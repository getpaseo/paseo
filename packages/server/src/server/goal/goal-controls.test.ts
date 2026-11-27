import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Goal, GoalConfig, GoalEvent, TaskSpec } from "@getpaseo/protocol/goal/types";
import { GoalEventLog } from "./event-log.js";
import {
  MAX_PLAN_REJECTIONS,
  MAX_USAGE_BREAKDOWN_ENTRIES,
  applyGoalEvent,
} from "./goal-reducer.js";
import { goalActiveMs } from "@getpaseo/protocol/goal/active-time";
import { goalDeadlineMs } from "./goal-limits.js";
import { reworkWorktreeProblem } from "./goal-recovery.js";
import { GoalService } from "./goal-service.js";
import { GoalStore } from "./goal-store.js";
import { CONFIG, createGoalTestEnv, task, type GoalTestEnv } from "./goal-test-env.js";

const AT = "2026-01-01T00:00:00.000Z";

function spec(id: string, dependsOn: string[] = []): TaskSpec {
  return { id, title: id, description: "", kind: "implement", dependsOn };
}

let counter = 0;
function ev(goal: Goal | null, partial: Record<string, unknown>, at = AT): GoalEvent {
  counter += 1;
  return {
    id: `e${counter}`,
    goalId: "g1",
    seq: (goal?.lastSeq ?? 0) + 1,
    at,
    ...partial,
  } as GoalEvent;
}

function run(events: Record<string, unknown>[], start: Goal | null = null): Goal {
  let goal = start;
  for (const partial of events) goal = applyGoalEvent(goal, ev(goal, partial));
  if (!goal) throw new Error("no events");
  return goal;
}

const managed = (config: Partial<GoalConfig> = {}) => ({
  type: "goal.created",
  title: "T",
  objective: "O",
  criteria: [{ id: "c1", text: "works" }],
  config: { ...CONFIG, ...config },
});

const proposed = { type: "plan.proposed", tasks: [spec("a"), spec("b", ["a"])] };

/** A goal whose task a failed for good, which failed the goal. */
function failedGoal(config: Partial<GoalConfig> = {}): Goal {
  return run([
    managed(config),
    proposed,
    { type: "plan.approved" },
    { type: "task.started", taskId: "a" },
    { type: "run.started", runId: "a-a1", taskId: "a", provider: "codex" },
    { type: "run.finished", runId: "a-a1", outcome: "failed", error: "boom" },
    { type: "task.failed", taskId: "a", error: "boom" },
    { type: "goal.failed", reason: "No task can make progress. Failed or blocked: a, b" },
  ]);
}

describe("goal control events in the reducer", () => {
  test("a rejected plan is kept with its feedback and planning starts over", () => {
    const goal = run([managed(), proposed, { type: "plan.rejected", reason: "split a" }]);
    expect(goal.status).toBe("planning");
    expect(goal.tasks).toEqual([]);
    expect(goal.planRejections).toEqual([
      { reason: "split a", tasks: [spec("a"), spec("b", ["a"])], at: AT },
    ]);
  });

  test("a plan can be rejected only a bounded number of times", () => {
    const rounds = Array.from({ length: MAX_PLAN_REJECTIONS }, () => [
      proposed,
      { type: "plan.rejected", reason: "" },
    ]).flat();
    const goal = run([managed(), ...rounds, proposed]);
    expect(goal.planRejections).toHaveLength(MAX_PLAN_REJECTIONS);
    expect(() => applyGoalEvent(goal, ev(goal, { type: "plan.rejected", reason: "" }))).toThrow(
      /limit is 5/,
    );
  });

  test("pause and resume toggle pausedAt and refuse to repeat", () => {
    const paused = run([managed(), { type: "goal.paused" }]);
    expect(paused.pausedAt).toBe(AT);
    expect(() => applyGoalEvent(paused, ev(paused, { type: "goal.paused" }))).toThrow(
      /already paused/,
    );
    const resumed = run([{ type: "goal.resumed" }], paused);
    expect(resumed.pausedAt).toBeNull();
    expect(() => applyGoalEvent(resumed, ev(resumed, { type: "goal.resumed" }))).toThrow(
      /not paused/,
    );
  });

  test("an ended goal cannot be paused", () => {
    const cancelled = run([managed(), { type: "goal.cancelled" }]);
    expect(() => applyGoalEvent(cancelled, ev(cancelled, { type: "goal.paused" }))).toThrow(
      /goal is cancelled/,
    );
  });

  test("retrying a failed goal reopens it and forgives the earlier failures", () => {
    const goal = run([{ type: "goal.retried", taskIds: ["a"], reopen: true }], failedGoal());
    expect(goal.status).toBe("executing");
    expect(goal.failureReason).toBeNull();
    expect(goal.reopens).toBe(1);
    expect(goal.tasks[0]).toMatchObject({ status: "pending", error: null, forgivenFailures: 1 });
  });

  test("reopening must name every failed task and must say it reopens", () => {
    const failed = failedGoal();
    expect(() =>
      applyGoalEvent(failed, ev(failed, { type: "goal.retried", taskIds: ["a"], reopen: false })),
    ).toThrow(/must reopen/);
    expect(() =>
      applyGoalEvent(failed, ev(failed, { type: "goal.retried", taskIds: ["b"], reopen: true })),
    ).toThrow(/task b is pending/);
  });

  test("a failed goal past its run limit or time limit is not reopened", () => {
    const limited = failedGoal({ limits: { maxRuns: 1 } });
    expect(() =>
      applyGoalEvent(limited, ev(limited, { type: "goal.retried", taskIds: ["a"], reopen: true })),
    ).toThrow(/run limit of 1/);
    const late = failedGoal({ limits: { goalTimeoutMinutes: 1 } });
    expect(() =>
      applyGoalEvent(
        late,
        ev(
          late,
          { type: "goal.retried", taskIds: ["a"], reopen: true },
          "2026-01-01T00:01:00.000Z",
        ),
      ),
    ).toThrow(/time limit/);
  });

  test("a failed goal with a rejected change set is not reopened", () => {
    const goal = run([
      managed(),
      { type: "plan.proposed", tasks: [spec("a"), spec("b")] },
      { type: "plan.approved" },
      { type: "task.started", taskId: "a" },
      { type: "run.started", runId: "a-a1", taskId: "a", provider: "codex" },
      { type: "task.succeeded", taskId: "a" },
      { type: "run.finished", runId: "a-a1", outcome: "succeeded" },
      {
        type: "changeset.captured",
        changeSetId: "cs1",
        taskId: "a",
        runId: "a-a1",
        round: 0,
        supersedes: null,
        workspaceId: "w",
        cwd: "/w",
        branch: "b",
        baseCommit: "x",
        headCommit: "y",
        files: [],
      },
      { type: "changeset.transitioned", changeSetId: "cs1", to: "in_review" },
      { type: "changeset.transitioned", changeSetId: "cs1", to: "rejected" },
      { type: "task.started", taskId: "b" },
      { type: "task.failed", taskId: "b", error: "boom" },
      { type: "goal.failed", reason: "x" },
    ]);
    expect(() =>
      applyGoalEvent(goal, ev(goal, { type: "goal.retried", taskIds: ["b"], reopen: true })),
    ).toThrow(/cs1 was rejected/);
  });

  test("a manual goal has nothing to retry", () => {
    const goal = run([
      { ...managed(), config: undefined },
      proposed,
      { type: "plan.approved" },
      { type: "task.started", taskId: "a" },
      { type: "task.failed", taskId: "a", error: "boom" },
    ]);
    expect(() =>
      applyGoalEvent(goal, ev(goal, { type: "goal.retried", taskIds: ["a"], reopen: false })),
    ).toThrow(/manual goal/);
  });

  test("usage adds up per goal and per run, and counts turns without usage", () => {
    const goal = run([
      managed(),
      { type: "usage.recorded", role: "lead", agentId: "lead", usage: { inputTokens: 10 } },
      proposed,
      { type: "plan.approved" },
      { type: "task.started", taskId: "a" },
      { type: "run.started", runId: "a-a1", taskId: "a", provider: "codex" },
      {
        type: "usage.recorded",
        role: "worker",
        agentId: "w1",
        runId: "a-a1",
        usage: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, costUsd: 0.5 },
      },
      { type: "usage.recorded", role: "reviewer", agentId: "r1" },
    ]);
    expect(goal.usage).toEqual({
      inputTokens: 110,
      cachedInputTokens: 40,
      outputTokens: 20,
      totalTokens: 130,
      costUsd: 0.5,
      reportedTurns: 2,
      totalTurns: 3,
      costReportedTurns: 1,
      tokenReportedTurns: 2,
    });
    expect(goal.runs[0]?.usage).toMatchObject({ totalTokens: 120, reportedTurns: 1 });
    expect(() =>
      applyGoalEvent(goal, ev(goal, { type: "usage.recorded", role: "worker", agentId: "w" })),
    ).toThrow(/names its run/);
  });

  test("usage is broken down per role and per agent, naming each agent's provider", () => {
    const goal = run([
      managed({
        leadProvider: "claude/claude-opus-5-5",
        reviewProvider: "claude/claude-sonnet-5-5",
        leadThinking: "medium",
      }),
      { type: "usage.recorded", role: "lead", agentId: "lead", usage: { costUsd: 0.5 } },
      { type: "usage.recorded", role: "lead", agentId: "lead", usage: { inputTokens: 10 } },
      proposed,
      { type: "plan.approved" },
      { type: "task.started", taskId: "a" },
      { type: "run.started", runId: "a-a1", taskId: "a", provider: "codex/gpt-6-luna" },
      {
        type: "run.attached",
        runId: "a-a1",
        agentId: "w1",
        workspaceId: "ws",
        thinking: "max",
      },
      {
        type: "usage.recorded",
        role: "worker",
        agentId: "w1",
        runId: "a-a1",
        usage: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20 },
      },
      { type: "usage.recorded", role: "verifier", agentId: "v1", thinking: "high" },
    ]);
    expect(goal.usageByRole?.lead).toMatchObject({
      inputTokens: 10,
      costUsd: 0.5,
      totalTurns: 2,
      costReportedTurns: 1,
      tokenReportedTurns: 1,
    });
    expect(goal.usageByRole?.worker).toMatchObject({ totalTokens: 120, costReportedTurns: 0 });
    expect(goal.usageByRole?.verifier).toMatchObject({ totalTurns: 1, reportedTurns: 0 });
    expect(goal.usageByRole?.reviewer).toBeUndefined();
    // One entry per agent, most recently active last.
    expect(goal.usageBreakdown).toEqual([
      expect.objectContaining({
        agentId: "lead",
        role: "lead",
        provider: "claude",
        model: "claude-opus-5-5",
        thinking: "medium",
        usage: expect.objectContaining({ totalTurns: 2, inputTokens: 10, costUsd: 0.5 }),
      }),
      expect.objectContaining({
        agentId: "w1",
        role: "worker",
        taskId: "a",
        runId: "a-a1",
        provider: "codex",
        model: "gpt-6-luna",
        thinking: "max",
        usage: expect.objectContaining({ cachedInputTokens: 40, totalTurns: 1 }),
      }),
      expect.objectContaining({
        agentId: "v1",
        role: "verifier",
        provider: "claude",
        model: "claude-sonnet-5-5",
        thinking: "high",
      }),
    ]);
    expect(goal.usageBreakdownTruncated).toBeUndefined();
  });

  test("the breakdown keeps the most recently active agents and counts the ones dropped", () => {
    const turns = Array.from({ length: MAX_USAGE_BREAKDOWN_ENTRIES + 2 }, (_, i) => ({
      type: "usage.recorded",
      role: "reviewer",
      agentId: `r${i}`,
      usage: { outputTokens: 1 },
    }));
    const goal = run([
      managed(),
      ...turns,
      { type: "usage.recorded", role: "reviewer", agentId: "r0", usage: { outputTokens: 1 } },
    ]);
    expect(goal.usageBreakdown).toHaveLength(MAX_USAGE_BREAKDOWN_ENTRIES);
    // r0 and r1 were dropped; r0 came back with only its later turn.
    expect(goal.usageBreakdownTruncated).toBe(3);
    expect(goal.usageBreakdown?.at(-1)).toMatchObject({ agentId: "r0", usage: { totalTurns: 1 } });
    expect(goal.usageBreakdown?.some((e) => e.agentId === "r1")).toBe(false);
    expect(goal.usage).toMatchObject({ outputTokens: MAX_USAGE_BREAKDOWN_ENTRIES + 3 });
  });

  test("a goal over its token budget is not reopened", () => {
    const goal = run([
      managed({ limits: { maxTotalTokens: 1000 } }),
      proposed,
      { type: "plan.approved" },
      { type: "usage.recorded", role: "lead", agentId: "l", usage: { inputTokens: 1000 } },
      { type: "task.started", taskId: "a" },
      { type: "task.failed", taskId: "a", error: "boom" },
      { type: "goal.failed", reason: "Token budget of 1000 reached (1000 reported)" },
    ]);
    expect(() =>
      applyGoalEvent(goal, ev(goal, { type: "goal.retried", taskIds: ["a"], reopen: true })),
    ).toThrow(/Token budget of 1000 reached/);
  });
});

