import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { RECOVERY_DECISION_MS } from "@getpaseo/protocol/goal/interventions";
import type { Goal, GoalConfig, GoalEvent, GoalEventInput } from "@getpaseo/protocol/goal/types";
import { GoalEventLog } from "./event-log.js";
import type { CreateGoalAgentInput, TurnResult } from "./goal-manager.js";
import { CONFIG, createGoalTestEnv, task, type GoalTestEnv } from "./goal-test-env.js";
import { LEAD_DECISION_MS, TURN_TIMEOUT_PREFIX } from "./lead-intervention.js";

const REQUEST = JSON.stringify({ verdict: "request_changes", findings: ["tighten it"] });

/**
 * A scenario that touches every stage: two dependent implement tasks, a review
 * round that asks for rework, a merge conflict, a failing test command, and
 * verification. Its event log is the script for the crash tests below.
 */
async function recordFullRun(): Promise<GoalEvent[]> {
  const env = createGoalTestEnv();
  await env.init();
  try {
    env.script([task("a"), task("b", { dependsOn: ["a"] })]);
    let reviews = 0;
    env.stageReplies.review = () => {
      reviews += 1;
      return {
        outcome: "completed",
        text: env.fenced(
          reviews === 1 ? REQUEST : JSON.stringify({ verdict: "approve", findings: [] }),
        ),
      };
    };
    env.harness.git.mergeQueue.push(
      { ok: true, headCommit: "m1" },
      { ok: false, conflicts: ["x.ts"] },
    );
    env.harness.git.commandQueue.push(
      { exitCode: 0, timedOut: false, output: "ok" },
      { exitCode: 1, timedOut: false, output: "1 failing" },
    );
    const { store, manager } = await env.boot();
    await env.createGoal(store, { ...CONFIG, testCommand: "npm test", maxReworkRounds: 3 });
    await env.settle(manager);
    expect(env.goalOf(store).status).toBe("completed");
    return await env.readEvents();
  } finally {
    await env.cleanup();
  }
}

function strip(event: GoalEvent): GoalEventInput {
  const { seq: _seq, at: _at, ...input } = event;
  return input as GoalEventInput;
}

/** The integration head a restarted daemon would find in the worktree. */
function recordedHead(prefix: GoalEvent[]): string {
  const merged = prefix.findLast(
    (e) => e.type === "changeset.transitioned" && e.integratedCommit,
  ) as { integratedCommit: string } | undefined;
  return merged?.integratedCommit ?? "base0";
}

function assertSound(goal: Goal): void {
  expect(goal.runs.filter((r) => r.status === "running")).toEqual([]);
  expect(goal.tasks.filter((t) => t.status === "running")).toEqual([]);
  expect(
    goal.changeSets.filter((c) => c.status !== "integrated" && c.status !== "superseded"),
  ).toEqual([]);
  expect(goal.criteria.every((c) => c.verifiedAt)).toBe(true);
  for (const implemented of goal.tasks.filter((t) => t.kind === "implement")) {
    expect(implemented.captured).toBe(true);
  }
  // A notice is never left half sent: it is delivered, or was never queued.
  expect((goal.notifications ?? []).filter((n) => n.status !== "delivered")).toEqual([]);
}

describe("recovery after a crash at every point", () => {
  let events: GoalEvent[] = [];

  test("the scenario itself reaches completion through every stage", async () => {
    events = await recordFullRun();
    const types = new Set(events.map((e) => e.type));
    for (const expected of [
      "plan.proposed",
      "run.started",
      "changeset.captured",
      "task.added",
      "integration.prepared",
      "criterion.verified",
      "goal.completed",
      "notification.queued",
      "notification.attempted",
    ]) {
      expect(types.has(expected as GoalEvent["type"])).toBe(true);
    }
    const statuses = events
      .filter((e) => e.type === "changeset.transitioned")
      .map((e) => (e as { to: string }).to);
    expect(statuses).toEqual(
      expect.arrayContaining(["changes_requested", "conflicted", "test_failed", "integrated"]),
    );
  }, 30_000);

  test("a daemon that restarts after any recorded event finishes the goal", async () => {
    const failures: string[] = [];
    // The last event records the Lead's completion notice; restarting after it has nothing to resume.
    for (let keep = 1; keep < events.length; keep += 1) {
      const env = createGoalTestEnv();
      await env.init();
      try {
        const log = new GoalEventLog({ dir: env.logDir() });
        for (const event of events.slice(0, keep)) await log.append("g1", strip(event));
        env.script([task("a"), task("b", { dependsOn: ["a"] })]);
        // A real restart sees the commits and branch head that were recorded.
        env.harness.git.counter = 1000;
        env.harness.git.headValue = recordedHead(events.slice(0, keep));
        const { store, manager } = await env.boot();
        await env.settle(manager);
        const goal = store.get("g1");
        try {
          expect(goal?.status).toBe("completed");
          assertSound(goal as Goal);
        } catch (error) {
          failures.push(
            `after event ${keep} (${events[keep - 1]?.type}): status=${goal?.status} reason=${goal?.failureReason ?? "-"} ${error instanceof Error ? error.message.split("\n")[0] : ""}`,
          );
        }
      } finally {
        await env.cleanup();
      }
    }
    expect(failures).toEqual([]);
  }, 180_000);

  afterAll(() => {
    events = [];
  });
});

