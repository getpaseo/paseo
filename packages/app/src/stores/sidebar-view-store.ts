import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist, type StateStorage } from "zustand/middleware";
import { z } from "zod";
import { workspaceLabelKey } from "@getpaseo/protocol/workspace-labels";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

export type SidebarGroupMode = "project" | "status" | "label";
export type SidebarLabelMatch = "any" | "all";

const SIDEBAR_VIEW_STORAGE_KEY = "sidebar-view";
const LEGACY_SIDEBAR_GROUP_MODE_STORAGE_KEY = "sidebar-group-mode";
const SIDEBAR_VIEW_STORE_VERSION = 3;

export interface SidebarLabelFilter {
  include: string[];
  exclude: string[];
  includeUnlabelled: boolean;
  excludeUnlabelled: boolean;
  match: SidebarLabelMatch;
}

export function deduplicateSidebarLabelNames(names: readonly string[]): string[] {
  const namesByKey = new Map<string, string>();
  for (const name of names) {
    const key = workspaceLabelKey(name);
    if (key && !namesByKey.has(key)) namesByKey.set(key, name);
  }
  return [...namesByKey.values()];
}

export function sidebarLabelSelectionIncludes(names: readonly string[], name: string): boolean {
  const key = workspaceLabelKey(name);
  return names.some((candidate) => workspaceLabelKey(candidate) === key);
}

export function toggleSidebarLabelSelection(names: readonly string[], name: string): string[] {
  const key = workspaceLabelKey(name);
  const uniqueNames = deduplicateSidebarLabelNames(names);
  const withoutName = uniqueNames.filter((candidate) => workspaceLabelKey(candidate) !== key);
  return withoutName.length < uniqueNames.length ? withoutName : [...withoutName, name];
}

export function countSidebarLabelSelections(names: readonly string[]): number {
  return deduplicateSidebarLabelNames(names).length;
}

interface SidebarViewStoreState {
  groupMode: SidebarGroupMode;
  // Empty means "all hosts". A non-empty list pins the sidebar to those hosts.
  hostFilters: string[];
  labelFilter: SidebarLabelFilter;
  setGroupMode: (mode: SidebarGroupMode) => void;
  toggleHostFilter: (serverId: string) => void;
  clearHostFilters: () => void;
  setLabelFilter: (filter: SidebarLabelFilter) => void;
  clearLabelFilter: () => void;
  reconcileHostFilters: (serverIds: readonly string[]) => void;
}

interface SidebarViewPersistedState {
  groupMode: SidebarGroupMode;
  hostFilters: string[];
  labelFilter: SidebarLabelFilter;
}

const SidebarGroupModeSchema = z.enum(["project", "status", "label"]);
const SidebarLabelFilterSchema = z.object({
  include: z.array(z.string()),
  exclude: z.array(z.string()),
  includeUnlabelled: z.boolean().optional(),
  excludeUnlabelled: z.boolean().optional(),
  match: z.enum(["any", "all"]),
});
const SidebarViewPersistedStateSchema = z.strictObject({
  groupMode: SidebarGroupModeSchema.optional(),
  hostFilters: z.array(z.string()).optional(),
  hostFilter: z.string().nullable().optional(),
  groupModeByServerId: z.record(z.string(), SidebarGroupModeSchema).optional(),
  labelFilter: SidebarLabelFilterSchema.optional(),
});

type SidebarViewStorageState = z.infer<typeof SidebarViewPersistedStateSchema>;

function readLegacyGroupMode(persistedState: SidebarViewStorageState): SidebarGroupMode | null {
  const groupModeByServerId = persistedState.groupModeByServerId;
  if (!groupModeByServerId) {
    return null;
  }

  const modes = Object.values(groupModeByServerId);
  if (modes.length === 0) return null;
  return modes.includes("status") ? "status" : "project";
}

// Reads the host filter from any persisted shape: the current `hostFilters` array, or the
// pre-v2 single `hostFilter` string (null/absent meant "all hosts").
function readHostFilters(persistedState: SidebarViewStorageState): string[] {
  const hostFilters = persistedState.hostFilters;
  if (hostFilters) {
    return hostFilters;
  }
  // COMPAT(sidebarHostFilters): added in v0.1.102, remove after 2026-12-30 once pre-v2 persisted
  // sidebar state (a single `hostFilter` string) has aged out.
  const legacyHostFilter = persistedState.hostFilter;
  return legacyHostFilter ? [legacyHostFilter] : [];
}

export function migrateSidebarViewState(persistedState: unknown): SidebarViewPersistedState {
  const result = SidebarViewPersistedStateSchema.safeParse(persistedState);
  if (!result.success) {
    return { groupMode: "project", hostFilters: [], labelFilter: emptyLabelFilter() };
  }
  const state = result.data;

  const legacyGroupMode = readLegacyGroupMode(state);
  if (legacyGroupMode) {
    return { groupMode: legacyGroupMode, hostFilters: [], labelFilter: emptyLabelFilter() };
  }

  return {
    groupMode: state.groupMode ?? "project",
    hostFilters: readHostFilters(state),
    labelFilter: state.labelFilter
      ? {
          ...state.labelFilter,
          include: deduplicateSidebarLabelNames(state.labelFilter.include),
          exclude: deduplicateSidebarLabelNames(state.labelFilter.exclude),
          includeUnlabelled: state.labelFilter.includeUnlabelled ?? false,
          excludeUnlabelled: state.labelFilter.excludeUnlabelled ?? false,
        }
      : emptyLabelFilter(),
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
      hostFilters: [],
      labelFilter: emptyLabelFilter(),
      setGroupMode: (mode) => set({ groupMode: mode }),
      toggleHostFilter: (serverId) =>
        set((state) => ({
          hostFilters: state.hostFilters.includes(serverId)
            ? state.hostFilters.filter((id) => id !== serverId)
            : [...state.hostFilters, serverId],
        })),
      clearHostFilters: () => set({ hostFilters: [] }),
      setLabelFilter: (labelFilter) =>
        set({
          labelFilter: {
            ...labelFilter,
            include: deduplicateSidebarLabelNames(labelFilter.include),
            exclude: deduplicateSidebarLabelNames(labelFilter.exclude),
          },
        }),
      clearLabelFilter: () => set({ labelFilter: emptyLabelFilter() }),
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
    }),
    {
      name: SIDEBAR_VIEW_STORAGE_KEY,
      version: SIDEBAR_VIEW_STORE_VERSION,
      storage: createValidatedPersistStorage(
        createSidebarViewStorage(),
        SidebarViewPersistedStateSchema,
      ),
      partialize: (state) => ({
        groupMode: state.groupMode,
        hostFilters: state.hostFilters,
        labelFilter: state.labelFilter,
      }),
      migrate: migrateSidebarViewState,
    },
  ),
);

function emptyLabelFilter(): SidebarViewPersistedState["labelFilter"] {
  return {
    include: [],
    exclude: [],
    includeUnlabelled: false,
    excludeUnlabelled: false,
    match: "any",
  };
}
