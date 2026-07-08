import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useState } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  buildWorkspaceTabPersistenceKey,
  type WorkspaceTab,
  type WorkspaceTabTarget,
} from "@/stores/workspace-tabs-store";
import {
  defaultWorkspaceLayoutIds,
  type WorkspaceLayoutIdSource,
} from "@/stores/workspace-layout-ids";
import {
  clampNormalizedSizes,
  closeTabInLayout,
  collectAllPanes,
  collectAllTabs,
  convertDraftToAgentInLayout,
  createDefaultLayout,
  findPaneById,
  findPaneContainingTab,
  focusPaneInLayout,
  focusTabInLayout,
  getFocusedBrowserId,
  getTreeDepth,
  insertSplit,
  moveTabToPaneInLayout,
  normalizeLayout,
  normalizeWorkspaceTab,
  openTabInLayoutBackground,
  openTabInLayoutFocused,
  reconcileWorkspaceTabs,
  removePaneFromTree,
  removeTabFromTree,
  reorderFocusedPaneTabsInLayout,
  reorderPaneTabsInLayout,
  restoreTabInLayout,
  retargetTabInLayout,
  splitPaneEmptyInLayout,
  splitPaneInLayout,
  type SplitGroup,
  type SplitNode,
  type SplitPane,
  type WorkspaceTabReconcileState,
  type WorkspaceTabSnapshot,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-actions";
import { normalizeWorkspaceTabTarget } from "@/workspace-tabs/identity";

export { buildWorkspaceTabPersistenceKey };
export {
  collectAllPanes,
  collectAllTabs,
  createDefaultLayout,
  findPaneById,
  findPaneContainingTab,
  getFocusedBrowserId,
  getTreeDepth,
  insertSplit,
  normalizeLayout,
  removePaneFromTree,
  removeTabFromTree,
};
export type {
  SplitGroup,
  SplitNode,
  SplitPane,
  WorkspaceLayout,
  WorkspaceTabReconcileState,
  WorkspaceTabSnapshot,
};

interface WorkspaceLayoutStore {
  layoutByWorkspace: Record<string, WorkspaceLayout>;
  splitSizesByWorkspace: Record<string, Record<string, number[]>>;
  recentlyClosedTabsByWorkspace: Record<string, RecentlyClosedWorkspaceTab[]>;
  pinnedAgentIdsByWorkspace: Record<string, Set<string>>;
  hiddenAgentIdsByWorkspace: Record<string, Set<string>>;
  focusRestorationByWorkspace: Record<string, WorkspaceFocusRestorationState>;
  openTabFocused: (workspaceKey: string, target: WorkspaceTabTarget) => string | null;
  openChildTabFocused: (
    workspaceKey: string,
    target: WorkspaceTabTarget,
    parentTabId: string,
  ) => string | null;
  openTabInBackground: (workspaceKey: string, target: WorkspaceTabTarget) => string | null;
  closeTab: (workspaceKey: string, tabId: string) => void;
  restoreClosedTab: (workspaceKey: string, entryKey: string) => string | null;
  restoreLastClosedTab: (workspaceKey: string) => string | null;
  focusTab: (workspaceKey: string, tabId: string) => void;
  retargetTab: (workspaceKey: string, tabId: string, target: WorkspaceTabTarget) => string | null;
  convertDraftToAgent: (workspaceKey: string, tabId: string, agentId: string) => string | null;
  reconcileTabs: (workspaceKey: string, snapshot: WorkspaceTabSnapshot) => void;
  reorderTabs: (workspaceKey: string, tabIds: string[]) => void;
  getWorkspaceTabs: (workspaceKey: string) => WorkspaceTab[];
  splitPane: (
    workspaceKey: string,
    input: {
      tabId: string;
      targetPaneId: string;
      position: "left" | "right" | "top" | "bottom";
    },
  ) => string | null;
  splitPaneEmpty: (
    workspaceKey: string,
    input: {
      targetPaneId: string;
      position: "left" | "right" | "top" | "bottom";
    },
  ) => string | null;
  moveTabToPane: (workspaceKey: string, tabId: string, toPaneId: string) => void;
  focusPane: (workspaceKey: string, paneId: string) => void;
  unfocusPane: (workspaceKey: string) => string | null;
  restorePaneFocus: (workspaceKey: string, token: string) => void;
  resizeSplit: (workspaceKey: string, groupId: string, sizes: number[]) => void;
  reorderTabsInPane: (workspaceKey: string, paneId: string, tabIds: string[]) => void;
  pinAgent: (workspaceKey: string, agentId: string) => void;
  unpinAgent: (workspaceKey: string, agentId: string) => void;
  hideAgent: (workspaceKey: string, agentId: string) => void;
  unhideAgent: (workspaceKey: string, agentId: string) => void;
  purgeWorkspace: (workspaceKey: string) => void;
}

interface WorkspaceFocusRestorationState {
  restorePaneId: string | null;
  tokens: string[];
}

export interface RecentlyClosedWorkspaceTab {
  key: string;
  tab: WorkspaceTab;
  paneId: string | null;
  parentTabId: string | null;
  closedAt: number;
}

const MAX_TREE_DEPTH = 4;
const MAX_RECENTLY_CLOSED_TABS = 10;

function trimNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function addAgentIdToWorkspaceSet(
  state: Record<string, Set<string>>,
  workspaceKey: string,
  agentId: string,
): Record<string, Set<string>> {
  const currentAgentIds = state[workspaceKey] ?? null;
  if (currentAgentIds?.has(agentId)) {
    return state;
  }

  const nextAgentIds = new Set(currentAgentIds ?? []);
  nextAgentIds.add(agentId);
  return {
    ...state,
    [workspaceKey]: nextAgentIds,
  };
}

function removeAgentIdFromWorkspaceSet(
  state: Record<string, Set<string>>,
  workspaceKey: string,
  agentId: string,
): Record<string, Set<string>> {
  const currentAgentIds = state[workspaceKey] ?? null;
  if (!currentAgentIds?.has(agentId)) {
    return state;
  }

  if (currentAgentIds.size === 1) {
    const nextState = { ...state };
    delete nextState[workspaceKey];
    return nextState;
  }

  const nextAgentIds = new Set(currentAgentIds);
  nextAgentIds.delete(agentId);
  return {
    ...state,
    [workspaceKey]: nextAgentIds,
  };
}

function getWorkspaceLayout(
  state: Record<string, WorkspaceLayout>,
  workspaceKey: string,
): WorkspaceLayout {
  return normalizeLayout(state[workspaceKey] ?? createDefaultLayout());
}

function withoutFocusRestoration(
  state: WorkspaceLayoutStore,
  workspaceKey: string,
): Pick<WorkspaceLayoutStore, "focusRestorationByWorkspace"> | null {
  if (!(workspaceKey in state.focusRestorationByWorkspace)) {
    return null;
  }
  const { [workspaceKey]: _removed, ...focusRestorationByWorkspace } =
    state.focusRestorationByWorkspace;
  return { focusRestorationByWorkspace };
}

function isRestorableClosedTab(tab: WorkspaceTab): boolean {
  switch (tab.target.kind) {
    case "draft":
    case "agent":
    case "file":
    case "setup":
      return true;
    case "terminal":
    case "browser":
      return false;
  }
}

function normalizeRecentlyClosedTab(value: unknown): RecentlyClosedWorkspaceTab | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Partial<RecentlyClosedWorkspaceTab>;
  const tab = normalizeWorkspaceTab(record.tab);
  if (!tab || !isRestorableClosedTab(tab)) {
    return null;
  }
  const closedAt = typeof record.closedAt === "number" ? record.closedAt : Date.now();
  const key = trimNonEmpty(record.key) ?? `${closedAt}:${tab.tabId}`;
  return {
    key,
    tab,
    paneId: trimNonEmpty(record.paneId) ?? null,
    parentTabId: trimNonEmpty(record.parentTabId) ?? null,
    closedAt,
  };
}

