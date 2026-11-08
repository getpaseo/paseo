import { describe, expect, it } from "vitest";
import {
  buildGoalListSections,
  canAcknowledgeGoal,
  countGoalsBlockedOnUser,
  countGoalsByFilter,
  findNewGoalAttention,
  goalAttention,
  matchesGoalListFilter,
  snapshotGoalAttention,
} from "./goal-attention";
import { makeChangeSet, makeGoal } from "./test-utils/goal-fixture";

const planReview = makeGoal({ id: "plan", status: "awaiting_plan_approval" });
const changeReview = makeGoal({
  id: "change",
  status: "executing",
  changeSets: [makeChangeSet("cs-1", "t1", { status: "awaiting_human" })],
});
const running = makeGoal({ id: "running", status: "executing" });
const failed = makeGoal({ id: "failed", status: "failed" });
const completed = makeGoal({ id: "completed", status: "completed" });

describe("goalAttention", () => {
  it("names what each goal waits on", () => {
    expect(goalAttention(planReview)).toBe("plan_review");
    expect(goalAttention(changeReview)).toBe("change_review");
    expect(goalAttention(failed)).toBe("failed");
    expect(goalAttention(running)).toBeNull();
    expect(goalAttention(completed)).toBeNull();
  });

  it("ignores a held change set once the goal has ended", () => {
    expect(goalAttention({ ...changeReview, status: "cancelled" })).toBeNull();
  });

  it("stops asking about a dismissed failure, and asks again once retry clears the mark", () => {
    const dismissed = { ...failed, acknowledgedAt: "2026-10-22T00:00:00Z" };
    expect(goalAttention(dismissed)).toBeNull();
    expect(goalAttention({ ...dismissed, acknowledgedAt: null })).toBe("failed");
  });
});

describe("canAcknowledgeGoal", () => {
  it("offers dismiss only for ended goals not dismissed yet", () => {
    expect(canAcknowledgeGoal(failed)).toBe(true);
    expect(canAcknowledgeGoal(completed)).toBe(true);
    expect(canAcknowledgeGoal(running)).toBe(false);
    expect(canAcknowledgeGoal({ ...failed, acknowledgedAt: "2026-10-22T00:00:00Z" })).toBe(false);
  });
});

describe("dismissed failures in the list", () => {
  const dismissed = makeGoal({
    id: "dismissed",
    status: "failed",
    acknowledgedAt: "2026-10-22T00:00:00Z",
  });

  it("leaves Needs you but stays under All and Done", () => {
    expect(countGoalsByFilter([failed, dismissed])).toEqual({
      needs_you: 1,
      running: 0,
      done: 2,
      all: 2,
    });
    const sections = buildGoalListSections([failed, dismissed], "all");
    expect(sections.attention.map((goal) => goal.id)).toEqual(["failed"]);
    expect(sections.others.map((goal) => goal.id)).toEqual(["dismissed"]);
  });

  it("does not toast when a failure is dismissed, and toasts when it fails again", () => {
    const before = snapshotGoalAttention([failed]);
    const acked = { ...failed, acknowledgedAt: "2026-10-22T00:00:00Z" };
    expect(findNewGoalAttention(before, [acked])).toEqual([]);
    const reopened = { ...acked, status: "executing" as const, acknowledgedAt: null };
    const failedAgain = { ...reopened, status: "failed" as const };
    expect(
      findNewGoalAttention(snapshotGoalAttention([reopened]), [failedAgain]).map((t) => t.kind),
    ).toEqual(["failed"]);
  });
});

describe("goal list filters", () => {
  const goals = [planReview, changeReview, running, failed, completed];

  it("counts plans and changes awaiting approval, not failures", () => {
    expect(countGoalsBlockedOnUser(goals)).toBe(2);
  });

  it("counts every filter", () => {
    expect(countGoalsByFilter(goals)).toEqual({ needs_you: 3, running: 3, done: 2, all: 5 });
  });

  it("puts goals waiting on you first, each group by latest activity", () => {
    const older = makeGoal({ id: "older", status: "executing", updatedAt: "2026-10-20T00:00:00Z" });
    const sections = buildGoalListSections(
      [older, running, { ...planReview, updatedAt: "2026-10-19T00:00:00Z" }, failed],
      "all",
    );
    expect(sections.attention.map((goal) => goal.id)).toEqual(["failed", "plan"]);
    expect(sections.others.map((goal) => goal.id)).toEqual(["running", "older"]);
  });

  it("puts archived goals in their own group, which never needs you", () => {
    const archivedFailure = { ...failed, id: "archived", archivedAt: "2026-10-22T00:00:00Z" };
    expect(goalAttention(archivedFailure)).toBeNull();
    const sections = buildGoalListSections([archivedFailure, failed, running], "all");
    expect(sections.attention.map((goal) => goal.id)).toEqual(["failed"]);
    expect(sections.others.map((goal) => goal.id)).toEqual(["running"]);
    expect(sections.archived.map((goal) => goal.id)).toEqual(["archived"]);
  });

  it("orders each group with the given comparator", () => {
    const sections = buildGoalListSections([running, completed], "all", (a, b) =>
      a.id.localeCompare(b.id),
    );
    expect(sections.others.map((goal) => goal.id)).toEqual(["completed", "running"]);
  });

  it("keeps only finished goals under done", () => {
    const sections = buildGoalListSections([running, completed, failed], "done");
    expect(sections.attention.map((goal) => goal.id)).toEqual(["failed"]);
    expect(sections.others.map((goal) => goal.id)).toEqual(["completed"]);
  });
});

