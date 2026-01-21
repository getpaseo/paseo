import { z } from "zod";
import { AGENT_LIFECYCLE_STATUSES } from "./agent-lifecycle.js";
import { AgentProviderSchema } from "../server/agent/provider-manifest.js";
import type {
  AgentCapabilityFlags,
  AgentModelDefinition,
  AgentMode,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentRuntimeInfo,
  AgentTimelineItem,
  AgentUsage,
} from "../server/agent/agent-sdk-types.js";

export const AgentStatusSchema = z.enum(AGENT_LIFECYCLE_STATUSES);

const AgentModeSchema: z.ZodType<AgentMode> = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
});

const AgentModelDefinitionSchema: z.ZodType<AgentModelDefinition> = z.object({
  provider: AgentProviderSchema,
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  isDefault: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional(),
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
  title: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .optional()
    .nullable(),
  approvalPolicy: z.string().optional(),
  sandboxMode: z.string().optional(),
  networkAccess: z.boolean().optional(),
  webSearch: z.boolean().optional(),
  reasoningEffort: z.string().optional(),
  agentControlMcp: z
    .object({
      url: z.string(),
      headers: z.record(z.string()).optional(),
    })
    .optional(),
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
  });

// Structured tool result types for better client rendering
// These types define the structure of the `output` field in tool_call timeline items
export type StructuredToolResult =
  | { type: "command"; command: string; output: string; exitCode?: number; cwd?: string }
  | { type: "file_write"; filePath: string; oldContent: string; newContent: string }
  | { type: "file_edit"; filePath: string; diff?: string; oldContent?: string; newContent?: string }
  | { type: "file_read"; filePath: string; content: string }
  | { type: "generic"; data: unknown };

export const AgentTimelineItemPayloadSchema: z.ZodType<AgentTimelineItem> =
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("user_message"),
      text: z.string(),
      messageId: z.string().optional(),
    }),
    z.object({
      type: z.literal("assistant_message"),
      text: z.string(),
    }),
    z.object({
      type: z.literal("reasoning"),
      text: z.string(),
    }),
    z.object({
      type: z.literal("tool_call"),
      name: z.string(),
      callId: z.string().optional(),
      status: z.string().optional(),
      input: z.unknown().optional(),
      output: z.unknown().optional(),
      error: z.unknown().optional(),
    }),
    z.object({
      type: z.literal("todo"),
      items: z.array(
        z.object({
          text: z.string(),
          completed: z.boolean(),
        })
      ),
    }),
    z.object({
      type: z.literal("error"),
      message: z.string(),
    }),
  ]);

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
      type: z.literal("turn_canceled"),
      provider: AgentProviderSchema,
      reason: z.string(),
    }),
    z.object({
      type: z.literal("timeline"),
      provider: AgentProviderSchema,
      item: AgentTimelineItemPayloadSchema,
    }),
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
    z.object({
      type: z.literal("attention_required"),
      provider: AgentProviderSchema,
      reason: z.enum(["finished", "error", "permission"]),
      timestamp: z.string(),
      shouldNotify: z.boolean(),
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

const AgentRuntimeInfoSchema: z.ZodType<AgentRuntimeInfo> = z.object({
  provider: AgentProviderSchema,
  sessionId: z.string().nullable(),
  model: z.string().nullable().optional(),
  modeId: z.string().nullable().optional(),
  extra: z.record(z.unknown()).optional(),
});

export const AgentSnapshotPayloadSchema = z.object({
  id: z.string(),
  provider: AgentProviderSchema,
  cwd: z.string(),
  model: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastUserMessageAt: z.string().nullable(),
  status: AgentStatusSchema,
  capabilities: AgentCapabilityFlagsSchema,
  currentModeId: z.string().nullable(),
  availableModes: z.array(AgentModeSchema),
  pendingPermissions: z.array(AgentPermissionRequestPayloadSchema),
  persistence: AgentPersistenceHandleSchema.nullable(),
  runtimeInfo: AgentRuntimeInfoSchema.optional(),
  lastUsage: AgentUsageSchema.optional(),
  lastError: z.string().optional(),
  title: z.string().nullable(),
  requiresAttention: z.boolean().optional(),
  attentionReason: z.enum(["finished", "error", "permission"]).nullable().optional(),
  attentionTimestamp: z.string().nullable().optional(),
  parentAgentId: z.string().nullable().optional(),
});

export type AgentSnapshotPayload = z.infer<typeof AgentSnapshotPayloadSchema>;

export type AgentStreamEventPayload = z.infer<
  typeof AgentStreamEventPayloadSchema
>;

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
  requestId: z.string(),
});

