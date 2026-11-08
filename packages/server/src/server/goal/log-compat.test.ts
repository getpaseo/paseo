import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { goalPermissionPolicy } from "@getpaseo/protocol/goal/config-bounds";
import { GoalSchema } from "@getpaseo/protocol/goal/types";
import { excludedWaitMs } from "@getpaseo/protocol/goal/time-limit";
import { GoalEventLog } from "./event-log.js";
import { GoalManager } from "./goal-manager.js";
import { reworkWorktreeProblem } from "./goal-recovery.js";
import { GoalService } from "./goal-service.js";
import { GoalStore } from "./goal-store.js";
import { FakeClock, Harness } from "./goal-test-env.js";

/**
 * Logs are append-only and there is no migration step, so every change to an event
 * must keep old logs replayable. These fixtures are logs as earlier phases wrote
 * them: frozen text, not built from the current schemas.
 */
const AT = "2026-01-01T00:00:00.000Z";

function jsonl(goalId: string, events: Record<string, unknown>[]): string {
  return `${events
    .map((e, i) => JSON.stringify({ id: `${goalId}-${i + 1}`, goalId, seq: i + 1, at: AT, ...e }))
    .join("\n")}\n`;
}

const spec = (id: string, kind = "implement") => ({
  id,
  title: `Task ${id}`,
  description: "",
  kind,
  dependsOn: [],
});

const phase1Log = (goalId: string) =>
  jsonl(goalId, [
    {
      type: "goal.created",
      title: "Manual",
      objective: "",
      criteria: [{ id: "c1", text: "works" }],
    },
    { type: "plan.proposed", tasks: [spec("a")] },
    { type: "plan.approved" },
    { type: "task.started", taskId: "a" },
    { type: "task.succeeded", taskId: "a" },
    { type: "criterion.verified", criterionId: "c1" },
    { type: "goal.completed" },
  ]);

const config = {
  cwd: "/repo",
  leadProvider: "claude",
  defaultProvider: "codex",
  maxParallel: 2,
  maxAttempts: 2,
  autoApprovePlan: true,
  notifyLead: false,
};

const phase2Log = (goalId: string) =>
  jsonl(goalId, [
    {
      type: "goal.created",
      title: "Managed",
      objective: "o",
      criteria: [{ id: "c1", text: "w" }],
      config,
    },
    { type: "lead.attached", agentId: "lead-1" },
    { type: "plan.proposed", tasks: [spec("a", "read")] },
    { type: "plan.approved" },
    { type: "task.started", taskId: "a" },
    { type: "run.started", runId: "a-a1", taskId: "a", provider: "codex" },
    { type: "run.attached", runId: "a-a1", agentId: "ag", workspaceId: "ws" },
    { type: "task.succeeded", taskId: "a", summary: "read it" },
    { type: "run.finished", runId: "a-a1", outcome: "succeeded" },
    { type: "lead.notified", key: "all-tasks-finished" },
  ]);

// A managed goal that failed before notifications were recorded: the Lead was told
// with lead.notified, the originating chat with no event at all.
const preNotificationLog = (goalId: string) =>
  jsonl(goalId, [
    {
      type: "goal.created",
      title: "Told",
      objective: "o",
      criteria: [{ id: "c1", text: "w" }],
      config: { ...config, notifyLead: true, originAgentId: "chat-1" },
    },
    { type: "lead.attached", agentId: "lead-1", workspaceId: "lead-ws" },
    { type: "plan.proposed", tasks: [spec("a", "read")] },
    { type: "plan.approved" },
    { type: "task.started", taskId: "a" },
    { type: "run.started", runId: "a-a1", taskId: "a", provider: "codex" },
    { type: "run.finished", runId: "a-a1", outcome: "failed", error: "x" },
    { type: "task.failed", taskId: "a", error: "x" },
    { type: "lead.notified", key: "task-a-failed" },
    { type: "goal.failed", reason: "No task can make progress. Failed or blocked: a" },
  ]);