describe("retry time modes in the reducer", () => {
  const MIN = 60_000;
  const after = (ms: number) => new Date(Date.parse(AT) + ms).toISOString();
  const tenMinutes = { limits: { goalTimeoutMinutes: 10 } };
  const reopen = (extra: Record<string, unknown> = {}) => ({
    type: "goal.retried",
    taskIds: ["a"],
    reopen: true,
    ...extra,
  });
  const retryAt = (goal: Goal, extra: Record<string, unknown>, ms: number) =>
    applyGoalEvent(goal, ev(goal, reopen(extra), after(ms)));

  test("within the time limit, a retry without a mode leaves the time base alone", () => {
    const goal = retryAt(failedGoal(tenMinutes), {}, 5 * MIN);
    expect(goal.status).toBe("executing");
    expect(goal).not.toHaveProperty("timeBaseAt");
    expect(goalDeadlineMs(goal, Date.now())).toBe(Date.parse(after(10 * MIN)));
  });

  test("past the time limit, a retry must choose fresh or remaining", () => {
    const failed = failedGoal(tenMinutes);
    expect(() => retryAt(failed, {}, 20 * MIN)).toThrow(
      /time limit has passed; choose time mode fresh .* or remaining/,
    );
    const fresh = retryAt(failed, { timeMode: "fresh" }, 20 * MIN);
    expect(fresh.timeBaseAt).toBe(after(20 * MIN));
    expect(goalDeadlineMs(fresh, Date.now())).toBe(Date.parse(after(30 * MIN)));
    const remaining = retryAt(failed, { timeMode: "remaining", activeMs: 4 * MIN }, 20 * MIN);
    expect(remaining.timeBaseAt).toBe(after(16 * MIN));
    expect(goalDeadlineMs(remaining, Date.now())).toBe(Date.parse(after(26 * MIN)));
    // Raising the limit later moves the deadline from the same base.
    const raised = applyGoalEvent(
      remaining,
      ev(
        remaining,
        { type: "goal.config_updated", config: { ...CONFIG, limits: { goalTimeoutMinutes: 20 } } },
        after(21 * MIN),
      ),
    );
    expect(goalDeadlineMs(raised, Date.now())).toBe(Date.parse(after(36 * MIN)));
  });

  test("a mode is honoured even before the time limit passes", () => {
    const goal = retryAt(failedGoal(tenMinutes), { timeMode: "fresh" }, 5 * MIN);
    expect(goal.timeBaseAt).toBe(after(5 * MIN));
  });

  test("remaining with no time left, without its running time, or an unknown mode is refused", () => {
    const failed = failedGoal(tenMinutes);
    expect(() => retryAt(failed, { timeMode: "remaining", activeMs: 10 * MIN }, 20 * MIN)).toThrow(
      "no time is left; choose fresh or raise the limit",
    );
    expect(() => retryAt(failed, { timeMode: "remaining" }, 20 * MIN)).toThrow(/needs activeMs/);
    expect(() => retryAt(failed, { timeMode: "remaining", activeMs: 21 * MIN }, 20 * MIN)).toThrow(
      /longer than the goal has existed/,
    );
    expect(() => retryAt(failed, { timeMode: "later" }, 20 * MIN)).toThrow(
      /unknown time mode later; expected fresh or remaining/,
    );
  });

  test("a passed absolute deadline refuses every mode and says so", () => {
    const deadlineAt = after(15 * MIN);
    const failed = failedGoal({ limits: { goalTimeoutMinutes: 10, deadlineAt } });
    for (const extra of [{}, { timeMode: "fresh" }, { timeMode: "remaining", activeMs: 0 }]) {
      expect(() => retryAt(failed, extra, 20 * MIN)).toThrow(
        `the goal's deadline ${deadlineAt} has passed; set a later deadline or clear it`,
      );
    }
    // Before it, fresh restarts the limit but the deadline still caps it.
    const fresh = retryAt(failed, { timeMode: "fresh" }, 12 * MIN);
    expect(goalDeadlineMs(fresh, Date.now())).toBe(Date.parse(deadlineAt));
  });

  test("reopening a planning failure takes the same modes", () => {
    const planning = run([managed(tenMinutes), { type: "goal.failed", reason: "x" }]);
    expect(() =>
      applyGoalEvent(planning, ev(planning, { type: "goal.reopened" }, after(20 * MIN))),
    ).toThrow(/choose time mode fresh/);
    const replanned = applyGoalEvent(
      planning,
      ev(planning, { type: "goal.reopened", timeMode: "fresh" }, after(20 * MIN)),
    );
    expect(replanned).toMatchObject({ status: "planning", timeBaseAt: after(20 * MIN) });
  });

  test("a live goal's task retry takes a mode too", () => {
    const live = run([
      managed(tenMinutes),
      proposed,
      { type: "plan.approved" },
      { type: "task.started", taskId: "a" },
      { type: "task.failed", taskId: "a", error: "boom" },
    ]);
    const retried = applyGoalEvent(
      live,
      ev(
        live,
        { type: "goal.retried", taskIds: ["a"], reopen: false, timeMode: "fresh" },
        after(12 * MIN),
      ),
    );
    expect(retried).toMatchObject({ status: "executing", timeBaseAt: after(12 * MIN) });
  });
});

