import {
  findPaneById,
  type SplitPane,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-store";
import type { WorkspaceTab, WorkspaceTabTarget } from "@/stores/workspace-tabs-store";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import {
  buildDeterministicWorkspaceTabId,
  normalizeWorkspaceTabTarget,
  workspaceTabTargetsEqual,
} from "@/utils/workspace-tab-identity";
import { findAdjacentPane } from "@/utils/split-navigation";

export interface WorkspaceDerivedTab {
  descriptor: WorkspaceTabDescriptor;
}

export interface WorkspacePaneState {
  pane: SplitPane | null;
  tabs: WorkspaceDerivedTab[];
  focusedTabId: string | null;
  activeTabId: string | null;
  activeTab: WorkspaceDerivedTab | null;
}

export type WorkspaceSideFileOpenPlacement =
  | { kind: "open-in-source" }
  | { kind: "focus-side-pane"; paneId: string }
  | { kind: "split-side-pane"; paneId: string };

interface NormalizeWorkspacePaneTabsResult {
  tabs: WorkspaceDerivedTab[];
  openTabIds: Set<string>;
}

function trimNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeWorkspaceTab(tab: WorkspaceTab): WorkspaceTab | null {
  if (!tab || typeof tab !== "object") {
    return null;
  }
  const tabId = trimNonEmpty(tab.tabId);
  if (!tabId) {
    return null;
  }
  const target = normalizeWorkspaceTabTarget(tab.target);
  if (!target) {
    return null;
  }
  return {
    tabId,
    target,
    createdAt: tab.createdAt,
  };
}

function orderPaneTabs(input: { pane: SplitPane | null; tabs: WorkspaceTab[] }): WorkspaceTab[] {
  if (!input.pane) {
    return input.tabs;
  }

  const tabsById = new Map<string, WorkspaceTab>();
  for (const tab of input.tabs) {
    tabsById.set(tab.tabId, tab);
  }

  const orderedTabs: WorkspaceTab[] = [];
  for (const tabId of input.pane.tabIds) {
    const tab = tabsById.get(tabId);
    if (tab) {
      orderedTabs.push(tab);
    }
  }
  return orderedTabs;
}

function normalizeWorkspacePaneTabs(tabs: WorkspaceTab[]): NormalizeWorkspacePaneTabsResult {
  const nextTabs: WorkspaceDerivedTab[] = [];
  const openTabIds = new Set<string>();

  for (const tab of tabs) {
    const normalizedTab = normalizeWorkspaceTab(tab);
    if (!normalizedTab || openTabIds.has(normalizedTab.tabId)) {
      continue;
    }

    openTabIds.add(normalizedTab.tabId);
    nextTabs.push({
      descriptor: {
        key: normalizedTab.tabId,
        tabId: normalizedTab.tabId,
        kind: normalizedTab.target.kind,
        target: normalizedTab.target,
      },
    });
  }

  return {
    tabs: nextTabs,
    openTabIds,
  };
}

function getActiveTabId(input: {
  tabs: WorkspaceDerivedTab[];
  openTabIds: Set<string>;
  focusedTabId?: string | null;
  preferredTarget?: WorkspaceTabTarget | null;
}): string | null {
  const focusedTabId = trimNonEmpty(input.focusedTabId);
  const preferredTarget = normalizeWorkspaceTabTarget(input.preferredTarget ?? null);
  const preferredTabId = (() => {
    if (!preferredTarget) {
      return null;
    }
    const matchingTab =
      input.tabs.find((tab) => workspaceTabTargetsEqual(tab.descriptor.target, preferredTarget)) ??
      null;
    return matchingTab?.descriptor.tabId ?? buildDeterministicWorkspaceTabId(preferredTarget);
  })();

  if (preferredTabId && input.openTabIds.has(preferredTabId)) {
    return preferredTabId;
  }
  if (focusedTabId && input.openTabIds.has(focusedTabId)) {
    return focusedTabId;
  }
  return input.tabs[0]?.descriptor.tabId ?? null;
}

function getPane(input: {
  layout: WorkspaceLayout | null;
  pane?: SplitPane | null;
  paneId?: string | null;
}): SplitPane | null {
  if (input.pane) {
    return input.pane;
  }

  const layout = input.layout;
  if (!layout) {
    return null;
  }

  const resolvedPaneId = trimNonEmpty(input.paneId) ?? layout.focusedPaneId;
  if (!resolvedPaneId) {
    return null;
  }

  return findPaneById(layout.root, resolvedPaneId);
}

export function deriveWorkspacePaneState(input: {
  layout?: WorkspaceLayout | null;
  pane?: SplitPane | null;
  paneId?: string | null;
  tabs: WorkspaceTab[];
  focusedTabId?: string | null;
  preferredTarget?: WorkspaceTabTarget | null;
}): WorkspacePaneState {
  const pane = getPane({
    layout: input.layout ?? null,
    pane: input.pane ?? null,
    paneId: input.paneId,
  });
  const orderedTabs = orderPaneTabs({
    pane,
    tabs: input.tabs,
  });
  const normalizedTabs = normalizeWorkspacePaneTabs(orderedTabs);
  const focusedTabId = pane?.focusedTabId ?? trimNonEmpty(input.focusedTabId) ?? null;
  const activeTabId = getActiveTabId({
    tabs: normalizedTabs.tabs,
    openTabIds: normalizedTabs.openTabIds,
    focusedTabId,
    preferredTarget: input.preferredTarget,
  });

  return {
    pane,
    tabs: normalizedTabs.tabs,
    focusedTabId,
    activeTabId,
    activeTab: activeTabId
      ? (normalizedTabs.tabs.find((tab) => tab.descriptor.tabId === activeTabId) ?? null)
      : null,
  };
}

export function getWorkspacePaneDescriptors(input: {
  layout?: WorkspaceLayout | null;
  pane?: SplitPane | null;
  paneId?: string | null;
  tabs: WorkspaceTab[];
}): WorkspaceTabDescriptor[] {
  return deriveWorkspacePaneState(input).tabs.map((tab) => tab.descriptor);
}

export function resolveSideFileOpenPlacement(input: {
  layout?: WorkspaceLayout | null;
  sourcePaneId?: string | null;
  tabs: WorkspaceTab[];
  target: WorkspaceTabTarget;
}): WorkspaceSideFileOpenPlacement {
  const existingTab = input.tabs.find((tab) => workspaceTabTargetsEqual(tab.target, input.target));
  if (existingTab) {
    return { kind: "open-in-source" };
  }

  const layout = input.layout ?? null;
  const sourcePaneId = trimNonEmpty(input.sourcePaneId);
  if (!layout || !sourcePaneId) {
    return { kind: "open-in-source" };
  }

  const sidePaneId = findAdjacentPane(layout.root, sourcePaneId, "right");
  if (sidePaneId) {
    return { kind: "focus-side-pane", paneId: sidePaneId };
  }

  return { kind: "split-side-pane", paneId: sourcePaneId };
}
