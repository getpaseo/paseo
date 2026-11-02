import { describe, expect, it } from "vitest";
import type { GoalEvent } from "@getpaseo/protocol/goal/types";
import {
  budgetStatus,
  buildTaskTimeline,
  buildVerificationBar,
  burnRatePerHour,
  countGoalTasks,
  estimateRemaining,
  formatCompactCount,
  formatUsd,
  goalDeadline,
  goalRemainingRunMs,
  retryNeedsTimeMode,
  goalElapsedMs,
  goalListProgress,
  goalPercent,
  stageSamples,
  taskCompletion,
  taskDurationMs,
  taskTokens,
} from "./goal-progress";
import { makeChangeSet, makeGoal, makeRun, makeTask } from "./test-utils/goal-fixture";

const START = Date.parse("2026-10-21T00:00:00.000Z");
const MIN = 60_000;

function iso(offsetMinutes: number): string {
  return new Date(START + offsetMinutes * MIN).toISOString();
}

function finishedRun(id: string, taskId: string, from: number, to: number) {
  return makeRun(id, taskId, { status: "succeeded", startedAt: iso(from), endedAt: iso(to) });
}

describe("taskCompletion", () => {
  const task = makeTask("t1", { status: "succeeded" });

  it("counts review and merge for an implement task", () => {
    expect(taskCompletion(makeGoal(), task)).toBe(0.5);
    const reviewed = makeGoal({ changeSets: [makeChangeSet("c", "t1", { status: "approved" })] });
    expect(taskCompletion(reviewed, task)).toBe(0.75);
    const merged = makeGoal({ changeSets: [makeChangeSet("c", "t1", { status: "integrated" })] });
    expect(taskCompletion(merged, task)).toBe(1);
  });

  it("ignores superseded change sets and finishes tasks that changed nothing", () => {
    const goal = makeGoal({
      changeSets: [
        makeChangeSet("old", "t1", { status: "superseded" }),
        makeChangeSet("new", "t1", { status: "integrated" }),
      ],
    });
    expect(taskCompletion(goal, task)).toBe(1);
    expect(taskCompletion(makeGoal(), { ...task, captured: true })).toBe(1);
  });

  it("finishes read and review tasks when they succeed, and nothing else", () => {
    expect(taskCompletion(makeGoal(), { ...task, kind: "read" })).toBe(1);
    expect(taskCompletion(makeGoal(), { ...task, status: "failed" })).toBe(0);
  });
});

describe("goalPercent", () => {
  it("is zero with no tasks and 100 only when completed", () => {
    expect(goalPercent(makeGoal())).toBe(0);
    expect(goalPercent(makeGoal({ status: "completed" }))).toBe(100);
  });

  it("does not credit a plan that is not approved yet", () => {
    const goal = makeGoal({ status: "awaiting_plan_approval", tasks: [makeTask("t1")] });
    expect(goalPercent(goal)).toBe(0);
  });

  it("weights tasks, their merges and verification", () => {
    const goal = makeGoal({
      status: "executing",
      tasks: [makeTask("t1", { status: "succeeded" }), makeTask("t2", { status: "running" })],
      changeSets: [makeChangeSet("c", "t1", { status: "integrated" })],
      criteria: [{ id: "c1", text: "x", verifiedAt: null, evidence: null }],
    });
    // 5 for the plan, half of 85 for the tasks.
    expect(goalPercent(goal)).toBe(47);
  });

  it("stays below 100 when everything is done but the goal has not completed", () => {
    const goal = makeGoal({
      status: "executing",
      tasks: [makeTask("t1", { status: "succeeded", kind: "read" })],
      criteria: [{ id: "c1", text: "x", verifiedAt: iso(1), evidence: null }],
    });
    expect(goalPercent(goal)).toBe(99);
  });

  it("leaves cancelled tasks out and counts failed ones as not done", () => {
    const goal = makeGoal({
      status: "failed",
      tasks: [
        makeTask("t1", { status: "succeeded", kind: "read" }),
        makeTask("t2", { status: "failed" }),
        makeTask("t3", { status: "cancelled" }),
      ],
    });
    expect(goalPercent(goal)).toBe(47);
    expect(countGoalTasks(goal)).toEqual({
      done: 1,
      running: 0,
      remaining: 0,
      failed: 1,
      total: 2,
    });
  });
});

