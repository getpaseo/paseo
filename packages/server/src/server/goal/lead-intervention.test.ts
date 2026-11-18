import pino from "pino";
import { describe, expect, test } from "vitest";
import {
  MAX_DECISION_REASON_CHARS,
  MAX_NUDGE_CHARS,
  capText,
} from "@getpaseo/protocol/goal/interventions";
import type {
  Goal,
  GoalEvent,
  GoalEventInput,
  LeadIntervention,
  Task,
} from "@getpaseo/protocol/goal/types";
import { MAX_PLAN_REVISIONS, applyGoalEvent } from "./goal-reducer.js";
import type { GoalStoreListener } from "./goal-store.js";
import { FakeClock } from "./goal-test-env.js";
import {
  LEAD_STOP_PREFIX,
  LeadInterventions,
  TURN_TIMEOUT_PREFIX,
  dueWakeUp,
  failureTrigger,
  failureWakeUpHandler,
  interventionRevisionOps,
  revisionUnavailable,
  wakeUpsUnblocked,
} from "./lead-intervention.js";
import { MAX_REVISED_DESCRIPTION_CHARS } from "./plan-revision.js";
import { buildInterventionPrompt } from "./prompts.js";
import { InterventionDecisionError, extractInterventionDecision } from "./plan-extract.js";

const AT = "2026-01-01T00:00:00.000Z";
const TIMEOUT = `${TURN_TIMEOUT_PREFIX} 90 minutes`;

const config = {
  cwd: "/repo",
  leadProvider: "claude",
  defaultProvider: "codex",
  maxParallel: 2,
  maxAttempts: 3,
  autoApprovePlan: false,
  notifyLead: false,
  leadInterventions: true,
};

function spec(id: string, dependsOn: string[] = []) {
  return { id, title: id, description: "", kind: "implement", dependsOn };
}

function apply(goal: Goal | null, events: Record<string, unknown>[]): Goal {
  let next = goal;
  for (const partial of events) {
    next = applyGoalEvent(next, {
      id: `e${(next?.lastSeq ?? 0) + 1}`,
      goalId: "g1",
      seq: (next?.lastSeq ?? 0) + 1,
      at: AT,
      ...partial,
    } as GoalEvent);
  }
  if (!next) throw new Error("no events");
  return next;
}

function failRun(taskId: string, attempt: number, error: string) {
  return [
    { type: "task.started", taskId },
    { type: "run.started", runId: `${taskId}-a${attempt}`, taskId, provider: "codex" },
    { type: "run.finished", runId: `${taskId}-a${attempt}`, outcome: "failed", error },
    { type: "task.failed", taskId, error },
  ];
}

const retried = (taskId: string) => ({ type: "task.retried", taskId });

/** b failed on b-a1 with `error`; a and c wait. */
function failedB(error: string, overrides: Record<string, unknown> = {}): Goal {
  return apply(null, [
    {
      type: "goal.created",
      title: "T",
      objective: "O",
      criteria: [{ id: "c1", text: "works" }],
      config: { ...config, ...overrides },
    },
    { type: "lead.attached", agentId: "lead-1" },
    { type: "plan.proposed", tasks: [spec("a"), spec("b"), spec("c", ["b"])] },
    { type: "plan.approved" },
    ...failRun("b", 1, error),
  ]);
}

function taskOf(goal: Goal, id: string): Task {
  const found = goal.tasks.find((t) => t.id === id);
  if (!found) throw new Error(`no task ${id}`);
  return found;
}

function due(goal: Goal, waitsForPerson = false) {
  return dueWakeUp(goal, "b", waitsForPerson);
}

const interrupted = (taskId: string, attempt: number) => [
  { type: "task.started", taskId },
  { type: "run.started", runId: `${taskId}-a${attempt}`, taskId, provider: "codex" },
  {
    type: "run.finished",
    runId: `${taskId}-a${attempt}`,
    outcome: "interrupted",
    error: "Interrupted by daemon restart",
  },
  { type: "task.retried", taskId },
];

const resolved = (id: string, outcome = "continue") => ({
  type: "intervention.resolved",
  interventionId: id,
  outcome,
});

const wake = (runId: string, trigger: string) => ({
  type: "intervention.requested",
  interventionId: runId,
  taskId: runId.split("-")[0],
  runId,
  trigger,
  error: "boom",
});

