import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  type Goal,
  type GoalEvent,
  GoalEventSchema,
  type TaskSpec,
} from "@getpaseo/protocol/goal/types";
import {
  GoalTransitionError,
  MAX_INTERVENTIONS_PER_GOAL,
  MAX_NOTIFICATION_ATTEMPTS,
  MAX_PLAN_REVISIONS,
  checkInCapError,
  countedFailures,
  failureWakeUpCapError,
  NOTIFICATION_BACKOFF_MS,
  applyGoalEvent,
  replayGoal,
} from "./goal-reducer.js";
import {
  MAX_DECISION_REASON_CHARS,
  MAX_INTERVENTION_ERROR_CHARS,
  MAX_NUDGE_CHARS,
  MAX_RECOVERIES,
  MAX_WORK_SUMMARY_CHARS,
} from "@getpaseo/protocol/goal/interventions";
import { TaskGraphError, blockedTasks, readyTasks, validateTaskGraph } from "./task-graph.js";

const AT = "2026-01-01T00:00:00.000Z";

function task(id: string, dependsOn: string[] = []): TaskSpec {
  return { id, title: id, description: "", kind: "implement", dependsOn };
}

let counter = 0;
function ev(goal: Goal | null, partial: Record<string, unknown>): GoalEvent {
  counter += 1;
  return {
    id: `e${counter}`,
    goalId: "g1",
    seq: (goal?.lastSeq ?? 0) + 1,
    at: AT,
    ...partial,
  } as GoalEvent;
}

function run(events: Record<string, unknown>[]): Goal {
  let goal: Goal | null = null;
  for (const partial of events) {
    goal = applyGoalEvent(goal, ev(goal, partial));
  }
  if (!goal) throw new Error("no events");
  return goal;
}

const created = {
  type: "goal.created",
  title: "T",
  objective: "O",
  criteria: [{ id: "c1", text: "works" }],
};

describe("task graph", () => {
  test("rejects duplicate ids, unknown deps, self deps and cycles", () => {
    expect(() => validateTaskGraph([task("a"), task("a")])).toThrow(TaskGraphError);
    expect(() => validateTaskGraph([task("a", ["x"])])).toThrow(/unknown task x/);
    expect(() => validateTaskGraph([task("a", ["a"])])).toThrow(/itself/);
    expect(() => validateTaskGraph([task("a", ["b"]), task("b", ["a"])])).toThrow(/cycle/);
  });

  test("accepts a diamond", () => {
    expect(() =>
      validateTaskGraph([task("a"), task("b", ["a"]), task("c", ["a"]), task("d", ["b", "c"])]),
    ).not.toThrow();
  });

  test("readyTasks and blockedTasks follow dependency status", () => {
    const base = (id: string, deps: string[], status: string) =>
      ({ ...task(id, deps), status, attempts: 0, error: null }) as Goal["tasks"][number];
    const tasks = [
      base("a", [], "succeeded"),
      base("b", ["a"], "pending"),
      base("c", ["b"], "pending"),
      base("x", [], "failed"),
      base("y", ["x"], "pending"),
      base("z", ["y"], "pending"),
    ];
    expect(readyTasks(tasks).map((t) => t.id)).toEqual(["b"]);
    expect(blockedTasks(tasks).map((t) => t.id)).toEqual(["y", "z"]);
  });
});

describe("goal reducer", () => {
  const planned = [
    created,
    { type: "plan.proposed", tasks: [task("a"), task("b", ["a"])] },
    { type: "plan.approved" },
  ];

  test("runs a goal from creation to completion", () => {
    const goal = run([
      ...planned,
      { type: "task.started", taskId: "a" },
      { type: "task.succeeded", taskId: "a" },
      { type: "task.started", taskId: "b" },
      { type: "task.succeeded", taskId: "b" },
      { type: "criterion.verified", criterionId: "c1" },
      { type: "goal.completed" },
    ]);
    expect(goal.status).toBe("completed");
    expect(goal.lastSeq).toBe(9);
    expect(goal.criteria[0]?.verifiedAt).toBe(AT);
  });

  test("refuses to start a task whose dependency has not succeeded", () => {
    expect(() => run([...planned, { type: "task.started", taskId: "b" }])).toThrow(/not ready/);
  });

  test("refuses completion with open tasks or unverified criteria", () => {
    const running = [...planned, { type: "task.started", taskId: "a" }];
    expect(() => run([...running, { type: "goal.completed" }])).toThrow(/tasks not succeeded/);

    const allDone = [
      ...running,
      { type: "task.succeeded", taskId: "a" },
      { type: "task.started", taskId: "b" },
      { type: "task.succeeded", taskId: "b" },
    ];
    expect(() => run([...allDone, { type: "goal.completed" }])).toThrow(/criteria not verified/);
  });

  test("retry returns a failed task to pending and counts attempts", () => {
    const goal = run([
      ...planned,
      { type: "task.started", taskId: "a" },
      { type: "task.failed", taskId: "a", error: "boom" },
      { type: "task.retried", taskId: "a" },
      { type: "task.started", taskId: "a" },
    ]);
    expect(goal.tasks[0]).toMatchObject({ status: "running", attempts: 2, error: null });
  });

  test("cancel marks open tasks cancelled and rejects later events", () => {
    const goal = run([
      ...planned,
      { type: "task.started", taskId: "a" },
      { type: "goal.cancelled" },
    ]);
    expect(goal.tasks.map((t) => t.status)).toEqual(["cancelled", "cancelled"]);
    expect(() => applyGoalEvent(goal, ev(goal, { type: "plan.approved" }))).toThrow(/cancelled/);
  });

  test("failing a goal closes out running tasks and runs, and leaves pending tasks alone", () => {
    const goal = run([
      ...planned,
      { type: "task.started", taskId: "a" },
      { type: "run.started", runId: "a-a1", taskId: "a", provider: "codex" },
      { type: "goal.failed", reason: "boom" },
    ]);
    expect(goal.tasks.map((t) => t.status)).toEqual(["cancelled", "pending"]);
    expect(goal.runs.map((r) => r.status)).toEqual(["interrupted"]);
  });

  test("tracks runs apart from tasks", () => {
    const goal = run([
      ...planned,
      { type: "task.started", taskId: "a" },
      { type: "run.started", runId: "a-a1", taskId: "a", provider: "codex" },
      { type: "run.attached", runId: "a-a1", agentId: "ag", workspaceId: "ws" },
      { type: "run.finished", runId: "a-a1", outcome: "failed", error: "x" },
      { type: "task.failed", taskId: "a", error: "x" },
      { type: "task.retried", taskId: "a" },
      { type: "task.started", taskId: "a" },
      { type: "run.started", runId: "a-a2", taskId: "a", provider: "codex" },
    ]);
    expect(goal.runs.map((r) => [r.id, r.status, r.agentId, r.error])).toEqual([
      ["a-a1", "failed", "ag", "x"],
      ["a-a2", "running", null, null],
    ]);
    expect(goal.tasks[0]).toMatchObject({ status: "running", attempts: 2 });
  });

  test("a task cannot have two live runs, and a run needs a running task", () => {
    const started = [...planned, { type: "task.started", taskId: "a" }];
    const withRun = [...started, { type: "run.started", runId: "r1", taskId: "a", provider: "p" }];
    expect(() =>
      run([...withRun, { type: "run.started", runId: "r2", taskId: "a", provider: "p" }]),
    ).toThrow(/live run/);
    expect(() =>
      run([...planned, { type: "run.started", runId: "r1", taskId: "a", provider: "p" }]),
    ).toThrow(/not running/);
  });

  test("rejects plan task ids reserved for rework tasks", () => {
    expect(() => run([created, { type: "plan.proposed", tasks: [task("a-rw1")] }])).toThrow(
      /reserved for rework/,
    );
    expect(() => validateTaskGraph([task("x-rw12")])).toThrow(TaskGraphError);
  });

  test("rejects cyclic and empty plans", () => {
    expect(() =>
      run([created, { type: "plan.proposed", tasks: [task("a", ["b"]), task("b", ["a"])] }]),
    ).toThrow(GoalTransitionError);
    expect(() => run([created, { type: "plan.proposed", tasks: [] }])).toThrow(/no tasks/);
  });

  test("rejecting a plan returns to planning with no tasks", () => {
    const goal = run([
      created,
      { type: "plan.proposed", tasks: [task("a")] },
      { type: "plan.rejected", reason: "too big" },
    ]);
    expect(goal).toMatchObject({ status: "planning", tasks: [] });
  });

  test("rejects an event whose seq is not contiguous", () => {
    const goal = run([created]);
    const bad = { ...ev(goal, { type: "plan.approved" }), seq: 5 } as GoalEvent;
    expect(() => applyGoalEvent(goal, bad)).toThrow(/expected seq 2/);
  });

  test("replay of the same events yields the same state", () => {
    const events: GoalEvent[] = [];
    let goal: Goal | null = null;
    for (const partial of [
      ...planned,
      { type: "task.started", taskId: "a" },
      { type: "task.succeeded", taskId: "a" },
    ]) {
      const e = ev(goal, partial);
      goal = applyGoalEvent(goal, e);
      events.push(e);
    }
    expect(replayGoal(events)).toEqual(goal);
  });
});

describe("change set rules", () => {
  const base = [
    created,
    { type: "plan.proposed", tasks: [task("a")] },
    { type: "plan.approved" },
    { type: "task.started", taskId: "a" },
    { type: "task.succeeded", taskId: "a" },
  ];
  const captured = {
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
    headCommit: "head",
    files: [],
  };
  const moveTo = (...to: string[]) =>
    to.map((status) => ({ type: "changeset.transitioned", changeSetId: "cs1", to: status }));
  const integrationPrepared = {
    type: "integration.prepared",
    branch: "int",
    workspaceId: "wi",
    cwd: "/i",
    baseCommit: "base",
  };

  test("a change set can reach integrating only through a review verdict or a person", () => {
    const withSet = [...base, integrationPrepared, captured];
    expect(() => run([...withSet, ...moveTo("integrating")])).toThrow(/cannot go from captured/);
    expect(() => run([...withSet, ...moveTo("in_review", "integrating")])).toThrow(
      /cannot go from in_review to integrating/,
    );
    expect(() =>
      run([...withSet, ...moveTo("in_review", "awaiting_human", "integrating")]),
    ).toThrow(/cannot go from awaiting_human/);
    expect(
      run([...withSet, ...moveTo("in_review", "approved", "integrating")]).changeSets[0]?.status,
    ).toBe("integrating");
  });

  test("only a succeeded implement task can have a change set", () => {
    expect(() =>
      run([
        created,
        { type: "plan.proposed", tasks: [task("a")] },
        { type: "plan.approved" },
        captured,
      ]),
    ).toThrow(/not a succeeded implement task/);
  });

  test("integrated needs a commit and moves the integration head", () => {
    const withSet = [
      ...base,
      integrationPrepared,
      captured,
      ...moveTo("in_review", "approved", "integrating"),
    ];
    expect(() => run([...withSet, ...moveTo("integrated")])).toThrow(/integratedCommit/);
    const goal = run([
      ...withSet,
      {
        type: "changeset.transitioned",
        changeSetId: "cs1",
        to: "integrated",
        integratedCommit: "m1",
      },
    ]);
    expect(goal.integration?.headCommit).toBe("m1");
    expect(goal.changeSets[0]).toMatchObject({ status: "integrated", integratedCommit: "m1" });
  });

  test("the goal cannot complete while a change set is not integrated", () => {
    const withSet = [
      ...base,
      integrationPrepared,
      captured,
      { type: "criterion.verified", criterionId: "c1", evidence: "ok" },
    ];
    expect(() => run([...withSet, { type: "goal.completed" }])).toThrow(
      /change sets not integrated: cs1/,
    );

    const done = run([
      ...withSet,
      ...moveTo("in_review", "approved", "integrating"),
      {
        type: "changeset.transitioned",
        changeSetId: "cs1",
        to: "integrated",
        integratedCommit: "m1",
      },
      { type: "goal.completed" },
    ]);
    expect(done.status).toBe("completed");
    expect(done.criteria[0]?.evidence).toBe("ok");
  });

  test("a superseded or rejected change set keeps the reason it was fixed", () => {
    const goal = run([
      ...base,
      integrationPrepared,
      captured,
      ...moveTo("in_review", "approved", "integrating"),
      {
        type: "changeset.transitioned",
        changeSetId: "cs1",
        to: "conflicted",
        error: "Conflicts in: a.ts",
      },
      ...moveTo("superseded"),
    ]);
    expect(goal.changeSets[0]).toMatchObject({ status: "superseded", error: "Conflicts in: a.ts" });
  });

  test("a rework task needs an existing change set and a fresh id", () => {
    const withSet = [...base, integrationPrepared, captured];
    const rework = {
      type: "task.added",
      task: task("a-rw1"),
      rework: { changeSetId: "cs1", reason: "review", round: 1 },
    };
    expect(() =>
      run([...withSet, { ...rework, rework: { ...rework.rework, changeSetId: "nope" } }]),
    ).toThrow(/unknown change set/);
    expect(() => run([...withSet, rework, rework])).toThrow(/already exists/);
    expect(run([...withSet, rework]).tasks.map((t) => t.id)).toEqual(["a", "a-rw1"]);
  });

  test("a rework's change set supersedes the old one in the same step", () => {
    const withRework = [
      ...base,
      integrationPrepared,
      captured,
      ...moveTo("in_review", "changes_requested"),
      {
        type: "task.added",
        task: task("a-rw1"),
        rework: { changeSetId: "cs1", reason: "review", round: 1 },
      },
      { type: "task.started", taskId: "a-rw1" },
      { type: "task.succeeded", taskId: "a-rw1" },
    ];
    const goal = run([
      ...withRework,
      {
        ...captured,
        changeSetId: "cs2",
        taskId: "a-rw1",
        runId: "a-rw1-a1",
        round: 1,
        supersedes: "cs1",
      },
    ]);
    expect(goal.changeSets.map((c) => [c.id, c.status])).toEqual([
      ["cs1", "superseded"],
      ["cs2", "captured"],
    ]);
    expect(goal.tasks.find((t) => t.id === "a-rw1")?.captured).toBe(true);
  });

  test("a change set that is already integrated cannot be superseded", () => {
    const integrated = [
      ...base,
      integrationPrepared,
      captured,
      ...moveTo("in_review", "approved", "integrating"),
      {
        type: "changeset.transitioned",
        changeSetId: "cs1",
        to: "integrated",
        integratedCommit: "m",
      },
      {
        type: "task.added",
        task: task("a-rw1"),
        rework: { changeSetId: "cs1", reason: "review", round: 1 },
      },
      { type: "task.started", taskId: "a-rw1" },
      { type: "task.succeeded", taskId: "a-rw1" },
    ];
    expect(() =>
      run([...integrated, { ...captured, changeSetId: "cs2", taskId: "a-rw1", supersedes: "cs1" }]),
    ).toThrow(/cannot be superseded/);
  });

  test("a managed goal cannot complete while an implement task's work is uncaptured", () => {
    const managedCreated = {
      ...created,
      config: {
        cwd: "/repo",
        leadProvider: "p",
        defaultProvider: "p",
        maxParallel: 1,
        maxAttempts: 1,
        autoApprovePlan: true,
        notifyLead: false,
      },
    };
    const events = [
      managedCreated,
      { type: "plan.proposed", tasks: [task("a")] },
      { type: "plan.approved" },
      { type: "task.started", taskId: "a" },
      { type: "task.succeeded", taskId: "a" },
      { type: "criterion.verified", criterionId: "c1" },
    ];
    expect(() => run([...events, { type: "goal.completed" }])).toThrow(/work not captured for: a/);
    expect(
      run([
        ...events,
        { type: "capture.skipped", taskId: "a", runId: "a-a1" },
        { type: "goal.completed" },
      ]).status,
    ).toBe("completed");
  });

  test("a change set held for a person can be sent back or rejected, not merged", () => {
    const held = [...base, integrationPrepared, captured, ...moveTo("in_review", "awaiting_human")];
    expect(run([...held, ...moveTo("changes_requested")]).changeSets[0]?.status).toBe(
      "changes_requested",
    );
    expect(run([...held, ...moveTo("rejected")]).changeSets[0]?.status).toBe("rejected");
    expect(() => run([...held, ...moveTo("integrating")])).toThrow(/cannot go from awaiting_human/);
  });

  test("every change set transition outside the table is refused", () => {
    const allowed: Record<string, string[]> = {
      captured: ["in_review"],
      in_review: ["approved", "awaiting_human", "changes_requested", "rejected"],
      awaiting_human: ["approved", "changes_requested", "rejected"],
      approved: ["integrating"],
      integrating: ["integrated", "conflicted", "test_failed", "approved", "rejected"],
      integrated: [],
      changes_requested: ["superseded", "rejected"],
      conflicted: ["superseded", "rejected"],
      test_failed: ["superseded", "rejected"],
      superseded: [],
      rejected: [],
    };
    // Each status is reached by a legal route first, then every other target is tried.
    const route: Record<string, string[]> = {
      captured: [],
      in_review: ["in_review"],
      awaiting_human: ["in_review", "awaiting_human"],
      approved: ["in_review", "approved"],
      integrating: ["in_review", "approved", "integrating"],
      integrated: ["in_review", "approved", "integrating", "integrated"],
      changes_requested: ["in_review", "changes_requested"],
      conflicted: ["in_review", "approved", "integrating", "conflicted"],
      test_failed: ["in_review", "approved", "integrating", "test_failed"],
      superseded: ["in_review", "changes_requested", "superseded"],
      rejected: ["in_review", "rejected"],
    };
    const to = (status: string) =>
      status === "integrated"
        ? { type: "changeset.transitioned", changeSetId: "cs1", to: status, integratedCommit: "m" }
        : { type: "changeset.transitioned", changeSetId: "cs1", to: status };
    const all = Object.keys(allowed);
    for (const from of all) {
      for (const target of all) {
        const attempt = () =>
          run([...base, integrationPrepared, captured, ...route[from].map(to), to(target)]);
        if (allowed[from].includes(target)) expect(attempt, `${from} -> ${target}`).not.toThrow();
        else expect(attempt, `${from} -> ${target}`).toThrow(/cannot go from/);
      }
    }
  });
});

