import { collectAllPanes, collectAllTabs } from "@/stores/workspace-layout-actions";
import type { WorkspaceLayout } from "@/stores/workspace-layout-store";
import { getWorkspacePaneDescriptors } from "@/screens/workspace/workspace-pane-state";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import type { SubagentRow } from "@/subagents/select";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

export interface SidebarWorkspaceTabs {
  tabs: WorkspaceTabDescriptor[];
  /** The tab the workspace shows when it is opened: the focused pane's focused tab. */
  activeTabId: string | null;
}

export interface SelectSidebarWorkspaceTabsInput {
  layout: WorkspaceLayout | null;
  /**
   * The explorer is chrome beside the tab strip, not part of it, and on desktop it always holds
   * Files and Changes, so listing it would put the same two rows under every workspace.
   */
  explorerPaneId: string | null;
}

const NO_TABS: SidebarWorkspaceTabs = { tabs: [], activeTabId: null };

/** A workspace's open tabs, pane by pane in strip order, for the sidebar's tab list. */
export function selectSidebarWorkspaceTabs({
  layout,
  explorerPaneId,
}: SelectSidebarWorkspaceTabsInput): SidebarWorkspaceTabs {
  if (!layout) return NO_TABS;
  const allTabs = collectAllTabs(layout.root);
  const panes = collectAllPanes(layout.root).filter((pane) => pane.id !== explorerPaneId);
  const seenTabIds = new Set<string>();
  const tabs: WorkspaceTabDescriptor[] = [];
  for (const pane of panes) {
    for (const tab of getWorkspacePaneDescriptors({ pane, tabs: allTabs })) {
      if (seenTabIds.has(tab.tabId)) continue;
      seenTabIds.add(tab.tabId);
      tabs.push(tab);
    }
  }
  if (tabs.length === 0) return NO_TABS;
  const focusedPane = panes.find((pane) => pane.id === layout.focusedPaneId);
  const focusedTabId = focusedPane?.focusedTabId ?? null;
  const activeTabId = focusedTabId && seenTabIds.has(focusedTabId) ? focusedTabId : null;
  return { tabs, activeTabId };
}

/** What a collapsed workspace row needs to decide on its disclosure. */
export interface SidebarWorkspaceTabsSummary {
  tabCount: number;
  /** The agent of the workspace's only tab, whose subagents still earn the disclosure. */
  soleAgentId: string | null;
  /** Agent tabs in pane order. The disclosure's notice is the union of their subagents. */
  agentIds: readonly string[];
}

export const EMPTY_SIDEBAR_WORKSPACE_TABS_SUMMARY: SidebarWorkspaceTabsSummary = {
  tabCount: 0,
  soleAgentId: null,
  agentIds: [],
};

export function summarizeSidebarWorkspaceTabs({
  tabs,
}: SidebarWorkspaceTabs): SidebarWorkspaceTabsSummary {
  const sole = tabs.length === 1 ? tabs[0] : undefined;
  const agentIds: string[] = [];
  for (const tab of tabs) {
    if (tab.target.kind === "agent") agentIds.push(tab.target.agentId);
  }
  return {
    tabCount: tabs.length,
    soleAgentId: sole?.target.kind === "agent" ? sole.target.agentId : null,
    agentIds,
  };
}

export function sidebarWorkspaceTabsSummariesEqual(
  left: SidebarWorkspaceTabsSummary,
  right: SidebarWorkspaceTabsSummary,
): boolean {
  return (
    left.tabCount === right.tabCount &&
    left.soleAgentId === right.soleAgentId &&
    sameAgentIds(left.agentIds, right.agentIds)
  );
}

