import { create } from "zustand";

interface SidebarCollapsedSectionsState {
  collapsedProjectKeys: Set<string>;
  toggleProjectCollapsed: (projectKey: string) => void;
  setProjectCollapsed: (projectKey: string, collapsed: boolean) => void;
}

export const useSidebarCollapsedSectionsStore = create<SidebarCollapsedSectionsState>(
  (set) => ({
    collapsedProjectKeys: new Set(),
    toggleProjectCollapsed: (projectKey) =>
      set((state) => {
        const next = new Set(state.collapsedProjectKeys);
        if (next.has(projectKey)) {
          next.delete(projectKey);
        } else {
          next.add(projectKey);
        }
        return { collapsedProjectKeys: next };
      }),
    setProjectCollapsed: (projectKey, collapsed) =>
      set((state) => {
        const next = new Set(state.collapsedProjectKeys);
        if (collapsed) {
          next.add(projectKey);
        } else {
          next.delete(projectKey);
        }
        return { collapsedProjectKeys: next };
      }),
  })
);

