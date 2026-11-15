import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useState } from "react";
import invariant from "tiny-invariant";
import { z } from "zod";
import { create } from "zustand";
import { persist, type StateStorage } from "zustand/middleware";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import type { WorkspaceLayoutMode } from "@/stores/workspace-layout-store";

export const EXPLORER_SPLIT_STORAGE_KEY = "explorer-split";
const EXPLORER_SPLIT_STORE_VERSION = 1;
const DEFAULT_RATIO = 0.5;
const MIN_RATIO = 0.1;
const MAX_RATIO = 0.9;
/** Content each half keeps at least, in points, not counting the bottom half's header. */
const MIN_HALF_HEIGHT = 80;

export type ExplorerSplitHalf = "top" | "bottom";

export interface ExplorerSplitEntry {
  lowerTabId: string;
  ratio: number;
}

type ExplorerTab = Pick<WorkspaceTabDescriptor, "tabId" | "target">;

interface ExplorerSplitState {
  /** Persisted, keyed by `buildWorkspaceTabPersistenceKey`. */
  entries: Record<string, ExplorerSplitEntry>;
  /** In memory only; a missing entry means the top half. */
  activeHalfByWorkspace: Record<string, ExplorerSplitHalf>;
  showBelow: (workspaceKey: string, tab: ExplorerTab) => void;
  unsplit: (workspaceKey: string) => void;
  setRatio: (workspaceKey: string, ratio: number) => void;
  setActiveHalf: (workspaceKey: string, half: ExplorerSplitHalf) => void;
  swap: (workspaceKey: string, newLowerTabId: string) => void;
}

const ExplorerSplitPersistedStateSchema = z.strictObject({
  entries: z.record(
    z.string(),
    z.strictObject({
      lowerTabId: z.string().min(1),
      // Any finite number parses; `clampExplorerSplitRatio` brings it in range on load.
      ratio: z.number().finite(),
    }),
  ),
});

type ExplorerSplitPersistedState = z.infer<typeof ExplorerSplitPersistedStateSchema>;

/** `0` and non-finite values mean "no saved position", so they fall back to an even split. */
export function clampExplorerSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio === 0) return DEFAULT_RATIO;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
}

/** True when the dock is tall enough for two minimum halves and the bottom header. */
export function explorerSplitFitsHeight(
  containerHeight: number,
  lowerHeaderHeight: number,
): boolean {
  return containerHeight >= MIN_HALF_HEIGHT * 2 + lowerHeaderHeight;
}

/** Narrows a ratio so each half keeps `MIN_HALF_HEIGHT` points at this dock height. */
export function clampExplorerSplitRatioToHeight(
  ratio: number,
  containerHeight: number,
  lowerHeaderHeight: number,
): number {
  const min = MIN_HALF_HEIGHT / containerHeight;
  const max = (containerHeight - lowerHeaderHeight - MIN_HALF_HEIGHT) / containerHeight;
  return Math.min(max, Math.max(min, clampExplorerSplitRatio(ratio)));
}

/** A launcher changes its id when used, so it can never be the bottom tab. */
export function isExplorerTabEligible(tab: ExplorerTab): boolean {
  return tab.target.kind !== "new_tab";
}

/** The tab the split button shows below: the next eligible tab after the active one. */
export function nextEligibleExplorerTabId(
  tabs: readonly ExplorerTab[],
  activeTabId: string | null,
): string | null {
  const activeIndex = tabs.findIndex((tab) => tab.tabId === activeTabId);
  for (let offset = 1; offset <= tabs.length; offset += 1) {
    const candidate = tabs[(activeIndex + offset + tabs.length) % tabs.length];
    if (candidate && candidate.tabId !== activeTabId && isExplorerTabEligible(candidate)) {
      return candidate.tabId;
    }
  }
  return null;
}

export function canShowExplorerTabBelow(
  tab: ExplorerTab,
  activeTabId: string | null,
  lowerTabId: string | null,
): boolean {
  return isExplorerTabEligible(tab) && tab.tabId !== activeTabId && tab.tabId !== lowerTabId;
}

export type ExplorerSplitView =
  | { kind: "split"; topTabId: string; lowerTabId: string }
  | { kind: "single"; reason: "mode" | "none" | "missing" | "ended" };

/**
 * The one place that decides what each Explorer half shows. A `split` always names two different
 * tabs that are both in the Explorer, so the host never gets the same or a missing tab twice.
 * `missing` and `ended` mean the saved split should be cleared; `mode` and `none` keep it.
 */
export function deriveExplorerSplitView(input: {
  explorerTabs: readonly ExplorerTab[];
  activeTabId: string | null;
  lowerTabId: string | null;
  lastTopTabId: string | null;
  layoutMode: WorkspaceLayoutMode;
}): ExplorerSplitView {
  const { explorerTabs, activeTabId, lowerTabId, lastTopTabId, layoutMode } = input;
  if (layoutMode !== "split-panes") return { kind: "single", reason: "mode" };
  if (!lowerTabId) return { kind: "single", reason: "none" };
  const lowerTab = explorerTabs.find((tab) => tab.tabId === lowerTabId);
  if (!lowerTab || !isExplorerTabEligible(lowerTab)) return { kind: "single", reason: "missing" };
  if (activeTabId && activeTabId !== lowerTabId) {
    return { kind: "split", topTabId: activeTabId, lowerTabId };
  }
  const lastTopTab = explorerTabs.find((tab) => tab.tabId === lastTopTabId);
  if (
    activeTabId &&
    lastTopTab &&
    lastTopTab.tabId !== activeTabId &&
    isExplorerTabEligible(lastTopTab)
  ) {
    return { kind: "split", topTabId: activeTabId, lowerTabId: lastTopTab.tabId };
  }
  return { kind: "single", reason: "ended" };
}

