import type { QueryClient } from "@tanstack/react-query";
import type {
  PluginAttachmentSourceContribution,
  PluginCommandCenterItemContribution,
  PluginClientContribution,
  PluginCleanup,
  PluginComposerPillContribution,
  PluginSidebarContribution,
  PluginSurfaceContribution,
  PluginThemeContribution,
  PluginTimelineRendererContribution,
  PluginTimelineTransformerContribution,
  PluginPanelLocation,
  PluginWorkspacePanelContribution,
} from "@getpaseo/plugin";

export type EvaluatedPluginWorkspacePanelContribution = PluginWorkspacePanelContribution & {
  locations: readonly PluginPanelLocation[];
};

export interface EvaluatedPlugin {
  id: string;
  cleanup: PluginCleanup;
  surfaces: PluginSurfaceContribution[];
  sidebarItems: PluginSidebarContribution[];
  workspacePanels: EvaluatedPluginWorkspacePanelContribution[];
  commandCenterItems: PluginCommandCenterItemContribution[];
  clientSide: PluginClientContribution | null;
  attachmentSources: PluginAttachmentSourceContribution[];
  themes: PluginThemeContribution[];
  timelineTransformers: PluginTimelineTransformerContribution[];
  timelineRenderers: PluginTimelineRendererContribution[];
}

export interface InstalledPlugin extends EvaluatedPlugin {
  serverId: string;
  clientBundle: string;
  queryClient: QueryClient;
}

export type {
  PluginAttachmentSourceContribution,
  PluginCommandCenterItemContribution,
  PluginComposerPillContribution,
  PluginSidebarContribution,
  PluginSurfaceContribution,
  PluginThemeContribution,
  PluginTimelineRendererContribution,
  PluginTimelineTransformerContribution,
  PluginWorkspacePanelContribution,
};