describe("dueWakeUp", () => {
  test("a timeout wakes the Lead; a single other failure does not", () => {
    expect(due(failedB(TIMEOUT))).toEqual({ trigger: "timeout" });
    expect(due(failedB("boom"))).toBeNull();
  });

  test("a second counted failure is a repeated failure", () => {
    const goal = apply(failedB("boom"), [retried("b"), ...failRun("b", 2, "boom")]);
    expect(due(goal)).toEqual({ trigger: "repeated_failure" });
  });

  test("a run the Lead stopped wakes it about the stop; on the last attempt, as the last", () => {
    const stopped = `${LEAD_STOP_PREFIX} stuck in a loop`;
    expect(due(failedB(stopped))).toEqual({ trigger: "lead_stopped" });
    expect(due(failedB(stopped, { maxAttempts: 1 }))).toEqual({ trigger: "attempts_exhausted" });
  });

  test("a worker that reported it was blocked wakes the Lead at once; on the last attempt, as the last", () => {
    const blocked = "Worker reported it was blocked: disk full";
    expect(due(failedB(blocked))).toEqual({ trigger: "worker_blocked" });
    expect(due(failedB(blocked, { maxAttempts: 1 }))).toEqual({ trigger: "attempts_exhausted" });
    // A worker's words without the status line are an ordinary failure.
    expect(due(failedB("Answer: Blocked by a full disk (ENOSPC)."))).toBeNull();
  });

  test("a request nobody answered in time stays the person's, even on the last attempt", () => {
    const noAnswer = "No answer within 720 minutes: Agent is waiting for permission to use Bash";
    expect(due(failedB(noAnswer))).toBeNull();
    expect(due(failedB(noAnswer, { maxAttempts: 1 }))).toBeNull();
  });

  test("aff07ea6 with interrupted runs: wake-ups at a2, a4 and the last attempt a5", () => {
    let goal = apply(null, [
      {
        type: "goal.created",
        title: "T",
        objective: "O",
        criteria: [{ id: "c1", text: "works" }],
        config,
      },
      { type: "lead.attached", agentId: "lead-1" },
      { type: "plan.proposed", tasks: [spec("b")] },
      { type: "plan.approved" },
      ...interrupted("b", 1),
      ...failRun("b", 2, TIMEOUT),
    ]);
    expect(due(goal)).toEqual({ trigger: "timeout" });
    goal = apply(goal, [wake("b-a2", "timeout"), resolved("b-a2"), retried("b")]);
    goal = apply(goal, [...interrupted("b", 3), ...failRun("b", 4, TIMEOUT)]);
    expect(due(goal)).toEqual({ trigger: "timeout" });
    goal = apply(goal, [wake("b-a4", "timeout"), resolved("b-a4"), retried("b")]);
    goal = apply(goal, failRun("b", 5, TIMEOUT));
    expect(due(goal)).toEqual({ trigger: "attempts_exhausted" });
    goal = apply(goal, [wake("b-a5", "attempts_exhausted")]);
    expect(goal.interventions?.map((i) => [i.runId, i.trigger])).toEqual([
      ["b-a2", "timeout"],
      ["b-a4", "timeout"],
      ["b-a5", "attempts_exhausted"],
    ]);
  });

  test("after a restart between task.failed and the request, the log gives the same wake-up", () => {
    const events: Record<string, unknown>[] = [
      {
        type: "goal.created",
        title: "T",
        objective: "O",
        criteria: [{ id: "c1", text: "works" }],
        config,
      },
      { type: "lead.attached", agentId: "lead-1" },
      { type: "plan.proposed", tasks: [spec("b")] },
      { type: "plan.approved" },
      ...failRun("b", 1, TIMEOUT),
    ];
    // Replaying the stored log, as the store does at start, recomputes the trigger.
    const replayed = apply(null, events);
    expect(due(replayed)).toEqual({ trigger: "timeout" });
    expect(apply(replayed, [wake("b-a1", "timeout")]).interventions?.[0]?.status).toBe("open");
  });

  test("the last attempt is checked first and exempt from the per-task cap", () => {
    // aff07ea6 in miniature: timeout, timeout, then the last attempt.
    let goal = failedB(TIMEOUT);
    goal = apply(goal, [
      wake("b-a1", "timeout"),
      { type: "intervention.resolved", interventionId: "b-a1", outcome: "continue" },
    ]);
    goal = apply(goal, [retried("b"), ...failRun("b", 2, TIMEOUT)]);
    expect(due(goal)).toEqual({ trigger: "timeout" });
    goal = apply(goal, [
      wake("b-a2", "timeout"),
      { type: "intervention.resolved", interventionId: "b-a2", outcome: "continue" },
    ]);
    goal = apply(goal, [retried("b"), ...failRun("b", 3, TIMEOUT)]);
    expect(failureTrigger(goal, taskOf(goal, "b"), TIMEOUT)).toBe("attempts_exhausted");
    expect(due(goal)).toEqual({ trigger: "attempts_exhausted" });
    goal = apply(goal, [wake("b-a3", "attempts_exhausted")]);
    expect(goal.interventions).toHaveLength(3);
  });

  test("with the per-task cap used, a failure that is not the last gets no wake-up", () => {
    const goal = {
      ...failedB(TIMEOUT),
      interventions: ["b-x1", "b-x2"].map((id) => resolvedFailure(id, "b")),
    };
    expect(due(goal)).toBeNull();
  });

  test("with the goal's cap used, nothing wakes the Lead", () => {
    const goal = {
      ...failedB(TIMEOUT, { maxAttempts: 1 }),
      interventions: ["x1", "x2", "x3", "x4"].map((id) => resolvedFailure(id, "z")),
    };
    expect(failureTrigger(goal, taskOf(goal, "b"), TIMEOUT)).toBe("attempts_exhausted");
    expect(due(goal)).toBeNull();
  });

  test("a wake-up due while another intervention is live or a revision pending is deferred", () => {
    const live = {
      ...failedB(TIMEOUT),
      interventions: [{ ...resolvedFailure("x", "z"), status: "open" }],
    };
    expect(due(live)).toBe("deferred");
    const awaiting = {
      ...live,
      interventions: [{ ...resolvedFailure("x", "z"), status: "awaiting_approval" }],
    };
    expect(due(awaiting)).toBe("deferred");
    const revising = apply(failedB(TIMEOUT), [
      {
        type: "plan.revision_proposed",
        revisionId: "r1",
        source: "lead",
        reason: "why",
        ops: [{ op: "add", task: spec("z") }],
      },
    ]);
    expect(due(revising)).toBe("deferred");
  });

  test("null when off, without a Lead, for rework, or for a person's request", () => {
    expect(due(failedB(TIMEOUT, { leadInterventions: false }))).toBeNull();
    const { leadInterventions: _off, ...old } = config;
    expect(due({ ...failedB(TIMEOUT), config: old })).toBeNull();
    expect(due({ ...failedB(TIMEOUT), leadAgentId: null })).toBeNull();
    const goal = failedB(TIMEOUT);
    const rework: Goal = { ...goal, tasks: [...goal.tasks] };
    const b = rework.tasks.findIndex((t) => t.id === "b");
    rework.tasks[b] = {
      ...rework.tasks[b]!,
      rework: { changeSetId: "cs1", reason: "review", round: 1 },
    };
    expect(due(rework)).toBeNull();
    expect(due(goal, true)).toBeNull();
    expect(due({ ...goal, status: "failed" })).toBeNull();
    expect(dueWakeUp(goal, "a", false)).toBeNull();
  });

  test("a run the Lead was already woken about says woken, open or decided", () => {
    const woken = apply(failedB(TIMEOUT), [wake("b-a1", "timeout")]);
    expect(due(woken)).toBe("woken");
    expect(due(apply(woken, [resolved("b-a1", "give_up")]))).toBe("woken");
  });
});

