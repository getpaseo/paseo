import { describe, expect, test } from "vitest";
import type {
  Goal,
  GoalEvent,
  LeadIntervention,
  PlanRevisionOp,
  TaskSpec,
} from "@getpaseo/protocol/goal/types";
import { taskRunTimeoutMs } from "./goal-limits.js";
import { applyGoalEvent } from "./goal-reducer.js";
import { extractPlan } from "./plan-extract.js";
import {
  PlanRevisionError,
  diffDesiredPlan,
  removedTaskIds,
  validatePlanRevision,
} from "./plan-revision.js";
import { TaskGraphError, validateTaskGraph } from "./task-graph.js";

const AT = "2026-01-01T00:00:00.000Z";

const config = {
  cwd: "/repo",
  leadProvider: "claude",
  defaultProvider: "codex",
  maxParallel: 2,
  maxAttempts: 3,
  autoApprovePlan: true,
  notifyLead: false,
};

function spec(id: string, dependsOn: string[] = [], extra: Partial<TaskSpec> = {}): TaskSpec {
  return { id, title: `Task ${id}`, description: "", kind: "implement", dependsOn, ...extra };
}

function run(events: Record<string, unknown>[], start: Goal | null = null): Goal {
  let goal = start;
  for (const partial of events) {
    goal = applyGoalEvent(goal, {
      id: `e${(goal?.lastSeq ?? 0) + 1}`,
      goalId: "g1",
      seq: (goal?.lastSeq ?? 0) + 1,
      at: AT,
      ...partial,
    } as GoalEvent);
  }
  if (!goal) throw new Error("no events");
  return goal;
}

function failAttempt(taskId: string, attempt: number): Record<string, unknown>[] {
  const runId = `${taskId}-a${attempt}`;
  return [
    { type: "task.started", taskId },
    { type: "run.started", runId, taskId, provider: "codex" },
    { type: "run.finished", runId, outcome: "failed", error: "boom" },
    { type: "task.failed", taskId, error: "boom" },
  ];
}

/** t1 succeeded, t2 is running, t3 failed twice, t4 is pending behind t3. */
function executing(): Goal {
  return run([
    { type: "goal.created", title: "T", objective: "O", criteria: [], config },
    {
      type: "plan.proposed",
      tasks: [spec("t1"), spec("t2"), spec("t3"), spec("t4", ["t3"])],
    },
    { type: "plan.approved" },
    { type: "task.started", taskId: "t1" },
    { type: "task.succeeded", taskId: "t1" },
    { type: "task.started", taskId: "t2" },
    ...failAttempt("t3", 1),
    { type: "task.retried", taskId: "t3" },
    ...failAttempt("t3", 2),
  ]);
}

function intervention(taskId: string, status = "open"): LeadIntervention {
  return {
    id: `${taskId}-a2`,
    taskId,
    runId: `${taskId}-a2`,
    trigger: "repeated_failure",
    error: "boom",
    status,
    requestedAt: AT,
  };
}

