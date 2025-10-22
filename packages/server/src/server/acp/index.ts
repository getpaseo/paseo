/**
 * ACP (Agent Client Protocol) Integration - Phase 1
 *
 * Provides infrastructure for managing Claude Code agents.
 * This is standalone and does not integrate with Session/WebSocket yet.
 */

export { AgentManager } from "./agent-manager.js";
export type {
  AgentStatus,
  AgentInfo,
  AgentUpdate,
  CreateAgentOptions,
  AgentUpdateCallback,
} from "./types.js";