const LEAD_CONFIG = { ...CONFIG, leadInterventions: true };
const SPLIT_PLAN = [task("a"), task("b", { dependsOn: ["a"] })];

/**
 * Task a always times out; asked about it, the Lead splits it into a1 and a2 and rewires b,
 * or gives up when `giveUp` is set. Returns the decision prompts the Lead was given.
 */
function scriptLeadSplit(env: GoalTestEnv, giveUp = false): string[] {
  const decisions: string[] = [];
  env.script(SPLIT_PLAN, (turn) =>
    /Your task \(\w+\): Task a\n/.test(turn.prompt)
      ? { outcome: "failed", error: `${TURN_TIMEOUT_PREFIX} 90 minutes` }
      : { outcome: "completed", text: "ok" },
  );
  const base = env.harness.respond;
  env.harness.respond = (turn): TurnResult | "hold" => {
    if (!turn.prompt.includes("The Manager needs your decision")) return base?.(turn) ?? "hold";
    decisions.push(turn.prompt);
    const decision = giveUp
      ? { decision: "give_up", reason: "a cannot be done" }
      : {
          decision: "revise",
          reason: "split a",
          ops: [
            { op: "remove", taskId: "a" },
            { op: "add", task: task("a1") },
            { op: "add", task: task("a2", { dependsOn: ["a1"] }) },
            { op: "replace", task: task("b", { dependsOn: ["a2"] }) },
          ],
        };
    return { outcome: "completed", text: env.fenced(JSON.stringify(decision)) };
  };
  return decisions;
}

/** A timeout, the Lead's split, completion. Its log is the script for the tests below. */
async function recordInterventionRun(giveUp = false): Promise<GoalEvent[]> {
  const env = createGoalTestEnv();
  await env.init();
  try {
    scriptLeadSplit(env, giveUp);
    const { store, manager } = await env.boot();
    await env.createGoal(store, LEAD_CONFIG);
    await env.settle(manager);
    expect(env.goalOf(store).status).toBe(giveUp ? "failed" : "completed");
    return await env.readEvents();
  } finally {
    await env.cleanup();
  }
}

/** Boot a fresh daemon on the first `keep` events, with the Lead scripted as when recorded. */
async function restartAfter(
  events: GoalEvent[],
  keep: number,
  options: { giveUp?: boolean; recordedAgoMs?: number } = {},
) {
  const env = createGoalTestEnv();
  await env.init();
  if (options.recordedAgoMs === undefined) {
    const log = new GoalEventLog({ dir: env.logDir() });
    for (const event of events.slice(0, keep)) await log.append("g1", strip(event));
  } else {
    // Written as recorded, but that long ago, as a daemon that was down for a while finds them.
    const shift = options.recordedAgoMs;
    const lines = events
      .slice(0, keep)
      .map((e) => JSON.stringify({ ...e, at: new Date(Date.parse(e.at) - shift).toISOString() }));
    await writeFile(join(env.logDir(), "g1.jsonl"), `${lines.join("\n")}\n`);
  }
  const decisions = scriptLeadSplit(env, options.giveUp);
  env.harness.git.counter = 1000;
  env.harness.git.headValue = recordedHead(events.slice(0, keep));
  const { store, manager } = await env.boot();
  await env.settle(manager);
  return { env, store, decisions, events: await env.readEvents() };
}

const indexAfter = (events: GoalEvent[], match: (e: GoalEvent) => boolean) =>
  events.findIndex(match) + 1;

