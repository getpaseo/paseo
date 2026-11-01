import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import { GoalEventLog } from "../../goal/event-log.js";
import { GoalService } from "../../goal/goal-service.js";
import { GoalStore } from "../../goal/goal-store.js";
import { CLIENT_CAPS, type ClientCapability } from "@getpaseo/protocol/client-capabilities";
import { toGoalSummary } from "@getpaseo/protocol/goal/progress";
import type { Goal } from "@getpaseo/protocol/goal/types";
import {
  requiredPermissionForInbound,
  requiredPermissionForOutbound,
} from "../../authorization/operation-permissions.js";
import { GoalSession, SLIM_GUIDANCE_CHARS, publishGoalUpdate } from "./goal-session.js";

const task = (id: string, dependsOn: string[] = []) => ({
  id,
  title: id,
  description: "",
  kind: "implement" as const,
  dependsOn,
});

describe("GoalSession", () => {
  let dir: string;
  let emitted: SessionOutboundMessage[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "paseo-goal-session-"));
    emitted = [];
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function openSession(
    controlEvents?: boolean,
    acknowledgeEvents?: boolean,
    managementEvents?: boolean,
    configEdit?: boolean,
    usageBreakdown?: boolean,
    integrationRetry?: boolean,
    planRevision?: boolean,
    leadInterventions?: boolean,
    recovery?: boolean,
    accept?: boolean,
    userWait?: boolean,
  ): Promise<GoalSession> {
    const log = new GoalEventLog({ dir });
    const service = new GoalService(new GoalStore(log), log);
    await service.start();
    return new GoalSession({
      host: {
        emit: (msg) => emitted.push(msg),
        ...supported({
          supportsGoalControlEvents: controlEvents,
          supportsGoalAcknowledgeEvents: acknowledgeEvents,
          supportsGoalManagementEvents: managementEvents,
          supportsGoalConfigEdit: configEdit,
          supportsGoalUsageBreakdown: usageBreakdown,
          supportsGoalIntegrationRetry: integrationRetry,
          supportsGoalPlanRevision: planRevision,
          supportsGoalLeadInterventions: leadInterventions,
          supportsGoalRecovery: recovery,
          supportsGoalAccept: accept,
          supportsGoalUserWait: userWait,
        }),
      },
      goalService: service,
      logger: pino({ level: "silent" }),
    });
  }

  /** Host capability checks for the flags given; an absent one is assumed supported. */
  function supported(flags: Record<string, boolean | undefined>): Record<string, () => boolean> {
    const checks: Record<string, () => boolean> = {};
    for (const [name, value] of Object.entries(flags)) {
      if (value !== undefined) checks[name] = () => value;
    }
    return checks;
  }

  async function send(session: GoalSession, msg: SessionInboundMessage): Promise<void> {
    await session.dispatch(msg);
  }

  test("creates, plans, approves, lists and inspects a goal", async () => {
    const session = await openSession();
    await send(session, {
      type: "goal.create.request",
      requestId: "r1",
      goalId: "g1",
      title: "Ship",
      objective: "obj",
      criteria: ["tests pass"],
    });
    await send(session, {
      type: "goal.propose_plan.request",
      requestId: "r2",
      goalId: "g1",
      tasks: [task("a"), task("b", ["a"])],
    });
    await send(session, { type: "goal.approve_plan.request", requestId: "r3", goalId: "g1" });
    await send(session, { type: "goal.list.request", requestId: "r4" });
    await send(session, { type: "goal.inspect.request", requestId: "r5", goalId: "g1" });

    const approved = emitted.find((m) => m.type === "goal.approve_plan.response") as {
      payload: { goal: { status: string } };
    };
    const listed = emitted.find((m) => m.type === "goal.list.response") as {
      payload: { goals: unknown[] };
    };
    const inspected = emitted.find((m) => m.type === "goal.inspect.response") as {
      payload: { events: { type: string }[]; goal: { tasks: { id: string }[] } };
    };
    expect(approved.payload.goal.status).toBe("executing");
    expect(listed.payload.goals).toHaveLength(1);
    const inspect = inspected.payload;
    expect(inspect.events.map((e) => e.type)).toEqual([
      "goal.created",
      "plan.proposed",
      "plan.approved",
    ]);
    expect(inspect.goal.tasks.map((t) => t.id)).toEqual(["a", "b"]);
  });

  test("a retried create returns the same goal without a second event", async () => {
    const session = await openSession();
    const create = {
      type: "goal.create.request" as const,
      requestId: "r1",
      goalId: "g1",
      title: "Ship",
      objective: "obj",
      criteria: [],
    };
    await send(session, create);
    await send(session, { ...create, requestId: "r2" });
    await send(session, { type: "goal.inspect.request", requestId: "r3", goalId: "g1" });
    const inspect = emitted.find((m) => m.type === "goal.inspect.response") as {
      payload: { events: unknown[] };
    };
    expect(inspect.payload.events).toHaveLength(1);
  });

  test("illegal transitions and unknown goals come back as rpc_error", async () => {
    const session = await openSession();
    await send(session, { type: "goal.approve_plan.request", requestId: "r1", goalId: "nope" });
    await send(session, {
      type: "goal.create.request",
      requestId: "r2",
      goalId: "g1",
      title: "T",
      objective: "",
      criteria: [],
    });
    await send(session, { type: "goal.approve_plan.request", requestId: "r3", goalId: "g1" });
    const errors = emitted.filter((m) => m.type === "rpc_error") as {
      payload: { requestId: string; error: string; code: string };
    }[];
    expect(errors.map((e) => e.payload.requestId)).toEqual(["r1", "r3"]);
    expect(errors[0]?.payload.error).toMatch(/not found/);
    expect(errors[1]?.payload.error).toMatch(/awaiting_plan_approval/);
    expect(errors[0]?.payload.code).toBe("goal_request_failed");
  });

  test("ignores messages that are not goal requests", async () => {
    const session = await openSession();
    expect(session.dispatch({ type: "schedule/list", requestId: "x" })).toBeUndefined();
  });

  test("goals survive a restart", async () => {
    const first = await openSession();
    await send(first, {
      type: "goal.create.request",
      requestId: "r1",
      goalId: "g1",
      title: "T",
      objective: "",
      criteria: [],
    });
    const second = await openSession();
    await send(second, { type: "goal.list.request", requestId: "r2" });
    const list = emitted.findLast((m) => m.type === "goal.list.response") as {
      payload: { goals: { id: string }[] };
    };
    expect(list.payload.goals.map((g) => g.id)).toEqual(["g1"]);
  });

  test("rejects a plan with feedback, pauses and resumes, and refuses to retry a manual goal", async () => {
    const session = await openSession();
    await send(session, {
      type: "goal.create.request",
      requestId: "r1",
      goalId: "g1",
      title: "T",
      objective: "",
      criteria: [],
    });
    await send(session, {
      type: "goal.propose_plan.request",
      requestId: "r2",
      goalId: "g1",
      tasks: [task("a")],
    });
    await send(session, {
      type: "goal.reject_plan.request",
      requestId: "r3",
      goalId: "g1",
      feedback: "smaller steps",
    });
    await send(session, { type: "goal.retry.request", requestId: "r4", goalId: "g1" });
    const rejected = emitted.find((m) => m.type === "goal.reject_plan.response") as {
      payload: { goal: { status: string; planRejections: { reason: string }[] } };
    };
    expect(rejected.payload.goal.status).toBe("planning");
    expect(rejected.payload.goal.planRejections.map((r) => r.reason)).toEqual(["smaller steps"]);
    const error = emitted.find((m) => m.type === "rpc_error") as {
      payload: { requestId: string; error: string };
    };
    expect(error.payload).toMatchObject({ requestId: "r4" });
    expect(error.payload.error).toMatch(/manual/);
  });

  for (const [label, capable, expected] of [
    ["sends", true, ["goal.created", "goal.paused", "goal.resumed"]],
    ["omits", false, ["goal.created"]],
  ] as const) {
    test(`${label} goal control events to clients ${capable ? "with" : "without"} the capability`, async () => {
      const session = await openSession(capable);
      await send(session, {
        type: "goal.create.request",
        requestId: "r1",
        goalId: "g1",
        title: "T",
        objective: "",
        criteria: ["works"],
        config: {
          cwd: "/repo",
          leadProvider: "claude",
          defaultProvider: "codex",
          maxParallel: 1,
          maxAttempts: 1,
          autoApprovePlan: false,
          notifyLead: false,
        },
      });
      await send(session, { type: "goal.pause.request", requestId: "r2", goalId: "g1" });
      await send(session, { type: "goal.resume.request", requestId: "r3", goalId: "g1" });
      await send(session, { type: "goal.inspect.request", requestId: "r4", goalId: "g1" });
      const paused = emitted.find((m) => m.type === "goal.pause.response") as {
        payload: { goal: { pausedAt: string | null } };
      };
      expect(paused.payload.goal.pausedAt).toBeTruthy();
      const inspected = emitted.find((m) => m.type === "goal.inspect.response") as {
        payload: { events: { type: string }[]; goal: { pausedAt: string | null } };
      };
      expect(inspected.payload.goal.pausedAt).toBeNull();
      expect(inspected.payload.events.map((e) => e.type)).toEqual(expected);
    });
  }

  test("goal.list carries task progress next to each goal", async () => {
    const session = await openSession();
    await send(session, {
      type: "goal.create.request",
      requestId: "r1",
      goalId: "g1",
      title: "T",
      objective: "",
      criteria: [],
    });
    await send(session, {
      type: "goal.propose_plan.request",
      requestId: "r2",
      goalId: "g1",
      tasks: [task("a"), task("b", ["a"])],
    });
    await send(session, { type: "goal.list.request", requestId: "r3" });
    const list = emitted.find((m) => m.type === "goal.list.response") as {
      payload: { goals: { progress: unknown }[] };
    };
    expect(list.payload.goals[0]?.progress).toEqual({
      tasksTotal: 2,
      tasksDone: 0,
      tasksFailed: 0,
      tasksRunning: 0,
    });
  });

  test("acknowledges an ended goal once, refuses a live one, and keeps the mark across a restart", async () => {
    const session = await openSession();
    await send(session, {
      type: "goal.create.request",
      requestId: "r1",
      goalId: "g1",
      title: "T",
      objective: "",
      criteria: [],
    });
    await send(session, { type: "goal.acknowledge.request", requestId: "r2", goalId: "g1" });
    await send(session, { type: "goal.cancel.request", requestId: "r3", goalId: "g1" });
    await send(session, {
      type: "goal.acknowledge.request",
      requestId: "r4",
      goalId: "g1",
      eventId: "e1",
    });
    await send(session, {
      type: "goal.acknowledge.request",
      requestId: "r5",
      goalId: "g1",
      eventId: "e1",
    });
    await send(session, { type: "goal.acknowledge.request", requestId: "r6", goalId: "g1" });

    const error = emitted.find((m) => m.type === "rpc_error") as {
      payload: { requestId: string; error: string };
    };
    expect(error.payload.requestId).toBe("r2");
    expect(error.payload.error).toMatch(/only an ended goal/);
    const acks = emitted.filter((m) => m.type === "goal.acknowledge.response") as {
      payload: { goal: { status: string; acknowledgedAt: string | null } };
    }[];
    expect(acks).toHaveLength(3);
    const first = acks[0]?.payload.goal.acknowledgedAt;
    expect(first).toBeTruthy();
    expect(acks.map((a) => a.payload.goal.acknowledgedAt)).toEqual([first, first, first]);
    expect(acks[0]?.payload.goal.status).toBe("cancelled");

    const restarted = await openSession();
    await send(restarted, { type: "goal.inspect.request", requestId: "r7", goalId: "g1" });
    const inspected = emitted.findLast((m) => m.type === "goal.inspect.response") as {
      payload: { events: { type: string }[]; goal: { acknowledgedAt: string | null } };
    };
    expect(inspected.payload.goal.acknowledgedAt).toBe(first);
    expect(inspected.payload.events.map((e) => e.type)).toEqual([
      "goal.created",
      "goal.cancelled",
      "goal.acknowledged",
    ]);
  });

  test("omits goal.acknowledged from inspect for clients without the capability", async () => {
    const session = await openSession(true, false);
    await send(session, {
      type: "goal.create.request",
      requestId: "r1",
      goalId: "g1",
      title: "T",
      objective: "",
      criteria: [],
    });
    await send(session, { type: "goal.cancel.request", requestId: "r2", goalId: "g1" });
    await send(session, { type: "goal.acknowledge.request", requestId: "r3", goalId: "g1" });
    await send(session, { type: "goal.inspect.request", requestId: "r4", goalId: "g1" });
    const inspected = emitted.find((m) => m.type === "goal.inspect.response") as {
      payload: { events: { type: string }[]; goal: { acknowledgedAt: string | null } };
    };
    expect(inspected.payload.goal.acknowledgedAt).toBeTruthy();
    expect(inspected.payload.events.map((e) => e.type)).toEqual(["goal.created", "goal.cancelled"]);
  });

  async function createManual(session: GoalSession, goalId: string, title: string) {
    await send(session, {
      type: "goal.create.request",
      requestId: `create-${goalId}`,
      goalId,
      title,
      objective: "",
      criteria: [],
    });
  }

  function lastOf<T extends SessionOutboundMessage["type"]>(type: T) {
    return emitted.findLast((m) => m.type === type) as Extract<SessionOutboundMessage, { type: T }>;
  }

  test("renames, reprioritises, archives, filters and deletes goals", async () => {
    const session = await openSession();
    await createManual(session, "g1", "Fix login");
    await send(session, {
      type: "goal.create.request",
      requestId: "c2",
      goalId: "g2",
      title: "Write docs",
      objective: "",
      criteria: [],
      priority: "high",
    });
    await send(session, {
      type: "goal.rename.request",
      requestId: "r1",
      goalId: "g1",
      title: " Fix signup ",
    });
    expect(lastOf("goal.rename.response").payload.goal?.title).toBe("Fix signup");
    await send(session, {
      type: "goal.set_priority.request",
      requestId: "r2",
      goalId: "g1",
      priority: "low",
    });
    expect(lastOf("goal.set_priority.response").payload.goal?.priority).toBe("low");

    await send(session, { type: "goal.list.request", requestId: "l1" });
    expect(lastOf("goal.list.response").payload.goals.map((g) => g.id)).toEqual(["g2", "g1"]);
    await send(session, { type: "goal.list.request", requestId: "l2", query: "SIGNUP" });
    expect(lastOf("goal.list.response").payload.goals.map((g) => g.id)).toEqual(["g1"]);
    await send(session, { type: "goal.list.request", requestId: "l3", priority: ["high"] });
    expect(lastOf("goal.list.response").payload.goals.map((g) => g.id)).toEqual(["g2"]);

    // A live goal must be stopped first.
    await send(session, { type: "goal.archive.request", requestId: "a0", goalId: "g1" });
    expect(lastOf("rpc_error").payload).toMatchObject({
      requestId: "a0",
      error: expect.stringMatching(/stop it before it can be archived/),
    });
    await send(session, { type: "goal.cancel.request", requestId: "x1", goalId: "g1" });
    await send(session, { type: "goal.archive.request", requestId: "a1", goalId: "g1" });
    expect(lastOf("goal.archive.response").payload.goal?.archivedAt).toBeTruthy();

    // Old clients send no filter and get archived goals hidden.
    await send(session, { type: "goal.list.request", requestId: "l4" });
    expect(lastOf("goal.list.response").payload.goals.map((g) => g.id)).toEqual(["g2"]);
    await send(session, { type: "goal.list.request", requestId: "l5", includeArchived: true });
    expect(lastOf("goal.list.response").payload.goals.map((g) => g.id)).toEqual(["g2", "g1"]);
    await send(session, {
      type: "goal.list.request",
      requestId: "l6",
      includeArchived: true,
      archived: "only",
    });
    expect(lastOf("goal.list.response").payload.goals.map((g) => g.id)).toEqual(["g1"]);
    await send(session, {
      type: "goal.list.request",
      requestId: "l7",
      archived: "include",
      status: ["cancelled"],
    });
    expect(lastOf("goal.list.response").payload.goals.map((g) => g.id)).toEqual(["g1"]);

    await send(session, { type: "goal.unarchive.request", requestId: "u1", goalId: "g1" });
    expect(lastOf("goal.unarchive.response").payload.goal?.archivedAt).toBeNull();

    await send(session, { type: "goal.delete.request", requestId: "d0", goalId: "g2" });
    expect(lastOf("rpc_error").payload).toMatchObject({
      requestId: "d0",
      requestType: "goal.delete.request",
      error: expect.stringMatching(/stop it before it can be deleted/),
    });
    await send(session, { type: "goal.delete.request", requestId: "d1", goalId: "g1" });
    expect(lastOf("goal.delete.response").payload).toEqual({
      requestId: "d1",
      goalId: "g1",
      deleted: true,
      retained: [],
      error: null,
    });
    await send(session, { type: "goal.delete.request", requestId: "d2", goalId: "g1" });
    expect(lastOf("goal.delete.response").payload.deleted).toBe(false);
    await send(session, { type: "goal.list.request", requestId: "l8", archived: "include" });
    expect(lastOf("goal.list.response").payload.goals.map((g) => g.id)).toEqual(["g2"]);
  });

  for (const capable of [true, false]) {
    test(`${capable ? "keeps" : "omits"} goal management events for clients ${capable ? "with" : "without"} the capability`, async () => {
      const session = await openSession(true, true, capable);
      await createManual(session, "g1", "T");
      await send(session, {
        type: "goal.rename.request",
        requestId: "r1",
        goalId: "g1",
        title: "U",
      });
      await send(session, {
        type: "goal.set_priority.request",
        requestId: "r2",
        goalId: "g1",
        priority: "high",
      });
      await send(session, { type: "goal.cancel.request", requestId: "r3", goalId: "g1" });
      await send(session, { type: "goal.archive.request", requestId: "r4", goalId: "g1" });
      await send(session, { type: "goal.unarchive.request", requestId: "r5", goalId: "g1" });
      await send(session, { type: "goal.inspect.request", requestId: "r6", goalId: "g1" });
      const inspected = lastOf("goal.inspect.response").payload;
      expect(inspected.goal?.title).toBe("U");
      expect(inspected.events.map((e) => e.type)).toEqual(
        capable
          ? [
              "goal.created",
              "goal.renamed",
              "goal.priority_set",
              "goal.cancelled",
              "goal.archived",
              "goal.unarchived",
            ]
          : ["goal.created", "goal.cancelled"],
      );
    });
  }

  for (const capable of [true, false]) {
    test(`config edits and the auto policy ${capable ? "reach" : "are hidden from"} clients ${capable ? "with" : "without"} the capability`, async () => {
      const session = await openSession(true, true, true, capable);
      await send(session, {
        type: "goal.create.request",
        requestId: "r0",
        goalId: "g1",
        title: "T",
        objective: "o",
        criteria: ["works"],
        config: {
          cwd: "/repo",
          leadProvider: "claude",
          defaultProvider: "claude",
          maxParallel: 2,
          maxAttempts: 2,
          autoApprovePlan: false,
          notifyLead: true,
          onPermissionRequest: "auto",
        },
      });
      await send(session, {
        type: "goal.update_config.request",
        requestId: "r1",
        goalId: "g1",
        changes: { maxParallel: 3, limits: { maxRuns: 80 } },
        eventId: "edit-1",
      });
      await send(session, { type: "goal.list.request", requestId: "r2" });
      await send(session, { type: "goal.inspect.request", requestId: "r3", goalId: "g1" });

      const policy = capable ? "auto" : "wait";
      const updated = lastOf("goal.update_config.response").payload.goal;
      expect(updated?.config).toMatchObject({
        maxParallel: 3,
        limits: { maxRuns: 80 },
        onPermissionRequest: policy,
      });
      expect(lastOf("goal.list.response").payload.goals[0]?.config?.onPermissionRequest).toBe(
        policy,
      );
      const inspected = lastOf("goal.inspect.response").payload;
      expect(inspected.goal?.config?.onPermissionRequest).toBe(policy);
      expect(inspected.events.map((e) => e.type)).toEqual(
        capable ? ["goal.created", "goal.config_updated"] : ["goal.created"],
      );
      const created = inspected.events[0];
      expect(created?.type === "goal.created" && created.config?.onPermissionRequest).toBe(policy);
    });
  }

  for (const capable of [true, false]) {
    test(`the usage breakdown ${capable ? "reaches" : "is left out for"} clients ${capable ? "with" : "without"} the capability`, async () => {
      const at = "2026-01-01T00:00:00.000Z";
      const events = [
        {
          type: "goal.created",
          title: "T",
          objective: "o",
          criteria: [{ id: "c1", text: "works" }],
          config: {
            cwd: "/repo",
            leadProvider: "claude",
            defaultProvider: "codex",
            maxParallel: 2,
            maxAttempts: 2,
            autoApprovePlan: false,
            notifyLead: false,
          },
        },
        {
          type: "usage.recorded",
          role: "lead",
          agentId: "lead-1",
          usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.1 },
        },
      ];
      await writeFile(
        join(dir, "g1.jsonl"),
        `${events.map((e, i) => JSON.stringify({ id: `g1-${i + 1}`, goalId: "g1", seq: i + 1, at, ...e })).join("\n")}\n`,
      );
      const session = await openSession(true, true, true, true, capable);
      await send(session, { type: "goal.list.request", requestId: "r1" });
      await send(session, { type: "goal.inspect.request", requestId: "r2", goalId: "g1" });
      await send(session, {
        type: "goal.rename.request",
        requestId: "r3",
        goalId: "g1",
        title: "U",
      });

      const goals = [
        lastOf("goal.list.response").payload.goals[0],
        lastOf("goal.inspect.response").payload.goal,
        lastOf("goal.rename.response").payload.goal,
      ];
      for (const goal of goals) {
        // The totals reach every client; only the breakdown is new.
        expect(goal?.usage).toMatchObject({ totalTokens: 15, costReportedTurns: 1 });
        if (capable) {
          expect(goal?.usageByRole?.lead).toMatchObject({ totalTokens: 15 });
          expect(goal?.usageBreakdown).toEqual([
            expect.objectContaining({ agentId: "lead-1", role: "lead", provider: "claude" }),
          ]);
        } else {
          expect(goal).not.toHaveProperty("usageByRole");
          expect(goal).not.toHaveProperty("usageBreakdown");
          expect(goal).not.toHaveProperty("usageBreakdownTruncated");
        }
      }
    });
  }

  for (const capable of [true, false]) {
    test(`a merge retried by goal.retry ${capable ? "shows" : "is hidden from"} clients ${capable ? "with" : "without"} the capability`, async () => {
      const at = new Date().toISOString();
      const move = (to: string, extra: Record<string, unknown> = {}) => ({
        type: "changeset.transitioned",
        changeSetId: "cs1",
        to,
        ...extra,
      });
      const events = [
        {
          type: "goal.created",
          title: "T",
          objective: "o",
          criteria: [{ id: "c1", text: "works" }],
          config: {
            cwd: "/repo",
            leadProvider: "claude",
            defaultProvider: "codex",
            maxParallel: 2,
            maxAttempts: 2,
            autoApprovePlan: false,
            notifyLead: false,
          },
        },
        { type: "plan.proposed", tasks: [task("a")] },
        { type: "plan.approved" },
        { type: "task.started", taskId: "a" },
        { type: "task.succeeded", taskId: "a" },
        {
          type: "changeset.captured",
          changeSetId: "cs1",
          taskId: "a",
          runId: "a-a1",
          round: 0,
          supersedes: null,
          workspaceId: "ws",
          cwd: "/w",
          branch: "b",
          baseCommit: "base",
          headCommit: "h1",
          files: [],
        },
        move("in_review"),
        move("approved"),
        move("integrating"),
        move("rejected", { error: "Integration failed: boom", reason: "integration_failed" }),
        { type: "goal.failed", reason: "Integrating cs1 failed: boom" },
      ];
      await writeFile(
        join(dir, "g1.jsonl"),
        `${events.map((e, i) => JSON.stringify({ id: `g1-${i + 1}`, goalId: "g1", seq: i + 1, at, ...e })).join("\n")}\n`,
      );
      const session = await openSession(true, true, true, true, true, capable);
      await send(session, { type: "goal.retry.request", requestId: "r1", goalId: "g1" });
      await send(session, { type: "goal.inspect.request", requestId: "r2", goalId: "g1" });

      expect(lastOf("goal.retry.response").payload.goal?.changeSets[0]?.status).toBe("approved");
      const types = lastOf("goal.inspect.response").payload.events.map((e) => e.type);
      expect(types.includes("changeset.integration_retried")).toBe(capable);
      expect(types.at(-1)).toBe(capable ? "changeset.integration_retried" : "goal.failed");
    });
  }

  test("goal.retry carries its time mode to the service", async () => {
    // Created two days ago, past the default time limit of a day.
    const at = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString();
    const events = [
      {
        type: "goal.created",
        title: "T",
        objective: "o",
        criteria: [{ id: "c1", text: "works" }],
        config: {
          cwd: "/repo",
          leadProvider: "claude",
          defaultProvider: "codex",
          maxParallel: 2,
          maxAttempts: 2,
          autoApprovePlan: false,
          notifyLead: false,
        },
      },
      { type: "plan.proposed", tasks: [task("a")] },
      { type: "plan.approved" },
      { type: "task.started", taskId: "a" },
      { type: "task.failed", taskId: "a", error: "boom" },
      { type: "goal.failed", reason: "Task a failed" },
    ];
    await writeFile(
      join(dir, "g1.jsonl"),
      `${events.map((e, i) => JSON.stringify({ id: `g1-${i + 1}`, goalId: "g1", seq: i + 1, at, ...e })).join("\n")}\n`,
    );
    const session = await openSession();
    await send(session, { type: "goal.retry.request", requestId: "r1", goalId: "g1" });
    const refused = emitted.findLast((m) => m.type === "rpc_error") as {
      payload: { requestId: string; error: string };
    };
    expect(refused.payload).toMatchObject({ requestId: "r1" });
    expect(refused.payload.error).toMatch(/time limit has passed; choose time mode fresh/);

    await send(session, {
      type: "goal.retry.request",
      requestId: "r2",
      goalId: "g1",
      timeMode: "fresh",
    });
    const goal = lastOf("goal.retry.response").payload.goal;
    expect(goal?.status).toBe("executing");
    expect(Date.parse(goal?.timeBaseAt ?? "")).toBeGreaterThan(Date.parse(at));
  });

  for (const capable of [true, false]) {
    test(`plan revisions ${capable ? "show to" : "are hidden from"} clients ${capable ? "with" : "without"} the capability`, async () => {
      const at = new Date().toISOString();
      const events = [
        {
          type: "goal.created",
          title: "T",
          objective: "o",
          criteria: [{ id: "c1", text: "works" }],
          config: {
            cwd: "/repo",
            leadProvider: "claude",
            defaultProvider: "codex",
            maxParallel: 2,
            maxAttempts: 2,
            autoApprovePlan: false,
            notifyLead: false,
          },
        },
        { type: "plan.proposed", tasks: [task("a")] },
        { type: "plan.approved" },
        {
          type: "plan.revision_proposed",
          revisionId: "rv1",
          source: "person",
          reason: "more work",
          ops: [{ op: "add", task: task("b", ["a"]) }],
        },
        { type: "plan.revision_approved", revisionId: "rv1" },
        {
          type: "plan.revision_proposed",
          revisionId: "rv2",
          source: "lead",
          reason: "less work",
          ops: [{ op: "remove", taskId: "b" }],
        },
        { type: "plan.revision_rejected", revisionId: "rv2", reason: "keep b" },
        {
          type: "plan.revision_proposed",
          revisionId: "rv3",
          source: "lead",
          reason: "one more",
          ops: [{ op: "add", task: task("c") }],
        },
      ];
      await writeFile(
        join(dir, "g1.jsonl"),
        `${events.map((e, i) => JSON.stringify({ id: `g1-${i + 1}`, goalId: "g1", seq: i + 1, at, ...e })).join("\n")}\n`,
      );
      const session = await openSession(true, true, true, true, true, true, capable);
      await send(session, { type: "goal.inspect.request", requestId: "r1", goalId: "g1" });

      const inspected = lastOf("goal.inspect.response").payload;
      expect(inspected.events.map((e) => e.type)).toEqual([
        "goal.created",
        "plan.proposed",
        "plan.approved",
        ...(capable
          ? [
              "plan.revision_proposed",
              "plan.revision_approved",
              "plan.revision_proposed",
              "plan.revision_rejected",
              "plan.revision_proposed",
            ]
          : []),
      ]);
      expect(inspected.goal?.tasks.map((t) => t.id)).toEqual(["a", "b"]);
      // goal.inspect carries every revision in full.
      expect(inspected.goal?.planRevisions?.map((r) => r.ops.length)).toEqual(
        capable ? [1, 1, 1] : undefined,
      );

      // goal.list and mutation responses keep only the pending revision's ops.
      await send(session, { type: "goal.list.request", requestId: "r2" });
      await send(session, {
        type: "goal.rename.request",
        requestId: "r3",
        goalId: "g1",
        title: "U",
      });
      for (const goal of [
        lastOf("goal.list.response").payload.goals[0],
        lastOf("goal.rename.response").payload.goal,
      ]) {
        if (capable) {
          expect(goal?.planRevisions?.map((r) => [r.id, r.status, r.ops.length])).toEqual([
            ["rv1", "applied", 0],
            ["rv2", "rejected", 0],
            ["rv3", "pending", 1],
          ]);
          expect(goal?.planRevisions?.[1]?.decisionReason).toBe("keep b");
        } else {
          expect(goal).not.toHaveProperty("planRevisions");
        }
      }
    });
  }

  for (const [capable, shown] of [
    [true, "show to clients with"],
    [false, "are hidden from clients without"],
  ] as const) {
    test(`Lead interventions ${shown} the capability`, async () => {
      const at = new Date().toISOString();
      const events = [
        {
          type: "goal.created",
          title: "T",
          objective: "o",
          criteria: [{ id: "c1", text: "works" }],
          config: {
            cwd: "/repo",
            leadProvider: "claude",
            defaultProvider: "codex",
            maxParallel: 2,
            maxAttempts: 2,
            autoApprovePlan: false,
            notifyLead: false,
            leadInterventions: true,
          },
        },
        { type: "lead.attached", agentId: "lead-1" },
        { type: "plan.proposed", tasks: [task("a")] },
        { type: "plan.approved" },
        { type: "task.started", taskId: "a" },
        { type: "run.started", runId: "a-a1", taskId: "a", provider: "codex" },
        {
          type: "intervention.requested",
          interventionId: "a-a1:check-1",
          taskId: "a",
          runId: "a-a1",
          trigger: "watch",
          triggers: ["stall"],
          checkIn: 1,
          error: "",
          workSummary: " src/a.ts | 2 +-",
        },
        {
          type: "intervention.resolved",
          interventionId: "a-a1:check-1",
          outcome: "nudged",
          message: "run the tests",
        },
      ];
      await writeFile(
        join(dir, "g1.jsonl"),
        `${events.map((e, i) => JSON.stringify({ id: `g1-${i + 1}`, goalId: "g1", seq: i + 1, at, ...e })).join("\n")}\n`,
      );
      const session = await openSession(true, true, true, true, true, true, true, capable);
      await send(session, { type: "goal.inspect.request", requestId: "r1", goalId: "g1" });

      const inspected = lastOf("goal.inspect.response").payload;
      const types = inspected.events.map((e) => e.type);
      expect(types.includes("intervention.requested")).toBe(capable);
      expect(types.includes("intervention.resolved")).toBe(capable);
      expect(types.at(-1)).toBe(capable ? "intervention.resolved" : "run.started");
      await send(session, { type: "goal.list.request", requestId: "r2" });
      const listedGoal = lastOf("goal.list.response").payload.goals[0];
      if (!capable) {
        expect(inspected.goal).not.toHaveProperty("interventions");
        expect(listedGoal).not.toHaveProperty("interventions");
        return;
      }
      // goal.inspect carries the intervention in full.
      expect(inspected.goal?.interventions?.[0]).toMatchObject({
        message: "run the tests",
        workSummary: " src/a.ts | 2 +-",
      });
      // goal.list leaves out the work summary and the nudge's message.
      const listed = listedGoal?.interventions?.[0];
      expect(listed).toMatchObject({ outcome: "nudged", checkIn: 1 });
      expect(listed).not.toHaveProperty("message");
      expect(listed).not.toHaveProperty("workSummary");
    });
  }

  // A failed goal whose recovery Lead proposed a revise that waits for a person, or, with
  // `applied`, a retry with advice that reopened the goal.
  async function writeRecoveryLog(applied: boolean): Promise<void> {
    const at = new Date().toISOString();
    const decision = applied
      ? { decision: "retry", reason: "flaky", hints: { b: "use the cache" } }
      : { decision: "revise", reason: "drop b", ops: [{ op: "remove", taskId: "b" }] };
    const events = [
      {
        type: "goal.created",
        title: "T",
        objective: "o",
        criteria: [{ id: "c1", text: "works" }],
        config: {
          cwd: "/repo",
          leadProvider: "claude",
          defaultProvider: "codex",
          maxParallel: 2,
          maxAttempts: 2,
          autoApprovePlan: false,
          notifyLead: false,
        },
      },
      { type: "plan.proposed", tasks: [task("a"), task("b")] },
      { type: "plan.approved" },
      { type: "task.started", taskId: "b" },
      { type: "task.failed", taskId: "b", error: "boom" },
      { type: "goal.failed", reason: "No task can make progress" },
      {
        type: "recovery.started",
        recoveryId: "r1",
        startedBy: "person",
        guidance: { goal: "keep the API" },
      },
      { type: "lead.attached", agentId: "lead-r1" },
      {
        type: "intervention.requested",
        interventionId: "recovery-r1",
        trigger: "recovery",
        error: "",
      },
      { type: "recovery.decided", recoveryId: "r1", decision },
      ...(applied ? [{ type: "recovery.resolved", recoveryId: "r1", outcome: "applied" }] : []),
    ];
    await writeFile(
      join(dir, "g1.jsonl"),
      `${events.map((e, i) => JSON.stringify({ id: `g1-${i + 1}`, goalId: "g1", seq: i + 1, at, ...e })).join("\n")}\n`,
    );
  }

  for (const [capable, shown] of [
    [true, "show to clients with"],
    [false, "are hidden from clients without"],
  ] as const) {
    test(`recoveries ${shown} the capability`, async () => {
      await writeRecoveryLog(false);
      const session = await openSession(true, true, true, true, true, true, true, true, capable);
      await send(session, { type: "goal.inspect.request", requestId: "r1", goalId: "g1" });
      const inspected = lastOf("goal.inspect.response").payload;
      const types = inspected.events.map((e) => e.type);
      expect(types.includes("recovery.started")).toBe(capable);
      expect(types.includes("recovery.decided")).toBe(capable);
      // The Lead's decision prompt goes with the recovery it belongs to.
      expect(types.includes("intervention.requested")).toBe(capable);
      // The recovery Lead joining a failed goal stays: older clients know lead.attached.
      expect(types.filter((t) => t === "lead.attached")).toHaveLength(1);
      await send(session, { type: "goal.list.request", requestId: "r2" });
      const listed = lastOf("goal.list.response").payload.goals[0];
      for (const goal of [inspected.goal, listed]) {
        if (capable) {
          expect(goal?.recovery?.status).toBe("awaiting_approval");
          expect(goal?.guidance).toEqual({ goal: "keep the API" });
          expect(goal?.interventions?.map((i) => i.id)).toEqual(["recovery-r1"]);
        } else {
          expect(goal).not.toHaveProperty("recovery");
          expect(goal).not.toHaveProperty("guidance");
          expect(goal?.interventions ?? []).toEqual([]);
          expect(goal?.status).toBe("failed");
        }
      }
      if (capable) {
        // A revise waiting for approval keeps its ops in the list, which the person decides on.
        expect(listed?.recovery?.decision?.ops).toEqual([{ op: "remove", taskId: "b" }]);
      }
    });
  }

  test("the list leaves out an applied recovery's ops and the Lead's advice; inspect keeps them", async () => {
    await writeRecoveryLog(true);
    const session = await openSession();
    await send(session, { type: "goal.inspect.request", requestId: "r1", goalId: "g1" });
    const inspected = lastOf("goal.inspect.response").payload.goal;
    expect(inspected?.status).toBe("executing");
    expect(inspected?.guidance).toEqual({
      goal: "keep the API",
      lead: { recoveryId: "r1", tasks: { b: "use the cache" } },
    });
    await send(session, { type: "goal.list.request", requestId: "r2" });
    const listed = lastOf("goal.list.response").payload.goals[0];
    expect(listed?.guidance).toEqual({ goal: "keep the API" });
    expect(listed?.recovery).toMatchObject({ status: "applied", decision: { decision: "retry" } });
  });

  test("plan revision RPCs propose, decide and refuse through the service", async () => {
    const at = new Date().toISOString();
    const events = [
      {
        type: "goal.created",
        title: "T",
        objective: "o",
        criteria: [{ id: "c1", text: "works" }],
        config: {
          cwd: "/repo",
          leadProvider: "claude",
          defaultProvider: "codex",
          maxParallel: 2,
          maxAttempts: 2,
          autoApprovePlan: false,
          notifyLead: false,
        },
      },
      { type: "plan.proposed", tasks: [task("a"), task("b")] },
      { type: "lead.attached", agentId: "lead-1", workspaceId: "ws-lead" },
      { type: "plan.approved" },
    ];
    await writeFile(
      join(dir, "g1.jsonl"),
      `${events.map((e, i) => JSON.stringify({ id: `g1-${i + 1}`, goalId: "g1", seq: i + 1, at, ...e })).join("\n")}\n`,
    );
    const session = await openSession();
    await send(session, {
      type: "goal.plan.revise.request",
      requestId: "r1",
      goalId: "g1",
      tasks: [task("a")],
      remove: ["b"],
      reason: "b is not needed",
      agentId: "lead-1",
      eventId: "e1",
    });
    const proposed = lastOf("goal.plan.revise.response").payload;
    expect(proposed.error).toBeNull();
    expect(proposed.goal?.planRevisions).toEqual([
      expect.objectContaining({ id: "rev-e1", source: "lead", status: "pending" }),
    ]);

    await send(session, {
      type: "goal.plan.reject_revision.request",
      requestId: "r2",
      goalId: "g1",
      revisionId: "rev-e1",
      feedback: "keep b",
    });
    expect(
      lastOf("goal.plan.reject_revision.response").payload.goal?.planRevisions?.[0],
    ).toMatchObject({ status: "rejected", decisionReason: "keep b" });

    await send(session, {
      type: "goal.plan.approve_revision.request",
      requestId: "r3",
      goalId: "g1",
      revisionId: "rev-e1",
    });
    expect(lastOf("rpc_error").payload).toMatchObject({
      requestId: "r3",
      error: expect.stringMatching(/rev-e1 is rejected/),
    });
    await send(session, {
      type: "goal.plan.revise.request",
      requestId: "r4",
      goalId: "g1",
      ops: [{ op: "remove", taskId: "b" }],
      reason: "x",
      agentId: "worker-9",
    });
    expect(lastOf("rpc_error").payload).toMatchObject({
      requestId: "r4",
      error: expect.stringMatching(/Only the goal's Lead or a person/),
    });
  });

  /** A session over a service whose daemon reports `problem` for the integration worktree. */
  async function openRecoverySession(problem: string | null = null): Promise<GoalSession> {
    const log = new GoalEventLog({ dir });
    const service = new GoalService(new GoalStore(log), log);
    await service.start();
    service.attachActivityProbe({
      hasLiveWork: () => false,
      integrationProblem: async () => problem,
    });
    return new GoalSession({
      host: { emit: (msg) => emitted.push(msg) },
      goalService: service,
      logger: pino({ level: "silent" }),
    });
  }

  test("recovery RPCs start a recovery, refuse an agent, and carry guidance", async () => {
    await writeRecoveryLog(false);
    // Cancel the recovery the log holds, so a new one can start.
    const session = await openRecoverySession();
    await send(session, {
      type: "goal.recovery.cancel.request",
      requestId: "c1",
      goalId: "g1",
      recoveryId: "r1",
    });
    expect(lastOf("goal.recovery.cancel.response").payload.goal?.recovery).toMatchObject({
      id: "r1",
      status: "ended",
      outcome: "cancelled",
    });

    await send(session, {
      type: "goal.recovery.start.request",
      requestId: "s1",
      goalId: "g1",
      agentId: "agent-7",
    });
    expect(lastOf("rpc_error").payload).toMatchObject({
      requestId: "s1",
      error: expect.stringContaining("Only a person can start a recovery"),
    });
    await send(session, {
      type: "goal.recovery.start.request",
      requestId: "s2",
      goalId: "g1",
      guidance: { goal: null, tasks: { b: "use the cache" } },
      eventId: "e1",
    });
    const started = lastOf("goal.recovery.start.response").payload;
    expect(started.error).toBeNull();
    expect(started.goal?.recovery).toMatchObject({ status: "deciding", startedBy: "person" });
    // null cleared the person's instruction for the goal; the task's was added.
    expect(started.goal?.guidance).toEqual({ tasks: { b: "use the cache" } });

    await send(session, {
      type: "goal.retry.request",
      requestId: "t1",
      goalId: "g1",
      guidance: { goal: "x" },
      agentId: "agent-7",
    });
    expect(lastOf("rpc_error").payload).toMatchObject({
      requestId: "t1",
      error: expect.stringContaining("Only a person can give guidance"),
    });
    await send(session, { type: "goal.retry.request", requestId: "t2", goalId: "g1" });
    expect(lastOf("rpc_error").payload).toMatchObject({
      requestId: "t2",
      error: expect.stringContaining("cancel the recovery first: paseo goal recover g1 --cancel"),
    });
  });

  test("recovery decide applies after the integration check, or ends it for a person, uncounted", async () => {
    for (const problem of [null, "The integration worktree /w has uncommitted changes"]) {
      await writeRecoveryLog(false);
      const session = await openRecoverySession(problem);
      await send(session, {
        type: "goal.recovery.decide.request",
        requestId: "d1",
        goalId: "g1",
        recoveryId: "r1",
        approve: true,
        eventId: "approve-1",
      });
      const goal = lastOf("goal.recovery.decide.response").payload.goal;
      if (problem === null) {
        expect(goal?.status).toBe("executing");
        expect(goal?.recovery).toMatchObject({ status: "applied" });
        // The slim payload leaves out the applied revise's ops.
        expect(goal?.recovery?.decision?.ops).toEqual([]);
        expect(goal?.tasks.map((t) => t.id)).toEqual(["a"]);
      } else {
        expect(goal?.status).toBe("failed");
        expect(goal?.recovery).toMatchObject({ status: "ended", outcome: "needs_person" });
        expect(goal?.failureReason).toBe(`Recovery needs a person: ${problem}`);
        expect(goal?.recoveries ?? 0).toBe(0);
      }
      await rm(join(dir, "g1.jsonl"));
    }
  });

  /** A goal whose one task succeeded and whose criterion c1 the verifier found unmet. */
  async function writeUnmetLog(): Promise<void> {
    const at = new Date().toISOString();
    const events = [
      {
        type: "goal.created",
        title: "T",
        objective: "o",
        criteria: [
          { id: "c1", text: "works" },
          { id: "c2", text: "fast" },
        ],
        config: {
          cwd: "/repo",
          leadProvider: "claude",
          defaultProvider: "codex",
          maxParallel: 2,
          maxAttempts: 2,
          autoApprovePlan: false,
          notifyLead: false,
        },
      },
      { type: "plan.proposed", tasks: [{ ...task("a"), kind: "read" }] },
      { type: "plan.approved" },
      { type: "task.started", taskId: "a" },
      { type: "task.succeeded", taskId: "a" },
      { type: "criterion.verified", criterionId: "c2", evidence: "ok" },
      { type: "goal.failed", reason: "Acceptance criteria not met: works (no)" },
    ];
    await writeFile(
      join(dir, "g1.jsonl"),
      `${events.map((e, i) => JSON.stringify({ id: `g1-${i + 1}`, goalId: "g1", seq: i + 1, at, ...e })).join("\n")}\n`,
    );
  }

  test.each([
    [true, "show to clients with"],
    [false, "are hidden from clients without"],
  ] as const)("waits for an answer %s the goal_user_wait capability", async (capable, _shown) => {
    const at = new Date().toISOString();
    const events = [
      {
        type: "goal.created",
        title: "T",
        objective: "o",
        criteria: [{ id: "c1", text: "works" }],
        config: {
          cwd: "/repo",
          leadProvider: "claude",
          defaultProvider: "codex",
          maxParallel: 2,
          maxAttempts: 2,
          autoApprovePlan: false,
          notifyLead: false,
          limits: { userWaitMinutes: 30 },
        },
      },
      { type: "plan.proposed", tasks: [task("a")] },
      { type: "plan.approved" },
      { type: "task.started", taskId: "a" },
      { type: "run.started", runId: "a-a1", taskId: "a", provider: "codex" },
      { type: "wait.started", agentId: "agent-a", role: "worker", runId: "a-a1" },
      { type: "wait.ended", agentId: "agent-a", outcome: "answered" },
    ];
    await writeFile(
      join(dir, "g1.jsonl"),
      `${events.map((e, i) => JSON.stringify({ id: `g1-${i + 1}`, goalId: "g1", seq: i + 1, at, ...e })).join("\n")}\n`,
    );
    const session = await openSession(
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      capable,
    );
    await send(session, { type: "goal.inspect.request", requestId: "i1", goalId: "g1" });
    const { goal, events: shown } = lastOf("goal.inspect.response").payload;
    expect(shown.filter((e) => e.type.startsWith("wait.")).length).toBe(capable ? 2 : 0);
    expect(shown).toHaveLength(capable ? 7 : 5);
    expect(goal?.config?.limits?.userWaitMinutes).toBe(30);
  });

  test("goal.outcome.accept completes a failed goal with its unmet criteria waived, and refuses an agent", async () => {
    await writeUnmetLog();
    const session = await openSession();
    const accept = (requestId: string, fields: Record<string, unknown>) =>
      send(session, {
        type: "goal.outcome.accept.request",
        requestId,
        goalId: "g1",
        criterionIds: ["c1"],
        note: "good enough",
        ...fields,
      } as SessionInboundMessage);
    await accept("a1", { agentId: "agent-7" });
    expect(lastOf("rpc_error").payload).toMatchObject({
      requestId: "a1",
      error: expect.stringContaining("Only a person can accept a goal as is"),
    });
    await accept("a2", { criterionIds: [] });
    expect(lastOf("rpc_error").payload).toMatchObject({
      requestId: "a2",
      error: expect.stringContaining("missing: c1"),
    });
    await accept("a3", { client: "app" });
    const goal = lastOf("goal.outcome.accept.response").payload.goal;
    expect(goal).toMatchObject({
      status: "completed",
      failureReason: null,
      accepted: {
        note: "good enough",
        from: "Acceptance criteria not met: works (no)",
        client: "app",
      },
    });
    expect(goal?.criteria.map((c) => [c.id, c.waived?.note ?? null])).toEqual([
      ["c1", "good enough"],
      ["c2", null],
    ]);
  });

  test.each([
    [true, "show to clients with"],
    [false, "are hidden from clients without"],
  ] as const)("acceptances %s the capability", async (capable, _shown) => {
    await writeUnmetLog();
    const accepting = await openSession();
    await send(accepting, {
      type: "goal.outcome.accept.request",
      requestId: "a1",
      goalId: "g1",
      criterionIds: ["c1"],
      note: "good enough",
      client: "cli",
    });
    const session = await openSession(
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      capable,
    );
    await send(session, { type: "goal.inspect.request", requestId: "i1", goalId: "g1" });
    const { goal, events } = lastOf("goal.inspect.response").payload;
    expect(goal?.status).toBe("completed");
    expect(events.some((e) => e.type === "goal.accepted")).toBe(capable);
    expect(goal?.accepted !== undefined).toBe(capable);
    expect(goal?.criteria.some((c) => c.waived)).toBe(capable);
    await send(session, { type: "goal.list.request", requestId: "l1" });
    const listed = lastOf("goal.list.response").payload.goals[0];
    expect(listed?.accepted !== undefined).toBe(capable);
    expect(listed?.criteria.some((c) => c.waived)).toBe(capable);
  });

  test("recovery RPCs need automation.manage, like the other goal controls", () => {
    for (const type of [
      "goal.recovery.start.request",
      "goal.recovery.decide.request",
      "goal.recovery.cancel.request",
      "goal.outcome.accept.request",
    ] as const) {
      expect(requiredPermissionForInbound(type)).toBe("automation.manage");
      const response = {
        type: type.replace(".request", ".response"),
        payload: { requestId: "x", goal: null, error: null },
      };
      expect(requiredPermissionForOutbound(response as never)).toBe("automation.manage");
    }
  });
});

