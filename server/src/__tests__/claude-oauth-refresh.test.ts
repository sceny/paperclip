import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { agents, companies, companyMemberships, connectionGrants, createDb, toolConnections } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { aiConnectionService } from "../services/ai-connections.js";
import { quotaCredentialRecovery, quotaCredentialHash } from "../services/quota-credential-recovery.js";
import { parseStoredClaudeOauth } from "../services/claude-oauth-credential.js";
import * as secretsModule from "../services/secrets.js";
const { secretService } = secretsModule;

vi.mock("../services/subscription-refresh.js", () => ({ refreshSubscriptionConnection: vi.fn().mockResolvedValue(undefined) }));

const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 19, 8, 0, 0);
const companyId = randomUUID();
const agentId = randomUUID();
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let service: ReturnType<typeof aiConnectionService>;
let home: string;
let owners = 0;

const document = (n: number, expiresAt: number) => JSON.stringify({ claudeAiOauth: {
  accessToken: `access-${n}`, refreshToken: `refresh-${n}`, expiresAt, scopes: ["user:inference", "user:profile"], subscriptionType: "max",
} });

async function connect(value: string) {
  const owner = `claude-refresh-${owners++}`;
  await db.insert(companyMemberships).values({ companyId, principalId: owner, principalType: "user", status: "active", membershipRole: "member" });
  await service.save(companyId, owner, { provider: "anthropic", method: "subscription", ownership: "personal", name: owner, loginSessionId: "fixture", agentIds: [], allAgents: true }, value);
  const [row] = await service.subscriptionAccounts(companyId, owner);
  return row;
}
const stored = async (row: Awaited<ReturnType<typeof connect>>) => parseStoredClaudeOauth(await service.credentialRaw(row));

function providerSequence(responses: Array<() => Response | Promise<Response>>) {
  let call = 0;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    const next = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return next();
  });
}
const granted = (n: number, expiresInSeconds = 28800) => () =>
  Response.json({ access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: expiresInSeconds });

beforeAll(async () => {
  home = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-refresh-")));
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "claude-refresh-fixture");
  database = await startEmbeddedPostgresTestDatabase("paperclip-claude-refresh-");
  db = createDb(database.connectionString);
  service = aiConnectionService(db);
  await db.insert(companies).values({ id: companyId, name: "Claude refresh", issuePrefix: "CLR" });
  await db.insert(agents).values({ id: agentId, companyId, name: "Nova", adapterType: "claude_local" });
}, 90000);
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
afterAll(async () => { await database?.cleanup(); vi.unstubAllEnvs(); if (home) await rm(home, { recursive: true, force: true }); });