describe("recovery with Lead interventions", () => {
  let events: GoalEvent[] = [];

  test("the scenario wakes the Lead once and completes on its split", async () => {
    events = await recordInterventionRun();
    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === "intervention.requested")).toHaveLength(1);
    expect(types).toContain("plan.revision_approved");
  }, 30_000);

  test("a daemon that restarts after any recorded event finishes the goal", async () => {
    const failures: string[] = [];
    for (let keep = 1; keep < events.length; keep += 1) {
      const { env, store } = await restartAfter(events, keep);
      try {
        const goal = store.get("g1") as Goal;
        expect(goal.status).toBe("completed");
        assertSound(goal);
        expect(
          (goal.interventions ?? []).filter(
            (i) => i.status === "open" || i.status === "awaiting_approval",
          ),
        ).toEqual([]);
      } catch (error) {
        const goal = store.get("g1");
        failures.push(
          `after event ${keep} (${events[keep - 1]?.type}): status=${goal?.status} reason=${goal?.failureReason ?? "-"} ${error instanceof Error ? error.message.split("\n")[0] : ""}`,
        );
      } finally {
        await env.cleanup();
      }
    }
    expect(failures).toEqual([]);
  }, 180_000);

  test("a restart between task.failed and the wake-up asks the Lead instead of retrying", async () => {
    const keep = indexAfter(events, (e) => e.type === "task.failed");
    // The log stops right before the wake-up was recorded.
    expect(events[keep]?.type).toBe("intervention.requested");
    const { env, store, decisions, events: after } = await restartAfter(events, keep);
    try {
      expect(store.get("g1")?.status).toBe("completed");
      expect(decisions).toHaveLength(1);
      expect(after.some((e) => e.id.includes("recovered-failed"))).toBe(false);
      expect(after.filter((e) => e.type === "run.started").map((e) => e.runId)).not.toContain(
        "a-a2",
      );
    } finally {
      await env.cleanup();
    }
  });

  test("a decision left open at restart is asked again", async () => {
    const keep = indexAfter(events, (e) => e.type === "intervention.requested");
    const { env, store, decisions } = await restartAfter(events, keep);
    try {
      expect(store.get("g1")?.status).toBe("completed");
      expect(decisions).toHaveLength(1);
      expect(store.get("g1")?.interventions?.[0]).toMatchObject({ outcome: "revised" });
    } finally {
      await env.cleanup();
    }
  });

  test("a decision whose time ran out while the daemon was down expires at start", async () => {
    const keep = indexAfter(events, (e) => e.type === "intervention.requested");
    const { env, store } = await restartAfter(events, keep, {
      recordedAgoMs: LEAD_DECISION_MS + 60_000,
    });
    try {
      const goal = store.get("g1") as Goal;
      expect(goal.interventions?.[0]).toMatchObject({ id: "a-a1", outcome: "expired" });
      // Retried as without the Lead; the last attempt asks again and the split completes it.
      expect(goal.interventions?.[1]).toMatchObject({
        trigger: "attempts_exhausted",
        outcome: "revised",
      });
      expect(goal.status).toBe("completed");
    } finally {
      await env.cleanup();
    }
  });

  test("a restart after give_up and before goal.failed fails the goal without a retry", async () => {
    const gaveUp = await recordInterventionRun(true);
    const keep = indexAfter(gaveUp, (e) => e.type === "intervention.resolved");
    // The log stops right before the goal failed.
    expect(gaveUp[keep]?.type).toBe("goal.failed");
    const { env, store, events: after } = await restartAfter(gaveUp, keep, { giveUp: true });
    try {
      const goal = store.get("g1") as Goal;
      expect(goal.status).toBe("failed");
      expect(goal.failureReason).toContain("Lead gave up on a: a cannot be done");
      expect(after.filter((e) => e.type === "task.retried")).toEqual([]);
    } finally {
      await env.cleanup();
    }
  });

  afterAll(() => {
    events = [];
  });
});