describe("the time a goal ran", () => {
  const MIN = 60_000;
  const at = (minutes: number) => new Date(Date.parse(AT) + minutes * MIN).toISOString();
  const events = (list: [string, number, Record<string, unknown>?][]) =>
    list.map(([type, minutes, extra]) => ({ type, at: at(minutes), ...extra }) as GoalEvent);

  test("paused and failed time does not count; reopening and resuming start the clock", () => {
    const log = events([
      ["goal.created", 0],
      ["goal.paused", 2],
      ["goal.resumed", 5],
      ["goal.failed", 6],
      ["goal.retried", 30, { reopen: true }],
      ["goal.failed", 31],
    ]);
    expect(goalActiveMs(log, Date.parse(at(100)))).toBe(4 * MIN);
  });

  test("a live goal counts up to the time asked about", () => {
    expect(goalActiveMs(events([["goal.created", 0]]), Date.parse(at(3)))).toBe(3 * MIN);
  });

  test("a fresh restart starts the count again; remaining keeps it", () => {
    const fresh = events([
      ["goal.created", 0],
      ["goal.failed", 4],
      ["goal.retried", 10, { reopen: true, timeMode: "fresh" }],
      ["goal.failed", 11],
    ]);
    expect(goalActiveMs(fresh, Date.parse(at(50)))).toBe(MIN);
    const remaining = events([
      ["goal.created", 0],
      ["goal.failed", 4],
      ["changeset.integration_retried", 10, { timeMode: "remaining", activeMs: 4 * MIN }],
      ["goal.cancelled", 11],
    ]);
    expect(goalActiveMs(remaining, Date.parse(at(50)))).toBe(5 * MIN);
  });

  test("a fresh retry of a paused goal starts counting only when it is resumed", () => {
    const log = events([
      ["goal.created", 0],
      ["goal.paused", 1],
      ["goal.retried", 3, { reopen: false, timeMode: "fresh" }],
      ["goal.resumed", 5],
    ]);
    expect(goalActiveMs(log, Date.parse(at(6)))).toBe(MIN);
  });

  test("an event whose time does not parse is skipped", () => {
    const log = [...events([["goal.created", 0]]), { type: "goal.paused", at: "x" } as GoalEvent];
    expect(goalActiveMs(log, Date.parse(at(2)))).toBe(2 * MIN);
  });

  test("a goal that failed while paused reopens paused and runs once resumed", () => {
    const log = events([
      ["goal.created", 0],
      ["goal.paused", 1],
      ["goal.failed", 2],
      ["goal.reopened", 5],
      ["goal.resumed", 6],
    ]);
    expect(goalActiveMs(log, Date.parse(at(8)))).toBe(3 * MIN);
  });
});