describe("goalListProgress", () => {
  it("uses the host's summary and computes it for a host without one", () => {
    const tasks = [
      makeTask("t1", { status: "succeeded" }),
      makeTask("t2", { status: "failed" }),
      makeTask("t3", { status: "running" }),
      makeTask("t4", { status: "cancelled" }),
    ];
    expect(goalListProgress(makeGoal({ tasks }))).toEqual({
      tasksTotal: 4,
      tasksDone: 1,
      tasksFailed: 1,
      tasksRunning: 1,
    });
    const progress = { tasksTotal: 9, tasksDone: 3, tasksFailed: 0, tasksRunning: 2 };
    expect(goalListProgress({ ...makeGoal({ tasks }), progress })).toBe(progress);
  });
});

describe("elapsed and durations", () => {
  it("freezes elapsed time when the goal ends and never goes negative", () => {
    const ended = makeGoal({ status: "completed", createdAt: iso(0), updatedAt: iso(30) });
    expect(goalElapsedMs(ended, START + 90 * MIN)).toBe(30 * MIN);
    const skewed = makeGoal({ createdAt: iso(10) });
    expect(goalElapsedMs(skewed, START)).toBe(0);
  });

  it("spans retries and runs up to now while a task runs", () => {
    const goal = makeGoal({
      runs: [
        makeRun("r1", "t1", { status: "failed", startedAt: iso(0), endedAt: iso(5) }),
        makeRun("r2", "t1", { status: "running", startedAt: iso(6) }),
      ],
    });
    expect(taskDurationMs(goal, makeTask("t1", { status: "running" }), START + 10 * MIN)).toBe(
      10 * MIN,
    );
    expect(taskDurationMs(goal, makeTask("t2"), START)).toBeNull();
  });
});

describe("estimateRemaining", () => {
  const base = {
    status: "executing" as const,
    createdAt: iso(0),
  };

  it("estimates nothing for ended, manual or unplanned goals", () => {
    expect(estimateRemaining(makeGoal({ status: "completed" }), START)).toEqual({ kind: "none" });
    expect(estimateRemaining(makeGoal({ ...base, config: null }), START)).toEqual({
      kind: "none",
    });
    expect(estimateRemaining(makeGoal(base), START)).toEqual({ kind: "none" });
  });

  it("waits for two finished tasks", () => {
    const goal = makeGoal({
      ...base,
      tasks: [makeTask("t1", { status: "succeeded" }), makeTask("t2")],
      runs: [finishedRun("r1", "t1", 0, 10)],
    });
    expect(estimateRemaining(goal, START + 20 * MIN)).toEqual({ kind: "estimating", samples: 1 });
  });

  it("says paused instead of counting down", () => {
    const goal = makeGoal({ ...base, tasks: [makeTask("t1")], pausedAt: iso(1) });
    expect(estimateRemaining(goal, START)).toEqual({ kind: "paused" });
  });

  it("spreads the fastest and slowest task over the parallelism", () => {
    const goal = makeGoal({
      ...base,
      tasks: [
        makeTask("t1", { status: "succeeded" }),
        makeTask("t2", { status: "succeeded" }),
        makeTask("t3"),
        makeTask("t4"),
        makeTask("t5", { status: "running" }),
      ],
      runs: [
        finishedRun("r1", "t1", 0, 10),
        finishedRun("r2", "t2", 0, 30),
        makeRun("r5", "t5", { startedAt: iso(30) }),
      ],
    });
    // t3 and t4 take 10 to 30 minutes each; t5 has already run 5 of them. Two at a time:
    // 12.5 to 42.5 minutes, widened to whole minutes.
    expect(estimateRemaining(goal, START + 35 * MIN)).toEqual({
      kind: "range",
      lowMs: 12 * MIN,
      highMs: 43 * MIN,
    });
  });

  it("has nothing left once every task is done", () => {
    const goal = makeGoal({
      ...base,
      tasks: [makeTask("t1", { status: "succeeded" }), makeTask("t2", { status: "succeeded" })],
      runs: [finishedRun("r1", "t1", 0, 10), finishedRun("r2", "t2", 0, 20)],
    });
    expect(estimateRemaining(goal, START + 40 * MIN)).toEqual({
      kind: "range",
      lowMs: 0,
      highMs: 0,
    });
  });
});

