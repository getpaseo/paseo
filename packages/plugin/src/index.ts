import type { SettingsDefinition, SettingsState } from "./settings.js";
import type { ZodType } from "zod";
export { defineSettings, type SettingsDefinition, type SettingsState } from "./settings.js";
export declare function useSettings<Schema extends ZodType>(
  definition: SettingsDefinition<Schema>,
): SettingsState<Schema>;

import type { ComponentType } from "react";
import type { PluginAttachmentSourceContribution, PluginIconProps } from "./contracts.js";

export {
  PluginAttachmentItemSchema,
  PluginAttachmentSearchPayloadSchema,
  type PluginAttachmentItem,
  type PluginAttachmentSearchPayload,
} from "./attachments.js";
export { defineRpc, type PluginRpcContract, type RpcInput, type RpcOutput } from "./rpc.js";

export function defineAttachmentSource<Definition extends PluginAttachmentSourceContribution>(
  definition: Definition,
): Definition {
  return definition;
}

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
  PluginClientSlashCommandContribution,
  PluginClientOpenPanelOptions,
  PluginComposerPillContribution,
  PluginComposerPillProps,
  PluginServerContribution,
  PluginServerContext,
  PluginGlobalCommandContext,
  PluginHandlerContext,
  PluginHostProps,
  PluginOpenPanelOptions,
  PluginIconProps,
  PluginPanelLocation,
  PluginTheme,
  PluginSidebarContribution,
  PluginSurfaceContribution,
  PluginSettingsScreenContribution,
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

export type {
  PluginBeforeRequests,
  PluginHookAgent,
  PluginHookContext,
  PluginHookWorkspace,
  PluginLifecycleEvents,
  PluginLifecycleRegistration,
  PluginSessionOpenRequest,
  PluginTurnOutcome,
} from "./lifecycle.js";
