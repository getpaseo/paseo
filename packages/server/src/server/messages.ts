import { z } from "zod";
import type { AgentSnapshot } from "./agent/agent-manager.js";
import type {
  AgentCapabilityFlags,
  AgentMode,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentProvider,
  AgentStreamEvent,
  AgentTimelineItem,
  AgentUsage,
} from "./agent/agent-sdk-types.js";

type ProviderEventPayload = Extract<
  AgentStreamEvent,
  { type: "provider_event" }
>;

export type AgentSnapshotPayload = Omit<
  AgentSnapshot,
  "createdAt" | "updatedAt"
> & {
  createdAt: string;
  updatedAt: string;
  title: string | null;
};

const AGENT_PROVIDERS: [AgentProvider, AgentProvider] = ["claude", "codex"];
const AgentProviderSchema = z.enum(AGENT_PROVIDERS);

const AGENT_LIFECYCLE_STATUSES = [
  "initializing",
  "idle",
  "running",
  "error",
  "closed",
] as const;
const AgentStatusSchema = z.enum(AGENT_LIFECYCLE_STATUSES);

const AgentModeSchema: z.ZodType<AgentMode> = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
});

const AgentCapabilityFlagsSchema: z.ZodType<AgentCapabilityFlags> = z.object({
  supportsStreaming: z.boolean(),
  supportsSessionPersistence: z.boolean(),
  supportsDynamicModes: z.boolean(),
  supportsMcpServers: z.boolean(),
  supportsReasoningStream: z.boolean(),
  supportsToolInvocations: z.boolean(),
});

const AgentUsageSchema: z.ZodType<AgentUsage> = z.object({
  inputTokens: z.number().optional(),
  cachedInputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  totalCostUsd: z.number().optional(),
});

const AgentSessionConfigSchema = z.object({
  provider: AgentProviderSchema,
  cwd: z.string(),
  modeId: z.string().optional(),
  model: z.string().optional(),
  approvalPolicy: z.string().optional(),
  sandboxMode: z.string().optional(),
  networkAccess: z.boolean().optional(),
  webSearch: z.boolean().optional(),
  reasoningEffort: z.string().optional(),
  extra: z
    .object({
      codex: z.record(z.unknown()).optional(),
      claude: z.record(z.unknown()).optional(),
    })
    .partial()
    .optional(),
  mcpServers: z.record(z.unknown()).optional(),
});

const AgentPermissionUpdateSchema = z.record(z.unknown());

export const AgentPermissionResponseSchema: z.ZodType<AgentPermissionResponse> =
  z.union([
    z.object({
      behavior: z.literal("allow"),
      updatedInput: z.record(z.unknown()).optional(),
      updatedPermissions: z.array(AgentPermissionUpdateSchema).optional(),
    }),
    z.object({
      behavior: z.literal("deny"),
      message: z.string().optional(),
      interrupt: z.boolean().optional(),
    }),
  ]);

export const AgentPermissionRequestPayloadSchema: z.ZodType<AgentPermissionRequest> =
  z.object({
    id: z.string(),
    provider: AgentProviderSchema,
    name: z.string(),
    kind: z.enum(["tool", "plan", "mode", "other"]),
    title: z.string().optional(),
    description: z.string().optional(),
    input: z.record(z.unknown()).optional(),
    suggestions: z.array(AgentPermissionUpdateSchema).optional(),
    metadata: z.record(z.unknown()).optional(),
    raw: z.unknown().optional(),
  });

export const AgentTimelineItemPayloadSchema: z.ZodType<AgentTimelineItem> =
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("user_message"),
      text: z.string(),
      messageId: z.string().optional(),
      raw: z.unknown().optional(),
    }),
    z.object({
      type: z.literal("assistant_message"),
      text: z.string(),
      raw: z.unknown().optional(),
    }),
    z.object({
      type: z.literal("reasoning"),
      text: z.string(),
      raw: z.unknown().optional(),
    }),
    z.object({
      type: z.literal("tool_call"),
      server: z.string(),
      tool: z.string(),
      status: z.string().optional(),
      callId: z.string().optional(),
      displayName: z.string().optional(),
      kind: z.string().optional(),
      input: z.unknown().optional(),
      output: z.unknown().optional(),
      error: z.unknown().optional(),
      raw: z.unknown().optional(),
    }),
    z.object({
      type: z.literal("todo"),
      items: z.array(
        z.object({
          text: z.string(),
          completed: z.boolean(),
        })
      ),
      raw: z.unknown().optional(),
    }),
    z.object({
      type: z.literal("error"),
      message: z.string(),
      raw: z.unknown().optional(),
    }),
  ]);

