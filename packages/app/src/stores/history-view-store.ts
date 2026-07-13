import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

export type HistoryStatusFilter = "active" | "archived" | "all";
export type HistoryLastActivityFilter = "any" | "today" | "7d" | "30d";
export type HistoryGroupMode = "last_activity" | "project" | "none";
export type HistorySortMode = "alphabetical" | "created" | "recency";

export interface HistoryViewPersistedState {
  status: HistoryStatusFilter;
  projectFilters: string[];
  hostFilters: string[];
  lastActivity: HistoryLastActivityFilter;
  groupMode: HistoryGroupMode;
  sortMode: HistorySortMode;
}

interface HistoryViewStoreState extends HistoryViewPersistedState {
  setStatus: (status: HistoryStatusFilter) => void;
  toggleProjectFilter: (projectKey: string) => void;
  clearProjectFilters: () => void;
  toggleHostFilter: (serverId: string) => void;
  clearHostFilters: () => void;
  setLastActivity: (lastActivity: HistoryLastActivityFilter) => void;
  setGroupMode: (groupMode: HistoryGroupMode) => void;
  setSortMode: (sortMode: HistorySortMode) => void;
  clearFilters: () => void;
  reconcileProjectFilters: (projectKeys: readonly string[]) => void;
  reconcileHostFilters: (serverIds: readonly string[]) => void;
}

export const DEFAULT_HISTORY_VIEW_STATE: HistoryViewPersistedState = {
  status: "all",
  projectFilters: [],
  hostFilters: [],
  lastActivity: "any",
  groupMode: "last_activity",
  sortMode: "recency",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStatus(value: unknown): value is HistoryStatusFilter {
  return value === "active" || value === "archived" || value === "all";
}

function isLastActivity(value: unknown): value is HistoryLastActivityFilter {
  return value === "any" || value === "today" || value === "7d" || value === "30d";
}

function isGroupMode(value: unknown): value is HistoryGroupMode {
  return value === "last_activity" || value === "project" || value === "none";
}

function isSortMode(value: unknown): value is HistorySortMode {
  return value === "alphabetical" || value === "created" || value === "recency";
}

function normalizeKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "string") continue;
    const key = candidate.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result;
}

export function migrateHistoryViewState(value: unknown): HistoryViewPersistedState {
  if (!isRecord(value)) return DEFAULT_HISTORY_VIEW_STATE;
  return {
    status: isStatus(value.status) ? value.status : DEFAULT_HISTORY_VIEW_STATE.status,
    projectFilters: normalizeKeys(value.projectFilters),
    hostFilters: normalizeKeys(value.hostFilters),
    lastActivity: isLastActivity(value.lastActivity)
      ? value.lastActivity
      : DEFAULT_HISTORY_VIEW_STATE.lastActivity,
    groupMode: isGroupMode(value.groupMode)
      ? value.groupMode
      : DEFAULT_HISTORY_VIEW_STATE.groupMode,
    sortMode: isSortMode(value.sortMode) ? value.sortMode : DEFAULT_HISTORY_VIEW_STATE.sortMode,
  };
}

function toggleKey(keys: string[], rawKey: string): string[] {
  const key = rawKey.trim();
  if (!key) return keys;
  return keys.includes(key) ? keys.filter((candidate) => candidate !== key) : [...keys, key];
}

function reconcileKeys(keys: string[], availableKeys: readonly string[]): string[] {
  if (keys.length === 0) return keys;
  const available = new Set(availableKeys);
  const next = keys.filter((key) => available.has(key));
  return next.length === keys.length ? keys : next;
}

export function createHistoryViewStore(storage: StateStorage = AsyncStorage) {
  return create<HistoryViewStoreState>()(
    persist(
      (set) => ({
        ...DEFAULT_HISTORY_VIEW_STATE,
        setStatus: (status) => set({ status }),
        toggleProjectFilter: (projectKey) =>
          set((state) => ({ projectFilters: toggleKey(state.projectFilters, projectKey) })),
        clearProjectFilters: () => set({ projectFilters: [] }),
        toggleHostFilter: (serverId) =>
          set((state) => ({ hostFilters: toggleKey(state.hostFilters, serverId) })),
        clearHostFilters: () => set({ hostFilters: [] }),
        setLastActivity: (lastActivity) => set({ lastActivity }),
        setGroupMode: (groupMode) => set({ groupMode }),
        setSortMode: (sortMode) => set({ sortMode }),
        clearFilters: () =>
          set({
            status: DEFAULT_HISTORY_VIEW_STATE.status,
            projectFilters: [],
            hostFilters: [],
            lastActivity: DEFAULT_HISTORY_VIEW_STATE.lastActivity,
          }),
        reconcileProjectFilters: (projectKeys) =>
          set((state) => {
            const projectFilters = reconcileKeys(state.projectFilters, projectKeys);
            return projectFilters === state.projectFilters ? state : { projectFilters };
          }),
        reconcileHostFilters: (serverIds) =>
          set((state) => {
            const hostFilters = reconcileKeys(state.hostFilters, serverIds);
            return hostFilters === state.hostFilters ? state : { hostFilters };
          }),
      }),
      {
        name: "history-view",
        version: 1,
        storage: createJSONStorage(() => storage),
        partialize: (state) => ({
          status: state.status,
          projectFilters: state.projectFilters,
          hostFilters: state.hostFilters,
          lastActivity: state.lastActivity,
          groupMode: state.groupMode,
          sortMode: state.sortMode,
        }),
        migrate: migrateHistoryViewState,
      },
    ),
  );
}

export const useHistoryViewStore = createHistoryViewStore();
