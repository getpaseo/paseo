import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

export type SidebarGroupMode = "project" | "status";

const SIDEBAR_VIEW_STORAGE_KEY = "sidebar-view";
const LEGACY_SIDEBAR_GROUP_MODE_STORAGE_KEY = "sidebar-group-mode";
const SIDEBAR_VIEW_STORE_VERSION = 1;

interface SidebarViewStoreState {
  groupMode: SidebarGroupMode;
  hostFilter: string | null;
  setGroupMode: (mode: SidebarGroupMode) => void;
  setHostFilter: (serverId: string | null) => void;
  reconcileHostFilter: (serverIds: readonly string[]) => void;
}

interface SidebarViewPersistedState {
  groupMode: SidebarGroupMode;
  hostFilter: string | null;
}

function isSidebarGroupMode(value: unknown): value is SidebarGroupMode {
  return value === "project" || value === "status";
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
    return { groupMode: "project", hostFilter: null };
  }

  const legacyGroupMode = readLegacyGroupMode(persistedState);
  if (legacyGroupMode) {
    return { groupMode: legacyGroupMode, hostFilter: null };
  }

  return {
    groupMode: isSidebarGroupMode(persistedState.groupMode) ? persistedState.groupMode : "project",
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
      hostFilter: null,
      setGroupMode: (mode) => set({ groupMode: mode }),
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
        hostFilter: state.hostFilter,
      }),
      migrate: migrateSidebarViewState,
    },
  ),
);
