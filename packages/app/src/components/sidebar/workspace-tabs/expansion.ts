import { create } from "zustand";
import { buildSidebarTabSubagentsKey, toggleExpandedKey } from "./model";

interface SidebarWorkspaceTabsExpansionState {
  expandedWorkspaceKeys: ReadonlySet<string>;
  /** Agent tabs showing their subagents, keyed by `buildSidebarTabSubagentsKey`. */
  expandedTabSubagentKeys: ReadonlySet<string>;
  toggle: (workspaceKey: string) => void;
  toggleTabSubagents: (key: string) => void;
}

// Session-only on purpose: an expanded row is a glance, and persisting it would keep keys of
// workspaces that have since been archived.
const useSidebarWorkspaceTabsExpansionStore = create<SidebarWorkspaceTabsExpansionState>()(
  (set) => ({
    expandedWorkspaceKeys: new Set(),
    expandedTabSubagentKeys: new Set(),
    toggle: (workspaceKey) =>
      set((state) => ({
        expandedWorkspaceKeys: toggleExpandedKey(state.expandedWorkspaceKeys, workspaceKey),
      })),
    toggleTabSubagents: (key) =>
      set((state) => ({
        expandedTabSubagentKeys: toggleExpandedKey(state.expandedTabSubagentKeys, key),
      })),
  }),
);

export function useIsSidebarWorkspaceTabsExpanded(workspaceKey: string): boolean {
  return useSidebarWorkspaceTabsExpansionStore((state) =>
    state.expandedWorkspaceKeys.has(workspaceKey),
  );
}

export function toggleSidebarWorkspaceTabs(workspaceKey: string): void {
  useSidebarWorkspaceTabsExpansionStore.getState().toggle(workspaceKey);
}

export function useIsSidebarTabSubagentsExpanded(workspaceKey: string, tabId: string): boolean {
  const key = buildSidebarTabSubagentsKey(workspaceKey, tabId);
  return useSidebarWorkspaceTabsExpansionStore((state) => state.expandedTabSubagentKeys.has(key));
}

export function toggleSidebarTabSubagents(workspaceKey: string, tabId: string): void {
  useSidebarWorkspaceTabsExpansionStore
    .getState()
    .toggleTabSubagents(buildSidebarTabSubagentsKey(workspaceKey, tabId));
}