export const ListConversationsRequestMessageSchema = z.object({
  type: z.literal("list_conversations_request"),
  requestId: z.string(),
});

export const DeleteConversationRequestMessageSchema = z.object({
  type: z.literal("delete_conversation_request"),
  conversationId: z.string(),
  requestId: z.string(),
});

export const DeleteAgentRequestMessageSchema = z.object({
  type: z.literal("delete_agent_request"),
  agentId: z.string(),
  requestId: z.string(),
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

export const TranscribeAudioRequestSchema = z.object({
  type: z.literal("transcribe_audio_request"),
  audio: z.string(), // base64 encoded
  format: z.string(),
  requestId: z.string(),
});

const GitSetupOptionsSchema = z.object({
  baseBranch: z.string().optional(),
  createNewBranch: z.boolean().optional(),
  newBranchName: z.string().optional(),
  createWorktree: z.boolean().optional(),
  worktreeSlug: z.string().optional(),
});

export type GitSetupOptions = z.infer<typeof GitSetupOptionsSchema>;

export const CreateAgentRequestMessageSchema = z.object({
  type: z.literal("create_agent_request"),
  config: AgentSessionConfigSchema,
  worktreeName: z.string().optional(),
  initialPrompt: z.string().optional(),
  images: z.array(z.object({
    data: z.string(), // base64 encoded image
    mimeType: z.string(), // e.g., "image/jpeg", "image/png"
  })).optional(),
  git: GitSetupOptionsSchema.optional(),
  requestId: z.string(),
});

export const ListProviderModelsRequestMessageSchema = z.object({
  type: z.literal("list_provider_models_request"),
  provider: AgentProviderSchema,
  cwd: z.string().optional(),
  requestId: z.string(),
});

// Legacy alias used by older clients; keep for compatibility

export const GitRepoInfoRequestMessageSchema = z.object({
  type: z.literal("git_repo_info_request"),
  cwd: z.string(),
  requestId: z.string(),
});

export const ResumeAgentRequestMessageSchema = z.object({
  type: z.literal("resume_agent_request"),
  handle: AgentPersistenceHandleSchema,
  overrides: AgentSessionConfigSchema.partial().optional(),
  requestId: z.string(),
});

export const RefreshAgentRequestMessageSchema = z.object({
  type: z.literal("refresh_agent_request"),
  agentId: z.string(),
  requestId: z.string(),
});

export const CancelAgentRequestMessageSchema = z.object({
  type: z.literal("cancel_agent_request"),
  agentId: z.string(),
});

export const RestartServerRequestMessageSchema = z.object({
  type: z.literal("restart_server_request"),
  reason: z.string().optional(),
  requestId: z.string(),
});

export const InitializeAgentRequestMessageSchema = z.object({
  type: z.literal("initialize_agent_request"),
  agentId: z.string(),
  requestId: z.string(),
});

export const InitializeAgentResponseMessageSchema = z.object({
  // Response shares the same type literal as the request for simple requestId matching
  type: z.literal("initialize_agent_request"),
  payload: z.object({
    agentId: z.string(),
    agentStatus: z.string().optional(),
    timelineSize: z.number().optional(),
    requestId: z.string(),
    error: z.string().optional(),
  }),
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
  requestId: z.string(),
});

// Highlighted diff token schema
// Note: style can be a compound class name (e.g., "heading meta") from the syntax highlighter
const HighlightTokenSchema = z.object({
  text: z.string(),
  style: z.string().nullable(),
});

const DiffLineSchema = z.object({
  type: z.enum(["add", "remove", "context", "header"]),
  content: z.string(),
  tokens: z.array(HighlightTokenSchema).optional(),
});

const DiffHunkSchema = z.object({
  oldStart: z.number(),
  oldCount: z.number(),
  newStart: z.number(),
  newCount: z.number(),
  lines: z.array(DiffLineSchema),
});

const ParsedDiffFileSchema = z.object({
  path: z.string(),
  isNew: z.boolean(),
  isDeleted: z.boolean(),
  additions: z.number(),
  deletions: z.number(),
  hunks: z.array(DiffHunkSchema),
  status: z.enum(["ok", "too_large", "binary"]).optional(),
});

export const HighlightedDiffRequestSchema = z.object({
  type: z.literal("highlighted_diff_request"),
  agentId: z.string(),
  requestId: z.string(),
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
  requestId: z.string(),
});

export const FileDownloadTokenRequestSchema = z.object({
  type: z.literal("file_download_token_request"),
  agentId: z.string(),
  path: z.string(),
  requestId: z.string(),
});

export const ClearAgentAttentionMessageSchema = z.object({
  type: z.literal("clear_agent_attention"),
  agentId: z.union([z.string(), z.array(z.string())]),
});

export const ClientHeartbeatMessageSchema = z.object({
  type: z.literal("client_heartbeat"),
  deviceType: z.enum(["web", "mobile"]),
  focusedAgentId: z.string().nullable(),
  lastActivityAt: z.string(),
  appVisible: z.boolean(),
});

export const ListCommandsRequestSchema = z.object({
  type: z.literal("list_commands_request"),
  agentId: z.string(),
  requestId: z.string(),
});

export const ExecuteCommandRequestSchema = z.object({
  type: z.literal("execute_command_request"),
  agentId: z.string(),
  commandName: z.string(),
  args: z.string().optional(),
  requestId: z.string(),
});

export const RegisterPushTokenMessageSchema = z.object({
  type: z.literal("register_push_token"),
  token: z.string(),
});

// ============================================================================
// Terminal Messages
// ============================================================================

export const ListTerminalsRequestSchema = z.object({
  type: z.literal("list_terminals_request"),
  cwd: z.string(),
  requestId: z.string(),
});

export const CreateTerminalRequestSchema = z.object({
  type: z.literal("create_terminal_request"),
  cwd: z.string(),
  name: z.string().optional(),
  requestId: z.string(),
});

export const SubscribeTerminalRequestSchema = z.object({
  type: z.literal("subscribe_terminal_request"),
  terminalId: z.string(),
  requestId: z.string(),
});

export const UnsubscribeTerminalRequestSchema = z.object({
  type: z.literal("unsubscribe_terminal_request"),
  terminalId: z.string(),
});

const TerminalClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input"), data: z.string() }),
  z.object({ type: z.literal("resize"), rows: z.number(), cols: z.number() }),
  z.object({
    type: z.literal("mouse"),
    row: z.number(),
    col: z.number(),
    button: z.number(),
    action: z.enum(["down", "up", "move"]),
  }),
]);

