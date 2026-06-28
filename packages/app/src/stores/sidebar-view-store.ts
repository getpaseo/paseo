import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

export type SidebarGroupMode = "project" | "status" | "flat";
export type SidebarSortMode = "custom" | "activity" | "alphabetical";

const SIDEBAR_VIEW_STORAGE_KEY = "sidebar-view";
const LEGACY_SIDEBAR_GROUP_MODE_STORAGE_KEY = "sidebar-group-mode";
const SIDEBAR_VIEW_STORE_VERSION = 2;

interface SidebarViewStoreState {
  groupMode: SidebarGroupMode;
  sortMode: SidebarSortMode;
  hostFilter: string | null;
  setGroupMode: (mode: SidebarGroupMode) => void;
  setSortMode: (mode: SidebarSortMode) => void;
  setHostFilter: (serverId: string | null) => void;
  reconcileHostFilter: (serverIds: readonly string[]) => void;
}

interface SidebarViewPersistedState {
  groupMode: SidebarGroupMode;
  sortMode: SidebarSortMode;
  hostFilter: string | null;
}

function isSidebarGroupMode(value: unknown): value is SidebarGroupMode {
  return value === "project" || value === "status" || value === "flat";
}

function isSidebarSortMode(value: unknown): value is SidebarSortMode {
  return value === "custom" || value === "activity" || value === "alphabetical";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readLegacyGroupMode(persistedState: Record<string, unknown>): SidebarGroupMode | null {
  const groupModeByServerId = persistedState.groupModeByServerId;
  if (!isRecord(groupModeByServerId)) {
    return null;
  }

  const modes = Object.values(groupModeByServerId).filter(isSidebarGroupMode);
  if (modes.length === 0) return null;
  return modes.includes("status") ? "status" : "project";
}

export function migrateSidebarViewState(persistedState: unknown): SidebarViewPersistedState {
  if (!isRecord(persistedState)) {
    return { groupMode: "project", sortMode: "custom", hostFilter: null };
  }

  const legacyGroupMode = readLegacyGroupMode(persistedState);
  if (legacyGroupMode) {
    return { groupMode: legacyGroupMode, sortMode: "custom", hostFilter: null };
  }

  return {
    groupMode: isSidebarGroupMode(persistedState.groupMode) ? persistedState.groupMode : "project",
    sortMode: isSidebarSortMode(persistedState.sortMode) ? persistedState.sortMode : "custom",
    hostFilter: typeof persistedState.hostFilter === "string" ? persistedState.hostFilter : null,
  };
}

export function createSidebarViewStorage(
  backingStorage: StateStorage = AsyncStorage,
): StateStorage {
  return {
    getItem: async (name) => {
      const value = await backingStorage.getItem(name);
      if (value !== null || name !== SIDEBAR_VIEW_STORAGE_KEY) {
        return value;
      }
      return backingStorage.getItem(LEGACY_SIDEBAR_GROUP_MODE_STORAGE_KEY);
    },
    setItem: (name, value) => backingStorage.setItem(name, value),
    removeItem: (name) => backingStorage.removeItem(name),
  };
}

export const useSidebarViewStore = create<SidebarViewStoreState>()(
  persist(
    (set) => ({
      groupMode: "project",
      sortMode: "custom",
      hostFilter: null,
      setGroupMode: (mode) => set({ groupMode: mode }),
      setSortMode: (mode) => set({ sortMode: mode }),
      setHostFilter: (serverId) => set({ hostFilter: serverId }),
      reconcileHostFilter: (serverIds) =>
        set((state) => {
          if (!state.hostFilter || serverIds.includes(state.hostFilter)) {
            return state;
          }
          return { hostFilter: null };
        }),
    }),
    {
      name: SIDEBAR_VIEW_STORAGE_KEY,
      version: SIDEBAR_VIEW_STORE_VERSION,
      storage: createJSONStorage(createSidebarViewStorage),
      partialize: (state) => ({
        groupMode: state.groupMode,
        sortMode: state.sortMode,
        hostFilter: state.hostFilter,
      }),
      migrate: migrateSidebarViewState,
    },
  ),
);