describe("Claude subscription token renewal", () => {
  it("passes a legacy plain token through without contacting the provider", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected"));
    const row = await connect("sk-ant-oat01-legacy");
    expect(await service.credential(row)).toBe("sk-ant-oat01-legacy");
    expect(await service.runtimeCredential(row)).toBe("sk-ant-oat01-legacy");
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps a token alive across the eight-hour access lifetime (t=0, +7h, +8.5h)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const request = providerSequence([granted(1), granted(2)]);
    const row = await connect(document(0, T0 + 8 * HOUR));

    expect(await service.runtimeCredential(row)).toBe("access-0");
    expect(request).not.toHaveBeenCalled();

    vi.setSystemTime(T0 + 7 * HOUR);
    expect(await service.runtimeCredential(row)).toBe("access-1");
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toMatchObject({ grant_type: "refresh_token", refresh_token: "refresh-0" });
    expect(await stored(row)).toMatchObject({ accessToken: "access-1", refreshToken: "refresh-1", expiresAt: T0 + 15 * HOUR });

    vi.setSystemTime(T0 + 8.5 * HOUR);
    expect(await service.runtimeCredential(row)).toBe("access-1");
    expect(request).toHaveBeenCalledTimes(1);

    vi.setSystemTime(T0 + 13.5 * HOUR);
    expect(await service.runtimeCredential(row)).toBe("access-2");
    expect(request).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(request.mock.calls[1][1]?.body))).toMatchObject({ refresh_token: "refresh-1" });
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, row.grant.id));
    expect(grant.status).toBe("active");
  });

  it("exchanges the refresh token once when runs ask at the same time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const request = providerSequence([granted(1)]);
    const row = await connect(document(0, T0 + 1 * HOUR));
    const tokens = await Promise.all([1, 2, 3, 4].map(() => service.credential(row)));
    expect(tokens).toEqual(Array(4).fill("access-1"));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("saves a journaled replacement instead of spending the old refresh token again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const request = providerSequence([granted(9)]);
    const base = document(0, T0 + 1 * HOUR);
    const row = await connect(base);
    const [ref] = row.grant.credentialSecretRefs;
    const recovery = quotaCredentialRecovery(companyId, row.grant.id);
    await recovery.write({ companyId, grantId: row.grant.id, connectionId: row.connection.id, secretId: ref.secretId,
      baseHash: quotaCredentialHash(base), value: document(1, T0 + 8 * HOUR) });
    expect(await service.credential(row)).toBe("access-1");
    expect(request).not.toHaveBeenCalled();
    expect(await recovery.read()).toBeNull();
    expect(await stored(row)).toMatchObject({ refreshToken: "refresh-1" });
  });

  it("keeps the journal and defers the run when the replacement cannot be saved", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const request = providerSequence([granted(1)]);
    const row = await connect(document(0, T0 + 1 * HOUR));
    const realSecretService = secretService;
    const failing = vi.spyOn(secretsModule, "secretService").mockImplementation(((...args: Parameters<typeof realSecretService>) => {
      const real = realSecretService(...args);
      return { ...real, rotate: async () => { throw new Error("injected write failure"); } };
    }) as typeof realSecretService);
    await expect(service.credential(row)).rejects.toMatchObject({ details: { code: "ai_connection_busy" } });
    failing.mockRestore();
    expect((await quotaCredentialRecovery(companyId, row.grant.id).read())?.value).toContain("refresh-1");
    expect(request).toHaveBeenCalledTimes(1);
    request.mockClear().mockRejectedValue(new Error("must not exchange again"));
    expect(await service.credential(row)).toBe("access-1");
    expect(request).not.toHaveBeenCalled();
  });

  it("uses the current access token when renewal is unavailable but it has not expired", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    providerSequence([() => new Response("down", { status: 503 })]);
    const row = await connect(document(0, T0 + 1 * HOUR));
    expect(await service.credential(row)).toBe("access-0");
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, row.grant.id));
    expect(grant.status).toBe("active");
  });

  it("asks to retry when renewal is unavailable and the token has expired", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    providerSequence([() => new Response("down", { status: 503 })]);
    const row = await connect(document(0, T0 - HOUR));
    await expect(service.credential(row)).rejects.toMatchObject({ details: { code: "ai_connection_busy" } });
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, row.grant.id));
    expect(grant.status).toBe("active");
  });

  it("asks for a new sign-in when the provider refuses an expired token's refresh token", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    providerSequence([() => new Response("{}", { status: 400 })]);
    const row = await connect(document(0, T0 - HOUR));
    await expect(service.credential(row)).rejects.toMatchObject({ details: { code: "ai_connection_credential_missing" } });
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, row.grant.id));
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, row.connection.id));
    expect(grant.status).toBe("needs_reauthorization");
    expect(connection.healthStatus).toBe("error");
  });

  it("does not disable a connection while the refused token's access token still works", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    providerSequence([() => new Response("{}", { status: 400 })]);
    const row = await connect(document(0, T0 + 1 * HOUR));
    expect(await service.credential(row)).toBe("access-0");
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, row.grant.id));
    expect(grant.status).toBe("active");
  });
});