describe("validatePlanRevision", () => {
  test("replace keeps attempts and forgives earlier failures", () => {
    const goal = executing();
    const tasks = validatePlanRevision(
      goal,
      [{ op: "replace", task: spec("t3", [], { title: "Smaller t3" }) }],
      "lead",
    );
    expect(tasks.find((t) => t.id === "t3")).toMatchObject({
      title: "Smaller t3",
      status: "pending",
      attempts: 2,
      error: null,
      summary: null,
      forgivenFailures: 2,
    });
    expect(tasks.map((t) => t.id)).toEqual(["t1", "t2", "t3", "t4"]);
  });

  test("add appends a pending task and remove drops one", () => {
    const tasks = validatePlanRevision(
      executing(),
      [
        { op: "remove", taskId: "t4" },
        { op: "add", task: spec("t5", ["t1"]) },
      ],
      "person",
    );
    expect(tasks.map((t) => t.id)).toEqual(["t1", "t2", "t3", "t5"]);
    expect(tasks.at(-1)).toMatchObject({ status: "pending", attempts: 0 });
  });

  test("running, succeeded, unknown and rework targets are refused", () => {
    const goal = executing();
    const refuse = (op: PlanRevisionOp, message: RegExp) =>
      expect(() => validatePlanRevision(goal, [op], "lead")).toThrow(message);
    refuse({ op: "replace", task: spec("t1") }, /t1 is succeeded and cannot change/);
    refuse({ op: "remove", taskId: "t2" }, /t2 is running and cannot change/);
    refuse({ op: "remove", taskId: "nope" }, /does not exist/);

    const withRework: Goal = {
      ...goal,
      tasks: [
        ...goal.tasks,
        {
          ...spec("t1-rw1"),
          status: "pending",
          attempts: 0,
          error: null,
          summary: null,
          rework: { changeSetId: "cs1", reason: "review", round: 1 },
        },
      ],
    };
    expect(() =>
      validatePlanRevision(withRework, [{ op: "remove", taskId: "t1-rw1" }], "lead"),
    ).toThrow(/rework task the Manager owns/);
  });

  test("reused ids are refused: live, removed, ever run and reserved", () => {
    const goal = executing();
    const add = (id: string, on: Goal = goal) =>
      validatePlanRevision(on, [{ op: "add", task: spec(id) }], "lead");
    expect(() => add("t1")).toThrow(/already exists/);
    expect(() => add("x-rw2")).toThrow(/reserved for rework/);

    const removed = run(
      [
        {
          type: "plan.revision_proposed",
          revisionId: "r1",
          source: "person",
          reason: "drop t4",
          ops: [{ op: "remove", taskId: "t4" }],
        },
        { type: "plan.revision_approved", revisionId: "r1" },
      ],
      goal,
    );
    expect([...removedTaskIds(removed)]).toEqual(["t4"]);
    expect(() => add("t4", removed)).toThrow(/used earlier in this goal/);

    // A run recorded for a task id no longer in the plan still holds the id.
    const ranBefore: Goal = {
      ...removed,
      runs: [...removed.runs, { ...removed.runs[0]!, id: "z-a1", taskId: "z" }],
    };
    expect(() => add("z", ranBefore)).toThrow(/used earlier in this goal/);
  });

  test("graph shape, duplicate ops, empty ops and the task limit are checked", () => {
    const goal = executing();
    expect(() => validatePlanRevision(goal, [], "lead")).toThrow(/changes nothing/);
    expect(() =>
      validatePlanRevision(
        goal,
        [
          { op: "replace", task: spec("t3") },
          { op: "remove", taskId: "t3" },
        ],
        "lead",
      ),
    ).toThrow(/more than one op/);
    expect(() => validatePlanRevision(goal, [{ op: "remove", taskId: "t3" }], "lead")).toThrow(
      /t4 depends on unknown task t3/,
    );
    expect(() =>
      validatePlanRevision(goal, [{ op: "add", task: spec("t5", ["t5"]) }], "lead"),
    ).toThrow(/depends on itself/);
    expect(() =>
      validatePlanRevision(goal, [{ op: "replace", task: spec("t3", ["t4"]) }], "lead"),
    ).toThrow(/cycle/);
    const small: Goal = { ...goal, config: { ...config, limits: { maxTasks: 4 } } };
    expect(() => validatePlanRevision(small, [{ op: "add", task: spec("t5") }], "lead")).toThrow(
      /at most 4 are allowed/,
    );
    expect(() => validatePlanRevision(goal, [{ op: "add", task: spec("t5") }], "agent")).toThrow(
      /Unknown revision source/,
    );
  });

  test("an intervention revision must replace or remove the intervention's task", () => {
    const goal: Goal = { ...executing(), interventions: [intervention("t3")] };
    expect(() =>
      validatePlanRevision(goal, [{ op: "add", task: spec("t5") }], "lead", "t3-a2"),
    ).toThrow(/must replace or remove t3/);
    expect(() =>
      validatePlanRevision(
        goal,
        [{ op: "replace", task: spec("t3", [], { title: "x" }) }],
        "lead",
        "nope",
      ),
    ).toThrow(/Unknown intervention nope/);
    expect(
      validatePlanRevision(
        goal,
        [{ op: "replace", task: spec("t3", [], { title: "x" }) }],
        "lead",
        "t3-a2",
      ),
    ).toHaveLength(4);
  });

  test("the Lead cannot revise outside the decision prompt while an intervention is live", () => {
    const goal: Goal = { ...executing(), interventions: [intervention("t3")] };
    expect(() => validatePlanRevision(goal, [{ op: "add", task: spec("t5") }], "lead")).toThrow(
      /answer the decision prompt/,
    );
    expect(validatePlanRevision(goal, [{ op: "add", task: spec("t5") }], "person")).toHaveLength(5);
  });
});

describe("validatePlanRevision, further refusals", () => {
  test("a target with a live run, an empty result and an unchanged replace are refused", () => {
    const goal = executing();
    // t2 was cancelled mid-run: its run is still live.
    const cancelled = run(
      [
        { type: "run.started", runId: "t2-a1", taskId: "t2", provider: "codex" },
        { type: "task.cancelled", taskId: "t2" },
      ],
      goal,
    );
    expect(() =>
      validatePlanRevision(
        cancelled,
        [{ op: "replace", task: spec("t2", [], { title: "x" }) }],
        "lead",
      ),
    ).toThrow(/t2 still has a live run; wait for it to end/);

    const only: Goal = { ...goal, tasks: goal.tasks.filter((t) => t.id === "t3") };
    expect(() => validatePlanRevision(only, [{ op: "remove", taskId: "t3" }], "person")).toThrow(
      /no tasks/,
    );

    expect(() => validatePlanRevision(goal, [{ op: "replace", task: spec("t3") }], "lead")).toThrow(
      /t3 would not change/,
    );
  });

  test("only the Lead answers an intervention", () => {
    const goal: Goal = { ...executing(), interventions: [intervention("t3")] };
    expect(() =>
      validatePlanRevision(
        goal,
        [{ op: "replace", task: spec("t3", [], { title: "x" }) }],
        "person",
        "t3-a2",
      ),
    ).toThrow(/Only the Lead answers an intervention/);
  });

  test("new or replaced work is refused once the run limit is used up; removal is not", () => {
    const goal = executing();
    const full: Goal = { ...goal, config: { ...config, limits: { maxRuns: goal.runs.length } } };
    expect(() => validatePlanRevision(full, [{ op: "add", task: spec("t5") }], "lead")).toThrow(
      /run limit of 2 is used up/,
    );
    expect(validatePlanRevision(full, [{ op: "remove", taskId: "t4" }], "lead")).toHaveLength(3);
  });

  test("an added task cannot depend on a task removed in the same revision", () => {
    expect(() =>
      validatePlanRevision(
        executing(),
        [
          { op: "remove", taskId: "t4" },
          { op: "add", task: spec("t5", ["t4"]) },
        ],
        "lead",
      ),
    ).toThrow(/t5 depends on unknown task t4/);
  });

  test("extractPlan keeps a task's runTimeoutMinutes", () => {
    const tasks = extractPlan(
      '```json\n{"tasks":[{"id":"a","title":"A","description":"","kind":"read","dependsOn":[],"runTimeoutMinutes":15}]}\n```',
    );
    expect(tasks[0]?.runTimeoutMinutes).toBe(15);
  });
});

