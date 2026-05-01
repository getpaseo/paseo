// CLI exports for @hubcode/server
export { createHubcodeDaemon, type HubcodeDaemon, type HubcodeDaemonConfig } from "./bootstrap.js";
export { loadConfig, type CliConfigOverrides } from "./config.js";
export { resolveHubcodeHome } from "./hubcode-home.js";
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
} from "../shared/connection-offer.js";
export {
  buildDaemonWebSocketUrl,
  buildRelayWebSocketUrl,
  deriveLabelFromEndpoint,
  normalizeHostPort,
  parseConnectionUri,
  shouldUseTlsForDefaultHostedRelay,
} from "../shared/daemon-endpoints.js";
export {
  DirectTcpHostConnectionSchema,
  type DirectTcpHostConnection,
  type NormalizedDirectTcpHostConnection,
} from "../shared/host-connection-schema.js";
export {
  DaemonClient,
  type DaemonClientConfig,
  type ConnectionState,
  type DaemonEvent,
} from "../client/daemon-client.js";
export type { WebSocketFactory, WebSocketLike } from "../client/daemon-client-transport-types.js";
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

// Provider binary resolution
export {
  applyProviderEnv,
  type ProviderOverride,
  type ProviderProfileModel,
} from "./agent/provider-launch-config.js";
export {
  findExecutable,
  quoteWindowsArgument,
  quoteWindowsCommand,
} from "../utils/executable.js";
export { execCommand, spawnProcess } from "../utils/spawn.js";

// Provider manifest (source of truth for provider definitions)
export {
  AGENT_PROVIDER_DEFINITIONS,
  BUILTIN_PROVIDER_IDS,
  type AgentProviderDefinition,
} from "./agent/provider-manifest.js";

// Agent SDK types for CLI commands
export type {
  AgentMode,
  AgentUsage,
  AgentCapabilityFlags,
  AgentPermissionRequest,
  AgentTimelineItem,
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
} from "../shared/messages.js";

// Library sync (Claude / Codex / OpenCode external config writers)
export {
  syncLibraryToTargets,
  defaultSyncPaths,
  type SyncInput,
  type SyncReport,
  type SyncTargetPaths,
} from "./library/sync-writers.js";
export type {
  MaterializedMcpEntry,
  MaterializedSkillEntry,
  LibrarySyncTarget,
  McpTransport,
  McpPayload,
  SkillPayload,
} from "./library/types.js";
export { redactSecrets, redactAuthorizationHeader } from "./library/redact.js";
