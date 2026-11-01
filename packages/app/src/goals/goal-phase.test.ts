import { describe, expect, it } from "vitest";
import {
  goalControlsAvailable,
  goalFailedOnPermission,
  goalFailedOnQuestion,
  goalGuidance,
  goalPhase,
  goalRetryLabelKey,
  goalSteps,
} from "./goal-phase";
import { makeChangeSet, makeGoal, makeRun, makeTask } from "./test-utils/goal-fixture";

function states(goal: Parameters<typeof goalSteps>[0]): string[] | undefined {
  return goalSteps(goal)?.map((step) => `${step.id}:${step.state}`);
}

describe("goalPhase", () => {
  it("follows the goal status before work starts", () => {
    expect(goalPhase(makeGoal({ status: "planning" }))).toBe("planning");
    expect(goalPhase(makeGoal({ status: "awaiting_plan_approval" }))).toBe("plan_review");
    expect(goalPhase(makeGoal({ status: "planning", config: null }))).toBe("manual");
  });

  it("names the furthest-behind work while executing", () => {
    const executing = { status: "executing" as const };
    expect(
      goalPhase(makeGoal({ ...executing, tasks: [makeTask("t1", { status: "running" })] })),
    ).toBe("working");
    expect(
      goalPhase(
        makeGoal({
          ...executing,
          tasks: [makeTask("t1", { status: "running" })],
          changeSets: [makeChangeSet("c", "t0", { status: "awaiting_human" })],
        }),
      ),
    ).toBe("change_review");
    expect(
      goalPhase(
        makeGoal({
          ...executing,
          tasks: [makeTask("t1", { status: "succeeded" })],
          changeSets: [makeChangeSet("c", "t1", { status: "in_review" })],
        }),
      ),
    ).toBe("reviewing");
    expect(
      goalPhase(
        makeGoal({
          ...executing,
          tasks: [makeTask("t1", { status: "succeeded" })],
          changeSets: [makeChangeSet("c", "t1", { status: "integrating" })],
        }),
      ),
    ).toBe("integrating");
    expect(
      goalPhase(
        makeGoal({
          ...executing,
          tasks: [makeTask("t1", { status: "succeeded" })],
          changeSets: [makeChangeSet("c", "t1", { status: "integrated" })],
        }),
      ),
    ).toBe("verifying");
  });

  it("reports a paused goal as paused", () => {
    expect(goalPhase(makeGoal({ status: "executing", pausedAt: "2026-10-21T00:00:00Z" }))).toBe(
      "paused",
    );
  });
});

describe("goalSteps", () => {
  it("has no steps for a manual goal", () => {
    expect(goalSteps(makeGoal({ config: null }))).toBeNull();
  });

  it("marks earlier steps done and the current one", () => {
    expect(states(makeGoal({ status: "awaiting_plan_approval" }))).toEqual([
      "planning:done",
      "plan_review:current",
      "working:upcoming",
      "review:upcoming",
      "integrating:upcoming",
      "done:upcoming",
    ]);
  });

  it("completes every step", () => {
    expect(goalSteps(makeGoal({ status: "completed" }))?.every((s) => s.state === "done")).toBe(
      true,
    );
  });

  it("stops at the step an ended goal reached", () => {
    expect(states(makeGoal({ status: "cancelled" }))?.[0]).toBe("planning:stopped");
    expect(states(makeGoal({ status: "cancelled", tasks: [makeTask("t1")] }))?.[1]).toBe(
      "plan_review:stopped",
    );
    const failedWhileWorking = makeGoal({
      status: "failed",
      tasks: [makeTask("t1", { status: "failed" })],
      runs: [makeRun("r1", "t1", { status: "failed" })],
    });
    expect(states(failedWhileWorking)?.slice(1, 4)).toEqual([
      "plan_review:done",
      "working:stopped",
      "review:upcoming",
    ]);
  });
});

describe("goalGuidance", () => {
  it("asks for the changes held for approval", () => {
    const guidance = goalGuidance(
      makeGoal({
        status: "executing",
        tasks: [makeTask("t1", { status: "succeeded" })],
        changeSets: [
          makeChangeSet("a", "t1", { status: "awaiting_human" }),
          makeChangeSet("b", "t1", { status: "awaiting_human" }),
        ],
      }),
    );
    expect(guidance).toEqual({
      phase: "change_review",
      tone: "warning",
      params: { running: 0, total: 1, held: 2, branch: "paseo-goal/goal-1" },
    });
  });
});

