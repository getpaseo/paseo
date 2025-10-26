import { z } from "zod";
import type { AgentType } from "./acp/agent-types.js";
import { listAgentTypeDefinitions } from "./acp/agent-types.js";

const AgentModeSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
});

const agentTypes = listAgentTypeDefinitions().map((definition) => definition.id);

const AgentInfoSchema = z.object({
  id: z.string(),
  status: z.string(),
  createdAt: z.date(),
  lastActivityAt: z.date(),
  type: z.enum(agentTypes as [AgentType, ...AgentType[]]),
  sessionId: z.string().nullable(),
  error: z.string().nullable(),
  currentModeId: z.string().nullable(),
  availableModes: z.array(AgentModeSchema).nullable(),
  title: z.string().nullable(),
  cwd: z.string(),
});

const AgentUpdatePayloadSchema = z.object({
  agentId: z.string(),
  timestamp: z.date(),
  notification: z.any(),
});

// ============================================================================
// Session Inbound Messages (Session receives these)
// ============================================================================

export const UserTextMessageSchema = z.object({
  type: z.literal("user_text"),
  text: z.string(),
});

export const RealtimeAudioChunkMessageSchema = z.object({
  type: z.literal("realtime_audio_chunk"),
  audio: z.string(), // base64 encoded
  format: z.string(),
  isLast: z.boolean(),
});

export const AbortRequestMessageSchema = z.object({
  type: z.literal("abort_request"),
});

export const AudioPlayedMessageSchema = z.object({
  type: z.literal("audio_played"),
  id: z.string(),
});

export const LoadConversationRequestMessageSchema = z.object({
  type: z.literal("load_conversation_request"),
  conversationId: z.string(),
});

export const ListConversationsRequestMessageSchema = z.object({
  type: z.literal("list_conversations_request"),
});

export const DeleteConversationRequestMessageSchema = z.object({
  type: z.literal("delete_conversation_request"),
  conversationId: z.string(),
});

export const SetRealtimeModeMessageSchema = z.object({
  type: z.literal("set_realtime_mode"),
  enabled: z.boolean(),
});

export const SendAgentMessageSchema = z.object({
  type: z.literal("send_agent_message"),
  agentId: z.string(),
  text: z.string(),
  messageId: z.string().optional(), // Client-provided ID for deduplication
  images: z.array(z.object({
    data: z.string(), // base64 encoded image
    mimeType: z.string(), // e.g., "image/jpeg", "image/png"
  })).optional(),
});

export const SendAgentAudioSchema = z.object({
  type: z.literal("send_agent_audio"),
  agentId: z.string(),
  audio: z.string(), // base64 encoded
  format: z.string(),
  isLast: z.boolean(),
  requestId: z.string().optional(), // Client-provided ID for tracking transcription
});

export const CreateAgentRequestMessageSchema = z.object({
  type: z.literal("create_agent_request"),
  cwd: z.string(),
  initialMode: z.string().optional(),
  worktreeName: z.string().optional(),
  agentType: z.enum(agentTypes as [AgentType, ...AgentType[]]).optional(),
  requestId: z.string().optional(),
});

export const InitializeAgentRequestMessageSchema = z.object({
  type: z.literal("initialize_agent_request"),
  agentId: z.string(),
  requestId: z.string().optional(),
});

export const SetAgentModeMessageSchema = z.object({
  type: z.literal("set_agent_mode"),
  agentId: z.string(),
  modeId: z.string(),
});

export const AgentPermissionResponseMessageSchema = z.object({
  type: z.literal("agent_permission_response"),
  agentId: z.string(),
  requestId: z.string(),
  optionId: z.string(),
});

export const GitDiffRequestSchema = z.object({
  type: z.literal("git_diff_request"),
  agentId: z.string(),
});

export const SessionInboundMessageSchema = z.discriminatedUnion("type", [
  UserTextMessageSchema,
  RealtimeAudioChunkMessageSchema,
  AbortRequestMessageSchema,
  AudioPlayedMessageSchema,
  LoadConversationRequestMessageSchema,
  ListConversationsRequestMessageSchema,
  DeleteConversationRequestMessageSchema,
  SetRealtimeModeMessageSchema,
  SendAgentMessageSchema,
  SendAgentAudioSchema,
  CreateAgentRequestMessageSchema,
  InitializeAgentRequestMessageSchema,
  SetAgentModeMessageSchema,
  AgentPermissionResponseMessageSchema,
  GitDiffRequestSchema,
]);

export type SessionInboundMessage = z.infer<typeof SessionInboundMessageSchema>;

// ============================================================================
// Session Outbound Messages (Session emits these)
// ============================================================================

export const ActivityLogPayloadSchema = z.object({
  id: z.string(),
  timestamp: z.date(),
  type: z.enum([
    "transcript",
    "assistant",
    "tool_call",
    "tool_result",
    "error",
    "system",
  ]),
  content: z.string(),
  metadata: z.record(z.unknown()).optional(),
});