describe("integration retry", () => {
  const config = {
    cwd: "/repo",
    leadProvider: "claude",
    defaultProvider: "codex",
    maxParallel: 2,
    maxAttempts: 1,
    autoApprovePlan: false,
    notifyLead: false,
  };
  const csFor = (changeSetId: string, taskId: string) => ({
    type: "changeset.captured",
    changeSetId,
    taskId,
    runId: `${taskId}-r1`,
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
  // Task a's change set failed to merge; task b was running and is cancelled by the failure.
  const integrationFailed = [
    { ...created, config },
    { type: "plan.proposed", tasks: [task("a"), task("b")] },
    { type: "plan.approved" },
    {
      type: "integration.prepared",
      branch: "int",
      workspaceId: "wi",
      cwd: "/i",
      baseCommit: "base",
    },
    { type: "task.started", taskId: "a" },
    { type: "task.started", taskId: "b" },
    { type: "task.succeeded", taskId: "a" },
    csFor("cs1", "a"),
    ...move("cs1", "in_review", "awaiting_human", "approved", "integrating"),
    {
      type: "changeset.transitioned",
      changeSetId: "cs1",
      to: "rejected",
      error: "Integration failed: Integration worktree has uncommitted changes:\nM x",
      reason: "integration_failed",
    },
    { type: "goal.failed", reason: "Integrating cs1 failed" },
  ];
  const retry = (changeSetIds: string[], taskIds: string[]) => ({
    type: "changeset.integration_retried",
    changeSetIds,
    taskIds,
  });

  test("a change set whose merge failed is marked, and a retry approves it again and reopens the goal", () => {
    const failed = run(integrationFailed);
    expect(failed.changeSets[0]).toMatchObject({
      status: "rejected",
      rejectionReason: "integration_failed",
    });
    expect(failed.tasks.find((t) => t.id === "b")?.status).toBe("cancelled");

    const goal = run([...integrationFailed, retry(["cs1"], ["b"])]);
    expect(goal.status).toBe("executing");
    expect(goal.failureReason).toBeNull();
    expect(goal.reopens).toBe(1);
    expect(goal.tasks.find((t) => t.id === "b")?.status).toBe("pending");
    expect(goal.changeSets[0]?.status).toBe("approved");
    expect(goal.changeSets[0]?.error).toBeNull();
    expect(goal.changeSets[0]?.rejectionReason).toBeUndefined();
    // It merges again from approved, as any approved change set does.
    const merging = run([
      ...integrationFailed,
      retry(["cs1"], ["b"]),
      ...move("cs1", "integrating"),
    ]);
    expect(merging.changeSets[0]?.status).toBe("integrating");
  });

  test("a merge retry past the time limit chooses how it restarts, and replays the same", () => {
    // Two days later, past the default limit of a day.
    const later = new Date(Date.parse(AT) + 2 * 24 * 60 * 60_000).toISOString();
    expect(() => run([...integrationFailed, { ...retry(["cs1"], ["b"]), at: later }])).toThrow(
      /time limit has passed; choose time mode fresh/,
    );
    const events = [
      ...integrationFailed,
      { ...retry(["cs1"], ["b"]), at: later, timeMode: "remaining", activeMs: 60_000 },
    ];
    const goal = run(events);
    expect(goal.timeBaseAt).toBe(new Date(Date.parse(later) - 60_000).toISOString());
    // A log without time modes replays with no time base at all.
    expect(run(integrationFailed)).not.toHaveProperty("timeBaseAt");
    expect(run([...integrationFailed, retry(["cs1"], ["b"])])).not.toHaveProperty("timeBaseAt");
  });

  test("a reopen must cover every failed or cancelled task and every change set it leaves rejected", () => {
    expect(() => run([...integrationFailed, retry(["cs1"], [])])).toThrow(
      /every failed or cancelled task retried; missing b/,
    );
    // A goal.retried alone cannot reopen it while the change set stays rejected.
    expect(() =>
      run([...integrationFailed, { type: "goal.retried", taskIds: ["b"], reopen: true }]),
    ).toThrow(/cs1 was rejected/);
  });

  test("a change set rejected by review is not merged again", () => {
    const reviewRejected = [
      { ...created, config },
      { type: "plan.proposed", tasks: [task("a")] },
      { type: "plan.approved" },
      { type: "task.started", taskId: "a" },
      { type: "task.succeeded", taskId: "a" },
      csFor("cs1", "a"),
      ...move("cs1", "in_review"),
      {
        type: "changeset.transitioned",
        changeSetId: "cs1",
        to: "rejected",
        error: "Review failed: x",
      },
      { type: "goal.failed", reason: "rejected" },
    ];
    expect(run(reviewRejected).changeSets[0]?.rejectionReason).toBeUndefined();
    expect(() => run([...reviewRejected, retry(["cs1"], [])])).toThrow(/rejected by review/);
  });

  test("only a failed goal takes it, so a second retry is refused", () => {
    expect(() => run([...integrationFailed, retry(["cs1"], ["b"]), retry(["cs1"], ["b"])])).toThrow(
      /requires goal status failed/,
    );
    expect(() => run([...integrationFailed, retry(["nope"], ["b"])])).toThrow(
      /unknown change set nope/,
    );
  });

  test("the run limit must leave room", () => {
    const tight = integrationFailed.map((e) =>
      e.type === "goal.created" ? { ...e, config: { ...config, limits: { maxRuns: 0 } } } : e,
    );
    expect(() => run([...tight, retry(["cs1"], ["b"])])).toThrow(/run limit/);
  });

  test("a log without the reason marks a rejection out of integrating by its error text", () => {
    const legacy = integrationFailed.map((e) => {
      if (e.type !== "changeset.transitioned" || !("reason" in e)) return e;
      const { reason: _reason, ...rest } = e;
      return rest;
    });
    expect(run(legacy).changeSets[0]?.rejectionReason).toBe("integration_failed");
    expect(run([...legacy, retry(["cs1"], ["b"])]).changeSets[0]?.status).toBe("approved");
  });
});

describe("rework retry", () => {
  const config = {
    cwd: "/repo",
    leadProvider: "claude",
    defaultProvider: "codex",
    maxParallel: 2,
    maxAttempts: 1,
    maxReworkRounds: 1,
    autoApprovePlan: false,
    notifyLead: false,
  };
  const captured = (
    changeSetId: string,
    taskId: string,
    round = 0,
    supersedes: string | null = null,
  ) => ({
    type: "changeset.captured",
    changeSetId,
    taskId,
    runId: `${taskId}-a1`,
    round,
    supersedes,
    workspaceId: "ws",
    cwd: "/w",
    branch: "b",
    baseCommit: "base",
    headCommit: "head",
    files: [],
  });
  const move = (changeSetId: string, ...to: string[]) =>
    to.map((status) => ({ type: "changeset.transitioned", changeSetId, to: status }));
  const origins = {
    review: [
      ...move("cs1", "in_review"),
      {
        type: "changeset.transitioned",
        changeSetId: "cs1",
        to: "changes_requested",
        findings: "f",
      },
    ],
    conflict: move("cs1", "in_review", "approved", "integrating", "conflicted"),
    tests: move("cs1", "in_review", "approved", "integrating", "test_failed"),
  } as const;
  type Origin = keyof typeof origins;
  const failRun = (taskId: string, error: string) => [
    { type: "task.started", taskId },
    { type: "run.started", runId: `${taskId}-a1`, taskId, provider: "codex" },
    { type: "run.finished", runId: `${taskId}-a1`, outcome: "failed", error },
    { type: "task.failed", taskId, error },
  ];
  // Task a's change set waits for rework; the rework stops on a permission request, and the
  // change set is rejected as the pipeline rejects it, then the goal fails.
  const reworkFailed = (origin: Origin, reason?: string) => [
    { ...created, config },
    { type: "plan.proposed", tasks: [task("a")] },
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
    captured("cs1", "a"),
    ...origins[origin],
    {
      type: "task.added",
      task: task("a-rw1"),
      rework: { changeSetId: "cs1", reason: origin, round: 1 },
    },
    ...failRun("a-rw1", "Agent is waiting for permission to use Bash"),
    {
      type: "changeset.transitioned",
      changeSetId: "cs1",
      to: "rejected",
      error: "Rework a-rw1 failed: Agent is waiting for permission to use Bash",
      ...(reason ? { reason } : {}),
    },
    { type: "goal.failed", reason: "Rework a-rw1 failed after 1 attempts." },
  ];
  const retry = (extra: Record<string, unknown> = {}) => ({
    type: "goal.retried",
    taskIds: ["a-rw1"],
    reopen: true,
    ...extra,
  });

  test("a rejection for a failed rework is marked, also from the error text of an older log", () => {
    for (const origin of ["review", "conflict", "tests"] as const) {
      expect(run(reworkFailed(origin, "rework_failed")).changeSets[0]?.rejectionReason).toBe(
        "rework_failed",
      );
      expect(run(reworkFailed(origin)).changeSets[0]?.rejectionReason).toBe("rework_failed");
    }
  });

  test("other rejections give no retryable reason", () => {
    const rejectedWith = (error: string, from: Record<string, unknown>[], reason?: string) =>
      run([
        { ...created, config },
        { type: "plan.proposed", tasks: [task("a")] },
        { type: "plan.approved" },
        { type: "task.started", taskId: "a" },
        { type: "task.succeeded", taskId: "a" },
        captured("cs1", "a"),
        ...from,
        {
          type: "changeset.transitioned",
          changeSetId: "cs1",
          to: "rejected",
          error,
          ...(reason ? { reason } : {}),
        },
      ]).changeSets[0]?.rejectionReason;
    const waiting = origins.review;
    expect(rejectedWith("Rework limit reached after 1 rounds", waiting)).toBeUndefined();
    expect(rejectedWith("Rework limit reached after 1 rounds", waiting, "rework_limit")).toBe(
      "rework_limit",
    );
    expect(rejectedWith("Rework added no commits", waiting)).toBeUndefined();
    expect(rejectedWith("Rework task could not be added", waiting)).toBeUndefined();
    expect(rejectedWith("Review failed: x", move("cs1", "in_review"))).toBeUndefined();
    // The rework text without a rework task for the change set is not one the pipeline wrote.
    expect(rejectedWith("Rework a-rw1 failed: boom", waiting)).toBeUndefined();
    // Nor is it out of a status that does not wait for rework, even with a rework task.
    const reworkTask = {
      type: "task.added",
      task: task("a-rw1"),
      rework: { changeSetId: "cs1", reason: "review", round: 1 },
    };
    expect(
      rejectedWith("Rework a-rw1 failed: boom", [...move("cs1", "in_review"), reworkTask]),
    ).toBeUndefined();
    expect(
      rejectedWith("Rework a-rw1 failed: boom", [
        ...move("cs1", "in_review", "approved", "integrating"),
        reworkTask,
      ]),
    ).toBeUndefined();
  });

  test("a reopen sends the change set back to the status it was rejected from, and reruns its rework", () => {
    const statuses = { review: "changes_requested", conflict: "conflicted", tests: "test_failed" };
    for (const origin of ["review", "conflict", "tests"] as const) {
      const goal = run([...reworkFailed(origin), retry({ reworkChangeSetIds: ["cs1"] })]);
      expect(goal.status).toBe("executing");
      expect(goal.changeSets[0]).toMatchObject({
        status: statuses[origin],
        round: 0,
        error: null,
        cwd: "/w",
      });
      expect(goal.changeSets[0]).not.toHaveProperty("rejectionReason");
      expect(goal.tasks.find((t) => t.id === "a-rw1")).toMatchObject({
        status: "pending",
        forgivenFailures: 1,
      });
      expect(countedFailures(goal, "a-rw1")).toBe(0);
    }
    const review = run([...reworkFailed("review"), retry({ reworkChangeSetIds: ["cs1"] })]);
    expect(review.changeSets[0]?.findings).toBe("f");
    // The rework's capture supersedes the reopened change set, as on any rework.
    const reworked = run([
      ...reworkFailed("review"),
      retry({ reworkChangeSetIds: ["cs1"] }),
      { type: "task.started", taskId: "a-rw1" },
      { type: "task.succeeded", taskId: "a-rw1" },
      captured("cs2", "a-rw1", 1, "cs1"),
    ]);
    expect(reworked.changeSets.map((c) => c.status)).toEqual(["superseded", "captured"]);
  });

  test("a reopen must list every failed rework, and only failed reworks", () => {
    expect(() => run([...reworkFailed("review"), retry()])).toThrow(
      /every change set whose rework failed reworked again; missing cs1/,
    );
    // The same log, with the change set rejected at the rework limit instead.
    const limited = reworkFailed("review");
    limited.splice(-2, 1, {
      type: "changeset.transitioned",
      changeSetId: "cs1",
      to: "rejected",
      error: "Rework limit reached after 1 rounds",
      reason: "rework_limit",
    });
    expect(() => run([...limited, retry({ reworkChangeSetIds: ["cs1"] })])).toThrow(
      /cs1 is rejected \(rework_limit\); only a change set whose rework failed/,
    );
    expect(() => run([...limited, retry()])).toThrow(/cs1 was rejected/);
    // A change set rejected by review carries no reason and is refused the same way.
    const reviewRejected = reworkFailed("review");
    reviewRejected.splice(-2, 1, {
      type: "changeset.transitioned",
      changeSetId: "cs1",
      to: "rejected",
      error: "Review failed: x",
    });
    expect(() => run([...reviewRejected, retry({ reworkChangeSetIds: ["cs1"] })])).toThrow(
      /cs1 is rejected; only a change set whose rework failed/,
    );
    // Only a retry that reopens the failed goal reworks one again.
    const live = reworkFailed("review").slice(0, -1);
    expect(() => run([...live, retry({ reopen: false, reworkChangeSetIds: ["cs1"] })])).toThrow(
      /only a retry that reopens a failed goal reworks a change set again/,
    );
    expect(() => run([...reworkFailed("review"), retry({ reworkChangeSetIds: ["nope"] })])).toThrow(
      /unknown change set nope/,
    );
  });

  test("an applied recovery reworks one change set and merges another again in one event", () => {
    const both = [
      { ...created, config: { ...config, autoApprovePlan: true } },
      { type: "lead.attached", agentId: "lead-1", workspaceId: "ws-1" },
      { type: "plan.proposed", tasks: [task("a"), task("b")] },
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
      captured("cs1", "a"),
      ...origins.review,
      {
        type: "task.added",
        task: task("a-rw1"),
        rework: { changeSetId: "cs1", reason: "review", round: 1 },
      },
      ...failRun("a-rw1", "boom"),
      {
        type: "changeset.transitioned",
        changeSetId: "cs1",
        to: "rejected",
        error: "Rework a-rw1 failed: boom",
        reason: "rework_failed",
      },
      { type: "task.started", taskId: "b" },
      { type: "task.succeeded", taskId: "b" },
      captured("cs2", "b"),
      ...move("cs2", "in_review", "approved", "integrating"),
      {
        type: "changeset.transitioned",
        changeSetId: "cs2",
        to: "rejected",
        error: "Integration failed: dirty",
        reason: "integration_failed",
      },
      { type: "goal.failed", reason: "Integrating cs2 failed" },
      { type: "recovery.started", recoveryId: "r1", startedBy: "person" },
      { type: "lead.attached", agentId: "lead-r1", workspaceId: "ws-r1" },
      {
        type: "intervention.requested",
        interventionId: "recovery-r1",
        trigger: "recovery",
        error: "",
      },
      {
        type: "recovery.decided",
        recoveryId: "r1",
        decision: { decision: "retry", reason: "flaky" },
      },
    ];
    const resolved = (extra: Record<string, unknown> = {}) => ({
      type: "recovery.resolved",
      recoveryId: "r1",
      outcome: "applied",
      ...extra,
    });
    expect(() => run([...both, resolved()])).toThrow(/missing cs1/);
    const goal = run([...both, resolved({ reworkChangeSetIds: ["cs1"] })]);
    expect(goal.status).toBe("executing");
    expect(goal.changeSets.map((c) => c.status)).toEqual(["changes_requested", "approved"]);
    expect(goal.tasks.find((t) => t.id === "a-rw1")?.status).toBe("pending");
    // A recovery that ends without applying reworks nothing.
    expect(() =>
      run([...both, resolved({ outcome: "needs_person", reworkChangeSetIds: ["cs1"] })]),
    ).toThrow(/only an applied recovery reworks change sets again/);
  });
});

describe("stage times", () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
  function timed(events: Record<string, unknown>[]): Goal[] {
    const states: Goal[] = [];
    let goal: Goal | null = null;
    events.forEach((partial, index) => {
      goal = applyGoalEvent(goal, { ...ev(goal, partial), at: at(index) });
      states.push(goal);
    });
    return states;
  }
  const captured = {
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
    headCommit: "head",
    files: [],
  };
  const to = (status: string, extra: Record<string, unknown> = {}) => ({
    type: "changeset.transitioned",
    changeSetId: "cs1",
    to: status,
    ...extra,
  });
  // Managed, so the task's work must be captured before verification can start.
  const managed = {
    ...created,
    config: {
      cwd: "/repo",
      leadProvider: "claude",
      defaultProvider: "codex",
      maxParallel: 1,
      maxAttempts: 1,
      autoApprovePlan: false,
      notifyLead: false,
    },
  };
  const events = [
    managed, // 0
    { type: "plan.proposed", tasks: [task("a")] }, // 1
    { type: "plan.approved" }, // 2
    { type: "task.started", taskId: "a" }, // 3
    { type: "task.succeeded", taskId: "a" }, // 4
    captured, // 5
    to("in_review"), // 6
    to("approved"), // 7
    to("integrating"), // 8
    to("approved"), // 9: a restart interrupted the merge
    to("integrating"), // 10
    to("integrated", { integratedCommit: "m1" }), // 11
    { type: "criterion.verified", criterionId: "c1", evidence: "ok" }, // 12
    { type: "goal.completed" }, // 13
  ];

  test("review, merge and verification are timed from the events that enter and leave them", () => {
    const states = timed(events);
    const done = states.at(-1);
    expect(done?.changeSets[0]).toMatchObject({
      reviewStartedAt: at(6),
      reviewedAt: at(7),
      mergeStartedAt: at(8),
      mergedAt: at(11),
    });
    expect(done?.verifyStartedAt).toBe(at(11));
    expect(done?.verifiedAt).toBe(at(12));
    // Not set before the stage is reached.
    expect(states[5]?.changeSets[0]?.reviewStartedAt).toBeUndefined();
    expect(states[10]?.verifyStartedAt).toBeUndefined();
  });

  test("replaying the log gives the same times", () => {
    const events2: GoalEvent[] = [];
    let goal: Goal | null = null;
    events.forEach((partial, index) => {
      const event = { ...ev(goal, partial), at: at(index) };
      events2.push(event);
      goal = applyGoalEvent(goal, event);
    });
    expect(replayGoal(events2)).toEqual(goal);
  });

  test("a verdict held for a person ends the review", () => {
    const states = timed([...events.slice(0, 7), to("awaiting_human"), to("approved")]);
    expect(states.at(-1)?.changeSets[0]).toMatchObject({
      reviewStartedAt: at(6),
      reviewedAt: at(7),
    });
  });
});

describe("acknowledgement", () => {
  test("only an ended goal is acknowledged, once; its status stays", () => {
    expect(() => run([created, { type: "goal.acknowledged" }])).toThrow(/only an ended goal/);
    const goal = run([created, { type: "goal.cancelled" }, { type: "goal.acknowledged" }]);
    expect(goal.status).toBe("cancelled");
    expect(goal.acknowledgedAt).toBe(AT);
    expect(() =>
      run([
        created,
        { type: "goal.cancelled" },
        { type: "goal.acknowledged" },
        { type: "goal.acknowledged" },
      ]),
    ).toThrow(/already acknowledged/);
  });

  test("a failed goal can still be retried after it was acknowledged, which clears the mark", () => {
    const config = {
      cwd: "/repo",
      leadProvider: "claude",
      defaultProvider: "codex",
      maxParallel: 1,
      maxAttempts: 1,
      autoApprovePlan: false,
      notifyLead: false,
    };
    const goal = run([
      { ...created, config },
      { type: "plan.proposed", tasks: [task("a")] },
      { type: "plan.approved" },
      { type: "task.started", taskId: "a" },
      { type: "task.failed", taskId: "a", error: "boom" },
      { type: "goal.failed", reason: "a failed" },
      { type: "goal.acknowledged" },
      { type: "goal.retried", taskIds: ["a"], reopen: true },
    ]);
    expect(goal.status).toBe("executing");
    expect(goal.acknowledgedAt).toBeNull();
  });
});

describe("notifications", () => {
  const queued = { type: "notification.queued", target: "origin", key: "goal-ended", text: "hi" };
  const attempted = (attempt: number, outcome: "delivered" | "failed", error?: string) => ({
    type: "notification.attempted",
    target: "origin",
    key: "goal-ended",
    attempt,
    outcome,
    ...(error ? { error } : {}),
  });

  test("a new goal has none", () => {
    expect(run([created]).notifications).toEqual([]);
  });

  test("are recorded after the goal has ended, and nothing else is", () => {
    for (const ending of [{ type: "goal.cancelled" }, { type: "goal.failed", reason: "x" }]) {
      const goal = run([created, ending, queued, attempted(1, "delivered")]);
      expect(goal.notifications).toEqual([
        {
          key: "goal-ended",
          target: "origin",
          text: "hi",
          status: "delivered",
          attempts: 1,
          lastError: null,
          updatedAt: AT,
        },
      ]);
      for (const other of [
        { type: "plan.proposed", tasks: [task("a")] },
        { type: "lead.notified", key: "k" },
        { type: "criterion.verified", criterionId: "c1" },
        { type: "goal.cancelled" },
      ]) {
        expect(() => run([created, ending, other]), other.type).toThrow(/goal is/);
      }
    }
  });

  test("a failure stays pending until the last attempt, which leaves it failed", () => {
    const afterTwo = run([created, queued, attempted(1, "failed", "down"), attempted(2, "failed")]);
    expect(afterTwo.notifications?.[0]).toMatchObject({
      status: "pending",
      attempts: 2,
      lastError: "unknown error",
    });
    const failures = (n: number) =>
      Array.from({ length: n }, (_, i) => attempted(i + 1, "failed", `e${i + 1}`));
    const afterFour = run([created, queued, ...failures(4)]);
    expect(afterFour.notifications?.[0]).toMatchObject({
      status: "pending",
      attempts: 4,
      lastError: "e4",
    });
    const afterFive = run([created, queued, ...failures(5)]);
    expect(afterFive.notifications?.[0]).toMatchObject({
      status: "failed",
      attempts: 5,
      lastError: "e5",
    });
  });

  test("a notice with fewer attempts than the cap, as an older log recorded, still has attempts left", () => {
    const events = [
      created,
      queued,
      attempted(1, "failed", "a"),
      attempted(2, "failed", "b"),
      attempted(3, "failed", "c"),
    ];
    expect(run(events).notifications?.[0]).toMatchObject({ status: "pending", attempts: 3 });
    expect(run([...events, attempted(4, "delivered")]).notifications?.[0]).toMatchObject({
      status: "delivered",
      attempts: 4,
    });
  });

  test("the backoff has one wait between each pair of attempts", () => {
    expect(NOTIFICATION_BACKOFF_MS).toHaveLength(MAX_NOTIFICATION_ATTEMPTS - 1);
  });

  test("rejects a duplicate queue, an unknown notice, a skipped or extra attempt", () => {
    expect(() => run([created, queued, queued])).toThrow(/already queued/);
    expect(() => run([created, attempted(1, "delivered")])).toThrow(/unknown notification/);
    expect(() => run([created, queued, attempted(2, "failed")])).toThrow(/expected attempt 1/);
    expect(() =>
      run([created, queued, attempted(1, "delivered"), attempted(2, "delivered")]),
    ).toThrow(/is delivered/);
    expect(() =>
      run([
        created,
        queued,
        attempted(1, "failed"),
        attempted(2, "failed"),
        attempted(3, "failed"),
        attempted(4, "failed"),
        attempted(5, "failed"),
        attempted(6, "failed"),
      ]),
    ).toThrow(/is failed/);
  });

  test("the same key may be queued once per target", () => {
    const goal = run([created, queued, { ...queued, target: "lead" }]);
    expect(goal.notifications?.map((n) => n.target)).toEqual(["origin", "lead"]);
  });
});

// Shared by the plan revision tests below.
const revisionConfig = {
  cwd: "/repo",
  leadProvider: "claude",
  defaultProvider: "codex",
  maxParallel: 2,
  maxAttempts: 2,
  autoApprovePlan: false,
  notifyLead: false,
};

function apply(goal: Goal, events: Record<string, unknown>[]): Goal {
  return events.reduce((g, partial) => applyGoalEvent(g, ev(g, partial)), goal);
}

// a succeeded, b failed, c waits on b.
const executing = () =>
  run([
    { ...created, config: revisionConfig },
    { type: "plan.proposed", tasks: [task("a"), task("b"), task("c", ["b"])] },
    { type: "plan.approved" },
    { type: "task.started", taskId: "a" },
    { type: "task.succeeded", taskId: "a" },
    { type: "task.started", taskId: "b" },
    { type: "task.failed", taskId: "b", error: "boom" },
  ]);

const propose = (
  revisionId: string,
  source: string,
  ops: Record<string, unknown>[],
  extra: Record<string, unknown> = {},
) => ({ type: "plan.revision_proposed", revisionId, source, reason: "why", ops, ...extra });

const splitB = [
  { op: "replace", task: { ...task("b"), title: "smaller b" } },
  { op: "add", task: task("b2", ["b"]) },
];

describe("plan revisions", () => {
  test("a proposed revision waits, then applies its ops on approval", () => {
    const proposed = apply(executing(), [propose("r1", "lead", splitB)]);
    expect(proposed.planRevisions).toEqual([
      { id: "r1", source: "lead", reason: "why", ops: splitB, status: "pending", proposedAt: AT },
    ]);
    expect(proposed.tasks.map((t) => t.id)).toEqual(["a", "b", "c"]);

    const approved = apply(proposed, [{ type: "plan.revision_approved", revisionId: "r1" }]);
    expect(approved.planRevisions?.[0]).toMatchObject({ status: "applied", decidedAt: AT });
    expect(approved.tasks.map((t) => t.id)).toEqual(["a", "b", "c", "b2"]);
    expect(approved.tasks[1]).toMatchObject({
      title: "smaller b",
      status: "pending",
      attempts: 1,
      error: null,
    });
    // The replaced task starts again under the next attempt number.
    const started = apply(approved, [{ type: "task.started", taskId: "b" }]);
    expect(started.tasks[1]).toMatchObject({ status: "running", attempts: 2 });
  });

  test("a rejected revision changes no task and records the reason", () => {
    const rejected = apply(executing(), [
      propose("r1", "lead", splitB),
      { type: "plan.revision_rejected", revisionId: "r1", reason: "keep b" },
    ]);
    expect(rejected.planRevisions?.[0]).toMatchObject({
      status: "rejected",
      decisionReason: "keep b",
    });
    expect(rejected.tasks.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(() => apply(rejected, [{ type: "plan.revision_approved", revisionId: "r1" }])).toThrow(
      /revision r1 is rejected/,
    );
    expect(() => apply(rejected, [{ type: "plan.revision_approved", revisionId: "nope" }])).toThrow(
      /unknown revision nope/,
    );
  });

  test("a revision id is used once", () => {
    const decided = apply(executing(), [
      propose("r1", "person", splitB),
      { type: "plan.revision_rejected", revisionId: "r1", reason: "" },
    ]);
    expect(() => apply(decided, [propose("r1", "person", splitB)])).toThrow(
      /revision r1 already exists/,
    );
  });

  test("one revision is pending at a time; a person's replaces the pending one", () => {
    const pending = apply(executing(), [propose("r1", "lead", splitB)]);
    expect(() => apply(pending, [propose("r2", "lead", splitB)])).toThrow(
      /revision r1 is still pending/,
    );
    const replaced = apply(pending, [propose("r2", "person", [{ op: "remove", taskId: "c" }])]);
    expect(replaced.planRevisions?.map((r) => [r.id, r.status])).toEqual([
      ["r1", "superseded"],
      ["r2", "pending"],
    ]);
    expect(replaced.planRevisions?.[0]?.decisionReason).toBe("superseded by revision r2");
  });

  test("a task a pending revision changes cannot start", () => {
    const goal = apply(executing(), [
      { type: "task.retried", taskId: "b" },
      propose("r1", "lead", splitB),
    ]);
    expect(() => apply(goal, [{ type: "task.started", taskId: "b" }])).toThrow(
      /task b is changed by pending revision r1/,
    );
  });

  test("approval checks the revision again against the goal as it is then", () => {
    const pending = apply(executing(), [propose("r1", "lead", splitB)]);
    const lowered = apply(pending, [
      { type: "goal.config_updated", config: { ...revisionConfig, limits: { maxTasks: 3 } } },
    ]);
    expect(() => apply(lowered, [{ type: "plan.revision_approved", revisionId: "r1" }])).toThrow(
      /at most 3 are allowed/,
    );
  });

  test("refused on a manual goal, outside execution and once verification started", () => {
    const manual = run([
      created,
      { type: "plan.proposed", tasks: [task("a")] },
      { type: "plan.approved" },
    ]);
    expect(() => apply(manual, [propose("r1", "person", splitB)])).toThrow(/manual goal/);

    const planning = run([{ ...created, config: revisionConfig }]);
    expect(() => apply(planning, [propose("r1", "person", splitB)])).toThrow(
      /requires goal status executing/,
    );

    const verifying = run([
      { ...created, config: revisionConfig },
      { type: "plan.proposed", tasks: [{ ...task("a"), kind: "read" }] },
      { type: "plan.approved" },
      { type: "task.started", taskId: "a" },
      { type: "task.succeeded", taskId: "a" },
    ]);
    expect(verifying.verifyStartedAt).toBe(AT);
    expect(() =>
      apply(verifying, [propose("r1", "person", [{ op: "add", task: task("z") }])]),
    ).toThrow(/verification has started/);
  });

  test("verification waits for a pending revision, and the goal cannot complete past it", () => {
    const readOnly = [
      { ...created, config: revisionConfig },
      { type: "plan.proposed", tasks: [{ ...task("a"), kind: "read" }] },
      { type: "plan.approved" },
      { type: "task.started", taskId: "a" },
    ];
    const waiting = run([
      ...readOnly,
      propose("r1", "lead", [{ op: "add", task: task("z") }]),
      { type: "task.succeeded", taskId: "a" },
      { type: "criterion.verified", criterionId: "c1" },
    ]);
    expect(waiting).not.toHaveProperty("verifyStartedAt");
    expect(() => apply(waiting, [{ type: "goal.completed" }])).toThrow(/revision r1 is pending/);
    // A criterion verified while the revision waited would vouch for work it never saw.
    expect(() => apply(waiting, [{ type: "plan.revision_approved", revisionId: "r1" }])).toThrow(
      /verification has started/,
    );

    const rejected = apply(waiting, [
      { type: "plan.revision_rejected", revisionId: "r1", reason: "no" },
    ]);
    expect(rejected.verifyStartedAt).toBe(AT);
    expect(apply(rejected, [{ type: "goal.completed" }]).status).toBe("completed");
  });

  test("tasks a pending revision does not touch still start; removed ones do not", () => {
    const goal = apply(executing(), [
      { type: "task.retried", taskId: "b" },
      propose("r1", "lead", [
        { op: "remove", taskId: "c" },
        { op: "add", task: task("d") },
      ]),
    ]);
    expect(apply(goal, [{ type: "task.started", taskId: "b" }]).tasks[1]?.status).toBe("running");
    const bDone = apply(goal, [
      { type: "task.started", taskId: "b" },
      { type: "task.succeeded", taskId: "b" },
    ]);
    expect(() => apply(bDone, [{ type: "task.started", taskId: "c" }])).toThrow(
      /task c is changed by pending revision r1/,
    );
  });

  test("a replaced task that used every attempt gets a full set again", () => {
    const exhausted = run([
      { ...created, config: revisionConfig },
      { type: "plan.proposed", tasks: [task("a")] },
      { type: "plan.approved" },
      { type: "task.started", taskId: "a" },
      { type: "run.started", runId: "a-a1", taskId: "a", provider: "codex" },
      { type: "run.finished", runId: "a-a1", outcome: "failed", error: "x" },
      { type: "task.retried", taskId: "a" },
      { type: "task.started", taskId: "a" },
      { type: "run.started", runId: "a-a2", taskId: "a", provider: "codex" },
      { type: "run.finished", runId: "a-a2", outcome: "failed", error: "x" },
      { type: "task.failed", taskId: "a", error: "x" },
    ]);
    expect(countedFailures(exhausted, "a")).toBe(revisionConfig.maxAttempts);
    const replaced = apply(exhausted, [
      propose("r1", "lead", [{ op: "replace", task: { ...task("a"), title: "smaller a" } }]),
      { type: "plan.revision_approved", revisionId: "r1" },
    ]);
    expect(countedFailures(replaced, "a")).toBe(0);
    const started = apply(replaced, [
      { type: "task.started", taskId: "a" },
      { type: "run.started", runId: "a-a3", taskId: "a", provider: "codex" },
    ]);
    expect(started.runs.at(-1)?.id).toBe("a-a3");
  });

  test("a Lead revision proposed before an intervention opened can still be approved", () => {
    const pending = apply(executing(), [propose("r1", "lead", [{ op: "add", task: task("z") }])]);
    const woken: Goal = {
      ...pending,
      interventions: [
        {
          id: "b-a1",
          taskId: "b",
          runId: "b-a1",
          trigger: "timeout",
          error: "boom",
          status: "open",
          requestedAt: AT,
        },
      ],
    };
    const approved = apply(woken, [{ type: "plan.revision_approved", revisionId: "r1" }]);
    expect(approved.planRevisions?.[0]?.status).toBe("applied");
    expect(approved.interventions?.[0]?.status).toBe("open");
  });

  for (const end of ["goal.failed", "goal.cancelled"]) {
    test(`${end} abandons a pending revision`, () => {
      const ended = apply(executing(), [
        propose("r1", "lead", splitB),
        end === "goal.failed" ? { type: end, reason: "stop" } : { type: end },
      ]);
      expect(ended.planRevisions?.[0]).toMatchObject({ status: "abandoned", decidedAt: AT });
    });
  }

  test("a goal without revisions ends without the new fields", () => {
    const failed = apply(executing(), [{ type: "goal.failed", reason: "stop" }]);
    expect(failed).not.toHaveProperty("planRevisions");
    expect(failed).not.toHaveProperty("interventions");
  });
});

describe("plan revisions answering Lead interventions", () => {
  // Interventions are written by events added later; these rules read them when present.
  const open = (taskId: string, status = "open") => ({
    id: `${taskId}-a1`,
    taskId,
    runId: `${taskId}-a1`,
    trigger: "timeout",
    error: "boom",
    status,
    requestedAt: AT,
  });
  const woken = (...interventions: ReturnType<typeof open>[]): Goal => ({
    ...executing(),
    interventions,
  });
  const answer = (revisionId = "b-a1") =>
    propose(revisionId, "lead", splitB, { interventionId: "b-a1" });

  test("a revision answering an intervention needs it open and holds it for approval", () => {
    const awaiting = apply(woken(open("b")), [answer()]);
    expect(awaiting.interventions?.[0]).toMatchObject({
      status: "awaiting_approval",
      revisionId: "b-a1",
    });
    expect(awaiting.planRevisions?.[0]?.interventionId).toBe("b-a1");
    expect(() => apply(woken(open("b", "resolved")), [answer()])).toThrow(
      /intervention b-a1 is resolved, expected open/,
    );
    expect(() => apply(executing(), [answer()])).toThrow(/Unknown intervention b-a1/);
  });

  test("the revision must replace or remove the intervention's task", () => {
    expect(() =>
      apply(woken(open("b")), [
        propose("r1", "lead", [{ op: "add", task: task("z") }], { interventionId: "b-a1" }),
      ]),
    ).toThrow(/must replace or remove b/);
  });

  test("approval resolves the intervention as revised, rejection as revision_rejected", () => {
    const approved = apply(woken(open("b")), [
      answer(),
      { type: "plan.revision_approved", revisionId: "b-a1" },
    ]);
    expect(approved.interventions?.[0]).toMatchObject({
      status: "resolved",
      outcome: "revised",
      resolvedAt: AT,
    });
    const rejected = apply(woken(open("b")), [
      answer(),
      { type: "plan.revision_rejected", revisionId: "b-a1", reason: "no" },
    ]);
    expect(rejected.interventions?.[0]).toMatchObject({
      status: "resolved",
      outcome: "revision_rejected",
    });
  });

  test("the Lead cannot revise outside the decision prompt while one is live", () => {
    expect(() =>
      apply(woken(open("b")), [propose("r1", "lead", [{ op: "add", task: task("z") }])]),
    ).toThrow(/answer the decision prompt/);
  });

  test("an intervention about the whole goal is named as such", () => {
    const { taskId: _task, runId: _run, ...goalLevel } = open("b");
    expect(() =>
      apply({ ...executing(), interventions: [goalLevel] }, [
        propose("r1", "lead", [{ op: "add", task: task("z") }]),
      ]),
    ).toThrow(/decide about this goal; answer the decision prompt/);
  });

  test("a person's revision touching the task supersedes the intervention and its revision", () => {
    const awaiting = apply(woken(open("b")), [answer()]);
    const person = apply(awaiting, [propose("p1", "person", [{ op: "remove", taskId: "c" }])]);
    expect(person.planRevisions?.map((r) => r.status)).toEqual(["superseded", "pending"]);
    expect(person.interventions?.[0]).toMatchObject({
      status: "resolved",
      outcome: "superseded",
    });

    const touched = apply(woken(open("b")), [
      propose("p1", "person", [{ op: "replace", task: { ...task("b"), title: "mine" } }]),
    ]);
    expect(touched.interventions?.[0]).toMatchObject({
      status: "resolved",
      outcome: "superseded",
    });

    const untouched = apply(woken(open("b")), [
      propose("p1", "person", [{ op: "add", task: task("z") }]),
    ]);
    expect(untouched.interventions?.[0]?.status).toBe("open");
  });

  test("the goal ending abandons live interventions", () => {
    const failed = apply(woken(open("b"), open("c", "resolved")), [
      answer(),
      { type: "goal.failed", reason: "stop" },
    ]);
    expect(failed.interventions?.[0]).toMatchObject({ status: "abandoned", resolvedAt: AT });
    expect(failed.interventions?.[0]).not.toHaveProperty("outcome");
    expect(failed.interventions?.[1]?.status).toBe("resolved");
    expect(failed.planRevisions?.[0]?.status).toBe("abandoned");
  });
});

describe("Lead interventions", () => {
  const interventionConfig = { ...revisionConfig, maxAttempts: 3, leadInterventions: true };
  const timedOut = "Turn timed out after 90 minutes";
  const failRun = (taskId: string, attempt: number, error = "boom") => [
    { type: "task.started", taskId },
    { type: "run.started", runId: `${taskId}-a${attempt}`, taskId, provider: "codex" },
    { type: "run.finished", runId: `${taskId}-a${attempt}`, outcome: "failed", error },
    { type: "task.failed", taskId, error },
  ];
  // a runs on a-a1; b failed on b-a1; c waits on b.
  const failedB = (config: Record<string, unknown> = interventionConfig) =>
    run([
      { ...created, config },
      { type: "lead.attached", agentId: "lead-1" },
      { type: "plan.proposed", tasks: [task("a"), task("b"), task("c", ["b"])] },
      { type: "plan.approved" },
      { type: "task.started", taskId: "a" },
      { type: "run.started", runId: "a-a1", taskId: "a", provider: "codex" },
      ...failRun("b", 1, timedOut),
    ]);
  const wake = (runId: string, trigger = "timeout", extra: Record<string, unknown> = {}) => ({
    type: "intervention.requested",
    interventionId: runId,
    taskId: runId.split("-")[0],
    runId,
    trigger,
    error: "boom",
    ...extra,
  });
  const checkIn = (n: number, extra: Record<string, unknown> = {}) => ({
    type: "intervention.requested",
    interventionId: `a-a1:check-${n}`,
    taskId: "a",
    runId: "a-a1",
    trigger: "watch",
    triggers: ["near_timeout"],
    checkIn: n,
    error: "",
    ...extra,
  });
  const resolve = (id: string, outcome: string, extra: Record<string, unknown> = {}) => ({
    type: "intervention.resolved",
    interventionId: id,
    outcome,
    ...extra,
  });
  const resolved = (id: string, trigger: string, taskId = "z") => ({
    id,
    taskId,
    runId: id,
    trigger,
    error: "",
    status: "resolved",
    outcome: "continue",
    requestedAt: AT,
  });
  const smallerB = [{ op: "replace", task: { ...task("b"), title: "smaller" } }];

  test("a failure wake-up opens about the failed run, once per run", () => {
    const goal = apply(failedB(), [wake("b-a1", "timeout", { workSummary: "1 file changed" })]);
    expect(goal.interventions).toEqual([
      {
        id: "b-a1",
        taskId: "b",
        runId: "b-a1",
        trigger: "timeout",
        error: "boom",
        workSummary: "1 file changed",
        status: "open",
        requestedAt: AT,
      },
    ]);
    const decided = apply(goal, [resolve("b-a1", "continue", { note: "flaky" })]);
    expect(decided.interventions?.[0]).toMatchObject({
      status: "resolved",
      outcome: "continue",
      note: "flaky",
      resolvedAt: AT,
    });
    expect(() => apply(decided, [{ ...wake("b-a1"), interventionId: "again" }])).toThrow(
      /already woken about run b-a1/,
    );
    expect(() => apply(decided, [wake("b-a1")])).toThrow(/intervention b-a1 already exists/);
  });

  test("a wake-up needs the setting on and a Lead", () => {
    const { leadInterventions: _off, ...oldConfig } = interventionConfig;
    expect(() => apply(failedB(oldConfig), [wake("b-a1")])).toThrow(/Lead interventions are off/);
    expect(() =>
      apply(failedB({ ...interventionConfig, leadInterventions: false }), [wake("b-a1")]),
    ).toThrow(/Lead interventions are off/);
    expect(() => apply({ ...failedB(), leadAgentId: null }, [wake("b-a1")])).toThrow(
      /the goal has no Lead/,
    );
  });

  test("a failure wake-up needs a failed task, a failed run of it, and no check-in fields", () => {
    expect(() => apply(failedB(), [wake("a-a1")])).toThrow(/task a is running, expected failed/);
    expect(() => apply(failedB(), [{ ...wake("b-a1"), runId: "a-a1" }])).toThrow(
      /run a-a1 is not a run of task b/,
    );
    expect(() => apply(failedB(), [{ ...wake("b-a1"), runId: undefined }])).toThrow(
      /needs a taskId and runId/,
    );
    expect(() => apply(failedB(), [wake("b-a1", "timeout", { checkIn: 1 })])).toThrow(
      /only a check-in carries/,
    );
    const rework = failedB();
    const b = rework.tasks.findIndex((t) => t.id === "b");
    rework.tasks[b] = {
      ...rework.tasks[b]!,
      rework: { changeSetId: "cs1", reason: "review", round: 1 },
    };
    expect(() => apply(rework, [wake("b-a1")])).toThrow(/task b is a rework task/);
  });

  test("one intervention is live per goal, whatever its kind", () => {
    const failure = apply(failedB(), [wake("b-a1")]);
    expect(() => apply(failure, [checkIn(1)])).toThrow(/intervention b-a1 is still open/);
    const watching = apply(failedB(), [checkIn(1)]);
    expect(() => apply(watching, [wake("b-a1")])).toThrow(
      /intervention a-a1:check-1 is still open/,
    );
  });

  test("no intervention opens while a plan revision is pending", () => {
    const pending = apply(failedB(), [propose("r1", "lead", smallerB)]);
    expect(() => apply(pending, [wake("b-a1")])).toThrow(/revision r1 is pending/);
  });

  test("a task wakes the Lead twice at most, and once more about its last attempt", () => {
    const twice = apply(failedB(), [
      wake("b-a1"),
      resolve("b-a1", "continue"),
      { type: "task.retried", taskId: "b" },
      ...failRun("b", 2),
      wake("b-a2", "repeated_failure"),
      resolve("b-a2", "continue"),
      { type: "task.retried", taskId: "b" },
      ...failRun("b", 3),
    ]);
    expect(() => apply(twice, [wake("b-a3", "repeated_failure")])).toThrow(
      /woken 2 times about task b; the limit is 2/,
    );
    const last = apply(twice, [wake("b-a3", "attempts_exhausted")]);
    expect(last.interventions?.at(-1)).toMatchObject({ trigger: "attempts_exhausted" });
  });

  test("a goal wakes the Lead about failures four times at most; check-ins count apart", () => {
    const four = {
      ...failedB(),
      interventions: ["x1", "x2", "x3", "x4"].map((id) => resolved(id, "timeout")),
    };
    expect(() => apply(four, [wake("b-a1", "attempts_exhausted")])).toThrow(
      /woken 4 times about failed tasks; the limit is 4/,
    );
    expect(apply(four, [checkIn(1)]).interventions?.at(-1)?.status).toBe("open");
  });

  test("an intervention resolves only while open, with an outcome of its kind", () => {
    const failure = apply(failedB(), [wake("b-a1")]);
    expect(() => apply(failure, [resolve("b-a1", "ok")])).toThrow(
      /outcome ok does not resolve a failure wake-up/,
    );
    for (const outcome of ["revised", "revision_rejected", "superseded", "run_ended"]) {
      expect(() => apply(failure, [resolve("b-a1", outcome)])).toThrow(/does not resolve/);
    }
    expect(() => apply(failure, [resolve("x", "continue")])).toThrow(/unknown intervention x/);
    const gaveUp = apply(failure, [resolve("b-a1", "give_up", { note: "too big" })]);
    expect(() => apply(gaveUp, [resolve("b-a1", "continue")])).toThrow(
      /intervention b-a1 is resolved, expected open/,
    );
    const awaiting = apply(failure, [
      propose("b-a1", "lead", smallerB, { interventionId: "b-a1" }),
    ]);
    expect(() => apply(awaiting, [resolve("b-a1", "continue")])).toThrow(
      /is awaiting_approval, expected open/,
    );
  });

  test("an answering revision resolves the intervention as revised when approved", () => {
    const revised = apply(failedB(), [
      wake("b-a1"),
      propose("b-a1", "lead", smallerB, { interventionId: "b-a1" }),
      { type: "plan.revision_approved", revisionId: "b-a1" },
    ]);
    expect(revised.interventions?.[0]).toMatchObject({ status: "resolved", outcome: "revised" });
    expect(revised.tasks.find((t) => t.id === "b")?.status).toBe("pending");
  });

  test("a check-in nudge records its message; stop needs the run near its time limit", () => {
    const open = apply(failedB(), [checkIn(1)]);
    expect(() => apply(open, [resolve("a-a1:check-1", "nudged")])).toThrow(
      /message is recorded with outcome nudged only/,
    );
    expect(() => apply(open, [resolve("a-a1:check-1", "ok", { message: "hi" })])).toThrow(
      /message is recorded with outcome nudged only/,
    );
    expect(() => apply(open, [resolve("a-a1:check-1", "continue")])).toThrow(
      /does not resolve a check-in/,
    );
    const nudged = apply(open, [resolve("a-a1:check-1", "nudged", { message: "run the tests" })]);
    expect(nudged.interventions?.[0]).toMatchObject({
      outcome: "nudged",
      message: "run the tests",
    });
    expect(apply(open, [resolve("a-a1:check-1", "stopped")]).interventions?.[0]?.outcome).toBe(
      "stopped",
    );
    const stalled = apply(failedB(), [checkIn(1, { triggers: ["stall"] })]);
    expect(() => apply(stalled, [resolve("a-a1:check-1", "stopped")])).toThrow(
      /stop a run only near its time limit/,
    );
  });

  test("a check-in needs the task's live run and the next number", () => {
    const opened = apply(failedB(), [checkIn(1)]);
    expect(opened.interventions?.[0]).toMatchObject({
      trigger: "watch",
      triggers: ["near_timeout"],
      checkIn: 1,
      status: "open",
    });
    expect(() => apply(failedB(), [checkIn(2)])).toThrow(/check-in 2 on run a-a1, expected 1/);
    expect(() => apply(failedB(), [checkIn(1, { checkIn: undefined })])).toThrow(
      /without a number on run a-a1, expected 1/,
    );
    const second = apply(opened, [resolve("a-a1:check-1", "ok")]);
    expect(() => apply(second, [checkIn(1, { interventionId: "dup" })])).toThrow(
      /check-in 1 on run a-a1, expected 2/,
    );
    expect(() =>
      apply(failedB(), [checkIn(1, { taskId: "b", runId: "b-a1", interventionId: "w" })]),
    ).toThrow(/task b is failed, expected running/);
  });

  test("a check-in requested after its run ended is refused", () => {
    const ended = apply(failedB(), [
      { type: "run.finished", runId: "a-a1", outcome: "failed", error: "boom" },
    ]);
    expect(() => apply(ended, [checkIn(1)])).toThrow(/run a-a1 is failed, expected running/);
  });

  test("a run gets three check-ins at most, a goal twelve", () => {
    const three = apply(failedB(), [
      checkIn(1),
      resolve("a-a1:check-1", "ok"),
      checkIn(2),
      resolve("a-a1:check-2", "ok"),
      checkIn(3),
      resolve("a-a1:check-3", "ok"),
    ]);
    expect(() => apply(three, [checkIn(4)])).toThrow(/checked in 3 times on run a-a1/);
    const twelve = {
      ...failedB(),
      interventions: Array.from({ length: 12 }, (_, i) => resolved(`w${i}`, "watch")),
    };
    expect(() => apply(twelve, [checkIn(1)])).toThrow(/checked in 12 times; the limit is 12/);
    // Failure wake-ups have their own cap.
    expect(apply(twelve, [wake("b-a1")]).interventions?.at(-1)?.status).toBe("open");
  });

  test("the end of the run resolves an open check-in as run_ended", () => {
    for (const end of [
      { type: "run.finished", runId: "a-a1", outcome: "succeeded" },
      { type: "task.succeeded", taskId: "a" },
      { type: "task.failed", taskId: "a", error: "boom" },
    ]) {
      const goal = apply(failedB(), [checkIn(1), end]);
      expect(goal.interventions?.[0]).toMatchObject({
        status: "resolved",
        outcome: "run_ended",
        resolvedAt: AT,
      });
    }
    // A decided check-in keeps its outcome.
    const decided = apply(failedB(), [
      checkIn(1),
      resolve("a-a1:check-1", "stopped"),
      { type: "run.finished", runId: "a-a1", outcome: "failed", error: "Stopped by the Lead: x" },
    ]);
    expect(decided.interventions?.[0]?.outcome).toBe("stopped");
  });

  test("a task the Lead is deciding about is neither retried nor started", () => {
    const deciding = apply(failedB(), [wake("b-a1")]);
    expect(() => apply(deciding, [{ type: "task.retried", taskId: "b" }])).toThrow(
      /task b waits for the Lead's decision \(intervention b-a1\)/,
    );
    const pendingC: Goal = {
      ...deciding,
      interventions: [{ ...resolved("c-a1", "timeout", "c"), status: "open" }],
      tasks: [...deciding.tasks],
    };
    const b = pendingC.tasks.findIndex((t) => t.id === "b");
    pendingC.tasks[b] = { ...pendingC.tasks[b]!, status: "succeeded" };
    expect(() => apply(pendingC, [{ type: "task.started", taskId: "c" }])).toThrow(
      /task c waits for the Lead's decision/,
    );
  });

  test("after the Lead gives up, the failed run is not retried; a later run may be", () => {
    const gaveUp = apply(failedB(), [wake("b-a1"), resolve("b-a1", "give_up", { note: "no" })]);
    expect(() => apply(gaveUp, [{ type: "task.retried", taskId: "b" }])).toThrow(
      /the Lead gave up on task b \(intervention b-a1\)/,
    );
    // A person's retry wins; the next failure stands on its own.
    const again = apply(gaveUp, [
      { type: "goal.retried", taskIds: ["b"], reopen: false },
      ...failRun("b", 2),
      { type: "task.retried", taskId: "b" },
    ]);
    expect(again.tasks.find((t) => t.id === "b")?.status).toBe("pending");
  });

  test("a task is not retried while its run is live, once the goal woke the Lead", () => {
    const watched = apply(failedB(), [checkIn(1), resolve("a-a1:check-1", "ok")]);
    expect(() => apply(watched, [{ type: "task.retried", taskId: "a" }])).toThrow(
      /task a still has a live run/,
    );
    // A goal that never woke the Lead replays as before.
    const before = apply(failedB(), [{ type: "task.retried", taskId: "a" }]);
    expect(before.tasks.find((t) => t.id === "a")?.status).toBe("pending");
  });

  test("restart recovery: the run is closed first, so an open check-in ends and the task is retried", () => {
    const goal = apply(failedB(), [
      checkIn(1),
      { type: "run.finished", runId: "a-a1", outcome: "interrupted", error: "restart" },
      { type: "task.retried", taskId: "a" },
    ]);
    expect(goal.interventions?.[0]?.outcome).toBe("run_ended");
    expect(goal.tasks.find((t) => t.id === "a")?.status).toBe("pending");
  });

  test("a wake-up about an earlier run of the task is refused", () => {
    const again = apply(failedB(), [{ type: "task.retried", taskId: "b" }, ...failRun("b", 2)]);
    expect(() => apply(again, [wake("b-a1")])).toThrow(
      /run b-a1 is not the latest run of task b \(b-a2\)/,
    );
    expect(apply(again, [wake("b-a2")]).interventions?.[0]?.runId).toBe("b-a2");
  });

  test("worker_blocked is a failure trigger the reducer accepts", () => {
    const goal = apply(failedB(), [
      wake("b-a1", "worker_blocked", { error: "Worker reported it was blocked: disk full" }),
    ]);
    expect(goal.interventions?.[0]).toMatchObject({ trigger: "worker_blocked", status: "open" });
  });

  test("a trigger this version does not know is refused", () => {
    expect(() => apply(failedB(), [wake("b-a1", "audit")])).toThrow(/unknown trigger audit/);
    expect(() => apply(failedB(), [wake("b-a1", "")])).toThrow(/unknown trigger/);
  });

  test("recorded text is capped", () => {
    const long = "x".repeat(10_000);
    const goal = apply(failedB(), [
      wake("b-a1", "timeout", { error: long, workSummary: long }),
      resolve("b-a1", "continue", { note: long }),
      checkIn(1),
      resolve("a-a1:check-1", "nudged", { message: long, note: "n" }),
    ]);
    const [failure, nudge] = goal.interventions ?? [];
    expect(failure?.error).toHaveLength(MAX_INTERVENTION_ERROR_CHARS);
    expect(failure?.workSummary).toHaveLength(MAX_WORK_SUMMARY_CHARS);
    expect(failure?.note).toHaveLength(MAX_DECISION_REASON_CHARS);
    expect(failure?.note?.endsWith("…")).toBe(true);
    expect(nudge?.message).toHaveLength(MAX_NUDGE_CHARS);
  });

  test("a person's retry supersedes the intervention and the revision answering it", () => {
    const awaiting = apply(failedB(), [
      wake("b-a1"),
      propose("b-a1", "lead", smallerB, { interventionId: "b-a1" }),
    ]);
    const retried = apply(awaiting, [{ type: "goal.retried", taskIds: ["b"], reopen: false }]);
    expect(retried.interventions?.[0]).toMatchObject({
      status: "resolved",
      outcome: "superseded",
      resolvedAt: AT,
    });
    expect(retried.planRevisions?.[0]).toMatchObject({
      status: "superseded",
      decisionReason: "superseded by a person's retry",
    });
    expect(retried.tasks.find((t) => t.id === "b")?.status).toBe("pending");
  });

  test("a person's revision of the task supersedes the open intervention", () => {
    const goal = apply(failedB(), [
      wake("b-a1"),
      propose("p1", "person", [{ op: "replace", task: { ...task("b"), title: "mine" } }]),
    ]);
    expect(goal.interventions?.[0]).toMatchObject({ status: "resolved", outcome: "superseded" });
  });

  test("the goal failing or being cancelled abandons a live intervention", () => {
    for (const end of [{ type: "goal.failed", reason: "stop" }, { type: "goal.cancelled" }]) {
      const goal = apply(failedB(), [checkIn(1), end]);
      expect(goal.interventions?.[0]).toMatchObject({ status: "abandoned", resolvedAt: AT });
      expect(goal.interventions?.[0]).not.toHaveProperty("outcome");
      expect(() => apply(goal, [resolve("a-a1:check-1", "ok")])).toThrow(/goal is/);
    }
  });

  test("a failed goal with no recovery in progress takes no Lead work", () => {
    const wokenThenFailed = apply(failedB(), [wake("b-a1"), { type: "goal.failed", reason: "x" }]);
    for (const event of [
      { type: "lead.attached", agentId: "lead-2" },
      { ...wake("b-a1"), interventionId: "other" },
      { ...wake("b-a1"), interventionId: "goal-level", taskId: undefined, runId: undefined },
      resolve("b-a1", "continue"),
      { type: "usage.recorded", role: "lead", agentId: "lead-1" },
    ]) {
      expect(() => apply(wokenThenFailed, [event])).toThrow(/goal is failed/);
    }
    const reopened = apply(wokenThenFailed, [
      { type: "goal.retried", taskIds: ["a", "b"], reopen: true },
    ]);
    expect(reopened.status).toBe("executing");
  });

  test("an open intervention still resolves after the setting is switched off", () => {
    const off = apply(failedB(), [
      checkIn(1),
      { type: "goal.config_updated", config: { ...interventionConfig, leadInterventions: false } },
      resolve("a-a1:check-1", "expired"),
    ]);
    expect(off.interventions?.[0]?.outcome).toBe("expired");
  });
});

describe("recovery", () => {
  const T0 = Date.parse(AT);
  const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
  const recoveryConfig = {
    ...revisionConfig,
    maxAttempts: 5,
    autoApprovePlan: true,
    limits: { goalTimeoutMinutes: 60 },
  };
  const fail = (taskId: string, attempt: number, error = "boom", when = AT) => [
    { type: "task.started", taskId, at: when },
    { type: "run.started", runId: `${taskId}-a${attempt}`, taskId, provider: "codex", at: when },
    {
      type: "run.finished",
      runId: `${taskId}-a${attempt}`,
      outcome: "failed",
      error,
      at: when,
    },
    { type: "task.failed", taskId, error, at: when },
  ];
  // a succeeded, b failed twice, c waits on b; the goal failed ten minutes in.
  const failed = (config: Record<string, unknown> = recoveryConfig) =>
    run([
      { ...created, config },
      { type: "lead.attached", agentId: "lead-1", workspaceId: "ws-1" },
      { type: "plan.proposed", tasks: [task("a"), task("b"), task("c", ["b"])] },
      { type: "plan.approved" },
      { type: "task.started", taskId: "a" },
      { type: "task.succeeded", taskId: "a" },
      ...fail("b", 1),
      { type: "task.retried", taskId: "b" },
      ...fail("b", 2, "Turn timed out after 30 minutes"),
      {
        type: "goal.failed",
        reason: "No task can make progress. Failed or blocked: b, c",
        at: at(10),
      },
    ]);
  const start = (extra: Record<string, unknown> = {}) => ({
    type: "recovery.started",
    recoveryId: "r1",
    startedBy: "person",
    at: at(20),
    ...extra,
  });
  const attach = { type: "lead.attached", agentId: "lead-r1", workspaceId: "ws-r1", at: at(20) };
  const ask = {
    type: "intervention.requested",
    interventionId: "recovery-r1",
    trigger: "recovery",
    error: "",
    at: at(20),
  };
  const decide = (decision: Record<string, unknown>, when = at(25)) => ({
    type: "recovery.decided",
    recoveryId: "r1",
    decision,
    at: when,
  });
  const resolveAs = (outcome: string, extra: Record<string, unknown> = {}) => ({
    type: "recovery.resolved",
    recoveryId: "r1",
    outcome,
    at: at(26),
    ...extra,
  });
  const deciding = (config?: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    apply(failed(config), [start(extra), attach, ask]);
  const retry = { decision: "retry", reason: "flaky", hints: { b: "use the cache" } };
  const removeC = {
    decision: "revise",
    reason: "c is not needed",
    ops: [{ op: "remove", taskId: "c" }],
  };

  test("the recovery Lead may wait for an answer while it decides; a plain failed goal takes no wait", () => {
    const more = (goal: Goal, events: Record<string, unknown>[]) =>
      events.reduce((g, partial) => applyGoalEvent(g, ev(g, partial)), goal);
    const leadWait = { type: "wait.started", agentId: "lead-r1", role: "lead", at: at(21) };
    expect(() => more(failed(), [leadWait])).toThrow(/goal is failed/);
    const leadDeciding = more(failed(), [start(), attach, ask, leadWait]);
    expect(leadDeciding.waits).toEqual({
      open: { "lead-r1": { since: at(21) } },
      excludedMs: 0,
      since: at(21),
    });
    const answered = more(leadDeciding, [
      { type: "wait.ended", agentId: "lead-r1", outcome: "answered", at: at(24) },
    ]);
    expect(answered.waits).toEqual({ open: {}, excludedMs: 3 * 60_000, since: null });
  });

  test("goal.failed records when the goal failed", () => {
    expect(failed().failedAt).toBe(at(10));
  });

  test("a recovery starts deciding on a failed goal and changes no work", () => {
    const goal = failed();
    const started = apply(goal, [
      start({ guidance: { goal: "keep the API", tasks: { b: "skip the flaky test" } } }),
    ]);
    expect(started.status).toBe("failed");
    expect(started.recovery).toEqual({
      id: "r1",
      status: "deciding",
      startedAt: at(20),
      startedBy: "person",
      failureReason: "No task can make progress. Failed or blocked: b, c",
      failedAt: at(10),
    });
    expect(started.guidance).toEqual({ goal: "keep the API", tasks: { b: "skip the flaky test" } });
    expect(started.tasks).toEqual(goal.tasks);
    expect(started.runs).toEqual(goal.runs);
    expect(started.failureReason).toBe(goal.failureReason);
  });

  test("a recovery starts only on a failed managed goal with a plan, one at a time", () => {
    const live = run([
      { ...created, config: recoveryConfig },
      { type: "plan.proposed", tasks: [task("a")] },
      { type: "plan.approved" },
    ]);
    expect(() => apply(live, [start()])).toThrow(/goal is executing/);
    const planningFailure = run([
      { ...created, config: recoveryConfig },
      { type: "goal.failed", reason: "no plan" },
    ]);
    expect(() => apply(planningFailure, [start()])).toThrow(/failed before it had a plan/);
    const manual = run([
      created,
      { type: "plan.proposed", tasks: [task("a")] },
      { type: "plan.approved" },
      { type: "goal.failed", reason: "x" },
    ]);
    expect(() => apply(manual, [start()])).toThrow(/manual goal/);
    const archived = apply(failed(), [{ type: "goal.archived" }]);
    expect(() => apply(archived, [start()])).toThrow(/archived/);
    const open = apply(failed(), [start()]);
    expect(() => apply(open, [{ ...start(), recoveryId: "r2" }])).toThrow(
      /recovery r1 is still deciding/,
    );
  });

  test("a recovery is refused once MAX_RECOVERIES counted, or when its id was used", () => {
    expect(() => apply({ ...failed(), recoveries: MAX_RECOVERIES }, [start()])).toThrow(
      `already recovered ${MAX_RECOVERIES} times`,
    );
    expect(apply({ ...failed(), recoveries: MAX_RECOVERIES - 1 }, [start()]).recovery?.status).toBe(
      "deciding",
    );
    const ended = apply(failed(), [start(), resolveAs("cancelled")]);
    expect(() => apply(ended, [start()])).toThrow(/recovery id r1 was already used/);
    const revised = {
      ...failed(),
      planRevisions: [
        { id: "r1", source: "lead", reason: "x", ops: [], status: "applied", proposedAt: AT },
      ],
    };
    expect(() => apply(revised, [start()])).toThrow(/recovery id r1 was already used/);
  });

  test("a recovery is refused when a change set was rejected by review, or nothing can run", () => {
    const goal = failed();
    const rejected: Goal = {
      ...goal,
      changeSets: [
        {
          id: "cs-a",
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
          status: "rejected",
          findings: null,
          testSummary: null,
          integratedCommit: null,
          error: null,
          createdAt: AT,
          updatedAt: AT,
        },
      ],
    };
    expect(() => apply(rejected, [start()])).toThrow(/cs-a was rejected by review/);
    const runsUsed: Goal = {
      ...goal,
      config: { ...goal.config!, limits: { goalTimeoutMinutes: 60, maxRuns: 2 } },
    };
    expect(() => apply(runsUsed, [start()])).toThrow(/run limit of 2 is used up/);
    const spent: Goal = {
      ...goal,
      config: { ...goal.config!, limits: { goalTimeoutMinutes: 60, maxCostUsd: 1 } },
      usage: {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 2,
        reportedTurns: 1,
        totalTurns: 1,
      },
    };
    expect(() => apply(spent, [start()])).toThrow(/Cost budget/);
  });

  test("past the time limit a recovery must choose a valid time mode", () => {
    const late = at(90);
    expect(() => apply(failed(), [start({ at: late })])).toThrow(/time limit has passed/);
    expect(() => apply(failed(), [start({ at: late, timeMode: "soon" })])).toThrow(
      /unknown time mode soon/,
    );
    expect(() => apply(failed(), [start({ at: late, timeMode: "remaining" })])).toThrow(
      /needs activeMs/,
    );
    expect(() =>
      apply(failed(), [start({ at: late, timeMode: "remaining", activeMs: 60 * 60_000 })]),
    ).toThrow(/no time is left/);
    const fresh = apply(failed(), [start({ at: late, timeMode: "fresh" })]);
    expect(fresh.recovery).toMatchObject({ status: "deciding", timeMode: "fresh" });
    // The time base moves only when the recovery applies.
    expect(fresh).not.toHaveProperty("timeBaseAt");
    const remaining = apply(failed(), [
      start({ at: late, timeMode: "remaining", activeMs: 10 * 60_000 }),
    ]);
    expect(remaining.recovery).toMatchObject({ timeMode: "remaining", activeMs: 10 * 60_000 });
    const base = failed();
    const passedDeadline: Goal = {
      ...base,
      config: {
        ...base.config!,
        limits: { goalTimeoutMinutes: 60, deadlineAt: at(15) },
      },
    };
    expect(() => apply(passedDeadline, [start({ timeMode: "fresh" })])).toThrow(
      /deadline .* has passed/,
    );
  });

  test("a failed goal takes the Lead and its prompt only while a recovery decides", () => {
    const goal = failed();
    expect(() => apply(goal, [attach])).toThrow(/goal is failed/);
    expect(() => apply(goal, [ask])).toThrow(/goal is failed/);
    expect(() =>
      apply(goal, [{ type: "usage.recorded", role: "lead", agentId: "lead-1" }]),
    ).toThrow(/goal is failed/);
    const started = apply(goal, [start()]);
    const attached = apply(started, [attach]);
    expect(attached).toMatchObject({ leadAgentId: "lead-r1", leadWorkspaceId: "ws-r1" });
    expect(attached.recovery).toMatchObject({ leadAgentId: "lead-r1", leadWorkspaceId: "ws-r1" });
    const used = apply(attached, [{ type: "usage.recorded", role: "lead", agentId: "lead-r1" }]);
    expect(used.usageByRole?.lead?.totalTurns).toBe(1);
    for (const event of [
      { type: "usage.recorded", role: "worker", agentId: "w", runId: "b-a2" },
      { type: "task.retried", taskId: "b" },
      { ...ask, trigger: "timeout", taskId: "b", runId: "b-a2", interventionId: "b-a2" },
      {
        type: "plan.revision_proposed",
        revisionId: "x",
        source: "person",
        reason: "r",
        ops: removeC.ops,
      },
    ]) {
      expect(() => apply(attached, [event])).toThrow(/goal is failed/);
    }
    const decided = apply(attached, [ask, decide(retry)]);
    expect(() => apply(decided, [{ ...attach, agentId: "other" }])).toThrow(/goal is failed/);
  });

  test("the Lead's late usage is accepted after the recovery ended", () => {
    const ended = apply(deciding(), [resolveAs("cancelled")]);
    const late = apply(ended, [{ type: "usage.recorded", role: "lead", agentId: "lead-r1" }]);
    expect(late.usage?.totalTurns).toBe(1);
  });

  test("the recovery prompt is one per recovery, about the goal, and needs no leadInterventions", () => {
    const { leadInterventions: _off, ...config } = { ...recoveryConfig, leadInterventions: true };
    const started = apply(failed(config), [start()]);
    expect(() => apply(started, [ask])).toThrow(/recovery r1 has no Lead yet/);
    const asked = apply(started, [attach, ask]);
    expect(asked.interventions?.at(-1)).toEqual({
      id: "recovery-r1",
      trigger: "recovery",
      error: "",
      status: "open",
      requestedAt: at(20),
    });
    expect(asked.recovery?.interventionId).toBe("recovery-r1");
    expect(() => apply(asked, [{ ...ask, interventionId: "again" }])).toThrow(
      /intervention recovery-r1 is still open/,
    );
    const closed: Goal = {
      ...asked,
      interventions: [{ ...asked.interventions![0]!, status: "abandoned" }],
    };
    expect(() => apply(closed, [{ ...ask, interventionId: "again" }])).toThrow(
      /already asked its Lead/,
    );
    const attached = apply(started, [attach]);
    expect(() => apply(attached, [{ ...ask, taskId: "b" }])).toThrow(/about the goal, not a task/);
    expect(() => apply(attached, [{ ...ask, checkIn: 1 }])).toThrow(/no check-in fields/);
  });

  test("intervention.resolved never decides a recovery", () => {
    const goal = deciding();
    expect(() =>
      apply(goal, [
        { type: "intervention.resolved", interventionId: "recovery-r1", outcome: "decided" },
      ]),
    ).toThrow(/goal is failed/);
  });

  test("a retry decision resolves the prompt and waits to be applied", () => {
    const decided = apply(deciding(), [decide(retry)]);
    expect(decided.recovery).toMatchObject({
      status: "decided",
      decision: retry,
      decidedAt: at(25),
      counted: true,
    });
    expect(decided.interventions?.at(-1)).toMatchObject({
      status: "resolved",
      outcome: "decided",
      resolvedAt: at(25),
    });
    expect(decided.status).toBe("failed");
    expect(() => apply(decided, [decide(retry)])).toThrow(
      /recovery r1 is decided, expected deciding/,
    );
  });

  test("a fallback decision does not count", () => {
    const fallback = apply(deciding(), [
      decide({ decision: "retry", reason: "no answer", fallback: true }),
    ]);
    expect(fallback.recovery?.counted).toBe(false);
    const applied = apply(fallback, [resolveAs("applied")]);
    expect(applied).not.toHaveProperty("recoveries");
  });

  test("a revise waits for a person unless plans approve on their own", () => {
    const auto = apply(deciding(), [decide(removeC)]);
    expect(auto.recovery?.status).toBe("decided");
    const held = apply(deciding({ ...recoveryConfig, autoApprovePlan: false }), [decide(removeC)]);
    expect(held.recovery?.status).toBe("awaiting_approval");
  });

  test("a decision is checked against the goal", () => {
    const goal = deciding();
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ decision: "unrecoverable", reason: "x" }, /Unknown decision "unrecoverable"/],
      [{ ...retry, ops: removeC.ops }, /retry decision carries no ops/],
      [{ decision: "revise", reason: "x" }, /revise decision needs ops/],
      [{ decision: "retry", reason: "x", hints: { a: "redo" } }, /a is succeeded/],
      [{ decision: "retry", reason: "x", hints: { z: "redo" } }, /z is not a task/],
      [{ decision: "retry", reason: "x", hints: { b: "x".repeat(1001) } }, /limit is 1000/],
      [{ decision: "needs_person", reason: "x", hints: { b: "y" } }, /carries no hints/],
      [
        { decision: "revise", reason: "x", ops: [{ op: "remove", taskId: "a" }] },
        /a is succeeded and cannot change/,
      ],
    ];
    for (const [decision, error] of cases) {
      expect(() => apply(goal, [decide(decision)])).toThrow(error);
    }
    expect(
      apply(goal, [decide({ ...retry, hints: { b: "x".repeat(1000) } })]).recovery?.status,
    ).toBe("decided");
  });

  test("after verification started a recovery may still replace or add tasks", () => {
    const goal = { ...deciding(), verifyStartedAt: AT };
    const replaceB = {
      decision: "revise",
      reason: "x",
      ops: [{ op: "replace", task: { ...task("b"), title: "smaller" } }],
    };
    expect(apply(goal, [decide(replaceB)]).recovery?.status).toBe("decided");
    expect(apply(goal, [decide(removeC)]).recovery?.status).toBe("decided");
  });

  test("a Lead's needs_person ends the recovery, counted, and the goal stays failed", () => {
    const ended = apply(deciding(), [
      decide({ decision: "needs_person", reason: "raise maxRuns" }),
    ]);
    expect(ended.status).toBe("failed");
    expect(ended.failureReason).toBe("Recovery needs a person: raise maxRuns");
    expect(ended.failedAt).toBe(at(25));
    expect(ended.recoveries).toBe(1);
    expect(ended.recovery).toMatchObject({
      status: "ended",
      outcome: "needs_person",
      reason: "raise maxRuns",
      failureReason: "No task can make progress. Failed or blocked: b, c",
    });
    // A pre-check failure is recorded as a fallback and does not count.
    const precheck = apply(failed(), [
      start(),
      decide({ decision: "needs_person", reason: "worktree is dirty", fallback: true }),
    ]);
    expect(precheck.recovery?.status).toBe("ended");
    expect(precheck).not.toHaveProperty("recoveries");
    // The next recovery keeps the reason the goal first failed with.
    const next = apply(ended, [{ ...start(), recoveryId: "r2" }]);
    expect(next.recovery?.failureReason).toBe("No task can make progress. Failed or blocked: b, c");
  });

  test("an applied retry reopens the goal in one step", () => {
    const goal = { ...failed(), acknowledgedAt: at(15) };
    const applied = apply(goal, [start(), attach, ask, decide(retry), resolveAs("applied")]);
    expect(applied).toMatchObject({
      status: "executing",
      failureReason: null,
      failedAt: at(10),
      reopens: 1,
      acknowledgedAt: null,
      recoveries: 1,
      leadAgentId: "lead-r1",
    });
    expect(applied.recovery).toMatchObject({
      status: "applied",
      outcome: "applied",
      resolvedAt: at(26),
    });
    expect(applied.tasks.map((t) => [t.id, t.status, t.forgivenFailures])).toEqual([
      ["a", "succeeded", undefined],
      ["b", "pending", 2],
      ["c", "pending", undefined],
    ]);
    expect(countedFailures(applied, "b")).toBe(0);
    expect(applied.guidance).toEqual({ lead: { recoveryId: "r1", tasks: { b: "use the cache" } } });
    expect(applied.planRevisions).toBeUndefined();
  });

  test("an applied recovery merges change sets whose integration failed again", () => {
    const goal = failed();
    const withFailedMerge: Goal = {
      ...goal,
      changeSets: [
        {
          id: "cs-a",
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
          status: "rejected",
          rejectionReason: "integration_failed",
          findings: null,
          testSummary: null,
          integratedCommit: null,
          error: "Integration failed: dirty",
          createdAt: AT,
          updatedAt: AT,
        },
      ],
    };
    const applied = apply(withFailedMerge, [
      start(),
      attach,
      ask,
      decide(retry),
      resolveAs("applied"),
    ]);
    expect(applied.changeSets[0]).toMatchObject({ status: "approved", error: null });
    expect(applied.changeSets[0]).not.toHaveProperty("rejectionReason");
  });

  test("the time limit restarts when the recovery applies, from that event's time", () => {
    const late = at(90);
    const fresh = apply(failed(), [
      start({ at: late, timeMode: "fresh" }),
      attach,
      ask,
      decide(retry),
      resolveAs("applied", { timeMode: "fresh", at: at(100) }),
    ]);
    expect(fresh.timeBaseAt).toBe(at(100));
    // A slow approval: applied three hours after the recovery started, the goal still gets
    // the 50 minutes it had left.
    const slow = apply(failed({ ...recoveryConfig, autoApprovePlan: false }), [
      start({ at: late, timeMode: "remaining", activeMs: 10 * 60_000 }),
      attach,
      ask,
      decide(removeC, at(95)),
      resolveAs("applied", { timeMode: "remaining", activeMs: 10 * 60_000, at: at(270) }),
    ]);
    expect(slow.timeBaseAt).toBe(at(260));
    expect(Date.parse(slow.timeBaseAt!) + 60 * 60_000 - Date.parse(at(270))).toBe(50 * 60_000);
  });

  test("the applied event carries the recovery's time mode and active time", () => {
    const goal = apply(failed(), [start({ timeMode: "fresh" }), attach, ask, decide(retry)]);
    expect(() => apply(goal, [resolveAs("applied")])).toThrow(
      /must be the ones the recovery started/,
    );
    expect(() =>
      apply(goal, [resolveAs("applied", { timeMode: "remaining", activeMs: 1 })]),
    ).toThrow(/must be the ones the recovery started/);
  });

  test("only a needs_person outcome can be uncounted", () => {
    const goal = apply(failed(), [start({ timeMode: "fresh" }), attach, ask, decide(retry)]);
    expect(() =>
      apply(goal, [resolveAs("applied", { timeMode: "fresh", uncounted: false })]),
    ).toThrow(/only a needs_person outcome can be uncounted/);
    const held = apply(deciding({ ...recoveryConfig, autoApprovePlan: false }), [decide(removeC)]);
    for (const outcome of ["rejected", "cancelled"]) {
      expect(() => apply(held, [resolveAs(outcome, { uncounted: true })])).toThrow(
        /only a needs_person outcome can be uncounted/,
      );
    }
  });

  test("a limit that runs out while the Lead decides needs a time mode, or a later deadline", () => {
    // 60-minute limit: at minute 45 the Lead's 20 minutes would outlast it.
    expect(() => apply(failed(), [start({ at: at(45) })])).toThrow(
      /the Lead has 20 minutes to decide, and by then the goal's time limit has passed; choose time mode/,
    );
    expect(apply(failed(), [start({ at: at(45), timeMode: "fresh" })]).recovery?.status).toBe(
      "deciding",
    );
    expect(apply(failed(), [start({ at: at(39) })]).recovery?.status).toBe("deciding");
    const base = failed();
    const deadline: Goal = {
      ...base,
      config: { ...base.config!, limits: { goalTimeoutMinutes: 600, deadlineAt: at(35) } },
    };
    expect(() => apply(deadline, [start({ timeMode: "fresh" })])).toThrow(
      /deadline .* passes within the Lead's 20 minutes to decide; set a later deadline/,
    );
  });

  test("a recovery keeps the reason and time the goal first failed with", () => {
    const ended = apply(deciding(), [decide({ decision: "needs_person", reason: "x" })]);
    expect(ended.failedAt).toBe(at(25));
    expect(ended.recovery).toMatchObject({
      failureReason: expect.stringContaining("No task"),
      failedAt: at(10),
    });
    const next = apply(ended, [{ ...start(), recoveryId: "r2", at: at(30) }]);
    expect(next.recovery).toMatchObject({ failedAt: at(10) });
  });

  test("a criterion verified before keeps its result through a retry or a revise that only removes", () => {
    const goal = deciding();
    const verified: Goal = {
      ...goal,
      criteria: [{ ...goal.criteria[0]!, verifiedAt: AT, evidence: "ok" }],
    };
    for (const decision of [retry, removeC]) {
      const applied = apply(verified, [decide(decision), resolveAs("applied")]);
      expect(applied.status).toBe("executing");
      expect(applied.criteria[0]).toMatchObject({ verifiedAt: AT, evidence: "ok" });
      expect(applied).not.toHaveProperty("verificationRound");
    }
    // A revise that adds work clears it and starts round 1.
    const added = apply(verified, [
      decide({ decision: "revise", reason: "x", ops: [{ op: "add", task: task("d") }] }),
      resolveAs("applied"),
    ]);
    expect(added.criteria[0]).toMatchObject({ verifiedAt: null, evidence: null });
    expect(added.verificationRound).toBe(1);
  });

  test("an applied revise drops a person's guidance for tasks it removed", () => {
    const applied = apply(failed(), [
      start({ guidance: { tasks: { b: "use the cache", c: "skip it" } } }),
      attach,
      ask,
      decide(removeC),
      resolveAs("applied"),
    ]);
    expect(applied.guidance).toEqual({ tasks: { b: "use the cache" } });
  });

  test("an applied recovery is refused when the goal cannot run now", () => {
    const goal = apply(failed(), [start(), attach, ask, decide(retry)]);
    // The limit passed while the recovery waited, and it chose no time mode.
    expect(() => apply(goal, [resolveAs("applied", { at: at(61) })])).toThrow(
      /time limit has passed/,
    );
    expect(() => apply(apply(failed(), [start(), attach, ask]), [resolveAs("applied")])).toThrow(
      /recovery r1 is deciding, expected decided or awaiting_approval/,
    );
  });

  test("an applied revise is recorded as a plan revision and its removed ids stay taken", () => {
    const applied = apply(deciding(), [decide(removeC), resolveAs("applied")]);
    expect(applied.tasks.map((t) => t.id)).toEqual(["a", "b"]);
    expect(applied.planRevisions).toEqual([
      {
        id: "r1",
        source: "lead",
        reason: "c is not needed",
        ops: [{ op: "remove", taskId: "c" }],
        status: "applied",
        interventionId: "recovery-r1",
        proposedAt: at(25),
        decidedAt: at(26),
      },
    ]);
    expect(() =>
      apply(applied, [
        {
          type: "plan.revision_proposed",
          revisionId: "rv",
          source: "person",
          reason: "back",
          ops: [{ op: "add", task: task("c") }],
        },
      ]),
    ).toThrow(/Task id c was used earlier in this goal/);
  });

  test("a revise needs room among the plan revisions", () => {
    const goal = deciding();
    const full = {
      ...goal,
      planRevisions: Array.from({ length: MAX_PLAN_REVISIONS }, (_, i) => ({
        id: `x${i}`,
        source: "person",
        reason: "x",
        ops: [],
        status: "rejected",
        proposedAt: AT,
      })),
    };
    expect(() => apply(full, [decide(removeC)])).toThrow(/already revised 20 times/);
    expect(apply(full, [decide(retry)]).recovery?.status).toBe("decided");
  });

  test("ending outcomes and what they count", () => {
    const held = apply(deciding({ ...recoveryConfig, autoApprovePlan: false }), [decide(removeC)]);
    const rejected = apply(held, [resolveAs("rejected", { reason: "keep c" })]);
    expect(rejected).toMatchObject({
      status: "failed",
      failureReason: "Recovery rejected: keep c",
      failedAt: at(26),
      recoveries: 1,
    });
    expect(rejected.recovery).toMatchObject({ status: "ended", outcome: "rejected" });
    // The integration check before applying failed: not the Lead's doing, not counted.
    const precheck = apply(held, [resolveAs("needs_person", { reason: "dirty", uncounted: true })]);
    expect(precheck).not.toHaveProperty("recoveries");
    const refused = apply(apply(deciding(), [decide(retry)]), [
      resolveAs("needs_person", { reason: "no room" }),
    ]);
    expect(refused.recoveries).toBe(1);
    const cancelled = apply(held, [resolveAs("cancelled")]);
    expect(cancelled).not.toHaveProperty("recoveries");
    expect(cancelled.failureReason).toBe("Recovery cancelled");
  });

  test("cancelling ends a deciding recovery and abandons its prompt", () => {
    const cancelled = apply(deciding(), [resolveAs("cancelled", { reason: "changed my mind" })]);
    expect(cancelled.recovery).toMatchObject({ status: "ended", outcome: "cancelled" });
    expect(cancelled.interventions?.at(-1)).toMatchObject({
      id: "recovery-r1",
      status: "abandoned",
    });
  });

  test("a recovery being applied cannot be cancelled, and outcomes need their status", () => {
    const decided = apply(deciding(), [decide(retry)]);
    expect(() => apply(decided, [resolveAs("cancelled")])).toThrow(
      /being applied; cancel the goal after it reopens/,
    );
    expect(() => apply(decided, [resolveAs("rejected")])).toThrow(/expected awaiting_approval/);
    expect(() => apply(deciding(), [resolveAs("needs_person")])).toThrow(
      /expected decided or awaiting_approval/,
    );
    expect(() => apply(decided, [resolveAs("dropped")])).toThrow(/unknown outcome dropped/);
    expect(() => apply(decided, [resolveAs("needs_person", { timeMode: "fresh" })])).toThrow(
      /only an applied recovery restarts/,
    );
    expect(() => apply(decided, [{ ...resolveAs("applied"), recoveryId: "r9" }])).toThrow(
      /unknown recovery r9/,
    );
  });

  test("retry, reopen, a failed merge's retry and archive wait for a live recovery", () => {
    for (const goal of [
      deciding(),
      apply(deciding(), [decide(retry)]),
      apply(deciding({ ...recoveryConfig, autoApprovePlan: false }), [decide(removeC)]),
    ]) {
      for (const event of [
        { type: "goal.retried", taskIds: ["b", "c"], reopen: true },
        { type: "goal.reopened" },
        { type: "changeset.integration_retried", changeSetIds: ["cs-a"], taskIds: [] },
        { type: "goal.archived" },
      ]) {
        expect(() => apply(goal, [event])).toThrow(
          /cancel the recovery first: paseo goal recover g1 --cancel/,
        );
      }
    }
    const ended = apply(deciding(), [resolveAs("cancelled")]);
    expect(apply(ended, [{ type: "goal.retried", taskIds: ["b"], reopen: true }]).status).toBe(
      "executing",
    );
  });

  test("a reopened goal that ends again ends its recovery", () => {
    const applied = apply(deciding(), [decide(retry), resolveAs("applied")]);
    const refailed = apply(applied, [{ type: "goal.failed", reason: "again", at: at(40) }]);
    expect(refailed.recovery).toMatchObject({ status: "ended", outcome: "applied" });
    expect(refailed.failedAt).toBe(at(40));
    const cancelled = apply(applied, [{ type: "goal.cancelled" }]);
    expect(cancelled.recovery?.status).toBe("ended");
    // A second recovery can start once the first ended.
    expect(
      apply(refailed, [{ ...start(), recoveryId: "r2", at: at(41), timeMode: "fresh" }]).recovery
        ?.status,
    ).toBe("deciding");
  });

  test("a retry merges a person's guidance; null clears an entry", () => {
    const goal = apply(failed(), [
      {
        type: "goal.retried",
        taskIds: ["b"],
        reopen: true,
        guidance: { goal: "be careful", tasks: { b: "use the cache", c: "later" } },
      },
    ]);
    expect(goal.guidance).toEqual({
      goal: "be careful",
      tasks: { b: "use the cache", c: "later" },
    });
    const cleared = apply(goal, [
      ...fail("b", 3),
      {
        type: "goal.retried",
        taskIds: ["b"],
        reopen: false,
        guidance: { goal: null, tasks: { c: null } },
      },
    ]);
    expect(cleared.guidance).toEqual({ tasks: { b: "use the cache" } });
    const none = apply(cleared, [
      ...fail("b", 4),
      { type: "goal.retried", taskIds: ["b"], reopen: false, guidance: { tasks: { b: null } } },
    ]);
    expect(none).not.toHaveProperty("guidance");
    const retryWith = (guidance: Record<string, unknown>) => ({
      type: "goal.retried",
      taskIds: ["b"],
      reopen: true,
      guidance,
    });
    expect(() => apply(failed(), [retryWith({ tasks: { z: "x" } })])).toThrow(/unknown task z/);
    expect(() => apply(failed(), [retryWith({ goal: " " })])).toThrow(/send null to clear it/);
    expect(() => apply(failed(), [retryWith({ goal: "x".repeat(4001) })])).toThrow(/limit is 4000/);
  });

  test("the Lead's advice stays apart from a person's guidance and is replaced by the next recovery", () => {
    const applied = apply(failed(), [
      start({ guidance: { goal: "keep the API" } }),
      attach,
      ask,
      decide(retry),
      resolveAs("applied"),
    ]);
    expect(applied.guidance).toEqual({
      goal: "keep the API",
      lead: { recoveryId: "r1", tasks: { b: "use the cache" } },
    });
    const again = apply(applied, [
      ...fail("b", 3),
      { type: "goal.failed", reason: "again", at: at(30) },
      { ...start(), recoveryId: "r2", at: at(31) },
      { ...attach, agentId: "lead-r2", at: at(31) },
      { ...ask, interventionId: "recovery-r2", at: at(31) },
      { ...decide({ decision: "retry", reason: "again" }), recoveryId: "r2", at: at(32) },
      { ...resolveAs("applied"), recoveryId: "r2", at: at(33) },
    ]);
    expect(again.guidance).toEqual({ goal: "keep the API" });
    expect(again.recoveries).toBe(2);
  });
});