describe("goal logs written by earlier phases", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "paseo-goal-compat-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function load() {
    const store = new GoalStore(new GoalEventLog({ dir }));
    await store.recover();
    return store;
  }

  test("a phase 1 log replays into a valid completed goal", async () => {
    await writeFile(join(dir, "m1.jsonl"), phase1Log("m1"));
    const goal = (await load()).get("m1");
    expect(goal?.status).toBe("completed");
    expect(GoalSchema.safeParse(goal).success).toBe(true);
    expect(goal).toMatchObject({ config: null, runs: [], changeSets: [], integration: null });
    expect(goal?.criteria[0]).toMatchObject({ verifiedAt: AT, evidence: null });
  });

  test("a phase 2 log replays, with fields added later defaulting sensibly", async () => {
    await writeFile(join(dir, "p2.jsonl"), phase2Log("p2"));
    const goal = (await load()).get("p2");
    expect(goal?.status).toBe("executing");
    expect(GoalSchema.safeParse(goal).success).toBe(true);
    expect(goal).toMatchObject({ leadAgentId: "lead-1", leadWorkspaceId: null });
    expect(goal?.runs[0]).toMatchObject({ id: "a-a1", cwd: null, status: "succeeded" });
    // Logs from before goal thinking carry no thinking anywhere.
    expect(goal?.runs[0]).not.toHaveProperty("thinking");
    expect(goal?.config).not.toHaveProperty("leadThinking");
    expect(goal?.config).not.toHaveProperty("workerThinking");
    // Nor plan revisions, interventions or task run timeouts.
    expect(goal).not.toHaveProperty("planRevisions");
    expect(goal).not.toHaveProperty("interventions");
    // An older goal has no leadInterventions and reads as off.
    expect(goal?.config).not.toHaveProperty("leadInterventions");
    expect(goal?.tasks[0]).not.toHaveProperty("runTimeoutMinutes");
    // Nor a time base: the time limit counts from creation.
    expect(goal).not.toHaveProperty("timeBaseAt");
  });

  test("a retry that restarted the time limit replays to the same time base", async () => {
    const later = "2026-01-03T00:00:00.000Z";
    const lines = preNotificationLog("t1").trimEnd().split("\n");
    lines.push(
      JSON.stringify({
        id: "t1-11",
        goalId: "t1",
        seq: 11,
        at: later,
        type: "goal.retried",
        taskIds: ["a"],
        reopen: true,
        timeMode: "remaining",
        activeMs: 60_000,
      }),
    );
    await writeFile(join(dir, "t1.jsonl"), `${lines.join("\n")}\n`);
    const first = (await load()).get("t1");
    expect(first).toMatchObject({ status: "executing", timeBaseAt: "2026-01-02T23:59:00.000Z" });
    expect(GoalSchema.safeParse(first).success).toBe(true);
    expect((await load()).get("t1")).toEqual(first);
  });

  test("plan revisions round-trip through the log and replay to the same goal", async () => {
    await writeFile(
      join(dir, "r1.jsonl"),
      jsonl("r1", [
        {
          type: "goal.created",
          title: "Revised",
          objective: "o",
          criteria: [{ id: "c1", text: "w" }],
          config,
        },
        { type: "lead.attached", agentId: "lead-1" },
        { type: "plan.proposed", tasks: [spec("a"), spec("b")] },
        { type: "plan.approved" },
        { type: "task.started", taskId: "a" },
        { type: "run.started", runId: "a-a1", taskId: "a", provider: "codex" },
        {
          type: "run.finished",
          runId: "a-a1",
          outcome: "failed",
          error: "Turn timed out after 90 minutes",
        },
        { type: "task.failed", taskId: "a", error: "Turn timed out after 90 minutes" },
        {
          type: "plan.revision_proposed",
          revisionId: "rv1",
          source: "lead",
          reason: "a is too big",
          ops: [
            { op: "replace", task: { ...spec("a"), runTimeoutMinutes: 30 } },
            { op: "add", task: { ...spec("a2"), dependsOn: ["a"] } },
          ],
        },
        { type: "plan.revision_approved", revisionId: "rv1" },
        {
          type: "plan.revision_proposed",
          revisionId: "rv2",
          source: "person",
          reason: "drop b",
          ops: [{ op: "remove", taskId: "b" }],
        },
        { type: "plan.revision_rejected", revisionId: "rv2", reason: "keep b" },
      ]),
    );
    const log = new GoalEventLog({ dir });
    const store = new GoalStore(log);
    await store.recover();
    const goal = store.get("r1");
    expect(GoalSchema.safeParse(goal).success).toBe(true);
    expect(goal?.planRevisions?.map((r) => [r.id, r.status])).toEqual([
      ["rv1", "applied"],
      ["rv2", "rejected"],
    ]);
    expect(goal?.tasks.map((t) => [t.id, t.status, t.runTimeoutMinutes])).toEqual([
      ["a", "pending", 30],
      ["b", "pending", undefined],
      ["a2", "pending", undefined],
    ]);

    // A revision appended now is read back by a fresh load exactly as dispatched.
    await store.dispatch("r1", {
      id: "r1-next",
      goalId: "r1",
      type: "plan.revision_proposed",
      revisionId: "rv3",
      source: "person",
      reason: "drop b",
      ops: [{ op: "remove", taskId: "b" }],
    });
    const events = await log.read("r1");
    expect(events.at(-1)).toMatchObject({ type: "plan.revision_proposed", revisionId: "rv3" });
    expect((await load()).get("r1")).toEqual(store.get("r1"));
  });

  test("Lead interventions round-trip through the log and replay to the same goal", async () => {
    const timedOut = "Turn timed out after 90 minutes";
    await writeFile(
      join(dir, "i1.jsonl"),
      jsonl("i1", [
        {
          type: "goal.created",
          title: "Woken",
          objective: "o",
          criteria: [{ id: "c1", text: "w" }],
          config: { ...config, autoApprovePlan: false, leadInterventions: true },
        },
        { type: "lead.attached", agentId: "lead-1" },
        { type: "plan.proposed", tasks: [spec("a"), spec("b")] },
        { type: "plan.approved" },
        { type: "task.started", taskId: "a" },
        { type: "run.started", runId: "a-a1", taskId: "a", provider: "codex" },
        {
          type: "intervention.requested",
          interventionId: "a-a1:check-1",
          taskId: "a",
          runId: "a-a1",
          trigger: "watch",
          triggers: ["near_timeout"],
          checkIn: 1,
          error: "",
        },
        { type: "intervention.resolved", interventionId: "a-a1:check-1", outcome: "stopped" },
        { type: "run.finished", runId: "a-a1", outcome: "failed", error: "Stopped by the Lead: x" },
        { type: "task.failed", taskId: "a", error: "Stopped by the Lead: x" },
        {
          type: "intervention.requested",
          interventionId: "a-a1",
          taskId: "a",
          runId: "a-a1",
          trigger: "lead_stopped",
          error: "Stopped by the Lead: x",
          workSummary: " a.ts | 2 +-",
        },
        {
          type: "plan.revision_proposed",
          revisionId: "a-a1",
          source: "lead",
          reason: "split a",
          ops: [{ op: "replace", task: { ...spec("a"), title: "Smaller a" } }],
          interventionId: "a-a1",
        },
        { type: "plan.revision_approved", revisionId: "a-a1" },
        { type: "task.started", taskId: "b" },
        { type: "run.started", runId: "b-a1", taskId: "b", provider: "codex" },
        { type: "run.finished", runId: "b-a1", outcome: "failed", error: timedOut },
        { type: "task.failed", taskId: "b", error: timedOut },
        {
          type: "intervention.requested",
          interventionId: "b-a1",
          taskId: "b",
          runId: "b-a1",
          trigger: "timeout",
          error: timedOut,
        },
        {
          type: "intervention.resolved",
          interventionId: "b-a1",
          outcome: "continue",
          note: "flaky",
        },
      ]),
    );
    const log = new GoalEventLog({ dir });
    const store = new GoalStore(log);
    await store.recover();
    const goal = store.get("i1");
    expect(GoalSchema.safeParse(goal).success).toBe(true);
    expect(goal?.interventions?.map((i) => [i.id, i.trigger, i.status, i.outcome])).toEqual([
      ["a-a1:check-1", "watch", "resolved", "stopped"],
      ["a-a1", "lead_stopped", "resolved", "revised"],
      ["b-a1", "timeout", "resolved", "continue"],
    ]);
    expect(goal?.tasks.map((t) => [t.id, t.status, t.title])).toEqual([
      ["a", "pending", "Smaller a"],
      ["b", "failed", "Task b"],
    ]);

    // The retry after a continue is accepted, and a fresh load reads the same goal.
    await store.dispatch("i1", {
      id: "i1-next",
      goalId: "i1",
      type: "task.retried",
      taskId: "b",
    });
    const events = await log.read("i1");
    expect(events.at(-1)).toMatchObject({ type: "task.retried", taskId: "b" });
    expect((await load()).get("i1")).toEqual(store.get("i1"));
  });

  test("logs from before recoveries replay with no recovery fields, and failedAt from the failure", async () => {
    await writeFile(join(dir, "p2.jsonl"), phase2Log("p2"));
    await writeFile(join(dir, "n1.jsonl"), preNotificationLog("n1"));
    const store = await load();
    for (const field of ["recovery", "recoveries", "guidance", "failedAt"]) {
      expect(store.get("p2")).not.toHaveProperty(field);
    }
    const failed = store.get("n1");
    // failedAt is the goal.failed event's own time, so it reads the same on every replay.
    expect(failed?.failedAt).toBe(AT);
    for (const field of ["recovery", "recoveries", "guidance"]) {
      expect(failed).not.toHaveProperty(field);
    }
    expect((await load()).get("n1")).toEqual(failed);
  });

  test("interventions written before epochs replay without one", async () => {
    await writeFile(
      join(dir, "e1.jsonl"),
      jsonl("e1", [
        {
          type: "goal.created",
          title: "Woken",
          objective: "o",
          criteria: [{ id: "c1", text: "w" }],
          config: { ...config, leadInterventions: true },
        },
        { type: "lead.attached", agentId: "lead-1" },
        { type: "plan.proposed", tasks: [spec("a")] },
        { type: "plan.approved" },
        { type: "task.started", taskId: "a" },
        { type: "run.started", runId: "a-a1", taskId: "a", provider: "codex" },
        { type: "run.finished", runId: "a-a1", outcome: "failed", error: "x" },
        { type: "task.failed", taskId: "a", error: "x" },
        {
          type: "intervention.requested",
          interventionId: "a-a1",
          taskId: "a",
          runId: "a-a1",
          trigger: "repeated_failure",
          error: "x",
        },
      ]),
    );
    const goal = (await load()).get("e1");
    expect(goal?.interventions).toEqual([
      {
        id: "a-a1",
        taskId: "a",
        runId: "a-a1",
        trigger: "repeated_failure",
        error: "x",
        status: "open",
        requestedAt: AT,
      },
    ]);
  });

  test("a recovery round-trips through the log and replays to the same goal", async () => {
    const later = "2026-01-01T00:30:00.000Z";
    const lines = preNotificationLog("rc").trimEnd().split("\n");
    const recovery = [
      {
        type: "recovery.started",
        recoveryId: "r1",
        startedBy: "person",
        timeMode: "remaining",
        activeMs: 0,
        guidance: { goal: "be careful", tasks: { a: "read the docs first" } },
      },
      { type: "lead.attached", agentId: "lead-r1", workspaceId: "ws-r1" },
      {
        type: "intervention.requested",
        interventionId: "recovery-r1",
        trigger: "recovery",
        error: "",
      },
      { type: "usage.recorded", role: "lead", agentId: "lead-r1", usage: { outputTokens: 10 } },
      {
        type: "recovery.decided",
        recoveryId: "r1",
        decision: {
          decision: "revise",
          reason: "split a",
          ops: [
            { op: "replace", task: { ...spec("a", "read"), title: "Smaller a" } },
            { op: "add", task: spec("a2", "read") },
          ],
          hints: { a: "start from the README" },
        },
      },
      {
        type: "recovery.resolved",
        recoveryId: "r1",
        outcome: "applied",
        timeMode: "remaining",
        activeMs: 0,
      },
    ];
    recovery.forEach((event, i) => {
      lines.push(
        JSON.stringify({ id: `rc-r${i}`, goalId: "rc", seq: 11 + i, at: later, ...event }),
      );
    });
    await writeFile(join(dir, "rc.jsonl"), `${lines.join("\n")}\n`);
    const log = new GoalEventLog({ dir });
    const store = new GoalStore(log);
    await store.recover();
    const goal = store.get("rc");
    expect(GoalSchema.safeParse(goal).success).toBe(true);
    expect(goal).toMatchObject({
      status: "executing",
      reopens: 1,
      recoveries: 1,
      failedAt: AT,
      timeBaseAt: later,
      leadAgentId: "lead-r1",
      guidance: {
        goal: "be careful",
        tasks: { a: "read the docs first" },
        lead: { recoveryId: "r1", tasks: { a: "start from the README" } },
      },
    });
    expect(goal?.recovery).toMatchObject({ id: "r1", status: "applied", counted: true });
    expect(goal?.planRevisions?.map((r) => [r.id, r.source, r.status])).toEqual([
      ["r1", "lead", "applied"],
    ]);
    expect(goal?.tasks.map((t) => [t.id, t.status, t.title])).toEqual([
      ["a", "pending", "Smaller a"],
      ["a2", "pending", "Task a2"],
    ]);

    // An event appended now is read back by a fresh load exactly as dispatched.
    await store.dispatch("rc", {
      id: "rc-next",
      goalId: "rc",
      type: "goal.failed",
      reason: "again",
    });
    expect(store.get("rc")?.recovery?.status).toBe("ended");
    expect((await load()).get("rc")).toEqual(store.get("rc"));
  });

  test("a log from before goal management reads as normal priority, not archived, and takes management events", async () => {
    await writeFile(join(dir, "m1.jsonl"), phase1Log("m1"));
    const log = new GoalEventLog({ dir });
    const store = new GoalStore(log);
    await store.recover();
    const service = new GoalService(store, log);
    expect(store.get("m1")).not.toHaveProperty("priority");
    expect(store.get("m1")).not.toHaveProperty("archivedAt");
    expect(service.list().map((g) => g.id)).toEqual(["m1"]);
    expect(service.list({ priority: ["normal"] }).map((g) => g.id)).toEqual(["m1"]);
    await service.archive("m1");
    expect(service.list()).toEqual([]);
    const reloaded = await load();
    expect(reloaded.get("m1")?.archivedAt).toBeTruthy();
    expect(GoalSchema.safeParse(reloaded.get("m1")).success).toBe(true);
  });

  test("a log from before notifications were recorded replays with none and sends nothing", async () => {
    await writeFile(join(dir, "n1.jsonl"), preNotificationLog("n1"));
    const store = await load();
    const goal = store.get("n1");
    expect(goal?.status).toBe("failed");
    expect(GoalSchema.safeParse(goal).success).toBe(true);
    expect(goal?.notifications).toEqual([]);

    const harness = new Harness();
    const manager = new GoalManager({
      store,
      agents: harness.agentPort,
      workspaces: harness.workspacePort,
      git: harness.git,
      clock: new FakeClock(),
      logger: pino({ level: "silent" }),
    });
    await manager.start();
    await manager.idle();
    manager.stop();
    // Neither the Lead nor the chat hears about a goal that ended before the upgrade.
    expect(harness.notifyAttempts).toBe(0);
    expect(store.get("n1")?.lastSeq).toBe(10);
  });

  test("a goal stored without a permission policy keeps running under fail, also after a config edit", async () => {
    // Written before "wait" became the default: no onPermissionRequest at all.
    await writeFile(
      join(dir, "pp.jsonl"),
      jsonl("pp", [
        {
          type: "goal.created",
          title: "Policy",
          objective: "o",
          criteria: [{ id: "c1", text: "w" }],
          config,
        },
      ]),
    );
    const log = new GoalEventLog({ dir });
    const store = new GoalStore(log);
    await store.recover();
    expect(goalPermissionPolicy(store.get("pp")?.config)).toBe("fail");

    // Editing another setting leaves the policy unset, so it still means fail.
    const service = new GoalService(store, log);
    const edited = await service.updateConfig("pp", { maxParallel: 3 });
    expect(edited.config).not.toHaveProperty("onPermissionRequest");

    const harness = new Harness();
    const permissions: (string | undefined)[] = [];
    const runTurn = harness.agentPort.runTurn;
    harness.agentPort.runTurn = (agentId, prompt, options) => {
      const permission = options?.permission;
      permissions.push(typeof permission === "function" ? permission() : permission);
      return runTurn(agentId, prompt, options);
    };
    harness.respond = () => ({ outcome: "needs_permission" });
    const manager = new GoalManager({
      store,
      agents: harness.agentPort,
      workspaces: harness.workspacePort,
      git: harness.git,
      clock: new FakeClock(),
      logger: pino({ level: "silent" }),
    });
    await manager.start();
    await manager.idle();
    manager.stop();
    expect(harness.agents.map((a) => a.permission)).toEqual(["fail"]);
    expect(permissions).toEqual(["fail"]);
    expect(store.get("pp")?.failureReason).toMatch(/needs_permission/);
  });

  test("usage recorded before one token meaning replays unchanged, and is broken down per agent", async () => {
    // Shaped like a real goal log: a Claude Lead whose input left out cache reads and whose
    // cost was the session's running total, and Codex workers whose input counted cache
    // reads and covered only the turn's last model call. No provider or thinking on events.
    const usageLog = jsonl("u1", [
      {
        type: "goal.created",
        title: "Usage",
        objective: "o",
        criteria: [{ id: "c1", text: "w" }],
        config: {
          ...config,
          leadProvider: "claude/claude-opus-5-5",
          defaultProvider: "codex/gpt-6-luna",
          leadThinking: "medium",
          onPermissionRequest: "wait",
        },
      },
      { type: "lead.attached", agentId: "lead-1", workspaceId: "wks-lead" },
      {
        type: "usage.recorded",
        role: "lead",
        agentId: "lead-1",
        usage: {
          inputTokens: 8,
          cachedInputTokens: 174852,
          outputTokens: 7609,
          costUsd: 0.5307984,
        },
      },
      { type: "plan.proposed", tasks: [spec("t1"), spec("t2")] },
      { type: "plan.approved" },
      { type: "task.started", taskId: "t1" },
      { type: "run.started", runId: "t1-a1", taskId: "t1", provider: "codex/gpt-6-luna" },
      {
        type: "run.attached",
        runId: "t1-a1",
        agentId: "w-1",
        workspaceId: "wks-1",
        cwd: "/w1",
        thinking: "max",
      },
      {
        type: "usage.recorded",
        role: "worker",
        agentId: "w-1",
        runId: "t1-a1",
        usage: { inputTokens: 179133, cachedInputTokens: 178560, outputTokens: 2983 },
      },
      { type: "task.started", taskId: "t2" },
      { type: "run.started", runId: "t2-a1", taskId: "t2", provider: "codex/gpt-6-luna" },
      { type: "run.attached", runId: "t2-a1", agentId: "w-2", workspaceId: "wks-2", cwd: "/w2" },
      { type: "usage.recorded", role: "worker", agentId: "w-2", runId: "t2-a1" },
    ]);
    await writeFile(join(dir, "u1.jsonl"), usageLog);
    const goal = (await load()).get("u1");
    expect(GoalSchema.safeParse(goal).success).toBe(true);
    // The totals keep the sums those events always gave.
    expect(goal?.usage).toEqual({
      inputTokens: 179141,
      cachedInputTokens: 353412,
      outputTokens: 10592,
      totalTokens: 189733,
      costUsd: 0.5307984,
      reportedTurns: 2,
      totalTurns: 3,
      costReportedTurns: 1,
      tokenReportedTurns: 2,
    });
    expect(goal?.usageByRole?.lead).toMatchObject({ totalTokens: 7617, costReportedTurns: 1 });
    expect(goal?.usageByRole?.worker).toMatchObject({
      totalTokens: 182116,
      totalTurns: 2,
      costReportedTurns: 0,
    });
    expect(goal?.usageBreakdown).toEqual([
      expect.objectContaining({
        agentId: "lead-1",
        role: "lead",
        provider: "claude",
        model: "claude-opus-5-5",
        thinking: "medium",
      }),
      expect.objectContaining({
        agentId: "w-1",
        role: "worker",
        taskId: "t1",
        runId: "t1-a1",
        provider: "codex",
        model: "gpt-6-luna",
        thinking: "max",
      }),
      expect.objectContaining({
        agentId: "w-2",
        taskId: "t2",
        usage: expect.objectContaining({ reportedTurns: 0, totalTurns: 1 }),
      }),
    ]);
    expect(goal?.usageBreakdown?.[2]).not.toHaveProperty("thinking");
  });

  test("a merge that failed before the rejection reason was recorded can be merged again", async () => {
    // As v0.13.9 wrote it: no `reason` on the transition, only the error text. Recent
    // times, so the goal's time limit still leaves room for the reopen.
    const now = new Date().toISOString();
    const error = "Integration failed: Integration worktree has uncommitted changes:\n?? .gjc/";
    await writeFile(
      join(dir, "i1.jsonl"),
      jsonl(
        "i1",
        [
          {
            type: "goal.created",
            title: "Merge",
            objective: "o",
            criteria: [{ id: "c1", text: "w" }],
            config: { ...config, requireHumanApproval: true },
          },
          { type: "plan.proposed", tasks: [spec("t2")] },
          { type: "plan.approved" },
          {
            type: "integration.prepared",
            branch: "paseo-goal/i1",
            workspaceId: "wi",
            cwd: "/i",
            baseCommit: "base",
          },
          { type: "task.started", taskId: "t2" },
          { type: "run.started", runId: "t2-a1", taskId: "t2", provider: "codex" },
          { type: "run.attached", runId: "t2-a1", agentId: "ag", workspaceId: "ws", cwd: "/w" },
          { type: "task.succeeded", taskId: "t2", summary: "done" },
          { type: "run.finished", runId: "t2-a1", outcome: "succeeded" },
          {
            type: "changeset.captured",
            changeSetId: "cs-t2-a1",
            taskId: "t2",
            runId: "t2-a1",
            round: 0,
            supersedes: null,
            workspaceId: "ws",
            cwd: "/w",
            branch: "b",
            baseCommit: "base",
            headCommit: "h1",
            files: [{ status: "A", path: "x.txt" }],
          },
          { type: "changeset.transitioned", changeSetId: "cs-t2-a1", to: "in_review" },
          { type: "changeset.transitioned", changeSetId: "cs-t2-a1", to: "awaiting_human" },
          { type: "changeset.transitioned", changeSetId: "cs-t2-a1", to: "approved" },
          { type: "changeset.transitioned", changeSetId: "cs-t2-a1", to: "integrating" },
          { type: "changeset.transitioned", changeSetId: "cs-t2-a1", to: "rejected", error },
          { type: "goal.failed", reason: `Integrating cs-t2-a1 failed: ${error.slice(20)}` },
        ].map((e) => Object.assign(e, { at: now })),
      ),
    );
    const log = new GoalEventLog({ dir });
    const store = new GoalStore(log);
    await store.recover();
    const failed = store.get("i1");
    expect(failed?.status).toBe("failed");
    expect(failed?.changeSets[0]).toMatchObject({
      status: "rejected",
      error,
      rejectionReason: "integration_failed",
    });
    expect(GoalSchema.safeParse(failed).success).toBe(true);

    const goal = await new GoalService(store, log).retry("i1", undefined);
    expect(goal.status).toBe("executing");
    expect(goal.failureReason).toBeNull();
    expect(goal.changeSets[0]?.status).toBe("approved");
    expect((await load()).get("i1")?.changeSets[0]?.status).toBe("approved");
  });

  test("goal 4fe24f94: a rework that failed before the reason was recorded is reworked again by retry", async () => {
    // The real log, anonymised (test-fixtures): cs-t7-a1's rework t7-rw1 stopped on a Bash
    // permission request under `fail`, and the change set was rejected with no reason.
    const goalId = "4fe24f94-477b-4e3a-80e2-2c8a46fe8d00";
    const fixture = await readFile(
      join(import.meta.dirname, "test-fixtures", "4fe24f94.jsonl"),
      "utf8",
    );
    await writeFile(join(dir, `${goalId}.jsonl`), fixture);
    const log = new GoalEventLog({ dir });
    const store = new GoalStore(log);
    await store.recover();
    const failed = store.get(goalId);
    expect(failed).toMatchObject({
      status: "failed",
      failureReason: "Rework t7-rw1 failed after 2 attempts.",
    });
    expect(GoalSchema.safeParse(failed).success).toBe(true);
    const rejected = failed?.changeSets.find((c) => c.id === "cs-t7-a1");
    expect(rejected).toMatchObject({ status: "rejected", rejectionReason: "rework_failed" });
    expect(rejected?.error).toMatch(/^Rework t7-rw1 failed: Agent is waiting for permission/);
    // The fallback derives the reason and nothing else: the same log written with the reason
    // replays to the same goal.
    const withReason = fixture.replace(
      '"to": "rejected", "error"',
      '"to": "rejected", "reason": "rework_failed", "error"',
    );
    await writeFile(join(dir, `${goalId}.jsonl`), withReason);
    expect((await load()).get(goalId)).toEqual(failed);
    const runs = failed?.runs.length ?? 0;
    expect(runs).toBe(15);
    expect(runs).toBeLessThan(failed?.config?.limits?.maxRuns ?? 0);

    // The person turns away from `fail`, which would refuse the same `git commit` again.
    const current = failed?.config;
    if (!current) throw new Error("expected a managed goal");
    await store.dispatch(goalId, {
      id: "config",
      goalId,
      type: "goal.config_updated",
      config: {
        ...current,
        onPermissionRequest: "wait",
        limits: { ...current.limits, maxRuns: 40 },
      },
    });
    const service = new GoalService(store, log);
    // The rework's worktree is checked before it is reworked again; here it is still there.
    service.attachActivityProbe({
      hasLiveWork: () => false,
      reworkWorktreeProblem: (failedGoal) =>
        reworkWorktreeProblem(failedGoal, { head: async () => "head" }),
    });
    const goal = await service.retry(goalId, undefined, "retry", "fresh");
    expect(goal.status).toBe("executing");
    expect(goal.changeSets.find((c) => c.id === "cs-t7-a1")).toMatchObject({
      status: "changes_requested",
      round: 0,
      error: null,
      findings: "Finding.",
      cwd: rejected?.cwd,
    });
    expect(goal.changeSets.find((c) => c.id === "cs-t7-a1")).not.toHaveProperty("rejectionReason");
    expect(goal.tasks.find((t) => t.id === "t7-rw1")).toMatchObject({
      status: "pending",
      forgivenFailures: 1,
    });
    // A retry starts no run by itself; each run from here counts against the raised limit.
    expect(goal.runs).toHaveLength(runs);
    const events = await log.read(goalId);
    expect(events.at(-1)).toMatchObject({
      type: "goal.retried",
      taskIds: ["t7-rw1"],
      reopen: true,
      reworkChangeSetIds: ["cs-t7-a1"],
    });
    expect((await load()).get(goalId)).toEqual(goal);
  });

  test("the other real goal logs gain no rejection reason from the rework fallback", async () => {
    for (const name of ["aff07ea6.jsonl", "b195cf6f.jsonl"]) {
      const text = await readFile(join(import.meta.dirname, "test-fixtures", name), "utf8");
      const goalId: string = JSON.parse(text.slice(0, text.indexOf("\n"))).goalId;
      await writeFile(join(dir, `${goalId}.jsonl`), text);
    }
    const store = await load();
    const goals = store.list();
    expect(goals).toHaveLength(2);
    for (const goal of goals) {
      expect(goal.changeSets.filter((c) => c.rejectionReason !== undefined)).toEqual([]);
      expect(GoalSchema.safeParse(goal).success).toBe(true);
    }
  });

  test("real goal logs from before waits replay with no waits, so their time limits are unchanged", async () => {
    const names = ["4fe24f94.jsonl", "aff07ea6.jsonl", "b195cf6f.jsonl", "b195cf6f-verify.jsonl"];
    for (const [i, name] of names.entries()) {
      const text = await readFile(join(import.meta.dirname, "test-fixtures", name), "utf8");
      const sub = join(dir, `f${i}`);
      await mkdir(sub);
      await writeFile(
        join(sub, `${JSON.parse(text.slice(0, text.indexOf("\n"))).goalId}.jsonl`),
        text,
      );
      const store = new GoalStore(new GoalEventLog({ dir: sub }));
      await store.recover();
      const [goal] = store.list();
      expect(goal?.waits).toBeUndefined();
      if (goal) expect(excludedWaitMs(goal, Date.now())).toBe(0);
    }
  });

  test("a log with waits round-trips through the store", async () => {
    const waitConfig = {
      cwd: "/repo",
      leadProvider: "claude",
      defaultProvider: "codex",
      maxParallel: 1,
      maxAttempts: 2,
      autoApprovePlan: true,
      notifyLead: false,
      limits: { userWaitMinutes: 30 },
    };
    const events = [
      { type: "goal.created", title: "T", objective: "o", criteria: [], config: waitConfig },
      { type: "plan.proposed", tasks: [spec("a")] },
      { type: "plan.approved" },
      { type: "task.started", taskId: "a" },
      { type: "run.started", runId: "a-a1", taskId: "a", provider: "codex" },
      {
        type: "wait.started",
        agentId: "agent-a",
        role: "worker",
        runId: "a-a1",
        request: { kind: "permission", tool: "Bash", text: "git commit" },
      },
      { type: "wait.started", agentId: "lead-1", role: "lead" },
      { type: "wait.ended", agentId: "agent-a", outcome: "answered" },
    ];
    await writeFile(join(dir, "w1.jsonl"), jsonl("w1", events));
    const goal = (await load()).get("w1");
    expect(GoalSchema.safeParse(goal).success).toBe(true);
    expect(goal?.waits).toEqual({
      open: { "lead-1": { since: AT } },
      excludedMs: 0,
      since: AT,
    });
  });

  test("goal b195cf6f accepted as is after its last recovery round-trips through the log", async () => {
    const goalId = "b195cf6f-6f1c-4889-aff8-3f689db7ab15";
    await writeFile(
      join(dir, `${goalId}.jsonl`),
      await readFile(join(import.meta.dirname, "test-fixtures", "b195cf6f-verify.jsonl"), "utf8"),
    );
    const log = new GoalEventLog({ dir });
    const store = new GoalStore(log);
    await store.recover();
    expect(store.get(goalId)).not.toHaveProperty("accepted");
    const service = new GoalService(store, log);
    service.attachActivityProbe({ hasLiveWork: () => false });
    const started = await service.startRecovery(goalId, { timeMode: "fresh" });
    const recoveryId = started.recovery?.id ?? "";
    const send = (event: Record<string, unknown>) =>
      store.dispatch(goalId, { goalId, ...event } as Parameters<GoalStore["dispatch"]>[1]);
    await send({ id: "lead", type: "lead.attached", agentId: "lead-3" });
    await send({
      id: "ask",
      type: "intervention.requested",
      interventionId: `recovery-${recoveryId}`,
      trigger: "recovery",
      error: "",
    });
    await send({
      id: "decided",
      type: "recovery.decided",
      recoveryId,
      decision: { decision: "needs_person", reason: "c1 needs a person" },
    });
    expect(store.get(goalId)).toMatchObject({ status: "failed", recoveries: 3 });
    const accepted = await service.accept(goalId, {
      criterionIds: ["c1"],
      note: "UV-02 is tracked separately",
      client: "cli",
    });
    expect(accepted.status).toBe("completed");

    // A fresh store reads the same goal back from the log.
    const reread = new GoalStore(new GoalEventLog({ dir }));
    await reread.recover();
    const goal = reread.get(goalId);
    expect(goal).toEqual(accepted);
    expect(goal?.criteria.find((c) => c.id === "c1")?.waived?.note).toBe(
      "UV-02 is tracked separately",
    );
    expect(GoalSchema.safeParse(goal).success).toBe(true);
    const lines = (await readFile(join(dir, `${goalId}.jsonl`), "utf8")).trim().split("\n");
    expect(JSON.parse(lines.at(-1) ?? "{}")).toMatchObject({
      type: "goal.accepted",
      criterionIds: ["c1"],
      client: "cli",
    });
  });

  test("goal b195cf6f later: it replays with no verification round, and a recovery that adds a fix round-trips", async () => {
    // The real log to seq 216, anonymised (test-fixtures): verification failed on c1 and two
    // recoveries ended needs_person.
    const goalId = "b195cf6f-6f1c-4889-aff8-3f689db7ab15";
    await writeFile(
      join(dir, `${goalId}.jsonl`),
      await readFile(join(import.meta.dirname, "test-fixtures", "b195cf6f-verify.jsonl"), "utf8"),
    );
    const log = new GoalEventLog({ dir });
    const store = new GoalStore(log);
    await store.recover();
    const failed = store.get(goalId);
    expect(failed).toMatchObject({ status: "failed", recoveries: 2, lastSeq: 216 });
    expect(failed).not.toHaveProperty("verificationRound");
    expect(failed?.criteria.filter((c) => c.verifiedAt).map((c) => c.id)).toEqual([
      "c2",
      "c3",
      "c4",
      "c5",
      "c6",
      "c7",
      "c8",
      "c9",
      "c10",
    ]);
    expect(GoalSchema.safeParse(failed).success).toBe(true);

    // A third recovery is accepted, and its Lead adds a fix task.
    const service = new GoalService(store, log);
    service.attachActivityProbe({ hasLiveWork: () => false });
    const started = await service.startRecovery(goalId, { timeMode: "fresh" });
    const recoveryId = started.recovery?.id ?? "";
    const send = (event: Record<string, unknown>) =>
      store.dispatch(goalId, { goalId, ...event } as Parameters<GoalStore["dispatch"]>[1]);
    await send({ id: "lead", type: "lead.attached", agentId: "lead-3" });
    await send({
      id: "ask",
      type: "intervention.requested",
      interventionId: `recovery-${recoveryId}`,
      trigger: "recovery",
      error: "",
    });
    await send({
      id: "decided",
      type: "recovery.decided",
      recoveryId,
      decision: {
        decision: "revise",
        reason: "fix F-01",
        ops: [{ op: "add", task: { ...spec("t7"), dependsOn: ["t5"] } }],
      },
    });
    await send({
      id: "applied",
      type: "recovery.resolved",
      recoveryId,
      outcome: "applied",
      timeMode: "fresh",
    });
    const applied = store.get(goalId);
    expect(applied).toMatchObject({ status: "executing", recoveries: 3, verificationRound: 1 });
    expect(applied?.criteria.every((c) => c.verifiedAt === null)).toBe(true);
    expect(GoalSchema.safeParse(applied).success).toBe(true);
    // The fixed id of round 0 is taken, so a round-1 result needs its own.
    expect(
      (await send({ id: `${goalId}:verified:c2`, type: "criterion.verified", criterionId: "c2" }))
        .duplicate,
    ).toBe(true);
    // Verification runs only once t7 is merged; here the reducer takes a result directly.
    await send({
      id: `${goalId}:verified:c2:v1`,
      type: "criterion.verified",
      criterionId: "c2",
      evidence: "round 1",
    });
    const current = store.get(goalId);
    expect(current?.criteria.find((c) => c.id === "c2")).toMatchObject({ evidence: "round 1" });
    expect((await load()).get(goalId)).toEqual(current);
  });

  test("an event carrying fields this version does not know is still accepted", async () => {
    const log = phase1Log("x1").replace(
      '"type":"plan.approved"',
      '"type":"plan.approved","futureField":42',
    );
    await writeFile(join(dir, "x1.jsonl"), log);
    expect((await load()).get("x1")?.status).toBe("completed");
  });

  test("a log from a newer version is set aside without stopping the others", async () => {
    await writeFile(join(dir, "m1.jsonl"), phase1Log("m1"));
    await writeFile(
      join(dir, "future.jsonl"),
      jsonl("future", [
        { type: "goal.created", title: "T", objective: "", criteria: [] },
        { type: "plan.teleported", destination: "mars" },
      ]),
    );
    const store = await load();
    expect(store.get("m1")?.status).toBe("completed");
    expect(store.get("future")).toBeUndefined();
    expect([...store.unreadable.keys()]).toEqual(["future"]);
  });

  test("a live goal from before work capture existed fails loudly rather than completing unreviewed", async () => {
    // An implement task that succeeded in phase 2, before change sets existed.
    await writeFile(
      join(dir, "old.jsonl"),
      jsonl("old", [
        {
          type: "goal.created",
          title: "Old",
          objective: "o",
          criteria: [{ id: "c1", text: "w" }],
          config,
        },
        { type: "plan.proposed", tasks: [spec("a")] },
        { type: "plan.approved" },
        { type: "task.started", taskId: "a" },
        { type: "run.started", runId: "a-a1", taskId: "a", provider: "codex" },
        { type: "run.attached", runId: "a-a1", agentId: "ag", workspaceId: "ws" },
        { type: "task.succeeded", taskId: "a", summary: "done" },
        { type: "run.finished", runId: "a-a1", outcome: "succeeded" },
      ]),
    );
    const store = await load();
    const harness = new Harness();
    const manager = new GoalManager({
      store,
      agents: harness.agentPort,
      workspaces: harness.workspacePort,
      git: harness.git,
      clock: new FakeClock(),
      logger: pino({ level: "silent" }),
    });
    await manager.start();
    await manager.idle();
    manager.stop();

    const goal = store.get("old");
    expect(goal?.status).toBe("failed");
    expect(goal?.failureReason).toMatch(/Could not recover the work of task a/);
    expect(harness.git.merges).toHaveLength(0);
  });
});