export const ActivityLogMessageSchema = z.object({
  type: z.literal("activity_log"),
  payload: ActivityLogPayloadSchema,
});

export const AssistantChunkMessageSchema = z.object({
  type: z.literal("assistant_chunk"),
  payload: z.object({
    chunk: z.string(),
  }),
});

export const AudioOutputMessageSchema = z.object({
  type: z.literal("audio_output"),
  payload: z.object({
    audio: z.string(), // base64 encoded
    format: z.string(),
    id: z.string(),
    isRealtimeMode: z.boolean(), // Mode when audio was generated (for drift protection)
  }),
});

export const TranscriptionResultMessageSchema = z.object({
  type: z.literal("transcription_result"),
  payload: z.object({
    text: z.string(),
    language: z.string().optional(),
    duration: z.number().optional(),
    requestId: z.string().optional(), // Echoed back from request for tracking
  }),
});

export const StatusMessageSchema = z.object({
  type: z.literal("status"),
  payload: z
    .object({
      status: z.string(),
    })
    .passthrough(), // Allow additional fields
});

export const ArtifactMessageSchema = z.object({
  type: z.literal("artifact"),
  payload: z.object({
    type: z.enum(["markdown", "diff", "image", "code"]),
    id: z.string(),
    title: z.string(),
    content: z.string(),
    isBase64: z.boolean(),
  }),
});

export const ConversationLoadedMessageSchema = z.object({
  type: z.literal("conversation_loaded"),
  payload: z.object({
    conversationId: z.string(),
    messageCount: z.number(),
  }),
});

export const AgentCreatedMessageSchema = z.object({
  type: z.literal("agent_created"),
  payload: z.object({
    agentId: z.string(),
    status: z.string(),
    type: z.enum(agentTypes as [AgentType, ...AgentType[]]),
    currentModeId: z.string().optional(),
    availableModes: z.array(AgentModeSchema).optional(),
    title: z.string().optional(),
    cwd: z.string(),
    requestId: z.string().optional(),
  }),
});

export const AgentUpdateMessageSchema = z.object({
  type: z.literal("agent_update"),
  payload: AgentUpdatePayloadSchema,
});

export const AgentStatusMessageSchema = z.object({
  type: z.literal("agent_status"),
  payload: z.object({
    agentId: z.string(),
    status: z.string(),
    info: AgentInfoSchema,
  }),
});

export const SessionStateMessageSchema = z.object({
  type: z.literal("session_state"),
  payload: z.object({
    agents: z.array(AgentInfoSchema),
    commands: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        workingDirectory: z.string(),
        currentCommand: z.string(),
        isDead: z.boolean(),
        exitCode: z.number().nullable(),
      })
    ),
  }),
});

export const AgentInitializedMessageSchema = z.object({
  type: z.literal("agent_initialized"),
  payload: z.object({
    agentId: z.string(),
    info: AgentInfoSchema,
    updates: z.array(AgentUpdatePayloadSchema),
    requestId: z.string().optional(),
  }),
});

export const ListConversationsResponseMessageSchema = z.object({
  type: z.literal("list_conversations_response"),
  payload: z.object({
    conversations: z.array(
      z.object({
        id: z.string(),
        lastUpdated: z.string(),
        messageCount: z.number(),
      })
    ),
  }),
});

export const DeleteConversationResponseMessageSchema = z.object({
  type: z.literal("delete_conversation_response"),
  payload: z.object({
    conversationId: z.string(),
    success: z.boolean(),
    error: z.string().optional(),
  }),
});

export const AgentPermissionRequestMessageSchema = z.object({
  type: z.literal("agent_permission_request"),
  payload: z.object({
    agentId: z.string(),
    requestId: z.string(),
    sessionId: z.string(),
    toolCall: z.any(), // ToolCallUpdate from ACP SDK - complex type with flexible rawInput
    options: z.array(z.object({
      kind: z.enum(["allow_always", "allow_once", "reject_once", "reject_always"]),
      name: z.string(),
      optionId: z.string(),
    })),
  }),
});

export const AgentPermissionResolvedMessageSchema = z.object({
  type: z.literal("agent_permission_resolved"),
  payload: z.object({
    agentId: z.string(),
    requestId: z.string(),
    optionId: z.string(),
  }),
});

export const GitDiffResponseSchema = z.object({
  type: z.literal("git_diff_response"),
  payload: z.object({
    agentId: z.string(),
    diff: z.string(),
    error: z.string().nullable(),
  }),
});

export const SessionOutboundMessageSchema = z.discriminatedUnion("type", [
  ActivityLogMessageSchema,
  AssistantChunkMessageSchema,
  AudioOutputMessageSchema,
  TranscriptionResultMessageSchema,
  StatusMessageSchema,
  ArtifactMessageSchema,
  ConversationLoadedMessageSchema,
  AgentCreatedMessageSchema,
  AgentUpdateMessageSchema,
  AgentStatusMessageSchema,
  SessionStateMessageSchema,
  AgentInitializedMessageSchema,
  ListConversationsResponseMessageSchema,
  DeleteConversationResponseMessageSchema,
  AgentPermissionRequestMessageSchema,
  AgentPermissionResolvedMessageSchema,
  GitDiffResponseSchema,
]);