export const TerminalInputSchema = z.object({
  type: z.literal("terminal_input"),
  terminalId: z.string(),
  message: TerminalClientMessageSchema,
});

export const KillTerminalRequestSchema = z.object({
  type: z.literal("kill_terminal_request"),
  terminalId: z.string(),
  requestId: z.string(),
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
  TranscribeAudioRequestSchema,
  CreateAgentRequestMessageSchema,
  ListProviderModelsRequestMessageSchema,
  ResumeAgentRequestMessageSchema,
  RefreshAgentRequestMessageSchema,
  CancelAgentRequestMessageSchema,
  RestartServerRequestMessageSchema,
  InitializeAgentRequestMessageSchema,
  SetAgentModeMessageSchema,
  AgentPermissionResponseMessageSchema,
  GitDiffRequestSchema,
  HighlightedDiffRequestSchema,
  FileExplorerRequestSchema,
  FileDownloadTokenRequestSchema,
  GitRepoInfoRequestMessageSchema,
  ClearAgentAttentionMessageSchema,
  ClientHeartbeatMessageSchema,
  ListCommandsRequestSchema,
  ExecuteCommandRequestSchema,
  RegisterPushTokenMessageSchema,
  ListTerminalsRequestSchema,
  CreateTerminalRequestSchema,
  SubscribeTerminalRequestSchema,
  UnsubscribeTerminalRequestSchema,
  TerminalInputSchema,
  KillTerminalRequestSchema,
]);

