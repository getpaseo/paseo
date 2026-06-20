import { describe, expect, it } from "vitest";
import {
  type CollapsedProjectsState,
  mergePersistedCollapsedProjects,
  serializeCollapsedProjects,
  setProjectCollapsed,
  toggleProjectCollapsed,
  toggleStatusGroupCollapsed,
  toggleWorkspaceCollapsed,
} from "@/stores/sidebar-collapsed-sections-store/state";

function emptyState(): CollapsedProjectsState {
  return {
    collapsedProjectKeys: new Set(),
    collapsedStatusGroupKeys: new Set(),
    collapsedWorkspaceKeys: new Set(),
  };
}

describe("sidebar collapsed projects transitions", () => {
  it("tracks collapsed project keys as a Set", () => {
    let state = emptyState();

    state = setProjectCollapsed(state, "project-a", true);
    state = toggleProjectCollapsed(state, "project-b");
    state = toggleProjectCollapsed(state, "project-a");
    state = toggleStatusGroupCollapsed(state, "running");
    state = toggleWorkspaceCollapsed(state, "workspace-a");

    expect(Array.from(state.collapsedProjectKeys)).toEqual(["project-b"]);
    expect(Array.from(state.collapsedStatusGroupKeys)).toEqual(["running"]);
    expect(Array.from(state.collapsedWorkspaceKeys)).toEqual(["workspace-a"]);
  });

  it("serializes collapsed project keys for preference storage", () => {
    const state: CollapsedProjectsState = {
      collapsedProjectKeys: new Set(["project-a", "project-b"]),
      collapsedStatusGroupKeys: new Set(["running"]),
      collapsedWorkspaceKeys: new Set(["workspace-a"]),
    };

    expect(serializeCollapsedProjects(state)).toEqual({
      collapsedProjectKeys: ["project-a", "project-b"],
      collapsedStatusGroupKeys: ["running"],
      collapsedWorkspaceKeys: ["workspace-a"],
    });
  });

  it("restores collapsed project keys from persisted preferences", () => {
    const restored = mergePersistedCollapsedProjects(
      { collapsedProjectKeys: ["project-a", "project-b", 42] },
      emptyState(),
    );

    expect(Array.from(restored.collapsedProjectKeys)).toEqual(["project-a", "project-b"]);
    expect(Array.from(restored.collapsedStatusGroupKeys)).toEqual([]);
    expect(Array.from(restored.collapsedWorkspaceKeys)).toEqual([]);
  });

  it("restores collapsed workspace keys from persisted preferences", () => {
    const restored = mergePersistedCollapsedProjects(
      { collapsedWorkspaceKeys: ["workspace-a", 42, "workspace-b"] },
      emptyState(),
    );

    expect(Array.from(restored.collapsedProjectKeys)).toEqual([]);
    expect(Array.from(restored.collapsedStatusGroupKeys)).toEqual([]);
    expect(Array.from(restored.collapsedWorkspaceKeys)).toEqual(["workspace-a", "workspace-b"]);
  });

  it("keeps the existing state object when persisted preferences do not change collapsed keys", () => {
    const currentState = emptyState();

    expect(mergePersistedCollapsedProjects(undefined, currentState)).toBe(currentState);
    expect(mergePersistedCollapsedProjects({}, currentState)).toBe(currentState);
    expect(
      mergePersistedCollapsedProjects(
        { collapsedProjectKeys: [], collapsedStatusGroupKeys: [], collapsedWorkspaceKeys: [] },
        currentState,
      ),
    ).toBe(currentState);
  });
});
