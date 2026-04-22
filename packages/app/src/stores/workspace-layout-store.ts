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
  getTreeDepth,
  insertSplit,
  moveTabToPaneInLayout,
  normalizeLayout,
  openTabInLayoutBackground,
  openTabInLayoutFocused,
  reconcileWorkspaceTabs,
  removePaneFromTree,
  removeTabFromTree,
  reorderFocusedPaneTabsInLayout,
  reorderPaneTabsInLayout,
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
import { normalizeWorkspaceTabTarget } from "@/utils/workspace-tab-identity";

export { buildWorkspaceTabPersistenceKey };
export {
  collectAllPanes,
  collectAllTabs,
  createDefaultLayout,
  findPaneById,
  findPaneContainingTab,
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
  pinnedAgentIdsByWorkspace: Record<string, Set<string>>;
  hiddenAgentIdsByWorkspace: Record<string, Set<string>>;
  openTabFocused: (workspaceKey: string, target: WorkspaceTabTarget) => string | null;
  openTabInBackground: (workspaceKey: string, target: WorkspaceTabTarget) => string | null;
  closeTab: (workspaceKey: string, tabId: string) => void;
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
  resizeSplit: (workspaceKey: string, groupId: string, sizes: number[]) => void;
  reorderTabsInPane: (workspaceKey: string, paneId: string, tabIds: string[]) => void;
  pinAgent: (workspaceKey: string, agentId: string) => void;
  unpinAgent: (workspaceKey: string, agentId: string) => void;
  hideAgent: (workspaceKey: string, agentId: string) => void;
  unhideAgent: (workspaceKey: string, agentId: string) => void;
  purgeWorkspace: (workspaceKey: string) => void;
}

const MAX_TREE_DEPTH = 4;

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

export const useWorkspaceLayoutStore = create<WorkspaceLayoutStore>()(
  persist(
    (set, get) => ({
      layoutByWorkspace: {},
      splitSizesByWorkspace: {},
      pinnedAgentIdsByWorkspace: {},
      hiddenAgentIdsByWorkspace: {},
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
          const nextLayout = closeTabInLayout({
            layout: getWorkspaceLayout(state.layoutByWorkspace, normalizedWorkspaceKey),
            tabId: normalizedTabId,
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
          const currentLayout = getWorkspaceLayout(state.layoutByWorkspace, normalizedWorkspaceKey);
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
          createNodeId: (prefix) => {
            const randomValue =
              typeof globalThis.crypto?.randomUUID === "function"
                ? globalThis.crypto.randomUUID()
                : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
            return `${prefix}_${randomValue}`;
          },
        });
        if (!result) {
          return null;
        }

        set((state) => ({
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
          createNodeId: (prefix) => {
            const randomValue =
              typeof globalThis.crypto?.randomUUID === "function"
                ? globalThis.crypto.randomUUID()
                : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
            return `${prefix}_${randomValue}`;
          },
        });
        if (!result) {
          return null;
        }

        set((state) => ({
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
            layoutByWorkspace: {
              ...state.layoutByWorkspace,
              [normalizedWorkspaceKey]: nextLayout,
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
              ...(state.splitSizesByWorkspace[normalizedWorkspaceKey] ?? {}),
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
            normalizedWorkspaceKey in state.pinnedAgentIdsByWorkspace ||
            normalizedWorkspaceKey in state.hiddenAgentIdsByWorkspace;
          if (!hasAny) {
            return state;
          }
          const { [normalizedWorkspaceKey]: _layout, ...layoutByWorkspace } =
            state.layoutByWorkspace;
          const { [normalizedWorkspaceKey]: _splits, ...splitSizesByWorkspace } =
            state.splitSizesByWorkspace;
          const { [normalizedWorkspaceKey]: _pinned, ...pinnedAgentIdsByWorkspace } =
            state.pinnedAgentIdsByWorkspace;
          const { [normalizedWorkspaceKey]: _hidden, ...hiddenAgentIdsByWorkspace } =
            state.hiddenAgentIdsByWorkspace;
          return {
            layoutByWorkspace,
            splitSizesByWorkspace,
            pinnedAgentIdsByWorkspace,
            hiddenAgentIdsByWorkspace,
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
        };
      },
    },
  ),
);

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
