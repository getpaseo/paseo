import { describe, expect, it } from "vitest";
import type { ActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { pruneMountedWorkspaceSelections } from "@/screens/workspace/workspace-deck-retention";

function workspace(workspaceId: string, serverId = "server"): ActiveWorkspaceSelection {
  return { serverId, workspaceId };
}

function mountedWorkspaceIds(selections: ActiveWorkspaceSelection[]): string[] {
  return selections.map((selection) => selection.workspaceId);
}

describe("pruneMountedWorkspaceSelections", () => {
  it("keeps the active workspace and the two most recent inactive workspaces", () => {
    const mountedAfterA = pruneMountedWorkspaceSelections({
      currentSelections: [],
      activeSelection: workspace("A"),
      shouldPruneInactiveSelections: true,
      canRetainInactiveSelection: () => true,
    });
    const mountedAfterB = pruneMountedWorkspaceSelections({
      currentSelections: mountedAfterA,
      activeSelection: workspace("B"),
      shouldPruneInactiveSelections: true,
      canRetainInactiveSelection: () => true,
    });
    const mountedAfterC = pruneMountedWorkspaceSelections({
      currentSelections: mountedAfterB,
      activeSelection: workspace("C"),
      shouldPruneInactiveSelections: true,
      canRetainInactiveSelection: () => true,
    });
    const mountedAfterD = pruneMountedWorkspaceSelections({
      currentSelections: mountedAfterC,
      activeSelection: workspace("D"),
      shouldPruneInactiveSelections: true,
      canRetainInactiveSelection: () => true,
    });

    expect(mountedWorkspaceIds(mountedAfterD)).toEqual(["D", "C", "B"]);
  });

  it("retains the active workspace even when inactive pruning would reject it", () => {
    const mountedSelections = pruneMountedWorkspaceSelections({
      currentSelections: [workspace("A")],
      activeSelection: workspace("A"),
      shouldPruneInactiveSelections: true,
      canRetainInactiveSelection: () => false,
    });

    expect(mountedWorkspaceIds(mountedSelections)).toEqual(["A"]);
  });

  it("prunes inactive workspaces that no longer exist", () => {
    const mountedSelections = pruneMountedWorkspaceSelections({
      currentSelections: [workspace("A"), workspace("B"), workspace("C")],
      activeSelection: workspace("A"),
      shouldPruneInactiveSelections: true,
      canRetainInactiveSelection: (selection) => selection.workspaceId !== "B",
    });

    expect(mountedWorkspaceIds(mountedSelections)).toEqual(["A", "C"]);
  });

  it("waits to prune inactive workspaces until workspace hydration is ready", () => {
    const mountedSelections = pruneMountedWorkspaceSelections({
      currentSelections: [workspace("A"), workspace("B")],
      activeSelection: workspace("A"),
      shouldPruneInactiveSelections: false,
      canRetainInactiveSelection: () => false,
    });

    expect(mountedWorkspaceIds(mountedSelections)).toEqual(["A", "B"]);
  });

  it("always allows at least the active workspace", () => {
    const mountedSelections = pruneMountedWorkspaceSelections({
      currentSelections: [workspace("A"), workspace("B")],
      activeSelection: workspace("C"),
      maxMountedWorkspaces: 0,
      shouldPruneInactiveSelections: true,
      canRetainInactiveSelection: () => true,
    });

    expect(mountedWorkspaceIds(mountedSelections)).toEqual(["C"]);
  });
});
