export {
  PluginAttachmentItemSchema,
  PluginAttachmentSearchPayloadSchema,
  type PluginAttachmentItem,
  type PluginAttachmentSearchPayload,
} from "./attachments.js";
export type {
  PluginAttachmentSourceContribution,
  PluginAgentCommandContext,
  PluginAgentPanelProps,
  PluginAgentSnapshot,
  PluginCleanup,
  PluginCommandCapabilities,
  PluginCommandCenterItemContribution,
  PluginContribution,
  PluginContext,
  PluginGlobalCommandContext,
  PluginHandlerContext,
  PluginHostProps,
  PluginSidebarContribution,
  PluginSurfaceContribution,
  PluginSurfaceProps,
  PluginWorkspaceCommandContext,
  PluginWorkspacePanelContribution,
  PluginWorkspacePanelProps,
  PluginWorkspaceSnapshot,
} from "./contracts.js";
export { usePaseo } from "./paseo-context.js";
export { useAgent, useWorkspace } from "./client-state.js";
import type { PluginAttachmentSourceContribution } from "./contracts.js";
export { useRpc } from "./rpc-context.js";
export { defineRpc, type PluginRpcContract } from "./rpc.js";

export function defineAttachmentSource<Definition extends PluginAttachmentSourceContribution>(
  definition: Definition,
): Definition {
  return definition;
}
