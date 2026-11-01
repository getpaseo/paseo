import { describe, expect, test } from "vitest";
import type { ChangeSet, Goal, Task } from "./types.js";
import { describeGoalWaitingOn } from "./waiting-on.js";

const base: Goal = {
  id: "g",
  title: "T",
  objective: "",
  status: "executing",
  config: {
    cwd: "/repo",
    leadProvider: "claude",
    defaultProvider: "codex",
    maxParallel: 2,
    maxAttempts: 2,
    autoApprovePlan: false,
    notifyLead: true,
  },
  leadAgentId: null,
  leadWorkspaceId: null,
  criteria: [],
  tasks: [],
  runs: [],
  changeSets: [],
  integration: null,
  lastSeq: 1,
  failureReason: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const task = (id: string, status: Task["status"]): Task => ({
  id,
  title: `Task ${id}`,
  description: "",
  kind: "implement",
  dependsOn: [],
  status,
  attempts: 1,
  error: null,
  summary: null,
});

const changeSet = (id: string, status: ChangeSet["status"]) => ({ id, status }) as ChangeSet;

describe("describeGoalWaitingOn", () => {
  test("names what a live goal waits for, most pressing first", () => {
    expect(describeGoalWaitingOn({ ...base, status: "completed" })).toBeNull();
    expect(describeGoalWaitingOn({ ...base, pausedAt: "x" })?.kind).toBe("paused");
    expect(describeGoalWaitingOn({ ...base, status: "planning" })?.label).toBe("the Lead's plan");
    expect(describeGoalWaitingOn({ ...base, status: "awaiting_plan_approval" })?.label).toBe(
      "plan approval",
    );
    expect(
      describeGoalWaitingOn({
        ...base,
        tasks: [task("a", "running")],
        changeSets: [changeSet("cs1", "awaiting_human")],
      })?.label,
    ).toBe("change set approval: cs1");
    expect(
      describeGoalWaitingOn({
        ...base,
        tasks: [task("a", "running"), task("b", "failed")],
        planRevisions: [
          {
            id: "rev-1",
            source: "lead",
            reason: "split b",
            ops: [{ op: "remove", taskId: "b" }],
            status: "pending",
            proposedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    ).toEqual({
      kind: "plan_revision_approval",
      label: "approval of a plan change",
      key: "goals.waitingOn.planRevisionApproval",
      params: {},
    });
    const intervention = (trigger: string, status: string) => ({
      id: "x",
      taskId: trigger === "watch" ? "a" : "b",
      runId: trigger === "watch" ? "a-a1" : "b-a1",
      trigger,
      error: "",
      status,
      requestedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(
      describeGoalWaitingOn({
        ...base,
        tasks: [task("a", "running"), task("b", "failed")],
        interventions: [intervention("timeout", "open")],
      }),
    ).toEqual({
      kind: "lead_decision",
      label: "the Lead's decision about b",
      key: "goals.waitingOn.leadDecision",
      params: { count: 1, ids: "b", title: "Task b" },
    });
    // A check-in on a running task, or a decided wake-up, holds nothing.
    for (const interventions of [
      [intervention("watch", "open")],
      [intervention("timeout", "resolved")],
    ]) {
      expect(
        describeGoalWaitingOn({ ...base, tasks: [task("a", "running")], interventions })?.kind,
      ).toBe("running");
    }
    expect(describeGoalWaitingOn({ ...base, tasks: [task("a", "running")] })?.label).toBe(
      "running task a (Task a)",
    );
    expect(
      describeGoalWaitingOn({
        ...base,
        tasks: [task("a", "succeeded")],
        changeSets: [changeSet("cs1", "in_review")],
      })?.kind,
    ).toBe("review");
    expect(describeGoalWaitingOn({ ...base, tasks: [task("a", "failed")] })?.kind).toBe("retry");
    expect(describeGoalWaitingOn({ ...base, tasks: [task("a", "succeeded")] })?.kind).toBe(
      "verification",
    );
  });

  test("pairs every English label with a translation key and its params", () => {
    expect(describeGoalWaitingOn({ ...base, tasks: [task("a", "running")] })).toEqual({
      kind: "running",
      label: "running task a (Task a)",
      key: "goals.waitingOn.runningTask",
      params: { count: 1, ids: "a", title: "Task a", tasks: "a (Task a)" },
    });
    expect(
      describeGoalWaitingOn({ ...base, tasks: [task("a", "running"), task("b", "running")] }),
    ).toMatchObject({
      label: "running tasks a (Task a), b (Task b)",
      key: "goals.waitingOn.runningTask",
      params: { count: 2, ids: "a, b", title: "Task a" },
    });
    expect(
      describeGoalWaitingOn({
        ...base,
        tasks: [task("a", "succeeded")],
        changeSets: [changeSet("cs1", "approved"), changeSet("cs2", "integrating")],
      }),
    ).toEqual({
      kind: "merge",
      label: "merge of cs1, cs2",
      key: "goals.waitingOn.merge",
      params: { count: 2, ids: "cs1, cs2" },
    });
    expect(describeGoalWaitingOn({ ...base, pausedAt: "x" })).toEqual({
      kind: "paused",
      label: "resume (paused)",
      key: "goals.waitingOn.paused",
      params: {},
    });
    expect(describeGoalWaitingOn({ ...base, status: "planning", config: null })?.key).toBe(
      "goals.waitingOn.manualPlan",
    );
    expect(describeGoalWaitingOn({ ...base, tasks: [task("a", "pending")] })).toMatchObject({
      label: "starting task a (Task a)",
      key: "goals.waitingOn.startingTask",
      params: { count: 1, title: "Task a" },
    });
    expect(describeGoalWaitingOn({ ...base, tasks: [task("a", "failed")] })?.key).toBe(
      "goals.waitingOn.retry",
    );
  });
});
