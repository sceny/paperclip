import { describe, expect, it, vi } from "vitest";
import {
  claudeAccessTokenOf, claudeRefreshDue, ClaudeOauthRefreshError, CLAUDE_OAUTH_CLIENT_ID, CLAUDE_OAUTH_TOKEN_URL,
  CLAUDE_REFRESH_MARGIN_MS, parseStoredClaudeOauth, refreshClaudeOauth, serializeClaudeOauth,
} from "../services/claude-oauth-credential.js";

const HOUR = 60 * 60 * 1000;
const oauth = { accessToken: "access-0", refreshToken: "refresh-0", expiresAt: 8 * HOUR, scopes: ["user:inference"], subscriptionType: "max" };
const BROAD = ["user:inference", "user:profile", "org:create_api_key"];
const stored = JSON.stringify({ claudeAiOauth: oauth });

describe("Claude OAuth credential", () => {
  it("treats a plain token as a legacy value that never refreshes", () => {
    expect(parseStoredClaudeOauth("sk-ant-oat01-plain")).toBeNull();
    expect(claudeAccessTokenOf("sk-ant-oat01-plain")).toBe("sk-ant-oat01-plain");
  });

  it("rejects documents that cannot be renewed", () => {
    expect(parseStoredClaudeOauth("{")).toBeNull();
    expect(parseStoredClaudeOauth(JSON.stringify({ tokens: { access_token: "codex" } }))).toBeNull();
    expect(serializeClaudeOauth({ accessToken: "a", expiresAt: 1 })).toBeNull();
    expect(serializeClaudeOauth({ accessToken: "a", refreshToken: "r", expiresAt: "soon" })).toBeNull();
  });

  it("round-trips the renewable document, including the run token", () => {
    const withRun = { ...oauth, run: { accessToken: "run-0", expiresAt: 4 * HOUR }, runRefused: true };
    const serialized = serializeClaudeOauth({ ...withRun, extra: "dropped" })!;
    expect(parseStoredClaudeOauth(serialized)).toEqual(withRun);
    expect(parseStoredClaudeOauth(serializeClaudeOauth({ ...oauth, run: { accessToken: "", expiresAt: 1 } })!)?.run).toBeUndefined();
  });

  it("serves a run only a token known to be inference-only", () => {
    const broad = { ...oauth, scopes: BROAD };
    expect(claudeAccessTokenOf(JSON.stringify({ claudeAiOauth: broad }), "run")).toBeNull();
    expect(claudeAccessTokenOf(JSON.stringify({ claudeAiOauth: broad }), "account")).toBe("access-0");
    expect(claudeAccessTokenOf(JSON.stringify({ claudeAiOauth: { ...oauth, scopes: undefined } }), "run")).toBeNull();
    expect(claudeAccessTokenOf(JSON.stringify({ claudeAiOauth: { ...oauth, scopes: [] } }), "run")).toBeNull();
    expect(claudeAccessTokenOf(stored, "run")).toBe("access-0");
    expect(claudeAccessTokenOf(JSON.stringify({ claudeAiOauth: { ...broad, run: { accessToken: "run-0", expiresAt: 1 } } }), "run")).toBe("run-0");
  });

  it("is due once the token for a use is inside the refresh margin", () => {
    const parsed = parseStoredClaudeOauth(stored)!;
    expect(claudeRefreshDue(parsed, "run", 0)).toBe(false);
    expect(claudeRefreshDue(parsed, "run", 8 * HOUR - CLAUDE_REFRESH_MARGIN_MS)).toBe(true);
    expect(claudeRefreshDue(parsed, "account", 8.5 * HOUR)).toBe(true);
  });

  it("is due at once for a run with no inference-only token, until the provider refused to issue one", () => {
    const broad = parseStoredClaudeOauth(JSON.stringify({ claudeAiOauth: { ...oauth, scopes: BROAD } }))!;
    expect(claudeRefreshDue(broad, "run", 0)).toBe(true);
    expect(claudeRefreshDue(broad, "account", 0)).toBe(false);
    expect(claudeRefreshDue({ ...broad, runRefused: true }, "run", 0)).toBe(false);
    expect(claudeRefreshDue({ ...broad, scopes: undefined }, "run", 0)).toBe(true);
    expect(claudeRefreshDue({ ...broad, run: { accessToken: "run-0", expiresAt: 8 * HOUR } }, "run", 0)).toBe(false);
  });

  it("asks for inference only for a run, and stores the answer as the run token beside the login token", async () => {
    const broad = parseStoredClaudeOauth(JSON.stringify({ claudeAiOauth: { ...oauth, scopes: BROAD } }))!;
    const fetchImpl = vi.fn(async () => Response.json({ access_token: "run-1", refresh_token: "refresh-1", expires_in: 3600, scope: "user:inference" }));
    const next = parseStoredClaudeOauth(await refreshClaudeOauth(broad, "run", { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 0 }))!;
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(CLAUDE_OAUTH_TOKEN_URL);
    expect(JSON.parse(String(init.body))).toEqual({
      grant_type: "refresh_token", refresh_token: "refresh-0", client_id: CLAUDE_OAUTH_CLIENT_ID, scope: "user:inference",
    });
    expect(next).toMatchObject({ accessToken: "access-0", scopes: BROAD, refreshToken: "refresh-1", subscriptionType: "max", run: { accessToken: "run-1", expiresAt: HOUR } });
  });

  it("stores a run token when the answer omits the scope, which grants what was asked", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ access_token: "run-1", expires_in: 3600 }));
    const next = parseStoredClaudeOauth(await refreshClaudeOauth(parseStoredClaudeOauth(stored)!, "run", { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 0 }))!;
    expect(next.run).toEqual({ accessToken: "run-1", expiresAt: HOUR });
  });

  it("asks for the login scopes for the account use, and leaves the run token alone", async () => {
    const withRun = parseStoredClaudeOauth(JSON.stringify({ claudeAiOauth: { ...oauth, scopes: BROAD, run: { accessToken: "run-0", expiresAt: 5 * HOUR } } }))!;
    const fetchImpl = vi.fn(async () => Response.json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, scope: BROAD.join(" ") }));
    const next = parseStoredClaudeOauth(await refreshClaudeOauth(withRun, "account", { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 0 }))!;
    expect(JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)).scope).toBe(BROAD.join(" "));
    expect(next).toMatchObject({ accessToken: "access-1", refreshToken: "refresh-1", expiresAt: HOUR, scopes: BROAD, run: { accessToken: "run-0", expiresAt: 5 * HOUR } });
  });

  it("never stores a run token wider than inference when the provider ignores the narrow scope", async () => {
    const withRun = parseStoredClaudeOauth(JSON.stringify({ claudeAiOauth: { ...oauth, scopes: BROAD, run: { accessToken: "run-0", expiresAt: 1 } } }))!;
    const fetchImpl = vi.fn(async () => Response.json({ access_token: "wide-1", refresh_token: "refresh-1", expires_in: 3600, scope: BROAD.join(" ") }));
    const next = parseStoredClaudeOauth(await refreshClaudeOauth(withRun, "run", { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 0 }))!;
    expect(next.run).toBeUndefined();
    expect(next).toMatchObject({ accessToken: "wide-1", refreshToken: "refresh-1", runRefused: true });
    expect(claudeAccessTokenOf(JSON.stringify({ claudeAiOauth: next }), "run")).toBeNull();
    expect(claudeRefreshDue(next, "run", 0)).toBe(false);
  });

  it("keeps the run refusal across an account renewal", async () => {
    const refused = parseStoredClaudeOauth(JSON.stringify({ claudeAiOauth: { ...oauth, scopes: BROAD, runRefused: true } }))!;
    const fetchImpl = vi.fn(async () => Response.json({ access_token: "access-1", expires_in: 3600 }));
    const next = parseStoredClaudeOauth(await refreshClaudeOauth(refused, "account", { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 0 }))!;
    expect(next.runRefused).toBe(true);
  });

  it("reports a refused scope apart from a revoked login, and does not repeat the request", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ error: "invalid_scope" }, { status: 400 }));
    const scoped = await refreshClaudeOauth(parseStoredClaudeOauth(stored)!, "run", { fetchImpl: fetchImpl as unknown as typeof fetch }).catch(e => e);
    expect(scoped).toMatchObject({ scopeRefused: true, rejected: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const revoked = await refreshClaudeOauth(parseStoredClaudeOauth(stored)!, "run", {
      fetchImpl: (async () => Response.json({ error: "invalid_grant" }, { status: 400 })) as unknown as typeof fetch,
    }).catch(e => e);
    expect(revoked).toMatchObject({ scopeRefused: false, rejected: true });
  });

  it("keeps the previous refresh token when the provider does not rotate it", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ access_token: "access-1", expires_in: 3600 }));
    const next = await refreshClaudeOauth(parseStoredClaudeOauth(stored)!, "account", { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 0 });
    expect(parseStoredClaudeOauth(next)).toMatchObject({ accessToken: "access-1", refreshToken: "refresh-0", expiresAt: HOUR });
  });

  it.each([[400, true], [401, true], [403, true], [429, false], [500, false]])("classifies HTTP %i as rejected=%s", async (status, rejected) => {
    const fetchImpl = vi.fn(async () => new Response("secret refresh-0 body", { status }));
    const error = await refreshClaudeOauth(parseStoredClaudeOauth(stored)!, "account", { fetchImpl: fetchImpl as unknown as typeof fetch }).catch(e => e);
    expect(error).toBeInstanceOf(ClaudeOauthRefreshError);
    expect(error.rejected).toBe(rejected);
    expect(error.message).not.toContain("refresh-0");
  });

  it("does not echo credentials when the response is malformed or the network fails", async () => {
    for (const fetchImpl of [
      vi.fn(async () => Response.json({ access_token: "access-1" })),
      vi.fn(async () => new Response("not json")),
      vi.fn(async () => { throw new Error("connect failed for refresh-0"); }),
    ]) {
      const error = await refreshClaudeOauth(parseStoredClaudeOauth(stored)!, "account", { fetchImpl: fetchImpl as unknown as typeof fetch }).catch(e => e);
      expect(error).toBeInstanceOf(ClaudeOauthRefreshError);
      expect(error.rejected).toBe(false);
      expect(error.message).not.toMatch(/refresh-0|access-1/);
    }
  });
});
