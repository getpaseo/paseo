import { PluginAttachmentSearchPayloadSchema } from "./attachments.js";
export { PluginClientStateProvider, type PluginClientStateSource } from "./client-state.js";
import type {
  PluginAttachmentSourceContribution,
  PluginCommandCenterItemContribution,
  PluginContext,
  PluginSidebarContribution,
  PluginSurfaceContribution,
  PluginSurfaceProps,
  PluginThemeContribution,
  PluginTimelineRendererContribution,
  PluginTimelineTransformerContribution,
  PluginWorkspacePanelContribution,
} from "./contracts.js";
import { PluginRpcProvider } from "./rpc-context.js";
import { PaseoApiProvider } from "./paseo-context.js";
import { callPluginRpc } from "./rpc.js";
import type { ComponentType } from "react";

interface PluginCollector {
  addSurface(id: string, Component: ComponentType<PluginSurfaceProps>): void;
  addSidebarItem(contribution: PluginSidebarContribution): void;
  addWorkspacePanel(contribution: PluginWorkspacePanelContribution): void;
  addCommandCenterItem(contribution: PluginCommandCenterItemContribution): void;
  addAttachmentSource(contribution: PluginAttachmentSourceContribution): void;
  addTheme(contribution: PluginThemeContribution): void;
  addTimelineTransformer(contribution: PluginTimelineTransformerContribution): void;
  addTimelineRenderer(contribution: PluginTimelineRendererContribution): void;
}

export interface PluginRegistrationCollector {
  surfaces: PluginSurfaceContribution[];
  sidebarItems: PluginSidebarContribution[];
  workspacePanels: PluginWorkspacePanelContribution[];
  commandCenterItems: PluginCommandCenterItemContribution[];
  attachmentSources: PluginAttachmentSourceContribution[];
  themes: PluginThemeContribution[];
  timelineTransformers: PluginTimelineTransformerContribution[];
  timelineRenderers: PluginTimelineRendererContribution[];
}

export function createPluginContext(
  collector: PluginCollector,
): Pick<
  PluginContext,
  | "addSurface"
  | "addSidebarItem"
  | "addWorkspacePanel"
  | "addCommandCenterItem"
  | "addAttachmentSource"
  | "addTheme"
  | "addTimelineTransformer"
  | "addTimelineRenderer"
> {
  return {
    addSurface(id, Component) {
      collector.addSurface(id, Component);
    },
    addSidebarItem(contribution) {
      collector.addSidebarItem(contribution);
    },
    addWorkspacePanel(contribution) {
      collector.addWorkspacePanel(contribution);
    },
    addCommandCenterItem(contribution) {
      collector.addCommandCenterItem(contribution);
    },
    addAttachmentSource(contribution) {
      collector.addAttachmentSource(contribution);
    },
    addTheme(contribution) {
      collector.addTheme(contribution);
    },
    addTimelineTransformer(contribution) {
      collector.addTimelineTransformer(contribution);
    },
    addTimelineRenderer(contribution) {
      collector.addTimelineRenderer(contribution);
    },
  };
}

export async function searchPluginAttachments(
  source: PluginAttachmentSourceContribution,
  invoke: (method: string, input: unknown) => Promise<unknown>,
  query: string,
) {
  const output = await callPluginRpc(source.search, invoke, { query });
  return PluginAttachmentSearchPayloadSchema.parseAsync(output);
}

export { callPluginRpc, PaseoApiProvider, PluginRpcProvider };
