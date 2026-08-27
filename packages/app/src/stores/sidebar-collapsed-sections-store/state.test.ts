import { describe, expect, it } from "vitest";
import {
  type CollapsedProjectsState,
  mergePersistedCollapsedProjects,
  serializeCollapsedProjects,
  setProjectCollapsed,
  togglePinnedCollapsed,
  toggleProjectCollapsed,
  toggleWorkspaceGroupCollapsed,
  isAgentListExpanded,
  toggleAgentListExpanded,
} from "@/stores/sidebar-collapsed-sections-store/state";

function emptyState(): CollapsedProjectsState {
  return {
    collapsedProjectKeys: new Set(),
    collapsedWorkspaceGroupKeys: new Set(),
    collapsedPinned: false,
    agentListOverrides: new Map(),
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
      agentListOverrides: new Map(),
    };

    expect(serializeCollapsedProjects(state)).toEqual({
      collapsedProjectKeys: ["project-a", "project-b"],
      collapsedWorkspaceGroupKeys: ["running"],
      collapsedPinned: true,
      agentListOverrides: {},
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
});

describe("sidebar agent list expansion", () => {
  it("reads the display preference until a workspace is toggled", () => {
    const state = emptyState();
    expect(isAgentListExpanded(state, "host-a:ws-1", false)).toBe(false);
    expect(isAgentListExpanded(state, "host-a:ws-1", true)).toBe(true);
  });

  it("stores an override only while it differs from the default", () => {
    const expanded = toggleAgentListExpanded(emptyState(), "host-a:ws-1", false);
    expect(isAgentListExpanded(expanded, "host-a:ws-1", false)).toBe(true);
    expect(expanded.agentListOverrides.get("host-a:ws-1")).toBe(true);

    // Back to the default: the override is dropped rather than pinned, so a later change to the
    // display preference still reaches this workspace.
    const collapsed = toggleAgentListExpanded(expanded, "host-a:ws-1", false);
    expect(collapsed.agentListOverrides.has("host-a:ws-1")).toBe(false);
    expect(isAgentListExpanded(collapsed, "host-a:ws-1", true)).toBe(true);
  });

  it("keeps overrides per workspace", () => {
    const state = toggleAgentListExpanded(emptyState(), "host-a:ws-1", false);
    expect(isAgentListExpanded(state, "host-a:ws-2", false)).toBe(false);
  });

  it("round-trips overrides through persistence", () => {
    const state = toggleAgentListExpanded(emptyState(), "host-a:ws-1", false);
    const restored = mergePersistedCollapsedProjects(
      serializeCollapsedProjects(state),
      emptyState(),
    );
    expect(isAgentListExpanded(restored, "host-a:ws-1", false)).toBe(true);
  });
});
