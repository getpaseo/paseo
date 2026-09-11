import { UnistylesRuntime } from "react-native-unistyles";
import type { PluginClientStateSource } from "@getpaseo/plugin/client/host";
import { supportsDesktopPaneSplits } from "@/constants/layout";
import {
  collectAllPanes,
  DEFAULT_PANE_ID,
  resolveExplorerSidebarPaneId,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import type { PluginWorkspaceTabTarget, WorkspaceTabTarget } from "@/workspace-tabs/model";
import type { InstalledPlugin } from "../types";

type AgentTabTarget = Extract<WorkspaceTabTarget, { kind: "agent" }>;
type WorkspacePanelTarget = Extract<PluginWorkspaceTabTarget, { context: "workspace" }>;

/** Validates a panel-with-agent request against the installation and the host's cached state. */
export function resolvePanelWithAgent(input: {
  plugin: InstalledPlugin;
  state: PluginClientStateSource;
  panelId: string;
  workspaceId: string;
  agentId: string;
}): { workspaceId: string; panel: WorkspacePanelTarget; agent: AgentTabTarget } {
  const panelId = input.panelId.trim();
  const panel = input.plugin.workspacePanels.find((candidate) => candidate.id === panelId);
  if (!panel || panel.context !== "workspace" || !panel.locations.includes("workspace")) {
    throw new Error(`Workspace panel is unavailable: ${panelId}`);
  }
  const workspace = input.state.getWorkspace(input.workspaceId.trim());
  const agent = input.state.getAgent(input.agentId.trim());
  if (!workspace || !agent || agent.workspaceId !== workspace.id) {
    throw new Error("Agent is unavailable in this workspace");
  }
  return {
    workspaceId: workspace.id,
    panel: { kind: "plugin", pluginId: input.plugin.id, panelId, context: "workspace" },
    agent: { kind: "agent", agentId: agent.id },
  };
}

/** Side panes need desktop pane splits and a wide layout; elsewhere only the chat opens. */
export function canOpenPanelBesideAgent(): boolean {
  const breakpoint = UnistylesRuntime.breakpoint;
  return supportsDesktopPaneSplits() && breakpoint !== "xs" && breakpoint !== "sm";
}

function resolveMainPaneId(workspaceKey: string): string | null {
  const state = useWorkspaceLayoutStore.getState();
  const layout = state.layoutByWorkspace[workspaceKey];
  if (!layout) return null;
  const explorerPaneId = resolveExplorerSidebarPaneId(
    layout,
    state.explorerSidebarPaneIdByWorkspace[workspaceKey],
  );
  const sidePaneId = state.sidePaneIdByWorkspace[workspaceKey] ?? null;
  const candidates = collectAllPanes(layout.root).filter(
    (pane) => pane.hidden !== true && pane.id !== explorerPaneId && pane.id !== sidePaneId,
  );
  return (candidates.find((pane) => pane.id === DEFAULT_PANE_ID) ?? candidates[0])?.id ?? null;
}

/**
 * Moves the panel into the main pane, then the agent tab into the side pane on its right. The panel
 * moves first because taking the last tab out of the side pane removes that pane. Existing tabs move
 * rather than duplicate, so the chat keeps its tab and agent-keyed draft. Returns the agent's pane.
 */
export function arrangePanelWithAgent(input: {
  workspaceKey: string;
  panel: WorkspacePanelTarget;
  agent: AgentTabTarget;
}): string | null {
  const store = useWorkspaceLayoutStore.getState();
  const mainPaneId = resolveMainPaneId(input.workspaceKey);
  const panelTabId = store.openTab({
    workspaceKey: input.workspaceKey,
    target: input.panel,
    intent: "reveal",
    placement: mainPaneId ? { mode: "pane", paneId: mainPaneId } : undefined,
  });
  const sidePaneId = useWorkspaceLayoutStore.getState().ensureSidePane(input.workspaceKey);
  const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[input.workspaceKey];
  const panelPaneId = layout
    ? collectAllPanes(layout.root).find((pane) => pane.focusedTabId === panelTabId)?.id
    : undefined;
  const agentPaneId = sidePaneId && sidePaneId !== panelPaneId ? sidePaneId : null;
  useWorkspaceLayoutStore.getState().openTab({
    workspaceKey: input.workspaceKey,
    target: input.agent,
    intent: "reveal",
    placement: agentPaneId ? { mode: "pane", paneId: agentPaneId } : undefined,
  });
  return agentPaneId;
}
