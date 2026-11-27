import { describe, expect, test } from "vitest";
import { SessionInboundMessageSchema, SessionOutboundMessageSchema } from "../messages.js";
import { DEFAULT_GOAL_PERMISSION_POLICY, goalPermissionPolicy } from "./config-bounds.js";
import { summarizeGoalProgress, toGoalSummary } from "./progress.js";
import {
  GOAL_TIME_MODES,
  type Goal,
  GoalConfigSchema,
  GoalEventSchema,
  GoalSchema,
} from "./types.js";

const config = {
  cwd: "/repo",
  leadProvider: "claude",
  defaultProvider: "codex",
  maxParallel: 2,
  maxAttempts: 2,
  autoApprovePlan: false,
  notifyLead: true,
};

describe("goal RPC schemas", () => {
  test("inbound requests parse through the session union", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "goal.create.request",
        requestId: "r1",
        title: "Ship",
        objective: "",
        criteria: ["tests pass"],
      }).type,
    ).toBe("goal.create.request");
    expect(
      SessionInboundMessageSchema.parse({
        type: "goal.propose_plan.request",
        requestId: "r2",
        goalId: "g1",
        eventId: "e1",
        tasks: [{ id: "a", title: "A", description: "", kind: "implement", dependsOn: [] }],
      }).type,
    ).toBe("goal.propose_plan.request");
  });

  test("rejects a plan task with an unknown kind", () => {
    expect(
      SessionInboundMessageSchema.safeParse({
        type: "goal.propose_plan.request",
        requestId: "r2",
        goalId: "g1",
        tasks: [{ id: "a", title: "A", description: "", kind: "deploy", dependsOn: [] }],
      }).success,
    ).toBe(false);
  });

  test("responses parse through the session union", () => {
    expect(
      SessionOutboundMessageSchema.parse({
        type: "goal.list.response",
        payload: { requestId: "r1", goals: [], error: null },
      }).type,
    ).toBe("goal.list.response");
  });

  test("goal control requests parse with and without their optional fields", () => {
    for (const message of [
      { type: "goal.reject_plan.request", requestId: "r", goalId: "g" },
      {
        type: "goal.reject_plan.request",
        requestId: "r",
        goalId: "g",
        feedback: "x",
        eventId: "e",
      },
      { type: "goal.retry.request", requestId: "r", goalId: "g" },
      { type: "goal.retry.request", requestId: "r", goalId: "g", taskId: "a" },
      { type: "goal.pause.request", requestId: "r", goalId: "g" },
      { type: "goal.resume.request", requestId: "r", goalId: "g", eventId: "e" },
    ]) {
      expect(SessionInboundMessageSchema.parse(message).type).toBe(message.type);
    }
  });

  test("a goal from a daemon without goal controls still parses", () => {
    const goal = {
      id: "g",
      title: "T",
      objective: "",
      status: "executing",
      config,
      leadAgentId: null,
      leadWorkspaceId: null,
      criteria: [],
      tasks: [],
      runs: [],
      changeSets: [],
      integration: null,
      lastSeq: 3,
      failureReason: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(
      SessionOutboundMessageSchema.parse({
        type: "goal.pause.response",
        payload: { requestId: "r", goal, error: null },
      }).type,
    ).toBe("goal.pause.response");
  });

  test("config accepts the new settings and refuses an unsafe branch prefix", () => {
    const rich = {
      ...config,
      verifyProvider: "opencode/some-model",
      branchPrefix: "goals/team-a",
      limits: { maxTotalTokens: 2_000_000, maxCostUsd: 12.5, deadlineAt: "2026-12-01T00:00:00Z" },
    };
    expect(GoalConfigSchema.safeParse(rich).success).toBe(true);
    for (const branchPrefix of ["../x", "-x", "a//b", "a b", ".hidden"]) {
      expect(GoalConfigSchema.safeParse({ ...config, branchPrefix }).success).toBe(false);
    }
    expect(GoalConfigSchema.safeParse({ ...config, limits: { maxCostUsd: 0 } }).success).toBe(
      false,
    );
  });

  test("per-role thinking, a task's thinking and a run's thinking are optional", () => {
    const thinking = {
      ...config,
      leadThinking: "high",
      workerThinking: "low",
      reviewThinking: "medium",
      verifyThinking: "max",
    };
    const create = SessionInboundMessageSchema.parse({
      type: "goal.create.request",
      requestId: "r1",
      title: "Ship",
      objective: "",
      criteria: [],
      config: thinking,
    });
    expect(create).toMatchObject({ config: thinking });
    expect(GoalConfigSchema.parse(config)).not.toHaveProperty("leadThinking");
    expect(GoalConfigSchema.safeParse({ ...config, workerThinking: " " }).success).toBe(false);

    const plan = SessionInboundMessageSchema.parse({
      type: "goal.propose_plan.request",
      requestId: "r2",
      goalId: "g1",
      tasks: [
        { id: "a", title: "A", description: "", kind: "implement", dependsOn: [], thinking: "x" },
      ],
    });
    expect(plan).toMatchObject({ tasks: [{ thinking: "x" }] });

    const attached = {
      id: "e",
      goalId: "g",
      seq: 2,
      at: "2026-01-01T00:00:00.000Z",
      type: "run.attached",
      runId: "a-a1",
      agentId: "ag",
      workspaceId: "ws",
    };
    expect(GoalEventSchema.parse(attached)).not.toHaveProperty("thinking");
    expect(GoalEventSchema.parse({ ...attached, thinking: "low" })).toMatchObject({
      thinking: "low",
    });
  });

  test("acknowledge, the goal.update push and the list summary parse", () => {
    const goal: Goal = {
      id: "g",
      title: "T",
      objective: "",
      status: "failed",
      config,
      leadAgentId: null,
      leadWorkspaceId: null,
      criteria: [],
      tasks: [
        {
          id: "a",
          title: "A",
          description: "",
          kind: "implement",
          dependsOn: [],
          status: "succeeded",
          attempts: 1,
          error: null,
          summary: null,
        },
        {
          id: "b",
          title: "B",
          description: "",
          kind: "implement",
          dependsOn: [],
          status: "failed",
          attempts: 2,
          error: "x",
          summary: null,
        },
        {
          id: "c",
          title: "C",
          description: "",
          kind: "read",
          dependsOn: [],
          status: "pending",
          attempts: 0,
          error: null,
          summary: null,
        },
      ],
      runs: [],
      changeSets: [],
      integration: null,
      acknowledgedAt: "2026-01-02T00:00:00.000Z",
      lastSeq: 9,
      failureReason: "x",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(summarizeGoalProgress(goal)).toEqual({
      tasksTotal: 3,
      tasksDone: 1,
      tasksFailed: 1,
      tasksRunning: 0,
    });
    expect(
      SessionInboundMessageSchema.parse({
        type: "goal.acknowledge.request",
        requestId: "r",
        goalId: "g",
        eventId: "e",
      }).type,
    ).toBe("goal.acknowledge.request");
    const update = SessionOutboundMessageSchema.parse({
      type: "goal.update",
      payload: { goal: toGoalSummary(goal) },
    });
    expect(update.type === "goal.update" && update.payload.goal.progress?.tasksFailed).toBe(1);
    // A list from a daemon that predates progress still parses.
    expect(
      SessionOutboundMessageSchema.parse({
        type: "goal.list.response",
        payload: { requestId: "r", goals: [goal], error: null },
      }).type,
    ).toBe("goal.list.response");
    expect(
      GoalEventSchema.parse({ id: "e", goalId: "g", seq: 10, at: "x", type: "goal.acknowledged" })
        .type,
    ).toBe("goal.acknowledged");
    expect(
      SessionInboundMessageSchema.parse({
        type: "session.events.set_subscription.request",
        requestId: "r",
        events: ["goal.update"],
      }).type,
    ).toBe("session.events.set_subscription.request");
  });

  test("goal management requests, responses and events parse; old shapes still do", () => {
    const inbound = [
      { type: "goal.rename.request", requestId: "r", goalId: "g", title: " New ", eventId: "e" },
      { type: "goal.set_priority.request", requestId: "r", goalId: "g", priority: "high" },
      { type: "goal.archive.request", requestId: "r", goalId: "g" },
      { type: "goal.unarchive.request", requestId: "r", goalId: "g" },
      { type: "goal.delete.request", requestId: "r", goalId: "g" },
      {
        type: "goal.list.request",
        requestId: "r",
        query: "ship",
        status: ["failed", "cancelled"],
        priority: ["high"],
        cwd: "/repo",
        archived: "only",
        includeArchived: true,
      },
      // An old client's list request carries no filter.
      { type: "goal.list.request", requestId: "r" },
      {
        type: "goal.create.request",
        requestId: "r",
        title: "T",
        objective: "",
        criteria: [],
        priority: "low",
      },
    ];
    for (const message of inbound) {
      expect(SessionInboundMessageSchema.parse(message).type).toBe(message.type);
    }
    const rename = SessionInboundMessageSchema.parse(inbound[0]);
    expect(rename.type === "goal.rename.request" && rename.title).toBe("New");
    for (const bad of [
      { type: "goal.rename.request", requestId: "r", goalId: "g", title: "   " },
      { type: "goal.set_priority.request", requestId: "r", goalId: "g", priority: "urgent" },
      { type: "goal.list.request", requestId: "r", archived: "all" },
    ]) {
      expect(SessionInboundMessageSchema.safeParse(bad).success).toBe(false);
    }

    expect(
      SessionOutboundMessageSchema.parse({
        type: "goal.delete.response",
        payload: {
          requestId: "r",
          goalId: "g",
          deleted: true,
          retained: [
            { kind: "branch", name: "paseo-goal/g", reason: "Branches are never deleted" },
          ],
          error: null,
        },
      }).type,
    ).toBe("goal.delete.response");
    for (const type of ["goal.rename", "goal.set_priority", "goal.archive", "goal.unarchive"]) {
      expect(
        SessionOutboundMessageSchema.parse({
          type: `${type}.response`,
          payload: { requestId: "r", goal: null, error: "nope" },
        }).type,
      ).toBe(`${type}.response`);
    }

    const events = [
      { type: "goal.renamed", title: "T" },
      { type: "goal.priority_set", priority: "low" },
      { type: "goal.archived" },
      { type: "goal.unarchived" },
      { type: "goal.created", title: "T", objective: "", criteria: [], priority: "high" },
    ];
    for (const event of events) {
      expect(GoalEventSchema.parse({ id: "e", goalId: "g", seq: 1, at: "x", ...event }).type).toBe(
        event.type,
      );
    }
  });

  test("config edits: the request, the new events and the auto policy parse", () => {
    const request = SessionInboundMessageSchema.parse({
      type: "goal.update_config.request",
      requestId: "r",
      goalId: "g",
      eventId: "e",
      changes: {
        onPermissionRequest: "auto",
        notifyLead: false,
        maxParallel: 3,
        maxReworkRounds: null,
        testCommand: null,
        limits: { maxRuns: 120, maxTotalTokens: null, deadlineAt: "2026-12-01T00:00:00Z" },
      },
    });
    expect(request.type).toBe("goal.update_config.request");
    // An empty change set is a valid request; the daemon returns the goal unchanged.
    expect(
      SessionInboundMessageSchema.safeParse({
        type: "goal.update_config.request",
        requestId: "r",
        goalId: "g",
        changes: {},
      }).success,
    ).toBe(true);
    // Bounds are the create bounds.
    expect(
      SessionInboundMessageSchema.safeParse({
        type: "goal.update_config.request",
        requestId: "r",
        goalId: "g",
        changes: { maxParallel: 9 },
      }).success,
    ).toBe(false);
    expect(
      SessionInboundMessageSchema.safeParse({
        type: "goal.update_config.request",
        requestId: "r",
        goalId: "g",
        changes: { onPermissionRequest: "ask" },
      }).success,
    ).toBe(false);
    expect(
      SessionOutboundMessageSchema.parse({
        type: "goal.update_config.response",
        payload: { requestId: "r", goal: null, error: "nope" },
      }).type,
    ).toBe("goal.update_config.response");

    expect(GoalConfigSchema.parse({ ...config, onPermissionRequest: "auto" })).toMatchObject({
      onPermissionRequest: "auto",
    });
    for (const event of [
      { type: "goal.config_updated", config: { ...config, onPermissionRequest: "wait" } },
      { type: "goal.reopened" },
    ]) {
      expect(GoalEventSchema.parse({ id: "e", goalId: "g", seq: 2, at: "x", ...event }).type).toBe(
        event.type,
      );
    }
  });

  test("a stored config without a policy reads as fail; new goals record wait", () => {
    expect(goalPermissionPolicy(GoalConfigSchema.parse(config))).toBe("fail");
    expect(goalPermissionPolicy({ onPermissionRequest: "auto" })).toBe("auto");
    expect(goalPermissionPolicy(null)).toBe("fail");
    expect(DEFAULT_GOAL_PERMISSION_POLICY).toBe("wait");
  });
});

