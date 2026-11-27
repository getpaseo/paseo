import { MAX_ACCEPT_NOTE_CHARS, type Goal } from "@getpaseo/protocol/goal/types";
import { describe, expect, it } from "vitest";
import {
  acceptCriterionIds,
  acceptGroups,
  acceptNoteState,
  acceptedWaivedCount,
  canAccept,
  criterionState,
} from "./goal-accept";
import { FIXTURE_AT, makeGoal, makeTask } from "./test-utils/goal-fixture";

const criteria: Goal["criteria"] = [
  { id: "c1", text: "UV-02 is fixed", verifiedAt: null, evidence: null },
  { id: "c2", text: "Docs updated", verifiedAt: FIXTURE_AT, evidence: "ok" },
  { id: "c3", text: "Logs are quiet", verifiedAt: null, evidence: null },
];

function failedGoal(overrides: Partial<Goal> = {}): Goal {
  return makeGoal({
    status: "failed",
    failedAt: FIXTURE_AT,
    failureReason: "Acceptance criteria not met: c1, c3",
    tasks: [makeTask("t1", { status: "succeeded", captured: true })],
    criteria,
    ...overrides,
  });
}

describe("canAccept", () => {
  it("needs the host feature and a goal the daemon would accept", () => {
    expect(canAccept(failedGoal(), true)).toBe(true);
    expect(canAccept(failedGoal(), false)).toBe(false);
  });

  it("refuses a goal that failed before it had a plan, or that is not failed", () => {
    expect(canAccept(failedGoal({ tasks: [] }), true)).toBe(false);
    expect(canAccept(failedGoal({ status: "completed" }), true)).toBe(false);
  });
});

describe("acceptGroups", () => {
  it("puts the unverified criteria under Not met when verification judged them", () => {
    expect(acceptGroups(failedGoal())).toEqual([
      { kind: "notMet", criteria: [criteria[0], criteria[2]] },
    ]);
  });

  it("puts them under Never checked when the goal failed another way", () => {
    expect(acceptGroups(failedGoal({ failureReason: "Goal timed out" }))).toEqual([
      { kind: "neverChecked", criteria: [criteria[0], criteria[2]] },
    ]);
  });

  it("is empty when every criterion was verified", () => {
    const verified = criteria.map((criterion) => ({ ...criterion, verifiedAt: FIXTURE_AT }));
    expect(acceptGroups(failedGoal({ criteria: verified }))).toEqual([]);
  });
});

describe("acceptCriterionIds", () => {
  it("sends every unverified criterion", () => {
    expect(acceptCriterionIds(failedGoal())).toEqual(["c1", "c3"]);
    expect(acceptCriterionIds(failedGoal({ failureReason: "Goal timed out" }))).toEqual([
      "c1",
      "c3",
    ]);
  });
});

describe("acceptNoteState", () => {
  it("needs a note, without an error while it is empty", () => {
    expect(acceptNoteState("")).toEqual({ canConfirm: false, tooLong: false });
    expect(acceptNoteState("   \n")).toEqual({ canConfirm: false, tooLong: false });
  });

  it("accepts a note within the limit once trimmed", () => {
    expect(acceptNoteState("  Good enough for now  ")).toEqual({
      canConfirm: true,
      tooLong: false,
    });
    expect(acceptNoteState(`${"x".repeat(MAX_ACCEPT_NOTE_CHARS)}  `).canConfirm).toBe(true);
  });

  it("says a note over the limit is too long", () => {
    expect(acceptNoteState("x".repeat(MAX_ACCEPT_NOTE_CHARS + 1))).toEqual({
      canConfirm: false,
      tooLong: true,
    });
  });
});

describe("acceptedWaivedCount", () => {
  it("is null for a goal nobody accepted", () => {
    expect(acceptedWaivedCount(makeGoal({ status: "completed", criteria }))).toBeNull();
  });

  it("counts the waived criteria of an accepted goal", () => {
    const waived = { at: FIXTURE_AT, note: "Good enough" };
    const goal = makeGoal({
      status: "completed",
      accepted: {
        at: FIXTURE_AT,
        note: "Good enough",
        from: "Acceptance criteria not met: c1, c3",
        client: "app",
      },
      criteria: [{ ...criteria[0], waived }, criteria[1], { ...criteria[2], waived }],
    });
    expect(acceptedWaivedCount(goal)).toBe(2);
  });
});

describe("criterionState", () => {
  it("tells verified, waived and unverified apart", () => {
    expect(criterionState(criteria[1])).toBe("verified");
    expect(criterionState({ ...criteria[0], waived: { at: FIXTURE_AT, note: "ok" } })).toBe(
      "waived",
    );
    expect(criterionState(criteria[0])).toBe("unverified");
  });
});
