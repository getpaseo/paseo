import type { PluginSubagent, PluginWorkspaceTab } from "@getpaseo/plugin/client";
import { queryClient } from "@/data/query-client";
import {
  APP_SETTINGS_QUERY_KEY,
  DEFAULT_OPEN_IN_SIDE_PANE_PREFERENCES,
  type AppSettings,
} from "@/hooks/use-settings/storage";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { usePanelStore } from "@/stores/panel-store";
import { useSessionStore } from "@/stores/session-store";
import type { SubagentRow } from "@/subagents/select";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { buildWorkspaceTabPersistenceKey, type WorkspaceTabTarget } from "@/workspace-tabs/model";
import { revealWorkspaceTab } from "@/workspace-tabs/navigation";
import { openPreferredWorkspaceTarget } from "@/workspace-tabs/open-beside";
import { readSubagentRow } from "./model";

/**
 * Opens the workspace on this tab. The tab is revealed by id rather than passed as a navigation
 * target: a target re-resolves placement and can open a compact sheet beside the tab that is
 * already there, while the id names the very tab listed. Revealing after navigating also picks
 * the compact panel: the explorer for its own tabs, the workspace otherwise.
 */
export function openPluginWorkspaceTab(tab: PluginWorkspaceTab): void {
  const serverId = tab.workspace.hostId;
  const workspaceId = tab.workspace.id;
  navigateToWorkspace({ serverId, workspaceId });
  const layoutKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  if (layoutKey) revealWorkspaceTab(layoutKey, tab.id);
}

/**
 * Opens a subagent as its parent's subagents track does. A Paseo subagent on another host or in
 * its own workspace opens there. Otherwise it opens in the parent tab's workspace, at the
 * location the user prefers for subagents, beside the parent tab when one is given.
 */
export function openPluginSubagent(
  subagent: PluginSubagent,
  options: { parentTab?: PluginWorkspaceTab } = {},
): void {
  const source = readSubagentRow(subagent);
  if (!source) throw new Error("Unknown subagent: read it with useSubagents");
  const { row, hostId } = source;
  const parentTab = options.parentTab;
  if (row.kind === "paseo" && !sharesParentTabWorkspace(row.address, parentTab)) {
    navigateToAgent(row.address);
    return;
  }
  const serverId = parentTab?.workspace.hostId ?? hostId;
  const workspaceId =
    parentTab?.workspace.id ?? findParentWorkspaceId(hostId, subagent.parentAgent.id);
  const workspaceKey = workspaceId
    ? buildWorkspaceTabPersistenceKey({ serverId, workspaceId })
    : null;
  if (!workspaceId || !workspaceKey) return;
  navigateToWorkspace({ serverId, workspaceId });
  if (parentTab) revealWorkspaceTab(workspaceKey, parentTab.id);
  openPreferredWorkspaceTarget({
    workspaceKey,
    target: subagentTarget(row),
    source: "subagents",
    preferences: readOpenInSidePanePreferences(),
    parentTabId: parentTab?.id,
  });
  if (useWorkspaceLayoutStore.getState().layoutMode === "compact") {
    usePanelStore.getState().showMobileAgent();
  }
}

/** A Paseo subagent on another host, or with a workspace of its own, opens there instead. */
function sharesParentTabWorkspace(
  address: { serverId: string; agentId: string },
  parentTab: PluginWorkspaceTab | undefined,
): boolean {
  if (!parentTab || address.serverId !== parentTab.workspace.hostId) return false;
  const session = useSessionStore.getState().sessions[address.serverId];
  const agent = session?.agents.get(address.agentId) ?? session?.agentDetails.get(address.agentId);
  return !agent?.workspaceId || agent.workspaceId === parentTab.workspace.id;
}

function subagentTarget(row: SubagentRow): WorkspaceTabTarget {
  return row.kind === "paseo"
    ? { kind: "agent", agentId: row.id }
    : { kind: "provider_subagent", parentAgentId: row.parentAgentId, subagentId: row.id };
}

function findParentWorkspaceId(hostId: string, parentAgentId: string): string | null {
  const session = useSessionStore.getState().sessions[hostId];
  const parent = session?.agents.get(parentAgentId) ?? session?.agentDetails.get(parentAgentId);
  return parent?.workspaceId ?? null;
}

function readOpenInSidePanePreferences() {
  return (
    queryClient.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY)?.openInSidePane ??
    DEFAULT_OPEN_IN_SIDE_PANE_PREFERENCES
  );
}
