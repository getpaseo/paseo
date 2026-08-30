import type { ComponentType } from "react";
import type { PluginIconProps } from "./contracts.js";

export {
  PluginAttachmentItemSchema,
  PluginAttachmentSearchPayloadSchema,
  defineAttachmentSource,
  defineRpc,
  type PluginAttachmentItem,
  type PluginAttachmentSearchPayload,
  type PluginRpcContract,
} from "./server.js";

export declare const Icon: ComponentType<PluginIconProps>;
export type {
  PluginAttachmentSourceContribution,
  PluginAgentCommandContext,
  PluginAgentPanelProps,
  PluginAgentSnapshot,
  PluginCleanup,
  PluginCommandCapabilities,
  PluginCommandCenterItemContribution,
  PluginClientContext,
  PluginClientContribution,
  PluginClientOpenPanelOptions,
  PluginComposerPillContribution,
  PluginComposerPillProps,
  PluginContribution,
  PluginContext,
  PluginGlobalCommandContext,
  PluginHandlerContext,
  PluginHostProps,
  PluginOpenPanelOptions,
  PluginIconProps,
  PluginPanelLocation,
  PluginTheme,
  PluginSidebarContribution,
  PluginSurfaceContribution,
  PluginSurfaceProps,
  PluginThemeColors,
  PluginThemeContribution,
  PluginTimelineData,
  PluginTimelineItem,
  PluginTimelineItemProps,
  PluginTimelineRendererContribution,
  PluginTimelineTransformerContribution,
  PluginTimelineTransformResult,
  PluginWorkspaceCommandContext,
  PluginWorkspacePanelContribution,
  PluginWorkspacePanelProps,
  PluginWorkspaceSnapshot,
} from "./contracts.js";
export { usePaseo } from "./paseo-context.js";
export { useAgent, useWorkspace } from "./client-state.js";
export { useRpc } from "./rpc-context.js";