const ProviderEventPayloadSchema = z.object({
  type: z.literal("provider_event"),
  provider: AgentProviderSchema,
  raw: z.custom<ProviderEventPayload["raw"]>(),
});

export const AgentStreamEventPayloadSchema = z.discriminatedUnion("type", [
    z.object({
      type: z.literal("thread_started"),
      sessionId: z.string(),
      provider: AgentProviderSchema,
    }),
    z.object({
      type: z.literal("turn_started"),
      provider: AgentProviderSchema,
    }),
    z.object({
      type: z.literal("turn_completed"),
      provider: AgentProviderSchema,
      usage: AgentUsageSchema.optional(),
    }),
    z.object({
      type: z.literal("turn_failed"),
      provider: AgentProviderSchema,
      error: z.string(),
    }),
    z.object({
      type: z.literal("timeline"),
      provider: AgentProviderSchema,
      item: AgentTimelineItemPayloadSchema,
    }),
    ProviderEventPayloadSchema,
    z.object({
      type: z.literal("permission_requested"),
      provider: AgentProviderSchema,
      request: AgentPermissionRequestPayloadSchema,
    }),
    z.object({
      type: z.literal("permission_resolved"),
      provider: AgentProviderSchema,
      requestId: z.string(),
      resolution: AgentPermissionResponseSchema,
    }),
]);

const AgentPersistenceHandleSchema: z.ZodType<AgentPersistenceHandle | null> =
  z
    .object({
      provider: AgentProviderSchema,
      sessionId: z.string(),
      nativeHandle: z.any().optional(),
      metadata: z.record(z.unknown()).optional(),
    })
    .nullable();

export const AgentSnapshotPayloadSchema = z.object({
  id: z.string(),
  provider: AgentProviderSchema,
  cwd: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  status: AgentStatusSchema,
  sessionId: z.string().nullable(),
  capabilities: AgentCapabilityFlagsSchema,
  currentModeId: z.string().nullable(),
  availableModes: z.array(AgentModeSchema),
  pendingPermissions: z.array(AgentPermissionRequestPayloadSchema),
  persistence: AgentPersistenceHandleSchema.nullable(),
  lastUsage: AgentUsageSchema.optional(),
  lastError: z.string().optional(),
  title: z.string().nullable(),
});

export type AgentStreamEventPayload = z.infer<
  typeof AgentStreamEventPayloadSchema
>;

export function serializeAgentSnapshot(
  snapshot: AgentSnapshot,
  options?: { title?: string | null }
): AgentSnapshotPayload {
  const { createdAt, updatedAt, ...rest } = snapshot;
  return {
    ...rest,
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    title: options?.title ?? null,
  };
}

export function serializeAgentStreamEvent(
  event: AgentStreamEvent
): AgentStreamEventPayload {
  return event as AgentStreamEventPayload;
}

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

export const DeleteAgentRequestMessageSchema = z.object({
  type: z.literal("delete_agent_request"),
  agentId: z.string(),
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
  config: AgentSessionConfigSchema,
  worktreeName: z.string().optional(),
  requestId: z.string().optional(),
});

export const ResumeAgentRequestMessageSchema = z.object({
  type: z.literal("resume_agent_request"),
  handle: AgentPersistenceHandleSchema,
  overrides: AgentSessionConfigSchema.partial().optional(),
  requestId: z.string().optional(),
});

export const RefreshAgentRequestMessageSchema = z.object({
  type: z.literal("refresh_agent_request"),
  agentId: z.string(),
  requestId: z.string().optional(),
});

