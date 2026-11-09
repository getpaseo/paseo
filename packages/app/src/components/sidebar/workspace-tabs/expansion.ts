import { create } from "zustand";
import { toggleExpandedWorkspaceKey } from "./model";

interface SidebarWorkspaceTabsExpansionState {
  expandedWorkspaceKeys: ReadonlySet<string>;
  toggle: (workspaceKey: string) => void;
}

// Session-only on purpose: an expanded row is a glance, and persisting it would keep keys of
// workspaces that have since been archived.
const useSidebarWorkspaceTabsExpansionStore = create<SidebarWorkspaceTabsExpansionState>()(
  (set) => ({
    expandedWorkspaceKeys: new Set(),
    toggle: (workspaceKey) =>
      set((state) => ({
        expandedWorkspaceKeys: toggleExpandedWorkspaceKey(
          state.expandedWorkspaceKeys,
          workspaceKey,
        ),
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
