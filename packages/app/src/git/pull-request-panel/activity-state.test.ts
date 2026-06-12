import { describe, expect, it } from "vitest";
import {
  collapseActivity,
  expandActivity,
  getActivityState,
  getCollapsedEntryIds,
  getVisibleEntries,
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

function singleEntry(id: string, resolved = false, outdated = false): PrTimelineEntry {
  return {
    kind: "single",
    id,
    activity: activity(id, {
      location:
        resolved || outdated
          ? { path: "a.ts", line: 1, isResolved: resolved, isOutdated: outdated }
          : undefined,
    }),
  };
}

function threadEntry(id: string, resolved = false, outdated = false): PrTimelineEntry {
  return {
    kind: "thread",
    id: `thread:${id}`,
    location: { path: "a.ts", line: 1, isResolved: resolved, isOutdated: outdated },
    comments: [activity(id)],
  };
}

function reviewEntry(id: string, threads: PrTimelineEntry[]): PrTimelineEntry {
  return {
    kind: "review",
    id,
    review: activity(id, { kind: "review", reviewState: "commented" }),
    threads: threads.filter((entry) => entry.kind === "thread"),
  };
}

describe("pull request activity state", () => {
  it("collapses and expands activity by PR-scoped stable key", () => {
    const collapsed = collapseActivity(getActivityState(), {
      prNumber: 42,
      activityId: "comment-1",
    });

    expect(collapsed.collapsedKeys).toEqual(["42:comment-1"]);
    expect(expandActivity(collapsed, { prNumber: 42, activityId: "comment-1" })).toEqual({
      collapsedKeys: [],
      expandedKeys: ["42:comment-1"],
    });
  });

  it("collapses resolved and outdated entries by default", () => {
    const entries = [
      singleEntry("normal"),
      singleEntry("resolved", true),
      singleEntry("outdated", false, true),
      threadEntry("thread-normal"),
      threadEntry("thread-resolved", true),
      threadEntry("thread-outdated", false, true),
    ];

    const visible = getVisibleEntries(getActivityState(), { prNumber: 42, entries });

    expect(visible.map((v) => ({ id: v.entry.id, collapsed: v.collapsed }))).toEqual([
      { id: "normal", collapsed: false },
      { id: "resolved", collapsed: true },
      { id: "outdated", collapsed: true },
      { id: "thread:thread-normal", collapsed: false },
      { id: "thread:thread-resolved", collapsed: true },
      { id: "thread:thread-outdated", collapsed: true },
    ]);
  });

  it("lets user expand a default-collapsed entry", () => {
    const entries = [threadEntry("resolved", true)];
    const expanded = expandActivity(getActivityState(), {
      prNumber: 42,
      activityId: "thread:resolved",
    });

    const visible = getVisibleEntries(expanded, { prNumber: 42, entries });
    expect(visible[0].collapsed).toBe(false);
  });

  it("lets user collapse a default-expanded entry", () => {
    const entries = [threadEntry("normal")];
    const collapsed = collapseActivity(getActivityState(), {
      prNumber: 42,
      activityId: "thread:normal",
    });

    const visible = getVisibleEntries(collapsed, { prNumber: 42, entries });
    expect(visible[0].collapsed).toBe(true);
  });

  it("includes default-collapsed nested review threads in collapsed IDs", () => {
    const entries = [
      reviewEntry("review", [
        threadEntry("thread-normal"),
        threadEntry("thread-resolved", true),
        threadEntry("thread-outdated", false, true),
      ]),
    ];

    const collapsedIds = getCollapsedEntryIds(getActivityState(), { prNumber: 42, entries });

    expect([...collapsedIds].sort()).toEqual(["thread:thread-outdated", "thread:thread-resolved"]);
  });

  it("lets user expand a default-collapsed nested review thread", () => {
    const entries = [reviewEntry("review", [threadEntry("thread-resolved", true)])];
    const expanded = expandActivity(getActivityState(), {
      prNumber: 42,
      activityId: "thread:thread-resolved",
    });

    const collapsedIds = getCollapsedEntryIds(expanded, { prNumber: 42, entries });

    expect(collapsedIds.has("thread:thread-resolved")).toBe(false);
  });
});