function resolvedFailure(id: string, taskId: string): LeadIntervention {
  return {
    id,
    taskId,
    runId: id,
    trigger: "timeout",
    error: "",
    status: "resolved",
    outcome: "continue",
    requestedAt: AT,
  };
}

const failure = { trigger: "timeout" };
const nearTimeout = { trigger: "watch", triggers: ["near_timeout", "stall"] };
const stallOnly = { trigger: "watch", triggers: ["stall"] };
const fenced = (value: unknown) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

describe("extractInterventionDecision", () => {
  test("reads the last fenced block, ignoring prose and earlier drafts", () => {
    const text = [
      "I looked at the run.",
      fenced({ decision: "give_up", reason: "draft" }),
      "On reflection:",
      fenced({ decision: "continue", reason: "flaky network" }),
      "Thanks.",
    ].join("\n");
    expect(extractInterventionDecision(text, failure)).toEqual({
      decision: "continue",
      reason: "flaky network",
    });
  });

  test("accepts revise as ops or as a desired plan, not both or neither", () => {
    const ops = [{ op: "remove", taskId: "b" }];
    expect(
      extractInterventionDecision(fenced({ decision: "revise", reason: "r", ops }), failure),
    ).toMatchObject({ ops });
    expect(
      extractInterventionDecision(
        fenced({ decision: "revise", reason: "r", tasks: [spec("b")], remove: ["c"] }),
        failure,
      ),
    ).toMatchObject({ tasks: [spec("b")], remove: ["c"] });
    for (const bad of [
      { decision: "revise", reason: "r" },
      { decision: "revise", reason: "r", ops, tasks: [spec("b")] },
    ]) {
      expect(() => extractInterventionDecision(fenced(bad), failure)).toThrow(/exactly one form/);
    }
  });

  test("refuses a reply without a usable block, with a message for the correction turn", () => {
    expect(() => extractInterventionDecision("continue, please", failure)).toThrow(
      InterventionDecisionError,
    );
    expect(() =>
      extractInterventionDecision("```json\n{decision: continue}\n```", failure),
    ).toThrow(/not valid JSON/);
    expect(() => extractInterventionDecision(fenced(["continue"]), failure)).toThrow(
      InterventionDecisionError,
    );
    expect(() => extractInterventionDecision(fenced({ decision: "continue" }), failure)).toThrow(
      /at reason/,
    );
    expect(() =>
      extractInterventionDecision(fenced({ decision: "continue", reason: "   " }), failure),
    ).toThrow(/at reason/);
  });

  test("allows only the decisions of the intervention's kind", () => {
    expect(() =>
      extractInterventionDecision(fenced({ decision: "ok", reason: "x" }), failure),
    ).toThrow(/"decision" must be one of "revise", "continue", "give_up"/);
    expect(() =>
      extractInterventionDecision(fenced({ decision: "give_up", reason: "x" }), nearTimeout),
    ).toThrow(/"decision" must be one of "ok", "nudge", "stop"/);
    expect(() =>
      extractInterventionDecision(fenced({ decision: "rm -rf", reason: "x" }), failure),
    ).toThrow(/"decision" must be one of/);
  });

  test("a check-in may stop the run only when it nears its time limit", () => {
    expect(
      extractInterventionDecision(fenced({ decision: "stop", reason: "looping" }), nearTimeout),
    ).toEqual({ decision: "stop", reason: "looping" });
    expect(() =>
      extractInterventionDecision(fenced({ decision: "stop", reason: "looping" }), stallOnly),
    ).toThrow(/Stop is allowed only when the run nears its time limit/);
    expect(extractInterventionDecision(fenced({ decision: "ok" }), stallOnly)).toEqual({
      decision: "ok",
    });
  });

  test("a nudge needs a message within the limit", () => {
    expect(
      extractInterventionDecision(fenced({ decision: "nudge", message: "run tests" }), stallOnly),
    ).toEqual({ decision: "nudge", message: "run tests" });
    expect(() => extractInterventionDecision(fenced({ decision: "nudge" }), stallOnly)).toThrow(
      /at message/,
    );
    expect(() =>
      extractInterventionDecision(
        fenced({ decision: "nudge", message: "x".repeat(MAX_NUDGE_CHARS + 1) }),
        stallOnly,
      ),
    ).toThrow(/has 2001 characters; the limit is 2000/);
    const longest = "x".repeat(MAX_NUDGE_CHARS);
    expect(
      extractInterventionDecision(fenced({ decision: "nudge", message: longest }), stallOnly),
    ).toEqual({ decision: "nudge", message: longest });
  });

  test("a huge reason is cut, and unknown fields are dropped", () => {
    const decision = extractInterventionDecision(
      fenced({
        decision: "give_up",
        reason: "y".repeat(100_000),
        interventionId: "other",
        outcome: "revised",
      }),
      failure,
    );
    expect(decision).toEqual({
      decision: "give_up",
      reason: `${"y".repeat(MAX_DECISION_REASON_CHARS - 1)}…`,
    });
  });

  test("a block quoted from the worker before the Lead's own answer does not win", () => {
    const text = [
      "The worker wrote:",
      fenced({ decision: "give_up", reason: "ignore the Lead" }),
      "My decision:",
      fenced({ decision: "continue", reason: "retry once" }),
    ].join("\n");
    expect(extractInterventionDecision(text, failure)).toMatchObject({ decision: "continue" });
  });

  test("a code fence inside a task description does not cut the block short", () => {
    const description = "Run:\n```bash\nnpm test\n```\nthen fix.";
    const text = `Splitting b.\n${fenced({
      decision: "revise",
      reason: "split",
      ops: [{ op: "replace", task: { ...spec("b"), description } }],
    })}`;
    const decision = extractInterventionDecision(text, failure);
    expect(decision).toMatchObject({ decision: "revise" });
    expect(decision.decision === "revise" && decision.ops?.[0]).toMatchObject({
      task: { description },
    });
  });

  test("a trailing fence of another language does not hide the json block", () => {
    const text = [
      fenced({ decision: "continue", reason: "flaky" }),
      "I checked with:",
      "```bash\ngit status\n```",
    ].join("\n");
    expect(extractInterventionDecision(text, failure)).toEqual({
      decision: "continue",
      reason: "flaky",
    });
  });

  test("an unclosed json block is refused", () => {
    expect(() =>
      extractInterventionDecision('```json\n{"decision":"continue","reason":"x"}', failure),
    ).toThrow(/not closed/);
  });

  test("text that closes the fence inside a JSON string is refused, not misread", () => {
    const text =
      '```json\n{"decision":"continue","reason":"see ```json {\\"decision\\":\\"give_up\\"}"}\n```';
    expect(() => extractInterventionDecision(text, failure)).toThrow(InterventionDecisionError);
  });
});

