import type { QueryClient } from "@tanstack/react-query";
import type {
  PluginAttachmentSourceContribution,
  PluginCommandCenterItemContribution,
  PluginSidebarContribution,
  PluginSurfaceContribution,
  PluginWorkspacePanelContribution,
} from "@paseo/plugin";

export interface EvaluatedPlugin {
  id: string;
  cleanup: () => void;
  surfaces: PluginSurfaceContribution[];
  sidebarItems: PluginSidebarContribution[];
  workspacePanels: PluginWorkspacePanelContribution[];
  commandCenterItems: PluginCommandCenterItemContribution[];
  attachmentSources: PluginAttachmentSourceContribution[];
}

export interface InstalledPlugin extends EvaluatedPlugin {
  serverId: string;
  clientBundle: string;
  queryClient: QueryClient;
}

export type {
  PluginAttachmentSourceContribution,
  PluginCommandCenterItemContribution,
  PluginSidebarContribution,
  PluginSurfaceContribution,
  PluginWorkspacePanelContribution,
};
