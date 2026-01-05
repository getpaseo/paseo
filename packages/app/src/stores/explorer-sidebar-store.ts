import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";

type ExplorerTab = "changes" | "files";
export type ViewMode = "list" | "grid";
export type SortOption = "name" | "modified" | "size";

export const DEFAULT_EXPLORER_SIDEBAR_WIDTH = 400;
export const MIN_EXPLORER_SIDEBAR_WIDTH = 280;
export const MAX_EXPLORER_SIDEBAR_WIDTH = 800;

interface ExplorerSidebarState {
  isOpen: boolean;
  activeTab: ExplorerTab;
  width: number;
  viewMode: ViewMode;
  sortOption: SortOption;
  toggle: () => void;
  open: () => void;
  close: () => void;
  setActiveTab: (tab: ExplorerTab) => void;
  setWidth: (width: number) => void;
  setViewMode: (mode: ViewMode) => void;
  setSortOption: (option: SortOption) => void;
}

function clampWidth(width: number): number {
  return Math.max(MIN_EXPLORER_SIDEBAR_WIDTH, Math.min(MAX_EXPLORER_SIDEBAR_WIDTH, width));
}

export const useExplorerSidebarStore = create<ExplorerSidebarState>()(
  persist(
    (set) => ({
      isOpen: false,
      activeTab: "changes",
      width: DEFAULT_EXPLORER_SIDEBAR_WIDTH,
      viewMode: "list",
      sortOption: "name",
      toggle: () => set((state) => ({ isOpen: !state.isOpen })),
      open: () => set({ isOpen: true }),
      close: () => set({ isOpen: false }),
      setActiveTab: (tab) => set({ activeTab: tab }),
      setWidth: (width) => set({ width: clampWidth(width) }),
      setViewMode: (mode) => set({ viewMode: mode }),
      setSortOption: (option) => set({ sortOption: option }),
    }),
    {
      name: "explorer-sidebar-state",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        isOpen: state.isOpen,
        activeTab: state.activeTab,
        width: state.width,
        viewMode: state.viewMode,
        sortOption: state.sortOption,
      }),
    }
  )
);

export function useExplorerSidebar() {
  return useExplorerSidebarStore();
}
