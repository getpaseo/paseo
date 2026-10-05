import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import {
  type CollapsedProjectsState,
  type PersistedCollapsedProjects,
  mergePersistedCollapsedProjects,
  PersistedCollapsedProjectsSchema,
  serializeCollapsedProjects,
  setProjectCollapsed,
  togglePinnedCollapsed,
  toggleProjectCollapsed,
  toggleWorkspaceGroupCollapsed,
  toggleWorkspaceTabsExpanded,
  setWorkspaceTabsExpanded,
} from "./state";

interface SidebarCollapsedSectionsState extends CollapsedProjectsState {
  toggleProjectCollapsed: (projectKey: string) => void;
  setProjectCollapsed: (projectKey: string, collapsed: boolean) => void;
  toggleWorkspaceGroupCollapsed: (workspaceGroupKey: string) => void;
  togglePinnedCollapsed: () => void;
  toggleWorkspaceTabsExpanded: (workspaceKey: string) => void;
  setWorkspaceTabsExpanded: (workspaceKey: string, expanded: boolean) => void;
}

export const useSidebarCollapsedSectionsStore = create<SidebarCollapsedSectionsState>()(
  persist<SidebarCollapsedSectionsState, [], [], PersistedCollapsedProjects>(
    (set) => ({
      collapsedProjectKeys: new Set(),
      collapsedWorkspaceGroupKeys: new Set(),
      collapsedPinned: false,
      expandedTabWorkspaceKeys: new Set(),
      toggleProjectCollapsed: (projectKey) =>
        set((state) => toggleProjectCollapsed(state, projectKey)),
      setProjectCollapsed: (projectKey, collapsed) =>
        set((state) => setProjectCollapsed(state, projectKey, collapsed)),
      toggleWorkspaceGroupCollapsed: (workspaceGroupKey) =>
        set((state) => toggleWorkspaceGroupCollapsed(state, workspaceGroupKey)),
      togglePinnedCollapsed: () => set((state) => togglePinnedCollapsed(state)),
      toggleWorkspaceTabsExpanded: (workspaceKey) =>
        set((state) => toggleWorkspaceTabsExpanded(state, workspaceKey)),
      setWorkspaceTabsExpanded: (workspaceKey, expanded) =>
        set((state) => setWorkspaceTabsExpanded(state, workspaceKey, expanded)),
    }),
    {
      name: "sidebar-collapsed-sections",
      storage: createValidatedPersistStorage(AsyncStorage, PersistedCollapsedProjectsSchema),
      partialize: (state) => serializeCollapsedProjects(state),
      merge: (persistedState, currentState) =>
        mergePersistedCollapsedProjects(persistedState, currentState),
    },
  ),
);