describe("estimateRemaining with stage times", () => {
  const base = { status: "executing" as const, createdAt: iso(0) };
  // Two finished tasks of 10 and 30 minutes, each reviewed and merged.
  const finished = {
    tasks: [makeTask("t1", { status: "succeeded" }), makeTask("t2", { status: "succeeded" })],
    runs: [finishedRun("r1", "t1", 0, 10), finishedRun("r2", "t2", 0, 30)],
  };
  const reviewedAndMerged = [
    makeChangeSet("c1", "t1", {
      status: "integrated",
      reviewStartedAt: iso(10),
      reviewedAt: iso(14),
      mergeStartedAt: iso(14),
      mergedAt: iso(15),
    }),
    makeChangeSet("c2", "t2", {
      status: "integrated",
      reviewStartedAt: iso(30),
      reviewedAt: iso(38),
      mergeStartedAt: iso(38),
      mergedAt: iso(41),
    }),
  ];

  it("samples finished reviews and merges only", () => {
    const open = makeChangeSet("c3", "t3", { status: "in_review", reviewStartedAt: iso(40) });
    expect(stageSamples({ changeSets: [...reviewedAndMerged, open] })).toEqual({
      review: [4 * MIN, 8 * MIN],
      merge: [1 * MIN, 3 * MIN],
    });
  });

  it("adds the last review, merge and verification after the open tasks", () => {
    const goal = makeGoal({
      ...base,
      tasks: [...finished.tasks, makeTask("t3")],
      runs: finished.runs,
      changeSets: reviewedAndMerged,
      criteria: [{ id: "k1", text: "Works", verifiedAt: null, evidence: null }],
    });
    // t3 alone: 10 to 30 minutes; then a review (4 to 8), a merge (1 to 3) and the
    // verification, sized like a review (4 to 8).
    expect(estimateRemaining(goal, START + 45 * MIN)).toEqual({
      kind: "range",
      lowMs: 19 * MIN,
      highMs: 49 * MIN,
    });
  });

  it("counts down the review and verification already under way", () => {
    const reviewing = makeGoal({
      ...base,
      ...finished,
      changeSets: [
        reviewedAndMerged[0]!,
        makeChangeSet("c2", "t2", { status: "in_review", reviewStartedAt: iso(30) }),
      ],
    });
    // 3 minutes into a review that takes 4 (only c1 finished): 1 left, then a 1-minute merge.
    expect(estimateRemaining(reviewing, START + 33 * MIN)).toEqual({
      kind: "range",
      lowMs: 2 * MIN,
      highMs: 2 * MIN,
    });
    const verifying = makeGoal({
      ...base,
      ...finished,
      changeSets: reviewedAndMerged,
      criteria: [{ id: "k1", text: "Works", verifiedAt: null, evidence: null }],
      verifyStartedAt: iso(41),
    });
    expect(estimateRemaining(verifying, START + 43 * MIN)).toEqual({
      kind: "range",
      lowMs: 2 * MIN,
      highMs: 6 * MIN,
    });
  });

  it("falls back to task times alone without stage times", () => {
    const goal = makeGoal({
      ...base,
      tasks: [...finished.tasks, makeTask("t3")],
      runs: finished.runs,
      changeSets: [makeChangeSet("c1", "t1", { status: "integrated" })],
      criteria: [{ id: "k1", text: "Works", verifiedAt: null, evidence: null }],
    });
    expect(estimateRemaining(goal, START + 45 * MIN)).toEqual({
      kind: "range",
      lowMs: 10 * MIN,
      highMs: 30 * MIN,
    });
  });
});