export const CancelAgentRequestMessageSchema = z.object({
  type: z.literal("cancel_agent_request"),
  agentId: z.string(),
});

export const ListPersistedAgentsRequestMessageSchema = z.object({
  type: z.literal("list_persisted_agents_request"),
  provider: AgentProviderSchema.optional(),
  limit: z.number().int().positive().optional(),
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
  response: AgentPermissionResponseSchema,
});

export const GitDiffRequestSchema = z.object({
  type: z.literal("git_diff_request"),
  agentId: z.string(),
});

const FileExplorerEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.enum(["file", "directory"]),
  size: z.number(),
  modifiedAt: z.string(),
});

const FileExplorerFileSchema = z.object({
  path: z.string(),
  kind: z.enum(["text", "image", "binary"]),
  encoding: z.enum(["utf-8", "base64", "none"]),
  content: z.string().optional(),
  mimeType: z.string().optional(),
  size: z.number(),
  modifiedAt: z.string(),
});

const FileExplorerDirectorySchema = z.object({
  path: z.string(),
  entries: z.array(FileExplorerEntrySchema),
});

export const FileExplorerRequestSchema = z.object({
  type: z.literal("file_explorer_request"),
  agentId: z.string(),
  path: z.string().optional(),
  mode: z.enum(["list", "file"]),
});

