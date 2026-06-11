import { describe, expect, it } from "vitest";
import {
  collapseActivity,
  expandActivity,
  getActivityState,
  getVisibleEntries,
  hideActivity,
  showHiddenActivities,
} from "./activity-state";
import type { PrTimelineEntry } from "./timeline";
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

function singleEntry(id: string): PrTimelineEntry {
  return { kind: "single", id, activity: activity(id) };
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
    const entries = [singleEntry("comment-1"), singleEntry("comment-2")];

    expect(getVisibleEntries(state, { prNumber: 42, entries })).toEqual([
      { entry: entries[0], collapsed: true },
      { entry: entries[1], collapsed: false },
    ]);
    expect(getVisibleEntries(state, { prNumber: 99, entries })).toEqual([
      { entry: entries[1], collapsed: false },
    ]);
  });
});
