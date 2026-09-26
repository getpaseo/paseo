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
export {
  defineSettings,
  settingsRpc,
  type DeepReadonly,
  type PluginSettingsDecision,
  type PluginSettingsErrorCode,
  type SettingsDefinition,
} from "./settings.js";
export {
  defineAttachmentSource,
  PluginAttachmentItemSchema,
  PluginAttachmentSearchPayloadSchema,
  type PluginAttachmentItem,
  type PluginAttachmentSearchPayload,
} from "./attachments.js";
export { defineRpc, type PluginRpcContract, type RpcInput, type RpcOutput } from "./rpc.js";
export {
  defineForgeClientProvider,
  defineForgeFacts,
  GITHUB_LINE_ANCHOR,
  GITLAB_LINE_ANCHOR,
  renderForgeLineAnchor,
  type PluginForgeClientProviderContribution,
  type PluginForgeClientView,
  type PluginForgeDefinition,
  type PluginForgeFactsRegistration,
  type PluginForgeFactsContribution,
  type PluginForgeLineAnchor,
  type PluginForgeMergeCapability,
  type PluginForgeMergeMethod,
  type PluginForgeReferencePath,
  type PluginForgeSetupSurface,
  type PluginForgeSignInCommand,
  type PluginForgeSpecificEnvelope,
  type PluginForgeSvgPathIcon,
  type PluginForgeUrlGrammar,
} from "./forge.js";
