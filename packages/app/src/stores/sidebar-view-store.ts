import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist, type StateStorage } from "zustand/middleware";
import { z } from "zod";
import { workspaceLabelKey } from "@getpaseo/protocol/workspace-labels";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

export type SidebarGroupMode = "project" | "status" | "label";
export type SidebarLabelMatch = "any" | "all";
export type SidebarLabelState = "include" | "exclude";

const SIDEBAR_VIEW_STORAGE_KEY = "sidebar-view";
const LEGACY_SIDEBAR_GROUP_MODE_STORAGE_KEY = "sidebar-group-mode";
const SIDEBAR_VIEW_STORE_VERSION = 3;

/**
 * The key standing for "this workspace carries no labels at all".
 *
 * `normalizeWorkspaceLabelName` trims, so no real label can ever normalize to the empty string
 * and nothing in `labels` can collide with it. That is the whole reason the empty string is the
 * choice: a sentinel like `"__unlabelled__"` would be a name a person is free to type.
 */
export const SIDEBAR_UNLABELLED_LABEL_KEY = "";

/**
 * What the sidebar's Labels page currently says.
 *
 * One entry per label the user has an opinion about, keyed by `workspaceLabelKey`. A label holds
 * one value, so include and exclude cannot both be true for the same label by construction.
 * Absent means the label is neither.
 */
export interface SidebarLabelFilter {
  labels: Record<string, SidebarLabelState>;
  match: SidebarLabelMatch;
}

export function hasActiveSidebarLabelFilter(filter: SidebarLabelFilter): boolean {
  return Object.keys(filter.labels).length > 0;
}

interface SidebarViewStoreState {
  groupMode: SidebarGroupMode;
  // Empty means "all hosts". A non-empty list pins the sidebar to those hosts.
  hostFilters: string[];
  labelFilter: SidebarLabelFilter;
  setGroupMode: (mode: SidebarGroupMode) => void;
  toggleHostFilter: (serverId: string) => void;
  clearHostFilters: () => void;
  /** The label row itself: included, or not. One press each way. */
  toggleLabelInclude: (name: string) => void;
  /** The label row's own exclude control: excluded, or not. One press each way. */
  toggleLabelExclude: (name: string) => void;
  setLabelMatch: (match: SidebarLabelMatch) => void;
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
  labels: z.record(z.string(), z.enum(["include", "exclude"])),
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
      ? normalizeSidebarLabelFilter(state.labelFilter)
      : emptyLabelFilter(),
  };
}

/**
 * Re-keys a persisted filter through `workspaceLabelKey`, so the invariant on `labels` holds for
 * state that was written by an older build of this page rather than by the current one.
 */
function normalizeSidebarLabelFilter(filter: SidebarLabelFilter): SidebarLabelFilter {
  const labels: Record<string, SidebarLabelState> = {};
  for (const [name, state] of Object.entries(filter.labels)) {
    labels[workspaceLabelKey(name)] = state;
  }
  return { labels, match: filter.match };
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
      toggleLabelInclude: (name) =>
        set((state) => ({ labelFilter: toggleLabelState(state.labelFilter, name, "include") })),
      toggleLabelExclude: (name) =>
        set((state) => ({ labelFilter: toggleLabelState(state.labelFilter, name, "exclude") })),
      setLabelMatch: (match) => set((state) => ({ labelFilter: { ...state.labelFilter, match } })),
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

function emptyLabelFilter(): SidebarLabelFilter {
  return { labels: {}, match: "any" };
}

/**
 * Sets one label to `state`, or clears it if it already says that.
 *
 * Include and exclude are two independent controls over one value, so each is a plain toggle and
 * setting either drops the other for that label. Neither transition passes through the other
 * state: clearing an include never briefly excludes, which is what made the old rotation re-filter
 * the sidebar on the way out.
 */
function toggleLabelState(
  filter: SidebarLabelFilter,
  name: string,
  state: SidebarLabelState,
): SidebarLabelFilter {
  const key = workspaceLabelKey(name);
  const labels = { ...filter.labels };
  if (labels[key] === state) delete labels[key];
  else labels[key] = state;
  return { ...filter, labels };
}
