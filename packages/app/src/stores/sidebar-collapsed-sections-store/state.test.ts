import { describe, expect, it } from "vitest";
import {
  type CollapsedProjectsState,
  mergePersistedCollapsedProjects,
  resolveCollapsedProjectKeys,
  serializeCollapsedProjects,
  setProjectCollapsed,
  togglePinnedCollapsed,
  toggleProjectCollapsed,
  toggleStatusGroupCollapsed,
} from "@/stores/sidebar-collapsed-sections-store/state";

function emptyState(): CollapsedProjectsState {
  return {
    expandedProjectKeys: new Set(),
    collapsedStatusGroupKeys: new Set(),
    collapsedPinned: false,
  };
}

describe("sidebar collapsed projects transitions", () => {
  it("defaults projects to collapsed and tracks explicit expansions", () => {
    let state = emptyState();

    expect(
      Array.from(
        resolveCollapsedProjectKeys(["project-a", "project-b"], state.expandedProjectKeys),
      ),
    ).toEqual(["project-a", "project-b"]);

    state = setProjectCollapsed(state, "project-a", false);
    state = toggleProjectCollapsed(state, "project-b");
    state = toggleProjectCollapsed(state, "project-a");
    state = toggleStatusGroupCollapsed(state, "running");

    expect(Array.from(state.expandedProjectKeys)).toEqual(["project-b"]);
    expect(
      Array.from(
        resolveCollapsedProjectKeys(["project-a", "project-b"], state.expandedProjectKeys),
      ),
    ).toEqual(["project-a"]);
    expect(Array.from(state.collapsedStatusGroupKeys)).toEqual(["running"]);
  });

  it("serializes expanded project keys for preference storage", () => {
    const state: CollapsedProjectsState = {
      expandedProjectKeys: new Set(["project-a", "project-b"]),
      collapsedStatusGroupKeys: new Set(["running"]),
      collapsedPinned: true,
    };

    expect(serializeCollapsedProjects(state)).toEqual({
      expandedProjectKeys: ["project-a", "project-b"],
      collapsedStatusGroupKeys: ["running"],
      collapsedPinned: true,
    });
  });

  it("toggles and restores the pinned section collapse flag", () => {
    const toggled = togglePinnedCollapsed(emptyState());
    expect(toggled.collapsedPinned).toBe(true);

    const restored = mergePersistedCollapsedProjects({ collapsedPinned: true }, emptyState());
    expect(restored.collapsedPinned).toBe(true);
  });

  it("restores expanded project keys from persisted preferences", () => {
    const restored = mergePersistedCollapsedProjects(
      { expandedProjectKeys: ["project-a", "project-b", 42] },
      emptyState(),
    );

    expect(Array.from(restored.expandedProjectKeys)).toEqual(["project-a", "project-b"]);
    expect(Array.from(restored.collapsedStatusGroupKeys)).toEqual([]);
  });

  it("keeps the existing state object when persisted preferences do not change collapsed keys", () => {
    const currentState = emptyState();

    expect(mergePersistedCollapsedProjects(undefined, currentState)).toBe(currentState);
    expect(mergePersistedCollapsedProjects({}, currentState)).toBe(currentState);
    expect(mergePersistedCollapsedProjects({ expandedProjectKeys: [] }, currentState)).toBe(
      currentState,
    );
  });
});
