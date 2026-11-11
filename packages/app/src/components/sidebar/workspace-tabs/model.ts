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
 * A row only offers its tabs when there is a choice to make: with one tab, opening the
 * workspace already lands on it, unless that tab is an agent with subagents to list under it.
 */
export function hasSidebarWorkspaceTabsDisclosure(
  tabCount: number,
  soleTabHasSubagents = false,
): boolean {
  return tabCount > 1 || (tabCount === 1 && soleTabHasSubagents);
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
 * The tabs listed under another agent tab's subagents, which the top level leaves out. Only a
 * child its parent's list actually shows is nested, so a tab whose row the list hides (an archived
 * or hidden child) stays reachable at the top level. A tab never nests under itself.
 */
export function selectNestedSubagentTabIds(
  tabs: readonly WorkspaceTabDescriptor[],
  subagentsOf: (agentId: string) => readonly SubagentRow[],
): string[] {
  const nested: string[] = [];
  const parents = tabs.flatMap((tab) =>
    tab.target.kind === "agent"
      ? [{ tabId: tab.tabId, rows: subagentsOf(tab.target.agentId) }]
      : [],
  );
  for (const tab of tabs) {
    const isChild = parents.some(
      (parent) =>
        parent.tabId !== tab.tabId && parent.rows.some((row) => isSubagentTarget(tab.target, row)),
    );
    if (isChild) nested.push(tab.tabId);
  }
  return nested;
}
