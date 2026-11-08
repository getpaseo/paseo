import { describe, expect, test } from "vitest";
import {
  acceptNoteProblem,
  acceptRefusal,
  canAcceptGoal,
  criteriaToWaive,
  waivedCriteria,
} from "./acceptance.js";
import type { Goal } from "./types.js";

const AT = "2026-10-27T09:00:00.000Z";

function goal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "g1",
    title: "Ship",
    objective: "obj",
    status: "failed",
    config: { cwd: "/repo", leadProvider: "claude", defaultProvider: "codex" },
    leadAgentId: null,
    leadWorkspaceId: null,
    tasks: [
      {
        id: "a",
        title: "a",
        description: "",
        kind: "implement",
        dependsOn: [],
        status: "succeeded",
        attempts: 1,
        summary: "ok",
        error: null,
        captured: true,
      },
    ],
    runs: [],
    changeSets: [],
    integration: null,
    criteria: [
      { id: "c1", text: "works", verifiedAt: null, evidence: null },
      { id: "c2", text: "fast", verifiedAt: AT, evidence: "ok" },
    ],
    lastSeq: 9,
    failureReason: "Acceptance criteria not met: works (500)",
    failedAt: AT,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  } as Goal;
}

describe("accepting a failed goal as is", () => {
  test("is offered only when every task succeeded and all work is merged", () => {
    expect(acceptRefusal(goal())).toBeNull();
    expect(canAcceptGoal(goal())).toBe(true);
    expect(acceptRefusal(goal({ status: "completed" }))).toMatch(/only a failed goal/);
    expect(acceptRefusal(goal({ config: null }))).toMatch(/manual/);
    expect(acceptRefusal(goal({ archivedAt: AT }))).toMatch(/archived/);
    expect(acceptRefusal(goal({ tasks: [] }))).toMatch(/before it had a plan/);
    const [done] = goal().tasks;
    const failedTask = [{ ...done, status: "failed" }] as Goal["tasks"];
    expect(acceptRefusal(goal({ tasks: failedTask }))).toBe("tasks not succeeded: a");
    const uncaptured = [{ ...done, captured: false }] as Goal["tasks"];
    expect(acceptRefusal(goal({ tasks: uncaptured }))).toBe("work not captured for: a");
    const reworkFailed = [
      { id: "cs-a", taskId: "a", status: "rejected", rejectionReason: "rework_failed" },
    ] as unknown as Goal["changeSets"];
    expect(acceptRefusal(goal({ changeSets: reworkFailed }))).toBe("change sets not merged: cs-a");
    const deciding = {
      id: "rec-9",
      status: "deciding",
      startedAt: AT,
      startedBy: "person",
      failureReason: "x",
    };
    expect(acceptRefusal(goal({ recovery: deciding }))).toBe(
      "recovery rec-9 is still deciding; cancel it first",
    );
  });

  test("criteria the verifier judged unmet are not met; others were never checked", () => {
    expect(criteriaToWaive(goal())).toEqual({
      notMet: [{ id: "c1", text: "works", verifiedAt: null, evidence: null }],
      neverChecked: [],
    });
    const timedOut = criteriaToWaive(goal({ failureReason: "Time limit of 60 minutes reached" }));
    expect(timedOut.notMet).toEqual([]);
    expect(timedOut.neverChecked.map((c) => c.id)).toEqual(["c1"]);
  });

  test("after a recovery ended for a person, the goal's original failure decides the group", () => {
    const ended = goal({
      failureReason: "Recovery needs a person: c1 needs a person",
      recovery: {
        id: "rec-9",
        status: "ended",
        outcome: "needs_person",
        startedAt: AT,
        startedBy: "person",
        failureReason: "Acceptance criteria not met: works (500)",
        resolvedAt: AT,
      },
    });
    expect(criteriaToWaive(ended).notMet.map((c) => c.id)).toEqual(["c1"]);
  });

  test("lists the waived criteria and checks the note", () => {
    const accepted = goal({
      status: "completed",
      criteria: [
        {
          id: "c1",
          text: "works",
          verifiedAt: null,
          evidence: null,
          waived: { at: AT, note: "x" },
        },
        { id: "c2", text: "fast", verifiedAt: AT, evidence: "ok" },
      ],
    });
    expect(waivedCriteria(accepted).map((c) => c.id)).toEqual(["c1"]);
    expect(acceptNoteProblem("  ")).toBe("empty");
    expect(acceptNoteProblem("x".repeat(2001))).toBe("too_long");
    expect(acceptNoteProblem(` ${"x".repeat(2000)} `)).toBeNull();
  });
});