describe("goalControlsAvailable", () => {
  const plan = makeGoal({ status: "awaiting_plan_approval" });

  it("offers nothing without host support or for a manual goal", () => {
    expect(Object.values(goalControlsAvailable(plan, false)).some(Boolean)).toBe(false);
    expect(
      Object.values(goalControlsAvailable({ ...plan, config: null }, true)).some(Boolean),
    ).toBe(false);
  });

  it("allows sending a plan back up to the daemon's limit", () => {
    expect(goalControlsAvailable(plan, true).canRejectPlan).toBe(true);
    const rejection = { reason: "", tasks: [], at: "2026-10-21T00:00:00Z" };
    const exhausted = { ...plan, planRejections: Array.from({ length: 5 }, () => rejection) };
    expect(goalControlsAvailable(exhausted, true).canRejectPlan).toBe(false);
  });

  it("pauses a live goal and resumes a paused one", () => {
    const running = makeGoal({ status: "executing" });
    expect(goalControlsAvailable(running, true)).toMatchObject({
      canPause: true,
      canResume: false,
      canRetryTasks: true,
    });
    expect(
      goalControlsAvailable({ ...running, pausedAt: "2026-10-21T00:00:00Z" }, true),
    ).toMatchObject({ canPause: false, canResume: true });
    expect(goalControlsAvailable(makeGoal({ status: "completed" }), true).canPause).toBe(false);
  });

  const failedTask = [makeTask("t1", { status: "failed" })];

  it("retries a failed goal unless a change was rejected", () => {
    const failed = makeGoal({ status: "failed", tasks: failedTask });
    expect(goalControlsAvailable(failed, true).canRetry).toBe(true);
    const rejected = {
      ...failed,
      changeSets: [makeChangeSet("c", "t1", { status: "rejected" })],
    };
    expect(goalControlsAvailable(rejected, true).canRetry).toBe(false);
  });

  it("does not retry an archived failed goal until it is unarchived", () => {
    const archived = makeGoal({
      status: "failed",
      tasks: failedTask,
      archivedAt: "2026-10-22T00:00:00Z",
    });
    expect(goalControlsAvailable(archived, true).canRetry).toBe(false);
    expect(goalControlsAvailable({ ...archived, archivedAt: null }, true).canRetry).toBe(true);
  });
});

describe("retrying a failed merge", () => {
  const tasks = [makeTask("t1", { status: "succeeded" })];
  const mergeFailed = makeChangeSet("c1", "t1", {
    status: "rejected",
    rejectionReason: "integration_failed",
  });
  const failedMerge = makeGoal({ status: "failed", tasks, changeSets: [mergeFailed] });

  it("is offered as a merge retry only by a host that merges it again", () => {
    expect(goalControlsAvailable(failedMerge, true)).toMatchObject({
      canRetry: false,
      canRetryMerge: false,
    });
    const controls = goalControlsAvailable(failedMerge, true, { integrationRetry: true });
    expect(controls).toMatchObject({ canRetry: true, canRetryMerge: true });
    expect(goalRetryLabelKey(controls)).toBe("goals.detail.retryMerge");
  });

  it("is not offered when a change set was rejected by review, or while archived", () => {
    const reviewRejected = makeChangeSet("c2", "t1", { status: "rejected" });
    const both = { ...failedMerge, changeSets: [mergeFailed, reviewRejected] };
    expect(goalControlsAvailable(both, true, { integrationRetry: true }).canRetry).toBe(false);
    const archived = { ...failedMerge, archivedAt: "2026-10-22T00:00:00Z" };
    expect(goalControlsAvailable(archived, true, { integrationRetry: true }).canRetry).toBe(false);
  });

  it("labels a plain task retry as such", () => {
    const failed = makeGoal({ status: "failed", tasks: [makeTask("t1", { status: "failed" })] });
    expect(goalRetryLabelKey(goalControlsAvailable(failed, true, { integrationRetry: true }))).toBe(
      "goals.detail.retryGoal",
    );
  });
});

