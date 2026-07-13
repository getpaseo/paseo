import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

export type SidebarGroupMode = "project" | "project_collection" | "status" | "collection" | "none";
export type SidebarSortMode = "custom" | "alphabetical" | "created" | "recency";
export type SidebarVisibilityFilter = "visible" | "hidden" | "all";
export type SidebarLastActivityFilter = "all" | "today" | "seven_days" | "thirty_days";
export type SidebarStatusFilter = "needs_input" | "failed" | "attention" | "running" | "done";

const SIDEBAR_VIEW_STORAGE_KEY = "sidebar-view";
const LEGACY_SIDEBAR_GROUP_MODE_STORAGE_KEY = "sidebar-group-mode";
const SIDEBAR_VIEW_STORE_VERSION = 4;

interface SidebarViewStoreState {
  groupMode: SidebarGroupMode;
  sortMode: SidebarSortMode;
  visibilityFilter: SidebarVisibilityFilter;
  lastActivityFilter: SidebarLastActivityFilter;
  statusFilters: SidebarStatusFilter[];
  projectFilters: string[];
  // Empty means "all hosts". A non-empty list pins the sidebar to those hosts.
  hostFilters: string[];
  setGroupMode: (mode: SidebarGroupMode) => void;
  setSortMode: (mode: SidebarSortMode) => void;
  setVisibilityFilter: (filter: SidebarVisibilityFilter) => void;
  setLastActivityFilter: (filter: SidebarLastActivityFilter) => void;
  toggleStatusFilter: (status: SidebarStatusFilter) => void;
  clearStatusFilters: () => void;
  toggleProjectFilter: (projectKey: string) => void;
  clearProjectFilters: () => void;
  toggleHostFilter: (serverId: string) => void;
  clearHostFilters: () => void;
  reconcileHostFilters: (serverIds: readonly string[]) => void;
  reconcileProjectFilters: (projectKeys: readonly string[]) => void;
  clearFilters: () => void;
}

interface SidebarViewPersistedState {
  groupMode: SidebarGroupMode;
  sortMode: SidebarSortMode;
  visibilityFilter: SidebarVisibilityFilter;
  lastActivityFilter: SidebarLastActivityFilter;
  statusFilters: SidebarStatusFilter[];
  projectFilters: string[];
  hostFilters: string[];
}

function isSidebarGroupMode(value: unknown): value is SidebarGroupMode {
  return (
    value === "project" ||
    value === "project_collection" ||
    value === "status" ||
    value === "collection" ||
    value === "none"
  );
}

function isSidebarSortMode(value: unknown): value is SidebarSortMode {
  return (
    value === "custom" || value === "alphabetical" || value === "created" || value === "recency"
  );
}

function isSidebarVisibilityFilter(value: unknown): value is SidebarVisibilityFilter {
  return value === "visible" || value === "hidden" || value === "all";
}

function isSidebarLastActivityFilter(value: unknown): value is SidebarLastActivityFilter {
  return value === "all" || value === "today" || value === "seven_days" || value === "thirty_days";
}

function isSidebarStatusFilter(value: unknown): value is SidebarStatusFilter {
  return (
    value === "needs_input" ||
    value === "failed" ||
    value === "attention" ||
    value === "running" ||
    value === "done"
  );
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const values: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const normalized = entry.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    values.push(normalized);
  }
  return values;
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

// Reads the host filter from any persisted shape: the current `hostFilters` array, or the
// pre-v2 single `hostFilter` string (null/absent meant "all hosts").
function readHostFilters(persistedState: Record<string, unknown>): string[] {
  const hostFilters = persistedState.hostFilters;
  if (Array.isArray(hostFilters)) {
    return readStringList(hostFilters);
  }
  // COMPAT(sidebarHostFilters): added in v0.1.102, remove after 2026-12-30 once pre-v2 persisted
  // sidebar state (a single `hostFilter` string) has aged out.
  const legacyHostFilter = persistedState.hostFilter;
  return typeof legacyHostFilter === "string" ? [legacyHostFilter] : [];
}

