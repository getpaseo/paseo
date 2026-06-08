import { describe, expect, it } from "vitest";
import {
  collapseActivity,
  expandActivity,
  getActivityState,
  getVisibleActivities,
  hideActivity,
  showHiddenActivities,
} from "./activity-state";
import type { PrPaneActivity } from "./data";

function activity(id: string, overrides: Partial<PrPaneActivity> = {}): PrPaneActivity {
  return {
    id,
    provider: "github",
    kind: "comment",
    author: "octocat",
    avatarColor: "#0ea5e9",
    body: "Looks good.",
    age: "3d ago",
    url: `https://github.com/getpaseo/paseo/pull/42#${id}`,
    ...overrides,
  };
}

describe("pull request activity state", () => {
  it("collapses and expands activity by PR-scoped stable key", () => {
    const collapsed = collapseActivity(getActivityState(), {
      prNumber: 42,
      activityId: "comment-1",
    });

    expect(collapsed.collapsedKeys).toEqual(["42:comment-1"]);
    expect(expandActivity(collapsed, { prNumber: 42, activityId: "comment-1" })).toEqual(
      getActivityState(),
    );
  });

  it("hides activity and restores hidden activity for that PR", () => {
    const hidden = hideActivity(getActivityState(), { prNumber: 42, activityId: "comment-1" });

    expect(hidden.hiddenKeys).toEqual(["42:comment-1"]);
    expect(showHiddenActivities(hidden, { prNumber: 42 })).toEqual(getActivityState());
  });

  it("keeps collapse and hide state scoped to a pull request", () => {
    const state = hideActivity(
      collapseActivity(getActivityState(), { prNumber: 42, activityId: "comment-1" }),
      { prNumber: 99, activityId: "comment-1" },
    );
    const activities = [activity("comment-1"), activity("comment-2")];

    expect(getVisibleActivities(state, { prNumber: 42, activities })).toEqual([
      { activity: activities[0], collapsed: true },
      { activity: activities[1], collapsed: false },
    ]);
    expect(getVisibleActivities(state, { prNumber: 99, activities })).toEqual([
      { activity: activities[1], collapsed: false },
    ]);
  });
});