function normalizeRecentlyClosedTabs(value: unknown): RecentlyClosedWorkspaceTab[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const next: RecentlyClosedWorkspaceTab[] = [];
  const seen = new Set<string>();
  for (const entryValue of value) {
    const entry = normalizeRecentlyClosedTab(entryValue);
    if (!entry || seen.has(entry.key)) {
      continue;
    }
    seen.add(entry.key);
    next.push(entry);
  }
  return next
    .sort((left, right) => right.closedAt - left.closedAt)
    .slice(0, MAX_RECENTLY_CLOSED_TABS);
}

function enqueueRecentlyClosedTab(input: {
  current: RecentlyClosedWorkspaceTab[];
  tab: WorkspaceTab;
  paneId: string | null;
  parentTabId: string | null;
  closedAt: number;
}): RecentlyClosedWorkspaceTab[] {
  if (!isRestorableClosedTab(input.tab)) {
    return input.current;
  }
  const key = `${input.closedAt}:${input.tab.tabId}`;
  const entry: RecentlyClosedWorkspaceTab = {
    key,
    tab: input.tab,
    paneId: input.paneId,
    parentTabId: input.parentTabId,
    closedAt: input.closedAt,
  };
  return [entry, ...input.current.filter((current) => current.tab.tabId !== input.tab.tabId)].slice(
    0,
    MAX_RECENTLY_CLOSED_TABS,
  );
}