describe("integration retry", () => {
  const envelope = { id: "e", goalId: "g", seq: 2, at: "x" };

  test("a rejection carries its reason, and a merge retry names change sets and tasks", () => {
    expect(
      GoalEventSchema.parse({
        ...envelope,
        type: "changeset.transitioned",
        changeSetId: "cs1",
        to: "rejected",
        error: "Integration failed: boom",
        reason: "integration_failed",
      }),
    ).toMatchObject({ reason: "integration_failed" });
    const retried = {
      ...envelope,
      type: "changeset.integration_retried",
      changeSetIds: ["cs1"],
      taskIds: [],
    };
    expect(GoalEventSchema.parse(retried).type).toBe("changeset.integration_retried");
    expect(GoalEventSchema.safeParse({ ...retried, changeSetIds: [] }).success).toBe(false);
    expect(
      SessionOutboundMessageSchema.parse({
        type: "goal.inspect.response",
        payload: { requestId: "r", goal: null, events: [retried], error: null },
      }).type,
    ).toBe("goal.inspect.response");
  });
});

describe("retry time mode", () => {
  const envelope = { id: "e", goalId: "g", seq: 2, at: "x" };
  const goalWithoutControls = {
    id: "g",
    title: "T",
    objective: "",
    status: "executing",
    config,
    leadAgentId: null,
    leadWorkspaceId: null,
    criteria: [],
    tasks: [],
    runs: [],
    changeSets: [],
    integration: null,
    lastSeq: 3,
    failureReason: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  test("goal.retry takes an optional time mode as a string, so the set can grow", () => {
    for (const timeMode of [undefined, "fresh", "remaining", "later"]) {
      const message = {
        type: "goal.retry.request",
        requestId: "r",
        goalId: "g",
        ...(timeMode ? { timeMode } : {}),
      };
      expect(SessionInboundMessageSchema.parse(message)).toMatchObject(message);
    }
    expect(
      SessionInboundMessageSchema.safeParse({
        type: "goal.retry.request",
        requestId: "r",
        goalId: "g",
        timeMode: "x".repeat(33),
      }).success,
    ).toBe(false);
  });

  test("the reopening events carry the mode and running time; a goal its time base", () => {
    for (const event of [
      { type: "goal.retried", taskIds: ["a"], reopen: true },
      { type: "goal.reopened" },
      { type: "changeset.integration_retried", changeSetIds: ["cs1"], taskIds: [] },
    ]) {
      const parsed = GoalEventSchema.parse({
        ...envelope,
        ...event,
        timeMode: "remaining",
        activeMs: 1000,
      });
      expect(parsed).toMatchObject({ timeMode: "remaining", activeMs: 1000 });
      expect(GoalEventSchema.safeParse({ ...envelope, ...event, activeMs: -1 }).success).toBe(
        false,
      );
    }
    expect(
      GoalSchema.parse({ ...goalWithoutControls, timeBaseAt: "2026-01-01T00:00:00.000Z" })
        .timeBaseAt,
    ).toBe("2026-01-01T00:00:00.000Z");
    expect(GoalSchema.parse(goalWithoutControls).timeBaseAt).toBeUndefined();
    expect(GOAL_TIME_MODES).toEqual(["fresh", "remaining"]);
  });
});

describe("plan revision", () => {
  const spec = { id: "t7a", title: "A", description: "", kind: "implement", dependsOn: [] };

  test("the three requests parse, with ops or with a desired plan", () => {
    const withOps = {
      type: "goal.plan.revise.request",
      requestId: "r1",
      goalId: "g1",
      ops: [
        { op: "add", task: spec },
        { op: "remove", taskId: "t7" },
      ],
      reason: "split t7",
    };
    expect(SessionInboundMessageSchema.parse(withOps).type).toBe("goal.plan.revise.request");
    expect(
      SessionInboundMessageSchema.parse({
        type: "goal.plan.revise.request",
        requestId: "r2",
        goalId: "g1",
        tasks: [spec],
        remove: ["t7"],
        reason: "split t7",
        agentId: "lead-agent",
        eventId: "e1",
      }).type,
    ).toBe("goal.plan.revise.request");
    expect(
      SessionInboundMessageSchema.safeParse({
        ...withOps,
        ops: [{ op: "rename", taskId: "t7" }],
      }).success,
    ).toBe(false);
    for (const reason of ["  ", "x".repeat(2001)]) {
      expect(SessionInboundMessageSchema.safeParse({ ...withOps, reason }).success).toBe(false);
    }
    expect(
      SessionInboundMessageSchema.parse({
        type: "goal.plan.approve_revision.request",
        requestId: "r3",
        goalId: "g1",
        revisionId: "rev-1",
      }).type,
    ).toBe("goal.plan.approve_revision.request");
    expect(
      SessionInboundMessageSchema.parse({
        type: "goal.plan.reject_revision.request",
        requestId: "r4",
        goalId: "g1",
        revisionId: "rev-1",
        feedback: "keep t7",
      }).type,
    ).toBe("goal.plan.reject_revision.request");
  });

  test("the responses parse through the session union", () => {
    for (const type of [
      "goal.plan.revise.response",
      "goal.plan.approve_revision.response",
      "goal.plan.reject_revision.response",
    ]) {
      expect(
        SessionOutboundMessageSchema.parse({
          type,
          payload: { requestId: "r", goal: null, error: "nope" },
        }).type,
      ).toBe(type);
    }
  });
});
