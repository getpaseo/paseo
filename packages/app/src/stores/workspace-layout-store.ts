import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useState } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import type { WorkspaceTab, WorkspaceTabTarget } from "@/workspace-tabs/model";
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
  createWorkspaceLayoutWithExplorer,
  DEFAULT_EXPLORER_PANE_ID,
  findPaneById,
  findPaneContainingTab,
  focusPaneInLayout,
  focusTabInLayout,
  getFocusedBrowserId,
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
  setPaneHiddenInLayout,
  splitPaneEmptyInLayout,
  splitPaneInLayout,
  stripEphemeralTabsFromLayout,
  type SplitGroup,
  type SplitNode,
  type SplitPane,
  type WorkspaceTabReconcileState,
  type WorkspaceTabSnapshot,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-actions";
import { normalizeWorkspaceTabTarget } from "@/workspace-tabs/identity";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

export {
  collectAllPanes,
  collectAllTabs,
  createDefaultLayout,
  createWorkspaceLayoutWithExplorer,
  findPaneById,
  findPaneContainingTab,
  getFocusedBrowserId,
  getTreeDepth,
  insertSplit,
  normalizeLayout,
  removePaneFromTree,
  removeTabFromTree,
  stripEphemeralTabsFromLayout,
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
  pendingAgentIdsByWorkspace: Record<string, Set<string>>;
  hiddenAgentIdsByWorkspace: Record<string, Set<string>>;
  focusRestorationByWorkspace: Record<string, WorkspaceFocusRestorationState>;
  explorerPaneIdByWorkspace: Record<string, string | null>;
  acknowledgedPullRequestByWorkspace: Record<string, string>;
  openTabFocused: (workspaceKey: string, target: WorkspaceTabTarget) => string | null;
  openChildTabFocused: (
    workspaceKey: string,
    target: WorkspaceTabTarget,
    parentTabId: string,
  ) => string | null;
  openTabInBackground: (workspaceKey: string, target: WorkspaceTabTarget) => string | null;
  openTabInExplorerPaneBackground: (
    workspaceKey: string,
    target: WorkspaceTabTarget,
  ) => string | null;
  ensureExplorerPane: (workspaceKey: string) => EnsureExplorerPaneResult | null;
  openTabInExplorerPaneFocused: (
    workspaceKey: string,
    input: { target: WorkspaceTabTarget; parentTabId?: string | null },
  ) => string | null;
  observePullRequest: (workspaceKey: string, identity: string | null) => void;
  closeTab: (workspaceKey: string, tabId: string) => void;
  focusTab: (workspaceKey: string, tabId: string) => void;
  retargetTab: (workspaceKey: string, tabId: string, target: WorkspaceTabTarget) => string | null;
  convertDraftToAgent: (workspaceKey: string, tabId: string, agentId: string) => string | null;
  reconcileTabs: (workspaceKey: string, snapshot: WorkspaceTabSnapshot) => void;
  resolvePendingAgent: (workspaceKey: string, agentId: string) => void;
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
  hidePane: (workspaceKey: string, paneId: string) => void;
  showPane: (workspaceKey: string, paneId: string) => void;
  setExplorerPaneId: (workspaceKey: string, paneId: string | null) => void;
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

interface EnsureExplorerPaneResult {
  paneId: string;
  created: boolean;
}

interface WorkspaceFocusRestorationState {
  restorePaneId: string | null;
  tokens: string[];
}

// The root companion split is always present for the hidden explorer pane.
// Preserve four user-created split levels beneath it.
const MAX_TREE_DEPTH = 5;

const WorkspaceDraftTabSetupStorageSchema = z.strictObject({
  provider: z.string(),
  cwd: z.string(),
  modeId: z.string().nullable(),
  model: z.string().nullable(),
  thinkingOptionId: z.string().nullable(),
  featureValues: z.record(z.string(), z.union([z.boolean(), z.string(), z.null()])),
});
const WorkspaceTabTargetStorageSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("draft"),
    draftId: z.string(),
    setup: WorkspaceDraftTabSetupStorageSchema.optional(),
  }),
  z.strictObject({ kind: z.literal("agent"), agentId: z.string() }),
  z.strictObject({
    kind: z.literal("provider_subagent"),
    parentAgentId: z.string(),
    subagentId: z.string(),
  }),
  z.strictObject({ kind: z.literal("terminal"), terminalId: z.string() }),
  z.strictObject({ kind: z.literal("browser"), browserId: z.string() }),
  z.strictObject({ kind: z.literal("files") }),
  z.strictObject({ kind: z.literal("pull_request") }),
  z.strictObject({
    kind: z.literal("file"),
    path: z.string(),
    lineStart: z.number().int().positive().optional(),
    lineEnd: z.number().int().positive().optional(),
  }),
  z.strictObject({
    kind: z.literal("working_diff"),
    focusPath: z.string().optional(),
    focusRequestId: z.number().optional(),
    // COMPAT(workingDiffTarget): accepted from pre-canonical tab ids; normalization removes them.
    mode: z.enum(["uncommitted", "base"]).optional(),
    baseRef: z.string().nullable().optional(),
    ignoreWhitespace: z.boolean().optional(),
  }),
  z.strictObject({ kind: z.literal("setup"), workspaceId: z.string() }),
  z.strictObject({ kind: z.literal("commit_diff"), sha: z.string() }),
  z.discriminatedUnion("context", [
    z.strictObject({
      kind: z.literal("plugin"),
      pluginId: z.string(),
      panelId: z.string(),
      context: z.literal("workspace"),
    }),
    z.strictObject({
      kind: z.literal("plugin"),
      pluginId: z.string(),
      panelId: z.string(),
      context: z.literal("agent"),
      agentId: z.string(),
    }),
  ]),
]);
const WorkspaceTabStorageSchema = z.strictObject({
  tabId: z.string(),
  target: WorkspaceTabTargetStorageSchema,
  createdAt: z.number(),
});
const SplitNodeStorageSchema: z.ZodType<SplitNode> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("pane"),
      pane: z.strictObject({
        id: z.string(),
        tabIds: z.array(z.string()),
        focusedTabId: z.string().nullable(),
        tabs: z.array(WorkspaceTabStorageSchema).optional(),
        hidden: z.boolean().optional(),
      }),
    }),
    z.strictObject({
      kind: z.literal("group"),
      group: z.strictObject({
        id: z.string(),
        direction: z.enum(["horizontal", "vertical"]),
        children: z.array(SplitNodeStorageSchema),
        sizes: z.array(z.number()),
      }),
    }),
  ]),
);
const WorkspaceLayoutStorageSchema: z.ZodType<WorkspaceLayout> = z.strictObject({
  root: SplitNodeStorageSchema,
  focusedPaneId: z.string().nullable(),
  parentTabIdByTabId: z.record(z.string(), z.string()).optional(),
});
const WorkspaceLayoutPersistedStateSchema = z.strictObject({
  layoutByWorkspace: z.record(z.string(), WorkspaceLayoutStorageSchema),
  splitSizesByWorkspace: z.record(z.string(), z.record(z.string(), z.array(z.number()))).optional(),
  explorerPaneIdByWorkspace: z.record(z.string(), z.string().nullable()).optional(),
  acknowledgedPullRequestByWorkspace: z.record(z.string(), z.string()).optional(),
});

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
  return normalizeLayout(state[workspaceKey] ?? createWorkspaceLayoutWithExplorer());
}