describe("goal.update pushes", () => {
  const at = "2026-01-01T00:00:00.000Z";
  const revision = (id: string, status: string) => ({
    id,
    source: "lead",
    reason: id,
    ops: [{ op: "remove" as const, taskId: "a" }],
    status,
    proposedAt: at,
  });
  const goal = {
    id: "g1",
    title: "T",
    objective: "",
    status: "executing",
    config: null,
    leadAgentId: null,
    leadWorkspaceId: null,
    criteria: [],
    tasks: [],
    runs: [],
    changeSets: [],
    integration: null,
    lastSeq: 3,
    failureReason: null,
    createdAt: at,
    updatedAt: at,
    planRevisions: [revision("rv1", "applied"), revision("rv2", "pending")],
    interventions: [
      {
        id: "a-a1",
        taskId: "a",
        runId: "a-a1",
        trigger: "timeout",
        error: "timed out",
        workSummary: " 3 files changed",
        status: "open",
        requestedAt: at,
      },
    ],
  } as Goal;

  function session(revisions: boolean, interventions = true, recovery = true, accept = true) {
    const sent: SessionOutboundMessage[] = [];
    return {
      sent,
      supports: (capability: ClientCapability) => {
        if (capability === CLIENT_CAPS.goalPlanRevision) return revisions;
        if (capability === CLIENT_CAPS.goalLeadInterventions) return interventions;
        if (capability === CLIENT_CAPS.goalRecovery) return recovery;
        if (capability === CLIENT_CAPS.goalAccept) return accept;
        return true;
      },
      publish: (message: SessionOutboundMessage) => sent.push(message),
    };
  }

  test("capable clients get the slim history, older ones get no revisions at all", () => {
    const capable = session(true);
    const older = session(false);
    publishGoalUpdate([capable, older], toGoalSummary(goal));

    const pushed = (target: ReturnType<typeof session>) => {
      const message = target.sent[0];
      if (message?.type !== "goal.update") throw new Error("no goal.update");
      return message.payload.goal;
    };
    expect(pushed(capable).planRevisions?.map((r) => [r.id, r.ops.length])).toEqual([
      ["rv1", 0],
      ["rv2", 1],
    ]);
    expect(pushed(capable).interventions?.[0]).not.toHaveProperty("workSummary");
    expect(pushed(capable).interventions?.[0]?.error).toBe("timed out");
    expect(pushed(older)).not.toHaveProperty("planRevisions");
    expect(pushed(older)).not.toHaveProperty("interventions");
  });

  test("a client that parses revisions but not interventions gets the revisions only", () => {
    const revisionsOnly = session(true, false);
    publishGoalUpdate([revisionsOnly], toGoalSummary(goal));
    const message = revisionsOnly.sent[0];
    if (message?.type !== "goal.update") throw new Error("no goal.update");
    expect(message.payload.goal.planRevisions).toHaveLength(2);
    expect(message.payload.goal).not.toHaveProperty("interventions");
  });

  test("a recovery reaches only clients that parse it, each in its own payload", () => {
    const recovering = {
      ...goal,
      status: "failed",
      recovery: {
        id: "r1",
        status: "decided",
        startedAt: at,
        startedBy: "person",
        failureReason: "x",
        decision: { decision: "revise", reason: "r", ops: [{ op: "remove", taskId: "a" }] },
      },
      recoveries: 1,
      guidance: { goal: "keep the API", lead: { recoveryId: "r1", tasks: { a: "hint" } } },
    } as Goal;
    const capable = session(true);
    const older = session(true, true, false);
    publishGoalUpdate([capable, older], toGoalSummary(recovering));
    const pushed = (target: ReturnType<typeof session>) => {
      const message = target.sent[0];
      if (message?.type !== "goal.update") throw new Error("no goal.update");
      return message.payload.goal;
    };
    expect(pushed(capable).recovery?.decision?.ops).toEqual([]);
    expect(pushed(capable).guidance).toEqual({ goal: "keep the API" });
    expect(pushed(capable).recoveries).toBe(1);
    expect(pushed(older)).not.toHaveProperty("recovery");
    expect(pushed(older)).not.toHaveProperty("recoveries");
    expect(pushed(older)).not.toHaveProperty("guidance");
    expect(pushed(older).planRevisions).toHaveLength(2);
  });

  test("an accepted goal reaches older clients as plain completed, without waived fields", () => {
    const accepted = {
      ...goal,
      status: "completed",
      criteria: [
        { id: "c1", text: "works", verifiedAt: null, evidence: null, waived: { at, note: "ok" } },
      ],
      accepted: { at, note: "ok", from: "Acceptance criteria not met: works", client: "app" },
    } as Goal;
    const capable = session(true);
    const older = session(true, true, true, false);
    publishGoalUpdate([capable, older], toGoalSummary(accepted));
    const pushed = (target: ReturnType<typeof session>) => {
      const message = target.sent[0];
      if (message?.type !== "goal.update") throw new Error("no goal.update");
      return message.payload.goal;
    };
    expect(pushed(capable).accepted?.note).toBe("ok");
    expect(pushed(capable).criteria[0]?.waived).toEqual({ at, note: "ok" });
    expect(pushed(older)).not.toHaveProperty("accepted");
    expect(pushed(older).criteria[0]).toEqual({
      id: "c1",
      text: "works",
      verifiedAt: null,
      evidence: null,
    });
    expect(pushed(older).status).toBe("completed");
    // One publish, two variants: the sessions differ only in goal_accept.
    expect(capable.sent[0]).not.toBe(older.sent[0]);
  });

  test("long guidance is cut in the slim payload and marked", () => {
    const long = "x".repeat(SLIM_GUIDANCE_CHARS + 100);
    const guided = { ...goal, guidance: { goal: long, tasks: { a: "short", b: long } } } as Goal;
    const capable = session(true);
    publishGoalUpdate([capable], toGoalSummary(guided));
    const message = capable.sent[0];
    if (message?.type !== "goal.update") throw new Error("no goal.update");
    const guidance = message.payload.goal.guidance;
    expect(guidance?.truncated).toBe(true);
    expect(guidance?.goal).toHaveLength(SLIM_GUIDANCE_CHARS);
    expect(guidance?.tasks).toEqual({ a: "short", b: expect.stringMatching(/…$/) });
    const short = { ...goal, guidance: { goal: "short" } } as Goal;
    const again = session(true);
    publishGoalUpdate([again], toGoalSummary(short));
    const plain = again.sent[0];
    if (plain?.type !== "goal.update") throw new Error("no goal.update");
    expect(plain.payload.goal.guidance).toEqual({ goal: "short" });
  });
});
