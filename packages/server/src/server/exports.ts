// CLI exports for @junction/server
export { createJunctionDaemon, type JunctionDaemon, type JunctionDaemonConfig } from "./bootstrap.js";
export { loadConfig, type CliConfigOverrides } from "./config.js";
export { resolveJunctionHome } from "./junction-home.js";
export { createRootLogger, type LogLevel, type LogFormat } from "./logger.js";
export { loadPersistedConfig, type PersistedConfig } from "./persisted-config.js";
export { DaemonClient, type DaemonClientConfig, type ConnectionState, type DaemonEvent } from "../client/daemon-client.js";

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