function removeRecentlyClosedEntry(
  entries: RecentlyClosedWorkspaceTab[],
  entryKey: string,
): RecentlyClosedWorkspaceTab[] {
  return entries.filter((entry) => entry.key !== entryKey);
}

function resolveRestoredHiddenAgentIds(input: {
  hiddenAgentIdsByWorkspace: Record<string, Set<string>>;
  workspaceKey: string;
  tab: WorkspaceTab;
}): Record<string, Set<string>> {
  if (input.tab.target.kind !== "agent") {
    return input.hiddenAgentIdsByWorkspace;
  }
  return removeAgentIdFromWorkspaceSet(
    input.hiddenAgentIdsByWorkspace,
    input.workspaceKey,
    input.tab.target.agentId,
  );
}

function attachParentTab(input: {
  layout: WorkspaceLayout;
  childTabId: string | null;
  parentTabId: string | null;
}): WorkspaceLayout {
  const childTabId = trimNonEmpty(input.childTabId);
  const parentTabId = trimNonEmpty(input.parentTabId);
  if (!childTabId || !parentTabId || childTabId === parentTabId) {
    return normalizeLayout(input.layout);
  }

  const openTabIds = new Set(collectAllTabs(input.layout.root).map((tab) => tab.tabId));
  if (!openTabIds.has(childTabId) || !openTabIds.has(parentTabId)) {
    return normalizeLayout(input.layout);
  }

  return normalizeLayout({
    ...input.layout,
    parentTabIdByTabId: {
      ...input.layout.parentTabIdByTabId,
      [childTabId]: parentTabId,
    },
  });
}

