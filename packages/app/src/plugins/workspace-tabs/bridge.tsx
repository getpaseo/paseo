import type {
  AgentRef,
  PluginSubagent,
  PluginSubagentMenuProps,
  PluginTabMenuProps,
  PluginTabPresentation,
  PluginWorkspaceTab,
  PluginWorkspaceTabs,
  WorkspaceRef,
} from "@getpaseo/plugin/client";
import type { ComponentType, ReactNode } from "react";

/**
 * The plugin loader and `/client/ui` reach workspace tabs through this module. The host it
 * forwards to imports the panel registry and the workspace screen's tab hooks, which import the
 * plugin registry back; importing it here directly would put the loader in those cycles.
 */
export interface WorkspaceTabsHost {
  useWorkspaceTabs(workspace: WorkspaceRef): PluginWorkspaceTabs;
  useSubagents(agent: AgentRef, options?: { parentSubagentId?: string }): readonly PluginSubagent[];
  useSubagentPresentation(subagent: PluginSubagent): PluginTabPresentation;
  WorkspaceTabPresentation: ComponentType<{
    tab: PluginWorkspaceTab;
    children: (presentation: PluginTabPresentation) => ReactNode;
  }>;
  WorkspaceTabMenu: ComponentType<PluginTabMenuProps>;
  SubagentMenu: ComponentType<PluginSubagentMenuProps>;
}

let host: WorkspaceTabsHost | null = null;

export function registerWorkspaceTabsHost(next: WorkspaceTabsHost): void {
  host = next;
}

function requireHost(): WorkspaceTabsHost {
  if (!host) throw new Error("Workspace tabs are not available before the sidebar loads");
  return host;
}

export function useWorkspaceTabs(workspace: WorkspaceRef): PluginWorkspaceTabs {
  return requireHost().useWorkspaceTabs(workspace);
}

export function useSubagents(
  agent: AgentRef,
  options?: { parentSubagentId?: string },
): readonly PluginSubagent[] {
  return requireHost().useSubagents(agent, options);
}

export function useSubagentPresentation(subagent: PluginSubagent): PluginTabPresentation {
  return requireHost().useSubagentPresentation(subagent);
}

export function WorkspaceTabPresentation(props: {
  tab: PluginWorkspaceTab;
  children: (presentation: PluginTabPresentation) => ReactNode;
}) {
  const { WorkspaceTabPresentation: Presentation } = requireHost();
  return <Presentation {...props} />;
}

export function WorkspaceTabMenu(props: PluginTabMenuProps) {
  const { WorkspaceTabMenu: Menu } = requireHost();
  return <Menu {...props} />;
}

export function SubagentMenu(props: PluginSubagentMenuProps) {
  const { SubagentMenu: Menu } = requireHost();
  return <Menu {...props} />;
}