describe("diffDesiredPlan", () => {
  test("reordered dependencies are not a change", () => {
    const goal = run([
      { type: "goal.created", title: "T", objective: "O", criteria: [], config },
      { type: "plan.proposed", tasks: [spec("a"), spec("b"), spec("c", ["a", "b"])] },
      { type: "plan.approved" },
    ]);
    expect(() => diffDesiredPlan(goal, [spec("a"), spec("b"), spec("c", ["b", "a"])], [])).toThrow(
      /nothing to revise/,
    );
  });

  test("a desired plan that changes finished tasks is refused (goal aff07ea6)", () => {
    const goal = executing();
    // The Lead re-planned from scratch, rewriting t1 (succeeded) and t2 (running).
    const desired = [
      spec("t1", [], { title: "Redo t1" }),
      spec("t2", [], { title: "Redo t2" }),
      spec("t3"),
      spec("t4", ["t3"]),
    ];
    expect(() => diffDesiredPlan(goal, desired, [])).toThrow(
      "t1 succeeded and cannot change; give new work a new id; t2 is running and cannot change; give new work a new id.",
    );
  });

  test("a partial plan lists every missing task", () => {
    const goal = executing();
    expect(() => diffDesiredPlan(goal, [spec("t5")], [])).toThrow(
      /missing t3, t4: list each pending, failed or cancelled task, or name it in remove/,
    );
  });

  test("explicit remove, unchanged tasks, replacements and additions become ops", () => {
    const goal = executing();
    const ops = diffDesiredPlan(
      goal,
      [
        spec("t1"),
        spec("t3", [], { title: "Split t3", runTimeoutMinutes: 30 }),
        spec("t3b", ["t3"]),
      ],
      ["t4"],
    );
    expect(ops).toEqual([
      { op: "replace", task: spec("t3", [], { title: "Split t3", runTimeoutMinutes: 30 }) },
      { op: "remove", taskId: "t4" },
      { op: "add", task: spec("t3b", ["t3"]) },
    ]);
    expect(() => validatePlanRevision(goal, ops, "lead")).not.toThrow();
  });

  test("refuses removing finished or unknown tasks, double listing and no change", () => {
    const goal = executing();
    const rest = [spec("t3"), spec("t4", ["t3"])];
    expect(() => diffDesiredPlan(goal, rest, ["t1"])).toThrow(/t1 succeeded and cannot change/);
    expect(() => diffDesiredPlan(goal, rest, ["ghost"])).toThrow(/remove names unknown task ghost/);
    expect(() => diffDesiredPlan(goal, rest, ["t4"])).toThrow(/t4 is both listed and in remove/);
    expect(() => diffDesiredPlan(goal, [...rest, spec("t3")], [])).toThrow(/t3 is listed twice/);
    expect(() => diffDesiredPlan(goal, rest, [])).toThrow(/nothing to revise/);
    expect(() => diffDesiredPlan(goal, rest, [])).toThrow(PlanRevisionError);
  });
});

describe("validateTaskGraph", () => {
  test("still refuses reserved ids in a first plan", () => {
    expect(() => validateTaskGraph([spec("a-rw1")])).toThrow(TaskGraphError);
    expect(() => validateTaskGraph([spec("a-rw1")])).toThrow(/reserved for rework/);
  });
});

describe("taskRunTimeoutMs", () => {
  test("a task's limit can lower the goal's run timeout, never raise it", () => {
    const goal = { config: { ...config, limits: { runTimeoutMinutes: 60 } } };
    expect(taskRunTimeoutMs(goal, {})).toBe(60 * 60_000);
    expect(taskRunTimeoutMs(goal, { runTimeoutMinutes: 20 })).toBe(20 * 60_000);
    expect(taskRunTimeoutMs(goal, { runTimeoutMinutes: 120 })).toBe(60 * 60_000);
  });
});
