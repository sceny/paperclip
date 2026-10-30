// A Claude subscription connection from `claude auth login` stores the CLI's
// OAuth document, not only the access token. The login grants organization and
// account management as well as inference, and the server needs the broad token
// to read usage and subscription identity. An agent run must not hold it, so the
// document keeps a second, inference-only access token for runs, renewed from the
// same refresh token.

export const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const CLAUDE_OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
/** Renew early so a long run does not outlive the token it started with. */
export const CLAUDE_REFRESH_MARGIN_MS = 2 * 60 * 60 * 1000;
/** The background renewal starts earlier than a run would, so an idle login still renews while its refresh token is valid. */
export const CLAUDE_PROACTIVE_REFRESH_MARGIN_MS = 3 * 60 * 60 * 1000;
/** The only scope a run needs; `claude setup-token` used to grant exactly this. */
export const CLAUDE_RUN_SCOPES = ["user:inference"];
const REFRESH_TIMEOUT_MS = 60_000;

/** `run` is a token an agent process receives. `account` is the login token the server uses itself. */
export type ClaudeTokenUse = "run" | "account";

export interface StoredClaudeOauth {
  /** The login's access token, with every scope the login granted. Never handed to a run. */
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
  /** The inference-only access token for runs. */
  run?: { accessToken: string; expiresAt: number };
  /** The provider would not issue an inference-only token for this login, so runs cannot use it. */
  runRefused?: boolean;
}

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

function pickRun(source: unknown): StoredClaudeOauth["run"] | null {
  if (!source || typeof source !== "object") return null;
  const run = source as Record<string, unknown>;
  if (!nonEmpty(run.accessToken) || typeof run.expiresAt !== "number" || !Number.isFinite(run.expiresAt)) return null;
  return { accessToken: run.accessToken, expiresAt: run.expiresAt };
}

function pickStored(source: unknown): StoredClaudeOauth | null {
  if (!source || typeof source !== "object") return null;
  const oauth = source as Record<string, unknown>;
  if (!nonEmpty(oauth.accessToken) || !nonEmpty(oauth.refreshToken)) return null;
  if (typeof oauth.expiresAt !== "number" || !Number.isFinite(oauth.expiresAt)) return null;
  const run = pickRun(oauth.run);
  return {
    accessToken: oauth.accessToken,
    refreshToken: oauth.refreshToken,
    expiresAt: oauth.expiresAt,
    ...(Array.isArray(oauth.scopes) ? { scopes: oauth.scopes.filter((scope): scope is string => typeof scope === "string") } : {}),
    ...(nonEmpty(oauth.subscriptionType) ? { subscriptionType: oauth.subscriptionType } : {}),
    ...(nonEmpty(oauth.rateLimitTier) ? { rateLimitTier: oauth.rateLimitTier } : {}),
    ...(run ? { run } : {}),
    ...(oauth.runRefused === true ? { runRefused: true } : {}),
  };
}

/** Null for a plain access token, which older connections store, and for any other shape. */
export function parseStoredClaudeOauth(raw: string): StoredClaudeOauth | null {
  if (!raw.trimStart().startsWith("{")) return null;
  try {
    return pickStored((JSON.parse(raw) as { claudeAiOauth?: unknown } | null)?.claudeAiOauth);
  } catch {
    return null;
  }
}

/** The secret value for a login file's `claudeAiOauth` object, or null when it cannot be renewed. */
export function serializeClaudeOauth(source: unknown): string | null {
  const stored = pickStored(source);
  return stored ? JSON.stringify({ claudeAiOauth: stored }) : null;
}

/** Known scopes that all fit a run. A missing or empty list is unknown, and unknown is not safe. */
function onlyRunScopes(scopes: string[] | undefined): boolean {
  return Boolean(scopes?.length) && scopes!.every(scope => CLAUDE_RUN_SCOPES.includes(scope));
}

/** The token held for a use, or null when there is none: a run has none until one was issued for inference only. */
export function claudeTokenFor(stored: StoredClaudeOauth, use: ClaudeTokenUse): { accessToken: string; expiresAt: number } | null {
  if (use === "account") return { accessToken: stored.accessToken, expiresAt: stored.expiresAt };
  if (stored.run) return stored.run;
  return onlyRunScopes(stored.scopes) ? { accessToken: stored.accessToken, expiresAt: stored.expiresAt } : null;
}

