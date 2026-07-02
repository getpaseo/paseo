// CLI exports for @getpaseo/server
export { createPaseoDaemon, type PaseoDaemon, type PaseoDaemonConfig } from "./bootstrap.js";
export { loadConfig, type CliConfigOverrides } from "./config.js";
export { resolvePaseoHome } from "./paseo-home.js";
export { getOrCreateServerId } from "./server-id.js";
export { createRootLogger, type LogLevel, type LogFormat } from "./logger.js";
export {
  loadPersistedConfig,
  savePersistedConfig,
  type PersistedConfig,
} from "./persisted-config.js";
export { hashDaemonPassword, isBearerTokenValid } from "./auth.js";
export { generateLocalPairingOffer, type LocalPairingOffer } from "./pairing-offer.js";
export {
  ConnectionOfferSchema,
  decodeOfferFragmentPayload,
  parseConnectionOfferFromUrl,
  type ConnectionOffer,
} from "@getpaseo/protocol/connection-offer";
export { buildRelayWebSocketUrl } from "@getpaseo/protocol/daemon-endpoints";
export {
  buildDaemonWebSocketUrl,
  deriveLabelFromEndpoint,
  normalizeHostPort,
  parseConnectionUri,
  shouldUseTlsForDefaultHostedRelay,
} from "@getpaseo/protocol/daemon-endpoints";
export { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
export {
  DirectTcpHostConnectionSchema,
  type DirectTcpHostConnection,
  type NormalizedDirectTcpHostConnection,
} from "@getpaseo/protocol/host-connection-schema";
export {
  ensureLocalSpeechModels,
  listLocalSpeechModels,
  type LocalSpeechModelId,
  type LocalSttModelId,
  type LocalTtsModelId,
} from "./speech/providers/local/models.js";
export {
  applySherpaLoaderEnv,
  resolveSherpaLoaderEnv,
  sherpaLoaderEnvKey,
  sherpaPlatformArch,
  sherpaPlatformPackageName,
  type SherpaLoaderEnvKey,
  type SherpaLoaderEnvResolution,
} from "./speech/providers/local/sherpa/sherpa-runtime-env.js";

// Paseo Agent OAuth login + Paseo-owned credential store
export {
  loginOAuthBrowser,
  loginAndStoreOAuth,
  paseoAgentAuthStoragePath,
  type OAuthDeviceCodeInfo,
} from "./agent/providers/paseo-agent/oauth-store.js";

// Provider binary resolution
export {
  type ProviderOverride,
  type ProviderProfileModel,
} from "./agent/provider-launch-config.js";
export { findExecutable } from "../executable-resolution/executable-resolution.js";
export { execCommand, spawnProcess } from "../utils/spawn.js";

// Provider manifest (source of truth for provider definitions)
export {
  AGENT_PROVIDER_DEFINITIONS,
  BUILTIN_PROVIDER_IDS,
  type AgentProviderDefinition,
} from "@getpaseo/protocol/provider-manifest";

// Agent SDK types for CLI commands
export type {
  AgentMode,
  AgentUsage,
  AgentCapabilityFlags,
  AgentPermissionRequest,
  AgentTimelineItem,
  ProviderSnapshotEntry,
} from "./agent/agent-sdk-types.js";

// Agent activity curator for CLI logs
export { curateAgentActivity } from "./agent/activity-curator.js";
export {
  getStructuredAgentResponse,
  StructuredAgentResponseError,
  StructuredAgentFallbackError,
  DEFAULT_STRUCTURED_GENERATION_PROVIDERS,
  generateStructuredAgentResponseWithFallback,
  type AgentCaller,
  type JsonSchema,
  type StructuredGenerationAttempt,
  type StructuredGenerationProvider,
  type StructuredAgentGenerationOptions,
  type StructuredAgentGenerationWithFallbackOptions,
  type StructuredAgentResponseOptions,
} from "./agent/agent-response-loop.js";

// WebSocket message types for CLI streaming
export type {
  AgentSnapshotPayload,
  AgentStreamEventPayload,
  AgentStreamMessage,
} from "@getpaseo/protocol/messages";
