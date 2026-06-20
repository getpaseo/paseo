import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type SidebarGroupMode = "project" | "status";
export type SidebarEmbeddedTabSortMode = "manual" | "created" | "lastUpdated";
export type SidebarEmbeddedRecentTabCount = 3 | 5 | 10 | "all";

interface SidebarViewStoreState {
  groupModeByServerId: Record<string, SidebarGroupMode>;
  embeddedTabSortModeByServerId: Record<string, SidebarEmbeddedTabSortMode>;
  embeddedRecentTabCountByServerId: Record<string, SidebarEmbeddedRecentTabCount>;
  getGroupMode: (serverId: string) => SidebarGroupMode;
  setGroupMode: (serverId: string, mode: SidebarGroupMode) => void;
  getEmbeddedTabSortMode: (serverId: string) => SidebarEmbeddedTabSortMode;
  setEmbeddedTabSortMode: (serverId: string, mode: SidebarEmbeddedTabSortMode) => void;
  getEmbeddedRecentTabCount: (serverId: string) => SidebarEmbeddedRecentTabCount;
  setEmbeddedRecentTabCount: (serverId: string, count: SidebarEmbeddedRecentTabCount) => void;
}

function normalizeTabSortMode(value: unknown): SidebarEmbeddedTabSortMode {
  return value === "created" || value === "lastUpdated" || value === "manual" ? value : "manual";
}

function normalizeRecentTabCount(value: unknown): SidebarEmbeddedRecentTabCount {
  return value === 3 || value === 5 || value === 10 || value === "all" ? value : 5;
}

export const useSidebarViewStore = create<SidebarViewStoreState>()(
  persist(
    (set, get) => ({
      groupModeByServerId: {},
      embeddedTabSortModeByServerId: {},
      embeddedRecentTabCountByServerId: {},
      getGroupMode: (serverId) => {
        const key = serverId.trim();
        if (!key) return "project";
        return get().groupModeByServerId[key] ?? "project";
      },
      setGroupMode: (serverId, mode) => {
        const key = serverId.trim();
        if (!key) return;
        set((state) => ({
          groupModeByServerId: {
            ...state.groupModeByServerId,
            [key]: mode,
          },
        }));
      },
      getEmbeddedTabSortMode: (serverId) => {
        const key = serverId.trim();
        if (!key) return "manual";
        return normalizeTabSortMode(get().embeddedTabSortModeByServerId[key]);
      },
      setEmbeddedTabSortMode: (serverId, mode) => {
        const key = serverId.trim();
        if (!key) return;
        set((state) => ({
          embeddedTabSortModeByServerId: {
            ...state.embeddedTabSortModeByServerId,
            [key]: normalizeTabSortMode(mode),
          },
        }));
      },
      getEmbeddedRecentTabCount: (serverId) => {
        const key = serverId.trim();
        if (!key) return 5;
        return normalizeRecentTabCount(get().embeddedRecentTabCountByServerId[key]);
      },
      setEmbeddedRecentTabCount: (serverId, count) => {
        const key = serverId.trim();
        if (!key) return;
        set((state) => ({
          embeddedRecentTabCountByServerId: {
            ...state.embeddedRecentTabCountByServerId,
            [key]: normalizeRecentTabCount(count),
          },
        }));
      },
    }),
    {
      name: "sidebar-group-mode",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        groupModeByServerId: state.groupModeByServerId,
        embeddedTabSortModeByServerId: state.embeddedTabSortModeByServerId,
        embeddedRecentTabCountByServerId: state.embeddedRecentTabCountByServerId,
      }),
    },
  ),
);
