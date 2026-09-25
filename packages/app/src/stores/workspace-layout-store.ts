import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useState } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { z } from "zod";
import { WorkspaceLayoutPersistedStateSchema } from "./workspace-layout-storage";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type { WorkspaceTab, WorkspaceTabTarget } from "@/workspace-tabs/model";
import {
  defaultWorkspaceLayoutIds,
  type WorkspaceLayoutIdSource,
} from "@/stores/workspace-layout-ids";
import {
  canDismissPaneInLayout,
  clampNormalizedSizes,
  closePaneInLayout,
  closeTabInLayout,
  collectAllPanes,
  collectAllTabs,
  convertDraftToAgentInLayout,
  createTabInLayout,
  createDefaultLayout,
  DEFAULT_PANE_ID,
  AMBIENT_PLACEMENT,
  createWorkspaceLayoutWithExplorerSidebar,
  FOCUSED_PANE_PLACEMENT,
  EXPLORER_SIDEBAR_PANE_ID,
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
  replaceTabTargetInLayout,
  revealTargetInLayout,
  restoreWorkspaceLayout,
  reconcileWorkspaceTabs,
  removePaneFromTree,
  removeTabFromTree,
  reorderFocusedPaneTabsInLayout,
  reorderPaneTabsInLayout,
  setPaneHiddenInLayout,
  setTabStateInLayout,
  selectTabInPaneInLayout,
  splitPaneEmptyInLayout,
  splitWorkspaceRootRightInLayout,
  splitWorkspaceRootBottomInLayout,
  splitPaneInLayout,
  BOTTOM_DOCK_MAX_SIZE,
  clampBottomDockGroupSizes,
  stripEphemeralTabsFromLayout,
  type SplitGroup,
  type SplitNode,
  type SplitPane,
  type WorkspaceTabPlacement,
  type WorkspaceTabInsertionPosition,
  type WorkspaceTabReconcileState,
  type WorkspaceTabSnapshot,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-actions";
import { normalizeWorkspaceTabTarget } from "@/workspace-tabs/identity";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import { panelTargetSupportsHostForWorkspaceKey } from "@/plugins/workspace-panels/locations";

export {
  AMBIENT_PLACEMENT,
  canDismissPaneInLayout,
  collectAllPanes,
  collectAllTabs,
  createDefaultLayout,
  DEFAULT_PANE_ID,
  createWorkspaceLayoutWithExplorerSidebar,
  FOCUSED_PANE_PLACEMENT,
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
  WorkspaceTabPlacement,
  WorkspaceTabReconcileState,
  WorkspaceTabSnapshot,
};

export type WorkspaceTabOpenIntent = "new" | "reveal" | "background";
export interface OpenWorkspaceTabInput {
  workspaceKey: string;
  target: WorkspaceTabTarget;
  intent: WorkspaceTabOpenIntent;
  /** Keeps an explicitly opened agent visible even when it is archived. */
  pin?: boolean;
  placement?: WorkspaceTabPlacement;
  insertionPosition?: WorkspaceTabInsertionPosition;
  parentTabId?: string;
  state?: JsonValue;
}

interface WorkspaceLayoutStore {
  layoutByWorkspace: Record<string, WorkspaceLayout>;
  splitSizesByWorkspace: Record<string, Record<string, number[]>>;
  explorerSidebarWidthByWorkspace: Record<string, number>;
  pinnedAgentIdsByWorkspace: Record<string, Set<string>>;
  hiddenAgentIdsByWorkspace: Record<string, Set<string>>;
  focusRestorationByWorkspace: Record<string, WorkspaceFocusRestorationState>;
  explorerSidebarPaneIdByWorkspace: Record<string, string | null>;
  sidePaneIdByWorkspace: Record<string, string | null>;
  /** Workspaces where PR detection already added its tab once; a closed tab never returns. */
  pullRequestTabAutoOpenedByWorkspace: Record<string, true>;
  bottomPaneIdByWorkspace: Record<string, string | null>;
  openTab: (input: OpenWorkspaceTabInput) => string | null;
  /** Placement resolves lazily so an already acknowledged workspace never creates a side pane. */
  autoOpenPullRequestTab: (
    workspaceKey: string,
    resolvePlacement: () => Pick<OpenWorkspaceTabInput, "placement" | "insertionPosition">,
  ) => string | null;
  /** Reveals the Explorer sidebar without selecting a view. Returns its pane id. */
  showExplorerSidebar: (workspaceKey: string) => string | null;
  hideExplorerSidebar: (workspaceKey: string) => void;
  /** Returns the ordinary right-side workspace pane, creating it when absent. */
  ensureSidePane: (workspaceKey: string, options?: { focus: boolean }) => string | null;
  /** Returns the ordinary bottom workspace pane, creating it when absent. */
  ensureBottomPane: (workspaceKey: string) => string | null;
  closeTab: (workspaceKey: string, tabId: string) => void;
  focusTab: (workspaceKey: string, tabId: string) => void;
  selectTabInPane: (workspaceKey: string, paneId: string, tabId: string) => void;
  replaceTab: (
    workspaceKey: string,
    tabId: string,
    target: WorkspaceTabTarget,
    state?: JsonValue,
  ) => string | null;
  setTabState: (workspaceKey: string, tabId: string, state: JsonValue | undefined) => void;
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
  /**
   * Dismisses the pane along with whatever it still holds. The Explorer hides so the
   * user can bring it back; every ordinary pane is removed. Callers own tab teardown
   * (archiving agents, killing terminals) first. No-ops on the last visible pane.
   */
  closePane: (workspaceKey: string, paneId: string) => void;
  focusPane: (workspaceKey: string, paneId: string) => void;
  unfocusPane: (workspaceKey: string) => string | null;
  restorePaneFocus: (workspaceKey: string, token: string) => void;
  resizeSplit: (workspaceKey: string, groupId: string, sizes: number[]) => void;
  resizeExplorerSidebar: (workspaceKey: string, width: number) => void;
  reorderTabsInPane: (workspaceKey: string, paneId: string, tabIds: string[]) => void;
  unpinAgent: (workspaceKey: string, agentId: string) => void;
  hideAgent: (workspaceKey: string, agentId: string) => void;
  unhideAgent: (workspaceKey: string, agentId: string) => void;
  purgeWorkspace: (workspaceKey: string) => void;
}

interface WorkspaceFocusRestorationState {
  restorePaneId: string | null;
  tokens: string[];
}

// The persisted tree includes the Explorer shell; the renderer docks it outside workspace splits.
// Preserve four user-created split levels beneath that bookkeeping node.
const MAX_TREE_DEPTH = 5;

const LEGACY_EXPLORER_SIDEBAR_REFERENCE_WIDTH = 1440;
const WORKSPACE_LAYOUT_PERSIST_VERSION = 2;

function convertLegacyExplorerSidebarRatios(
  ratiosByWorkspace: Record<string, number>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(ratiosByWorkspace).map(([workspaceKey, ratio]) => [
      workspaceKey,
      ratio * LEGACY_EXPLORER_SIDEBAR_REFERENCE_WIDTH,
    ]),
  );
}