describe("plan changes and recoveries waiting for you", () => {
  const revision = (id: string, status = "pending") => ({
    id,
    source: "lead",
    reason: "",
    ops: [],
    status,
    proposedAt: "2026-10-22T00:00:00Z",
  });
  const recovery = (status: string, id = "r1") => ({
    id,
    status,
    startedAt: "2026-10-22T00:00:00Z",
    startedBy: "person",
    failureReason: "Task t7 failed",
  });
  const revising = makeGoal({
    id: "revising",
    status: "executing",
    planRevisions: [revision("rev-1")],
  });
  const recoveryReview = makeGoal({
    id: "recovery",
    status: "failed",
    recovery: recovery("awaiting_approval"),
  });

  it("names a plan change and a recovery's plan change as waiting on you", () => {
    expect(goalAttention(revising)).toBe("revision_review");
    expect(
      goalAttention({ ...revising, planRevisions: [revision("rev-1", "applied")] }),
    ).toBeNull();
    expect(goalAttention(recoveryReview)).toBe("recovery_review");
    // A dismissed failure still asks once a recovery waits for approval.
    expect(goalAttention({ ...recoveryReview, acknowledgedAt: "2026-10-22T00:00:00Z" })).toBe(
      "recovery_review",
    );
  });

  it("stops asking about a failure while a recovery decides or applies, and asks again when it ends", () => {
    expect(goalAttention({ ...failed, recovery: recovery("deciding") })).toBeNull();
    expect(goalAttention({ ...failed, recovery: recovery("decided") })).toBeNull();
    expect(goalAttention({ ...failed, recovery: recovery("ended") })).toBe("failed");
  });

  it("asks again about a dismissed failure once a recovery ended after the dismiss", () => {
    const endedAt = "2026-10-23T00:00:00Z";
    const endedRecovery = {
      ...recovery("ended"),
      outcome: "needs_person",
      resolvedAt: endedAt,
    };
    const dismissedThenRecovered = {
      ...failed,
      failedAt: endedAt,
      acknowledgedAt: "2026-10-22T12:00:00Z",
      recovery: endedRecovery,
    };
    expect(goalAttention(dismissedThenRecovered)).toBe("failed");
    // Dismissed after the recovery ended: it stays quiet.
    expect(
      goalAttention({ ...dismissedThenRecovered, acknowledgedAt: "2026-10-23T01:00:00Z" }),
    ).toBeNull();
    // A stale recovery (the goal failed again later) does not count as a new failure.
    expect(
      goalAttention({
        ...dismissedThenRecovered,
        failedAt: "2026-10-24T00:00:00Z",
        acknowledgedAt: "2026-10-24T01:00:00Z",
      }),
    ).toBeNull();
  });

  it("offers no Dismiss while a recovery runs", () => {
    expect(canAcknowledgeGoal({ ...failed, recovery: recovery("deciding") })).toBe(false);
    expect(canAcknowledgeGoal({ ...failed, recovery: recovery("awaiting_approval") })).toBe(false);
    expect(canAcknowledgeGoal({ ...failed, recovery: recovery("ended") })).toBe(true);
  });

  it("files a recovering goal under Running, not Done", () => {
    const recovering = { ...failed, recovery: recovery("deciding") };
    expect(matchesGoalListFilter(recovering, "running")).toBe(true);
    expect(matchesGoalListFilter(recovering, "done")).toBe(false);
    expect(matchesGoalListFilter({ ...failed, recovery: recovery("ended") }, "done")).toBe(true);
  });

  it("counts both in the badge", () => {
    expect(countGoalsBlockedOnUser([revising, recoveryReview, failed, running])).toBe(2);
  });

  it("reports a later plan change on the same goal", () => {
    const previous = snapshotGoalAttention([revising]);
    expect(findNewGoalAttention(previous, [revising])).toEqual([]);
    const next = { ...revising, planRevisions: [revision("rev-1", "rejected"), revision("rev-2")] };
    expect(findNewGoalAttention(previous, [next]).map((entry) => entry.kind)).toEqual([
      "revision_review",
    ]);
  });

  it("reports a failed goal whose recovery starts waiting for approval", () => {
    const previous = snapshotGoalAttention([{ ...recoveryReview, recovery: recovery("deciding") }]);
    expect(findNewGoalAttention(previous, [recoveryReview]).map((entry) => entry.kind)).toEqual([
      "recovery_review",
    ]);
  });
});

describe("findNewGoalAttention", () => {
  it("is quiet on the first poll", () => {
    expect(findNewGoalAttention(null, [planReview])).toEqual([]);
  });

  it("reports a goal that started waiting since the last poll", () => {
    const previous = snapshotGoalAttention([{ ...planReview, status: "planning" }, running]);
    const transitions = findNewGoalAttention(previous, [planReview, running]);
    expect(transitions.map((entry) => [entry.goal.id, entry.kind])).toEqual([
      ["plan", "plan_review"],
    ]);
  });

  it("does not repeat a state it already reported", () => {
    const previous = snapshotGoalAttention([planReview, changeReview]);
    expect(findNewGoalAttention(previous, [planReview, changeReview])).toEqual([]);
  });

  it("reports another change set held for approval", () => {
    const previous = snapshotGoalAttention([changeReview]);
    const next = {
      ...changeReview,
      changeSets: [
        ...changeReview.changeSets,
        makeChangeSet("cs-2", "t2", { status: "awaiting_human" }),
      ],
    };
    expect(findNewGoalAttention(previous, [next]).map((entry) => entry.kind)).toEqual([
      "change_review",
    ]);
  });

  it("reports a goal first seen already waiting", () => {
    const previous = snapshotGoalAttention([running]);
    expect(findNewGoalAttention(previous, [running, failed]).map((e) => e.goal.id)).toEqual([
      "failed",
    ]);
  });
});