/** The access token for a use of a stored value; a plain token serves both. Null when a run has no safe token. */
export function claudeAccessTokenOf(raw: string, use: ClaudeTokenUse): string | null {
  const stored = parseStoredClaudeOauth(raw);
  return stored ? claudeTokenFor(stored, use)?.accessToken ?? null : raw;
}

/** Due when the token for this use nears expiry, or a run has none yet and the provider has not refused to issue one. */
export function claudeRefreshDue(stored: StoredClaudeOauth, use: ClaudeTokenUse, now = Date.now(), marginMs = CLAUDE_REFRESH_MARGIN_MS): boolean {
  const token = claudeTokenFor(stored, use);
  if (!token) return !stored.runRefused;
  return token.expiresAt - marginMs <= now;
}

export class ClaudeOauthRefreshError extends Error {
  /** True when the provider refused the refresh token, so the user must sign in again. */
  readonly rejected: boolean;
  /** True when the provider refused the requested scopes. The login itself is not revoked. */
  readonly scopeRefused: boolean;
  constructor(message: string, rejected: boolean, scopeRefused = false) {
    super(message);
    this.name = "ClaudeOauthRefreshError";
    this.rejected = rejected;
    this.scopeRefused = scopeRefused;
  }
}

/**
 * Exchange the refresh token for the token a use needs: inference only for a run, the login scopes for the
 * server. The provider rotates the refresh token, so the returned value must be saved before anything else can
 * use the old one. A response that is wider than a run asked for is never kept as a run token. Error messages
 * never carry request or response bytes.
 */
export async function refreshClaudeOauth(
  stored: StoredClaudeOauth,
  use: ClaudeTokenUse,
  options: { fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const scopes = use === "run" ? CLAUDE_RUN_SCOPES : stored.scopes;
  let response: Response;
  try {
    response = await fetchImpl(CLAUDE_OAUTH_TOKEN_URL, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: stored.refreshToken,
        client_id: CLAUDE_OAUTH_CLIENT_ID,
        ...(scopes?.length ? { scope: scopes.join(" ") } : {}),
      }),
    });
  } catch {
    throw new ClaudeOauthRefreshError("Claude token refresh could not reach the provider", false);
  }
  if (!response.ok) {
    // A refused scope is not a revoked login: the refresh token may still be good.
    const scopeRefused = response.status === 400 && (await providerErrorCode(response)) === "invalid_scope";
    await response.body?.cancel().catch(() => undefined);
    throw new ClaudeOauthRefreshError(
      `Claude token refresh failed with HTTP ${response.status}`,
      !scopeRefused && (response.status === 400 || response.status === 401 || response.status === 403),
      scopeRefused,
    );
  }
  let payload: Record<string, unknown> | null = null;
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    payload = null;
  }
  if (!payload || !nonEmpty(payload.access_token) || typeof payload.expires_in !== "number" || !(payload.expires_in > 0)) {
    throw new ClaudeOauthRefreshError("Claude token refresh returned an unexpected response", false);
  }
  // A response without `scope` grants what was requested (RFC 6749 section 5.1).
  const granted = nonEmpty(payload.scope) ? payload.scope.split(/\s+/).filter(Boolean) : scopes;
  const accessToken = payload.access_token;
  const expiresAt = now() + payload.expires_in * 1000;
  const { run: _run, runRefused: _runRefused, ...rest } = stored;
  const next: StoredClaudeOauth = {
    ...rest,
    refreshToken: nonEmpty(payload.refresh_token) ? payload.refresh_token : stored.refreshToken,
    ...(use === "account" && stored.run ? { run: stored.run } : {}),
    ...(use === "account" && stored.runRefused ? { runRefused: true } : {}),
  };
  if (use === "account") {
    next.accessToken = accessToken;
    next.expiresAt = expiresAt;
    if (granted?.length) next.scopes = granted;
  } else if (!granted || onlyRunScopes(granted)) {
    next.run = { accessToken, expiresAt };
  } else {
    // The provider ignored the narrower scope. The wider token is still a valid login token for the server,
    // and the rotated refresh token must be kept, but runs cannot use this login.
    next.accessToken = accessToken;
    next.expiresAt = expiresAt;
    next.scopes = granted;
    delete next.run;
    next.runRefused = true;
  }
  return JSON.stringify({ claudeAiOauth: next });
}

/** The OAuth `error` code of a failed response, read from a copy so the caller can still use the original. */
async function providerErrorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.clone().json()) as { error?: unknown } | null;
    return typeof body?.error === "string" ? body.error : null;
  } catch {
    return null;
  }
}