describe("goalDeadline", () => {
  it("counts down from the configured timeout", () => {
    const goal = makeGoal({
      status: "executing",
      createdAt: iso(0),
      config: { ...makeGoal().config!, limits: { goalTimeoutMinutes: 100 } },
    });
    expect(goalDeadline(goal, START + 25 * MIN)).toEqual({
      kind: "running",
      remainingMs: 75 * MIN,
      totalMs: 100 * MIN,
      usedFraction: 0.25,
    });
    expect(goalDeadline(goal, START + 110 * MIN)).toEqual({ kind: "overdue", overdueMs: 10 * MIN });
  });

  it("pushes the end back by the time spent waiting for a person, an open wait included", () => {
    const config = { ...makeGoal().config!, limits: { goalTimeoutMinutes: 100 } };
    const closed = makeGoal({
      status: "executing",
      createdAt: iso(0),
      config,
      waits: { open: {}, excludedMs: 30 * MIN, since: null },
    });
    expect(goalDeadline(closed, START + 25 * MIN)).toMatchObject({
      kind: "running",
      remainingMs: 105 * MIN,
    });
    const open = makeGoal({
      status: "executing",
      createdAt: iso(0),
      config,
      waits: { open: { a: { since: iso(20) } }, excludedMs: 30 * MIN, since: iso(20) },
    });
    // The end keeps moving while the wait is open: the remaining time does not shrink.
    expect(goalDeadline(open, START + 25 * MIN)).toMatchObject({ remainingMs: 110 * MIN });
    expect(goalDeadline(open, START + 50 * MIN)).toMatchObject({ remainingMs: 110 * MIN });
  });

  it("never pushes back an absolute deadline", () => {
    const goal = makeGoal({
      status: "executing",
      createdAt: iso(0),
      config: {
        ...makeGoal().config!,
        limits: { goalTimeoutMinutes: 100, deadlineAt: iso(60) },
      },
      waits: { open: {}, excludedMs: 30 * MIN, since: null },
    });
    expect(goalDeadline(goal, START + 25 * MIN)).toMatchObject({ remainingMs: 35 * MIN });
  });

  it("uses the daemon default and has none for ended or manual goals", () => {
    const goal = makeGoal({ status: "executing", createdAt: iso(0) });
    expect(goalDeadline(goal, START)).toMatchObject({ totalMs: 1440 * MIN });
    expect(goalDeadline(makeGoal({ status: "failed" }), START)).toEqual({ kind: "none" });
    expect(goalDeadline(makeGoal({ config: null }), START)).toEqual({ kind: "none" });
  });

  it("counts from where a retry restarted the time limit", () => {
    const goal = makeGoal({
      status: "executing",
      createdAt: iso(0),
      timeBaseAt: iso(200),
      config: { ...makeGoal().config!, limits: { goalTimeoutMinutes: 100 } },
    });
    expect(goalDeadline(goal, START + 225 * MIN)).toEqual({
      kind: "running",
      remainingMs: 75 * MIN,
      totalMs: 100 * MIN,
      usedFraction: 0.25,
    });
  });
});

describe("goalRemainingRunMs", () => {
  const event = (type: string, minutes: number, extra: Record<string, unknown> = {}) =>
    ({ id: type, goalId: "g", seq: 1, at: iso(minutes), type, ...extra }) as GoalEvent;
  const goal = makeGoal({
    status: "failed",
    createdAt: iso(0),
    config: { ...makeGoal().config!, limits: { goalTimeoutMinutes: 100 } },
  });

  it("is the limit minus the time the goal ran, leaving out pauses", () => {
    const events = [
      event("goal.created", 0),
      event("goal.paused", 30),
      event("goal.resumed", 200),
      event("goal.failed", 220),
    ];
    expect(goalRemainingRunMs(goal, events, START + 500 * MIN)).toBe(50 * MIN);
  });

  it("is used up when the goal ran the whole limit, and unknown for a manual goal", () => {
    const events = [event("goal.created", 0), event("goal.failed", 100)];
    expect(goalRemainingRunMs(goal, events, START + 500 * MIN)).toBe(0);
    expect(goalRemainingRunMs(makeGoal({ config: null }), events, START)).toBeNull();
  });
});

