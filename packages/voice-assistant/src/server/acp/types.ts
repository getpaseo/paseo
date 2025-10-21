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
  sessionId?: string;
  error?: string;
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
 * Permission modes for agent file operations
 */
export type PermissionMode =
  | "auto_approve"      // Automatically approve all permissions
  | "ask_user"          // Prompt user for each permission
  | "reject_all";       // Reject all permission requests

/**
 * Options for creating an agent
 */
export interface CreateAgentOptions {
  cwd: string;
  initialPrompt?: string;
  permissionsMode?: PermissionMode;
}

/**
 * Callback for agent updates
 */
export type AgentUpdateCallback = (update: AgentUpdate) => void;