export function migrateSidebarViewState(persistedState: unknown): SidebarViewPersistedState {
  if (!isRecord(persistedState)) {
    return {
      groupMode: "project",
      sortMode: "custom",
      visibilityFilter: "visible",
      lastActivityFilter: "all",
      statusFilters: [],
      projectFilters: [],
      hostFilters: [],
    };
  }

  const legacyGroupMode = readLegacyGroupMode(persistedState);
  if (legacyGroupMode) {
    return {
      groupMode: legacyGroupMode,
      sortMode: "custom",
      visibilityFilter: "visible",
      lastActivityFilter: "all",
      statusFilters: [],
      projectFilters: [],
      hostFilters: [],
    };
  }

  return {
    groupMode: isSidebarGroupMode(persistedState.groupMode) ? persistedState.groupMode : "project",
    sortMode: isSidebarSortMode(persistedState.sortMode) ? persistedState.sortMode : "custom",
    visibilityFilter: isSidebarVisibilityFilter(persistedState.visibilityFilter)
      ? persistedState.visibilityFilter
      : "visible",
    lastActivityFilter: isSidebarLastActivityFilter(persistedState.lastActivityFilter)
      ? persistedState.lastActivityFilter
      : "all",
    statusFilters: readStringList(persistedState.statusFilters).filter(isSidebarStatusFilter),
    projectFilters: readStringList(persistedState.projectFilters),
    hostFilters: readHostFilters(persistedState),
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
      visibilityFilter: "visible",
      lastActivityFilter: "all",
      statusFilters: [],
      projectFilters: [],
      hostFilters: [],
      setGroupMode: (mode) => set({ groupMode: mode }),
      setSortMode: (mode) => set({ sortMode: mode }),
      setVisibilityFilter: (filter) => set({ visibilityFilter: filter }),
      setLastActivityFilter: (filter) => set({ lastActivityFilter: filter }),
      toggleStatusFilter: (status) =>
        set((state) => ({
          statusFilters: state.statusFilters.includes(status)
            ? state.statusFilters.filter((value) => value !== status)
            : [...state.statusFilters, status],
        })),
      clearStatusFilters: () => set({ statusFilters: [] }),
      toggleProjectFilter: (projectKey) =>
        set((state) => ({
          projectFilters: state.projectFilters.includes(projectKey)
            ? state.projectFilters.filter((value) => value !== projectKey)
            : [...state.projectFilters, projectKey],
        })),
      clearProjectFilters: () => set({ projectFilters: [] }),
      toggleHostFilter: (serverId) =>
        set((state) => ({
          hostFilters: state.hostFilters.includes(serverId)
            ? state.hostFilters.filter((id) => id !== serverId)
            : [...state.hostFilters, serverId],
        })),
      clearHostFilters: () => set({ hostFilters: [] }),
      reconcileHostFilters: (serverIds) =>
        set((state) => {
          if (state.hostFilters.length === 0) {
            return state;
          }
          const allowed = new Set(serverIds);
          const next = state.hostFilters.filter((id) => allowed.has(id));
          if (next.length === state.hostFilters.length) {
            return state;
          }
          return { hostFilters: next };
        }),
      reconcileProjectFilters: (projectKeys) =>
        set((state) => {
          if (state.projectFilters.length === 0) return state;
          const allowed = new Set(projectKeys);
          const next = state.projectFilters.filter((key) => allowed.has(key));
          return next.length === state.projectFilters.length ? state : { projectFilters: next };
        }),
      clearFilters: () =>
        set({
          visibilityFilter: "visible",
          lastActivityFilter: "all",
          statusFilters: [],
          projectFilters: [],
          hostFilters: [],
        }),
    }),
    {
      name: SIDEBAR_VIEW_STORAGE_KEY,
      version: SIDEBAR_VIEW_STORE_VERSION,
      storage: createJSONStorage(createSidebarViewStorage),
      partialize: (state) => ({
        groupMode: state.groupMode,
        sortMode: state.sortMode,
        visibilityFilter: state.visibilityFilter,
        lastActivityFilter: state.lastActivityFilter,
        statusFilters: state.statusFilters,
        projectFilters: state.projectFilters,
        hostFilters: state.hostFilters,
      }),
      migrate: migrateSidebarViewState,
    },
  ),
);
