// CLI exports for @paseo/server
export { createPaseoDaemon, type PaseoDaemon, type PaseoDaemonConfig } from "./bootstrap.js";
export { loadConfig, type CliConfigOverrides } from "./config.js";
export { resolvePaseoHome } from "./paseo-home.js";
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

// WebSocket message types for CLI streaming
export type {
  AgentSnapshotPayload,
  AgentStreamEventPayload,
  AgentStreamMessage,
  AgentStreamSnapshotMessage,
} from "../shared/messages.js";