function replacePaneInNode(node: SplitNode, paneId: string, replacement: SplitPane): SplitNode {
  if (node.kind === "pane") {
    return node.pane.id === paneId ? { kind: "pane", pane: replacement } : node;
  }
  return {
    kind: "group",
    group: {
      ...node.group,
      children: node.group.children.map((child) => replacePaneInNode(child, paneId, replacement)),
    },
  };
}

function visiblePane<TPane extends SplitPane>(pane: TPane): Omit<TPane, "hidden"> {
  const { hidden: _hidden, ...visible } = pane;
  return visible;
}

function createExplorerSidebarNode(): SplitNode {
  const layout = createWorkspaceLayoutWithExplorerSidebar();
  const pane = findPaneById(layout.root, EXPLORER_SIDEBAR_PANE_ID);
  if (!pane) {
    throw new Error("Default Explorer pane is missing");
  }
  return { kind: "pane", pane };
}

function preserveVersionOneSideTabs(input: {
  layout: WorkspaceLayout;
  legacyExplorerPane: SplitPane;
  rememberedSidePane: SplitPane | null;
  tabs: WorkspaceTab[];
  ids: WorkspaceLayoutIdSource;
}): { root: SplitNode; sidePaneId: string | null } {
  const rootWithoutExplorer = removePaneFromTree(input.layout.root, input.legacyExplorerPane.id);
  if (input.tabs.length === 0) {
    return {
      root: findPaneById(rootWithoutExplorer, input.legacyExplorerPane.id)
        ? createDefaultLayout().root
        : rootWithoutExplorer,
      sidePaneId: input.rememberedSidePane?.id ?? null,
    };
  }

  if (input.rememberedSidePane) {
    const rememberedTabs = collectAllTabs(input.layout.root).filter((tab) =>
      input.rememberedSidePane?.tabIds.includes(tab.tabId),
    );
    const nextSidePane = visiblePane({
      ...input.rememberedSidePane,
      tabIds: [...input.rememberedSidePane.tabIds, ...input.tabs.map((tab) => tab.tabId)],
      tabs: [...rememberedTabs, ...input.tabs],
      focusedTabId: input.rememberedSidePane.focusedTabId ?? input.tabs[0]?.tabId ?? null,
    });
    return {
      root: replacePaneInNode(rootWithoutExplorer, input.rememberedSidePane.id, nextSidePane),
      sidePaneId: input.rememberedSidePane.id,
    };
  }

  const sidePaneId = input.ids.createNodeId("pane");
  const sidePane = visiblePane({
    ...input.legacyExplorerPane,
    id: sidePaneId,
    tabIds: input.tabs.map((tab) => tab.tabId),
    tabs: input.tabs,
    focusedTabId:
      input.tabs.find((tab) => tab.tabId === input.legacyExplorerPane.focusedTabId)?.tabId ??
      input.tabs[0]?.tabId ??
      null,
  });
  return {
    root: replacePaneInNode(input.layout.root, input.legacyExplorerPane.id, sidePane),
    sidePaneId,
  };
}

function migrateVersionOneWorkspaceLayout(input: {
  layout: WorkspaceLayout;
  legacyExplorerPaneId: string | null | undefined;
  rememberedSidePaneId: string | null | undefined;
  ids: WorkspaceLayoutIdSource;
}): { layout: WorkspaceLayout; explorerPaneId: string; sidePaneId: string | null } {
  const strippedLayout = stripEphemeralTabsFromLayout(input.layout);
  const legacyExplorerPaneId = resolveExplorerSidebarPaneId(
    strippedLayout,
    input.legacyExplorerPaneId,
  );
  const legacyExplorerPane = findPaneById(strippedLayout.root, legacyExplorerPaneId);
  if (!legacyExplorerPane) {
    const ensured = ensurePersistedExplorerSidebarPane({
      layout: strippedLayout,
      registeredPaneId: null,
      ids: input.ids,
    });
    return {
      layout: ensured?.layout ?? strippedLayout,
      explorerPaneId: ensured?.paneId ?? EXPLORER_SIDEBAR_PANE_ID,
      sidePaneId: input.rememberedSidePaneId ?? null,
    };
  }

  const preservedTabs = collectAllTabs(strippedLayout.root).filter(
    (tab) =>
      legacyExplorerPane.tabIds.includes(tab.tabId) &&
      tab.target.kind !== "files" &&
      tab.target.kind !== "changes_tree",
  );
  const preservedSide = preserveVersionOneSideTabs({
    layout: strippedLayout,
    legacyExplorerPane,
    rememberedSidePane: findPaneById(strippedLayout.root, input.rememberedSidePaneId ?? null),
    tabs: preservedTabs,
    ids: input.ids,
  });
  const explorerNode = createExplorerSidebarNode();
  const focusedPaneId =
    strippedLayout.focusedPaneId === legacyExplorerPane.id
      ? (preservedSide.sidePaneId ?? collectAllPanes(preservedSide.root)[0]?.id ?? DEFAULT_PANE_ID)
      : strippedLayout.focusedPaneId;
  return {
    layout: normalizeLayout({
      root: {
        kind: "group",
        group: {
          id: input.ids.createNodeId("group"),
          direction: "horizontal",
          children: [preservedSide.root, explorerNode],
          sizes: [0.78, 0.22],
        },
      },
      focusedPaneId,
      parentTabIdByTabId: strippedLayout.parentTabIdByTabId,
    }),
    explorerPaneId: EXPLORER_SIDEBAR_PANE_ID,
    sidePaneId: preservedSide.sidePaneId,
  };
}