describe("intervention caps per reopen", () => {
  const failure = (id: string, taskId: string, epoch?: number) => ({
    id,
    taskId,
    runId: id,
    trigger: "timeout",
    error: "",
    status: "resolved",
    outcome: "continue",
    requestedAt: AT,
    ...(epoch === undefined ? {} : { epoch }),
  });
  const checkIn = (id: string, runId: string, epoch?: number) => ({
    ...failure(id, "a", epoch),
    runId,
    trigger: "watch",
  });
  const base = run([{ ...created, config: revisionConfig }]);

  test("failure wake-ups count only the current reopen; those without an epoch read as 0", () => {
    const four = Array.from({ length: MAX_INTERVENTIONS_PER_GOAL }, (_, i) =>
      failure(`f${i}`, `t${i}`),
    );
    const before: Goal = { ...base, interventions: four };
    expect(failureWakeUpCapError(before, "x", "timeout")).toMatch(/limit is 4/);
    const reopened: Goal = { ...before, reopens: 1 };
    expect(failureWakeUpCapError(reopened, "x", "timeout")).toBeNull();
    const again: Goal = {
      ...reopened,
      interventions: [
        ...four,
        ...Array.from({ length: MAX_INTERVENTIONS_PER_GOAL }, (_, i) =>
          failure(`g${i}`, `t${i}`, 1),
        ),
      ],
    };
    expect(failureWakeUpCapError(again, "x", "timeout")).toMatch(/limit is 4/);
    const perTask: Goal = { ...reopened, interventions: [failure("p1", "x"), failure("p2", "x")] };
    expect(failureWakeUpCapError(perTask, "x", "timeout")).toBeNull();
    expect(failureWakeUpCapError({ ...perTask, reopens: 0 }, "x", "timeout")).toMatch(/task x/);
  });

  test("check-ins count only the current reopen", () => {
    const twelve = Array.from({ length: 12 }, (_, i) => checkIn(`c${i}`, `r${i}`));
    expect(checkInCapError({ ...base, interventions: twelve }, "new")).toMatch(/limit is 12/);
    expect(checkInCapError({ ...base, interventions: twelve, reopens: 2 }, "new")).toBeNull();
  });

  test("an intervention records the reopen it belongs to, and none before the first", () => {
    const failedB = (reopens: number) => {
      const goal = run([
        { ...created, config: { ...revisionConfig, maxAttempts: 5, leadInterventions: true } },
        { type: "lead.attached", agentId: "lead-1" },
        { type: "plan.proposed", tasks: [task("b")] },
        { type: "plan.approved" },
        { type: "task.started", taskId: "b" },
        { type: "run.started", runId: "b-a1", taskId: "b", provider: "codex" },
        { type: "run.finished", runId: "b-a1", outcome: "failed", error: "x" },
        { type: "task.failed", taskId: "b", error: "x" },
      ]);
      return { ...goal, reopens };
    };
    const wake = {
      type: "intervention.requested",
      interventionId: "b-a1",
      taskId: "b",
      runId: "b-a1",
      trigger: "repeated_failure",
      error: "x",
    };
    expect(apply(failedB(0), [wake]).interventions?.[0]).not.toHaveProperty("epoch");
    expect(apply(failedB(2), [wake]).interventions?.[0]?.epoch).toBe(2);
  });
});

