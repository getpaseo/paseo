// Shared SDK entry. Keep runtime-specific imports and re-exports on /client or /server.
export type {
  PluginTheme,
  PluginWorkspaceSnapshot,
  PluginAgentSnapshot,
  PluginThemeColors,
  PluginThemeContribution,
  PluginAttachmentSourceContribution,
  PluginTimelineData,
  PluginTimelineItem,
  PluginTimelineTransformResult,
  PluginCleanup,
} from "./contracts.js";
export { defineSettings, settingsRpc, type SettingsDefinition } from "./settings.js";
export {
  defineAttachmentSource,
  PluginAttachmentItemSchema,
  PluginAttachmentSearchPayloadSchema,
  type PluginAttachmentItem,
  type PluginAttachmentSearchPayload,
} from "./attachments.js";
export { defineRpc, type PluginRpcContract, type RpcInput, type RpcOutput } from "./rpc.js";

export type { PluginText, PluginMessage } from "./text.js";
export {
  findSvgIconProblem,
  PLUGIN_SVG_ICON_MAX_BYTES,
  type PluginIconProps,
  type PluginSerializableIcon,
  type PluginSvgIcon,
} from "./icons.js";
