import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  type CollapsedProjectsState,
  type PersistedCollapsedProjects,
  mergePersistedCollapsedProjects,
  serializeCollapsedProjects,
  setExpandedProjectKeys,
  setProjectCollapsed,
  togglePinnedCollapsed,
  toggleProjectCollapsed,
  toggleStatusGroupCollapsed,
} from "./state";

interface SidebarCollapsedSectionsState extends CollapsedProjectsState {
  toggleProjectCollapsed: (projectKey: string) => void;
  setProjectCollapsed: (projectKey: string, collapsed: boolean) => void;
  setExpandedProjectKeys: (projectKeys: Iterable<string>) => void;
  toggleStatusGroupCollapsed: (statusGroupKey: string) => void;
  togglePinnedCollapsed: () => void;
}

export const useSidebarCollapsedSectionsStore = create<SidebarCollapsedSectionsState>()(
  persist(
    (set) => ({
      expandedProjectKeys: new Set(),
      collapsedStatusGroupKeys: new Set(),
      collapsedPinned: false,
      toggleProjectCollapsed: (projectKey) =>
        set((state) => toggleProjectCollapsed(state, projectKey)),
      setProjectCollapsed: (projectKey, collapsed) =>
        set((state) => setProjectCollapsed(state, projectKey, collapsed)),
      setExpandedProjectKeys: (projectKeys) =>
        set((state) => setExpandedProjectKeys(state, projectKeys)),
      toggleStatusGroupCollapsed: (statusGroupKey) =>
        set((state) => toggleStatusGroupCollapsed(state, statusGroupKey)),
      togglePinnedCollapsed: () => set((state) => togglePinnedCollapsed(state)),
    }),
    {
      name: "sidebar-collapsed-sections",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => serializeCollapsedProjects(state),
      merge: (persistedState, currentState) =>
        mergePersistedCollapsedProjects(
          persistedState as PersistedCollapsedProjects | undefined,
          currentState,
        ),
    },
  ),
);