describe("recovery with a check-in open", () => {
  /**
   * Records a run of task a that the Lead is checking in on, up to the check-in request, or with
   * `stop` up to the stopped run's failure.
   */
  async function recordOpenCheckIn(stop = false): Promise<GoalEvent[]> {
    const env = createGoalTestEnv();
    env.logOptions.now = () => new Date(env.clock.now()).toISOString();
    await env.init();
    try {
      env.script([task("a")], () => "hold");
      const base = env.harness.respond;
      const stopAnswer = env.fenced(JSON.stringify({ decision: "stop", reason: "too large" }));
      env.harness.respond = (turn) => {
        if (turn.prompt.includes("The Manager is checking in")) {
          return stop ? { outcome: "completed", text: stopAnswer } : "hold";
        }
        // The wake-up about the stopped run is left open.
        if (turn.prompt.includes("The Manager needs your decision")) return "hold";
        return base?.(turn) ?? "hold";
      };
      const { store, manager } = await env.boot();
      await env.createGoal(store, {
        ...LEAD_CONFIG,
        limits: { ...CONFIG.limits, runTimeoutMinutes: 90 },
      });
      const open = () => (store.get("g1")?.interventions ?? []).length > 0;
      for (let i = 0; i < 400 && env.harness.turns.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      for (let minute = 0; minute < 80 && !open(); minute += 1) {
        env.clock.advance(60_000);
        for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
        await store.whenIdle("g1");
      }
      expect(open()).toBe(true);
      if (stop) {
        const failed = () => store.get("g1")?.tasks[0]?.status === "failed";
        for (let i = 0; i < 400 && !failed(); i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
      manager.stop();
      return await env.readEvents();
    } finally {
      await env.cleanup();
    }
  }

  test("the run is interrupted at start, which ends the check-in, and the task runs again", async () => {
    const events = await recordOpenCheckIn();
    expect(events.at(-1)).toMatchObject({ type: "intervention.requested", trigger: "watch" });
    const env = createGoalTestEnv();
    await env.init();
    try {
      const log = new GoalEventLog({ dir: env.logDir() });
      for (const event of events) await log.append("g1", strip(event));
      env.script([task("a")]);
      const prompts: string[] = [];
      const base = env.harness.respond;
      env.harness.respond = (turn) => {
        prompts.push(turn.prompt);
        return base?.(turn) ?? "hold";
      };
      const { store, manager } = await env.boot();
      await env.settle(manager);
      const goal = store.get("g1") as Goal;
      expect(goal.status).toBe("completed");
      assertSound(goal);
      expect(goal.interventions).toMatchObject([
        { id: "a-a1:check-1", status: "resolved", outcome: "run_ended" },
      ]);
      expect(goal.runs.map((r) => [r.id, r.status])).toEqual([
        ["a-a1", "interrupted"],
        ["a-a2", "succeeded"],
      ]);
      expect(prompts.some((p) => p.includes("The Manager is checking in"))).toBe(false);
    } finally {
      await env.cleanup();
    }
  });

  test("a crash between the Lead's stop and the run's failure retries the task as interrupted", async () => {
    const recorded = await recordOpenCheckIn(true);
    const keep = indexAfter(
      recorded,
      (e) => e.type === "intervention.resolved" && e.outcome === "stopped",
    );
    // The log stops before the stopped run's failure was recorded.
    expect(recorded.slice(keep).some((e) => e.type === "run.finished")).toBe(true);
    const env = createGoalTestEnv();
    await env.init();
    try {
      const log = new GoalEventLog({ dir: env.logDir() });
      for (const event of recorded.slice(0, keep)) await log.append("g1", strip(event));
      env.script([task("a")]);
      const { store, manager } = await env.boot();
      await env.settle(manager);
      const goal = store.get("g1") as Goal;
      expect(goal.status).toBe("completed");
      assertSound(goal);
      expect(goal.interventions).toMatchObject([{ id: "a-a1:check-1", outcome: "stopped" }]);
      expect(goal.runs.map((r) => [r.id, r.status])).toEqual([
        ["a-a1", "interrupted"],
        ["a-a2", "succeeded"],
      ]);
    } finally {
      await env.cleanup();
    }
  });
});

const RECOVERY_PLAN = [task("m"), task("a"), task("b", { dependsOn: ["a"] })];

/**
 * Task a fails until the goal is recovered; the recovery Lead answers with `decision`. Workers
 * read whether they run after the recovery from the Lead's hint in their prompt.
 */
function scriptRecovery(env: GoalTestEnv, decision: Record<string, unknown>): void {
  env.script(RECOVERY_PLAN, (turn) =>
    /Your task \(\w+\): Task a\n/.test(turn.prompt) && !turn.prompt.includes("use the cache")
      ? { outcome: "failed", error: "boom" }
      : { outcome: "completed", text: "ok" },
  );
  const base = env.harness.respond;
  const recoveryLeads = new Set<string>();
  env.harness.respond = (turn): TurnResult | "hold" => {
    if (turn.prompt.includes("asked you to recover it")) recoveryLeads.add(turn.agentId);
    if (!recoveryLeads.has(turn.agentId)) return base?.(turn) ?? "hold";
    return { outcome: "completed", text: env.fenced(JSON.stringify(decision)) };
  };
}

const RECOVER_RETRY = {
  decision: "retry",
  reason: "a needs the cache",
  hints: { a: "use the cache" },
};

interface RecordedRecovery {
  events: GoalEvent[];
  /** The recovery Lead as the agent layer keeps it across a restart. */
  lead: CreateGoalAgentInput & { agentId: string };
}

/** A failure, a recovery the Lead decides with `decision`, and what follows. */
async function recordRecoveryRun(
  decision: Record<string, unknown>,
  config: Partial<GoalConfig> = {},
): Promise<RecordedRecovery> {
  const env = createGoalTestEnv();
  await env.init();
  try {
    scriptRecovery(env, decision);
    const { store, manager, service } = await env.boot();
    service.attachActivityProbe(manager);
    await env.createGoal(store, { ...CONFIG, ...config });
    await env.settle(manager);
    if (env.goalOf(store).status === "awaiting_plan_approval") {
      await service.approvePlan("g1");
      await env.settle(manager);
    }
    expect(env.goalOf(store).status).toBe("failed");
    await service.startRecovery("g1", { prompt: "try once more", timeMode: "fresh" });
    await env.settle(manager);
    const lead = env.harness.agents.find((a) => a.labels["paseo.goal-recovery"]);
    if (!lead) throw new Error("no recovery Lead");
    return { events: await env.readEvents(), lead };
  } finally {
    await env.cleanup();
  }
}

/** Boot on the first `keep` events, with the agents the agent layer would still know. */
async function restartRecoveryAfter(
  recorded: RecordedRecovery,
  keep: number,
  options: {
    decision?: Record<string, unknown>;
    agents?: (CreateGoalAgentInput & { agentId: string })[];
    recordedAgoMs?: number;
  } = {},
) {
  const env = createGoalTestEnv();
  await env.init();
  const shift = options.recordedAgoMs ?? 0;
  const lines = recorded.events
    .slice(0, keep)
    .map((e) => JSON.stringify({ ...e, at: new Date(Date.parse(e.at) - shift).toISOString() }));
  await writeFile(join(env.logDir(), "g1.jsonl"), `${lines.join("\n")}\n`);
  scriptRecovery(env, options.decision ?? RECOVER_RETRY);
  env.harness.agents.push(...(options.agents ?? []));
  env.harness.git.counter = 1000;
  env.harness.git.headValue = recordedHead(recorded.events.slice(0, keep));
  const { store, manager, service } = await env.boot();
  service.attachActivityProbe(manager);
  await env.settle(manager);
  return { env, store, service, manager };
}

describe("recovery of a failed goal across restarts", () => {
  let recorded: RecordedRecovery = { events: [], lead: {} as RecordedRecovery["lead"] };
  const started = () => indexAfter(recorded.events, (e) => e.type === "recovery.started");

  test("the scenario fails, is recovered by the Lead's retry and completes", async () => {
    recorded = await recordRecoveryRun(RECOVER_RETRY);
    const types = recorded.events.map((e) => e.type);
    expect(types.slice(started() - 1, started() + 3)).toEqual([
      "recovery.started",
      "lead.attached",
      "intervention.requested",
      "usage.recorded",
    ]);
    expect(types).toContain("recovery.decided");
    expect(types.at(-1) === "goal.completed" || types.includes("goal.completed")).toBe(true);
  }, 30_000);

  test("a daemon that restarts after any event of the recovery finishes the goal", async () => {
    const failures: string[] = [];
    for (let keep = started(); keep < recorded.events.length; keep += 1) {
      const attached = recorded.events
        .slice(0, keep)
        .some((e) => e.type === "lead.attached" && e.id.includes(":lead:recovery-"));
      // The agent layer still knows the recovery Lead it created before the crash.
      const { env, store } = await restartRecoveryAfter(recorded, keep, {
        agents: [recorded.lead],
      });
      try {
        const goal = store.get("g1") as Goal;
        expect(goal.status).toBe("completed");
        assertSound(goal);
        expect(goal.recovery).toMatchObject({ outcome: "applied" });
        expect(goal.recoveries).toBe(1);
        expect((goal.interventions ?? []).filter((i) => i.status === "open")).toEqual([]);
        if (!attached) {
          // Crash window (a): the Lead created before lead.attached is released, a new one decides.
          expect(env.harness.canceled).toContain(recorded.lead.agentId);
          expect(env.harness.archived).toContain(recorded.lead.workspaceId);
        }
      } catch (error) {
        const goal = store.get("g1");
        failures.push(
          `after event ${keep} (${recorded.events[keep - 1]?.type}): status=${goal?.status} recovery=${goal?.recovery?.status} reason=${goal?.failureReason ?? "-"} ${error instanceof Error ? error.message.split("\n")[0] : ""}`,
        );
      } finally {
        await env.cleanup();
      }
    }
    expect(failures).toEqual([]);
  }, 180_000);

  test("crash window (b): a Lead attached but never asked is asked at start", async () => {
    const keep = indexAfter(
      recorded.events,
      (e) => e.type === "lead.attached" && e.id.includes(":lead:recovery-"),
    );
    expect(recorded.events[keep]?.type).toBe("intervention.requested");
    const { env, store } = await restartRecoveryAfter(recorded, keep);
    try {
      const goal = store.get("g1") as Goal;
      expect(goal.status).toBe("completed");
      // The same Lead was asked; no second recovery Lead was created.
      expect(env.harness.agents.filter((a) => a.labels["paseo.goal-recovery"])).toEqual([]);
      expect(goal.interventions?.at(-1)).toMatchObject({
        id: `recovery-${goal.recovery?.id}`,
        outcome: "decided",
      });
    } finally {
      await env.cleanup();
    }
  });

  test("crash window (c): a decision whose time ran out while the daemon was down falls back to a retry, not counted", async () => {
    const keep = indexAfter(recorded.events, (e) => e.type === "intervention.requested");
    const { env, store } = await restartRecoveryAfter(recorded, keep, {
      recordedAgoMs: RECOVERY_DECISION_MS + 60_000,
    });
    try {
      const goal = store.get("g1") as Goal;
      expect(goal.recovery?.decision).toMatchObject({ decision: "retry", fallback: true });
      expect(goal.recoveries ?? 0).toBe(0);
      // Retried with the person's instruction only, which does not fix a: the goal fails again.
      expect(goal.status).toBe("failed");
      expect(goal.recovery?.status).toBe("ended");
    } finally {
      await env.cleanup();
    }
  });

  test("a recovery that ended before the daemon stopped has its Lead released at start", async () => {
    const ended = await recordRecoveryRun({ decision: "needs_person", reason: "raise maxRuns" });
    const keep = indexAfter(ended.events, (e) => e.type === "recovery.decided");
    const { env, store } = await restartRecoveryAfter(ended, keep, {
      decision: { decision: "needs_person", reason: "raise maxRuns" },
      agents: [ended.lead],
    });
    try {
      const goal = store.get("g1") as Goal;
      expect(goal.status).toBe("failed");
      expect(goal.recovery).toMatchObject({ status: "ended", outcome: "needs_person" });
      expect(env.harness.canceled).toContain(ended.lead.agentId);
      expect(env.harness.archived).toContain(ended.lead.workspaceId);
    } finally {
      await env.cleanup();
    }
    // Once released, a later start leaves it alone.
    const again = await restartRecoveryAfter(ended, ended.events.length, {
      decision: { decision: "needs_person", reason: "raise maxRuns" },
      agents: [],
    });
    try {
      expect(again.env.harness.canceled).toEqual([]);
    } finally {
      await again.env.cleanup();
    }
  });

  test("a split waiting for approval waits across a restart, then applies when the person approves", async () => {
    const split = {
      decision: "revise",
      reason: "split a",
      ops: [
        { op: "remove", taskId: "a" },
        { op: "add", task: task("a1") },
        { op: "replace", task: task("b", { dependsOn: ["a1"] }) },
      ],
    };
    const waiting = await recordRecoveryRun(split, { autoApprovePlan: false });
    const keep = indexAfter(waiting.events, (e) => e.type === "recovery.decided");
    const { env, store, service, manager } = await restartRecoveryAfter(waiting, keep, {
      decision: split,
    });
    try {
      const goal = store.get("g1") as Goal;
      expect(goal.recovery?.status).toBe("awaiting_approval");
      expect((await env.readEvents()).length).toBe(keep);
      await service.decideRecovery("g1", { recoveryId: goal.recovery?.id ?? "", approve: true });
      await env.settle(manager);
      expect(store.get("g1")?.status).toBe("completed");
    } finally {
      await env.cleanup();
    }
  });

  afterAll(() => {
    recorded = { events: [], lead: {} as RecordedRecovery["lead"] };
  });
});

// Goal b195cf6f (test-fixtures, anonymised): every task succeeded, c1 was not met and one
// recovery is left. Its Lead adds a fix task, which is merged before every criterion is
// verified again in round 1.
const B195 = "b195cf6f-6f1c-4889-aff8-3f689db7ab15";
const ADD_FIX = {
  decision: "revise",
  reason: "add a task that fixes F-01",
  ops: [{ op: "add", task: task("t7", { dependsOn: ["t5"] }) }],
};

function scriptVerifyFix(env: GoalTestEnv): void {
  env.script([]);
  const base = env.harness.respond;
  const recoveryLeads = new Set<string>();
  env.harness.respond = (turn): TurnResult | "hold" => {
    if (turn.prompt.includes("asked you to recover it")) recoveryLeads.add(turn.agentId);
    if (!recoveryLeads.has(turn.agentId)) return base?.(turn) ?? "hold";
    return { outcome: "completed", text: env.fenced(JSON.stringify(ADD_FIX)) };
  };
}

/** Boot on `lines` of goal b195cf6f's log, with the agents the agent layer still knows. */
async function bootB195(
  lines: string[],
  agents: (CreateGoalAgentInput & { agentId: string })[] = [],
) {
  const env = createGoalTestEnv();
  await env.init();
  await writeFile(join(env.logDir(), `${B195}.jsonl`), `${lines.join("\n")}\n`);
  scriptVerifyFix(env);
  env.harness.agents.push(...agents);
  env.harness.git.counter = 1000;
  env.harness.git.headValue = recordedHead(lines.map((line) => JSON.parse(line) as GoalEvent));
  const { store, manager, service } = await env.boot();
  service.attachActivityProbe(manager);
  return { env, store, manager, service };
}

describe("recovery of a failed verification across restarts (b195cf6f)", () => {
  let recorded: RecordedRecovery = { events: [], lead: {} as RecordedRecovery["lead"] };

  test("the recovery adds a fix, which is merged before every criterion is verified again", async () => {
    const fixture = await readFile(
      join(import.meta.dirname, "test-fixtures", "b195cf6f-verify.jsonl"),
      "utf8",
    );
    const { env, store, manager, service } = await bootB195(fixture.trim().split("\n"));
    try {
      await service.startRecovery(B195, { timeMode: "fresh" });
      await env.settle(manager);
      const goal = env.goalOf(store, B195);
      expect(goal.status).toBe("completed");
      expect(goal.verificationRound).toBe(1);
      const lead = env.harness.agents.find((a) => a.labels["paseo.goal-recovery"]);
      if (!lead) throw new Error("no recovery Lead");
      recorded = { events: await env.readEvents(B195), lead };
    } finally {
      await env.cleanup();
    }
  }, 30_000);

  test("a daemon that restarts after any event of the recovery finishes the goal", async () => {
    const failures: string[] = [];
    for (let keep = 217; keep < recorded.events.length; keep += 1) {
      const lines = recorded.events.slice(0, keep).map((e) => JSON.stringify(e));
      const { env, store, manager } = await bootB195(lines, [recorded.lead]);
      try {
        await env.settle(manager);
        const goal = store.get(B195) as Goal;
        expect(goal.status).toBe("completed");
        assertSound(goal);
        expect(goal.verificationRound).toBe(1);
        expect(goal.recoveries).toBe(3);
        expect(goal.tasks.find((t) => t.id === "t7")?.status).toBe("succeeded");
      } catch (error) {
        const goal = store.get(B195);
        failures.push(
          `after event ${keep} (${recorded.events[keep - 1]?.type}): status=${goal?.status} reason=${goal?.failureReason ?? "-"} ${error instanceof Error ? error.message.split("\n")[0] : ""}`,
        );
      } finally {
        await env.cleanup();
      }
    }
    expect(failures).toEqual([]);
  }, 180_000);
});