describe("retryNeedsTimeMode with waits", () => {
  it("is not needed while waiting time keeps the limit from passing", () => {
    const goal = makeGoal({
      status: "failed",
      createdAt: iso(0),
      config: { ...makeGoal().config!, limits: { goalTimeoutMinutes: 100 } },
      waits: { open: {}, excludedMs: 50 * MIN, since: null },
    });
    expect(retryNeedsTimeMode(goal, START + 120 * MIN)).toBe(false);
    expect(retryNeedsTimeMode({ ...goal, waits: undefined }, START + 120 * MIN)).toBe(true);
  });
});

describe("retryNeedsTimeMode", () => {
  const limited = (
    limits: { goalTimeoutMinutes: number; deadlineAt?: string },
    timeBaseAt?: string,
  ) =>
    makeGoal({
      status: "failed",
      createdAt: iso(0),
      ...(timeBaseAt ? { timeBaseAt } : {}),
      config: { ...makeGoal().config!, limits },
    });

  it("asks once the time limit has passed, from the time base when there is one", () => {
    expect(retryNeedsTimeMode(limited({ goalTimeoutMinutes: 100 }), START + 99 * MIN)).toBe(false);
    expect(retryNeedsTimeMode(limited({ goalTimeoutMinutes: 100 }), START + 100 * MIN)).toBe(true);
    expect(
      retryNeedsTimeMode(limited({ goalTimeoutMinutes: 100 }, iso(50)), START + 120 * MIN),
    ).toBe(false);
  });

  it("does not ask when an absolute deadline has passed too, or for a manual goal", () => {
    const deadlineAt = iso(150);
    expect(
      retryNeedsTimeMode(limited({ goalTimeoutMinutes: 100, deadlineAt }), START + 120 * MIN),
    ).toBe(true);
    expect(
      retryNeedsTimeMode(limited({ goalTimeoutMinutes: 100, deadlineAt }), START + 160 * MIN),
    ).toBe(false);
    expect(retryNeedsTimeMode(makeGoal({ config: null }), START + 10_000 * MIN)).toBe(false);
  });
});

describe("budgetStatus", () => {
  it("tells unreported usage apart from zero", () => {
    expect(budgetStatus(null, 100)).toEqual({ kind: "not_reported" });
    expect(budgetStatus(0, null)).toEqual({ kind: "unlimited", used: 0 });
  });

  it("measures usage against the limit and flags going over", () => {
    expect(budgetStatus(25, 100)).toEqual({
      kind: "limited",
      used: 25,
      limit: 100,
      fraction: 0.25,
      isOver: false,
    });
    expect(budgetStatus(150, 100)).toMatchObject({ fraction: 1, isOver: true });
  });

  it("computes a burn rate only with usage and time", () => {
    expect(burnRatePerHour(50, 30 * MIN)).toBe(100);
    expect(burnRatePerHour(null, 30 * MIN)).toBeNull();
    expect(burnRatePerHour(50, 0)).toBeNull();
  });
});

describe("buildTaskTimeline", () => {
  it("places each task across the goal's span", () => {
    const goal = makeGoal({
      status: "executing",
      createdAt: iso(0),
      tasks: [
        makeTask("t1", { status: "succeeded", attempts: 2 }),
        makeTask("t2", {
          status: "running",
          rework: { changeSetId: "c", reason: "review", round: 1 },
        }),
        makeTask("t3"),
      ],
      runs: [finishedRun("r1", "t1", 0, 50), makeRun("r2", "t2", { startedAt: iso(50) })],
    });
    expect(buildTaskTimeline(goal, START + 100 * MIN)).toEqual([
      {
        taskId: "t1",
        offset: 0,
        width: 0.5,
        durationMs: 50 * MIN,
        attempts: 2,
        reworkRound: null,
        stages: [],
      },
      {
        taskId: "t2",
        offset: 0.5,
        width: 0.5,
        durationMs: 50 * MIN,
        attempts: 0,
        reworkRound: 1,
        stages: [],
      },
      {
        taskId: "t3",
        offset: 0,
        width: 0,
        durationMs: null,
        attempts: 0,
        reworkRound: null,
        stages: [],
      },
    ]);
  });

  it("clamps runs that start before the goal", () => {
    const goal = makeGoal({
      status: "executing",
      createdAt: iso(10),
      tasks: [makeTask("t1", { status: "running" })],
      runs: [makeRun("r1", "t1", { startedAt: iso(0) })],
    });
    const [bar] = buildTaskTimeline(goal, START + 20 * MIN);
    expect(bar?.offset).toBe(0);
    expect(bar?.width).toBe(1);
  });
});