export type SessionInboundMessage = z.infer<typeof SessionInboundMessageSchema>;

// ============================================================================
// Session Outbound Messages (Session emits these)
// ============================================================================

export const ActivityLogPayloadSchema = z.object({
  id: z.string(),
  timestamp: z.coerce.date(),
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
    requestId: z.string(), // Echoed back from request for tracking
    avgLogprob: z.number().optional(),
    isLowConfidence: z.boolean().optional(),
    byteLength: z.number().optional(),
    format: z.string().optional(),
    debugRecordingPath: z.string().optional(),
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

const AgentStatusWithRequestSchema = z.object({
  agentId: z.string(),
  requestId: z.string(),
});

const AgentStatusWithTimelineSchema = AgentStatusWithRequestSchema.extend({
  timelineSize: z.number().optional(),
});

export const AgentCreatedStatusPayloadSchema = z
  .object({
    status: z.literal("agent_created"),
  })
  .extend(AgentStatusWithRequestSchema.shape);

export const AgentCreateFailedStatusPayloadSchema = z.object({
  status: z.literal("agent_create_failed"),
  requestId: z.string(),
  error: z.string(),
});

export const AgentResumedStatusPayloadSchema = z
  .object({
    status: z.literal("agent_resumed"),
  })
  .extend(AgentStatusWithTimelineSchema.shape);

export const AgentRefreshedStatusPayloadSchema = z
  .object({
    status: z.literal("agent_refreshed"),
  })
  .extend(AgentStatusWithTimelineSchema.shape);

export const RestartRequestedStatusPayloadSchema = z.object({
  status: z.literal("restart_requested"),
  clientId: z.string(),
  reason: z.string().optional(),
  requestId: z.string(),
});

export const KnownStatusPayloadSchema = z.discriminatedUnion("status", [
  AgentCreatedStatusPayloadSchema,
  AgentCreateFailedStatusPayloadSchema,
  AgentResumedStatusPayloadSchema,
  AgentRefreshedStatusPayloadSchema,
  RestartRequestedStatusPayloadSchema,
]);

export type KnownStatusPayload = z.infer<typeof KnownStatusPayloadSchema>;

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
    requestId: z.string(),
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
    requestId: z.string(),
  }),
});

export const DeleteConversationResponseMessageSchema = z.object({
  type: z.literal("delete_conversation_response"),
  payload: z.object({
    conversationId: z.string(),
    success: z.boolean(),
    error: z.string().optional(),
    requestId: z.string(),
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
    requestId: z.string(),
  }),
});

export const GitDiffResponseSchema = z.object({
  type: z.literal("git_diff_response"),
  payload: z.object({
    agentId: z.string(),
    diff: z.string(),
    error: z.string().nullable(),
    requestId: z.string(),
  }),
});

export const HighlightedDiffResponseSchema = z.object({
  type: z.literal("highlighted_diff_response"),
  payload: z.object({
    agentId: z.string(),
    files: z.array(ParsedDiffFileSchema),
    error: z.string().nullable(),
    requestId: z.string(),
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
    requestId: z.string(),
  }),
});

export const FileDownloadTokenResponseSchema = z.object({
  type: z.literal("file_download_token_response"),
  payload: z.object({
    agentId: z.string(),
    path: z.string(),
    token: z.string().nullable(),
    fileName: z.string().nullable(),
    mimeType: z.string().nullable(),
    size: z.number().nullable(),
    error: z.string().nullable(),
    requestId: z.string(),
  }),
});

const GitBranchInfoSchema = z.object({
  name: z.string(),
  isCurrent: z.boolean(),
});

export const GitRepoInfoResponseSchema = z.object({
  type: z.literal("git_repo_info_response"),
  payload: z.object({
    cwd: z.string(),
    repoRoot: z.string(),
    requestId: z.string(),
    branches: z.array(GitBranchInfoSchema).optional(),
    currentBranch: z.string().nullable().optional(),
    isDirty: z.boolean().optional(),
    error: z.string().nullable().optional(),
  }),
});

