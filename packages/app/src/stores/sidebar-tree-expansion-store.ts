import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/**
 * Expansion state for the per-workspace agent/terminal tree in the sidebar.
 *
 * Two independent key spaces:
 * - `expandedWorkspaceKeys` — a workspace row's subtree is open. Keyed by the
 *   sidebar workspace key (`${serverId}:${workspaceId}`).
 * - `expandedAgentKeys` — an individual agent node's children are open. Keyed
 *   by `${serverId}:${agentId}` so the same agent collapses consistently
 *   across any workspace that surfaces it.
 */
interface SidebarTreeExpansionState {
  expandedWorkspaceKeys: Set<string>;
  expandedAgentKeys: Set<string>;
  toggleWorkspaceExpanded: (key: string) => void;
  setWorkspaceExpanded: (key: string, expanded: boolean) => void;
  toggleAgentExpanded: (key: string) => void;
}

function toggleSet(set: Set<string>, key: string): Set<string> {
  const next = new Set(set);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  return next;
}

function setMembership(set: Set<string>, key: string, member: boolean): Set<string> {
  if (member === set.has(key)) {
    return set;
  }
  const next = new Set(set);
  if (member) {
    next.add(key);
  } else {
    next.delete(key);
  }
  return next;
}

export const useSidebarTreeExpansionStore = create<SidebarTreeExpansionState>()(
  persist(
    (set) => ({
      expandedWorkspaceKeys: new Set(),
      expandedAgentKeys: new Set(),
      toggleWorkspaceExpanded: (key) =>
        set((state) => ({ expandedWorkspaceKeys: toggleSet(state.expandedWorkspaceKeys, key) })),
      setWorkspaceExpanded: (key, expanded) =>
        set((state) => ({
          expandedWorkspaceKeys: setMembership(state.expandedWorkspaceKeys, key, expanded),
        })),
      toggleAgentExpanded: (key) =>
        set((state) => ({ expandedAgentKeys: toggleSet(state.expandedAgentKeys, key) })),
    }),
    {
      name: "sidebar-tree-expansion",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        expandedWorkspaceKeys: Array.from(state.expandedWorkspaceKeys),
        expandedAgentKeys: Array.from(state.expandedAgentKeys),
      }),
      merge: (persisted, current) => {
        const data = persisted as
          | { expandedWorkspaceKeys?: unknown; expandedAgentKeys?: unknown }
          | undefined;
        return {
          ...current,
          expandedWorkspaceKeys: deserializeKeySet(data?.expandedWorkspaceKeys),
          expandedAgentKeys: deserializeKeySet(data?.expandedAgentKeys),
        };
      },
    },
  ),
);

function deserializeKeySet(value: unknown): Set<string> {
  if (!Array.isArray(value)) {
    return new Set();
  }
  const next = new Set<string>();
  for (const entry of value) {
    if (typeof entry === "string") {
      next.add(entry);
    }
  }
  return next;
}
