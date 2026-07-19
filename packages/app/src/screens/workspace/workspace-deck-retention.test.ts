import { describe, expect, it } from "vitest";
import type { ActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import {
  orderWorkspaceSelectionsForStableRender,
  pruneMountedWorkspaceSelections,
  shouldKeepWorkspaceDeckEntryMounted,
} from "@/screens/workspace/workspace-deck-retention";

function workspace(workspaceId: string, serverId = "server"): ActiveWorkspaceSelection {
  return { serverId, workspaceId };
}

function mountedWorkspaceIds(selections: ActiveWorkspaceSelection[]): string[] {
  return selections.map((selection) => selection.workspaceId);
}

describe("pruneMountedWorkspaceSelections", () => {
  it("retains the deck while an app-wide route temporarily clears the active workspace", () => {
    const mountedSelections = [workspace("A"), workspace("B")];

    expect(
      pruneMountedWorkspaceSelections({
        currentSelections: mountedSelections,
        activeSelection: null,
      }),
    ).toBe(mountedSelections);
  });

  it("keeps the active workspace and the two most recent inactive workspaces", () => {
    const mountedAfterA = pruneMountedWorkspaceSelections({
      currentSelections: [],
      activeSelection: workspace("A"),
    });
    const mountedAfterB = pruneMountedWorkspaceSelections({
      currentSelections: mountedAfterA,
      activeSelection: workspace("B"),
    });
    const mountedAfterC = pruneMountedWorkspaceSelections({
      currentSelections: mountedAfterB,
      activeSelection: workspace("C"),
    });
    const mountedAfterD = pruneMountedWorkspaceSelections({
      currentSelections: mountedAfterC,
      activeSelection: workspace("D"),
    });

    expect(mountedWorkspaceIds(mountedAfterD)).toEqual(["D", "C", "B"]);
  });

  it("retains the active workspace", () => {
    const mountedSelections = pruneMountedWorkspaceSelections({
      currentSelections: [workspace("A")],
      activeSelection: workspace("A"),
    });

    expect(mountedWorkspaceIds(mountedSelections)).toEqual(["A"]);
  });

  it("deduplicates retained workspace selections", () => {
    const mountedSelections = pruneMountedWorkspaceSelections({
      currentSelections: [workspace("B"), workspace("A"), workspace("B")],
      activeSelection: workspace("A"),
    });

    expect(mountedWorkspaceIds(mountedSelections)).toEqual(["A", "B"]);
  });

  it("always allows at least the active workspace", () => {
    const mountedSelections = pruneMountedWorkspaceSelections({
      currentSelections: [workspace("A"), workspace("B")],
      activeSelection: workspace("C"),
      maxMountedWorkspaces: 0,
    });

    expect(mountedWorkspaceIds(mountedSelections)).toEqual(["C"]);
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
