import { describe, expect, it } from "vitest";
import {
  migrateSidebarWorkspaceVisibilityState,
  reconcileHiddenProjectKeys,
  reconcileHiddenWorkspaceKeys,
  updateHiddenProjectKeys,
  updateHiddenWorkspaceKeys,
} from "./sidebar-workspace-visibility-store";

describe("sidebar workspace visibility", () => {
  it("hides and unhides a workspace without changing unrelated keys", () => {
    const hiddenA = updateHiddenWorkspaceKeys({
      keys: [],
      workspaceKey: "host-a:workspace-a",
      hidden: true,
    });
    const hiddenBoth = updateHiddenWorkspaceKeys({
      keys: hiddenA,
      workspaceKey: "host-a:workspace-b",
      hidden: true,
    });
    const hiddenB = updateHiddenWorkspaceKeys({
      keys: hiddenBoth,
      workspaceKey: "host-a:workspace-a",
      hidden: false,
    });

    expect(hiddenB).toEqual(["host-a:workspace-b"]);
  });

  it("prunes archived workspaces after descriptor hydration", () => {
    const hiddenWorkspaceKeys = reconcileHiddenWorkspaceKeys(
      ["host-a:active", "host-a:archived"],
      ["host-a:active"],
    );

    expect(hiddenWorkspaceKeys).toEqual(["host-a:active"]);
  });

  it("hides, unhides, and reconciles projects independently from workspaces", () => {
    const hiddenProjects = updateHiddenProjectKeys({
      keys: [],
      projectKey: "project-a",
      hidden: true,
    });

    expect(hiddenProjects).toEqual(["project-a"]);
    expect(reconcileHiddenProjectKeys(hiddenProjects, ["project-b"])).toEqual([]);
    expect(
      updateHiddenProjectKeys({ keys: hiddenProjects, projectKey: "project-a", hidden: false }),
    ).toEqual([]);
  });

  it("normalizes duplicate and blank persisted keys", () => {
    expect(
      migrateSidebarWorkspaceVisibilityState({
        hiddenWorkspaceKeys: [" host-a:workspace ", "host-a:workspace", ""],
        hiddenProjectKeys: [" project-a ", "project-a", ""],
        hiddenSectionCollapsed: false,
        collapsedCollectionKeys: ["collection-a", " collection-a "],
      }),
    ).toEqual({
      hiddenWorkspaceKeys: ["host-a:workspace"],
      hiddenProjectKeys: ["project-a"],
      hiddenSectionCollapsed: false,
      collapsedCollectionKeys: ["collection-a"],
    });
  });
});