function withoutKey<Value>(record: Record<string, Value>, key: string): Record<string, Value> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

export function selectExplorerActiveHalf(
  state: Pick<ExplorerSplitState, "activeHalfByWorkspace">,
  workspaceKey: string,
): ExplorerSplitHalf {
  return state.activeHalfByWorkspace[workspaceKey] ?? "top";
}

export function createExplorerSplitStore(backingStorage: StateStorage) {
  return create<ExplorerSplitState>()(
    persist(
      (set, get) => ({
        entries: {},
        activeHalfByWorkspace: {},
        showBelow: (workspaceKey, tab) => {
          if (!workspaceKey) return;
          invariant(
            isExplorerTabEligible(tab),
            `A launcher tab can't be shown below in the Explorer: ${tab.tabId}`,
          );
          set((state) => ({
            entries: {
              ...state.entries,
              [workspaceKey]: {
                lowerTabId: tab.tabId,
                ratio: state.entries[workspaceKey]?.ratio ?? DEFAULT_RATIO,
              },
            },
            activeHalfByWorkspace: withoutKey(state.activeHalfByWorkspace, workspaceKey),
          }));
        },
        unsplit: (workspaceKey) =>
          set((state) => ({
            entries: withoutKey(state.entries, workspaceKey),
            activeHalfByWorkspace: withoutKey(state.activeHalfByWorkspace, workspaceKey),
          })),
        setRatio: (workspaceKey, ratio) =>
          set((state) => {
            const entry = state.entries[workspaceKey];
            if (!entry) return state;
            return {
              entries: {
                ...state.entries,
                [workspaceKey]: { ...entry, ratio: clampExplorerSplitRatio(ratio) },
              },
            };
          }),
        setActiveHalf: (workspaceKey, half) => {
          // Every set writes storage through persist, and this runs on each row click.
          if (selectExplorerActiveHalf(get(), workspaceKey) === half) return;
          set((state) => ({
            activeHalfByWorkspace: { ...state.activeHalfByWorkspace, [workspaceKey]: half },
          }));
        },
        swap: (workspaceKey, newLowerTabId) =>
          set((state) => {
            const entry = state.entries[workspaceKey];
            if (!entry) return state;
            return {
              entries: {
                ...state.entries,
                [workspaceKey]: { ...entry, lowerTabId: newLowerTabId },
              },
              activeHalfByWorkspace: withoutKey(state.activeHalfByWorkspace, workspaceKey),
            };
          }),
      }),
      {
        name: EXPLORER_SPLIT_STORAGE_KEY,
        version: EXPLORER_SPLIT_STORE_VERSION,
        storage: createValidatedPersistStorage<ExplorerSplitPersistedState>(
          backingStorage,
          ExplorerSplitPersistedStateSchema,
        ),
        partialize: (state) => ({ entries: state.entries }),
        merge: (persisted, current) => {
          const stored = (persisted as ExplorerSplitPersistedState | undefined)?.entries ?? {};
          const entries: Record<string, ExplorerSplitEntry> = {};
          for (const [workspaceKey, entry] of Object.entries(stored)) {
            entries[workspaceKey] = {
              lowerTabId: entry.lowerTabId,
              ratio: clampExplorerSplitRatio(entry.ratio),
            };
          }
          return { ...current, entries };
        },
      },
    ),
  );
}

export const useExplorerSplitStore = createExplorerSplitStore(AsyncStorage);

type ExplorerSplitStore = ReturnType<typeof createExplorerSplitStore>;

/** The split button, shortcut and command: unsplit when split, else show the next tab below. */
export function toggleExplorerSplit(
  input: { workspaceKey: string; explorerTabs: readonly ExplorerTab[]; activeTabId: string | null },
  store: ExplorerSplitStore = useExplorerSplitStore,
): void {
  const state = store.getState();
  if (state.entries[input.workspaceKey]) {
    state.unsplit(input.workspaceKey);
    return;
  }
  const nextTabId = nextEligibleExplorerTabId(input.explorerTabs, input.activeTabId);
  const nextTab = input.explorerTabs.find((tab) => tab.tabId === nextTabId);
  if (nextTab) state.showBelow(input.workspaceKey, nextTab);
}

export function useExplorerSplitStoreHydrated(): boolean {
  const [hasHydrated, setHasHydrated] = useState(() => useExplorerSplitStore.persist.hasHydrated());
  useEffect(() => {
    if (useExplorerSplitStore.persist.hasHydrated()) {
      setHasHydrated(true);
      return undefined;
    }
    return useExplorerSplitStore.persist.onFinishHydration(() => setHasHydrated(true));
  }, []);
  return hasHydrated;
}
