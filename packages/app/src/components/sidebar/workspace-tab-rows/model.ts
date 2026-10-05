/**
 * The third tier of the sidebar: the open tabs inside one workspace, as a folder under its row.
 *
 * Project -> Workspace rows already exist; this projects the tabs that hang under a workspace row
 * when the tier is switched on. It is the sidebar's mirror of the workspace tab strip, so it reads
 * the same layout the strip reads and must keep giving the same answer: a tab the strip shows and
 * this hides (or the reverse) reads as a bug.
 *
 * The layout is per client and only exists once a workspace has been opened here. A workspace
 * that has never been opened would otherwise show an empty folder while agents are running in
 * it, so its root agents are appended as rows the layout does not hold yet. They are exactly the
 * agents the strip auto-opens on first visit (`deriveWorkspaceAgentVisibility`), so the folder
 * does not change shape when the workspace is opened.
 *
 * Pure on purpose — no store reads, no React. The caller passes what it already subscribes to.
 */
import type { Agent } from "@/stores/session-store";
import {
  collectAllPanes,
  collectAllTabs,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-store";
import { getWorkspacePaneDescriptors } from "@/screens/workspace/workspace-pane-state";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import type { WorkspaceTab } from "@/workspace-tabs/model";
import { isWorkspaceRootAgent } from "@/subagents/policies";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";

export interface SidebarTabRow {
  /** Stable row key. Tab ids are unique per workspace, not across them. */
  key: string;
  descriptor: WorkspaceTabDescriptor;
  /** False for an agent the layout does not hold yet: pressing it opens a tab rather than focusing one. */
  inLayout: boolean;
}

export interface SidebarWorkspaceTabs {
  rows: SidebarTabRow[];
  /** The tab the strip would show as active. Null when the layout has none of the listed rows. */
  activeTabId: string | null;
}

export interface SelectWorkspaceTabRowsInput {
  layout: WorkspaceLayout | null | undefined;
  /** The Explorer's pane holds views of the workspace (files, changes), not tabs of it. */
  explorerSidebarPaneId: string | null;
  /** Agents the user closed the tab on. The strip keeps them closed, so this does too. */
  hiddenAgentIds: ReadonlySet<string> | null | undefined;
  agents: Iterable<Agent>;
  serverId: string;
  workspaceId: string | null | undefined;
}

export const EMPTY_WORKSPACE_TABS: SidebarWorkspaceTabs = { rows: [], activeTabId: null };

/** Prefix for rows standing in for an agent tab that does not exist yet, so they never collide. */
const PENDING_AGENT_TAB_PREFIX = "sidebar-pending-agent:";

export function selectWorkspaceTabRows(input: SelectWorkspaceTabRowsInput): SidebarWorkspaceTabs {
  const workspaceId = normalizeWorkspaceOpaqueId(input.workspaceId);
  if (!workspaceId) {
    return EMPTY_WORKSPACE_TABS;
  }
  const rowKeyPrefix = `${input.serverId}:${workspaceId}:`;

  const rows: SidebarTabRow[] = [];
  const agentIdsInLayout = new Set<string>();
  let activeTabId: string | null = null;

  if (input.layout) {
    const tabsById = new Map<string, WorkspaceTab>();
    for (const tab of collectAllTabs(input.layout.root)) {
      tabsById.set(tab.tabId, tab);
    }
    // Pane by pane, in the strip's own order, so a split workspace lists left pane then right.
    for (const pane of collectAllPanes(input.layout.root)) {
      if (pane.id === input.explorerSidebarPaneId) {
        continue;
      }
      const paneTabs = pane.tabIds.flatMap((tabId) => {
        const tab = tabsById.get(tabId);
        return tab ? [tab] : [];
      });
      for (const descriptor of getWorkspacePaneDescriptors({ pane, tabs: paneTabs })) {
        // The blank launcher tab is a place to start something, not something that is open.
        if (descriptor.kind === "new_tab") {
          continue;
        }
        if (descriptor.target.kind === "agent") {
          agentIdsInLayout.add(descriptor.target.agentId);
        }
        rows.push({ key: rowKeyPrefix + descriptor.tabId, descriptor, inLayout: true });
      }
      if (pane.id === input.layout.focusedPaneId && pane.focusedTabId) {
        activeTabId = pane.focusedTabId;
      }
    }
  }

  for (const agent of selectPendingRootAgents({
    agents: input.agents,
    serverId: input.serverId,
    workspaceId,
    exclude: agentIdsInLayout,
    hiddenAgentIds: input.hiddenAgentIds,
  })) {
    const tabId = PENDING_AGENT_TAB_PREFIX + agent.id;
    rows.push({
      key: rowKeyPrefix + tabId,
      descriptor: {
        key: tabId,
        tabId,
        kind: "agent",
        target: { kind: "agent", agentId: agent.id },
      },
      inLayout: false,
    });
  }

  if (activeTabId && !rows.some((row) => row.descriptor.tabId === activeTabId)) {
    activeTabId = null;
  }
  return rows.length === 0 ? EMPTY_WORKSPACE_TABS : { rows, activeTabId };
}

/**
 * Root agents of the workspace with no tab in the layout, oldest first — the order the strip
 * lays them out in when it opens them.
 */
function selectPendingRootAgents(input: {
  agents: Iterable<Agent>;
  serverId: string;
  workspaceId: string;
  exclude: ReadonlySet<string>;
  hiddenAgentIds: ReadonlySet<string> | null | undefined;
}): Agent[] {
  const agentsById = new Map<string, Agent>();
  for (const agent of input.agents) {
    agentsById.set(agent.id, agent);
  }

  const pending: Agent[] = [];
  for (const agent of agentsById.values()) {
    if (agent.serverId !== input.serverId || agent.archivedAt) {
      continue;
    }
    if (normalizeWorkspaceOpaqueId(agent.workspaceId) !== input.workspaceId) {
      continue;
    }
    if (input.exclude.has(agent.id) || input.hiddenAgentIds?.has(agent.id)) {
      continue;
    }
    // Subagents belong to their parent's pane, not to the workspace. The strip makes the same
    // cut, so including them here would put rows in the sidebar with no tab to open.
    const parentAgent = agent.parentAgentId ? agentsById.get(agent.parentAgentId) : undefined;
    if (!isWorkspaceRootAgent(agent, parentAgent)) {
      continue;
    }
    pending.push(agent);
  }

  // Agent id breaks ties so two agents created in the same millisecond keep a stable order.
  pending.sort(
    (left, right) =>
      left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id),
  );
  return pending;
}
