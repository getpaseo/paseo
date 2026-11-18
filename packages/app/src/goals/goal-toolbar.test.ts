import { describe, expect, it } from "vitest";
import { DEFAULT_GOAL_SORT, GOAL_PRIORITY_FILTER_ALL } from "./goal-management";
import { GOAL_PROJECT_FILTER_ALL } from "./goal-projects";
import {
  DEFAULT_GOAL_LIST_FILTER,
  activeGoalToolbarControls,
  goalToolbarBadgeText,
  goalToolbarMark,
  type GoalToolbarState,
} from "./goal-toolbar";

const defaults: GoalToolbarState = {
  status: DEFAULT_GOAL_LIST_FILTER,
  project: GOAL_PROJECT_FILTER_ALL,
  priority: GOAL_PRIORITY_FILTER_ALL,
  sort: DEFAULT_GOAL_SORT,
};

describe("activeGoalToolbarControls", () => {
  it("marks nothing active at the defaults", () => {
    expect(activeGoalToolbarControls(defaults)).toEqual({
      status: false,
      project: false,
      priority: false,
      sort: false,
    });
  });

  it("marks each control that left its default", () => {
    expect(
      activeGoalToolbarControls({
        status: "needs_you",
        project: "project-a",
        priority: "high",
        sort: "name",
      }),
    ).toEqual({ status: true, project: true, priority: true, sort: true });
  });

  it("treats the default sort as inactive whatever the other controls are", () => {
    const active = activeGoalToolbarControls({ ...defaults, priority: "low" });
    expect(active.sort).toBe(false);
    expect(active.priority).toBe(true);
  });
});

describe("goalToolbarBadgeText", () => {
  it("shows nothing for zero or less", () => {
    expect(goalToolbarBadgeText(0)).toBeNull();
    expect(goalToolbarBadgeText(-1)).toBeNull();
  });

  it("shows the count up to 99 and saturates above it", () => {
    expect(goalToolbarBadgeText(3)).toBe("3");
    expect(goalToolbarBadgeText(99)).toBe("99");
    expect(goalToolbarBadgeText(100)).toBe("99+");
  });
});

describe("goalToolbarMark", () => {
  it("shows no mark for an inactive control without attention", () => {
    expect(goalToolbarMark({ active: false })).toEqual({ kind: "none" });
  });

  it("shows a dot for an active control", () => {
    expect(goalToolbarMark({ active: true })).toEqual({ kind: "dot" });
  });

  it("keeps the attention badge whether or not the control is active", () => {
    expect(goalToolbarMark({ active: false, attentionCount: 2 })).toEqual({
      kind: "badge",
      text: "2",
    });
    expect(goalToolbarMark({ active: true, attentionCount: 2 })).toEqual({
      kind: "badge",
      text: "2",
    });
  });
});
