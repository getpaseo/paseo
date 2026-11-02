import type { PluginText } from "../text.js";
import { PluginAttachmentSearchPayloadSchema } from "../attachments.js";
export { PluginClientStateProvider, type PluginClientStateSource } from "./client-state.js";
export {
  usePluginRuntimeContextBridge,
  type PluginRuntimeContextBridge,
} from "./runtime-context-bridge.js";
import type { PluginAttachmentSourceContribution } from "../contracts.js";
import { PluginRpcProvider } from "./rpc-context.js";
import { PaseoApiProvider } from "./paseo-context.js";
import { callPluginRpc } from "../rpc.js";

export async function searchPluginAttachments(
  source: PluginAttachmentSourceContribution<PluginText>,
  invoke: (method: string, input: unknown) => Promise<unknown>,
  query: string,
) {
  const output = await callPluginRpc(source.search, invoke, { query });
  return PluginAttachmentSearchPayloadSchema.parseAsync(output);
}

export { callPluginRpc, PaseoApiProvider, PluginRpcProvider };

export {
  PluginTranslationRuntime,
  PluginTranslationProvider,
  usePluginTranslationRuntime,
  requirePluginText,
  isPluginMessage,
} from "./translations.js";
export type { PluginLocaleSource } from "./translations.js";