export function resolveExplorerPaneId(
  layout: WorkspaceLayout,
  registeredPaneId: string | null | undefined,
): string | null {
  const registeredPane = findPaneById(layout.root, registeredPaneId ?? null);
  if (registeredPane) {
    return registeredPane.id;
  }
  const defaultPane = findPaneById(layout.root, DEFAULT_EXPLORER_PANE_ID);
  return defaultPane?.id ?? null;
}

function ensurePersistedExplorerPane(input: {
  layout: WorkspaceLayout;
  registeredPaneId: string | null | undefined;
  ids: WorkspaceLayoutIdSource;
}): { layout: WorkspaceLayout; paneId: string } | null {
  const existingPaneId = resolveExplorerPaneId(input.layout, input.registeredPaneId);
  if (existingPaneId) {
    return { layout: input.layout, paneId: existingPaneId };
  }
  const targetPaneId =
    findPaneById(input.layout.root, input.layout.focusedPaneId)?.id ??
    collectAllPanes(input.layout.root)[0]?.id;
  if (!targetPaneId) {
    return null;
  }
  const split = splitPaneEmptyInLayout({
    layout: input.layout,
    targetPaneId,
    position: "right",
    createNodeId: input.ids.createNodeId,
    maxTreeDepth: MAX_TREE_DEPTH,
  });
  if (!split) {
    return null;
  }
  const hiddenLayout = setPaneHiddenInLayout({
    layout: split.layout,
    paneId: split.paneId,
    hidden: true,
  });
  return { layout: hiddenLayout ?? split.layout, paneId: split.paneId };
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
        pinnedAgentIdsByWorkspace: {},
        pendingAgentIdsByWorkspace: {},
        hiddenAgentIdsByWorkspace: {},
        focusRestorationByWorkspace: {},
        explorerPaneIdByWorkspace: {},
        acknowledgedPullRequestByWorkspace: {},
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
        openTabInExplorerPaneBackground: (workspaceKey, target) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedTarget = normalizeWorkspaceTabTarget(target);
          if (!normalizedWorkspaceKey || !normalizedTarget) {
            return null;
          }

          let tabId: string | null = null;
          set((state) => {
            const layout = getWorkspaceLayout(state.layoutByWorkspace, normalizedWorkspaceKey);
            const explorerPaneId = resolveExplorerPaneId(
              layout,
              state.explorerPaneIdByWorkspace[normalizedWorkspaceKey],
            );
            const explorerPane = findPaneById(layout.root, explorerPaneId);
            if (!explorerPane) {
              return state;
            }

            const originalFocusedPaneId = layout.focusedPaneId;
            const revealedLayout = focusPaneInLayout({ layout, paneId: explorerPane.id }) ?? layout;
            const result = openTabInLayoutBackground({
              layout: revealedLayout,
              target: normalizedTarget,
              now: Date.now(),
            });
            const currentPane = findPaneContainingTab(result.layout.root, result.tabId);
            const placedLayout =
              currentPane?.id === explorerPane.id
                ? result.layout
                : (moveTabToPaneInLayout({
                    layout: result.layout,
                    tabId: result.tabId,
                    toPaneId: explorerPane.id,
                  }) ?? result.layout);
            const restoredVisibility = explorerPane.hidden
              ? (setPaneHiddenInLayout({
                  layout: placedLayout,
                  paneId: explorerPane.id,
                  hidden: true,
                }) ?? placedLayout)
              : placedLayout;
            const restoredLayout =
              originalFocusedPaneId && originalFocusedPaneId !== explorerPane.id
                ? (focusPaneInLayout({
                    layout: restoredVisibility,
                    paneId: originalFocusedPaneId,
                  }) ?? restoredVisibility)
                : restoredVisibility;

            tabId = result.tabId;
            return {
              ...withoutFocusRestoration(state, normalizedWorkspaceKey),
              explorerPaneIdByWorkspace: {
                ...state.explorerPaneIdByWorkspace,
                [normalizedWorkspaceKey]: explorerPane.id,
              },
              layoutByWorkspace: {
                ...state.layoutByWorkspace,
                [normalizedWorkspaceKey]: restoredLayout,
              },
            };
          });
          return tabId;
        },
        ensureExplorerPane: (workspaceKey) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          if (!normalizedWorkspaceKey) {
            return null;
          }

          const store = get();
          const layout = getWorkspaceLayout(store.layoutByWorkspace, normalizedWorkspaceKey);
          const explorerPaneId = resolveExplorerPaneId(
            layout,
            store.explorerPaneIdByWorkspace[normalizedWorkspaceKey],
          );
          const explorerPane = findPaneById(layout.root, explorerPaneId);
          if (explorerPane) {
            if (store.explorerPaneIdByWorkspace[normalizedWorkspaceKey] !== explorerPane.id) {
              store.setExplorerPaneId(normalizedWorkspaceKey, explorerPane.id);
            }
            store.focusPane(normalizedWorkspaceKey, explorerPane.id);
            return { paneId: explorerPane.id, created: false };
          }

          const targetPaneId =
            findPaneById(layout.root, layout.focusedPaneId)?.id ??
            collectAllPanes(layout.root)[0]?.id;
          if (!targetPaneId) {
            return null;
          }
          const paneId = store.splitPaneEmpty(normalizedWorkspaceKey, {
            targetPaneId,
            position: "right",
          });
          if (!paneId) {
            return null;
          }
          get().setExplorerPaneId(normalizedWorkspaceKey, paneId);
          return { paneId, created: true };
        },
        openTabInExplorerPaneFocused: (workspaceKey, input) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedTarget = normalizeWorkspaceTabTarget(input.target);
          if (!normalizedWorkspaceKey || !normalizedTarget) {
            return null;
          }

          const store = get();
          const explorerPane = store.ensureExplorerPane(normalizedWorkspaceKey);
          if (!explorerPane) {
            return null;
          }
          const parentTabId = trimNonEmpty(input.parentTabId);
          const tabId = parentTabId
            ? get().openChildTabFocused(normalizedWorkspaceKey, normalizedTarget, parentTabId)
            : get().openTabFocused(normalizedWorkspaceKey, normalizedTarget);
          if (!tabId) {
            return null;
          }

          const layout = getWorkspaceLayout(get().layoutByWorkspace, normalizedWorkspaceKey);
          const currentPane = findPaneContainingTab(layout.root, tabId);
          if (currentPane?.id !== explorerPane.paneId) {
            get().moveTabToPane(normalizedWorkspaceKey, tabId, explorerPane.paneId);
          }
          return tabId;
        },
        observePullRequest: (workspaceKey, identity) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedIdentity = trimNonEmpty(identity);
          if (!normalizedWorkspaceKey || !normalizedIdentity) {
            return;
          }

          set((state) => {
            if (
              state.acknowledgedPullRequestByWorkspace[normalizedWorkspaceKey] ===
              normalizedIdentity
            ) {
              return state;
            }

            const layout = getWorkspaceLayout(state.layoutByWorkspace, normalizedWorkspaceKey);
            const explorerPaneId = resolveExplorerPaneId(
              layout,
              state.explorerPaneIdByWorkspace[normalizedWorkspaceKey],
            );
            const explorerPane = findPaneById(layout.root, explorerPaneId);
            if (!explorerPane) {
              return state;
            }
            const placementLayout =
              focusPaneInLayout({ layout, paneId: explorerPane.id }) ?? layout;
            const result = openTabInLayoutFocused({
              layout: placementLayout,
              target: { kind: "pull_request" },
              now: Date.now(),
            });

            return {
              ...withoutFocusRestoration(state, normalizedWorkspaceKey),
              acknowledgedPullRequestByWorkspace: {
                ...state.acknowledgedPullRequestByWorkspace,
                [normalizedWorkspaceKey]: normalizedIdentity,
              },
              explorerPaneIdByWorkspace: {
                ...state.explorerPaneIdByWorkspace,
                [normalizedWorkspaceKey]: explorerPane.id,
              },
              layoutByWorkspace: {
                ...state.layoutByWorkspace,
                [normalizedWorkspaceKey]: result.layout,
              },
            };
          });
        },
        closeTab: (workspaceKey, tabId) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedTabId = trimNonEmpty(tabId);
          if (!normalizedWorkspaceKey || !normalizedTabId) {
            return;
          }

          set((state) => {
            const layout = getWorkspaceLayout(state.layoutByWorkspace, normalizedWorkspaceKey);
            const explorerPaneId = resolveExplorerPaneId(
              layout,
              state.explorerPaneIdByWorkspace[normalizedWorkspaceKey],
            );
            const closingPane = findPaneContainingTab(layout.root, normalizedTabId);
            const preserveEmptyPaneId =
              closingPane?.id === "main" || closingPane?.id === explorerPaneId
                ? closingPane.id
                : null;
            const nextLayout = closeTabInLayout({
              layout,
              tabId: normalizedTabId,
              preserveEmptyPaneId,
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
                pendingAgentIds: state.pendingAgentIdsByWorkspace[normalizedWorkspaceKey] ?? null,
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
        resolvePendingAgent: (workspaceKey, agentId) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedAgentId = trimNonEmpty(agentId);
          if (!normalizedWorkspaceKey || !normalizedAgentId) {
            return;
          }

          set((state) => {
            const pendingAgentIdsByWorkspace = removeAgentIdFromWorkspaceSet(
              state.pendingAgentIdsByWorkspace,
              normalizedWorkspaceKey,
              normalizedAgentId,
            );
            if (pendingAgentIdsByWorkspace === state.pendingAgentIdsByWorkspace) {
              return state;
            }
            return { pendingAgentIdsByWorkspace };
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
        hidePane: (workspaceKey, paneId) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedPaneId = trimNonEmpty(paneId);
          if (!normalizedWorkspaceKey || !normalizedPaneId) {
            return;
          }

          set((state) => {
            const nextLayout = setPaneHiddenInLayout({
              layout: getWorkspaceLayout(state.layoutByWorkspace, normalizedWorkspaceKey),
              paneId: normalizedPaneId,
              hidden: true,
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
        showPane: (workspaceKey, paneId) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedPaneId = trimNonEmpty(paneId);
          if (!normalizedWorkspaceKey || !normalizedPaneId) {
            return;
          }

          set((state) => {
            const nextLayout = setPaneHiddenInLayout({
              layout: getWorkspaceLayout(state.layoutByWorkspace, normalizedWorkspaceKey),
              paneId: normalizedPaneId,
              hidden: false,
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
        setExplorerPaneId: (workspaceKey, paneId) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          if (!normalizedWorkspaceKey) {
            return;
          }
          set((state) => ({
            explorerPaneIdByWorkspace: {
              ...state.explorerPaneIdByWorkspace,
              [normalizedWorkspaceKey]: trimNonEmpty(paneId),
            },
          }));
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

            const restorePane = findPaneById(layout.root, restoration.restorePaneId);
            const restorePaneId = restorePane?.hidden === true ? null : (restorePane?.id ?? null);
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
            const currentPendingAgentIds =
              state.pendingAgentIdsByWorkspace[normalizedWorkspaceKey] ?? null;
            if (
              currentPinnedAgentIds?.has(normalizedAgentId) &&
              currentPendingAgentIds?.has(normalizedAgentId)
            ) {
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
              pendingAgentIdsByWorkspace: addAgentIdToWorkspaceSet(
                state.pendingAgentIdsByWorkspace,
                normalizedWorkspaceKey,
                normalizedAgentId,
              ),
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
                pendingAgentIdsByWorkspace: removeAgentIdFromWorkspaceSet(
                  state.pendingAgentIdsByWorkspace,
                  normalizedWorkspaceKey,
                  normalizedAgentId,
                ),
              };
            }

            const nextPinnedAgentIds = new Set(currentPinnedAgentIds);
            nextPinnedAgentIds.delete(normalizedAgentId);

            return {
              pinnedAgentIdsByWorkspace: {
                ...state.pinnedAgentIdsByWorkspace,
                [normalizedWorkspaceKey]: nextPinnedAgentIds,
              },
              pendingAgentIdsByWorkspace: removeAgentIdFromWorkspaceSet(
                state.pendingAgentIdsByWorkspace,
                normalizedWorkspaceKey,
                normalizedAgentId,
              ),
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
              normalizedWorkspaceKey in state.pendingAgentIdsByWorkspace ||
              normalizedWorkspaceKey in state.hiddenAgentIdsByWorkspace ||
              normalizedWorkspaceKey in state.focusRestorationByWorkspace ||
              normalizedWorkspaceKey in state.explorerPaneIdByWorkspace ||
              normalizedWorkspaceKey in state.acknowledgedPullRequestByWorkspace;
            if (!hasAny) {
              return state;
            }
            const { [normalizedWorkspaceKey]: _layout, ...layoutByWorkspace } =
              state.layoutByWorkspace;
            const { [normalizedWorkspaceKey]: _splits, ...splitSizesByWorkspace } =
              state.splitSizesByWorkspace;
            const { [normalizedWorkspaceKey]: _pinned, ...pinnedAgentIdsByWorkspace } =
              state.pinnedAgentIdsByWorkspace;
            const { [normalizedWorkspaceKey]: _pending, ...pendingAgentIdsByWorkspace } =
              state.pendingAgentIdsByWorkspace;
            const { [normalizedWorkspaceKey]: _hidden, ...hiddenAgentIdsByWorkspace } =
              state.hiddenAgentIdsByWorkspace;
            const { [normalizedWorkspaceKey]: _restoration, ...focusRestorationByWorkspace } =
              state.focusRestorationByWorkspace;
            const { [normalizedWorkspaceKey]: _explorerPane, ...explorerPaneIdByWorkspace } =
              state.explorerPaneIdByWorkspace;
            const {
              [normalizedWorkspaceKey]: _acknowledgedPullRequest,
              ...acknowledgedPullRequestByWorkspace
            } = state.acknowledgedPullRequestByWorkspace;
            return {
              layoutByWorkspace,
              splitSizesByWorkspace,
              pinnedAgentIdsByWorkspace,
              pendingAgentIdsByWorkspace,
              hiddenAgentIdsByWorkspace,
              focusRestorationByWorkspace,
              explorerPaneIdByWorkspace,
              acknowledgedPullRequestByWorkspace,
            };
          });
        },
      }),
      {
        name: "workspace-layout-state",
        version: 1,
        storage: createValidatedPersistStorage(AsyncStorage, WorkspaceLayoutPersistedStateSchema),
        partialize: (state) => {
          const layoutByWorkspace: Record<string, WorkspaceLayout> = {};
          for (const key in state.layoutByWorkspace) {
            // Strip ephemeral (commit diff) tabs before persisting so they are
            // dropped on reload rather than restored pointing at a rebased SHA.
            layoutByWorkspace[key] = stripEphemeralTabsFromLayout(
              normalizeLayout(state.layoutByWorkspace[key]),
            );
          }
          return {
            layoutByWorkspace,
            splitSizesByWorkspace: state.splitSizesByWorkspace,
            explorerPaneIdByWorkspace: state.explorerPaneIdByWorkspace,
            acknowledgedPullRequestByWorkspace: state.acknowledgedPullRequestByWorkspace,
          };
        },
        merge: (persistedState, currentState) => {
          const result = WorkspaceLayoutPersistedStateSchema.safeParse(persistedState);
          if (!result.success) {
            return currentState;
          }
          const layoutByWorkspace: Record<string, WorkspaceLayout> = {};
          const explorerPaneIdByWorkspace: Record<string, string | null> = {
            ...result.data.explorerPaneIdByWorkspace,
          };
          for (const [workspaceKey, persistedLayout] of Object.entries(
            result.data.layoutByWorkspace,
          )) {
            const explorer = ensurePersistedExplorerPane({
              layout: normalizeLayout(persistedLayout),
              registeredPaneId: explorerPaneIdByWorkspace[workspaceKey],
              ids,
            });
            if (!explorer) {
              layoutByWorkspace[workspaceKey] = normalizeLayout(persistedLayout);
              continue;
            }
            layoutByWorkspace[workspaceKey] = explorer.layout;
            explorerPaneIdByWorkspace[workspaceKey] = explorer.paneId;
          }
          return {
            ...currentState,
            layoutByWorkspace,
            splitSizesByWorkspace: result.data.splitSizesByWorkspace ?? {},
            explorerPaneIdByWorkspace,
            acknowledgedPullRequestByWorkspace:
              result.data.acknowledgedPullRequestByWorkspace ?? {},
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