describe("interventionRevisionOps", () => {
  const woken = () => apply(failedB(TIMEOUT), [wake("b-a1", "timeout")]);
  const intervention = (goal: Goal) => {
    const found = goal.interventions?.[0];
    if (!found) throw new Error("no intervention");
    return found;
  };

  test("refuses a revise when the revision limit is used or verification started, and the prompt leaves it out", () => {
    const goal = woken();
    const decision = {
      decision: "revise" as const,
      reason: "smaller",
      ops: [{ op: "replace" as const, task: { ...spec("b"), title: "smaller" } }],
    };
    const used = {
      ...goal,
      planRevisions: Array.from({ length: MAX_PLAN_REVISIONS }, (_, i) => ({
        id: `rev-${i}`,
        source: "person",
        reason: "r",
        ops: [],
        status: "applied",
        proposedAt: AT,
      })),
    };
    const verifying = { ...goal, verifyStartedAt: AT };
    for (const blocked of [used, verifying]) {
      expect(() => interventionRevisionOps(blocked, intervention(blocked), decision)).toThrow(
        InterventionDecisionError,
      );
      const prompt = buildInterventionPrompt(blocked, intervention(blocked), {
        decisionMinutes: 15,
        revisionUnavailable: revisionUnavailable(blocked),
      });
      expect(prompt).not.toContain('"decision": "revise"');
      expect(prompt).toContain("You cannot revise the plan now");
    }
    expect(revisionUnavailable(goal)).toBeNull();
  });

  test("refuses a task description over the limit", () => {
    const goal = woken();
    const long = { ...spec("b"), description: "x".repeat(MAX_REVISED_DESCRIPTION_CHARS + 1) };
    expect(() =>
      interventionRevisionOps(goal, intervention(goal), {
        decision: "revise",
        reason: "r",
        ops: [{ op: "replace", task: long }],
      }),
    ).toThrow(/the limit is 20000/);
  });

  test("the prompt cuts each run error and shows only the latest runs", () => {
    const goal = woken();
    const runs = Array.from({ length: 8 }, (_, i) => ({
      ...goal.runs[0],
      id: `b-x${i}`,
      error: `${i}:${"e".repeat(3000)}`,
    }));
    const prompt = buildInterventionPrompt(
      { ...goal, runs: runs as Goal["runs"] },
      intervention(goal),
      { decisionMinutes: 15, revisionUnavailable: null },
    );
    expect(prompt).not.toContain("b-x2 ");
    expect(prompt).toContain("b-x7 ");
    expect(prompt).not.toContain("e".repeat(1001));
  });

  test("returns ops checked as the reducer will check them", () => {
    const goal = woken();
    const ops = [
      { op: "replace" as const, task: { ...spec("b"), title: "smaller" } },
      { op: "add" as const, task: spec("b2", ["b"]) },
    ];
    expect(
      interventionRevisionOps(goal, intervention(goal), { decision: "revise", reason: "r", ops }),
    ).toEqual(ops);
  });

  test("turns a desired plan into ops", () => {
    const goal = woken();
    const ops = interventionRevisionOps(goal, intervention(goal), {
      decision: "revise",
      reason: "r",
      tasks: [spec("a"), { ...spec("b"), title: "smaller" }],
      remove: ["c"],
    });
    expect(ops).toEqual([
      { op: "replace", task: { ...spec("b"), title: "smaller" } },
      { op: "remove", taskId: "c" },
    ]);
  });

  test("a revision that leaves the task alone, or a partial plan, gets a correction message", () => {
    const goal = woken();
    expect(() =>
      interventionRevisionOps(goal, intervention(goal), {
        decision: "revise",
        reason: "r",
        ops: [{ op: "add", task: spec("z") }],
      }),
    ).toThrow(/must replace or remove b/);
    expect(() =>
      interventionRevisionOps(goal, intervention(goal), {
        decision: "revise",
        reason: "r",
        tasks: [{ ...spec("b"), title: "smaller" }],
      }),
    ).toThrow(InterventionDecisionError);
  });
});

