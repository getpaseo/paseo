import type { PluginAttachmentSourceContribution, PluginToolContribution } from "./contracts.js";

export {
  PluginAttachmentItemSchema,
  PluginAttachmentSearchPayloadSchema,
  type PluginAttachmentItem,
  type PluginAttachmentSearchPayload,
} from "./attachments.js";
export type {
  PluginAttachmentSourceContribution,
  PluginHandlerContext,
  PluginToolContribution,
  PluginToolContext,
  PluginToolHandlerContext,
} from "./contracts.js";
export { defineRpc, type PluginRpcContract } from "./rpc.js";

export function defineTool<
  InputSchema extends import("zod").ZodType,
  OutputSchema extends import("zod").ZodType | undefined = undefined,
>(
  definition: PluginToolContribution<InputSchema, OutputSchema>,
): PluginToolContribution<InputSchema, OutputSchema> {
  return definition;
}

export function defineAttachmentSource<Definition extends PluginAttachmentSourceContribution>(
  definition: Definition,
): Definition {
  return definition;
}
