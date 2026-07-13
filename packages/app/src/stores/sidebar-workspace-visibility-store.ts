import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

interface SidebarWorkspaceVisibilityState {
  hiddenWorkspaceKeys: string[];
  hiddenProjectKeys: string[];
  hiddenSectionCollapsed: boolean;
  collapsedCollectionKeys: string[];
  setWorkspaceHidden: (workspaceKey: string, hidden: boolean) => void;
  setProjectHidden: (projectKey: string, hidden: boolean) => void;
  unhideAll: () => void;
  toggleHiddenSectionCollapsed: () => void;
  toggleCollectionCollapsed: (collectionKey: string) => void;
  reconcileWorkspaceKeys: (workspaceKeys: readonly string[]) => void;
  reconcileProjectKeys: (projectKeys: readonly string[]) => void;
}

function normalizeWorkspaceKeys(keys: readonly string[]): string[] {
  return Array.from(new Set(keys.map((key) => key.trim()).filter(Boolean)));
}

interface PersistedSidebarWorkspaceVisibilityState {
  hiddenWorkspaceKeys?: string[];
  hiddenProjectKeys?: string[];
  hiddenSectionCollapsed?: boolean;
  collapsedCollectionKeys?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export function updateHiddenWorkspaceKeys(input: {
  keys: readonly string[];
  workspaceKey: string;
  hidden: boolean;
}): string[] {
  const key = input.workspaceKey.trim();
  if (!key) return [...input.keys];
  const currentlyHidden = input.keys.includes(key);
  if (currentlyHidden === input.hidden) return [...input.keys];
  return input.hidden ? [...input.keys, key] : input.keys.filter((value) => value !== key);
}

export function updateHiddenProjectKeys(input: {
  keys: readonly string[];
  projectKey: string;
  hidden: boolean;
}): string[] {
  return updateHiddenWorkspaceKeys({
    keys: input.keys,
    workspaceKey: input.projectKey,
    hidden: input.hidden,
  });
}

export function reconcileHiddenWorkspaceKeys(
  hiddenWorkspaceKeys: readonly string[],
  availableWorkspaceKeys: readonly string[],
): string[] {
  const available = new Set(availableWorkspaceKeys);
  return hiddenWorkspaceKeys.filter((key) => available.has(key));
}

export function reconcileHiddenProjectKeys(
  hiddenProjectKeys: readonly string[],
  availableProjectKeys: readonly string[],
): string[] {
  return reconcileHiddenWorkspaceKeys(hiddenProjectKeys, availableProjectKeys);
}

export function migrateSidebarWorkspaceVisibilityState(
  persistedState: unknown,
): Pick<
  SidebarWorkspaceVisibilityState,
  "hiddenWorkspaceKeys" | "hiddenProjectKeys" | "hiddenSectionCollapsed" | "collapsedCollectionKeys"
> {
  const state: PersistedSidebarWorkspaceVisibilityState = isRecord(persistedState)
    ? {
        hiddenWorkspaceKeys: readStringArray(persistedState.hiddenWorkspaceKeys),
        hiddenProjectKeys: readStringArray(persistedState.hiddenProjectKeys),
        hiddenSectionCollapsed:
          typeof persistedState.hiddenSectionCollapsed === "boolean"
            ? persistedState.hiddenSectionCollapsed
            : undefined,
        collapsedCollectionKeys: readStringArray(persistedState.collapsedCollectionKeys),
      }
    : {};
  return {
    hiddenWorkspaceKeys: normalizeWorkspaceKeys(state?.hiddenWorkspaceKeys ?? []),
    hiddenProjectKeys: normalizeWorkspaceKeys(state?.hiddenProjectKeys ?? []),
    hiddenSectionCollapsed: state?.hiddenSectionCollapsed !== false,
    collapsedCollectionKeys: normalizeWorkspaceKeys(state?.collapsedCollectionKeys ?? []),
  };
}

export const useSidebarWorkspaceVisibilityStore = create<SidebarWorkspaceVisibilityState>()(
  persist(
    (set) => ({
      hiddenWorkspaceKeys: [],
      hiddenProjectKeys: [],
      hiddenSectionCollapsed: true,
      collapsedCollectionKeys: [],
      setWorkspaceHidden: (workspaceKey, hidden) =>
        set((state) => {
          const hiddenWorkspaceKeys = updateHiddenWorkspaceKeys({
            keys: state.hiddenWorkspaceKeys,
            workspaceKey,
            hidden,
          });
          return hiddenWorkspaceKeys.length === state.hiddenWorkspaceKeys.length &&
            hiddenWorkspaceKeys.every((key, index) => key === state.hiddenWorkspaceKeys[index])
            ? state
            : { hiddenWorkspaceKeys };
        }),
      setProjectHidden: (projectKey, hidden) =>
        set((state) => {
          const hiddenProjectKeys = updateHiddenProjectKeys({
            keys: state.hiddenProjectKeys,
            projectKey,
            hidden,
          });
          return hiddenProjectKeys.length === state.hiddenProjectKeys.length &&
            hiddenProjectKeys.every((key, index) => key === state.hiddenProjectKeys[index])
            ? state
            : { hiddenProjectKeys };
        }),
      unhideAll: () => set({ hiddenWorkspaceKeys: [], hiddenProjectKeys: [] }),
      toggleHiddenSectionCollapsed: () =>
        set((state) => ({ hiddenSectionCollapsed: !state.hiddenSectionCollapsed })),
      toggleCollectionCollapsed: (collectionKey) =>
        set((state) => ({
          collapsedCollectionKeys: state.collapsedCollectionKeys.includes(collectionKey)
            ? state.collapsedCollectionKeys.filter((key) => key !== collectionKey)
            : [...state.collapsedCollectionKeys, collectionKey],
        })),
      reconcileWorkspaceKeys: (workspaceKeys) =>
        set((state) => {
          const next = reconcileHiddenWorkspaceKeys(state.hiddenWorkspaceKeys, workspaceKeys);
          return next.length === state.hiddenWorkspaceKeys.length
            ? state
            : { hiddenWorkspaceKeys: next };
        }),
      reconcileProjectKeys: (projectKeys) =>
        set((state) => {
          const next = reconcileHiddenProjectKeys(state.hiddenProjectKeys, projectKeys);
          return next.length === state.hiddenProjectKeys.length
            ? state
            : { hiddenProjectKeys: next };
        }),
    }),
    {
      name: "sidebar-hidden-workspaces",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        hiddenWorkspaceKeys: state.hiddenWorkspaceKeys,
        hiddenProjectKeys: state.hiddenProjectKeys,
        hiddenSectionCollapsed: state.hiddenSectionCollapsed,
        collapsedCollectionKeys: state.collapsedCollectionKeys,
      }),
      version: 2,
      migrate: migrateSidebarWorkspaceVisibilityState,
    },
  ),
);
