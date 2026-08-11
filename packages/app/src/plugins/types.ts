import type { QueryClient } from "@tanstack/react-query";
import type {
  PluginAttachmentSourceContribution,
  PluginSidebarContribution,
  PluginSurfaceContribution,
} from "@paseo/plugin";

export interface EvaluatedPlugin {
  id: string;
  surfaces: PluginSurfaceContribution[];
  sidebarItems: PluginSidebarContribution[];
  attachmentSources: PluginAttachmentSourceContribution[];
}

export interface InstalledPlugin extends EvaluatedPlugin {
  serverId: string;
  clientBundle: string;
  queryClient: QueryClient;
}

export type {
  PluginAttachmentSourceContribution,
  PluginSidebarContribution,
  PluginSurfaceContribution,
};