describe("goal controls in the Manager", () => {
  let env: GoalTestEnv;

  beforeEach(async () => {
    env = createGoalTestEnv();
    await env.init();
  });
  afterEach(() => env.cleanup());

  const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

  test("a rejected plan goes to a fresh Lead with the feedback and the rejected plan", async () => {
    const prompts: string[] = [];
    let plans = 0;
    env.harness.respond = (turn) => {
      if (turn.prompt.includes("You are the Lead")) {
        prompts.push(turn.prompt);
        plans += 1;
        const tasks = plans === 1 ? [task("big")] : [task("small1"), task("small2")];
        return { outcome: "completed", text: `\`\`\`json\n${JSON.stringify({ tasks })}\n\`\`\`` };
      }
      return { outcome: "completed", text: "done" };
    };
    const { store, manager, service } = await env.boot();
    await env.createGoal(store, { ...CONFIG, autoApprovePlan: false });
    await env.settle(manager);
    const firstLead = env.goalOf(store).leadAgentId;

    await service.rejectPlan("g1", "Split it in two", "reject-1");
    // A resend with the same eventId changes nothing.
    await service.rejectPlan("g1", "Split it in two", "reject-1");
    await env.settle(manager);

    const goal = env.goalOf(store);
    expect(goal.status).toBe("awaiting_plan_approval");
    expect(goal.tasks.map((t) => t.id)).toEqual(["small1", "small2"]);
    expect(goal.planRejections).toHaveLength(1);
    expect(goal.leadAgentId).not.toBe(firstLead);
    expect(env.harness.canceled).toContain(firstLead);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Split it in two");
    expect(prompts[1]).toContain('"id": "big"');
  });

  test("a paused goal starts no runs, lets running ones finish, and resumes", async () => {
    env.script([task("a"), task("b", { dependsOn: ["a"] })], () => "hold");
    const { store, manager, service } = await env.boot();
    await env.createGoal(store);
    await tick();
    expect(env.harness.turns).toHaveLength(1);

    await service.pause("g1");
    env.harness.turns[0]?.resolve({ outcome: "completed", text: "a done" });
    await env.settle(manager);
    const paused = env.goalOf(store);
    expect(paused.tasks.map((t) => t.status)).toEqual(["succeeded", "pending"]);
    // a's change was reviewed and merged; b did not start.
    expect(paused.changeSets.map((c) => c.status)).toEqual(["integrated"]);
    expect(env.harness.agents.filter((a) => a.labels["paseo.goal-task"] === "b")).toHaveLength(0);

    env.script([task("a"), task("b", { dependsOn: ["a"] })]);
    await service.resume("g1");
    await env.settle(manager);
    expect(env.goalOf(store).status).toBe("completed");
  });

  test("a goal paused before a restart stays paused after it", async () => {
    env.script([task("a")], () => "hold");
    const first = await env.boot();
    await env.createGoal(first.store);
    await tick();
    await first.service.pause("g1");
    first.manager.stop();

    env.script([task("a")]);
    const second = await env.boot();
    await env.settle(second.manager);
    const goal = env.goalOf(second.store);
    // The interrupted run is closed out and its task waits to run again.
    expect(goal.status).toBe("executing");
    expect(goal.pausedAt).toBeTruthy();
    expect(goal.runs.map((r) => r.status)).toEqual(["interrupted"]);
    expect(goal.tasks[0]?.status).toBe("pending");

    await second.service.resume("g1");
    await env.settle(second.manager);
    expect(env.goalOf(second.store).status).toBe("completed");
  });

  test("retrying a failed goal reopens it, grants fresh attempts and finishes", async () => {
    let failing = true;
    env.script([task("a"), task("b", { dependsOn: ["a"] })], () =>
      failing ? { outcome: "failed", error: "flaky" } : { outcome: "completed", text: "ok" },
    );
    const config = { ...CONFIG, originAgentId: "chat-1" };
    const { store, manager, service } = await env.boot();
    await env.createGoal(store, config);
    await env.settle(manager);
    expect(env.goalOf(store).status).toBe("failed");

    failing = false;
    // Naming b, which is pending, is refused; naming nothing retries every failed task.
    await expect(service.retry("g1", "b")).rejects.toThrow(/b is pending/);
    await service.retry("g1", undefined, "retry-1");
    await service.retry("g1", undefined, "retry-1");
    await env.settle(manager);

    const goal = env.goalOf(store);
    expect(goal.status).toBe("completed");
    expect(goal.reopens).toBe(1);
    expect(goal.tasks[0]).toMatchObject({ status: "succeeded", forgivenFailures: 2 });
    // The chat hears about both endings.
    const toChat = env.harness.notified.filter((n) => n.agentId === "chat-1").map((n) => n.text);
    expect(toChat).toHaveLength(2);
    expect(toChat[0]).toMatch(/failed/);
    expect(toChat[1]).toMatch(/completed/);
  });

  test("a retry with remaining records the time the goal ran and counts the limit from it", async () => {
    let failing = true;
    env.script([task("a")], () =>
      failing ? { outcome: "failed", error: "flaky" } : { outcome: "completed", text: "ok" },
    );
    const { store, manager, service } = await env.boot();
    await env.createGoal(store);
    await env.settle(manager);
    expect(env.goalOf(store).status).toBe("failed");

    failing = false;
    const before = await env.readEvents();
    await service.retry("g1", undefined, "retry-remaining", "remaining");
    const events = await env.readEvents();
    const retried = events.at(-1);
    if (retried?.type !== "goal.retried") throw new Error("expected goal.retried");
    // The goal stopped running when it failed, so the time it ran is fixed by the log.
    expect(retried).toMatchObject({
      timeMode: "remaining",
      activeMs: goalActiveMs(before, Date.parse(retried.at)),
    });
    expect(env.goalOf(store).timeBaseAt).toBe(
      new Date(Date.parse(retried.at) - (retried.activeMs ?? 0)).toISOString(),
    );
    await env.settle(manager);
    expect(env.goalOf(store).status).toBe("completed");
  });

  test("a merge that failed is merged again by retry, and the goal finishes", async () => {
    env.script([task("a"), task("b")]);
    env.harness.git.mergeErrors.push(
      new Error("Integration worktree has uncommitted changes:\nM tracked.txt"),
    );
    const { store, manager, service } = await env.boot();
    await env.createGoal(store);
    await env.settle(manager);

    const failed = env.goalOf(store);
    expect(failed.status).toBe("failed");
    expect(failed.failureReason).toMatch(/Integrating cs-.* failed: Integration worktree/);
    const broken = failed.changeSets.find((c) => c.status === "rejected");
    expect(broken).toMatchObject({ rejectionReason: "integration_failed" });
    expect(broken?.error).toMatch(/^Integration failed: Integration worktree/);
    const merges = env.harness.git.merges.length;

    // The tree is clean now; retry merges the same change set again without a new review.
    const reviews = env.harness.agents.filter((a) => a.labels["paseo.goal-role"] === "reviewer");
    await service.retry("g1", undefined, "retry-merge");
    await service.retry("g1", undefined, "retry-merge");
    await env.settle(manager);

    const goal = env.goalOf(store);
    expect(goal.status).toBe("completed");
    expect(goal.reopens).toBe(1);
    expect(goal.changeSets.find((c) => c.id === broken?.id)?.status).toBe("integrated");
    expect(env.harness.git.merges.slice(merges).map((m) => m.commit)).toContain(broken?.headCommit);
    expect(
      env.harness.agents.filter((a) => a.labels["paseo.goal-role"] === "reviewer"),
    ).toHaveLength(reviews.length);
    const events = await env.readEvents();
    expect(events.filter((e) => e.type === "changeset.integration_retried")).toHaveLength(1);
  });

  test("a change set rejected by review or a failed verification gives retry nothing to do", async () => {
    env.script([task("a")]);
    env.stageReplies.review = () => ({
      outcome: "completed",
      text: env.fenced(JSON.stringify({ verdict: "request_changes", findings: ["wrong"] })),
    });
    const { store, manager, service } = await env.boot();
    await env.createGoal(store, { ...CONFIG, maxReworkRounds: 0 });
    await env.settle(manager);

    const goal = env.goalOf(store);
    expect(goal.status).toBe("failed");
    expect(goal.changeSets[0]?.status).toBe("rejected");
    // The rework limit is final.
    expect(goal.changeSets[0]?.rejectionReason).toBe("rework_limit");
    await expect(service.retry("g1", undefined)).rejects.toThrow(
      "has no failed or cancelled task, no change set rejected by a failed integration and no failed rework to retry",
    );
  });

  test("a failed rework is reworked again by retry, refused while its worktree is gone", async () => {
    let fixing = false;
    env.script([task("a")], (turn) =>
      turn.prompt.includes("You are fixing your earlier work") && !fixing
        ? { outcome: "failed", error: "cannot fix" }
        : { outcome: "completed", text: "done" },
    );
    let reviews = 0;
    env.stageReplies.review = () => {
      reviews += 1;
      const verdict =
        reviews === 1
          ? { verdict: "request_changes", findings: ["wrong"] }
          : { verdict: "approve", findings: [] };
      return { outcome: "completed", text: env.fenced(JSON.stringify(verdict)) };
    };
    const { store, manager, service } = await env.boot();
    service.attachActivityProbe(manager);
    await env.createGoal(store);
    await env.settle(manager);
    const failed = env.goalOf(store);
    expect(failed.changeSets[0]).toMatchObject({ id: "cs-a-a1", rejectionReason: "rework_failed" });

    // The worktree the rework runs in was archived: retry and recover are refused, unrecorded.
    const cwd = failed.changeSets[0]?.cwd ?? "";
    env.harness.git.missing.add(cwd);
    const before = (await env.readEvents()).length;
    await expect(service.retry("g1", undefined)).rejects.toThrow(
      `The rework worktree ${cwd} of cs-a-a1 is gone, so its rework a-rw1 cannot run again. Its work is on branch ${failed.changeSets[0]?.branch}.`,
    );
    await expect(service.startRecovery("g1", {})).rejects.toThrow(/rework worktree .* is gone/);
    expect(await env.readEvents()).toHaveLength(before);

    env.harness.git.missing.delete(cwd);
    fixing = true;
    await service.retry("g1", undefined, "retry-rework");
    const events = await env.readEvents();
    expect(events.at(-1)).toMatchObject({
      type: "goal.retried",
      taskIds: ["a-rw1"],
      reopen: true,
      reworkChangeSetIds: ["cs-a-a1"],
    });
    await env.settle(manager);
    const goal = env.goalOf(store);
    expect(goal.status).toBe("completed");
    expect(goal.changeSets.map((c) => c.status)).toEqual(["superseded", "integrated"]);
  });

  test("two reworks that fail together: the first is rejected, and one retry reworks both", async () => {
    let fixing = false;
    env.script([task("a"), task("b")], (turn) =>
      turn.prompt.includes("You are fixing your earlier work") && !fixing
        ? { outcome: "failed", error: "cannot fix" }
        : { outcome: "completed", text: "done" },
    );
    let reviews = 0;
    env.stageReplies.review = () => {
      // The first reviews of a and b ask for changes; the reworks' reviews approve.
      reviews += 1;
      const verdict =
        reviews <= 2
          ? { verdict: "request_changes", findings: ["wrong"] }
          : { verdict: "approve", findings: [] };
      return { outcome: "completed", text: env.fenced(JSON.stringify(verdict)) };
    };
    const { store, manager, service } = await env.boot();
    service.attachActivityProbe(manager);
    await env.createGoal(store);
    await env.settle(manager);
    const failed = env.goalOf(store);
    expect(failed.status).toBe("failed");
    expect(failed.tasks.filter((t) => t.rework).map((t) => t.status)).toEqual(["failed", "failed"]);
    // The Manager rejects the first dead rework it finds and fails the goal; the other change
    // set is left waiting for its rework, which a reopen retries as a failed task.
    const rejected = failed.changeSets.filter((c) => c.status === "rejected");
    expect(rejected.map((c) => c.rejectionReason)).toEqual(["rework_failed"]);
    expect(failed.changeSets.filter((c) => c.status === "changes_requested")).toHaveLength(1);

    fixing = true;
    await service.retry("g1", undefined);
    expect((await env.readEvents()).at(-1)).toMatchObject({
      type: "goal.retried",
      taskIds: ["a-rw1", "b-rw1"],
      reworkChangeSetIds: [rejected[0]?.id],
    });
    await env.settle(manager);
    const goal = env.goalOf(store);
    expect(goal.status).toBe("completed");
    expect(goal.changeSets.map((c) => c.status).sort()).toEqual([
      "integrated",
      "integrated",
      "superseded",
      "superseded",
    ]);
  });

  test("a retry reworks one change set and merges another again in one event", async () => {
    const log = new GoalEventLog({ dir: env.logDir() });
    const store = new GoalStore(log);
    await store.recover();
    const captured = (changeSetId: string, taskId: string) => ({
      type: "changeset.captured",
      changeSetId,
      taskId,
      runId: `${taskId}-a1`,
      round: 0,
      supersedes: null,
      workspaceId: "ws",
      cwd: "/w",
      branch: "b",
      baseCommit: "base",
      headCommit: "head",
      files: [],
    });
    const move = (changeSetId: string, ...to: string[]) =>
      to.map((status) => ({ type: "changeset.transitioned", changeSetId, to: status }));
    const events: Record<string, unknown>[] = [
      { ...managed(), at: undefined },
      { type: "plan.proposed", tasks: [spec("a"), spec("b")] },
      { type: "plan.approved" },
      {
        type: "integration.prepared",
        branch: "int",
        workspaceId: "wi",
        cwd: "/i",
        baseCommit: "base",
      },
      { type: "task.started", taskId: "a" },
      { type: "task.succeeded", taskId: "a" },
      captured("cs-a", "a"),
      ...move("cs-a", "in_review", "changes_requested"),
      {
        type: "task.added",
        task: spec("a-rw1"),
        rework: { changeSetId: "cs-a", reason: "review", round: 1 },
      },
      { type: "task.started", taskId: "a-rw1" },
      { type: "task.failed", taskId: "a-rw1", error: "boom" },
      {
        type: "changeset.transitioned",
        changeSetId: "cs-a",
        to: "rejected",
        error: "Rework a-rw1 failed: boom",
        reason: "rework_failed",
      },
      { type: "task.started", taskId: "b" },
      { type: "task.succeeded", taskId: "b" },
      captured("cs-b", "b"),
      ...move("cs-b", "in_review", "approved", "integrating"),
      {
        type: "changeset.transitioned",
        changeSetId: "cs-b",
        to: "rejected",
        error: "Integration failed: dirty",
        reason: "integration_failed",
      },
      { type: "goal.failed", reason: "Integrating cs-b failed" },
    ];
    for (const [i, { at: _at, ...event }] of events.entries()) {
      await store.dispatch("g2", { id: `g2-${i}`, goalId: "g2", ...event } as never);
    }
    const service = new GoalService(store, log);
    // Without the Manager to check the rework's worktree, the retry and a recovery are refused.
    await expect(service.retry("g2", undefined)).rejects.toThrow(
      "The daemon cannot check the rework worktree yet; retry again in a moment",
    );
    await expect(service.startRecovery("g2", {})).rejects.toThrow(
      "The daemon cannot check the rework worktree yet; recover again in a moment",
    );
    service.attachActivityProbe({
      hasLiveWork: () => false,
      reworkWorktreeProblem: (failed) => reworkWorktreeProblem(failed, env.harness.git),
    });
    const goal = await service.retry("g2", undefined, "retry-both");
    expect(goal.status).toBe("executing");
    expect(goal.changeSets.map((c) => [c.id, c.status])).toEqual([
      ["cs-a", "changes_requested"],
      ["cs-b", "approved"],
    ]);
    expect((await log.read("g2")).at(-1)).toMatchObject({
      type: "changeset.integration_retried",
      changeSetIds: ["cs-b"],
      taskIds: ["a-rw1"],
      reworkChangeSetIds: ["cs-a"],
    });
  });

  test("a goal reopened just before a restart finishes after it", async () => {
    let failing = true;
    env.script([task("a")], () =>
      failing ? { outcome: "failed", error: "flaky" } : { outcome: "completed", text: "ok" },
    );
    const first = await env.boot();
    await env.createGoal(first.store);
    await env.settle(first.manager);
    first.manager.stop();
    // Written by hand, as if the daemon stopped right after recording it.
    await first.store.dispatch("g1", {
      id: "retry",
      goalId: "g1",
      type: "goal.retried",
      taskIds: ["a"],
      reopen: true,
    });

    failing = false;
    const second = await env.boot();
    await env.settle(second.manager);
    expect(env.goalOf(second.store).status).toBe("completed");
  });

  test("a goal that reports more tokens than its budget fails", async () => {
    env.script([task("a"), task("b", { dependsOn: ["a"] })]);
    const respond = env.harness.respond;
    env.harness.respond = (turn) => {
      const result = respond?.(turn) ?? "hold";
      if (result === "hold") return result;
      return { ...result, usage: { inputTokens: 600, outputTokens: 100, costUsd: 0.01 } };
    };
    const { store, manager } = await env.boot();
    await env.createGoal(store, {
      ...CONFIG,
      limits: { retryBackoffSeconds: 0, maxTotalTokens: 2000 },
    });
    await env.settle(manager);
    const goal = env.goalOf(store);
    expect(goal.status).toBe("failed");
    expect(goal.failureReason).toBe("Token budget of 2000 reached (2100 reported)");
    expect(goal.usage).toMatchObject({ totalTokens: 2100, reportedTurns: 3, totalTurns: 3 });
    // Lead, worker a, reviewer of a; b never started.
    expect(env.harness.agents.filter((a) => a.labels["paseo.goal-task"] === "b")).toHaveLength(0);
  });

  test("turns whose provider reports nothing count as unreported", async () => {
    env.script([task("a")]);
    const { store, manager } = await env.boot();
    await env.createGoal(store);
    await env.settle(manager);
    const goal = env.goalOf(store);
    expect(goal.status).toBe("completed");
    // Lead, worker, reviewer, verifier.
    expect(goal.usage).toMatchObject({ reportedTurns: 0, totalTurns: 4, totalTokens: 0 });
    expect(goal.runs[0]?.usage).toMatchObject({ reportedTurns: 0, totalTurns: 1 });
    const events = await new GoalEventLog({ dir: env.logDir() }).read("g1");
    expect(events.filter((e) => e.type === "usage.recorded").map((e) => e.role)).toEqual([
      "lead",
      "worker",
      "reviewer",
      "verifier",
    ]);
  });

  test("the integration branch and verifier follow the goal's settings", async () => {
    env.script([task("a")]);
    const { store, manager } = await env.boot();
    await env.createGoal(store, {
      ...CONFIG,
      branchPrefix: "goals/team-a",
      verifyProvider: "opencode",
    });
    await env.settle(manager);
    expect(env.goalOf(store).status).toBe("completed");
    expect(env.harness.workspaces.map((w) => w.branchName).filter(Boolean)).toEqual([
      "goals/team-a/g1",
    ]);
    const verifier = env.harness.agents.find((a) => a.labels["paseo.goal-role"] === "verifier");
    expect(verifier?.provider).toBe("opencode");
  });
});

