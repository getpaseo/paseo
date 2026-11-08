import { describe, expect, it } from "vitest";
import type { Goal } from "@getpaseo/protocol/goal/types";
import {
  GOAL_PRIORITY_FILTER_ALL,
  compareGoals,
  filterGoalsForView,
  goalAvailableActions,
  goalPriority,
  hasAnyGoalAction,
  hasNarrowingGoalFilters,
  matchesGoalSearch,
  type GoalActionFeatures,
} from "./goal-management";
import type { GoalProjectOption } from "./goal-projects";
import { makeChangeSet, makeGoal, makeTask } from "./test-utils/goal-fixture";

const ALL_FEATURES: GoalActionFeatures = {
  controls: true,
  acknowledge: true,
  management: true,
  configEdit: true,
  integrationRetry: true,
  reworkRetry: true,
};
const NO_FEATURES: GoalActionFeatures = {
  controls: false,
  acknowledge: false,
  management: false,
  configEdit: false,
  integrationRetry: false,
  reworkRetry: false,
};

const projects: GoalProjectOption[] = [
  {
    projectId: "p-api",
    name: "Billing API",
    rootPath: "/code/api",
    directories: ["/code/api"],
    lastUsedAt: null,
  },
];

function goal(overrides: Partial<Goal>): Goal {
  return makeGoal(overrides);
}

describe("goalPriority", () => {
  it("reads a missing priority as normal", () => {
    expect(goalPriority(goal({}))).toBe("normal");
    expect(goalPriority(goal({ priority: "high" }))).toBe("high");
  });
});

describe("compareGoals", () => {
  const low = goal({
    id: "low",
    title: "beta",
    priority: "low",
    updatedAt: "2026-10-25T00:00:00Z",
  });
  const high = goal({
    id: "high",
    title: "Alpha",
    priority: "high",
    updatedAt: "2026-10-20T00:00:00Z",
  });
  const normalOld = goal({
    id: "normal-old",
    title: "gamma",
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-21T00:00:00Z",
  });
  const normalNew = goal({
    id: "normal-new",
    title: "delta",
    createdAt: "2026-10-10T00:00:00Z",
    updatedAt: "2026-10-22T00:00:00Z",
  });
  const goals = [low, high, normalOld, normalNew];
  const order = (sort: Parameters<typeof compareGoals>[0]) =>
    goals
      .slice()
      .sort(compareGoals(sort))
      .map((entry) => entry.id);

  it("sorts by priority, then the most recently updated", () => {
    expect(order("priority")).toEqual(["high", "normal-new", "normal-old", "low"]);
  });

  it("sorts by last update", () => {
    expect(order("updated")).toEqual(["low", "normal-new", "normal-old", "high"]);
  });

  it("sorts by creation, newest first", () => {
    // low and high carry the fixture's creation time, after both normal goals.
    expect(order("newest")).toEqual(["high", "low", "normal-new", "normal-old"]);
  });

  it("sorts by name without regard to case", () => {
    expect(order("name")).toEqual(["high", "low", "normal-new", "normal-old"]);
  });
});

describe("matchesGoalSearch", () => {
  const target = goal({
    id: "g-rate-limit",
    title: "Add rate limiting",
    objective: "Limit the public API to 100 requests",
    config: { ...makeGoal().config!, cwd: "/code/api" },
  });

  it("matches title, objective, id and project name, ignoring case", () => {
    expect(matchesGoalSearch(target, "RATE", projects)).toBe(true);
    expect(matchesGoalSearch(target, "100 requests", projects)).toBe(true);
    expect(matchesGoalSearch(target, "g-rate", projects)).toBe(true);
    expect(matchesGoalSearch(target, "billing", projects)).toBe(true);
    expect(matchesGoalSearch(target, "frontend", projects)).toBe(false);
  });

  it("keeps every goal for a blank query", () => {
    expect(matchesGoalSearch(target, "   ", projects)).toBe(true);
  });

  it("matches a manual goal on its own fields", () => {
    expect(matchesGoalSearch(goal({ title: "Notes", config: null }), "note", projects)).toBe(true);
  });
});

describe("filterGoalsForView", () => {
  const archived = goal({
    id: "archived",
    status: "completed",
    archivedAt: "2026-10-22T00:00:00Z",
  });
  const high = goal({ id: "high", priority: "high" });
  const plain = goal({ id: "plain" });

  it("hides archived goals unless asked", () => {
    const filters = {
      search: "",
      priority: GOAL_PRIORITY_FILTER_ALL,
      showArchived: false,
    } as const;
    expect(filterGoalsForView([archived, high, plain], filters, []).map((g) => g.id)).toEqual([
      "high",
      "plain",
    ]);
    expect(
      filterGoalsForView([archived, high], { ...filters, showArchived: true }, []).map((g) => g.id),
    ).toEqual(["archived", "high"]);
  });

  it("keeps one priority, counting a missing one as normal", () => {
    const filters = { search: "", priority: "normal", showArchived: false } as const;
    expect(filterGoalsForView([high, plain], filters, []).map((g) => g.id)).toEqual(["plain"]);
  });
});

describe("hasNarrowingGoalFilters", () => {
  it("is true for a search, a priority or a project", () => {
    const none: Parameters<typeof hasNarrowingGoalFilters>[0] = {
      search: " ",
      priority: GOAL_PRIORITY_FILTER_ALL,
      projectFiltered: false,
    };
    expect(hasNarrowingGoalFilters(none)).toBe(false);
    expect(hasNarrowingGoalFilters({ ...none, search: "x" })).toBe(true);
    expect(hasNarrowingGoalFilters({ ...none, priority: "low" })).toBe(true);
    expect(hasNarrowingGoalFilters({ ...none, projectFiltered: true })).toBe(true);
  });
});

