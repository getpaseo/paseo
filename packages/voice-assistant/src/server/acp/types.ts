import type { SessionNotification } from "@agentclientprotocol/sdk";

/**
 * Status of an agent
 */
export type AgentStatus =
  | "initializing"
  | "ready"
  | "processing"
  | "completed"
  | "failed"
  | "killed";

/**
 * Information about an agent
 */
export interface AgentInfo {
  id: string;
  status: AgentStatus;
  createdAt: Date;
  type: "claude";
  sessionId: string | null;
  error: string | null;
  currentModeId: string | null;
  availableModes: SessionMode[] | null;
}

/**
 * Update from an agent session
 * Wraps ACP SessionNotification with additional metadata
 */
export interface AgentUpdate {
  agentId: string;
  timestamp: Date;
  notification: SessionNotification;
}

/**
 * Session mode definition from ACP
 */
export interface SessionMode {
  id: string;
  name: string;
  description?: string | null;
}

/**
 * Options for creating an agent
 */
export interface CreateAgentOptions {
  cwd: string;
  initialPrompt?: string;
  initialMode?: string;
}

/**
 * Callback for agent updates
 */
export type AgentUpdateCallback = (update: AgentUpdate) => void;