describe("config edits and reopening a planning failure in the reducer", () => {
  test("a config update replaces the settings, even after the goal failed", () => {
    const goal = failedGoal();
    const next = { ...CONFIG, maxAttempts: 3, onPermissionRequest: "wait" as const };
    const updated = run([{ type: "goal.config_updated", config: next }], goal);
    expect(updated.config).toEqual(next);
    expect(updated.status).toBe("failed");
  });

  test("providers, the repository and the other fixed fields cannot change", () => {
    const goal = run([managed()]);
    for (const change of [
      { defaultProvider: "claude" },
      { cwd: "/elsewhere" },
      { leadThinking: "high" },
      { allowedProviders: ["codex"] },
    ]) {
      expect(() =>
        run([{ type: "goal.config_updated", config: { ...CONFIG, ...change } }], goal),
      ).toThrow(/cannot be changed after creation/);
    }
  });

  test("a manual or archived goal's settings cannot change", () => {
    const manual = run([{ type: "goal.created", title: "T", objective: "", criteria: [] }]);
    expect(() => run([{ type: "goal.config_updated", config: CONFIG }], manual)).toThrow(
      /manual goal/,
    );
    const archived = run([{ type: "goal.archived" }], failedGoal());
    expect(() => run([{ type: "goal.config_updated", config: CONFIG }], archived)).toThrow(
      /archived/,
    );
  });

  test("a goal that failed while planning reopens to planning", () => {
    const failed = run([
      managed(),
      { type: "goal.failed", reason: "Lead agent did not finish planning (needs_permission)." },
      { type: "goal.acknowledged" },
    ]);
    const reopened = run([{ type: "goal.reopened" }], failed);
    expect(reopened).toMatchObject({
      status: "planning",
      failureReason: null,
      reopens: 1,
      acknowledgedAt: null,
    });
    // Only a failed goal without tasks, within its limits.
    expect(() => run([{ type: "goal.reopened" }], reopened)).toThrow(/goal is planning/);
    expect(() => run([{ type: "goal.reopened" }], failedGoal())).toThrow(/retry its tasks/);
    const late = run([
      managed({ limits: { goalTimeoutMinutes: 1 } }),
      { type: "goal.failed", reason: "x" },
    ]);
    expect(() =>
      applyGoalEvent(late, ev(late, { type: "goal.reopened" }, "2026-01-01T00:05:00.000Z")),
    ).toThrow(/time limit has passed/);
  });
});