function migrateWorkspaceLayoutPersistedState(
  persistedState: unknown,
  version: number,
  ids: WorkspaceLayoutIdSource,
): z.infer<typeof WorkspaceLayoutPersistedStateSchema> {
  const result = WorkspaceLayoutPersistedStateSchema.safeParse(persistedState);
  if (!result.success || version >= WORKSPACE_LAYOUT_PERSIST_VERSION) {
    return result.success ? result.data : { layoutByWorkspace: {} };
  }

  const layoutByWorkspace: Record<string, WorkspaceLayout> = {};
  const explorerPaneIdByWorkspace: Record<string, string | null> = {};
  const sidePaneIdByWorkspace = { ...result.data.sidePaneIdByWorkspace };
  for (const [workspaceKey, layout] of Object.entries(result.data.layoutByWorkspace)) {
    const migrated = migrateVersionOneWorkspaceLayout({
      layout,
      legacyExplorerPaneId: result.data.explorerPaneIdByWorkspace?.[workspaceKey],
      rememberedSidePaneId: result.data.sidePaneIdByWorkspace?.[workspaceKey],
      ids,
    });
    layoutByWorkspace[workspaceKey] = migrated.layout;
    explorerPaneIdByWorkspace[workspaceKey] = migrated.explorerPaneId;
    sidePaneIdByWorkspace[workspaceKey] = migrated.sidePaneId;
  }

  return {
    ...result.data,
    layoutByWorkspace,
    explorerPaneIdByWorkspace,
    sidePaneIdByWorkspace,
  };
}

function trimNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function createWorkspaceTabInstanceId(): string {
  const value =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `tab_${value}`;
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
  return normalizeLayout(state[workspaceKey] ?? createWorkspaceLayoutWithExplorerSidebar());
}

function keepWorkspaceFocusOutOfExplorerSidebar(
  layout: WorkspaceLayout,
  explorerSidebarPaneId: string | null,
  preferredMainPaneId?: string | null,
): WorkspaceLayout {
  if (!explorerSidebarPaneId || layout.focusedPaneId !== explorerSidebarPaneId) {
    return layout;
  }
  const panes = collectAllPanes(layout.root);
  const preferredPane = panes.find(
    (pane) => pane.id === preferredMainPaneId && pane.id !== explorerSidebarPaneId,
  );
  const mainPane =
    preferredPane ??
    panes.find((pane) => pane.id === DEFAULT_PANE_ID && pane.id !== explorerSidebarPaneId) ??
    panes.find((pane) => pane.id !== explorerSidebarPaneId);
  return { ...layout, focusedPaneId: mainPane?.id ?? null };
}

type ExplorerSidebarState = Pick<
  WorkspaceLayoutStore,
  "layoutByWorkspace" | "explorerSidebarPaneIdByWorkspace"
>;

/**
 * The Explorer sidebar's pane, on screen or not. A workspace the user has not laid out
 * yet still has one — the default layout is born with it — so this answers before
 * the first tab exists.
 */
export function selectExplorerSidebarPaneId(
  state: ExplorerSidebarState,
  workspaceKey: string,
): string | null {
  const layout = getWorkspaceLayout(state.layoutByWorkspace, workspaceKey);
  return resolveExplorerSidebarPaneId(layout, state.explorerSidebarPaneIdByWorkspace[workspaceKey]);
}

/** Whether the Explorer sidebar pane is currently on screen. */
export function selectIsExplorerSidebarVisible(
  state: ExplorerSidebarState,
  workspaceKey: string,
): boolean {
  const layout = state.layoutByWorkspace[workspaceKey];
  const paneId = layout ? selectExplorerSidebarPaneId(state, workspaceKey) : null;
  const pane = paneId && layout ? findPaneById(layout.root, paneId) : null;
  return Boolean(pane && pane.hidden !== true);
}

export function resolveExplorerSidebarPaneId(
  layout: WorkspaceLayout,
  registeredPaneId: string | null | undefined,
): string | null {
  const registeredPane = findPaneById(layout.root, registeredPaneId ?? null);
  if (registeredPane) {
    return registeredPane.id;
  }
  const defaultPane = findPaneById(layout.root, EXPLORER_SIDEBAR_PANE_ID);
  return defaultPane?.id ?? null;
}