export function createWorkspaceLayoutStore(
  ids: WorkspaceLayoutIdSource = defaultWorkspaceLayoutIds,
) {
  return create<WorkspaceLayoutStore>()(
    persist(
      (set, get) => ({
        layoutByWorkspace: {},
        splitSizesByWorkspace: {},
        recentlyClosedTabsByWorkspace: {},
        pinnedAgentIdsByWorkspace: {},
        hiddenAgentIdsByWorkspace: {},
        focusRestorationByWorkspace: {},
        openTabFocused: (workspaceKey, target) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedTarget = normalizeWorkspaceTabTarget(target);
          if (!normalizedWorkspaceKey || !normalizedTarget) {
            return null;
          }

          const result = openTabInLayoutFocused({
            layout: getWorkspaceLayout(get().layoutByWorkspace, normalizedWorkspaceKey),
            target: normalizedTarget,
            now: Date.now(),
          });

          set((state) => ({
            ...withoutFocusRestoration(state, normalizedWorkspaceKey),
            hiddenAgentIdsByWorkspace:
              normalizedTarget.kind !== "agent"
                ? state.hiddenAgentIdsByWorkspace
                : removeAgentIdFromWorkspaceSet(
                    state.hiddenAgentIdsByWorkspace,
                    normalizedWorkspaceKey,
                    normalizedTarget.agentId,
                  ),
            layoutByWorkspace: {
              ...state.layoutByWorkspace,
              [normalizedWorkspaceKey]: result.layout,
            },
          }));

          return result.tabId;
        },
        openChildTabFocused: (workspaceKey, target, parentTabId) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedParentTabId = trimNonEmpty(parentTabId);
          const normalizedTarget = normalizeWorkspaceTabTarget(target);
          if (!normalizedWorkspaceKey || !normalizedParentTabId || !normalizedTarget) {
            return null;
          }

          const result = openTabInLayoutFocused({
            layout: getWorkspaceLayout(get().layoutByWorkspace, normalizedWorkspaceKey),
            target: normalizedTarget,
            now: Date.now(),
          });

          set((state) => {
            const layout = attachParentTab({
              layout: result.layout,
              childTabId: result.tabId,
              parentTabId: normalizedParentTabId,
            });
            return {
              ...withoutFocusRestoration(state, normalizedWorkspaceKey),
              hiddenAgentIdsByWorkspace:
                normalizedTarget.kind !== "agent"
                  ? state.hiddenAgentIdsByWorkspace
                  : removeAgentIdFromWorkspaceSet(
                      state.hiddenAgentIdsByWorkspace,
                      normalizedWorkspaceKey,
                      normalizedTarget.agentId,
                    ),
              layoutByWorkspace: {
                ...state.layoutByWorkspace,
                [normalizedWorkspaceKey]: layout,
              },
            };
          });

          return result.tabId;
        },
        openTabInBackground: (workspaceKey, target) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedTarget = normalizeWorkspaceTabTarget(target);
          if (!normalizedWorkspaceKey || !normalizedTarget) {
            return null;
          }

          const result = openTabInLayoutBackground({
            layout: getWorkspaceLayout(get().layoutByWorkspace, normalizedWorkspaceKey),
            target: normalizedTarget,
            now: Date.now(),
          });

          set((state) => ({
            hiddenAgentIdsByWorkspace:
              normalizedTarget.kind !== "agent"
                ? state.hiddenAgentIdsByWorkspace
                : removeAgentIdFromWorkspaceSet(
                    state.hiddenAgentIdsByWorkspace,
                    normalizedWorkspaceKey,
                    normalizedTarget.agentId,
                  ),
            layoutByWorkspace: {
              ...state.layoutByWorkspace,
              [normalizedWorkspaceKey]: result.layout,
            },
          }));

          return result.tabId;
        },
        closeTab: (workspaceKey, tabId) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedTabId = trimNonEmpty(tabId);
          if (!normalizedWorkspaceKey || !normalizedTabId) {
            return;
          }

          set((state) => {
            const layout = getWorkspaceLayout(state.layoutByWorkspace, normalizedWorkspaceKey);
            const sourcePane = findPaneContainingTab(layout.root, normalizedTabId);
            const closedTab =
              collectAllTabs(layout.root).find((tab) => tab.tabId === normalizedTabId) ?? null;
            const nextLayout = closeTabInLayout({
              layout,
              tabId: normalizedTabId,
            });
            if (!nextLayout) {
              return state;
            }

            const parentTabId = trimNonEmpty(layout.parentTabIdByTabId?.[normalizedTabId]);
            const currentRecentlyClosed =
              state.recentlyClosedTabsByWorkspace[normalizedWorkspaceKey] ?? [];
            const nextRecentlyClosed =
              closedTab && sourcePane
                ? enqueueRecentlyClosedTab({
                    current: currentRecentlyClosed,
                    tab: closedTab,
                    paneId: sourcePane.id,
                    parentTabId,
                    closedAt: Date.now(),
                  })
                : currentRecentlyClosed;
            const recentlyClosedTabsByWorkspace =
              nextRecentlyClosed === currentRecentlyClosed
                ? state.recentlyClosedTabsByWorkspace
                : {
                    ...state.recentlyClosedTabsByWorkspace,
                    [normalizedWorkspaceKey]: nextRecentlyClosed,
                  };

            return {
              ...withoutFocusRestoration(state, normalizedWorkspaceKey),
              recentlyClosedTabsByWorkspace,
              layoutByWorkspace: {
                ...state.layoutByWorkspace,
                [normalizedWorkspaceKey]: nextLayout,
              },
            };
          });
        },
        restoreClosedTab: (workspaceKey, entryKey) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedEntryKey = trimNonEmpty(entryKey);
          if (!normalizedWorkspaceKey || !normalizedEntryKey) {
            return null;
          }

          let restoredTabId: string | null = null;
          set((state) => {
            const entries = normalizeRecentlyClosedTabs(
              state.recentlyClosedTabsByWorkspace[normalizedWorkspaceKey],
            );
            const entry = entries.find((candidate) => candidate.key === normalizedEntryKey) ?? null;
            if (!entry) {
              return state;
            }

            const layout = getWorkspaceLayout(state.layoutByWorkspace, normalizedWorkspaceKey);
            const result = restoreTabInLayout({
              layout,
              tab: entry.tab,
              paneId: entry.paneId,
              parentTabId: entry.parentTabId,
            });
            if (!result) {
              return state;
            }

            restoredTabId = result.tabId;
            const nextEntries = removeRecentlyClosedEntry(entries, normalizedEntryKey);
            const recentlyClosedTabsByWorkspace =
              nextEntries.length === 0
                ? (() => {
                    const { [normalizedWorkspaceKey]: _removed, ...rest } =
                      state.recentlyClosedTabsByWorkspace;
                    return rest;
                  })()
                : {
                    ...state.recentlyClosedTabsByWorkspace,
                    [normalizedWorkspaceKey]: nextEntries,
                  };

            return {
              ...withoutFocusRestoration(state, normalizedWorkspaceKey),
              hiddenAgentIdsByWorkspace: resolveRestoredHiddenAgentIds({
                hiddenAgentIdsByWorkspace: state.hiddenAgentIdsByWorkspace,
                workspaceKey: normalizedWorkspaceKey,
                tab: entry.tab,
              }),
              recentlyClosedTabsByWorkspace,
              layoutByWorkspace: {
                ...state.layoutByWorkspace,
                [normalizedWorkspaceKey]: result.layout,
              },
            };
          });
          return restoredTabId;
        },
        restoreLastClosedTab: (workspaceKey) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          if (!normalizedWorkspaceKey) {
            return null;
          }
          const entries = normalizeRecentlyClosedTabs(
            get().recentlyClosedTabsByWorkspace[normalizedWorkspaceKey],
          );
          const entry = entries[0] ?? null;
          if (!entry) {
            return null;
          }
          return get().restoreClosedTab(normalizedWorkspaceKey, entry.key);
        },
        focusTab: (workspaceKey, tabId) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedTabId = trimNonEmpty(tabId);
          if (!normalizedWorkspaceKey || !normalizedTabId) {
            return;
          }

          set((state) => {
            const nextLayout = focusTabInLayout({
              layout: getWorkspaceLayout(state.layoutByWorkspace, normalizedWorkspaceKey),
              tabId: normalizedTabId,
            });
            if (!nextLayout) {
              return state;
            }

            return {
              ...withoutFocusRestoration(state, normalizedWorkspaceKey),
              layoutByWorkspace: {
                ...state.layoutByWorkspace,
                [normalizedWorkspaceKey]: nextLayout,
              },
            };
          });
        },
        retargetTab: (workspaceKey, tabId, target) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedTabId = trimNonEmpty(tabId);
          const normalizedTarget = normalizeWorkspaceTabTarget(target);
          if (!normalizedWorkspaceKey || !normalizedTabId || !normalizedTarget) {
            return null;
          }

          const result = retargetTabInLayout({
            layout: getWorkspaceLayout(get().layoutByWorkspace, normalizedWorkspaceKey),
            tabId: normalizedTabId,
            target: normalizedTarget,
          });
          if (!result) {
            return null;
          }

          set((state) => ({
            ...(result.layout.focusedPaneId !== null
              ? (withoutFocusRestoration(state, normalizedWorkspaceKey) ?? {})
              : {}),
            hiddenAgentIdsByWorkspace:
              normalizedTarget.kind !== "agent"
                ? state.hiddenAgentIdsByWorkspace
                : removeAgentIdFromWorkspaceSet(
                    state.hiddenAgentIdsByWorkspace,
                    normalizedWorkspaceKey,
                    normalizedTarget.agentId,
                  ),
            layoutByWorkspace: {
              ...state.layoutByWorkspace,
              [normalizedWorkspaceKey]: result.layout,
            },
          }));

          return result.tabId;
        },
        convertDraftToAgent: (workspaceKey, tabId, agentId) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedTabId = trimNonEmpty(tabId);
          const normalizedAgentId = trimNonEmpty(agentId);
          if (!normalizedWorkspaceKey || !normalizedTabId || !normalizedAgentId) {
            return null;
          }

          const result = convertDraftToAgentInLayout({
            layout: getWorkspaceLayout(get().layoutByWorkspace, normalizedWorkspaceKey),
            tabId: normalizedTabId,
            agentId: normalizedAgentId,
          });
          if (!result) {
            return null;
          }

          set((state) => ({
            ...(result.layout.focusedPaneId !== null
              ? (withoutFocusRestoration(state, normalizedWorkspaceKey) ?? {})
              : {}),
            hiddenAgentIdsByWorkspace: removeAgentIdFromWorkspaceSet(
              state.hiddenAgentIdsByWorkspace,
              normalizedWorkspaceKey,
              normalizedAgentId,
            ),
            layoutByWorkspace: {
              ...state.layoutByWorkspace,
              [normalizedWorkspaceKey]: result.layout,
            },
          }));

          return result.tabId;
        },
        reconcileTabs: (workspaceKey, snapshot) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          if (!normalizedWorkspaceKey) {
            return;
          }

          set((state) => {
            const currentLayout = getWorkspaceLayout(
              state.layoutByWorkspace,
              normalizedWorkspaceKey,
            );
            const nextState = reconcileWorkspaceTabs(
              {
                layout: currentLayout,
                pinnedAgentIds: state.pinnedAgentIdsByWorkspace[normalizedWorkspaceKey] ?? null,
                hiddenAgentIds: state.hiddenAgentIdsByWorkspace[normalizedWorkspaceKey] ?? null,
              },
              snapshot,
            );
            if (nextState.layout === currentLayout) {
              return state;
            }

            return {
              layoutByWorkspace: {
                ...state.layoutByWorkspace,
                [normalizedWorkspaceKey]: nextState.layout,
              },
            };
          });
        },
        reorderTabs: (workspaceKey, tabIds) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          if (!normalizedWorkspaceKey) {
            return;
          }

          set((state) => {
            const nextLayout = reorderFocusedPaneTabsInLayout({
              layout: getWorkspaceLayout(state.layoutByWorkspace, normalizedWorkspaceKey),
              tabIds,
            });
            if (!nextLayout) {
              return state;
            }

            return {
              layoutByWorkspace: {
                ...state.layoutByWorkspace,
                [normalizedWorkspaceKey]: nextLayout,
              },
            };
          });
        },
        getWorkspaceTabs: (workspaceKey) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          if (!normalizedWorkspaceKey) {
            return [];
          }
          return collectAllTabs(
            getWorkspaceLayout(get().layoutByWorkspace, normalizedWorkspaceKey).root,
          );
        },
        splitPane: (workspaceKey, input) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedTabId = trimNonEmpty(input.tabId);
          const normalizedTargetPaneId = trimNonEmpty(input.targetPaneId);
          if (!normalizedWorkspaceKey || !normalizedTabId || !normalizedTargetPaneId) {
            return null;
          }

          const result = splitPaneInLayout({
            layout: getWorkspaceLayout(get().layoutByWorkspace, normalizedWorkspaceKey),
            tabId: normalizedTabId,
            targetPaneId: normalizedTargetPaneId,
            position: input.position,
            maxTreeDepth: MAX_TREE_DEPTH,
            createNodeId: ids.createNodeId,
          });
          if (!result) {
            return null;
          }

          set((state) => ({
            ...withoutFocusRestoration(state, normalizedWorkspaceKey),
            layoutByWorkspace: {
              ...state.layoutByWorkspace,
              [normalizedWorkspaceKey]: result.layout,
            },
          }));

          return result.paneId;
        },
        splitPaneEmpty: (workspaceKey, input) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedTargetPaneId = trimNonEmpty(input.targetPaneId);
          if (!normalizedWorkspaceKey || !normalizedTargetPaneId) {
            return null;
          }

          const result = splitPaneEmptyInLayout({
            layout: getWorkspaceLayout(get().layoutByWorkspace, normalizedWorkspaceKey),
            targetPaneId: normalizedTargetPaneId,
            position: input.position,
            maxTreeDepth: MAX_TREE_DEPTH,
            createNodeId: ids.createNodeId,
          });
          if (!result) {
            return null;
          }

          set((state) => ({
            ...withoutFocusRestoration(state, normalizedWorkspaceKey),
            layoutByWorkspace: {
              ...state.layoutByWorkspace,
              [normalizedWorkspaceKey]: result.layout,
            },
          }));

          return result.paneId;
        },
        moveTabToPane: (workspaceKey, tabId, toPaneId) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedTabId = trimNonEmpty(tabId);
          const normalizedToPaneId = trimNonEmpty(toPaneId);
          if (!normalizedWorkspaceKey || !normalizedTabId || !normalizedToPaneId) {
            return;
          }

          set((state) => {
            const nextLayout = moveTabToPaneInLayout({
              layout: getWorkspaceLayout(state.layoutByWorkspace, normalizedWorkspaceKey),
              tabId: normalizedTabId,
              toPaneId: normalizedToPaneId,
            });
            if (!nextLayout) {
              return state;
            }

            return {
              ...withoutFocusRestoration(state, normalizedWorkspaceKey),
              layoutByWorkspace: {
                ...state.layoutByWorkspace,
                [normalizedWorkspaceKey]: nextLayout,
              },
            };
          });
        },
        focusPane: (workspaceKey, paneId) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedPaneId = trimNonEmpty(paneId);
          if (!normalizedWorkspaceKey || !normalizedPaneId) {
            return;
          }

          set((state) => {
            const nextLayout = focusPaneInLayout({
              layout: getWorkspaceLayout(state.layoutByWorkspace, normalizedWorkspaceKey),
              paneId: normalizedPaneId,
            });
            if (!nextLayout) {
              return state;
            }

            return {
              ...withoutFocusRestoration(state, normalizedWorkspaceKey),
              layoutByWorkspace: {
                ...state.layoutByWorkspace,
                [normalizedWorkspaceKey]: nextLayout,
              },
            };
          });
        },
        unfocusPane: (workspaceKey) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          if (!normalizedWorkspaceKey) {
            return null;
          }

          const token = ids.createFocusRestorationToken();
          set((state) => {
            const layout = getWorkspaceLayout(state.layoutByWorkspace, normalizedWorkspaceKey);
            const currentRestoration = state.focusRestorationByWorkspace[normalizedWorkspaceKey];
            const restorePaneId = currentRestoration?.restorePaneId ?? layout.focusedPaneId;

            return {
              focusRestorationByWorkspace: {
                ...state.focusRestorationByWorkspace,
                [normalizedWorkspaceKey]: {
                  restorePaneId,
                  tokens: [...(currentRestoration?.tokens ?? []), token],
                },
              },
              layoutByWorkspace: {
                ...state.layoutByWorkspace,
                [normalizedWorkspaceKey]:
                  layout.focusedPaneId === null ? layout : { ...layout, focusedPaneId: null },
              },
            };
          });
          return token;
        },
        restorePaneFocus: (workspaceKey, token) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedToken = trimNonEmpty(token);
          if (!normalizedWorkspaceKey || !normalizedToken) {
            return;
          }

          set((state) => {
            const restoration = state.focusRestorationByWorkspace[normalizedWorkspaceKey];
            if (!restoration?.tokens.includes(normalizedToken)) {
              return state;
            }

            const nextTokens = restoration.tokens.filter((entry) => entry !== normalizedToken);
            const { [normalizedWorkspaceKey]: _removed, ...remainingRestorations } =
              state.focusRestorationByWorkspace;
            const layout = getWorkspaceLayout(state.layoutByWorkspace, normalizedWorkspaceKey);

            if (layout.focusedPaneId !== null) {
              return {
                focusRestorationByWorkspace: remainingRestorations,
              };
            }

            if (nextTokens.length > 0) {
              return {
                focusRestorationByWorkspace: {
                  ...remainingRestorations,
                  [normalizedWorkspaceKey]: {
                    restorePaneId: restoration.restorePaneId,
                    tokens: nextTokens,
                  },
                },
              };
            }

            const restorePaneId = findPaneById(layout.root, restoration.restorePaneId)?.id ?? null;
            if (!restorePaneId) {
              return {
                focusRestorationByWorkspace: remainingRestorations,
              };
            }

            return {
              focusRestorationByWorkspace: remainingRestorations,
              layoutByWorkspace: {
                ...state.layoutByWorkspace,
                [normalizedWorkspaceKey]: {
                  ...layout,
                  focusedPaneId: restorePaneId,
                },
              },
            };
          });
        },
        resizeSplit: (workspaceKey, groupId, sizes) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedGroupId = trimNonEmpty(groupId);
          if (!normalizedWorkspaceKey || !normalizedGroupId) {
            return;
          }

          set((state) => ({
            splitSizesByWorkspace: {
              ...state.splitSizesByWorkspace,
              [normalizedWorkspaceKey]: {
                ...state.splitSizesByWorkspace[normalizedWorkspaceKey],
                [normalizedGroupId]: clampNormalizedSizes(sizes),
              },
            },
          }));
        },
        reorderTabsInPane: (workspaceKey, paneId, tabIds) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedPaneId = trimNonEmpty(paneId);
          if (!normalizedWorkspaceKey || !normalizedPaneId) {
            return;
          }

          set((state) => {
            const nextLayout = reorderPaneTabsInLayout({
              layout: getWorkspaceLayout(state.layoutByWorkspace, normalizedWorkspaceKey),
              paneId: normalizedPaneId,
              tabIds,
            });
            if (!nextLayout) {
              return state;
            }

            return {
              ...withoutFocusRestoration(state, normalizedWorkspaceKey),
              layoutByWorkspace: {
                ...state.layoutByWorkspace,
                [normalizedWorkspaceKey]: nextLayout,
              },
            };
          });
        },
        pinAgent: (workspaceKey, agentId) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedAgentId = trimNonEmpty(agentId);
          if (!normalizedWorkspaceKey || !normalizedAgentId) {
            return;
          }

          set((state) => {
            const currentPinnedAgentIds =
              state.pinnedAgentIdsByWorkspace[normalizedWorkspaceKey] ?? null;
            if (currentPinnedAgentIds?.has(normalizedAgentId)) {
              return state;
            }

            const nextPinnedAgentIds = new Set(currentPinnedAgentIds ?? []);
            nextPinnedAgentIds.add(normalizedAgentId);

            return {
              hiddenAgentIdsByWorkspace: removeAgentIdFromWorkspaceSet(
                state.hiddenAgentIdsByWorkspace,
                normalizedWorkspaceKey,
                normalizedAgentId,
              ),
              pinnedAgentIdsByWorkspace: {
                ...state.pinnedAgentIdsByWorkspace,
                [normalizedWorkspaceKey]: nextPinnedAgentIds,
              },
            };
          });
        },
        unpinAgent: (workspaceKey, agentId) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedAgentId = trimNonEmpty(agentId);
          if (!normalizedWorkspaceKey || !normalizedAgentId) {
            return;
          }

          set((state) => {
            const currentPinnedAgentIds =
              state.pinnedAgentIdsByWorkspace[normalizedWorkspaceKey] ?? null;
            if (!currentPinnedAgentIds?.has(normalizedAgentId)) {
              return state;
            }

            if (currentPinnedAgentIds.size === 1) {
              const nextPinnedAgentIdsByWorkspace = {
                ...state.pinnedAgentIdsByWorkspace,
              };
              delete nextPinnedAgentIdsByWorkspace[normalizedWorkspaceKey];
              return {
                pinnedAgentIdsByWorkspace: nextPinnedAgentIdsByWorkspace,
              };
            }

            const nextPinnedAgentIds = new Set(currentPinnedAgentIds);
            nextPinnedAgentIds.delete(normalizedAgentId);

            return {
              pinnedAgentIdsByWorkspace: {
                ...state.pinnedAgentIdsByWorkspace,
                [normalizedWorkspaceKey]: nextPinnedAgentIds,
              },
            };
          });
        },
        hideAgent: (workspaceKey, agentId) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedAgentId = trimNonEmpty(agentId);
          if (!normalizedWorkspaceKey || !normalizedAgentId) {
            return;
          }

          set((state) => {
            const nextHiddenAgentIdsByWorkspace = addAgentIdToWorkspaceSet(
              state.hiddenAgentIdsByWorkspace,
              normalizedWorkspaceKey,
              normalizedAgentId,
            );
            if (nextHiddenAgentIdsByWorkspace === state.hiddenAgentIdsByWorkspace) {
              return state;
            }

            return {
              hiddenAgentIdsByWorkspace: nextHiddenAgentIdsByWorkspace,
            };
          });
        },
        unhideAgent: (workspaceKey, agentId) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedAgentId = trimNonEmpty(agentId);
          if (!normalizedWorkspaceKey || !normalizedAgentId) {
            return;
          }

          set((state) => {
            const nextHiddenAgentIdsByWorkspace = removeAgentIdFromWorkspaceSet(
              state.hiddenAgentIdsByWorkspace,
              normalizedWorkspaceKey,
              normalizedAgentId,
            );
            if (nextHiddenAgentIdsByWorkspace === state.hiddenAgentIdsByWorkspace) {
              return state;
            }

            return {
              hiddenAgentIdsByWorkspace: nextHiddenAgentIdsByWorkspace,
            };
          });
        },
        purgeWorkspace: (workspaceKey) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          if (!normalizedWorkspaceKey) {
            return;
          }

          set((state) => {
            const hasAny =
              normalizedWorkspaceKey in state.layoutByWorkspace ||
              normalizedWorkspaceKey in state.splitSizesByWorkspace ||
              normalizedWorkspaceKey in state.recentlyClosedTabsByWorkspace ||
              normalizedWorkspaceKey in state.pinnedAgentIdsByWorkspace ||
              normalizedWorkspaceKey in state.hiddenAgentIdsByWorkspace ||
              normalizedWorkspaceKey in state.focusRestorationByWorkspace;
            if (!hasAny) {
              return state;
            }
            const { [normalizedWorkspaceKey]: _layout, ...layoutByWorkspace } =
              state.layoutByWorkspace;
            const { [normalizedWorkspaceKey]: _splits, ...splitSizesByWorkspace } =
              state.splitSizesByWorkspace;
            const { [normalizedWorkspaceKey]: _recentlyClosed, ...recentlyClosedTabsByWorkspace } =
              state.recentlyClosedTabsByWorkspace;
            const { [normalizedWorkspaceKey]: _pinned, ...pinnedAgentIdsByWorkspace } =
              state.pinnedAgentIdsByWorkspace;
            const { [normalizedWorkspaceKey]: _hidden, ...hiddenAgentIdsByWorkspace } =
              state.hiddenAgentIdsByWorkspace;
            const { [normalizedWorkspaceKey]: _restoration, ...focusRestorationByWorkspace } =
              state.focusRestorationByWorkspace;
            return {
              layoutByWorkspace,
              splitSizesByWorkspace,
              recentlyClosedTabsByWorkspace,
              pinnedAgentIdsByWorkspace,
              hiddenAgentIdsByWorkspace,
              focusRestorationByWorkspace,
            };
          });
        },
      }),
      {
        name: "workspace-layout-state",
        version: 1,
        storage: createJSONStorage(() => AsyncStorage),
        partialize: (state) => {
          const layoutByWorkspace: Record<string, WorkspaceLayout> = {};
          for (const key in state.layoutByWorkspace) {
            layoutByWorkspace[key] = normalizeLayout(state.layoutByWorkspace[key]);
          }
          return {
            layoutByWorkspace,
            splitSizesByWorkspace: state.splitSizesByWorkspace,
            recentlyClosedTabsByWorkspace: Object.fromEntries(
              Object.entries(state.recentlyClosedTabsByWorkspace).map(([key, entries]) => [
                key,
                normalizeRecentlyClosedTabs(entries),
              ]),
            ),
          };
        },
      },
    ),
  );
}

export const useWorkspaceLayoutStore = createWorkspaceLayoutStore();

export function useWorkspaceLayoutStoreHydrated(): boolean {
  const [hasHydrated, setHasHydrated] = useState(() =>
    useWorkspaceLayoutStore.persist.hasHydrated(),
  );

  useEffect(() => {
    if (useWorkspaceLayoutStore.persist.hasHydrated()) {
      setHasHydrated(true);
      return;
    }

    return useWorkspaceLayoutStore.persist.onFinishHydration(() => {
      setHasHydrated(true);
    });
  }, []);

  return hasHydrated;
}