export type SessionOutboundMessage = z.infer<
  typeof SessionOutboundMessageSchema
>;

// Type exports for individual message types
export type ActivityLogMessage = z.infer<typeof ActivityLogMessageSchema>;
export type AssistantChunkMessage = z.infer<typeof AssistantChunkMessageSchema>;
export type AudioOutputMessage = z.infer<typeof AudioOutputMessageSchema>;
export type TranscriptionResultMessage = z.infer<typeof TranscriptionResultMessageSchema>;
export type StatusMessage = z.infer<typeof StatusMessageSchema>;
export type ArtifactMessage = z.infer<typeof ArtifactMessageSchema>;
export type ConversationLoadedMessage = z.infer<typeof ConversationLoadedMessageSchema>;
export type AgentCreatedMessage = z.infer<typeof AgentCreatedMessageSchema>;
export type AgentUpdateMessage = z.infer<typeof AgentUpdateMessageSchema>;
export type AgentStatusMessage = z.infer<typeof AgentStatusMessageSchema>;
export type SessionStateMessage = z.infer<typeof SessionStateMessageSchema>;
export type AgentInitializedMessage = z.infer<typeof AgentInitializedMessageSchema>;
export type ListConversationsResponseMessage = z.infer<typeof ListConversationsResponseMessageSchema>;
export type DeleteConversationResponseMessage = z.infer<typeof DeleteConversationResponseMessageSchema>;
export type AgentPermissionRequestMessage = z.infer<typeof AgentPermissionRequestMessageSchema>;
export type AgentPermissionResolvedMessage = z.infer<typeof AgentPermissionResolvedMessageSchema>;

// Type exports for payload types
export type ActivityLogPayload = z.infer<typeof ActivityLogPayloadSchema>;

// Type exports for inbound message types
export type UserTextMessage = z.infer<typeof UserTextMessageSchema>;
export type RealtimeAudioChunkMessage = z.infer<typeof RealtimeAudioChunkMessageSchema>;
export type SendAgentMessage = z.infer<typeof SendAgentMessageSchema>;
export type SendAgentAudio = z.infer<typeof SendAgentAudioSchema>;
export type CreateAgentRequestMessage = z.infer<typeof CreateAgentRequestMessageSchema>;
export type InitializeAgentRequestMessage = z.infer<typeof InitializeAgentRequestMessageSchema>;
export type SetAgentModeMessage = z.infer<typeof SetAgentModeMessageSchema>;
export type AgentPermissionResponseMessage = z.infer<typeof AgentPermissionResponseMessageSchema>;
export type GitDiffRequest = z.infer<typeof GitDiffRequestSchema>;
export type GitDiffResponse = z.infer<typeof GitDiffResponseSchema>;

// ============================================================================
// WebSocket Level Messages (wraps session messages)
// ============================================================================

// WebSocket-only messages (not session messages)
export const WSPingMessageSchema = z.object({
  type: z.literal("ping"),
});

export const WSPongMessageSchema = z.object({
  type: z.literal("pong"),
});

export const WSRecordingStateMessageSchema = z.object({
  type: z.literal("recording_state"),
  isRecording: z.boolean(),
});

// Wrapped session message
export const WSSessionInboundSchema = z.object({
  type: z.literal("session"),
  message: SessionInboundMessageSchema,
});

export const WSSessionOutboundSchema = z.object({
  type: z.literal("session"),
  message: SessionOutboundMessageSchema,
});

// Complete WebSocket message schemas
export const WSInboundMessageSchema = z.discriminatedUnion("type", [
  WSPingMessageSchema,
  WSRecordingStateMessageSchema,
  WSSessionInboundSchema,
]);

export const WSOutboundMessageSchema = z.discriminatedUnion("type", [
  WSPongMessageSchema,
  WSSessionOutboundSchema,
]);

export type WSInboundMessage = z.infer<typeof WSInboundMessageSchema>;
export type WSOutboundMessage = z.infer<typeof WSOutboundMessageSchema>;

// ============================================================================
// Helper functions for message conversion
// ============================================================================

/**
 * Extract session message from WebSocket message
 * Returns null if message should be handled at WS level only
 */
export function extractSessionMessage(
  wsMsg: WSInboundMessage
): SessionInboundMessage | null {
  if (wsMsg.type === "session") {
    return wsMsg.message;
  }
  // Ping and recording_state are WS-level only
  return null;
}

/**
 * Wrap session message in WebSocket envelope
 */
export function wrapSessionMessage(
  sessionMsg: SessionOutboundMessage
): WSOutboundMessage {
  return {
    type: "session",
    message: sessionMsg,
  };
}
