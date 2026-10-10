import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, companies, companyMemberships, createDb, projects } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { projectRoutes } from "../routes/projects.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres project manual pause tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

function boardActor(companyId: string): Express.Request["actor"] {
  return {
    type: "board",
    userId: "user-1",
    source: "session",
    isInstanceAdmin: true,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "admin", status: "active" }],
  };
}

function agentActor(companyId: string): Express.Request["actor"] {
  return {
    type: "agent",
    agentId: randomUUID(),
    companyId,
    keyId: randomUUID(),
    source: "agent_key",
  };
}

function createApp(db: ReturnType<typeof createDb>, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", projectRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("project manual pause routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-project-manual-pause-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(companyMemberships);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(pause?: { pauseReason: string }) {
    const companyId = randomUUID();
    const projectId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Pausable Project",
      status: "in_progress",
      ...(pause ? { pauseReason: pause.pauseReason, pausedAt: new Date() } : {}),
    });
    return { companyId, projectId };
  }

  async function readPause() {
    const [row] = await db
      .select({ pauseReason: projects.pauseReason, pausedAt: projects.pausedAt })
      .from(projects);
    return row!;
  }

  async function activityActions() {
    const rows = await db.select({ action: activityLog.action }).from(activityLog);
    return rows.map((row) => row.action).sort();
  }

  it("pauses a project manually and records activity", async () => {
    const { companyId, projectId } = await seed();

    const res = await request(createApp(db, boardActor(companyId))).post(`/api/projects/${projectId}/pause`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: projectId, pauseReason: "manual" });
    expect(res.body.pausedAt).toEqual(expect.any(String));
    expect(await readPause()).toMatchObject({ pauseReason: "manual", pausedAt: expect.any(Date) });
    expect(await activityActions()).toEqual(["project.paused"]);
  });

  it("resumes a manually paused project and records activity", async () => {
    const { companyId, projectId } = await seed({ pauseReason: "manual" });

    const res = await request(createApp(db, boardActor(companyId))).post(`/api/projects/${projectId}/resume`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: projectId, pauseReason: null, pausedAt: null });
    expect(await readPause()).toEqual({ pauseReason: null, pausedAt: null });
    expect(await activityActions()).toEqual(["project.resumed"]);
  });

  it("is idempotent and does not log a second activity row", async () => {
    const { companyId, projectId } = await seed();
    const app = createApp(db, boardActor(companyId));

    expect((await request(app).post(`/api/projects/${projectId}/pause`)).status).toBe(200);
    const pausedAt = (await readPause()).pausedAt;
    expect((await request(app).post(`/api/projects/${projectId}/pause`)).status).toBe(200);
    expect((await readPause()).pausedAt).toEqual(pausedAt);

    expect((await request(app).post(`/api/projects/${projectId}/resume`)).status).toBe(200);
    expect((await request(app).post(`/api/projects/${projectId}/resume`)).status).toBe(200);

    expect(await activityActions()).toEqual(["project.paused", "project.resumed"]);
  });

  it("does not let a manual resume clear a budget pause", async () => {
    const { companyId, projectId } = await seed({ pauseReason: "budget" });

    const res = await request(createApp(db, boardActor(companyId))).post(`/api/projects/${projectId}/resume`);

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("budget");
    expect(await readPause()).toMatchObject({ pauseReason: "budget", pausedAt: expect.any(Date) });
    expect(await activityActions()).toEqual([]);
  });

  it("does not let a manual pause replace a budget pause", async () => {
    const { companyId, projectId } = await seed({ pauseReason: "budget" });

    const res = await request(createApp(db, boardActor(companyId))).post(`/api/projects/${projectId}/pause`);

    expect(res.status).toBe(409);
    expect(await readPause()).toMatchObject({ pauseReason: "budget" });
    expect(await activityActions()).toEqual([]);
  });

  it("rejects agent actors", async () => {
    const { companyId, projectId } = await seed();

    const res = await request(createApp(db, agentActor(companyId))).post(`/api/projects/${projectId}/pause`);

    expect(res.status).toBe(403);
    expect(await readPause()).toEqual({ pauseReason: null, pausedAt: null });
  });

  it("returns 404 for a project in another company", async () => {
    const { projectId } = await seed();

    const res = await request(createApp(db, boardActor(randomUUID()))).post(`/api/projects/${projectId}/pause`);

    expect(res.status).toBe(404);
    expect(await readPause()).toEqual({ pauseReason: null, pausedAt: null });
  });
});
