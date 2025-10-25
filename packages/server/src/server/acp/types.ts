import type {
  SessionNotification,
  RequestPermissionRequest,
  ClientSideConnection,
} from "@agentclientprotocol/sdk";
import type { ChildProcess } from "child_process";

/**
 * Extended update types with messageId for proper deduplication
 * messageId is optional since some sources may not provide it
 */
type UserMessageChunkWithId = Extract<
  SessionNotification["update"],
  { sessionUpdate: "user_message_chunk" }
> & { messageId?: string };
type AgentMessageChunkWithId = Extract<
  SessionNotification["update"],
  { sessionUpdate: "agent_message_chunk" }
> & { messageId?: string };
type AgentThoughtChunkWithId = Extract<
  SessionNotification["update"],
  { sessionUpdate: "agent_thought_chunk" }
> & { messageId?: string };

export type EnrichedSessionUpdate =
  | UserMessageChunkWithId
  | AgentMessageChunkWithId
  | AgentThoughtChunkWithId
  | Exclude<
      SessionNotification["update"],
      {
        sessionUpdate:
          | "user_message_chunk"
          | "agent_message_chunk"
          | "agent_thought_chunk";
      }
    >;

export interface EnrichedSessionNotification
  extends Omit<SessionNotification, "update"> {
  update: EnrichedSessionUpdate;
}

/**
 * Discriminated union for all notification types in the agent update stream
 */
export type AgentNotification =
  | { type: "session"; notification: EnrichedSessionNotification }
  | { type: "permission"; requestId: string; request: RequestPermissionRequest }
  | {
      type: "permission_resolved";
      requestId: string;
      agentId: string;
      optionId: string;
    }
  | { type: "status"; status: AgentStatus; error?: string };

/**
 * Status of an agent
 */
export type AgentStatus =
  | "uninitialized"
  | "initializing"
  | "ready"
  | "processing"
  | "completed"
  | "failed"
  | "killed";

/**
 * Session mode definition from ACP
 */
export interface SessionMode {
  id: string;
  name: string;
  description?: string | null;
}

/**
 * Runtime state for an initialized agent
 */
export interface AgentRuntime {
  process: ChildProcess;
  connection: ClientSideConnection;
  sessionId: string;
  currentModeId: string | null;
  availableModes: SessionMode[] | null;
}

/**
 * Discriminated union for agent state
 */
export type ManagedAgentState =
  | {
      type: "uninitialized";
      persistedSessionId: string | null;
      lastError?: string;
    }
  | {
      type: "initializing";
      persistedSessionId: string | null;
      initPromise: Promise<void>;
      initStartedAt: Date;
      runtime?: AgentRuntime;
    }
  | { type: "ready"; runtime: AgentRuntime }
  | { type: "processing"; runtime: AgentRuntime }
  | { type: "completed"; runtime: AgentRuntime; stopReason?: string }
  | { type: "failed"; lastError: string; runtime?: AgentRuntime }
  | { type: "killed" };

/**
 * Information about an agent
 */
export interface AgentInfo {
  id: string;
  status: AgentStatus;
  createdAt: Date;
  lastActivityAt: Date;
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
 * Wraps all notification types with additional metadata
 */
export interface AgentUpdate {
  agentId: string;
  timestamp: Date;
  notification: AgentNotification;
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