describe("config edits and reopening in the Manager", () => {
  let env: GoalTestEnv;

  beforeEach(async () => {
    env = createGoalTestEnv();
    await env.init();
  });
  afterEach(() => env.cleanup());

  const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

  test("a goal whose Lead stopped for a permission is reopened by retry with a fresh Lead", async () => {
    let leadTurns = 0;
    env.script([task("a")]);
    const scripted = env.harness.respond;
    env.harness.respond = (turn) => {
      if (turn.prompt.includes("You are the Lead")) {
        leadTurns += 1;
        if (leadTurns === 1) return { outcome: "needs_permission" };
      }
      return scripted?.(turn) ?? "hold";
    };
    const { store, manager, service } = await env.boot();
    await env.createGoal(store, { ...CONFIG, onPermissionRequest: "fail" });
    await env.settle(manager);
    const failed = env.goalOf(store);
    expect(failed.status).toBe("failed");
    expect(failed.failureReason).toMatch(/did not finish planning \(needs_permission\)/);
    const firstLead = failed.leadAgentId;

    // Change the policy, then reopen; a resend with the same eventId does nothing more.
    await service.updateConfig("g1", { onPermissionRequest: "wait" });
    await expect(service.retry("g1", "a")).rejects.toThrow(/not found/);
    await service.retry("g1", undefined, "reopen-1");
    await service.retry("g1", undefined, "reopen-1");
    await env.settle(manager);

    const goal = env.goalOf(store);
    expect(goal.status).toBe("completed");
    expect(goal.reopens).toBe(1);
    expect(goal.leadAgentId).not.toBe(firstLead);
    const leads = env.harness.agents.filter((a) => a.labels["paseo.goal-role"] === "lead");
    expect(leads.map((a) => a.permission)).toEqual(["fail", "wait"]);
    const events = await env.readEvents();
    expect(events.filter((e) => e.type === "goal.reopened")).toHaveLength(1);
    // The first Lead stays in the history.
    expect(events.filter((e) => e.type === "lead.attached")).toHaveLength(2);
  });

  test("a live goal picks up new settings: more parallel runs and the next turn's policy", async () => {
    const seen: (string | undefined)[] = [];
    const runTurn = env.harness.agentPort.runTurn;
    env.harness.agentPort.runTurn = (agentId, prompt, options) => {
      const permission = options?.permission;
      seen.push(typeof permission === "function" ? permission() : permission);
      return runTurn(agentId, prompt, options);
    };
    env.script([task("a"), task("b"), task("c")], () => "hold");
    const { store, manager, service } = await env.boot();
    await env.createGoal(store, { ...CONFIG, maxParallel: 1, onPermissionRequest: "fail" });
    await tick();
    expect(env.harness.turns).toHaveLength(1);

    await service.updateConfig("g1", { maxParallel: 3, onPermissionRequest: "auto" });
    await tick();
    expect(env.harness.turns).toHaveLength(3);
    // The Lead and the first worker ran under fail; the turns after the change wait.
    expect(seen).toEqual(["fail", "fail", "wait", "wait"]);
    const workers = env.harness.agents.filter((a) => a.labels["paseo.goal-task"]);
    expect(workers.map((a) => a.permission)).toEqual(["fail", "auto", "auto"]);

    env.script([task("a"), task("b"), task("c")]);
    for (const turn of env.harness.turns) turn.resolve({ outcome: "completed", text: "ok" });
    await env.settle(manager);
    expect(env.goalOf(store).status).toBe("completed");
  });

  test("a policy change switches the goal's running agents; one that cannot switch does not fail the edit", async () => {
    env.script([task("a"), task("b")], () => "hold");
    const { store, manager, service } = await env.boot();
    await env.createGoal(store, { ...CONFIG, onPermissionRequest: "wait" });
    const started = Date.now();
    while (
      env.harness.agents.filter((a) => a.labels["paseo.goal-task"]).length < 2 &&
      Date.now() - started < 5000
    ) {
      await tick(10);
    }
    const lead = env.goalOf(store).leadAgentId;
    const workers = env.harness.agents
      .filter((a) => a.labels["paseo.goal-task"])
      .map((a) => a.agentId);
    expect(workers).toHaveLength(2);

    // Another setting leaves the agents' modes alone.
    await service.updateConfig("g1", { maxParallel: 3 });
    await tick();
    expect(env.harness.modeSwitches).toEqual([]);

    env.harness.failModeSwitch.add(workers[0] as string);
    const updated = await service.updateConfig("g1", { onPermissionRequest: "fail" });
    expect(updated.config?.onPermissionRequest).toBe("fail");
    await tick();
    expect(env.harness.modeSwitches).toEqual(
      expect.arrayContaining(
        [lead, ...workers].map((agentId) => ({ agentId, permission: "fail" })),
      ),
    );
    expect(env.harness.modeSwitches).toHaveLength(3);

    for (const turn of env.harness.turns) turn.resolve({ outcome: "completed", text: "ok" });
    env.script([task("a"), task("b")]);
    await env.settle(manager);
    expect(env.goalOf(store).status).toBe("completed");
    // An ended goal's agents are left alone.
    await service.updateConfig("g1", { onPermissionRequest: "wait" });
    await tick();
    expect(env.harness.modeSwitches).toHaveLength(3);
  });

  test("a goal that used up its runs can be given more and retried", async () => {
    let failing = true;
    env.script([task("a"), task("b", { dependsOn: ["a"] })], () =>
      failing ? { outcome: "failed", error: "flaky" } : { outcome: "completed", text: "ok" },
    );
    const { store, manager, service } = await env.boot();
    await env.createGoal(store, {
      ...CONFIG,
      maxAttempts: 1,
      limits: { maxRuns: 1, retryBackoffSeconds: 0 },
    });
    await env.settle(manager);
    expect(env.goalOf(store).status).toBe("failed");
    await expect(service.retry("g1", undefined)).rejects.toThrow(/run limit of 1 is used up/);

    failing = false;
    await service.updateConfig("g1", { limits: { maxRuns: 10 } }, "more-runs");
    await service.retry("g1", undefined);
    await env.settle(manager);
    expect(env.goalOf(store).status).toBe("completed");
  });

  test("the service records the wait default, checks changes and ignores a repeat", async () => {
    const { store, service } = await env.boot();
    env.script([task("a")], () => "hold");
    expect(CONFIG.onPermissionRequest).toBeUndefined();
    const created = await service.create({
      goalId: "g2",
      title: "T",
      objective: "O",
      criteria: ["works"],
      config: CONFIG,
    });
    expect(created.config?.onPermissionRequest).toBe("wait");
    // New goals get Lead interventions unless asked not to; a person can switch them off.
    expect(created.config?.leadInterventions).toBe(true);
    const declined = await service.create({
      goalId: "g3",
      title: "T",
      objective: "O",
      criteria: ["works"],
      config: { ...CONFIG, leadInterventions: false },
    });
    expect(declined.config?.leadInterventions).toBe(false);
    const switched = await service.updateConfig("g3", { leadInterventions: true });
    expect(switched.config?.leadInterventions).toBe(true);

    const before = env.goalOf(store, "g2").lastSeq;
    // The current settings again, or no changes, record nothing.
    await service.updateConfig("g2", { onPermissionRequest: "wait", maxParallel: 2 });
    await service.updateConfig("g2", {});
    expect(env.goalOf(store, "g2").lastSeq).toBe(before);

    // A cleared optional setting falls back to its default; a cleared last limit drops limits.
    const updated = await service.updateConfig("g2", {
      testCommand: "npm test",
      limits: { retryBackoffSeconds: null, maxCostUsd: 5 },
    });
    expect(updated.config?.limits).toEqual({ maxCostUsd: 5 });
    expect(updated.config?.testCommand).toBe("npm test");
    const cleared = await service.updateConfig("g2", {
      testCommand: null,
      limits: { maxCostUsd: null },
    });
    expect(cleared.config?.testCommand).toBeUndefined();
    expect(cleared.config?.limits).toBeUndefined();

    await expect(service.updateConfig("g2", { maxParallel: 99 })).rejects.toThrow(
      /Invalid goal settings/,
    );
    const manual = await service.create({ goalId: "m", title: "M", objective: "", criteria: [] });
    await expect(service.updateConfig(manual.id, { maxParallel: 3 })).rejects.toThrow(/manual/);
  });
});