function sameAgentIds(left: readonly string[], right: readonly string[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * What a workspace row's disclosure opens. A row offers its tabs only when there is more than
 * one: opening the workspace already lands on a single tab. When that tab is an agent with
 * subagents, the disclosure counts the subagents. The list still shows the tab, so its menu
 * stays reachable, and lists those subagents under it.
 */
export type SidebarWorkspaceTabsDisclosure =
  | { kind: "none" }
  | { kind: "tabs"; count: number }
  | { kind: "subagents"; count: number };

const NO_DISCLOSURE: SidebarWorkspaceTabsDisclosure = { kind: "none" };

export function resolveSidebarWorkspaceTabsDisclosure(input: {
  tabCount: number;
  /** Subagents of the workspace's only tab, when that tab is an agent; otherwise 0. */
  soleTabSubagentCount: number;
}): SidebarWorkspaceTabsDisclosure {
  if (input.tabCount > 1) return { kind: "tabs", count: input.tabCount };
  if (input.tabCount === 1 && input.soleTabSubagentCount > 0) {
    return { kind: "subagents", count: input.soleTabSubagentCount };
  }
  return NO_DISCLOSURE;
}

/** Adds the key if absent and removes it if present, returning a new set. */
export function toggleExpandedKey(expanded: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(expanded);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** Keys one tab's subagent list within its workspace. */
export function buildSidebarTabSubagentsKey(workspaceKey: string, tabId: string): string {
  return `${workspaceKey}\0${tabId}`;
}

/** Whether a tab target is the tab a subagent row opens. */
export function isSubagentTarget(target: WorkspaceTabTarget | null, row: SubagentRow): boolean {
  if (!target) return false;
  if (row.kind === "paseo") return target.kind === "agent" && target.agentId === row.id;
  return (
    target.kind === "provider_subagent" &&
    target.parentAgentId === row.parentAgentId &&
    target.subagentId === row.id
  );
}

/**
 * The tabs listed under another agent tab's subagents, which the top level leaves out. A tab
 * nests only under a parent tab that itself stays at the top level, so a grandchild whose parent
 * tab is nested stays reachable and can list its own children. Only a child its parent's list
 * actually shows is nested, so a tab whose row the list hides (an archived or hidden child)
 * stays at the top level. A tab never nests under itself.
 */
export function selectNestedSubagentTabIds(
  tabs: readonly WorkspaceTabDescriptor[],
  subagentsOf: (agentId: string) => readonly SubagentRow[],
): string[] {
  const parentTabIdsByTabId = collectParentTabIds(tabs, subagentsOf);
  const placement = new Map<string, "top" | "nested">();
  const pending = new Set(tabs.map((tab) => tab.tabId));
  let moved = true;
  while (moved && pending.size > 0) {
    moved = false;
    for (const tabId of pending) {
      const decision = decideTabNesting(parentTabIdsByTabId.get(tabId), placement, pending);
      if (!decision) continue;
      placement.set(tabId, decision);
      pending.delete(tabId);
      moved = true;
    }
  }
  const nested: string[] = [];
  for (const tab of tabs) {
    if (placement.get(tab.tabId) === "nested") nested.push(tab.tabId);
  }
  return nested;
}

/**
 * Where a nested subagent's tab can be closed. The listing workspace wins when it holds the
 * tab; otherwise the subagent's own workspace. Null means neither layout has it, so the menu
 * has no Close.
 */
export function selectHoldingWorkspaceId(
  listingWorkspaceId: string,
  ownWorkspaceId: string | null,
  holdsTab: (workspaceId: string) => boolean,
): string | null {
  if (holdsTab(listingWorkspaceId)) return listingWorkspaceId;
  if (ownWorkspaceId && ownWorkspaceId !== listingWorkspaceId && holdsTab(ownWorkspaceId)) {
    return ownWorkspaceId;
  }
  return null;
}

function collectParentTabIds(
  tabs: readonly WorkspaceTabDescriptor[],
  subagentsOf: (agentId: string) => readonly SubagentRow[],
): Map<string, string[]> {
  const parentTabIdsByTabId = new Map<string, string[]>();
  for (const tab of tabs) {
    if (tab.target.kind !== "agent") continue;
    const rows = subagentsOf(tab.target.agentId);
    if (rows.length === 0) continue;
    for (const other of tabs) {
      if (other.tabId === tab.tabId) continue;
      if (!rows.some((row) => isSubagentTarget(other.target, row))) continue;
      const parents = parentTabIdsByTabId.get(other.tabId);
      if (parents) parents.push(tab.tabId);
      else parentTabIdsByTabId.set(other.tabId, [tab.tabId]);
    }
  }
  return parentTabIdsByTabId;
}

/** Null while a parent tab later in the list is still unresolved. A cycle never resolves. */
function decideTabNesting(
  parentTabIds: readonly string[] | undefined,
  placement: ReadonlyMap<string, "top" | "nested">,
  pending: ReadonlySet<string>,
): "top" | "nested" | null {
  if (!parentTabIds || parentTabIds.length === 0) return "top";
  let waiting = false;
  for (const parentTabId of parentTabIds) {
    const parentPlacement = placement.get(parentTabId);
    if (parentPlacement === "top") return "nested";
    if (parentPlacement === undefined && pending.has(parentTabId)) waiting = true;
  }
  return waiting ? null : "top";
}