describe("retrying a failed rework", () => {
  const tasks = [makeTask("t1", { status: "succeeded" }), makeTask("t1-rw1", { status: "failed" })];
  const reworkFailed = makeChangeSet("c1", "t1", {
    status: "rejected",
    rejectionReason: "rework_failed",
  });
  const failedRework = makeGoal({ status: "failed", tasks, changeSets: [reworkFailed] });

  it("is offered only by a host that reworks it again, labelled as a task retry", () => {
    expect(goalControlsAvailable(failedRework, true).canRetry).toBe(false);
    expect(goalControlsAvailable(failedRework, true, { integrationRetry: true }).canRetry).toBe(
      false,
    );
    const controls = goalControlsAvailable(failedRework, true, { reworkRetry: true });
    expect(controls).toMatchObject({ canRetry: true, canRetryMerge: false });
    expect(goalRetryLabelKey(controls)).toBe("goals.detail.retryGoal");
  });

  it("is not offered when another change set was rejected by review or hit the rework limit", () => {
    for (const rejectionReason of [undefined, "rework_limit"]) {
      const final = makeChangeSet("c2", "t1", { status: "rejected", rejectionReason });
      const both = { ...failedRework, changeSets: [reworkFailed, final] };
      expect(goalControlsAvailable(both, true, { reworkRetry: true }).canRetry).toBe(false);
    }
  });
});

describe("retrying a goal that failed while planning", () => {
  const failedPlanning = makeGoal({ status: "failed", tasks: [] });

  it("is offered as a planning retry only by a host that can reopen it", () => {
    expect(goalControlsAvailable(failedPlanning, true)).toMatchObject({
      canRetry: false,
      canRetryPlanning: false,
    });
    expect(goalControlsAvailable(failedPlanning, true, { configEdit: true })).toMatchObject({
      canRetry: true,
      canRetryPlanning: true,
    });
  });

  it("keeps the task retry for a goal that has a plan", () => {
    const failed = makeGoal({ status: "failed", tasks: [makeTask("t1", { status: "failed" })] });
    expect(goalControlsAvailable(failed, true, { configEdit: true })).toMatchObject({
      canRetry: true,
      canRetryPlanning: false,
    });
  });

  it("is not offered while archived or without goal controls", () => {
    const archived = { ...failedPlanning, archivedAt: "2026-10-22T00:00:00Z" };
    expect(goalControlsAvailable(archived, true, { configEdit: true }).canRetry).toBe(false);
    expect(goalControlsAvailable(failedPlanning, false, { configEdit: true }).canRetry).toBe(false);
  });
});

describe("goalFailedOnPermission", () => {
  it("recognises the outcome the daemon names when the Lead stops on a permission", () => {
    expect(
      goalFailedOnPermission({
        status: "failed",
        failureReason: "Lead agent did not finish planning (needs_permission).",
      }),
    ).toBe(true);
  });

  it("ignores other failures and goals that did not fail", () => {
    expect(
      goalFailedOnPermission({
        status: "failed",
        failureReason: "Lead agent did not finish planning (canceled).",
      }),
    ).toBe(false);
    expect(goalFailedOnPermission({ status: "failed", failureReason: null })).toBe(false);
    expect(goalFailedOnPermission({ status: "executing", failureReason: "needs_permission" })).toBe(
      false,
    );
  });
});

describe("goalFailedOnQuestion", () => {
  const question =
    "No task can make progress. Failed or blocked: a. Task a stopped on a request " +
    '(needs_permission): Agent asked a question and the goal\'s permission policy (fail) cannot answer it: "Configure or skip?". ' +
    "Change the policy to wait or auto, or resolve what triggers the question, then retry.";

  it("tells a task that stopped on a question from one that stopped on a permission", () => {
    expect(goalFailedOnPermission({ status: "failed", failureReason: question })).toBe(true);
    expect(goalFailedOnQuestion({ status: "failed", failureReason: question })).toBe(true);
    const permission =
      "No task can make progress. Failed or blocked: a. Task a stopped on a request " +
      '(needs_permission): Agent is waiting for permission to use Bash: "git push"';
    expect(goalFailedOnPermission({ status: "failed", failureReason: permission })).toBe(true);
    expect(goalFailedOnQuestion({ status: "failed", failureReason: permission })).toBe(false);
  });
});