function ensurePersistedExplorerSidebarPane(input: {
  layout: WorkspaceLayout;
  registeredPaneId: string | null | undefined;
  ids: WorkspaceLayoutIdSource;
}): { layout: WorkspaceLayout; paneId: string } | null {
  const existingPaneId = resolveExplorerSidebarPaneId(input.layout, input.registeredPaneId);
  if (existingPaneId) {
    return {
      layout: keepWorkspaceFocusOutOfExplorerSidebar(
        input.layout,
        existingPaneId,
        input.layout.focusedPaneId,
      ),
      paneId: existingPaneId,
    };
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
  const seededLayout = restoreWorkspaceLayout(
    stripEphemeralTabsFromLayout(hiddenLayout ?? split.layout),
    split.paneId,
  );
  return {
    layout: seededLayout,
    paneId: split.paneId,
  };
}

function getOpenTabPlacement(
  state: WorkspaceLayoutStore,
  workspaceKey: string,
  target: WorkspaceTabTarget,
  placement: WorkspaceTabPlacement | undefined,
): {
  layout: WorkspaceLayout;
  placement: WorkspaceTabPlacement;
  explorerSidebarPaneId: string | null;
} {
  const layout = getWorkspaceLayout(state.layoutByWorkspace, workspaceKey);
  const explorerSidebarPaneId = resolveExplorerSidebarPaneId(
    layout,
    state.explorerSidebarPaneIdByWorkspace[workspaceKey],
  );
  const requestedPlacement = placement ?? AMBIENT_PLACEMENT;
  const supportsPane = (pane: SplitPane) =>
    panelTargetSupportsHostForWorkspaceKey(
      workspaceKey,
      target,
      pane.id === explorerSidebarPaneId ? "explorer" : "main",
    );
  const requestedPaneId =
    requestedPlacement.mode === "pane" || requestedPlacement.mode === "prefer"
      ? requestedPlacement.paneId
      : layout.focusedPaneId;
  const requestedPane = findPaneById(layout.root, requestedPaneId);
  const fallbackPane = collectAllPanes(layout.root).find(
    (pane) => pane.hidden !== true && supportsPane(pane),
  );
  let resolvedPlacement = requestedPlacement;
  if ((!requestedPane || !supportsPane(requestedPane)) && fallbackPane) {
    resolvedPlacement = {
      mode: requestedPlacement.mode === "pane" ? "pane" : "prefer",
      paneId: fallbackPane.id,
    };
  }
  return {
    layout,
    placement: resolvedPlacement,
    explorerSidebarPaneId,
  };
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

function reconcileRememberedSidePane(
  state: WorkspaceLayoutStore,
  workspaceKey: string,
  layout: WorkspaceLayout,
): Pick<WorkspaceLayoutStore, "sidePaneIdByWorkspace"> {
  const paneId = state.sidePaneIdByWorkspace[workspaceKey];
  return {
    sidePaneIdByWorkspace:
      paneId && !findPaneById(layout.root, paneId)
        ? { ...state.sidePaneIdByWorkspace, [workspaceKey]: null }
        : state.sidePaneIdByWorkspace,
  };
}

function reconcileRememberedBottomPane(
  state: WorkspaceLayoutStore,
  workspaceKey: string,
  layout: WorkspaceLayout,
): Pick<WorkspaceLayoutStore, "bottomPaneIdByWorkspace"> {
  const paneId = state.bottomPaneIdByWorkspace[workspaceKey];
  return {
    bottomPaneIdByWorkspace:
      paneId && !findPaneById(layout.root, paneId)
        ? { ...state.bottomPaneIdByWorkspace, [workspaceKey]: null }
        : state.bottomPaneIdByWorkspace,
  };
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

/**
 * Splits an Explorer sidebar out of the pane the user is in. Only reached by layouts saved
 * before the Explorer became part of the default tree; new ones are born with it.
 */
function createExplorerSidebarPane(
  workspaceKey: string,
  layout: WorkspaceLayout,
  splitPaneEmpty: WorkspaceLayoutStore["splitPaneEmpty"],
): string | null {
  const targetPaneId =
    findPaneById(layout.root, layout.focusedPaneId)?.id ?? collectAllPanes(layout.root)[0]?.id;
  return targetPaneId ? splitPaneEmpty(workspaceKey, { targetPaneId, position: "right" }) : null;
}

export function createWorkspaceLayoutStore(
  ids: WorkspaceLayoutIdSource = defaultWorkspaceLayoutIds,
) {
  return create<WorkspaceLayoutStore>()(
    persist(
      (set, get) => ({
        autoOpenPullRequestTab: (workspaceKey, resolvePlacement) => {
          const key = trimNonEmpty(workspaceKey);
          if (!key || get().pullRequestTabAutoOpenedByWorkspace[key]) return null;
          const tabId = get().openTab({
            workspaceKey: key,
            target: { kind: "pull_request" },
            intent: "background",
            ...resolvePlacement(),
          });
          if (tabId) {
            set((state) => ({
              pullRequestTabAutoOpenedByWorkspace: {
                ...state.pullRequestTabAutoOpenedByWorkspace,
                [key]: true,
              },
            }));
          }
          return tabId;
        },
        layoutByWorkspace: {},
        splitSizesByWorkspace: {},
        explorerSidebarWidthByWorkspace: {},
        pinnedAgentIdsByWorkspace: {},
        hiddenAgentIdsByWorkspace: {},
        focusRestorationByWorkspace: {},
        explorerSidebarPaneIdByWorkspace: {},
        sidePaneIdByWorkspace: {},
        pullRequestTabAutoOpenedByWorkspace: {},
        bottomPaneIdByWorkspace: {},
        openTab: (input) => {
          const normalizedWorkspaceKey = trimNonEmpty(input.workspaceKey);
          const normalizedTarget = normalizeWorkspaceTabTarget(input.target);
          if (!normalizedWorkspaceKey || !normalizedTarget) {
            return null;
          }
          const placement = getOpenTabPlacement(
            get(),
            normalizedWorkspaceKey,
            normalizedTarget,
            input.placement,
          );
          let result;
          if (input.intent === "new") {
            result = createTabInLayout({
              ...placement,
              insertionPosition: input.insertionPosition,
              target: normalizedTarget,
              now: Date.now(),
              createTabId: createWorkspaceTabInstanceId,
              state: input.state,
            });
          } else if (input.intent === "background") {
            result = openTabInLayoutBackground({
              ...placement,
              insertionPosition: input.insertionPosition,
              target: normalizedTarget,
              now: Date.now(),
            });
          } else {
            result = revealTargetInLayout({
              ...placement,
              insertionPosition: input.insertionPosition,
              target: normalizedTarget,
              now: Date.now(),
              createTabId: createWorkspaceTabInstanceId,
            });
          }
          if (!result) {
            return null;
          }
          const nextLayout = keepWorkspaceFocusOutOfExplorerSidebar(
            result.layout,
            placement.explorerSidebarPaneId,
            placement.layout.focusedPaneId,
          );
          const shouldPinAgent = input.pin === true && normalizedTarget.kind === "agent";
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
            pinnedAgentIdsByWorkspace: shouldPinAgent
              ? addAgentIdToWorkspaceSet(
                  state.pinnedAgentIdsByWorkspace,
                  normalizedWorkspaceKey,
                  normalizedTarget.agentId,
                )
              : state.pinnedAgentIdsByWorkspace,
            layoutByWorkspace: {
              ...state.layoutByWorkspace,
              [normalizedWorkspaceKey]: input.parentTabId
                ? attachParentTab({
                    layout: nextLayout,
                    childTabId: result.tabId,
                    parentTabId: input.parentTabId,
                  })
                : nextLayout,
            },
          }));
          return result.tabId;
        },
        showExplorerSidebar: (workspaceKey) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          if (!normalizedWorkspaceKey) {
            return null;
          }

          const layout = getWorkspaceLayout(get().layoutByWorkspace, normalizedWorkspaceKey);
          const paneId =
            resolveExplorerSidebarPaneId(
              layout,
              get().explorerSidebarPaneIdByWorkspace[normalizedWorkspaceKey],
            ) ?? createExplorerSidebarPane(normalizedWorkspaceKey, layout, get().splitPaneEmpty);
          if (!paneId) {
            return null;
          }

          set((state) => {
            const currentLayout = getWorkspaceLayout(
              state.layoutByWorkspace,
              normalizedWorkspaceKey,
            );
            const revealedLayout =
              setPaneHiddenInLayout({ layout: currentLayout, paneId, hidden: false }) ??
              currentLayout;
            return {
              layoutByWorkspace: {
                ...state.layoutByWorkspace,
                [normalizedWorkspaceKey]: keepWorkspaceFocusOutOfExplorerSidebar(
                  revealedLayout,
                  paneId,
                  currentLayout.focusedPaneId,
                ),
              },
              explorerSidebarPaneIdByWorkspace: {
                ...state.explorerSidebarPaneIdByWorkspace,
                [normalizedWorkspaceKey]: paneId,
              },
            };
          });
          return paneId;
        },
        hideExplorerSidebar: (workspaceKey) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          if (!normalizedWorkspaceKey) {
            return;
          }

          set((state) => {
            const layout = getWorkspaceLayout(state.layoutByWorkspace, normalizedWorkspaceKey);
            const paneId = resolveExplorerSidebarPaneId(
              layout,
              state.explorerSidebarPaneIdByWorkspace[normalizedWorkspaceKey],
            );
            const nextLayout = paneId
              ? setPaneHiddenInLayout({ layout, paneId, hidden: true })
              : null;
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
        ensureSidePane: (workspaceKey, options) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          if (!normalizedWorkspaceKey) {
            return null;
          }
          const currentState = get();
          const layout = getWorkspaceLayout(currentState.layoutByWorkspace, normalizedWorkspaceKey);
          const explorerPaneId = resolveExplorerSidebarPaneId(
            layout,
            currentState.explorerSidebarPaneIdByWorkspace[normalizedWorkspaceKey],
          );
          const rememberedPaneId = trimNonEmpty(
            currentState.sidePaneIdByWorkspace[normalizedWorkspaceKey],
          );
          const rememberedPane = findPaneById(layout.root, rememberedPaneId);
          if (rememberedPane && rememberedPane.id !== explorerPaneId) {
            return rememberedPane.id;
          }

          const result = splitWorkspaceRootRightInLayout({
            layout,
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
              [normalizedWorkspaceKey]:
                options?.focus === false
                  ? { ...result.layout, focusedPaneId: layout.focusedPaneId }
                  : result.layout,
            },
            sidePaneIdByWorkspace: {
              ...state.sidePaneIdByWorkspace,
              [normalizedWorkspaceKey]: result.paneId,
            },
          }));
          return result.paneId;
        },
        ensureBottomPane: (workspaceKey) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          if (!normalizedWorkspaceKey) {
            return null;
          }
          const currentState = get();
          const layout = getWorkspaceLayout(currentState.layoutByWorkspace, normalizedWorkspaceKey);
          const explorerPaneId = resolveExplorerSidebarPaneId(
            layout,
            currentState.explorerSidebarPaneIdByWorkspace[normalizedWorkspaceKey],
          );
          const rememberedPaneId = trimNonEmpty(
            currentState.bottomPaneIdByWorkspace[normalizedWorkspaceKey],
          );
          const rememberedPane = findPaneById(layout.root, rememberedPaneId);
          if (rememberedPane && rememberedPane.id !== explorerPaneId) {
            return rememberedPane.id;
          }

          const result = splitWorkspaceRootBottomInLayout({
            layout,
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
            bottomPaneIdByWorkspace: {
              ...state.bottomPaneIdByWorkspace,
              [normalizedWorkspaceKey]: result.paneId,
            },
          }));
          return result.paneId;
        },
        closeTab: (workspaceKey, tabId) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedTabId = trimNonEmpty(tabId);
          if (!normalizedWorkspaceKey || !normalizedTabId) {
            return;
          }

          set((state) => {
            const layout = getWorkspaceLayout(state.layoutByWorkspace, normalizedWorkspaceKey);
            const explorerSidebarPaneId = resolveExplorerSidebarPaneId(
              layout,
              state.explorerSidebarPaneIdByWorkspace[normalizedWorkspaceKey],
            );
            const closingPane = findPaneContainingTab(layout.root, normalizedTabId);
            const closingTab = collectAllTabs(layout.root).find(
              (tab) => tab.tabId === normalizedTabId,
            );
            if (closingPane?.tabIds.length === 1 && closingTab?.target.kind === "new_tab") {
              const nextLayout =
                closingPane.id === explorerSidebarPaneId
                  ? setPaneHiddenInLayout({
                      layout,
                      paneId: closingPane.id,
                      hidden: true,
                    })
                  : closePaneInLayout({
                      layout,
                      paneId: closingPane.id,
                      explorerSidebarPaneId,
                    });
              if (!nextLayout) {
                return state;
              }
              return {
                ...withoutFocusRestoration(state, normalizedWorkspaceKey),
                ...reconcileRememberedSidePane(state, normalizedWorkspaceKey, nextLayout),
                ...reconcileRememberedBottomPane(state, normalizedWorkspaceKey, nextLayout),
                layoutByWorkspace: {
                  ...state.layoutByWorkspace,
                  [normalizedWorkspaceKey]: nextLayout,
                },
              };
            }
            const closedLayout = closeTabInLayout({
              layout,
              tabId: normalizedTabId,
              explorerSidebarPaneId,
            });
            const nextLayoutBeforeFocusNormalization =
              closedLayout &&
              closingPane?.id === explorerSidebarPaneId &&
              closingPane.tabIds.length === 1
                ? (setPaneHiddenInLayout({
                    layout: closedLayout,
                    paneId: explorerSidebarPaneId,
                    hidden: true,
                  }) ?? closedLayout)
                : closedLayout;
            const nextLayout = nextLayoutBeforeFocusNormalization
              ? keepWorkspaceFocusOutOfExplorerSidebar(
                  nextLayoutBeforeFocusNormalization,
                  explorerSidebarPaneId,
                  layout.focusedPaneId,
                )
              : null;
            if (!nextLayout) {
              return state;
            }

            return {
              ...withoutFocusRestoration(state, normalizedWorkspaceKey),
              ...reconcileRememberedSidePane(state, normalizedWorkspaceKey, nextLayout),
              ...reconcileRememberedBottomPane(state, normalizedWorkspaceKey, nextLayout),
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
            const layout = getWorkspaceLayout(state.layoutByWorkspace, normalizedWorkspaceKey);
            const explorerSidebarPaneId = resolveExplorerSidebarPaneId(
              layout,
              state.explorerSidebarPaneIdByWorkspace[normalizedWorkspaceKey],
            );
            const tabPane = findPaneContainingTab(layout.root, normalizedTabId);
            let nextLayout: WorkspaceLayout | null;
            if (tabPane?.id === explorerSidebarPaneId) {
              const revealedLayout =
                setPaneHiddenInLayout({
                  layout,
                  paneId: explorerSidebarPaneId,
                  hidden: false,
                }) ?? layout;
              nextLayout =
                selectTabInPaneInLayout({
                  layout: revealedLayout,
                  paneId: explorerSidebarPaneId,
                  tabId: normalizedTabId,
                }) ?? revealedLayout;
            } else {
              nextLayout = focusTabInLayout({ layout, tabId: normalizedTabId });
            }
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
        selectTabInPane: (workspaceKey, paneId, tabId) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedPaneId = trimNonEmpty(paneId);
          const normalizedTabId = trimNonEmpty(tabId);
          if (!normalizedWorkspaceKey || !normalizedPaneId || !normalizedTabId) {
            return;
          }
          set((state) => {
            const layout = getWorkspaceLayout(state.layoutByWorkspace, normalizedWorkspaceKey);
            const nextLayout = selectTabInPaneInLayout({
              layout,
              paneId: normalizedPaneId,
              tabId: normalizedTabId,
            });
            return nextLayout
              ? {
                  layoutByWorkspace: {
                    ...state.layoutByWorkspace,
                    [normalizedWorkspaceKey]: nextLayout,
                  },
                }
              : state;
          });
        },
        replaceTab: (workspaceKey, tabId, target, tabState) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedTabId = trimNonEmpty(tabId);
          const normalizedTarget = normalizeWorkspaceTabTarget(target);
          if (!normalizedWorkspaceKey || !normalizedTabId || !normalizedTarget) return null;
          const result = replaceTabTargetInLayout({
            layout: getWorkspaceLayout(get().layoutByWorkspace, normalizedWorkspaceKey),
            tabId: normalizedTabId,
            target: normalizedTarget,
            createTabId: createWorkspaceTabInstanceId,
            state: tabState,
          });
          if (!result) return null;
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
        setTabState: (workspaceKey, tabId, tabState) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedTabId = trimNonEmpty(tabId);
          if (!normalizedWorkspaceKey || !normalizedTabId) return;
          set((state) => {
            const layout = setTabStateInLayout({
              layout: getWorkspaceLayout(state.layoutByWorkspace, normalizedWorkspaceKey),
              tabId: normalizedTabId,
              state: tabState,
            });
            if (!layout) return state;
            return {
              layoutByWorkspace: {
                ...state.layoutByWorkspace,
                [normalizedWorkspaceKey]: layout,
              },
            };
          });
        },
        convertDraftToAgent: (workspaceKey, tabId, agentId) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedTabId = trimNonEmpty(tabId);
          const normalizedAgentId = trimNonEmpty(agentId);
          if (!normalizedWorkspaceKey || !normalizedTabId || !normalizedAgentId) {
            return null;
          }

          const layout = getWorkspaceLayout(get().layoutByWorkspace, normalizedWorkspaceKey);
          const result = convertDraftToAgentInLayout({
            layout,
            explorerSidebarPaneId: resolveExplorerSidebarPaneId(
              layout,
              get().explorerSidebarPaneIdByWorkspace[normalizedWorkspaceKey],
            ),
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
            const rawLayout = getWorkspaceLayout(state.layoutByWorkspace, normalizedWorkspaceKey);
            const explorerSidebarPaneId = resolveExplorerSidebarPaneId(
              rawLayout,
              state.explorerSidebarPaneIdByWorkspace[normalizedWorkspaceKey],
            );
            const currentLayout = keepWorkspaceFocusOutOfExplorerSidebar(
              rawLayout,
              explorerSidebarPaneId,
              rawLayout.focusedPaneId,
            );
            const nextState = reconcileWorkspaceTabs(
              {
                layout: currentLayout,
                pinnedAgentIds: state.pinnedAgentIdsByWorkspace[normalizedWorkspaceKey] ?? null,
                hiddenAgentIds: state.hiddenAgentIdsByWorkspace[normalizedWorkspaceKey] ?? null,
                explorerSidebarPaneId,
              },
              snapshot,
            );
            const nextLayout = keepWorkspaceFocusOutOfExplorerSidebar(
              nextState.layout,
              explorerSidebarPaneId,
              currentLayout.focusedPaneId,
            );
            let pinnedAgentIdsByWorkspace = state.pinnedAgentIdsByWorkspace;
            for (const agentId of state.pinnedAgentIdsByWorkspace[normalizedWorkspaceKey] ?? []) {
              if (!nextState.pinnedAgentIds?.has(agentId)) {
                pinnedAgentIdsByWorkspace = removeAgentIdFromWorkspaceSet(
                  pinnedAgentIdsByWorkspace,
                  normalizedWorkspaceKey,
                  agentId,
                );
              }
            }
            if (
              state.layoutByWorkspace[normalizedWorkspaceKey] &&
              nextLayout === rawLayout &&
              pinnedAgentIdsByWorkspace === state.pinnedAgentIdsByWorkspace
            ) {
              return state;
            }

            return {
              pinnedAgentIdsByWorkspace,
              layoutByWorkspace: {
                ...state.layoutByWorkspace,
                [normalizedWorkspaceKey]: nextLayout,
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

          const currentLayout = getWorkspaceLayout(get().layoutByWorkspace, normalizedWorkspaceKey);
          const explorerSidebarPaneId = resolveExplorerSidebarPaneId(
            currentLayout,
            get().explorerSidebarPaneIdByWorkspace[normalizedWorkspaceKey],
          );
          if (normalizedTargetPaneId === explorerSidebarPaneId) {
            return null;
          }
          const movingTab = collectAllTabs(currentLayout.root).find(
            (tab) => tab.tabId === normalizedTabId,
          );
          if (
            !movingTab ||
            !panelTargetSupportsHostForWorkspaceKey(
              normalizedWorkspaceKey,
              movingTab.target,
              "main",
            )
          ) {
            return null;
          }

          const result = splitPaneInLayout({
            layout: currentLayout,
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

          const currentLayout = getWorkspaceLayout(get().layoutByWorkspace, normalizedWorkspaceKey);
          const explorerSidebarPaneId = resolveExplorerSidebarPaneId(
            currentLayout,
            get().explorerSidebarPaneIdByWorkspace[normalizedWorkspaceKey],
          );
          if (normalizedTargetPaneId === explorerSidebarPaneId) {
            return null;
          }

          const result = splitPaneEmptyInLayout({
            layout: currentLayout,
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
            const layout = getWorkspaceLayout(state.layoutByWorkspace, normalizedWorkspaceKey);
            const movingTab = collectAllTabs(layout.root).find(
              (tab) => tab.tabId === normalizedTabId,
            );
            const explorerSidebarPaneId = resolveExplorerSidebarPaneId(
              layout,
              state.explorerSidebarPaneIdByWorkspace[normalizedWorkspaceKey],
            );
            const destinationHost =
              normalizedToPaneId === explorerSidebarPaneId ? "explorer" : "main";
            if (
              !movingTab ||
              !panelTargetSupportsHostForWorkspaceKey(
                normalizedWorkspaceKey,
                movingTab.target,
                destinationHost,
              )
            ) {
              return state;
            }
            const nextLayout = moveTabToPaneInLayout({
              layout,
              tabId: normalizedTabId,
              toPaneId: normalizedToPaneId,
              explorerSidebarPaneId,
            });
            if (!nextLayout) {
              return state;
            }
            const restoredLayout =
              normalizedToPaneId === explorerSidebarPaneId
                ? restoreWorkspaceLayout(nextLayout, explorerSidebarPaneId)
                : nextLayout;
            const normalizedNextLayout = keepWorkspaceFocusOutOfExplorerSidebar(
              restoredLayout,
              explorerSidebarPaneId,
              layout.focusedPaneId,
            );
            const rememberedSidePaneId = state.sidePaneIdByWorkspace[normalizedWorkspaceKey];
            const rememberedBottomPaneId = state.bottomPaneIdByWorkspace[normalizedWorkspaceKey];

            return {
              ...withoutFocusRestoration(state, normalizedWorkspaceKey),
              layoutByWorkspace: {
                ...state.layoutByWorkspace,
                [normalizedWorkspaceKey]: normalizedNextLayout,
              },
              sidePaneIdByWorkspace:
                rememberedSidePaneId &&
                !findPaneById(normalizedNextLayout.root, rememberedSidePaneId)
                  ? { ...state.sidePaneIdByWorkspace, [normalizedWorkspaceKey]: null }
                  : state.sidePaneIdByWorkspace,
              bottomPaneIdByWorkspace:
                rememberedBottomPaneId &&
                !findPaneById(normalizedNextLayout.root, rememberedBottomPaneId)
                  ? { ...state.bottomPaneIdByWorkspace, [normalizedWorkspaceKey]: null }
                  : state.bottomPaneIdByWorkspace,
            };
          });
        },
        closePane: (workspaceKey, paneId) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          const normalizedPaneId = trimNonEmpty(paneId);
          if (!normalizedWorkspaceKey || !normalizedPaneId) {
            return;
          }

          set((state) => {
            const layout = getWorkspaceLayout(state.layoutByWorkspace, normalizedWorkspaceKey);
            // The Explorer is a surface the user summons, so closing it puts it
            // away rather than dismantling the split it lives in.
            const explorerSidebarPaneId = resolveExplorerSidebarPaneId(
              layout,
              state.explorerSidebarPaneIdByWorkspace[normalizedWorkspaceKey],
            );
            const isExplorerSidebar = explorerSidebarPaneId === normalizedPaneId;
            const nextLayout = isExplorerSidebar
              ? setPaneHiddenInLayout({ layout, paneId: normalizedPaneId, hidden: true })
              : closePaneInLayout({
                  layout,
                  paneId: normalizedPaneId,
                  explorerSidebarPaneId,
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
              sidePaneIdByWorkspace:
                state.sidePaneIdByWorkspace[normalizedWorkspaceKey] === normalizedPaneId
                  ? {
                      ...state.sidePaneIdByWorkspace,
                      [normalizedWorkspaceKey]: null,
                    }
                  : state.sidePaneIdByWorkspace,
              bottomPaneIdByWorkspace:
                state.bottomPaneIdByWorkspace[normalizedWorkspaceKey] === normalizedPaneId
                  ? {
                      ...state.bottomPaneIdByWorkspace,
                      [normalizedWorkspaceKey]: null,
                    }
                  : state.bottomPaneIdByWorkspace,
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
            const layout = getWorkspaceLayout(state.layoutByWorkspace, normalizedWorkspaceKey);
            const explorerSidebarPaneId = resolveExplorerSidebarPaneId(
              layout,
              state.explorerSidebarPaneIdByWorkspace[normalizedWorkspaceKey],
            );
            if (normalizedPaneId === explorerSidebarPaneId) {
              return state;
            }
            const nextLayout = focusPaneInLayout({
              layout,
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

          const bottomPaneId = get().bottomPaneIdByWorkspace[normalizedWorkspaceKey] ?? null;
          const layout = bottomPaneId ? get().layoutByWorkspace[normalizedWorkspaceKey] : undefined;
          const nextSizes =
            bottomPaneId && layout
              ? clampBottomDockGroupSizes({
                  root: layout.root,
                  groupId: normalizedGroupId,
                  sizes,
                  bottomPaneId,
                  maxSize: BOTTOM_DOCK_MAX_SIZE,
                })
              : sizes;

          set((state) => ({
            splitSizesByWorkspace: {
              ...state.splitSizesByWorkspace,
              [normalizedWorkspaceKey]: {
                ...state.splitSizesByWorkspace[normalizedWorkspaceKey],
                [normalizedGroupId]: clampNormalizedSizes(nextSizes),
              },
            },
          }));
        },
        resizeExplorerSidebar: (workspaceKey, width) => {
          const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
          if (!normalizedWorkspaceKey || !Number.isFinite(width) || width <= 0) {
            return;
          }

          set((state) => ({
            explorerSidebarWidthByWorkspace: {
              ...state.explorerSidebarWidthByWorkspace,
              [normalizedWorkspaceKey]: width,
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
              normalizedWorkspaceKey in state.explorerSidebarWidthByWorkspace ||
              normalizedWorkspaceKey in state.pinnedAgentIdsByWorkspace ||
              normalizedWorkspaceKey in state.hiddenAgentIdsByWorkspace ||
              normalizedWorkspaceKey in state.focusRestorationByWorkspace ||
              normalizedWorkspaceKey in state.explorerSidebarPaneIdByWorkspace ||
              normalizedWorkspaceKey in state.sidePaneIdByWorkspace ||
              normalizedWorkspaceKey in state.pullRequestTabAutoOpenedByWorkspace ||
              normalizedWorkspaceKey in state.bottomPaneIdByWorkspace;
            if (!hasAny) {
              return state;
            }
            const {
              [normalizedWorkspaceKey]: _autoOpened,
              ...pullRequestTabAutoOpenedByWorkspace
            } = state.pullRequestTabAutoOpenedByWorkspace;
            const { [normalizedWorkspaceKey]: _layout, ...layoutByWorkspace } =
              state.layoutByWorkspace;
            const { [normalizedWorkspaceKey]: _splits, ...splitSizesByWorkspace } =
              state.splitSizesByWorkspace;
            const {
              [normalizedWorkspaceKey]: _explorerSidebarWidth,
              ...explorerSidebarWidthByWorkspace
            } = state.explorerSidebarWidthByWorkspace;
            const { [normalizedWorkspaceKey]: _pinned, ...pinnedAgentIdsByWorkspace } =
              state.pinnedAgentIdsByWorkspace;
            const { [normalizedWorkspaceKey]: _hidden, ...hiddenAgentIdsByWorkspace } =
              state.hiddenAgentIdsByWorkspace;
            const { [normalizedWorkspaceKey]: _restoration, ...focusRestorationByWorkspace } =
              state.focusRestorationByWorkspace;
            const {
              [normalizedWorkspaceKey]: _explorerSidebarPane,
              ...explorerSidebarPaneIdByWorkspace
            } = state.explorerSidebarPaneIdByWorkspace;
            const { [normalizedWorkspaceKey]: _sidePane, ...sidePaneIdByWorkspace } =
              state.sidePaneIdByWorkspace;
            const { [normalizedWorkspaceKey]: _bottomPane, ...bottomPaneIdByWorkspace } =
              state.bottomPaneIdByWorkspace;
            return {
              pullRequestTabAutoOpenedByWorkspace,
              layoutByWorkspace,
              splitSizesByWorkspace,
              explorerSidebarWidthByWorkspace,
              pinnedAgentIdsByWorkspace,
              hiddenAgentIdsByWorkspace,
              focusRestorationByWorkspace,
              explorerSidebarPaneIdByWorkspace,
              sidePaneIdByWorkspace,
              bottomPaneIdByWorkspace,
            };
          });
        },
      }),
      {
        name: "workspace-layout-state",
        version: WORKSPACE_LAYOUT_PERSIST_VERSION,
        storage: createValidatedPersistStorage(AsyncStorage, WorkspaceLayoutPersistedStateSchema),
        migrate: (persistedState, version) =>
          migrateWorkspaceLayoutPersistedState(persistedState, version, ids),
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
            pinnedAgentIdsByWorkspace: Object.fromEntries(
              Object.entries(state.pinnedAgentIdsByWorkspace).map(([key, agentIds]) => [
                key,
                Array.from(agentIds),
              ]),
            ),
            splitSizesByWorkspace: state.splitSizesByWorkspace,
            explorerSidebarWidthByWorkspace: state.explorerSidebarWidthByWorkspace,
            explorerPaneIdByWorkspace: state.explorerSidebarPaneIdByWorkspace,
            sidePaneIdByWorkspace: state.sidePaneIdByWorkspace,
            pullRequestTabAutoOpenedByWorkspace: state.pullRequestTabAutoOpenedByWorkspace,
            bottomPaneIdByWorkspace: state.bottomPaneIdByWorkspace,
          };
        },
        merge: (persistedState, currentState) => {
          const result = WorkspaceLayoutPersistedStateSchema.safeParse(persistedState);
          if (!result.success) {
            return currentState;
          }
          const layoutByWorkspace: Record<string, WorkspaceLayout> = {};
          const explorerSidebarPaneIdByWorkspace: Record<string, string | null> = {
            ...(result.data.explorerSidebarPaneIdByWorkspace ??
              result.data.explorerPaneIdByWorkspace),
          };
          for (const [workspaceKey, persistedLayout] of Object.entries(
            result.data.layoutByWorkspace,
          )) {
            const restoredLayout = restoreWorkspaceLayout(
              stripEphemeralTabsFromLayout(persistedLayout),
              resolveExplorerSidebarPaneId(
                persistedLayout,
                explorerSidebarPaneIdByWorkspace[workspaceKey],
              ),
              ids.createNodeId,
            );
            const explorerSidebar = ensurePersistedExplorerSidebarPane({
              layout: restoredLayout,
              registeredPaneId: explorerSidebarPaneIdByWorkspace[workspaceKey],
              ids,
            });
            layoutByWorkspace[workspaceKey] = explorerSidebar?.layout ?? restoredLayout;
            if (explorerSidebar) {
              explorerSidebarPaneIdByWorkspace[workspaceKey] = explorerSidebar.paneId;
            }
          }
          return {
            ...currentState,
            layoutByWorkspace,
            pinnedAgentIdsByWorkspace: Object.fromEntries(
              Object.entries(result.data.pinnedAgentIdsByWorkspace ?? {}).map(([key, agentIds]) => [
                key,
                new Set(agentIds),
              ]),
            ),
            splitSizesByWorkspace: result.data.splitSizesByWorkspace ?? {},
            explorerSidebarWidthByWorkspace:
              result.data.explorerSidebarWidthByWorkspace ??
              convertLegacyExplorerSidebarRatios(
                result.data.explorerSidebarRatioByWorkspace ??
                  result.data.sidePanelRatioByWorkspace ??
                  {},
              ),
            explorerSidebarPaneIdByWorkspace,
            sidePaneIdByWorkspace: result.data.sidePaneIdByWorkspace ?? {},
            pullRequestTabAutoOpenedByWorkspace:
              result.data.pullRequestTabAutoOpenedByWorkspace ?? {},
            bottomPaneIdByWorkspace: result.data.bottomPaneIdByWorkspace ?? {},
          };
        },
      },
    ),
  );
}

export const useWorkspaceLayoutStore = createWorkspaceLayoutStore();

/**
 * The agent tabs that exist right now, across every workspace of this host, independently
 * of which workspace views are mounted. Timeline sync uses this to release a chat when its
 * tab closes. It is not a subscription source: this layout is restored from disk at launch,
 * so subscribing to it would resume every agent the user has ever opened.
 */
export function observeOpenWorkspaceAgentIds(
  serverId: string,
  listener: (agentIds: string[]) => void,
  store = useWorkspaceLayoutStore,
): () => void {
  let previous: string[] | undefined;
  const publish = (state: Pick<WorkspaceLayoutStore, "layoutByWorkspace">) => {
    const ids = new Set<string>();
    for (const [workspaceKey, layout] of Object.entries(state.layoutByWorkspace)) {
      if (!workspaceKey.startsWith(`${serverId}:`)) continue;
      for (const tab of collectAllTabs(layout.root)) {
        if (tab.target.kind === "agent") ids.add(tab.target.agentId);
      }
    }
    const next = [...ids].sort();
    if (previous?.length === next.length && previous.every((id, index) => id === next[index]))
      return;
    previous = next;
    listener(next);
  };
  const unsubscribe = store.subscribe((state, before) => {
    if (state.layoutByWorkspace !== before.layoutByWorkspace) publish(state);
  });
  publish(store.getState());
  return unsubscribe;
}

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
