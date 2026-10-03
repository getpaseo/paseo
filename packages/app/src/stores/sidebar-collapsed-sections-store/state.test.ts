import { describe, expect, it } from "vitest";
import {
  type CollapsedProjectsState,
  mergePersistedCollapsedProjects,
  serializeCollapsedProjects,
  setProjectCollapsed,
  togglePinnedCollapsed,
  toggleProjectCollapsed,
  toggleWorkspaceGroupCollapsed,
  setWorkspaceTabsExpanded,
  toggleWorkspaceTabsExpanded,
} from "@/stores/sidebar-collapsed-sections-store/state";

function emptyState(): CollapsedProjectsState {
  return {
    collapsedProjectKeys: new Set(),
    collapsedWorkspaceGroupKeys: new Set(),
    collapsedPinned: false,
    expandedTabWorkspaceKeys: new Set(),
  };
}

describe("sidebar collapsed projects transitions", () => {
  it("tracks collapsed project keys as a Set", () => {
    let state = emptyState();

    state = setProjectCollapsed(state, "project-a", true);
    state = toggleProjectCollapsed(state, "project-b");
    state = toggleProjectCollapsed(state, "project-a");
    state = toggleWorkspaceGroupCollapsed(state, "running");

    expect(Array.from(state.collapsedProjectKeys)).toEqual(["project-b"]);
    expect(Array.from(state.collapsedWorkspaceGroupKeys)).toEqual(["running"]);
  });

  it("serializes collapsed project keys for preference storage", () => {
    const state: CollapsedProjectsState = {
      collapsedProjectKeys: new Set(["project-a", "project-b"]),
      collapsedWorkspaceGroupKeys: new Set(["running"]),
      collapsedPinned: true,
      expandedTabWorkspaceKeys: new Set(["srv:ws-1"]),
    };

    expect(serializeCollapsedProjects(state)).toEqual({
      collapsedProjectKeys: ["project-a", "project-b"],
      collapsedWorkspaceGroupKeys: ["running"],
      collapsedPinned: true,
      expandedTabWorkspaceKeys: ["srv:ws-1"],
    });
  });

  it("toggles and restores the pinned section collapse flag", () => {
    const toggled = togglePinnedCollapsed(emptyState());
    expect(toggled.collapsedPinned).toBe(true);

    const restored = mergePersistedCollapsedProjects({ collapsedPinned: true }, emptyState());
    expect(restored.collapsedPinned).toBe(true);
  });

  it("rejects the complete value when a persisted project key is invalid", () => {
    const restored = mergePersistedCollapsedProjects(
      { collapsedProjectKeys: ["project-a", "project-b", 42] },
      emptyState(),
    );

    expect(Array.from(restored.collapsedProjectKeys)).toEqual([]);
    expect(Array.from(restored.collapsedWorkspaceGroupKeys)).toEqual([]);
  });

  it("keeps the existing state object when persisted preferences do not change collapsed keys", () => {
    const currentState = emptyState();

    expect(mergePersistedCollapsedProjects(undefined, currentState)).toBe(currentState);
    expect(mergePersistedCollapsedProjects({}, currentState)).toBe(currentState);
    expect(mergePersistedCollapsedProjects({ collapsedProjectKeys: [] }, currentState)).toBe(
      currentState,
    );
  });

  it("toggles a workspace tab folder and restores it from storage", () => {
    let state = toggleWorkspaceTabsExpanded(emptyState(), "srv:ws-1");
    expect(Array.from(state.expandedTabWorkspaceKeys)).toEqual(["srv:ws-1"]);

    state = toggleWorkspaceTabsExpanded(state, "srv:ws-1");
    expect(Array.from(state.expandedTabWorkspaceKeys)).toEqual([]);

    const restored = mergePersistedCollapsedProjects(
      { expandedTabWorkspaceKeys: ["srv:ws-2"] },
      emptyState(),
    );
    expect(Array.from(restored.expandedTabWorkspaceKeys)).toEqual(["srv:ws-2"]);
  });

  it("sets a workspace tab folder open without churning state that already matches", () => {
    const opened = setWorkspaceTabsExpanded(emptyState(), "srv:ws-1", true);
    expect(Array.from(opened.expandedTabWorkspaceKeys)).toEqual(["srv:ws-1"]);
    expect(setWorkspaceTabsExpanded(opened, "srv:ws-1", true)).toBe(opened);

    const closed = setWorkspaceTabsExpanded(opened, "srv:ws-1", false);
    expect(Array.from(closed.expandedTabWorkspaceKeys)).toEqual([]);
  });
});