export const SessionInboundMessageSchema = z.discriminatedUnion("type", [
  UserTextMessageSchema,
  RealtimeAudioChunkMessageSchema,
  AbortRequestMessageSchema,
  AudioPlayedMessageSchema,
  LoadConversationRequestMessageSchema,
  ListConversationsRequestMessageSchema,
  DeleteConversationRequestMessageSchema,
  DeleteAgentRequestMessageSchema,
  SetRealtimeModeMessageSchema,
  SendAgentMessageSchema,
  SendAgentAudioSchema,
  CreateAgentRequestMessageSchema,
  ResumeAgentRequestMessageSchema,
  RefreshAgentRequestMessageSchema,
  CancelAgentRequestMessageSchema,
  InitializeAgentRequestMessageSchema,
  SetAgentModeMessageSchema,
  AgentPermissionResponseMessageSchema,
  GitDiffRequestSchema,
  FileExplorerRequestSchema,
  ListPersistedAgentsRequestMessageSchema,
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
    groupId: z.string().optional(), // Logical utterance id
    chunkIndex: z.number().int().nonnegative().optional(),
    isLastChunk: z.boolean().optional(),
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

export const AgentStateMessageSchema = z.object({
  type: z.literal("agent_state"),
  payload: AgentSnapshotPayloadSchema,
});

export const AgentStreamMessageSchema = z.object({
  type: z.literal("agent_stream"),
  payload: z.object({
    agentId: z.string(),
    event: AgentStreamEventPayloadSchema,
    timestamp: z.string(),
  }),
});

export const AgentStreamSnapshotMessageSchema = z.object({
  type: z.literal("agent_stream_snapshot"),
  payload: z.object({
    agentId: z.string(),
    events: z.array(
      z.object({
        event: AgentStreamEventPayloadSchema,
        timestamp: z.string(),
      })
    ),
  }),
});

export const AgentStatusMessageSchema = z.object({
  type: z.literal("agent_status"),
  payload: z.object({
    agentId: z.string(),
    status: z.string(),
    info: AgentSnapshotPayloadSchema,
  }),
});

export const SessionStateMessageSchema = z.object({
  type: z.literal("session_state"),
  payload: z.object({
    agents: z.array(AgentSnapshotPayloadSchema),
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
    request: AgentPermissionRequestPayloadSchema,
  }),
});

export const AgentPermissionResolvedMessageSchema = z.object({
  type: z.literal("agent_permission_resolved"),
  payload: z.object({
    agentId: z.string(),
    requestId: z.string(),
    resolution: AgentPermissionResponseSchema,
  }),
});

export const AgentDeletedMessageSchema = z.object({
  type: z.literal("agent_deleted"),
  payload: z.object({
    agentId: z.string(),
  }),
});

const PersistedAgentDescriptorPayloadSchema = z.object({
  provider: AgentProviderSchema,
  sessionId: z.string(),
  cwd: z.string(),
  title: z.string(),
  lastActivityAt: z.string(),
  persistence: AgentPersistenceHandleSchema,
});

export type PersistedAgentDescriptorPayload = z.infer<typeof PersistedAgentDescriptorPayloadSchema>;

export const ListPersistedAgentsResponseSchema = z.object({
  type: z.literal("list_persisted_agents_response"),
  payload: z.object({
    items: z.array(PersistedAgentDescriptorPayloadSchema),
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

export const FileExplorerResponseSchema = z.object({
  type: z.literal("file_explorer_response"),
  payload: z.object({
    agentId: z.string(),
    path: z.string(),
    mode: z.enum(["list", "file"]),
    directory: FileExplorerDirectorySchema.nullable(),
    file: FileExplorerFileSchema.nullable(),
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
  AgentStateMessageSchema,
  AgentStreamMessageSchema,
  AgentStreamSnapshotMessageSchema,
  AgentStatusMessageSchema,
  SessionStateMessageSchema,
  ListConversationsResponseMessageSchema,
  DeleteConversationResponseMessageSchema,
  AgentPermissionRequestMessageSchema,
  AgentPermissionResolvedMessageSchema,
  AgentDeletedMessageSchema,
  ListPersistedAgentsResponseSchema,
  GitDiffResponseSchema,
  FileExplorerResponseSchema,
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
export type AgentStateMessage = z.infer<typeof AgentStateMessageSchema>;
export type AgentStreamMessage = z.infer<typeof AgentStreamMessageSchema>;
export type AgentStreamSnapshotMessage = z.infer<
  typeof AgentStreamSnapshotMessageSchema
>;
export type AgentStatusMessage = z.infer<typeof AgentStatusMessageSchema>;
export type SessionStateMessage = z.infer<typeof SessionStateMessageSchema>;
export type ListConversationsResponseMessage = z.infer<typeof ListConversationsResponseMessageSchema>;
export type DeleteConversationResponseMessage = z.infer<typeof DeleteConversationResponseMessageSchema>;
export type AgentPermissionRequestMessage = z.infer<typeof AgentPermissionRequestMessageSchema>;
export type AgentPermissionResolvedMessage = z.infer<typeof AgentPermissionResolvedMessageSchema>;
export type AgentDeletedMessage = z.infer<typeof AgentDeletedMessageSchema>;
export type ListPersistedAgentsResponseMessage = z.infer<typeof ListPersistedAgentsResponseSchema>;

// Type exports for payload types
export type ActivityLogPayload = z.infer<typeof ActivityLogPayloadSchema>;

// Type exports for inbound message types
export type UserTextMessage = z.infer<typeof UserTextMessageSchema>;
export type RealtimeAudioChunkMessage = z.infer<typeof RealtimeAudioChunkMessageSchema>;
export type SendAgentMessage = z.infer<typeof SendAgentMessageSchema>;
export type SendAgentAudio = z.infer<typeof SendAgentAudioSchema>;
export type CreateAgentRequestMessage = z.infer<typeof CreateAgentRequestMessageSchema>;
export type ResumeAgentRequestMessage = z.infer<typeof ResumeAgentRequestMessageSchema>;
export type DeleteAgentRequestMessage = z.infer<typeof DeleteAgentRequestMessageSchema>;
export type ListPersistedAgentsRequestMessage = z.infer<typeof ListPersistedAgentsRequestMessageSchema>;
export type InitializeAgentRequestMessage = z.infer<typeof InitializeAgentRequestMessageSchema>;
export type SetAgentModeMessage = z.infer<typeof SetAgentModeMessageSchema>;
export type AgentPermissionResponseMessage = z.infer<typeof AgentPermissionResponseMessageSchema>;
export type GitDiffRequest = z.infer<typeof GitDiffRequestSchema>;
export type GitDiffResponse = z.infer<typeof GitDiffResponseSchema>;
export type FileExplorerRequest = z.infer<typeof FileExplorerRequestSchema>;
export type FileExplorerResponse = z.infer<typeof FileExplorerResponseSchema>;

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
