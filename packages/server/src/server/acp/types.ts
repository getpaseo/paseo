import type { SessionNotification } from "@agentclientprotocol/sdk";

/**
 * Extended update types with messageId for proper deduplication
 */
type AgentMessageChunkWithId = Extract<SessionNotification['update'], { sessionUpdate: 'agent_message_chunk' }> & { messageId: string };
type AgentThoughtChunkWithId = Extract<SessionNotification['update'], { sessionUpdate: 'agent_thought_chunk' }> & { messageId: string };

export type EnrichedSessionUpdate =
  | AgentMessageChunkWithId
  | AgentThoughtChunkWithId
  | Exclude<SessionNotification['update'], { sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk' }>;

export interface EnrichedSessionNotification extends Omit<SessionNotification, 'update'> {
  update: EnrichedSessionUpdate;
}

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
  createdAt: string;
  type: "claude";
  sessionId: string | null;
  error: string | null;
  currentModeId: string | null;
  availableModes: SessionMode[] | null;
  title: string | null;
  cwd: string;
}

/**
 * Update from an agent session
 * Wraps enriched SessionNotification with additional metadata
 */
export interface AgentUpdate {
  agentId: string;
  timestamp: Date;
  notification: EnrichedSessionNotification;
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
