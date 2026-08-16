export {
  PluginAttachmentItemSchema,
  PluginAttachmentSearchPayloadSchema,
  type PluginAttachmentItem,
  type PluginAttachmentSearchPayload,
} from "./attachments.js";
export type {
  PluginAttachmentSourceContribution,
  PluginCleanup,
  PluginContribution,
  PluginContext,
  PluginHandlerContext,
  PluginSidebarContribution,
  PluginSurfaceContribution,
  PluginSurfaceProps,
} from "./contracts.js";
export { usePaseo } from "./paseo-context.js";
import type { PluginAttachmentSourceContribution } from "./contracts.js";
export { useRpc } from "./rpc-context.js";
export { defineRpc, type PluginRpcContract } from "./rpc.js";

export function defineAttachmentSource<Definition extends PluginAttachmentSourceContribution>(
  definition: Definition,
): Definition {
  return definition;
}