describe("recovering a goal that failed verification (b195cf6f)", () => {
  // The real log, anonymised (test-fixtures): every task succeeded, c2 to c10 were verified,
  // c1 was not met, and two recoveries ended needs_person because a revise could not add work.
  const GOAL_ID = "b195cf6f-6f1c-4889-aff8-3f689db7ab15";
  const LATER = "2026-10-28T08:00:00.000Z";
  const events = (): GoalEvent[] =>
    readFileSync(join(import.meta.dirname, "test-fixtures", "b195cf6f-verify.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => GoalEventSchema.parse(JSON.parse(line)));
  const replayed = (upTo = Number.POSITIVE_INFINITY): Goal => {
    const goal = replayGoal(events().filter((e) => e.seq <= upTo));
    if (!goal) throw new Error("empty fixture");
    return goal;
  };
  const step = (goal: Goal, partials: Record<string, unknown>[]) =>
    apply(
      goal,
      partials.map((p) => ({ at: LATER, ...p })),
    );
  const t7 = { ...task("t7", ["t5"]), title: "Fix c1" };
  const addT7 = { decision: "revise", reason: "add a fix for c1", ops: [{ op: "add", task: t7 }] };
  const recover = (goal: Goal, decision: Record<string, unknown>, id = "rec-3") =>
    step(goal, [
      { type: "recovery.started", recoveryId: id, startedBy: "person", timeMode: "fresh" },
      { type: "lead.attached", agentId: `lead-${id}` },
      {
        type: "intervention.requested",
        interventionId: `recovery-${id}`,
        trigger: "recovery",
        error: "",
      },
      { type: "recovery.decided", recoveryId: id, decision },
      { type: "recovery.resolved", recoveryId: id, outcome: "applied", timeMode: "fresh" },
    ]);
  // t7 runs, is reviewed and merged.
  const fixMerged = (goal: Goal) =>
    step(goal, [
      { type: "task.started", taskId: "t7" },
      { type: "run.started", runId: "t7-a1", taskId: "t7", provider: "codex" },
      { type: "task.succeeded", taskId: "t7", summary: "fixed" },
      { type: "run.finished", runId: "t7-a1", outcome: "succeeded" },
      {
        type: "changeset.captured",
        changeSetId: "cs-t7-a1",
        taskId: "t7",
        runId: "t7-a1",
        round: 0,
        supersedes: null,
        cwd: "/worktrees/w-t7",
        branch: "feature/fix",
        baseCommit: "base",
        headCommit: "head",
        files: [{ path: "src/fix.ts", status: "M" }],
      },
      { type: "changeset.transitioned", changeSetId: "cs-t7-a1", to: "in_review" },
      { type: "changeset.transitioned", changeSetId: "cs-t7-a1", to: "approved" },
      { type: "changeset.transitioned", changeSetId: "cs-t7-a1", to: "integrating" },
      {
        type: "changeset.transitioned",
        changeSetId: "cs-t7-a1",
        to: "integrated",
        integratedCommit: "merged",
      },
    ]);
  const verifyAll = (goal: Goal, round: number) =>
    step(
      goal,
      goal.criteria.map((c) => ({
        id: `${GOAL_ID}:verified:${c.id}:v${round}`,
        type: "criterion.verified",
        criterionId: c.id,
        evidence: `round ${round}`,
      })),
    );

  test("the fixture replays to the failed goal with one recovery left", () => {
    const goal = replayed();
    expect(goal).toMatchObject({ status: "failed", recoveries: 2 });
    expect(goal).not.toHaveProperty("verificationRound");
    expect(goal.runs).toHaveLength(21);
    expect(goal.tasks.map((t) => [t.id, t.kind, t.status])).toEqual([
      ["t1", "implement", "succeeded"],
      ["t2", "implement", "succeeded"],
      ["t3", "implement", "succeeded"],
      ["t4", "implement", "succeeded"],
      ["t5", "implement", "succeeded"],
      ["t6", "review", "succeeded"],
      ["t3-rw1", "implement", "succeeded"],
    ]);
    expect(goal.tasks.find((t) => t.id === "t6")?.summary).toMatch(/^\*\*Verdict: FAIL/);
    expect(goal.changeSets.find((c) => c.id === "cs-t3-a10")?.status).toBe("superseded");
    expect(goal.changeSets.find((c) => c.id === "cs-t3-rw1-a1")?.status).toBe("integrated");
    expect(goal.criteria.filter((c) => !c.verifiedAt).map((c) => c.id)).toEqual(["c1"]);
    expect(goal.recovery).toMatchObject({
      id: "rec-212",
      status: "ended",
      outcome: "needs_person",
    });
    expect(goal.verifyStartedAt).toBeDefined();
  });

  test("an applied fix task clears every criterion, starts round 1 and counts as a revision", () => {
    const failed = replayed();
    const applied = recover(failed, addT7);
    expect(applied.status).toBe("executing");
    expect(applied.recoveries).toBe(3);
    expect(applied.verificationRound).toBe(1);
    expect(applied).not.toHaveProperty("verifyStartedAt");
    expect(applied).not.toHaveProperty("verifiedAt");
    expect(applied.criteria.every((c) => c.verifiedAt === null && c.evidence === null)).toBe(true);
    expect(applied.tasks.at(-1)).toMatchObject({ id: "t7", status: "pending" });
    expect(applied.planRevisions?.length).toBe((failed.planRevisions?.length ?? 0) + 1);
    expect(applied.planRevisions?.at(-1)).toMatchObject({ id: "rec-3", status: "applied" });
    // History stays: runs, change sets and the verifier's usage.
    expect(applied.runs).toEqual(failed.runs);
    expect(applied.changeSets).toEqual(failed.changeSets);
    expect(applied.usageByRole).toEqual(failed.usageByRole);
  });

  test("verification restarts only once the fix is merged, and every criterion is verified again", () => {
    const applied = recover(replayed(), addT7);
    const merged = fixMerged(applied);
    expect(merged.verifyStartedAt).toBe(LATER);
    const done = step(verifyAll(merged, 1), [{ type: "goal.completed" }]);
    expect(done.status).toBe("completed");
    expect(done.criteria.every((c) => c.evidence === "round 1")).toBe(true);
    expect(done.verifiedAt).toBe(LATER);
  });

  test("a criterion cannot be verified twice in one round, nor by a result from another round", () => {
    const merged = fixMerged(recover(replayed(), addT7));
    const verified = (id: string, round: number) => ({
      id,
      type: "criterion.verified",
      criterionId: "c2",
      evidence: "ok",
      round,
    });
    // A verifier asked before the reset answers late: its round-0 result does not count.
    expect(() => step(merged, [verified(`${GOAL_ID}:verified:c2`, 0)])).toThrow(
      /the result is for verification round 0; the goal is in round 1/,
    );
    const once = step(merged, [verified(`${GOAL_ID}:verified:c2:v1`, 1)]);
    expect(once.criteria.find((c) => c.id === "c2")?.verifiedAt).toBe(LATER);
    expect(() => step(once, [verified(`${GOAL_ID}:verified:c2:v1-again`, 1)])).toThrow(
      /criterion c2 already verified/,
    );
  });

  test("a retry or a revise that only removes keeps the results and the round", () => {
    const retried = recover(replayed(), { decision: "retry", reason: "check again" });
    expect(retried.status).toBe("executing");
    expect(retried).not.toHaveProperty("verificationRound");
    expect(retried.criteria.filter((c) => c.verifiedAt).map((c) => c.id)).toEqual(
      replayed()
        .criteria.filter((c) => c.verifiedAt)
        .map((c) => c.id),
    );
    expect(retried.verifyStartedAt).toBe(replayed().verifyStartedAt);
  });

  test("a plain revision stays refused after verification started, but is allowed while fix tasks run", () => {
    const retried = recover(replayed(), { decision: "retry", reason: "check again" });
    const addT8 = [{ op: "add", task: task("t8", ["t5"]) }];
    expect(() => step(retried, [propose("p1", "person", addT8)])).toThrow(
      /verification has started; the plan cannot change/,
    );
    const fixing = recover(replayed(), addT7);
    const revised = step(fixing, [
      propose("p1", "person", addT8),
      { type: "plan.revision_approved", revisionId: "p1" },
    ]);
    expect(revised.tasks.map((t) => t.id)).toContain("t8");
  });

  test("a revise is refused once the plan was revised the most times", () => {
    const failed = replayed();
    const full: Goal = {
      ...failed,
      planRevisions: Array.from({ length: MAX_PLAN_REVISIONS }, (_, i) => ({
        id: `x${i}`,
        source: "person",
        reason: "x",
        ops: [],
        status: "rejected" as const,
        proposedAt: LATER,
      })),
    };
    expect(() => recover(full, addT7)).toThrow(
      `the plan was already revised ${MAX_PLAN_REVISIONS} times`,
    );
  });

  test("a deadline reached mid-verification, then a recovery that adds work, clears the criteria verified so far", () => {
    // c2 to c4 were verified when the time ran out.
    const partly = replayed(199);
    expect(partly.criteria.filter((c) => c.verifiedAt).map((c) => c.id)).toEqual([
      "c2",
      "c3",
      "c4",
    ]);
    const failed = step(partly, [
      { type: "goal.failed", reason: "The goal's time limit of 2160 minutes was reached" },
    ]);
    const applied = recover(failed, addT7, "rec-d");
    expect(applied.verificationRound).toBe(1);
    expect(applied.criteria.every((c) => c.verifiedAt === null)).toBe(true);
    const done = step(verifyAll(fixMerged(applied), 1), [{ type: "goal.completed" }]);
    expect(done.status).toBe("completed");
  });

  test("a second reset moves to round 2", () => {
    const round1 = recover(replayed(), addT7);
    const failedAgain = step(fixMerged(round1), [
      { id: "v1-c2", type: "criterion.verified", criterionId: "c2", evidence: "ok" },
      { type: "goal.failed", reason: "Acceptance criteria not met: Criterion c1 (still open)" },
    ]);
    const t9 = { ...task("t9", ["t7"]), title: "Fix c1 again" };
    const round2 = recover(
      { ...failedAgain, recoveries: 0 },
      { decision: "revise", reason: "again", ops: [{ op: "add", task: t9 }] },
      "rec-4",
    );
    expect(round2.verificationRound).toBe(2);
    expect(round2.criteria.every((c) => c.verifiedAt === null)).toBe(true);
  });
});

describe("accepting a failed goal as is", () => {
  // The b195cf6f log: every task succeeded and is merged, c2 to c10 were verified, c1 was not
  // met, and two recoveries ended needs_person. A third ends the same way, leaving none.
  const LATER = "2026-10-28T08:00:00.000Z";
  const fixtureEvents = (): GoalEvent[] =>
    readFileSync(join(import.meta.dirname, "test-fixtures", "b195cf6f-verify.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => GoalEventSchema.parse(JSON.parse(line)));
  const step = (goal: Goal, partials: Record<string, unknown>[]) =>
    apply(
      goal,
      partials.map((p) => ({ at: LATER, ...p })),
    );
  const thirdRecoveryEnded = (): Goal => {
    const goal = replayGoal(fixtureEvents());
    if (!goal) throw new Error("empty fixture");
    return step(goal, [
      { type: "recovery.started", recoveryId: "rec-217", startedBy: "person", timeMode: "fresh" },
      { type: "lead.attached", agentId: "lead-rec-217" },
      {
        type: "intervention.requested",
        interventionId: "recovery-rec-217",
        trigger: "recovery",
        error: "",
      },
      {
        type: "recovery.decided",
        recoveryId: "rec-217",
        decision: { decision: "needs_person", reason: "c1 needs a person" },
      },
    ]);
  };
  const accept = (goal: Goal, fields: Record<string, unknown> = {}) =>
    step(goal, [
      {
        type: "goal.accepted",
        criterionIds: ["c1"],
        note: "UV-02 is tracked separately",
        acceptedFrom: goal.failureReason ?? "",
        client: "app",
        ...fields,
      },
    ]);

  test("completes the fixture goal with c1 waived, after its last recovery", () => {
    const failed = thirdRecoveryEnded();
    expect(failed.status).toBe("failed");
    expect(failed.recoveries).toBe(3);
    const reason = failed.failureReason;
    const done = accept(failed, { note: "  UV-02 is tracked separately  " });
    expect(done.status).toBe("completed");
    expect(done.failureReason).toBeNull();
    expect(done.accepted).toEqual({
      at: LATER,
      note: "UV-02 is tracked separately",
      from: reason,
      client: "app",
    });
    const c1 = done.criteria.find((c) => c.id === "c1");
    expect(c1).toMatchObject({
      verifiedAt: null,
      waived: { at: LATER, note: "UV-02 is tracked separately" },
    });
    expect(done.criteria.filter((c) => c.waived).map((c) => c.id)).toEqual(["c1"]);
    expect(done.criteria.filter((c) => c.verifiedAt)).toHaveLength(failed.criteria.length - 1);
  });

  test("replays to the same state, and an ended goal takes no reopen", () => {
    const done = accept(thirdRecoveryEnded());
    // The same events, parsed by the wire schema and replayed from the log.
    const base = fixtureEvents();
    let seq = base[base.length - 1]?.seq ?? 0;
    const third: Record<string, unknown>[] = [
      { type: "recovery.started", recoveryId: "rec-217", startedBy: "person", timeMode: "fresh" },
      { type: "lead.attached", agentId: "lead-rec-217" },
      {
        type: "intervention.requested",
        interventionId: "recovery-rec-217",
        trigger: "recovery",
        error: "",
      },
      {
        type: "recovery.decided",
        recoveryId: "rec-217",
        decision: { decision: "needs_person", reason: "c1 needs a person" },
      },
    ];
    const beforeAccept = replayGoal(
      base.concat(
        third.map((p) =>
          GoalEventSchema.parse({
            id: `x${seq}`,
            goalId: base[0]?.goalId,
            seq: ++seq,
            at: LATER,
            ...p,
          }),
        ),
      ),
    );
    const log = base.concat(
      [
        ...third,
        {
          type: "goal.accepted",
          criterionIds: ["c1"],
          note: "UV-02 is tracked separately",
          acceptedFrom: beforeAccept?.failureReason ?? "",
          client: "app",
        },
      ].map((p, i) =>
        GoalEventSchema.parse({
          id: `y${i}`,
          goalId: base[0]?.goalId,
          seq: base.length + i + 1,
          at: LATER,
          ...p,
        }),
      ),
    );
    const replayed = replayGoal(log);
    expect(replayed?.status).toBe("completed");
    expect(replayed?.accepted).toEqual(done.accepted);
    expect(replayed?.criteria).toEqual(done.criteria);
    expect(() =>
      step(done, [{ type: "recovery.started", recoveryId: "rec-x", startedBy: "person" }]),
    ).toThrow(/goal is completed/);
    expect(() => step(done, [{ type: "goal.retried", taskIds: ["t1"], reopen: true }])).toThrow(
      /goal is completed/,
    );
    expect(() => accept(done)).toThrow(/goal is completed/);
  });

  test("is refused while a recovery is open", () => {
    const failed = replayGoal(fixtureEvents());
    if (!failed) throw new Error("empty fixture");
    const deciding = step(failed, [
      { type: "recovery.started", recoveryId: "rec-217", startedBy: "person", timeMode: "fresh" },
    ]);
    expect(() => accept(deciding)).toThrow(/recovery rec-217 is still deciding/);
  });

  test("is refused for an archived goal, until it is unarchived", () => {
    const archived = step(thirdRecoveryEnded(), [{ type: "goal.archived" }]);
    expect(() => accept(archived)).toThrow(/archived/);
    expect(accept(step(archived, [{ type: "goal.unarchived" }])).status).toBe("completed");
  });

  test("is refused unless every unverified criterion is named exactly once", () => {
    const failed = thirdRecoveryEnded();
    expect(() => accept(failed, { criterionIds: [] })).toThrow(/missing: c1/);
    expect(() => accept(failed, { criterionIds: ["c1", "c2"] })).toThrow(
      /not unverified criteria: c2/,
    );
    expect(() => accept(failed, { criterionIds: ["c1", "c99"] })).toThrow(
      /not unverified criteria: c99/,
    );
    expect(() => accept(failed, { criterionIds: ["c1", "c1"] })).toThrow(/named twice/);
  });

  test("needs a note of bounded length", () => {
    const failed = thirdRecoveryEnded();
    expect(() => accept(failed, { note: "   " })).toThrow(/note saying why is required/);
    expect(() => accept(failed, { note: "x".repeat(2001) })).toThrow(/longer than 2000/);
    expect(accept(failed, { note: "x".repeat(2000) }).status).toBe("completed");
  });

  test("is refused when work is not done or not merged", () => {
    const failed = thirdRecoveryEnded();
    const reworkFailed = structuredClone(failed);
    Object.assign(reworkFailed.changeSets.find((c) => c.id === "cs-t5-a1") ?? {}, {
      status: "rejected",
      rejectionReason: "rework_failed",
    });
    expect(() => accept(reworkFailed)).toThrow(/change sets not merged: cs-t5-a1/);
    const uncaptured = structuredClone(failed);
    Object.assign(uncaptured.tasks.find((t) => t.id === "t5") ?? {}, { captured: false });
    expect(() => accept(uncaptured)).toThrow(/work not captured for: t5/);
    const taskFailed = run([
      { ...created, config: revisionConfig },
      { type: "plan.proposed", tasks: [task("a")] },
      { type: "plan.approved" },
      { type: "task.started", taskId: "a" },
      { type: "task.failed", taskId: "a", error: "boom" },
      { type: "goal.failed", reason: "Task a failed" },
    ]);
    expect(() => accept(taskFailed)).toThrow(/tasks not succeeded: a/);
  });

  test("is refused with zero tasks, on a manual goal and on a goal that did not fail", () => {
    const noPlan = run([
      { ...created, config: revisionConfig },
      { type: "goal.failed", reason: "The Lead gave no usable plan" },
    ]);
    expect(() => accept(noPlan)).toThrow(/before it had a plan/);
    const manual = run([created, { type: "goal.failed", reason: "x" }]);
    expect(() => accept(manual)).toThrow(/manual goal/);
    const verifying = replayGoal(fixtureEvents().filter((e) => e.seq <= 205));
    if (!verifying) throw new Error("empty fixture");
    expect(verifying.status).toBe("executing");
    expect(() => accept(verifying)).toThrow(/requires goal status failed/);
  });

  test("a goal never accepted carries no acceptance fields", () => {
    const failed = thirdRecoveryEnded();
    expect(failed.accepted).toBeUndefined();
    expect(failed.criteria.some((c) => c.waived)).toBe(false);
  });

  test("with every criterion verified it completes with nothing waived", () => {
    const allVerified = structuredClone(thirdRecoveryEnded());
    Object.assign(allVerified.criteria.find((c) => c.id === "c1") ?? {}, {
      verifiedAt: LATER,
      evidence: "ok",
    });
    const done = accept(allVerified, { criterionIds: [] });
    expect(done.status).toBe("completed");
    expect(done.accepted?.note).toBe("UV-02 is tracked separately");
    expect(done.criteria.some((c) => c.waived)).toBe(false);
  });

  test("a merge that failed refuses it; an acknowledged or paused goal is accepted and no stage time is invented", () => {
    const failed = thirdRecoveryEnded();
    const mergeFailed = structuredClone(failed);
    Object.assign(mergeFailed.changeSets.find((c) => c.id === "cs-t5-a1") ?? {}, {
      status: "rejected",
      rejectionReason: "integration_failed",
    });
    expect(() => accept(mergeFailed)).toThrow(/change sets not merged: cs-t5-a1/);

    const acknowledged = step(failed, [{ type: "goal.acknowledged" }]);
    const done = accept(acknowledged);
    expect(done.status).toBe("completed");
    expect(done.acknowledgedAt).toBe(LATER);

    const { verifyStartedAt: _started, ...unstamped } = failed;
    const paused = { ...unstamped, pausedAt: LATER };
    const accepted = accept(paused);
    expect(accepted.pausedAt).toBeNull();
    expect(accepted).not.toHaveProperty("verifyStartedAt");
    expect(accepted).not.toHaveProperty("verifiedAt");
  });
});

describe("waits for a person's answer", () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
  /** Applies `[minute, event]` pairs and returns every state. */
  function timed(events: [number, Record<string, unknown>][]): Goal[] {
    const states: Goal[] = [];
    let goal: Goal | null = null;
    for (const [minute, partial] of events) {
      goal = applyGoalEvent(goal, { ...ev(goal, partial), at: at(minute) });
      states.push(goal);
    }
    return states;
  }
  const config = {
    cwd: "/repo",
    leadProvider: "claude",
    defaultProvider: "codex",
    maxParallel: 2,
    maxAttempts: 2,
    autoApprovePlan: true,
    notifyLead: false,
    limits: { goalTimeoutMinutes: 60, deadlineAt: at(500) },
  };
  const running: [number, Record<string, unknown>][] = [
    [0, { ...created, config }],
    [0, { type: "plan.proposed", tasks: [task("a"), task("b")] }],
    [0, { type: "plan.approved" }],
    [0, { type: "task.started", taskId: "a" }],
    [0, { type: "run.started", runId: "a-a1", taskId: "a", provider: "codex" }],
    [0, { type: "task.started", taskId: "b" }],
    [0, { type: "run.started", runId: "b-a1", taskId: "b", provider: "codex" }],
  ];
  const waitA = { type: "wait.started", agentId: "agent-a", role: "worker", runId: "a-a1" };
  const waitB = { type: "wait.started", agentId: "agent-b", role: "worker", runId: "b-a1" };
  const last = (events: [number, Record<string, unknown>][]) => timed(events).at(-1) as Goal;

  test("overlapping waits are counted once", () => {
    const goal = last([
      ...running,
      [10, waitA],
      [15, waitB],
      [20, { type: "wait.ended", agentId: "agent-a", outcome: "answered" }],
      [30, { type: "wait.ended", agentId: "agent-b", outcome: "answered" }],
    ]);
    expect(goal.waits).toEqual({ open: {}, excludedMs: 20 * 60_000, since: null });
  });

  test("an open wait records when the stretch began", () => {
    const goal = last([...running, [10, waitA], [15, waitB]]);
    expect(goal.waits?.since).toBe(at(10));
    expect(goal.waits?.open["agent-b"]).toEqual({ since: at(15), runId: "b-a1" });
  });

  test("run.finished closes the wait of its run", () => {
    const goal = last([
      ...running,
      [10, waitA],
      [25, { type: "run.finished", runId: "a-a1", outcome: "interrupted" }],
    ]);
    expect(goal.waits).toEqual({ open: {}, excludedMs: 15 * 60_000, since: null });
  });

  test("a goal that ends closes every wait", () => {
    const goal = last([...running, [10, waitA], [12, waitB], [40, { type: "goal.cancelled" }]]);
    expect(goal.waits).toEqual({ open: {}, excludedMs: 30 * 60_000, since: null });
  });

  test("a new time base while a wait is open clears the count and restarts it", () => {
    const goal = last([
      ...running,
      [5, waitA],
      [6, { type: "wait.ended", agentId: "agent-a", outcome: "answered" }],
      [7, { type: "run.finished", runId: "a-a1", outcome: "failed", error: "boom" }],
      [7, { type: "task.failed", taskId: "a", error: "boom" }],
      [10, waitB],
      [20, { type: "goal.retried", taskIds: ["a"], reopen: false, timeMode: "fresh" }],
    ]);
    expect(goal.timeBaseAt).toBe(at(20));
    expect(goal.waits).toEqual({
      open: { "agent-b": { since: at(10), runId: "b-a1" } },
      excludedMs: 0,
      since: at(20),
    });
  });

  test("refuses a second wait for the same agent, a wait in a finished run, and an end without a wait", () => {
    expect(() => last([...running, [10, waitA], [11, waitA]])).toThrow(/already waiting/);
    expect(() =>
      last([
        ...running,
        [5, { type: "run.finished", runId: "a-a1", outcome: "failed", error: "x" }],
        [10, waitA],
      ]),
    ).toThrow(/not running/);
    expect(() =>
      last([...running, [10, { type: "wait.ended", agentId: "agent-a", outcome: "answered" }]]),
    ).toThrow(/not waiting/);
  });

  test("the absolute deadline is not moved by waiting", () => {
    const goal = last([
      ...running,
      [10, waitA],
      [400, { type: "wait.ended", agentId: "agent-a", outcome: "answered" }],
    ]);
    expect(goal.config?.limits?.deadlineAt).toBe(at(500));
    expect(goal.waits?.excludedMs).toBe(390 * 60_000);
  });

  test("replay gives the same state, and a log without waits has none", () => {
    const events = timed([...running, [10, waitA], [12, waitB]]);
    const log: GoalEvent[] = [];
    let goal: Goal | null = null;
    for (const [minute, partial] of [...running, [10, waitA], [12, waitB]] as [
      number,
      Record<string, unknown>,
    ][]) {
      const event = { ...ev(goal, partial), at: at(minute) };
      log.push(event);
      goal = applyGoalEvent(goal, event);
    }
    expect(replayGoal(log)).toEqual(events.at(-1));
    expect(last(running).waits).toBeUndefined();
  });
});