export const ListProviderModelsResponseMessageSchema = z.object({
  type: z.literal("list_provider_models_response"),
  payload: z.object({
    provider: AgentProviderSchema,
    models: z.array(AgentModelDefinitionSchema).optional(),
    error: z.string().nullable().optional(),
    fetchedAt: z.string(),
    requestId: z.string(),
  }),
});

const AgentSlashCommandSchema = z.object({
  name: z.string(),
  description: z.string(),
  argumentHint: z.string(),
});

export const ListCommandsResponseSchema = z.object({
  type: z.literal("list_commands_response"),
  payload: z.object({
    agentId: z.string(),
    commands: z.array(AgentSlashCommandSchema),
    error: z.string().nullable(),
    requestId: z.string(),
  }),
});

const AgentCommandResultSchema = z.object({
  text: z.string(),
  timeline: z.array(AgentTimelineItemPayloadSchema),
  usage: AgentUsageSchema.optional(),
});

export const ExecuteCommandResponseSchema = z.object({
  type: z.literal("execute_command_response"),
  payload: z.object({
    agentId: z.string(),
    result: AgentCommandResultSchema.nullable(),
    error: z.string().nullable(),
    requestId: z.string(),
  }),
});

// ============================================================================
// Terminal Outbound Messages
// ============================================================================

const TerminalInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  cwd: z.string(),
});

const TerminalCellSchema = z.object({
  char: z.string(),
  fg: z.number().optional(),
  bg: z.number().optional(),
  fgMode: z.number().optional(),
  bgMode: z.number().optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
});

const TerminalStateSchema = z.object({
  rows: z.number(),
  cols: z.number(),
  grid: z.array(z.array(TerminalCellSchema)),
  scrollback: z.array(z.array(TerminalCellSchema)),
  cursor: z.object({ row: z.number(), col: z.number() }),
});

export const ListTerminalsResponseSchema = z.object({
  type: z.literal("list_terminals_response"),
  payload: z.object({
    cwd: z.string(),
    terminals: z.array(TerminalInfoSchema.omit({ cwd: true })),
    requestId: z.string(),
  }),
});

export const CreateTerminalResponseSchema = z.object({
  type: z.literal("create_terminal_response"),
  payload: z.object({
    terminal: TerminalInfoSchema.nullable(),
    error: z.string().nullable(),
    requestId: z.string(),
  }),
});

export const SubscribeTerminalResponseSchema = z.object({
  type: z.literal("subscribe_terminal_response"),
  payload: z.object({
    terminalId: z.string(),
    state: TerminalStateSchema.nullable(),
    error: z.string().nullable(),
    requestId: z.string(),
  }),
});

export const TerminalOutputSchema = z.object({
  type: z.literal("terminal_output"),
  payload: z.object({
    terminalId: z.string(),
    state: TerminalStateSchema,
  }),
});

export const KillTerminalResponseSchema = z.object({
  type: z.literal("kill_terminal_response"),
  payload: z.object({
    terminalId: z.string(),
    success: z.boolean(),
    requestId: z.string(),
  }),
});