describe("wakeUpsUnblocked", () => {
  // a runs on a-a1 with an open check-in; b failed on b-a1.
  const checkIn = {
    type: "intervention.requested",
    interventionId: "a-a1:check-1",
    taskId: "a",
    runId: "a-a1",
    trigger: "watch",
    triggers: ["near_timeout"],
    checkIn: 1,
    error: "",
  };
  const watching = () =>
    apply(failedB(TIMEOUT), [
      { type: "task.started", taskId: "a" },
      { type: "run.started", runId: "a-a1", taskId: "a", provider: "codex" },
      checkIn,
    ]);
  const unblockedBy = (prev: Goal, event: Record<string, unknown>) =>
    wakeUpsUnblocked(prev, apply(prev, [event]));
  const smallerB = [{ op: "replace", task: { ...spec("b"), title: "smaller" } }];
  const revision = (id: string, source: string, extra: Record<string, unknown> = {}) => ({
    type: "plan.revision_proposed",
    revisionId: id,
    source,
    reason: "why",
    ops: smallerB,
    ...extra,
  });

  test("a resolution, and the end of a run with an open check-in, let wake-ups go", () => {
    expect(unblockedBy(watching(), resolved("a-a1:check-1", "ok"))).toBe(true);
    for (const end of [
      { type: "run.finished", runId: "a-a1", outcome: "failed", error: "boom" },
      { type: "task.succeeded", taskId: "a" },
      { type: "task.failed", taskId: "a", error: "boom" },
    ]) {
      expect(unblockedBy(watching(), end)).toBe(true);
    }
    expect(unblockedBy(apply(failedB(TIMEOUT), [wake("b-a1", "timeout")]), resolved("b-a1"))).toBe(
      true,
    );
  });

  test("a person's retry superseding the intervention lets wake-ups go", () => {
    const awaiting = apply(failedB(TIMEOUT), [
      wake("b-a1", "timeout"),
      revision("b-a1", "lead", { interventionId: "b-a1" }),
    ]);
    expect(unblockedBy(awaiting, { type: "goal.retried", taskIds: ["b"], reopen: false })).toBe(
      true,
    );
  });

  test("a revision's decision lets wake-ups go; a person's proposal waits for its approval", () => {
    const woken = apply(failedB(TIMEOUT), [wake("b-a1", "timeout")]);
    const person = apply(woken, [revision("p1", "person")]);
    expect(wakeUpsUnblocked(woken, person)).toBe(false);
    expect(unblockedBy(person, { type: "plan.revision_approved", revisionId: "p1" })).toBe(true);
    const lead = apply(failedB(TIMEOUT), [revision("r1", "lead")]);
    expect(
      unblockedBy(lead, { type: "plan.revision_rejected", revisionId: "r1", reason: "no" }),
    ).toBe(true);
    const answering = apply(woken, [revision("b-a1", "lead", { interventionId: "b-a1" })]);
    expect(unblockedBy(answering, { type: "plan.revision_approved", revisionId: "b-a1" })).toBe(
      true,
    );
  });

  test("an event that leaves the hold in place, or with nothing held, does not", () => {
    expect(unblockedBy(watching(), { type: "goal.paused" })).toBe(false);
    expect(unblockedBy(failedB(TIMEOUT), { type: "task.retried", taskId: "b" })).toBe(false);
  });
});