describe("goalAvailableActions", () => {
  it("offers pause and cancel on a running goal, but not archive or delete", () => {
    const actions = goalAvailableActions(goal({ status: "executing" }), ALL_FEATURES);
    expect(actions).toMatchObject({
      pause: true,
      resume: false,
      cancel: true,
      retry: false,
      rename: true,
      priority: true,
      archive: false,
      unarchive: false,
      delete: false,
      dismiss: false,
    });
  });

  it("offers resume on a paused goal", () => {
    const paused = goal({ status: "executing", pausedAt: "2026-10-22T00:00:00Z" });
    expect(goalAvailableActions(paused, ALL_FEATURES)).toMatchObject({
      pause: false,
      resume: true,
    });
  });

  it("hides retry, archive, delete and dismiss while a recovery is open, and offers them once it ended", () => {
    const recovery = {
      id: "r1",
      startedAt: "2026-10-22T00:00:00Z",
      startedBy: "person",
      failureReason: "Task t1 failed",
    };
    const tasks = [makeTask("t1", { status: "failed" })];
    for (const status of ["deciding", "decided", "awaiting_approval"]) {
      const recovering = goal({ status: "failed", tasks, recovery: { ...recovery, status } });
      expect(goalAvailableActions(recovering, ALL_FEATURES)).toMatchObject({
        retry: false,
        archive: false,
        delete: false,
        dismiss: false,
      });
    }
    const ended = goal({ status: "failed", tasks, recovery: { ...recovery, status: "ended" } });
    expect(goalAvailableActions(ended, ALL_FEATURES)).toMatchObject({
      retry: true,
      archive: true,
      delete: true,
    });
  });

  it("offers retry, dismiss, archive and delete on a failed goal", () => {
    const actions = goalAvailableActions(goal({ status: "failed" }), ALL_FEATURES);
    expect(actions).toMatchObject({
      cancel: false,
      retry: true,
      archive: true,
      delete: true,
      dismiss: true,
      pause: false,
    });
  });

  it("offers unarchive, not archive or retry, on an archived goal", () => {
    const actions = goalAvailableActions(
      goal({ status: "failed", archivedAt: "2026-10-22T00:00:00Z" }),
      ALL_FEATURES,
    );
    expect(actions).toMatchObject({ archive: false, unarchive: true, retry: false, delete: true });
  });

  it("offers only cancel on a host without the newer flags", () => {
    const actions = goalAvailableActions(goal({ status: "executing" }), NO_FEATURES);
    expect(actions).toEqual({
      pause: false,
      resume: false,
      cancel: true,
      retry: false,
      retryPlanning: false,
      retryMerge: false,
      editSettings: false,
      rename: false,
      priority: false,
      archive: false,
      unarchive: false,
      delete: false,
      dismiss: false,
    });
    expect(hasAnyGoalAction(goalAvailableActions(goal({ status: "completed" }), NO_FEATURES))).toBe(
      false,
    );
  });

  it("offers settings on any managed goal that is not archived, ended ones included", () => {
    expect(goalAvailableActions(goal({ status: "executing" }), ALL_FEATURES).editSettings).toBe(
      true,
    );
    expect(goalAvailableActions(goal({ status: "completed" }), ALL_FEATURES).editSettings).toBe(
      true,
    );
    expect(
      goalAvailableActions(
        goal({ status: "failed", archivedAt: "2026-10-22T00:00:00Z" }),
        ALL_FEATURES,
      ).editSettings,
    ).toBe(false);
    expect(
      goalAvailableActions(goal({ status: "executing", config: null }), ALL_FEATURES).editSettings,
    ).toBe(false);
    expect(
      goalAvailableActions(goal({ status: "executing" }), { ...ALL_FEATURES, configEdit: false })
        .editSettings,
    ).toBe(false);
  });

  it("labels the retry of a goal that failed while planning, on hosts that reopen it", () => {
    const failedPlanning = goal({ status: "failed", tasks: [] });
    expect(goalAvailableActions(failedPlanning, ALL_FEATURES)).toMatchObject({
      retry: true,
      retryPlanning: true,
    });
    expect(
      goalAvailableActions(failedPlanning, { ...ALL_FEATURES, configEdit: false }),
    ).toMatchObject({ retry: false, retryPlanning: false });
  });

  it("labels the retry of a failed merge, on hosts that merge it again", () => {
    const failedMerge = goal({
      status: "failed",
      tasks: [makeTask("t1", { status: "succeeded" })],
      changeSets: [
        makeChangeSet("c1", "t1", { status: "rejected", rejectionReason: "integration_failed" }),
      ],
    });
    expect(goalAvailableActions(failedMerge, ALL_FEATURES)).toMatchObject({
      retry: true,
      retryMerge: true,
      retryPlanning: false,
    });
    expect(
      goalAvailableActions(failedMerge, { ...ALL_FEATURES, integrationRetry: false }),
    ).toMatchObject({ retry: false, retryMerge: false });
  });

  it("leaves pause and retry off a manual goal", () => {
    const manual = goal({ status: "executing", config: null });
    expect(goalAvailableActions(manual, ALL_FEATURES)).toMatchObject({
      pause: false,
      cancel: true,
    });
  });
});
