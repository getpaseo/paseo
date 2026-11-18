import { describe, expect, it } from "vitest";
import type { GoalSummary } from "@getpaseo/protocol/goal/types";
import {
  applyGoalPush,
  applyGoalUpdate,
  mergePolledGoals,
  replaceGoalInList,
} from "./goal-updates";
import { makeGoal } from "./test-utils/goal-fixture";

function summary(id: string, lastSeq: number, overrides: Partial<GoalSummary> = {}): GoalSummary {
  return { ...makeGoal({ id, lastSeq }), ...overrides };
}

describe("applyGoalUpdate", () => {
  it("replaces the cached goal with a newer push and adds an unknown one first", () => {
    const list = [summary("a", 1), summary("b", 1)];
    const updated = applyGoalUpdate(list, summary("b", 2, { title: "B2" }));
    expect(updated.map((goal) => [goal.id, goal.lastSeq])).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
    expect(applyGoalUpdate(list, summary("c", 1)).map((goal) => goal.id)).toEqual(["c", "a", "b"]);
  });

  it("drops a push older than the cached goal", () => {
    const list = [summary("a", 5)];
    expect(applyGoalUpdate(list, summary("a", 4))[0]?.lastSeq).toBe(5);
  });
});

describe("mergePolledGoals", () => {
  it("keeps a pushed goal that is newer than the poll", () => {
    const cached = [summary("a", 7), summary("b", 1)];
    const polled = [summary("a", 6), summary("b", 2), summary("c", 1)];
    expect(mergePolledGoals(cached, polled).map((goal) => [goal.id, goal.lastSeq])).toEqual([
      ["a", 7],
      ["b", 2],
      ["c", 1],
    ]);
  });

  it("takes the poll as it is without a cache", () => {
    const polled = [summary("a", 1)];
    expect(mergePolledGoals(undefined, polled)).toEqual(polled);
  });
});

describe("applyGoalPush", () => {
  const list = [summary("a", 1), summary("b", 1)];

  it("drops a deleted goal from every list", () => {
    const ids = (mode: "exclude" | "include") =>
      applyGoalPush(list, summary("a", 2), { deleted: true, archived: mode }).map((g) => g.id);
    expect(ids("exclude")).toEqual(["b"]);
    expect(ids("include")).toEqual(["b"]);
  });

  it("drops an archived goal from a list that hides them and keeps it in one that shows them", () => {
    const archived = summary("a", 2, { status: "completed", archivedAt: "2026-10-22T00:00:00Z" });
    expect(
      applyGoalPush(list, archived, { deleted: false, archived: "exclude" }).map((g) => g.id),
    ).toEqual(["b"]);
    const shown = applyGoalPush(list, archived, { deleted: false, archived: "include" });
    expect(shown.find((g) => g.id === "a")?.archivedAt).toBe("2026-10-22T00:00:00Z");
  });

  it("ignores a push older than the cached goal", () => {
    const cached = [summary("a", 5)];
    const stale = summary("a", 4, { archivedAt: "2026-10-22T00:00:00Z" });
    expect(applyGoalPush(cached, stale, { deleted: false, archived: "exclude" })).toEqual(cached);
  });
});

describe("replaceGoalInList", () => {
  it("merges a mutation result into the cached goal, keeping its progress", () => {
    const cached = [
      summary("a", 1, {
        progress: { tasksTotal: 3, tasksDone: 1, tasksFailed: 0, tasksRunning: 1 },
      }),
    ];
    const renamed = replaceGoalInList(cached, makeGoal({ id: "a", lastSeq: 2, title: "Renamed" }), {
      archived: "exclude",
    });
    expect(renamed[0]).toMatchObject({ title: "Renamed", lastSeq: 2, progress: { tasksTotal: 3 } });
  });

  it("removes a goal archived by the mutation from a list that hides archived goals", () => {
    const archived = makeGoal({ id: "a", lastSeq: 2, archivedAt: "2026-10-22T00:00:00Z" });
    expect(replaceGoalInList([summary("a", 1)], archived, { archived: "exclude" })).toEqual([]);
    expect(replaceGoalInList([summary("a", 1)], archived, { archived: "include" })).toHaveLength(1);
  });

  it("does not add a goal the list does not hold", () => {
    expect(replaceGoalInList([], makeGoal({ id: "a" }), { archived: "include" })).toEqual([]);
  });
});
