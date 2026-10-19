// A Claude subscription connection from `claude auth login` stores the CLI's
// OAuth document, not only the access token. The access token lives about eight
// hours; the refresh token renews it. Runs receive only the access token.

export const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const CLAUDE_OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
/** Renew early so a long run does not outlive the token it started with. */
export const CLAUDE_REFRESH_MARGIN_MS = 2 * 60 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 60_000;

export interface StoredClaudeOauth {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
}

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

function pickStored(source: unknown): StoredClaudeOauth | null {
  if (!source || typeof source !== "object") return null;
  const oauth = source as Record<string, unknown>;
  if (!nonEmpty(oauth.accessToken) || !nonEmpty(oauth.refreshToken)) return null;
  if (typeof oauth.expiresAt !== "number" || !Number.isFinite(oauth.expiresAt)) return null;
  return {
    accessToken: oauth.accessToken,
    refreshToken: oauth.refreshToken,
    expiresAt: oauth.expiresAt,
    ...(Array.isArray(oauth.scopes) ? { scopes: oauth.scopes.filter((scope): scope is string => typeof scope === "string") } : {}),
    ...(nonEmpty(oauth.subscriptionType) ? { subscriptionType: oauth.subscriptionType } : {}),
    ...(nonEmpty(oauth.rateLimitTier) ? { rateLimitTier: oauth.rateLimitTier } : {}),
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

/** The token a run receives for a stored value: the access token, or the plain token itself. */
export function claudeAccessTokenOf(raw: string): string {
  return parseStoredClaudeOauth(raw)?.accessToken ?? raw;
}

export function claudeRefreshDue(stored: StoredClaudeOauth, now = Date.now()): boolean {
  return stored.expiresAt - CLAUDE_REFRESH_MARGIN_MS <= now;
}

export class ClaudeOauthRefreshError extends Error {
  /** True when the provider refused the refresh token, so the user must sign in again. */
  readonly rejected: boolean;
  constructor(message: string, rejected: boolean) {
    super(message);
    this.name = "ClaudeOauthRefreshError";
    this.rejected = rejected;
  }
}

/**
 * Exchange the refresh token. The provider rotates it, so the returned value
 * must be saved before anything else can use the old one. Error messages never
 * carry request or response bytes.
 */
export async function refreshClaudeOauth(
  stored: StoredClaudeOauth,
  options: { fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
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
        ...(stored.scopes?.length ? { scope: stored.scopes.join(" ") } : {}),
      }),
    });
  } catch {
    throw new ClaudeOauthRefreshError("Claude token refresh could not reach the provider", false);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ClaudeOauthRefreshError(
      `Claude token refresh failed with HTTP ${response.status}`,
      response.status === 400 || response.status === 401 || response.status === 403,
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
  const next: StoredClaudeOauth = {
    ...stored,
    accessToken: payload.access_token,
    refreshToken: nonEmpty(payload.refresh_token) ? payload.refresh_token : stored.refreshToken,
    expiresAt: now() + payload.expires_in * 1000,
    ...(nonEmpty(payload.scope) ? { scopes: payload.scope.split(/\s+/).filter(Boolean) } : {}),
  };
  return JSON.stringify({ claudeAiOauth: next });
}