describe("timeline stages", () => {
  it("places review and merge windows beside the run, open ones up to now", () => {
    const goal = makeGoal({
      status: "executing",
      createdAt: iso(0),
      tasks: [makeTask("t1", { status: "succeeded" })],
      runs: [finishedRun("r1", "t1", 0, 40)],
      changeSets: [
        makeChangeSet("c1", "t1", {
          status: "integrating",
          reviewStartedAt: iso(40),
          reviewedAt: iso(60),
          mergeStartedAt: iso(60),
        }),
      ],
    });
    const [bar] = buildTaskTimeline(goal, START + 100 * MIN);
    expect(bar?.stages).toEqual([
      { kind: "review", offset: 0.4, width: 0.2, durationMs: 20 * MIN },
      { kind: "merge", offset: 0.6, width: 0.4, durationMs: 40 * MIN },
    ]);
  });

  it("leaves out a window that was cut short", () => {
    const goal = makeGoal({
      status: "executing",
      createdAt: iso(0),
      tasks: [makeTask("t1", { status: "succeeded" })],
      changeSets: [makeChangeSet("c1", "t1", { status: "superseded", reviewStartedAt: iso(10) })],
    });
    expect(buildTaskTimeline(goal, START + 20 * MIN)[0]?.stages).toEqual([]);
  });

  it("shows verification once it starts, and freezes it when it ends", () => {
    const running = makeGoal({ status: "executing", createdAt: iso(0), verifyStartedAt: iso(80) });
    const bar = buildVerificationBar(running, START + 100 * MIN);
    expect(bar).toMatchObject({ offset: 0.8, durationMs: 20 * MIN, isRunning: true });
    expect(bar?.width).toBeCloseTo(0.2);
    const done = makeGoal({
      status: "completed",
      createdAt: iso(0),
      updatedAt: iso(100),
      verifyStartedAt: iso(80),
      verifiedAt: iso(90),
    });
    expect(buildVerificationBar(done, START + 200 * MIN)).toMatchObject({
      durationMs: 10 * MIN,
      isRunning: false,
    });
    expect(buildVerificationBar(makeGoal(), START)).toBeNull();
  });
});

const USAGE = {
  inputTokens: 900,
  cachedInputTokens: 0,
  outputTokens: 100,
  totalTokens: 1000,
  costUsd: 0.5,
  reportedTurns: 2,
  totalTurns: 3,
};

describe("taskTokens", () => {
  it("sums a task's reported runs", () => {
    const goal = makeGoal({
      runs: [
        makeRun("r1", "t1", { usage: USAGE }),
        makeRun("r2", "t1", { usage: USAGE }),
        makeRun("r3", "t1"),
      ],
    });
    expect(taskTokens(goal, "t1")).toBe(2000);
    expect(taskTokens(goal, "t2")).toBeNull();
  });
});

describe("goalDeadline with an explicit deadline", () => {
  it("uses the earlier of the timeout and the deadline", () => {
    const goal = makeGoal({
      status: "executing",
      createdAt: iso(0),
      config: { ...makeGoal().config!, limits: { deadlineAt: iso(30) } },
    });
    expect(goalDeadline(goal, START + 10 * MIN)).toMatchObject({
      remainingMs: 20 * MIN,
      totalMs: 30 * MIN,
    });
  });
});

describe("formatting", () => {
  it("shortens large counts and formats dollars", () => {
    expect(formatCompactCount(950)).toBe("950");
    expect(formatCompactCount(12_340)).toBe("12.3k");
    expect(formatCompactCount(4_500_000)).toBe("4.5M");
    expect(formatCompactCount(250_000)).toBe("250k");
    expect(formatUsd(0.5)).toBe("$0.50");
    expect(formatUsd(250.4)).toBe("$250");
  });
});
