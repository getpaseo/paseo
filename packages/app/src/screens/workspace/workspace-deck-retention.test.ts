import { describe, expect, it } from "vitest";
import type { ActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import {
  getNextWorkspaceDeckExpirationDelay,
  orderWorkspaceSelectionsForStableRender,
  reconcileRetainedWorkspaceSelections,
  resolveWorkspaceDeckEntries,
  shouldKeepWorkspaceDeckEntryMounted,
  WORKSPACE_DECK_INACTIVE_TTL_MS,
  WORKSPACE_DECK_MAX_MOUNTED_WORKSPACES,
} from "@/screens/workspace/workspace-deck-retention";

function workspace(workspaceId: string, serverId = "server"): ActiveWorkspaceSelection {
  return { serverId, workspaceId };
}

function mountedWorkspaceIds(selections: ActiveWorkspaceSelection[]): string[] {
  return selections.map((selection) => selection.workspaceId);
}

function retained(workspaceId: string, inactiveSince: number | null) {
  return { selection: workspace(workspaceId), inactiveSince };
}

function retainedWorkspaceIds(
  entries: ReturnType<typeof reconcileRetainedWorkspaceSelections>,
): string[] {
  return entries.map((entry) => entry.selection.workspaceId);
}

describe("reconcileRetainedWorkspaceSelections", () => {
  it("retains inactive workspaces for ten minutes across app-wide routes", () => {
    const retainedEntries = [retained("A", 1_000), retained("B", 2_000)];

    expect(
      reconcileRetainedWorkspaceSelections({
        currentEntries: retainedEntries,
        activeSelection: null,
        now: 2_000 + WORKSPACE_DECK_INACTIVE_TTL_MS - 1,
      }),
    ).toEqual([retained("B", 2_000)]);
  });

  it("keeps the active workspace and nine most recently activated inactive workspaces", () => {
    let retainedEntries = Array.from(
      { length: WORKSPACE_DECK_MAX_MOUNTED_WORKSPACES },
      (_, index) => retained(String(index + 1), index + 1),
    ).toReversed();

    retainedEntries = reconcileRetainedWorkspaceSelections({
      currentEntries: retainedEntries,
      activeSelection: workspace("11"),
      now: 11,
    });

    expect(retainedWorkspaceIds(retainedEntries)).toEqual([
      "11",
      "10",
      "9",
      "8",
      "7",
      "6",
      "5",
      "4",
      "3",
      "2",
    ]);
  });

  it("starts the TTL when the active workspace becomes inactive", () => {
    const retainedEntries = reconcileRetainedWorkspaceSelections({
      currentEntries: [retained("A", null), retained("B", 2_000)],
      activeSelection: workspace("B"),
      now: 3_000,
    });

    expect(retainedEntries).toEqual([retained("B", null), retained("A", 3_000)]);
  });

  it("never expires the active workspace", () => {
    const retainedEntries = reconcileRetainedWorkspaceSelections({
      currentEntries: [retained("A", 0)],
      activeSelection: workspace("A"),
      now: WORKSPACE_DECK_INACTIVE_TTL_MS,
    });

    expect(retainedEntries).toEqual([retained("A", null)]);
  });

  it("expires an inactive workspace at the TTL boundary", () => {
    const retainedEntries = reconcileRetainedWorkspaceSelections({
      currentEntries: [retained("B", null), retained("A", 0)],
      activeSelection: workspace("B"),
      now: WORKSPACE_DECK_INACTIVE_TTL_MS,
    });

    expect(retainedEntries).toEqual([retained("B", null)]);
  });

  it("deduplicates retained workspace selections", () => {
    const retainedEntries = reconcileRetainedWorkspaceSelections({
      currentEntries: [retained("B", 2), retained("A", 1), retained("B", 0)],
      activeSelection: workspace("A"),
      now: 3,
    });

    expect(retainedWorkspaceIds(retainedEntries)).toEqual(["A", "B"]);
  });
});

describe("getNextWorkspaceDeckExpirationDelay", () => {
  it("returns the remaining lifetime of the oldest inactive workspace", () => {
    expect(
      getNextWorkspaceDeckExpirationDelay({
        entries: [retained("C", null), retained("B", 2_000), retained("A", 1_000)],
        activeSelection: workspace("C"),
        now: 4_000,
      }),
    ).toBe(WORKSPACE_DECK_INACTIVE_TTL_MS - 3_000);
  });

  it("does not schedule expiration for the active workspace", () => {
    expect(
      getNextWorkspaceDeckExpirationDelay({
        entries: [retained("A", null)],
        activeSelection: workspace("A"),
        now: 4_000,
      }),
    ).toBeNull();
  });
});

describe("orderWorkspaceSelectionsForStableRender", () => {
  it("does not move retained native roots when the active LRU order changes", () => {
    const activeA = [workspace("A"), workspace("B")];
    const activeB = [workspace("B"), workspace("A")];

    expect(mountedWorkspaceIds(orderWorkspaceSelectionsForStableRender(activeA))).toEqual([
      "A",
      "B",
    ]);
    expect(mountedWorkspaceIds(orderWorkspaceSelectionsForStableRender(activeB))).toEqual([
      "A",
      "B",
    ]);
  });
});

describe("resolveWorkspaceDeckEntries", () => {
  it("keeps retained workspaces rendered but inactive on an app-wide route", () => {
    expect(
      resolveWorkspaceDeckEntries({
        selections: [workspace("A"), workspace("B")],
        activeSelection: null,
      }),
    ).toEqual([
      { selection: workspace("A"), active: false },
      { selection: workspace("B"), active: false },
    ]);
  });
});

describe("shouldKeepWorkspaceDeckEntryMounted", () => {
  it("keeps the active workspace mounted even when it is missing from hydrated workspaces", () => {
    expect(
      shouldKeepWorkspaceDeckEntryMounted({
        isActive: true,
        hasHydratedWorkspaces: true,
        workspaceExists: false,
      }),
    ).toBe(true);
  });

  it("keeps inactive workspaces mounted until workspace hydration finishes", () => {
    expect(
      shouldKeepWorkspaceDeckEntryMounted({
        isActive: false,
        hasHydratedWorkspaces: false,
        workspaceExists: false,
      }),
    ).toBe(true);
  });

  it("unmounts inactive workspaces that are gone after hydration", () => {
    expect(
      shouldKeepWorkspaceDeckEntryMounted({
        isActive: false,
        hasHydratedWorkspaces: true,
        workspaceExists: false,
      }),
    ).toBe(false);
  });

  it("keeps inactive workspaces that still exist after hydration", () => {
    expect(
      shouldKeepWorkspaceDeckEntryMounted({
        isActive: false,
        hasHydratedWorkspaces: true,
        workspaceExists: true,
      }),
    ).toBe(true);
  });
});
