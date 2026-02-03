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

const AgentSelectOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  isDefault: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const AgentModelDefinitionSchema: z.ZodType<AgentModelDefinition> = z.object({
  provider: AgentProviderSchema,
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  isDefault: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional(),
  thinkingOptions: z.array(AgentSelectOptionSchema).optional(),
  defaultThinkingOptionId: z.string().optional(),
  variantOptions: z.array(AgentSelectOptionSchema).optional(),
  defaultVariantOptionId: z.string().optional(),
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

const McpStdioServerConfigSchema = z.object({
  type: z.literal("stdio"),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
});

const McpHttpServerConfigSchema = z.object({
  type: z.literal("http"),
  url: z.string(),
  headers: z.record(z.string()).optional(),
});

const McpSseServerConfigSchema = z.object({
  type: z.literal("sse"),
  url: z.string(),
  headers: z.record(z.string()).optional(),
});

const McpServerConfigSchema = z.discriminatedUnion("type", [
  McpStdioServerConfigSchema,
  McpHttpServerConfigSchema,
  McpSseServerConfigSchema,
]);

const AgentSessionConfigSchema = z.object({
  provider: AgentProviderSchema,
  cwd: z.string(),
  modeId: z.string().optional(),
  model: z.string().optional(),
  thinkingOptionId: z.string().optional(),
  variantId: z.string().optional(),
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
  // Deprecated alias for thinkingOptionId (kept for backward compatibility)
  reasoningEffort: z.string().optional(),
  extra: z
    .object({
      codex: z.record(z.unknown()).optional(),
      claude: z.record(z.unknown()).optional(),
    })
    .partial()
    .optional(),
  mcpServers: z.record(McpServerConfigSchema).optional(),
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
      type: z.literal("provider_event"),
      provider: AgentProviderSchema,
      raw: z.unknown(),
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
  thinkingOptionId: z.string().nullable().optional(),
  variantId: z.string().nullable().optional(),
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
  labels: z.record(z.string()).default({}),
  requiresAttention: z.boolean().optional(),
  attentionReason: z.enum(["finished", "error", "permission"]).nullable().optional(),
  attentionTimestamp: z.string().nullable().optional(),
  archivedAt: z.string().nullable().optional(),
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

export const RequestAgentListMessageSchema = z.object({
  type: z.literal("request_agent_list"),
  requestId: z.string(),
  filter: z.object({
    labels: z.record(z.string()).optional(),
  }).optional(),
});

export const SubscribeAgentUpdatesMessageSchema = z.object({
  type: z.literal("subscribe_agent_updates"),
  subscriptionId: z.string(),
  filter: z.object({
    labels: z.record(z.string()).optional(),
    agentId: z.string().optional(),
  }).optional(),
});

export const UnsubscribeAgentUpdatesMessageSchema = z.object({
  type: z.literal("unsubscribe_agent_updates"),
  subscriptionId: z.string(),
});

export const LoadVoiceConversationRequestMessageSchema = z.object({
  type: z.literal("load_voice_conversation_request"),
  voiceConversationId: z.string(),
  requestId: z.string(),
});

export const ListVoiceConversationsRequestMessageSchema = z.object({
  type: z.literal("list_voice_conversations_request"),
  requestId: z.string(),
});

export const DeleteVoiceConversationRequestMessageSchema = z.object({
  type: z.literal("delete_voice_conversation_request"),
  voiceConversationId: z.string(),
  requestId: z.string(),
});

export const DeleteAgentRequestMessageSchema = z.object({
  type: z.literal("delete_agent_request"),
  agentId: z.string(),
  requestId: z.string(),
});

export const ArchiveAgentRequestMessageSchema = z.object({
  type: z.literal("archive_agent_request"),
  agentId: z.string(),
  requestId: z.string(),
});

export const SetVoiceConversationMessageSchema = z.object({
  type: z.literal("set_voice_conversation"),
  enabled: z.boolean(),
  voiceConversationId: z.string().optional(),
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

// ============================================================================
// Agent RPCs (requestId-correlated)
// ============================================================================

export const FetchAgentsRequestMessageSchema = z.object({
  type: z.literal("fetch_agents_request"),
  requestId: z.string(),
  filter: z
    .object({
      labels: z.record(z.string()).optional(),
    })
    .optional(),
});

export const FetchAgentRequestMessageSchema = z.object({
  type: z.literal("fetch_agent_request"),
  requestId: z.string(),
  /** Accepts full ID, unique prefix, or exact full title (server resolves). */
  agentId: z.string(),
});

export const SendAgentMessageRequestSchema = z.object({
  type: z.literal("send_agent_message_request"),
  requestId: z.string(),
  /** Accepts full ID, unique prefix, or exact full title (server resolves). */
  agentId: z.string(),
  text: z.string(),
  messageId: z.string().optional(), // Client-provided ID for deduplication
  images: z
    .array(
      z.object({
        data: z.string(), // base64 encoded image
        mimeType: z.string(), // e.g., "image/jpeg", "image/png"
      })
    )
    .optional(),
});

export const WaitForFinishRequestSchema = z.object({
  type: z.literal("wait_for_finish_request"),
  requestId: z.string(),
  /** Accepts full ID, unique prefix, or exact full title (server resolves). */
  agentId: z.string(),
  timeoutMs: z.number().int().positive().optional(),
});

// ============================================================================
// Dictation Streaming (lossless, resumable)
// ============================================================================

export const DictationStreamStartMessageSchema = z.object({
  type: z.literal("dictation_stream_start"),
  dictationId: z.string(),
  format: z.string(), // e.g. "audio/pcm;rate=16000;bits=16"
});

export const DictationStreamChunkMessageSchema = z.object({
  type: z.literal("dictation_stream_chunk"),
  dictationId: z.string(),
  seq: z.number().int().nonnegative(),
  audio: z.string(), // base64 encoded chunk
  format: z.string(), // e.g. "audio/pcm;rate=16000;bits=16"
});

export const DictationStreamFinishMessageSchema = z.object({
  type: z.literal("dictation_stream_finish"),
  dictationId: z.string(),
  finalSeq: z.number().int().nonnegative(),
});

export const DictationStreamCancelMessageSchema = z.object({
  type: z.literal("dictation_stream_cancel"),
  dictationId: z.string(),
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
  labels: z.record(z.string()).default({}),
  requestId: z.string(),
});

export const ListProviderModelsRequestMessageSchema = z.object({
  type: z.literal("list_provider_models_request"),
  provider: AgentProviderSchema,
  cwd: z.string().optional(),
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

export const SetAgentModelMessageSchema = z.object({
  type: z.literal("set_agent_model"),
  agentId: z.string(),
  modelId: z.string().nullable(),
});

export const SetAgentThinkingMessageSchema = z.object({
  type: z.literal("set_agent_thinking"),
  agentId: z.string(),
  thinkingOptionId: z.string().nullable(),
});

export const SetAgentVariantMessageSchema = z.object({
  type: z.literal("set_agent_variant"),
  agentId: z.string(),
  variantId: z.string().nullable(),
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

const CheckoutErrorCodeSchema = z.enum([
  "NOT_GIT_REPO",
  "NOT_ALLOWED",
  "MERGE_CONFLICT",
  "UNKNOWN",
]);

const CheckoutErrorSchema = z.object({
  code: CheckoutErrorCodeSchema,
  message: z.string(),
});

const CheckoutDiffCompareSchema = z.object({
  mode: z.enum(["uncommitted", "base"]),
  baseRef: z.string().optional(),
});

export const CheckoutStatusRequestSchema = z.object({
  type: z.literal("checkout_status_request"),
  cwd: z.string(),
  requestId: z.string(),
});

export const CheckoutDiffRequestSchema = z.object({
  type: z.literal("checkout_diff_request"),
  cwd: z.string(),
  compare: CheckoutDiffCompareSchema,
  requestId: z.string(),
});

export const CheckoutCommitRequestSchema = z.object({
  type: z.literal("checkout_commit_request"),
  cwd: z.string(),
  message: z.string().optional(),
  addAll: z.boolean().optional(),
  requestId: z.string(),
});

export const CheckoutMergeRequestSchema = z.object({
  type: z.literal("checkout_merge_request"),
  cwd: z.string(),
  baseRef: z.string().optional(),
  strategy: z.enum(["merge", "squash"]).optional(),
  requireCleanTarget: z.boolean().optional(),
  requestId: z.string(),
});

export const CheckoutMergeFromBaseRequestSchema = z.object({
  type: z.literal("checkout_merge_from_base_request"),
  cwd: z.string(),
  baseRef: z.string().optional(),
  requireCleanTarget: z.boolean().optional(),
  requestId: z.string(),
});

export const CheckoutPushRequestSchema = z.object({
  type: z.literal("checkout_push_request"),
  cwd: z.string(),
  requestId: z.string(),
});

export const CheckoutPrCreateRequestSchema = z.object({
  type: z.literal("checkout_pr_create_request"),
  cwd: z.string(),
  title: z.string().optional(),
  body: z.string().optional(),
  baseRef: z.string().optional(),
  requestId: z.string(),
});

export const CheckoutPrStatusRequestSchema = z.object({
  type: z.literal("checkout_pr_status_request"),
  cwd: z.string(),
  requestId: z.string(),
});

export const ValidateBranchRequestSchema = z.object({
  type: z.literal("validate_branch_request"),
  cwd: z.string(),
  branchName: z.string(),
  requestId: z.string(),
});

export const PaseoWorktreeListRequestSchema = z.object({
  type: z.literal("paseo_worktree_list_request"),
  cwd: z.string().optional(),
  repoRoot: z.string().optional(),
  requestId: z.string(),
});

export const PaseoWorktreeArchiveRequestSchema = z.object({
  type: z.literal("paseo_worktree_archive_request"),
  worktreePath: z.string().optional(),
  repoRoot: z.string().optional(),
  branchName: z.string().optional(),
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

export const ProjectIconRequestSchema = z.object({
  type: z.literal("project_icon_request"),
  cwd: z.string(),
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
  FetchAgentsRequestMessageSchema,
  FetchAgentRequestMessageSchema,
  SubscribeAgentUpdatesMessageSchema,
  UnsubscribeAgentUpdatesMessageSchema,
  LoadVoiceConversationRequestMessageSchema,
  ListVoiceConversationsRequestMessageSchema,
  DeleteVoiceConversationRequestMessageSchema,
  DeleteAgentRequestMessageSchema,
  ArchiveAgentRequestMessageSchema,
  SetVoiceConversationMessageSchema,
  SendAgentMessageRequestSchema,
  WaitForFinishRequestSchema,
  DictationStreamStartMessageSchema,
  DictationStreamChunkMessageSchema,
  DictationStreamFinishMessageSchema,
  DictationStreamCancelMessageSchema,
  CreateAgentRequestMessageSchema,
  ListProviderModelsRequestMessageSchema,
  ResumeAgentRequestMessageSchema,
  RefreshAgentRequestMessageSchema,
  CancelAgentRequestMessageSchema,
  RestartServerRequestMessageSchema,
  InitializeAgentRequestMessageSchema,
  SetAgentModeMessageSchema,
  SetAgentModelMessageSchema,
  SetAgentThinkingMessageSchema,
  SetAgentVariantMessageSchema,
  AgentPermissionResponseMessageSchema,
  GitDiffRequestSchema,
  CheckoutStatusRequestSchema,
  CheckoutDiffRequestSchema,
  CheckoutCommitRequestSchema,
  CheckoutMergeRequestSchema,
  CheckoutMergeFromBaseRequestSchema,
  CheckoutPushRequestSchema,
  CheckoutPrCreateRequestSchema,
  CheckoutPrStatusRequestSchema,
  ValidateBranchRequestSchema,
  PaseoWorktreeListRequestSchema,
  PaseoWorktreeArchiveRequestSchema,
  HighlightedDiffRequestSchema,
  FileExplorerRequestSchema,
  ProjectIconRequestSchema,
  FileDownloadTokenRequestSchema,
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

export const DictationStreamAckMessageSchema = z.object({
  type: z.literal("dictation_stream_ack"),
  payload: z.object({
    dictationId: z.string(),
    ackSeq: z.number().int(),
  }),
});

export const DictationStreamPartialMessageSchema = z.object({
  type: z.literal("dictation_stream_partial"),
  payload: z.object({
    dictationId: z.string(),
    text: z.string(),
  }),
});

export const DictationStreamFinalMessageSchema = z.object({
  type: z.literal("dictation_stream_final"),
  payload: z.object({
    dictationId: z.string(),
    text: z.string(),
    debugRecordingPath: z.string().optional(),
  }),
});

export const DictationStreamErrorMessageSchema = z.object({
  type: z.literal("dictation_stream_error"),
  payload: z.object({
    dictationId: z.string(),
    error: z.string(),
    retryable: z.boolean(),
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
    agent: AgentSnapshotPayloadSchema,
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
    agent: AgentSnapshotPayloadSchema,
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

export const VoiceConversationLoadedMessageSchema = z.object({
  type: z.literal("voice_conversation_loaded"),
  payload: z.object({
    voiceConversationId: z.string(),
    messageCount: z.number(),
    requestId: z.string(),
  }),
});

export const AgentUpdateMessageSchema = z.object({
  type: z.literal("agent_update"),
  payload: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("upsert"),
      agent: AgentSnapshotPayloadSchema,
    }),
    z.object({
      kind: z.literal("remove"),
      agentId: z.string(),
    }),
  ]),
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

export const AgentListMessageSchema = z.object({
  type: z.literal("agent_list"),
  payload: z.object({
    agents: z.array(AgentSnapshotPayloadSchema),
  }),
});

export const FetchAgentsResponseMessageSchema = z.object({
  type: z.literal("fetch_agents_response"),
  payload: z.object({
    requestId: z.string(),
    agents: z.array(AgentSnapshotPayloadSchema),
  }),
});

export const FetchAgentResponseMessageSchema = z.object({
  type: z.literal("fetch_agent_response"),
  payload: z.object({
    requestId: z.string(),
    agent: AgentSnapshotPayloadSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const SendAgentMessageResponseMessageSchema = z.object({
  type: z.literal("send_agent_message_response"),
  payload: z.object({
    requestId: z.string(),
    agentId: z.string(),
    accepted: z.boolean(),
    error: z.string().nullable(),
  }),
});

export const WaitForFinishResponseMessageSchema = z.object({
  type: z.literal("wait_for_finish_response"),
  payload: z.object({
    requestId: z.string(),
    status: z.enum(["idle", "error", "permission", "timeout"]),
    final: AgentSnapshotPayloadSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const ListVoiceConversationsResponseMessageSchema = z.object({
  type: z.literal("list_voice_conversations_response"),
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

export const DeleteVoiceConversationResponseMessageSchema = z.object({
  type: z.literal("delete_voice_conversation_response"),
  payload: z.object({
    voiceConversationId: z.string(),
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

export const AgentArchivedMessageSchema = z.object({
  type: z.literal("agent_archived"),
  payload: z.object({
    agentId: z.string(),
    archivedAt: z.string(),
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

const AheadBehindSchema = z.object({
  ahead: z.number(),
  behind: z.number(),
});

const CheckoutStatusCommonSchema = z.object({
  cwd: z.string(),
  error: CheckoutErrorSchema.nullable(),
  requestId: z.string(),
});

const CheckoutStatusNotGitSchema = CheckoutStatusCommonSchema.extend({
  isGit: z.literal(false),
  isPaseoOwnedWorktree: z.literal(false),
  repoRoot: z.null(),
  currentBranch: z.null(),
  isDirty: z.null(),
  baseRef: z.null(),
  aheadBehind: z.null(),
  aheadOfOrigin: z.null(),
  hasRemote: z.boolean(),
  remoteUrl: z.null(),
});

const CheckoutStatusGitNonPaseoSchema = CheckoutStatusCommonSchema.extend({
  isGit: z.literal(true),
  isPaseoOwnedWorktree: z.literal(false),
  repoRoot: z.string(),
  currentBranch: z.string().nullable(),
  isDirty: z.boolean(),
  baseRef: z.string().nullable(),
  aheadBehind: AheadBehindSchema.nullable(),
  aheadOfOrigin: z.number().nullable(),
  hasRemote: z.boolean(),
  remoteUrl: z.string().nullable(),
});

const CheckoutStatusGitPaseoSchema = CheckoutStatusCommonSchema.extend({
  isGit: z.literal(true),
  isPaseoOwnedWorktree: z.literal(true),
  repoRoot: z.string(),
  mainRepoRoot: z.string(),
  currentBranch: z.string().nullable(),
  isDirty: z.boolean(),
  baseRef: z.string(),
  aheadBehind: AheadBehindSchema.nullable(),
  aheadOfOrigin: z.number().nullable(),
  hasRemote: z.boolean(),
  remoteUrl: z.string().nullable(),
});

export const CheckoutStatusResponseSchema = z.object({
  type: z.literal("checkout_status_response"),
  payload: z.union([
    CheckoutStatusNotGitSchema,
    CheckoutStatusGitNonPaseoSchema,
    CheckoutStatusGitPaseoSchema,
  ]),
});

export const CheckoutDiffResponseSchema = z.object({
  type: z.literal("checkout_diff_response"),
  payload: z.object({
    cwd: z.string(),
    files: z.array(ParsedDiffFileSchema),
    error: CheckoutErrorSchema.nullable(),
    requestId: z.string(),
  }),
});

export const CheckoutCommitResponseSchema = z.object({
  type: z.literal("checkout_commit_response"),
  payload: z.object({
    cwd: z.string(),
    success: z.boolean(),
    error: CheckoutErrorSchema.nullable(),
    requestId: z.string(),
  }),
});

export const CheckoutMergeResponseSchema = z.object({
  type: z.literal("checkout_merge_response"),
  payload: z.object({
    cwd: z.string(),
    success: z.boolean(),
    error: CheckoutErrorSchema.nullable(),
    requestId: z.string(),
  }),
});

export const CheckoutMergeFromBaseResponseSchema = z.object({
  type: z.literal("checkout_merge_from_base_response"),
  payload: z.object({
    cwd: z.string(),
    success: z.boolean(),
    error: CheckoutErrorSchema.nullable(),
    requestId: z.string(),
  }),
});

export const CheckoutPushResponseSchema = z.object({
  type: z.literal("checkout_push_response"),
  payload: z.object({
    cwd: z.string(),
    success: z.boolean(),
    error: CheckoutErrorSchema.nullable(),
    requestId: z.string(),
  }),
});

export const CheckoutPrCreateResponseSchema = z.object({
  type: z.literal("checkout_pr_create_response"),
  payload: z.object({
    cwd: z.string(),
    url: z.string().nullable(),
    number: z.number().nullable(),
    error: CheckoutErrorSchema.nullable(),
    requestId: z.string(),
  }),
});

const CheckoutPrStatusSchema = z.object({
  url: z.string(),
  title: z.string(),
  state: z.string(),
  baseRefName: z.string(),
  headRefName: z.string(),
});

export const CheckoutPrStatusResponseSchema = z.object({
  type: z.literal("checkout_pr_status_response"),
  payload: z.object({
    cwd: z.string(),
    status: CheckoutPrStatusSchema.nullable(),
    error: CheckoutErrorSchema.nullable(),
    requestId: z.string(),
  }),
});

export const ValidateBranchResponseSchema = z.object({
  type: z.literal("validate_branch_response"),
  payload: z.object({
    exists: z.boolean(),
    resolvedRef: z.string().nullable(),
    isRemote: z.boolean(),
    error: z.string().nullable(),
    requestId: z.string(),
  }),
});

const PaseoWorktreeSchema = z.object({
  worktreePath: z.string(),
  branchName: z.string().nullable().optional(),
  head: z.string().nullable().optional(),
});

export const PaseoWorktreeListResponseSchema = z.object({
  type: z.literal("paseo_worktree_list_response"),
  payload: z.object({
    worktrees: z.array(PaseoWorktreeSchema),
    error: CheckoutErrorSchema.nullable(),
    requestId: z.string(),
  }),
});

export const PaseoWorktreeArchiveResponseSchema = z.object({
  type: z.literal("paseo_worktree_archive_response"),
  payload: z.object({
    success: z.boolean(),
    removedAgents: z.array(z.string()).optional(),
    error: CheckoutErrorSchema.nullable(),
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

const ProjectIconSchema = z.object({
  data: z.string(),
  mimeType: z.string(),
});

export const ProjectIconResponseSchema = z.object({
  type: z.literal("project_icon_response"),
  payload: z.object({
    cwd: z.string(),
    icon: ProjectIconSchema.nullable(),
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
  DictationStreamAckMessageSchema,
  DictationStreamPartialMessageSchema,
  DictationStreamFinalMessageSchema,
  DictationStreamErrorMessageSchema,
  StatusMessageSchema,
  InitializeAgentResponseMessageSchema,
  ArtifactMessageSchema,
  VoiceConversationLoadedMessageSchema,
  AgentUpdateMessageSchema,
  AgentStreamMessageSchema,
  AgentStreamSnapshotMessageSchema,
  AgentStatusMessageSchema,
  FetchAgentsResponseMessageSchema,
  FetchAgentResponseMessageSchema,
  SendAgentMessageResponseMessageSchema,
  WaitForFinishResponseMessageSchema,
  ListVoiceConversationsResponseMessageSchema,
  DeleteVoiceConversationResponseMessageSchema,
  AgentPermissionRequestMessageSchema,
  AgentPermissionResolvedMessageSchema,
  AgentDeletedMessageSchema,
  AgentArchivedMessageSchema,
  GitDiffResponseSchema,
  CheckoutStatusResponseSchema,
  CheckoutDiffResponseSchema,
  CheckoutCommitResponseSchema,
  CheckoutMergeResponseSchema,
  CheckoutMergeFromBaseResponseSchema,
  CheckoutPushResponseSchema,
  CheckoutPrCreateResponseSchema,
  CheckoutPrStatusResponseSchema,
  ValidateBranchResponseSchema,
  PaseoWorktreeListResponseSchema,
  PaseoWorktreeArchiveResponseSchema,
  HighlightedDiffResponseSchema,
  FileExplorerResponseSchema,
  ProjectIconResponseSchema,
  FileDownloadTokenResponseSchema,
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
export type VoiceConversationLoadedMessage = z.infer<
  typeof VoiceConversationLoadedMessageSchema
>;
export type AgentUpdateMessage = z.infer<typeof AgentUpdateMessageSchema>;
export type AgentStreamMessage = z.infer<typeof AgentStreamMessageSchema>;
export type AgentStreamSnapshotMessage = z.infer<
  typeof AgentStreamSnapshotMessageSchema
>;
export type AgentStatusMessage = z.infer<typeof AgentStatusMessageSchema>;
export type FetchAgentsResponseMessage = z.infer<
  typeof FetchAgentsResponseMessageSchema
>;
export type FetchAgentResponseMessage = z.infer<
  typeof FetchAgentResponseMessageSchema
>;
export type SendAgentMessageResponseMessage = z.infer<
  typeof SendAgentMessageResponseMessageSchema
>;
export type WaitForFinishResponseMessage = z.infer<
  typeof WaitForFinishResponseMessageSchema
>;
export type ListVoiceConversationsResponseMessage = z.infer<
  typeof ListVoiceConversationsResponseMessageSchema
>;
export type DeleteVoiceConversationResponseMessage = z.infer<
  typeof DeleteVoiceConversationResponseMessageSchema
>;
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
export type FetchAgentsRequestMessage = z.infer<typeof FetchAgentsRequestMessageSchema>;
export type FetchAgentRequestMessage = z.infer<typeof FetchAgentRequestMessageSchema>;
export type SendAgentMessageRequest = z.infer<typeof SendAgentMessageRequestSchema>;
export type WaitForFinishRequest = z.infer<typeof WaitForFinishRequestSchema>;
export type DictationStreamStartMessage = z.infer<typeof DictationStreamStartMessageSchema>;
export type DictationStreamChunkMessage = z.infer<typeof DictationStreamChunkMessageSchema>;
export type DictationStreamFinishMessage = z.infer<typeof DictationStreamFinishMessageSchema>;
export type DictationStreamCancelMessage = z.infer<typeof DictationStreamCancelMessageSchema>;
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
export type CheckoutStatusRequest = z.infer<typeof CheckoutStatusRequestSchema>;
export type CheckoutStatusResponse = z.infer<typeof CheckoutStatusResponseSchema>;
export type CheckoutDiffRequest = z.infer<typeof CheckoutDiffRequestSchema>;
export type CheckoutDiffResponse = z.infer<typeof CheckoutDiffResponseSchema>;
export type CheckoutCommitRequest = z.infer<typeof CheckoutCommitRequestSchema>;
export type CheckoutCommitResponse = z.infer<typeof CheckoutCommitResponseSchema>;
export type CheckoutMergeRequest = z.infer<typeof CheckoutMergeRequestSchema>;
export type CheckoutMergeResponse = z.infer<typeof CheckoutMergeResponseSchema>;
export type CheckoutMergeFromBaseRequest = z.infer<typeof CheckoutMergeFromBaseRequestSchema>;
export type CheckoutMergeFromBaseResponse = z.infer<typeof CheckoutMergeFromBaseResponseSchema>;
export type CheckoutPushRequest = z.infer<typeof CheckoutPushRequestSchema>;
export type CheckoutPushResponse = z.infer<typeof CheckoutPushResponseSchema>;
export type CheckoutPrCreateRequest = z.infer<typeof CheckoutPrCreateRequestSchema>;
export type CheckoutPrCreateResponse = z.infer<typeof CheckoutPrCreateResponseSchema>;
export type CheckoutPrStatusRequest = z.infer<typeof CheckoutPrStatusRequestSchema>;
export type CheckoutPrStatusResponse = z.infer<typeof CheckoutPrStatusResponseSchema>;
export type ValidateBranchRequest = z.infer<typeof ValidateBranchRequestSchema>;
export type ValidateBranchResponse = z.infer<typeof ValidateBranchResponseSchema>;
export type PaseoWorktreeListRequest = z.infer<typeof PaseoWorktreeListRequestSchema>;
export type PaseoWorktreeListResponse = z.infer<typeof PaseoWorktreeListResponseSchema>;
export type PaseoWorktreeArchiveRequest = z.infer<typeof PaseoWorktreeArchiveRequestSchema>;
export type PaseoWorktreeArchiveResponse = z.infer<typeof PaseoWorktreeArchiveResponseSchema>;
export type HighlightedDiffRequest = z.infer<typeof HighlightedDiffRequestSchema>;
export type HighlightedDiffResponse = z.infer<typeof HighlightedDiffResponseSchema>;
export type FileExplorerRequest = z.infer<typeof FileExplorerRequestSchema>;
export type FileExplorerResponse = z.infer<typeof FileExplorerResponseSchema>;
export type ProjectIconRequest = z.infer<typeof ProjectIconRequestSchema>;
export type ProjectIconResponse = z.infer<typeof ProjectIconResponseSchema>;
export type ProjectIcon = z.infer<typeof ProjectIconSchema>;
export type FileDownloadTokenRequest = z.infer<typeof FileDownloadTokenRequestSchema>;
export type FileDownloadTokenResponse = z.infer<typeof FileDownloadTokenResponseSchema>;
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
