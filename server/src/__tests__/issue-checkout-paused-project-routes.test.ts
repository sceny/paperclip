import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hoistModuleGraph } from "./helpers/hoist-module-graph.js";

const issueId = "11111111-1111-4111-8111-111111111111";
const projectId = "55555555-5555-4555-8555-555555555555";
const agentId = "22222222-2222-4222-8222-222222222222";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  checkout: vi.fn(),
  addComment: vi.fn(),
}));

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  getById: vi.fn(async () => null),
  reopenClosedIsolatedExecutionWorkspaceForIssue: vi.fn(),
  clearReopenPendingConsumptionForUnconsumedReopen: vi.fn(async () => ({ cleared: true })),
  refreshReopenPendingConsumption: vi.fn(async () => ({ refreshed: true })),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(async (input: { action: string }) => ({
    allowed: input.action === "issue:read" || input.action === "project:read",
    action: input.action,
    reason: "allow_test_read",
    explanation: "The fixture actor can read the task.",
  })),
  hasPermission: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(async () => null),
}));
const mockRunnerGoalService = vi.hoisted(() => ({
  projection: vi.fn(async () => null),
  act: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

function registerServiceMocks() {
  vi.doMock("../routes/authz.js", async () => vi.importActual("../routes/authz.js"));

  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentTaskCompleted: vi.fn(),
    trackErrorHandlerCrash: vi.fn(),
  }));

  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
  }));

  vi.doMock("../services/access.js", () => ({
    accessService: () => mockAccessService,
  }));

  vi.doMock("../services/activity-log.js", () => ({
    logActivity: mockLogActivity,
  }));

  vi.doMock("../services/execution-workspaces.js", () => ({
    executionWorkspaceService: () => mockExecutionWorkspaceService,
    STALE_REOPEN_PENDING_CONSUMPTION_GRACE_MS: 5 * 60 * 1000,
  }));

  vi.doMock("../services/heartbeat.js", () => ({
    heartbeatService: () => mockHeartbeatService,
  }));

  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));

  vi.doMock("../services/projects.js", () => ({
    projectService: () => mockProjectService,
  }));

  vi.doMock("../services/runner-goals.js", () => ({
    runnerGoalService: () => mockRunnerGoalService,
    RunnerGoalActionError: class RunnerGoalActionError extends Error {},
    RunnerGoalConflictError: class RunnerGoalConflictError extends Error {},
  }));

  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1" })),
    }),
    accessService: () => mockAccessService,
    agentService: () => ({
      getById: vi.fn(async () => null),
    }),
    companySkillService: () => ({
      completeTestRunForIssue: vi.fn(async () => null),
    }),
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => ({}),
    executionWorkspaceService: () => mockExecutionWorkspaceService,
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({
      getDefaultCompanyGoal: vi.fn(async () => null),
      getById: vi.fn(async () => null),
    }),
    heartbeatService: () => mockHeartbeatService,
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: {
          censorUsernameInLogs: false,
          feedbackDataSharingPreference: "prompt",
        },
      })),
      listCompanyIds: vi.fn(async () => ["company-1"]),
    }),
    issueApprovalService: () => ({}),
    issueReferenceService: () => ({
      deleteDocumentSource: async () => undefined,
      diffIssueReferenceSummary: () => ({
        addedReferencedIssues: [],
        removedReferencedIssues: [],
        currentReferencedIssues: [],
      }),
      emptySummary: () => ({ outbound: [], inbound: [] }),
      listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
      syncComment: async () => undefined,
      syncDocument: async () => undefined,
      syncIssue: async () => undefined,
    }),
    issueThreadInteractionService: () => ({
      listForIssue: vi.fn(async () => []),
      expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
      expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
    }),
    issueRecoveryActionService: () => ({
      getActiveForIssue: vi.fn(async () => null),
      listActiveForIssues: vi.fn(async () => new Map()),
    }),
    issueService: () => mockIssueService,
    logActivity: mockLogActivity,
    projectService: () => mockProjectService,
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({}),
  }));
}

function makeIssue() {
  return {
    id: issueId,
    companyId: "company-1",
    status: "todo",
    priority: "medium",
    assigneeAgentId: agentId,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "TST-1",
    title: "Task in a paused project",
    projectId,
    executionRunId: null,
    checkoutRunId: null,
    executionWorkspaceId: null,
  };
}

describe("issue checkout in a paused project", () => {
  const routeModules = hoistModuleGraph(registerServiceMocks, async () => {
    const [{ issueRoutes }, { errorHandler }] = await Promise.all([
      vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    return { issueRoutes, errorHandler };
  });

  function createApp() {
    const { issueRoutes, errorHandler } = routeModules.value;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "local-board",
        companyIds: ["company-1"],
        source: "local_implicit",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes({} as any, {} as any));
    app.use(errorHandler);
    return app;
  }

  function checkout() {
    return request(createApp())
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId, expectedStatuses: ["todo", "backlog", "blocked"] });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue(makeIssue());
  });

  it("names a manual pause and refuses the checkout", async () => {
    mockProjectService.getById.mockResolvedValue({ id: projectId, pausedAt: new Date(), pauseReason: "manual" });

    const res = await checkout();

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("paused manually");
    expect(res.body.error).not.toContain("budget");
    expect(mockIssueService.checkout).not.toHaveBeenCalled();
  });

  it("keeps the budget wording for a budget pause", async () => {
    mockProjectService.getById.mockResolvedValue({ id: projectId, pausedAt: new Date(), pauseReason: "budget" });

    const res = await checkout();

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Project is paused because its budget hard-stop was reached");
    expect(mockIssueService.checkout).not.toHaveBeenCalled();
  });

  it("accepts the checkout after the project resumes", async () => {
    mockProjectService.getById.mockResolvedValue({ id: projectId, pausedAt: null, pauseReason: null });
    mockIssueService.checkout.mockResolvedValue({ ...makeIssue(), status: "in_progress" });

    const res = await checkout();

    expect(res.status).toBe(200);
    expect(mockIssueService.checkout).toHaveBeenCalledTimes(1);
  });
});