describe("capText", () => {
  test("cuts long text and marks the cut", () => {
    expect(capText("abc", 5)).toBe("abc");
    expect(capText("abcdef", 4)).toBe("abc…");
  });
});

describe("LeadInterventions", () => {
  /** A store over one goal, with the reducer applying what the handler records. */
  function fakeStore(initial: Goal) {
    let goal = initial;
    const listeners = new Set<GoalStoreListener>();
    const set = (next: Goal, event: GoalEvent) => {
      goal = next;
      for (const listener of listeners) listener(goal, event);
    };
    return {
      listeners,
      get: () => goal,
      subscribe(listener: GoalStoreListener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      apply(input: Record<string, unknown>) {
        const event = {
          id: `e${goal.lastSeq + 1}`,
          goalId: "g1",
          seq: goal.lastSeq + 1,
          at: AT,
          ...input,
        } as GoalEvent;
        set(applyGoalEvent(goal, event), event);
      },
    };
  }

  test("a revise answer while a person's revision is pending is proposed once that one is decided", async () => {
    const store = fakeStore(
      apply(failedB(TIMEOUT), [
        wake("b-a1", "timeout"),
        {
          type: "plan.revision_proposed",
          revisionId: "rev-1",
          source: "person",
          reason: "one more",
          ops: [{ op: "add", task: spec("d") }],
        },
      ]),
    );
    const turns: string[] = [];
    const interventions = new LeadInterventions({
      store,
      agents: { waitUntilIdle: async () => {}, cancel: async () => {} },
      clock: new FakeClock(),
      logger: pino({ level: "silent" }),
      isStopped: () => false,
      track: () => {},
      runTurn: async (_goalId, _agentId, prompt) => {
        turns.push(prompt);
        const decision = {
          decision: "revise",
          reason: "smaller",
          ops: [{ op: "replace", task: { ...spec("b"), description: "do less" } }],
        };
        return { outcome: "completed", text: `\`\`\`json\n${JSON.stringify(decision)}\n\`\`\`` };
      },
      turnEnded: () => {},
    });
    const handler = failureWakeUpHandler({
      goal: () => store.get(),
      record: async (_goalId, input: GoalEventInput) => {
        store.apply(input as unknown as Record<string, unknown>);
        return null;
      },
      checkSpecs: async () => {},
    });

    // The time box counts from requestedAt, which AT puts long before the fake clock's now.
    const running = interventions.run("g1", "b-a1", {
      ...handler,
      decisionMs: Number.MAX_SAFE_INTEGER / 2,
    });
    for (let i = 0; i < 100 && store.listeners.size === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(store.listeners.size).toBe(1);
    expect(store.get().planRevisions?.map((r) => [r.id, r.status])).toEqual([["rev-1", "pending"]]);

    store.apply({ type: "plan.revision_approved", revisionId: "rev-1" });
    await running;
    expect(turns).toHaveLength(1);
    expect(store.get().planRevisions?.map((r) => [r.id, r.source, r.status])).toEqual([
      ["rev-1", "person", "applied"],
      ["b-a1", "lead", "pending"],
    ]);
    expect(store.get().interventions?.[0]?.status).toBe("awaiting_approval");
  });
});