describe("plan revisions in the Manager", () => {
  let env: GoalTestEnv;

  beforeEach(async () => {
    env = createGoalTestEnv();
    await env.init();
  });
  afterEach(() => env.cleanup());

  const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Wait for a state the Manager reaches asynchronously; a fixed sleep is too short on a loaded machine. */
  const until = async (reached: () => boolean, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (!reached() && Date.now() < deadline) await tick(10);
  };

  const failedTaskIds = (store: Parameters<typeof env.goalOf>[0]) =>
    env
      .goalOf(store)
      .tasks.filter((t) => t.status === "failed")
      .map((t) => t.id);

  /** The task a worker turn runs, from its agent's labels. */
  const taskOf = (agentId: string) =>
    env.harness.agents.find((a) => a.agentId === agentId)?.labels["paseo.goal-task"];

  /** Workers for `held` wait to be resolved, `failing` fail, the rest succeed. */
  function workers(
    tasks: unknown[],
    options: { held?: string[]; failing?: string[] } = {},
  ): { release(): void } {
    const held = new Set(options.held ?? []);
    const failing = new Set(options.failing ?? []);
    env.script(tasks, (turn) => {
      const id = taskOf(turn.agentId) ?? "";
      if (held.has(id)) return "hold";
      if (failing.has(id)) return { outcome: "failed", error: `${id} broke` };
      return { outcome: "completed", text: `${id} done` };
    });
    return {
      release: () => {
        held.clear();
        for (const turn of env.harness.turns) {
          turn.resolve({ outcome: "completed", text: `${taskOf(turn.agentId)} done` });
        }
      },
    };
  }

  const eventsOf = async (type: string) => (await env.readEvents()).filter((e) => e.type === type);

  test("a person's revision applies at once: one approval, and the reply shows it", async () => {
    const work = workers([task("a"), task("b", { dependsOn: ["a"] })], { held: ["a"] });
    const { store, manager, service } = await env.boot();
    service.attachActivityProbe(manager);
    await env.createGoal(store);
    await tick();

    const goal = await service.revisePlan(
      "g1",
      {
        ops: [
          { op: "replace", task: { ...task("b", { dependsOn: ["a"] }), description: "do b well" } },
          { op: "add", task: task("c") },
        ] as never,
        reason: "b needs more care; c was missing",
      },
      "rev-1",
    );

    expect(goal.planRevisions).toEqual([
      expect.objectContaining({ id: "rev-rev-1", source: "person", status: "applied" }),
    ]);
    expect(goal.tasks.map((t) => [t.id, t.status])).toEqual([
      ["a", "running"],
      ["b", "pending"],
      ["c", expect.any(String)],
    ]);
    // A resend with the same eventId returns the goal and records nothing.
    const before = env.goalOf(store).lastSeq;
    await service.revisePlan("g1", { ops: [{ op: "remove", taskId: "c" }], reason: "x" }, "rev-1");
    expect(env.goalOf(store).lastSeq).toBe(before);

    work.release();
    await env.settle(manager);
    expect(env.goalOf(store).status).toBe("completed");
    expect(await eventsOf("plan.revision_approved")).toHaveLength(1);
  });

  test("the source is decided by the caller's agent id; specs are checked like a plan", async () => {
    workers([task("a"), task("b", { dependsOn: ["a"] })], { held: ["a"] });
    const { store, manager, service } = await env.boot();
    service.attachActivityProbe(manager);
    await env.createGoal(store);
    await tick();
    const remove = { ops: [{ op: "remove" as const, taskId: "b" }], reason: "not needed" };

    await expect(service.revisePlan("g1", { ...remove, agentId: "someone-else" })).rejects.toThrow(
      /Only the goal's Lead or a person/,
    );
    await expect(
      service.revisePlan("g1", {
        ops: [{ op: "add", task: task("c", { provider: "nope" }) }] as never,
        reason: "x",
      }),
    ).rejects.toThrow(/unknown provider "nope"/);
    await expect(
      service.revisePlan("g1", { ops: [{ op: "remove", taskId: "a" }], reason: "x" }),
    ).rejects.toThrow(/a is running and cannot change/);
    await expect(
      service.revisePlan("g1", { tasks: [task("c")] as never, reason: "x" }),
    ).rejects.toThrow(/missing b/);

    const leadAgentId = env.goalOf(store).leadAgentId ?? "";
    const goal = await service.revisePlan("g1", { ...remove, agentId: leadAgentId });
    // The goal auto-approves plans, so the Lead's revision applies too.
    expect(goal.planRevisions?.[0]).toMatchObject({ source: "lead", status: "applied" });
    expect(goal.tasks.map((t) => t.id)).toEqual(["a"]);
  });

  test("a Lead's revision waits for a person; its task does not start meanwhile", async () => {
    const work = workers([task("a"), task("b", { dependsOn: ["a"] })], { held: ["a"] });
    const { store, manager, service } = await env.boot();
    await env.createGoal(store, { ...CONFIG, autoApprovePlan: false });
    await env.settle(manager);
    await service.approvePlan("g1");
    await tick();

    const leadAgentId = env.goalOf(store).leadAgentId ?? "";
    const pending = await service.revisePlan("g1", {
      ops: [
        { op: "replace", task: { ...task("b", { dependsOn: ["a"] }), description: "do b2" } },
      ] as never,
      reason: "b changes",
      agentId: leadAgentId,
    });
    const revisionId = pending.planRevisions?.[0]?.id ?? "";
    expect(pending.planRevisions?.[0]).toMatchObject({ source: "lead", status: "pending" });
    // Another Lead revision must wait for this one.
    await expect(
      service.revisePlan("g1", {
        ops: [{ op: "add", task: task("c") }] as never,
        reason: "more",
        agentId: leadAgentId,
      }),
    ).rejects.toThrow(/still pending/);

    work.release();
    await env.settle(manager);
    // a finished and b is ready, but the pending revision holds it, and the goal does not end.
    const waiting = env.goalOf(store);
    expect(waiting.status).toBe("executing");
    expect(waiting.tasks.map((t) => t.status)).toEqual(["succeeded", "pending"]);
    expect(env.harness.agents.some((a) => a.labels["paseo.goal-task"] === "b")).toBe(false);
    await expect(
      store.dispatch("g1", { id: "forced", goalId: "g1", type: "task.started", taskId: "b" }),
    ).rejects.toThrow(/changed by pending revision/);

    await service.approvePlanRevision("g1", revisionId, "approve-1");
    await service.approvePlanRevision("g1", revisionId, "approve-1");
    await env.settle(manager);
    const done = env.goalOf(store);
    expect(done.status).toBe("completed");
    expect(done.tasks.find((t) => t.id === "b")?.description).toBe("do b2");
    expect(await eventsOf("plan.revision_approved")).toHaveLength(1);
  });

  test("a pending revision holds a goal that would fail; its rejection lets it fail", async () => {
    const work = workers([task("a"), task("b")], { held: ["a"], failing: ["b"] });
    const { store, manager, service } = await env.boot();
    await env.createGoal(store, { ...CONFIG, autoApprovePlan: false });
    await env.settle(manager);
    await service.approvePlan("g1");
    await until(() => failedTaskIds(store).length > 0);
    expect(env.goalOf(store).tasks.map((t) => t.status)).toEqual(["running", "failed"]);

    const leadAgentId = env.goalOf(store).leadAgentId ?? "";
    const pending = await service.revisePlan("g1", {
      ops: [{ op: "replace", task: { ...task("b"), description: "do b differently" } }] as never,
      reason: "b keeps failing",
      agentId: leadAgentId,
    });
    work.release();
    await env.settle(manager);
    expect(env.goalOf(store).status).toBe("executing");

    await service.rejectPlanRevision("g1", pending.planRevisions?.[0]?.id ?? "", "no");
    await env.settle(manager);
    const goal = env.goalOf(store);
    expect(goal.planRevisions?.[0]).toMatchObject({ status: "rejected", decisionReason: "no" });
    expect(goal.status).toBe("failed");
    expect(goal.failureReason).toMatch(/Failed or blocked: b/);
  });

  test("an auto-approval the reducer refuses is recorded as the rejection", async () => {
    const work = workers([task("a"), task("b", { dependsOn: ["a"] })], { held: ["a"] });
    const { store, manager, service } = await env.boot();
    await env.createGoal(store, { ...CONFIG, autoApprovePlan: false });
    await env.settle(manager);
    await service.approvePlan("g1");
    await tick();
    const leadAgentId = env.goalOf(store).leadAgentId ?? "";
    const pending = await service.revisePlan("g1", {
      ops: [
        { op: "replace", task: { ...task("b", { dependsOn: ["a"] }), description: "b2" } },
      ] as never,
      reason: "b changes",
      agentId: leadAgentId,
    });
    const revisionId = pending.planRevisions?.[0]?.id ?? "";

    // Turning on auto-approval approves the waiting revision, but the run limit is used up.
    await service.updateConfig("g1", { autoApprovePlan: true, limits: { maxRuns: 1 } });
    await tick();
    const revision = env.goalOf(store).planRevisions?.[0];
    expect(revision).toMatchObject({ status: "rejected" });
    expect(revision?.decisionReason).toMatch(/run limit of 1 is used up/);
    const rejected = await eventsOf("plan.revision_rejected");
    expect(rejected.map((e) => e.id)).toEqual([`g1:revision-reject:${revisionId}`]);

    work.release();
    await env.settle(manager);
    // The goal is not left waiting: b cannot run within the limit, so it fails.
    expect(env.goalOf(store).status).toBe("failed");
  });

  test("a revision proposed just before a restart is approved after it", async () => {
    workers([task("a"), task("b", { dependsOn: ["a"] })], { held: ["a"] });
    const first = await env.boot();
    await env.createGoal(first.store);
    await tick();
    first.manager.stop();
    // The Manager was not listening, as when the daemon stopped right after the proposal.
    await first.store.dispatch("g1", {
      id: "crash-proposal",
      goalId: "g1",
      type: "plan.revision_proposed",
      revisionId: "rev-crash",
      source: "person",
      reason: "add c",
      ops: [{ op: "add", task: task("c") as never }],
    });

    workers([task("a"), task("b", { dependsOn: ["a"] })]);
    const second = await env.boot();
    await env.settle(second.manager);
    const goal = env.goalOf(second.store);
    expect(goal.planRevisions?.[0]).toMatchObject({ id: "rev-crash", status: "applied" });
    expect(goal.status).toBe("completed");
    expect((await eventsOf("plan.revision_approved")).map((e) => e.id)).toEqual([
      "g1:revision-approve:rev-crash",
    ]);
  });

  test("a task that failed for good is split by the Lead and the goal completes", async () => {
    // The shape of goal aff07ea6: t7 used up its attempts while other work still ran.
    const work = workers([task("t1"), task("t7"), task("t8", { dependsOn: ["t7"] })], {
      held: ["t1"],
      failing: ["t7"],
    });
    const { store, manager, service } = await env.boot();
    service.attachActivityProbe(manager);
    await env.createGoal(store);
    await until(() => failedTaskIds(store).includes("t7"));
    expect(env.goalOf(store).tasks.map((t) => [t.id, t.status])).toEqual([
      ["t1", "running"],
      ["t7", "failed"],
      ["t8", "pending"],
    ]);

    const leadAgentId = env.goalOf(store).leadAgentId ?? "";
    const revised = await service.revisePlan("g1", {
      tasks: [task("t7a"), task("t7b"), task("t8", { dependsOn: ["t7a", "t7b"] })] as never,
      remove: ["t7"],
      reason: "t7 was too large; split it",
      agentId: leadAgentId,
    });
    expect(revised.planRevisions?.[0]).toMatchObject({ source: "lead", status: "applied" });
    expect(revised.tasks.map((t) => t.id)).toEqual(["t1", "t8", "t7a", "t7b"]);
    // The removed id stays taken while the goal runs: its runs and events derive from it.
    await expect(
      service.revisePlan("g1", { ops: [{ op: "add", task: task("t7") }] as never, reason: "x" }),
    ).rejects.toThrow(/Task id t7 was used earlier in this goal/);

    work.release();
    await env.settle(manager);
    const goal = env.goalOf(store);
    expect(goal.status).toBe("completed");
    expect(goal.tasks.every((t) => t.status === "succeeded")).toBe(true);
  });

  test("a task's own run timeout can lower the goal's but not raise it", async () => {
    env.script(
      [task("short", { runTimeoutMinutes: 1 }), task("long", { runTimeoutMinutes: 120 })],
      () => "hold",
    );
    const { store } = await env.boot();
    await env.createGoal(store, {
      ...CONFIG,
      maxAttempts: 1,
      limits: { runTimeoutMinutes: 60, retryBackoffSeconds: 0 },
    });
    await tick();

    env.clock.advance(60_001);
    const runError = (taskId: string) =>
      env.goalOf(store).runs.find((r) => r.taskId === taskId)?.error;
    await until(() => Boolean(runError("short")));
    expect(runError("short")).toBe("Turn timed out after 1 minutes");
    expect(runError("long")).toBeNull();

    env.clock.advance(59 * 60_000);
    await tick();
    expect(runError("long")).toBe("Turn timed out after 60 minutes");
  });

  test("a task changed while the pump starts another runs on its new spec", async () => {
    workers([task("t1"), task("x")], { held: ["t1", "x"] });
    const { store, service, manager } = await env.boot();
    service.attachActivityProbe(manager);
    // The pump picked t1 and x together. While t1 starts, a person moves x to another provider;
    // the revision is applied before x's turn to start comes.
    let injected = false;
    store.subscribe((_goal, event) => {
      if (injected || event.type !== "task.started" || event.taskId !== "t1") return;
      injected = true;
      void store.dispatch("g1", {
        id: "mid-pump",
        goalId: "g1",
        type: "plan.revision_proposed",
        revisionId: "rev-mid",
        source: "person",
        reason: "x on opencode",
        ops: [{ op: "replace", task: task("x", { provider: "opencode" }) as never }],
      });
    });
    await env.createGoal(store);
    await tick();

    const goal = env.goalOf(store);
    expect(goal.planRevisions?.[0]).toMatchObject({ id: "rev-mid", status: "applied" });
    expect(goal.runs.find((r) => r.taskId === "x")?.provider).toBe("opencode");
    expect(env.harness.agents.find((a) => a.labels["paseo.goal-task"] === "x")?.provider).toBe(
      "opencode",
    );
  });

  test("a failed pipeline reaction does not lose the approval", async () => {
    const work = workers([task("a"), task("b", { dependsOn: ["a"] })], { held: ["a"] });
    const { store, manager, service } = await env.boot();
    service.attachActivityProbe(manager);
    const pipeline = Reflect.get(manager, "pipeline") as { onEvent(...args: unknown[]): void };
    const onEvent = pipeline.onEvent.bind(pipeline);
    pipeline.onEvent = (goal, event) => {
      if ((event as GoalEvent).type === "plan.revision_proposed") throw new Error("pipeline bug");
      onEvent(goal, event);
    };
    await env.createGoal(store);
    await tick();

    const goal = await service.revisePlan("g1", {
      ops: [{ op: "add", task: task("c") }] as never,
      reason: "c",
    });
    expect(goal.planRevisions?.[0]?.status).toBe("applied");
    work.release();
    await env.settle(manager);
    expect(env.goalOf(store).status).toBe("completed");
  });

  test("an automatic approval that failed is retried before the reply, or reported", async () => {
    workers([task("a"), task("b", { dependsOn: ["a"] })], { held: ["a"] });
    const { store, manager, service } = await env.boot();
    service.attachActivityProbe(manager);
    await env.createGoal(store);
    await tick();
    const dispatchOrElse = store.dispatchOrElse.bind(store);
    let failures = 1;
    store.dispatchOrElse = (...args) => {
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(new Error("disk full"));
      }
      return dispatchOrElse(...args);
    };

    // The Manager's own approval fails; the service asks once more and it applies.
    const applied = await service.revisePlan("g1", {
      ops: [{ op: "add", task: task("c") }] as never,
      reason: "c",
    });
    expect(applied.planRevisions?.[0]?.status).toBe("applied");

    // Both attempts fail: the reply is an error, not a success for a change not applied.
    failures = 2;
    await expect(
      service.revisePlan("g1", { ops: [{ op: "add", task: task("d") }] as never, reason: "d" }),
    ).rejects.toThrow(/disk full/);
    expect(env.goalOf(store).planRevisions?.[1]?.status).toBe("pending");
  });
});
