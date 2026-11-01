import type { PlanRevision } from "@getpaseo/protocol/goal/types";
import { describe, expect, it } from "vitest";
import { decidedPlanRevisions, pendingPlanRevision, revisionOpRows } from "./goal-plan-revisions";
import { FIXTURE_AT, makeGoal, makeTask } from "./test-utils/goal-fixture";

function revision(id: string, overrides: Partial<PlanRevision> = {}): PlanRevision {
  return {
    id,
    source: "lead",
    reason: "",
    ops: [],
    status: "applied",
    proposedAt: FIXTURE_AT,
    ...overrides,
  };
}

const goal = makeGoal({
  status: "executing",
  tasks: [
    makeTask("t7", { title: "Capture screenshots", status: "failed", dependsOn: ["t1"] }),
    makeTask("t8", { title: "Write docs" }),
  ],
});

describe("pendingPlanRevision and decidedPlanRevisions", () => {
  it("splits the revision waiting for you from the decided ones, newest first", () => {
    const withRevisions = makeGoal({
      planRevisions: [
        revision("rev-a"),
        revision("rev-b", { status: "rejected" }),
        revision("rev-c", { status: "pending" }),
      ],
    });
    expect(pendingPlanRevision(withRevisions)?.id).toBe("rev-c");
    expect(decidedPlanRevisions(withRevisions).map((entry) => entry.id)).toEqual([
      "rev-b",
      "rev-a",
    ]);
  });

  it("reads a goal without revisions as none", () => {
    expect(pendingPlanRevision(makeGoal())).toBeNull();
    expect(decidedPlanRevisions(makeGoal())).toEqual([]);
  });
});

describe("revisionOpRows", () => {
  const ops = [
    {
      op: "replace" as const,
      task: {
        id: "t7",
        title: "Capture the home screen",
        description: "Only the home screen",
        kind: "implement" as const,
        dependsOn: ["t1"],
        runTimeoutMinutes: 30,
      },
    },
    {
      op: "add" as const,
      task: {
        id: "t7b",
        title: "Capture settings",
        description: "",
        kind: "implement" as const,
        dependsOn: ["t7"],
      },
    },
    { op: "remove" as const, taskId: "t8" },
  ];

  it("reads a pending revision against the current plan", () => {
    expect(revisionOpRows(goal, ops, { compare: true })).toEqual([
      {
        kind: "replace",
        taskId: "t7",
        title: "Capture the home screen",
        previousTitle: "Capture screenshots",
        changed: ["description", "runTimeoutMinutes"],
        dependsOn: ["t1"],
      },
      {
        kind: "add",
        taskId: "t7b",
        title: "Capture settings",
        previousTitle: null,
        changed: [],
        dependsOn: ["t7"],
      },
      {
        kind: "remove",
        taskId: "t8",
        title: "Write docs",
        previousTitle: null,
        changed: [],
        dependsOn: [],
      },
    ]);
  });

  it("does not compare an applied revision with the plan it already changed", () => {
    const [replace] = revisionOpRows(goal, ops, { compare: false });
    expect(replace).toMatchObject({ kind: "replace", previousTitle: null, changed: [] });
  });

  it("ignores the order of dependencies and names a removed task it cannot find by id", () => {
    const reordered = makeGoal({
      tasks: [makeTask("t9", { title: "Same", dependsOn: ["a", "b"] })],
    });
    const rows = revisionOpRows(
      reordered,
      [
        {
          op: "replace",
          task: {
            id: "t9",
            title: "Same",
            description: "",
            kind: "implement",
            dependsOn: ["b", "a"],
          },
        },
        { op: "remove", taskId: "gone" },
      ],
      { compare: true },
    );
    expect(rows[0]?.changed).toEqual([]);
    expect(rows[1]?.title).toBe("gone");
  });
});