export const SessionOutboundMessageSchema = z.discriminatedUnion("type", [
  ActivityLogMessageSchema,
  AssistantChunkMessageSchema,
  AudioOutputMessageSchema,
  TranscriptionResultMessageSchema,
  StatusMessageSchema,
  InitializeAgentResponseMessageSchema,
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
  GitDiffResponseSchema,
  HighlightedDiffResponseSchema,
  FileExplorerResponseSchema,
  FileDownloadTokenResponseSchema,
  GitRepoInfoResponseSchema,
  ListProviderModelsResponseMessageSchema,
  ListCommandsResponseSchema,
  ExecuteCommandResponseSchema,
  ListTerminalsResponseSchema,
  CreateTerminalResponseSchema,
  SubscribeTerminalResponseSchema,
  TerminalOutputSchema,
  KillTerminalResponseSchema,
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
export type ListProviderModelsResponseMessage = z.infer<
  typeof ListProviderModelsResponseMessageSchema
>;
export type InitializeAgentResponseMessage = z.infer<typeof InitializeAgentResponseMessageSchema>;

// Type exports for payload types
export type ActivityLogPayload = z.infer<typeof ActivityLogPayloadSchema>;

// Type exports for inbound message types
export type UserTextMessage = z.infer<typeof UserTextMessageSchema>;
export type RealtimeAudioChunkMessage = z.infer<typeof RealtimeAudioChunkMessageSchema>;
export type SendAgentMessage = z.infer<typeof SendAgentMessageSchema>;
export type TranscribeAudioRequest = z.infer<typeof TranscribeAudioRequestSchema>;
export type CreateAgentRequestMessage = z.infer<typeof CreateAgentRequestMessageSchema>;
export type ListProviderModelsRequestMessage = z.infer<
  typeof ListProviderModelsRequestMessageSchema
>;
export type ResumeAgentRequestMessage = z.infer<typeof ResumeAgentRequestMessageSchema>;
export type DeleteAgentRequestMessage = z.infer<typeof DeleteAgentRequestMessageSchema>;
export type InitializeAgentRequestMessage = z.infer<typeof InitializeAgentRequestMessageSchema>;
export type SetAgentModeMessage = z.infer<typeof SetAgentModeMessageSchema>;
export type AgentPermissionResponseMessage = z.infer<typeof AgentPermissionResponseMessageSchema>;
export type GitDiffRequest = z.infer<typeof GitDiffRequestSchema>;
export type GitDiffResponse = z.infer<typeof GitDiffResponseSchema>;
export type HighlightedDiffRequest = z.infer<typeof HighlightedDiffRequestSchema>;
export type HighlightedDiffResponse = z.infer<typeof HighlightedDiffResponseSchema>;
export type FileExplorerRequest = z.infer<typeof FileExplorerRequestSchema>;
export type FileExplorerResponse = z.infer<typeof FileExplorerResponseSchema>;
export type FileDownloadTokenRequest = z.infer<typeof FileDownloadTokenRequestSchema>;
export type FileDownloadTokenResponse = z.infer<typeof FileDownloadTokenResponseSchema>;
export type GitRepoInfoResponse = z.infer<typeof GitRepoInfoResponseSchema>;
export type RestartServerRequestMessage = z.infer<typeof RestartServerRequestMessageSchema>;
export type ClearAgentAttentionMessage = z.infer<typeof ClearAgentAttentionMessageSchema>;
export type ClientHeartbeatMessage = z.infer<typeof ClientHeartbeatMessageSchema>;
export type ListCommandsRequest = z.infer<typeof ListCommandsRequestSchema>;
export type ListCommandsResponse = z.infer<typeof ListCommandsResponseSchema>;
export type ExecuteCommandRequest = z.infer<typeof ExecuteCommandRequestSchema>;
export type ExecuteCommandResponse = z.infer<typeof ExecuteCommandResponseSchema>;
export type RegisterPushTokenMessage = z.infer<typeof RegisterPushTokenMessageSchema>;

// Terminal message types
export type ListTerminalsRequest = z.infer<typeof ListTerminalsRequestSchema>;
export type ListTerminalsResponse = z.infer<typeof ListTerminalsResponseSchema>;
export type CreateTerminalRequest = z.infer<typeof CreateTerminalRequestSchema>;
export type CreateTerminalResponse = z.infer<typeof CreateTerminalResponseSchema>;
export type SubscribeTerminalRequest = z.infer<typeof SubscribeTerminalRequestSchema>;
export type SubscribeTerminalResponse = z.infer<typeof SubscribeTerminalResponseSchema>;
export type UnsubscribeTerminalRequest = z.infer<typeof UnsubscribeTerminalRequestSchema>;
export type TerminalInput = z.infer<typeof TerminalInputSchema>;
export type TerminalOutput = z.infer<typeof TerminalOutputSchema>;
export type KillTerminalRequest = z.infer<typeof KillTerminalRequestSchema>;
export type KillTerminalResponse = z.infer<typeof KillTerminalResponseSchema>;

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
