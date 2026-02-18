import { z } from 'zod'
import { AGENT_LIFECYCLE_STATUSES } from './agent-lifecycle.js'
import { AgentProviderSchema } from '../server/agent/provider-manifest.js'
import type {
  AgentCapabilityFlags,
  AgentModelDefinition,
  AgentMode,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentRuntimeInfo,
  AgentTimelineItem,
  ToolCallDetail,
  ToolCallTimelineItem,
  AgentUsage,
} from '../server/agent/agent-sdk-types.js'

export const AgentStatusSchema = z.enum(AGENT_LIFECYCLE_STATUSES)

const AgentModeSchema: z.ZodType<AgentMode> = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
})

const AgentSelectOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  isDefault: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional(),
})

const AgentModelDefinitionSchema: z.ZodType<AgentModelDefinition> = z.object({
  provider: AgentProviderSchema,
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  isDefault: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional(),
  thinkingOptions: z.array(AgentSelectOptionSchema).optional(),
  defaultThinkingOptionId: z.string().optional(),
})

const AgentCapabilityFlagsSchema: z.ZodType<AgentCapabilityFlags> = z.object({
  supportsStreaming: z.boolean(),
  supportsSessionPersistence: z.boolean(),
  supportsDynamicModes: z.boolean(),
  supportsMcpServers: z.boolean(),
  supportsReasoningStream: z.boolean(),
  supportsToolInvocations: z.boolean(),
})

const AgentUsageSchema: z.ZodType<AgentUsage> = z.object({
  inputTokens: z.number().optional(),
  cachedInputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  totalCostUsd: z.number().optional(),
})

const McpStdioServerConfigSchema = z.object({
  type: z.literal('stdio'),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
})

const McpHttpServerConfigSchema = z.object({
  type: z.literal('http'),
  url: z.string(),
  headers: z.record(z.string()).optional(),
})

const McpSseServerConfigSchema = z.object({
  type: z.literal('sse'),
  url: z.string(),
  headers: z.record(z.string()).optional(),
})

const McpServerConfigSchema = z.discriminatedUnion('type', [
  McpStdioServerConfigSchema,
  McpHttpServerConfigSchema,
  McpSseServerConfigSchema,
])

const AgentSessionConfigSchema = z.object({
  provider: AgentProviderSchema,
  cwd: z.string(),
  modeId: z.string().optional(),
  model: z.string().optional(),
  thinkingOptionId: z.string().optional(),
  title: z.string().trim().min(1).max(40).optional().nullable(),
  approvalPolicy: z.string().optional(),
  sandboxMode: z.string().optional(),
  networkAccess: z.boolean().optional(),
  webSearch: z.boolean().optional(),
  extra: z
    .object({
      codex: z.record(z.unknown()).optional(),
      claude: z.record(z.unknown()).optional(),
    })
    .partial()
    .optional(),
  systemPrompt: z.string().optional(),
  mcpServers: z.record(McpServerConfigSchema).optional(),
})

const AgentPermissionUpdateSchema = z.record(z.unknown())

export const AgentPermissionResponseSchema: z.ZodType<AgentPermissionResponse> = z.union([
  z.object({
    behavior: z.literal('allow'),
    updatedInput: z.record(z.unknown()).optional(),
    updatedPermissions: z.array(AgentPermissionUpdateSchema).optional(),
  }),
  z.object({
    behavior: z.literal('deny'),
    message: z.string().optional(),
    interrupt: z.boolean().optional(),
  }),
])

export const AgentPermissionRequestPayloadSchema: z.ZodType<AgentPermissionRequest> = z.object({
  id: z.string(),
  provider: AgentProviderSchema,
  name: z.string(),
  kind: z.enum(['tool', 'plan', 'question', 'mode', 'other']),
  title: z.string().optional(),
  description: z.string().optional(),
  input: z.record(z.unknown()).optional(),
  suggestions: z.array(AgentPermissionUpdateSchema).optional(),
  metadata: z.record(z.unknown()).optional(),
})

const UnknownValueSchema = z.union([
  z.null(),
  z.boolean(),
  z.number(),
  z.string(),
  z.array(z.unknown()),
  z.object({}).passthrough(),
])

const NonNullUnknownSchema = z.union([
  z.boolean(),
  z.number(),
  z.string(),
  z.array(z.unknown()),
  z.object({}).passthrough(),
])

const ToolCallDetailPayloadSchema: z.ZodType<ToolCallDetail> = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('shell'),
    command: z.string(),
    cwd: z.string().optional(),
    output: z.string().optional(),
    exitCode: z.number().nullable().optional(),
  }),
  z.object({
    type: z.literal('read'),
    filePath: z.string(),
    content: z.string().optional(),
    offset: z.number().optional(),
    limit: z.number().optional(),
  }),
  z.object({
    type: z.literal('edit'),
    filePath: z.string(),
    oldString: z.string().optional(),
    newString: z.string().optional(),
    unifiedDiff: z.string().optional(),
  }),
  z.object({
    type: z.literal('write'),
    filePath: z.string(),
    content: z.string().optional(),
  }),
  z.object({
    type: z.literal('search'),
    query: z.string(),
  }),
  z.object({
    type: z.literal('worktree_setup'),
    worktreePath: z.string(),
    branchName: z.string(),
    log: z.string(),
    commands: z.array(
      z.object({
        index: z.number().int().positive(),
        command: z.string(),
        cwd: z.string(),
        status: z.enum(['running', 'completed', 'failed']),
        exitCode: z.number().nullable(),
        durationMs: z.number().nonnegative().optional(),
      })
    ),
    truncated: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('unknown'),
    input: UnknownValueSchema,
    output: UnknownValueSchema,
  }),
])

const ToolCallBasePayloadSchema = z
  .object({
    type: z.literal('tool_call'),
    callId: z.string(),
    name: z.string(),
    detail: ToolCallDetailPayloadSchema,
    metadata: z.record(z.unknown()).optional(),
  })
  .strict()

const ToolCallRunningPayloadSchema = ToolCallBasePayloadSchema.extend({
  status: z.literal('running'),
  error: z.null(),
})

const ToolCallCompletedPayloadSchema = ToolCallBasePayloadSchema.extend({
  status: z.literal('completed'),
  error: z.null(),
})

const ToolCallFailedPayloadSchema = ToolCallBasePayloadSchema.extend({
  status: z.literal('failed'),
  error: NonNullUnknownSchema,
})

const ToolCallCanceledPayloadSchema = ToolCallBasePayloadSchema.extend({
  status: z.literal('canceled'),
  error: z.null(),
})

const ToolCallTimelineItemPayloadSchema: z.ZodType<ToolCallTimelineItem, z.ZodTypeDef, unknown> =
  z.union([
    ToolCallRunningPayloadSchema,
    ToolCallCompletedPayloadSchema,
    ToolCallFailedPayloadSchema,
    ToolCallCanceledPayloadSchema,
  ])

export const AgentTimelineItemPayloadSchema: z.ZodType<AgentTimelineItem, z.ZodTypeDef, unknown> =
  z.union([
    z.object({
      type: z.literal('user_message'),
      text: z.string(),
      messageId: z.string().optional(),
    }),
    z.object({
      type: z.literal('assistant_message'),
      text: z.string(),
    }),
    z.object({
      type: z.literal('reasoning'),
      text: z.string(),
    }),
    ToolCallTimelineItemPayloadSchema,
    z.object({
      type: z.literal('todo'),
      items: z.array(
        z.object({
          text: z.string(),
          completed: z.boolean(),
        })
      ),
    }),
    z.object({
      type: z.literal('error'),
      message: z.string(),
    }),
    z.object({
      type: z.literal('compaction'),
      status: z.enum(['loading', 'completed']),
      trigger: z.enum(['auto', 'manual']).optional(),
      preTokens: z.number().optional(),
    }),
  ])

export const AgentStreamEventPayloadSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('thread_started'),
    sessionId: z.string(),
    provider: AgentProviderSchema,
  }),
  z.object({
    type: z.literal('turn_started'),
    provider: AgentProviderSchema,
  }),
  z.object({
    type: z.literal('turn_completed'),
    provider: AgentProviderSchema,
    usage: AgentUsageSchema.optional(),
  }),
  z.object({
    type: z.literal('turn_failed'),
    provider: AgentProviderSchema,
    error: z.string(),
  }),
  z.object({
    type: z.literal('turn_canceled'),
    provider: AgentProviderSchema,
    reason: z.string(),
  }),
  z.object({
    type: z.literal('timeline'),
    provider: AgentProviderSchema,
    item: AgentTimelineItemPayloadSchema,
  }),
  z.object({
    type: z.literal('permission_requested'),
    provider: AgentProviderSchema,
    request: AgentPermissionRequestPayloadSchema,
  }),
  z.object({
    type: z.literal('permission_resolved'),
    provider: AgentProviderSchema,
    requestId: z.string(),
    resolution: AgentPermissionResponseSchema,
  }),
  z.object({
    type: z.literal('attention_required'),
    provider: AgentProviderSchema,
    reason: z.enum(['finished', 'error', 'permission']),
    timestamp: z.string(),
    shouldNotify: z.boolean(),
    notification: z
      .object({
        title: z.string(),
        body: z.string(),
        data: z.object({
          serverId: z.string(),
          agentId: z.string(),
          reason: z.enum(['finished', 'error', 'permission']),
        }),
      })
      .optional(),
  }),
])

const AgentPersistenceHandleSchema: z.ZodType<AgentPersistenceHandle | null> = z
  .object({
    provider: AgentProviderSchema,
    sessionId: z.string(),
    nativeHandle: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .nullable()

const AgentRuntimeInfoSchema: z.ZodType<AgentRuntimeInfo> = z.object({
  provider: AgentProviderSchema,
  sessionId: z.string().nullable(),
  model: z.string().nullable().optional(),
  modeId: z.string().nullable().optional(),
  extra: z.record(z.unknown()).optional(),
})

export const AgentSnapshotPayloadSchema = z.object({
  id: z.string(),
  provider: AgentProviderSchema,
  cwd: z.string(),
  model: z.string().nullable(),
  thinkingOptionId: z.string().nullable().optional(),
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
  attentionReason: z.enum(['finished', 'error', 'permission']).nullable().optional(),
  attentionTimestamp: z.string().nullable().optional(),
  archivedAt: z.string().nullable().optional(),
})

export type AgentSnapshotPayload = z.infer<typeof AgentSnapshotPayloadSchema>

export type AgentStreamEventPayload = z.infer<typeof AgentStreamEventPayloadSchema>

// ============================================================================
// Session Inbound Messages (Session receives these)
// ============================================================================

export const VoiceAudioChunkMessageSchema = z.object({
  type: z.literal('voice_audio_chunk'),
  audio: z.string(), // base64 encoded
  format: z.string(),
  isLast: z.boolean(),
})

export const AbortRequestMessageSchema = z.object({
  type: z.literal('abort_request'),
})

export const AudioPlayedMessageSchema = z.object({
  type: z.literal('audio_played'),
  id: z.string(),
})

const AgentDirectoryFilterSchema = z.object({
  labels: z.record(z.string()).optional(),
  projectKeys: z.array(z.string()).optional(),
  statuses: z.array(AgentStatusSchema).optional(),
  includeArchived: z.boolean().optional(),
  requiresAttention: z.boolean().optional(),
})

export const DeleteAgentRequestMessageSchema = z.object({
  type: z.literal('delete_agent_request'),
  agentId: z.string(),
  requestId: z.string(),
})

export const ArchiveAgentRequestMessageSchema = z.object({
  type: z.literal('archive_agent_request'),
  agentId: z.string(),
  requestId: z.string(),
})

export const UpdateAgentRequestMessageSchema = z.object({
  type: z.literal('update_agent_request'),
  agentId: z.string(),
  name: z.string().optional(),
  labels: z.record(z.string()).optional(),
  requestId: z.string(),
})

export const SetVoiceModeMessageSchema = z.object({
  type: z.literal('set_voice_mode'),
  enabled: z.boolean(),
  agentId: z.string().optional(),
  requestId: z.string().optional(),
})

export const SendAgentMessageSchema = z.object({
  type: z.literal('send_agent_message'),
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
})

// ============================================================================
// Agent RPCs (requestId-correlated)
// ============================================================================

export const FetchAgentsRequestMessageSchema = z.object({
  type: z.literal('fetch_agents_request'),
  requestId: z.string(),
  filter: AgentDirectoryFilterSchema.optional(),
  sort: z
    .array(
      z.object({
        key: z.enum(['status_priority', 'created_at', 'updated_at', 'title']),
        direction: z.enum(['asc', 'desc']),
      })
    )
    .optional(),
  page: z
    .object({
      limit: z.number().int().positive().max(1000),
      cursor: z.string().min(1).optional(),
    })
    .optional(),
  subscribe: z
    .object({
      subscriptionId: z.string().optional(),
    })
    .optional(),
})

export const FetchAgentRequestMessageSchema = z.object({
  type: z.literal('fetch_agent_request'),
  requestId: z.string(),
  /** Accepts full ID, unique prefix, or exact full title (server resolves). */
  agentId: z.string(),
})

export const SendAgentMessageRequestSchema = z.object({
  type: z.literal('send_agent_message_request'),
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
})

export const WaitForFinishRequestSchema = z.object({
  type: z.literal('wait_for_finish_request'),
  requestId: z.string(),
  /** Accepts full ID, unique prefix, or exact full title (server resolves). */
  agentId: z.string(),
  timeoutMs: z.number().int().positive().optional(),
})

// ============================================================================
// Dictation Streaming (lossless, resumable)
// ============================================================================

export const DictationStreamStartMessageSchema = z.object({
  type: z.literal('dictation_stream_start'),
  dictationId: z.string(),
  format: z.string(), // e.g. "audio/pcm;rate=16000;bits=16"
})

export const DictationStreamChunkMessageSchema = z.object({
  type: z.literal('dictation_stream_chunk'),
  dictationId: z.string(),
  seq: z.number().int().nonnegative(),
  audio: z.string(), // base64 encoded chunk
  format: z.string(), // e.g. "audio/pcm;rate=16000;bits=16"
})

export const DictationStreamFinishMessageSchema = z.object({
  type: z.literal('dictation_stream_finish'),
  dictationId: z.string(),
  finalSeq: z.number().int().nonnegative(),
})

export const DictationStreamCancelMessageSchema = z.object({
  type: z.literal('dictation_stream_cancel'),
  dictationId: z.string(),
})

const GitSetupOptionsSchema = z.object({
  baseBranch: z.string().optional(),
  createNewBranch: z.boolean().optional(),
  newBranchName: z.string().optional(),
  createWorktree: z.boolean().optional(),
  worktreeSlug: z.string().optional(),
})

export type GitSetupOptions = z.infer<typeof GitSetupOptionsSchema>

export const CreateAgentRequestMessageSchema = z.object({
  type: z.literal('create_agent_request'),
  config: AgentSessionConfigSchema,
  worktreeName: z.string().optional(),
  initialPrompt: z.string().optional(),
  outputSchema: z.record(z.unknown()).optional(),
  images: z
    .array(
      z.object({
        data: z.string(), // base64 encoded image
        mimeType: z.string(), // e.g., "image/jpeg", "image/png"
      })
    )
    .optional(),
  git: GitSetupOptionsSchema.optional(),
  labels: z.record(z.string()).default({}),
  requestId: z.string(),
})

export const ListProviderModelsRequestMessageSchema = z.object({
  type: z.literal('list_provider_models_request'),
  provider: AgentProviderSchema,
  cwd: z.string().optional(),
  requestId: z.string(),
})

export const ListAvailableProvidersRequestMessageSchema = z.object({
  type: z.literal('list_available_providers_request'),
  requestId: z.string(),
})

export const SpeechModelsListRequestSchema = z.object({
  type: z.literal('speech_models_list_request'),
  requestId: z.string(),
})

export const SpeechModelsDownloadRequestSchema = z.object({
  type: z.literal('speech_models_download_request'),
  modelIds: z.array(z.string()).optional(),
  requestId: z.string(),
})

export const ResumeAgentRequestMessageSchema = z.object({
  type: z.literal('resume_agent_request'),
  handle: AgentPersistenceHandleSchema,
  overrides: AgentSessionConfigSchema.partial().optional(),
  requestId: z.string(),
})

export const RefreshAgentRequestMessageSchema = z.object({
  type: z.literal('refresh_agent_request'),
  agentId: z.string(),
  requestId: z.string(),
})

export const CancelAgentRequestMessageSchema = z.object({
  type: z.literal('cancel_agent_request'),
  agentId: z.string(),
})

export const RestartServerRequestMessageSchema = z.object({
  type: z.literal('restart_server_request'),
  reason: z.string().optional(),
  requestId: z.string(),
})

export const AgentTimelineCursorSchema = z.object({
  epoch: z.string(),
  seq: z.number().int().nonnegative(),
})

export const FetchAgentTimelineRequestMessageSchema = z.object({
  type: z.literal('fetch_agent_timeline_request'),
  agentId: z.string(),
  requestId: z.string(),
  direction: z.enum(['tail', 'before', 'after']).optional(),
  cursor: AgentTimelineCursorSchema.optional(),
  // 0 means "all matching rows for this query window".
  limit: z.number().int().nonnegative().optional(),
  // Default should be projected for app timeline loading.
  projection: z.enum(['projected', 'canonical']).optional(),
})

export const SetAgentModeRequestMessageSchema = z.object({
  type: z.literal('set_agent_mode_request'),
  agentId: z.string(),
  modeId: z.string(),
  requestId: z.string(),
})

export const SetAgentModeResponseMessageSchema = z.object({
  type: z.literal('set_agent_mode_response'),
  payload: z.object({
    requestId: z.string(),
    agentId: z.string(),
    accepted: z.boolean(),
    error: z.string().nullable(),
  }),
})

export const SetAgentModelRequestMessageSchema = z.object({
  type: z.literal('set_agent_model_request'),
  agentId: z.string(),
  modelId: z.string().nullable(),
  requestId: z.string(),
})

export const SetAgentModelResponseMessageSchema = z.object({
  type: z.literal('set_agent_model_response'),
  payload: z.object({
    requestId: z.string(),
    agentId: z.string(),
    accepted: z.boolean(),
    error: z.string().nullable(),
  }),
})

export const SetAgentThinkingRequestMessageSchema = z.object({
  type: z.literal('set_agent_thinking_request'),
  agentId: z.string(),
  thinkingOptionId: z.string().nullable(),
  requestId: z.string(),
})

export const SetAgentThinkingResponseMessageSchema = z.object({
  type: z.literal('set_agent_thinking_response'),
  payload: z.object({
    requestId: z.string(),
    agentId: z.string(),
    accepted: z.boolean(),
    error: z.string().nullable(),
  }),
})

export const UpdateAgentResponseMessageSchema = z.object({
  type: z.literal('update_agent_response'),
  payload: z.object({
    requestId: z.string(),
    agentId: z.string(),
    accepted: z.boolean(),
    error: z.string().nullable(),
  }),
})

export const SetVoiceModeResponseMessageSchema = z.object({
  type: z.literal('set_voice_mode_response'),
  payload: z.object({
    requestId: z.string(),
    enabled: z.boolean(),
    agentId: z.string().nullable(),
    accepted: z.boolean(),
    error: z.string().nullable(),
    reasonCode: z.string().optional(),
    retryable: z.boolean().optional(),
    missingModelIds: z.array(z.string()).optional(),
  }),
})

export const AgentPermissionResponseMessageSchema = z.object({
  type: z.literal('agent_permission_response'),
  agentId: z.string(),
  requestId: z.string(),
  response: AgentPermissionResponseSchema,
})

const CheckoutErrorCodeSchema = z.enum(['NOT_GIT_REPO', 'NOT_ALLOWED', 'MERGE_CONFLICT', 'UNKNOWN'])

const CheckoutErrorSchema = z.object({
  code: CheckoutErrorCodeSchema,
  message: z.string(),
})

const CheckoutDiffCompareSchema = z.object({
  mode: z.enum(['uncommitted', 'base']),
  baseRef: z.string().optional(),
})

export const CheckoutStatusRequestSchema = z.object({
  type: z.literal('checkout_status_request'),
  cwd: z.string(),
  requestId: z.string(),
})

export const SubscribeCheckoutDiffRequestSchema = z.object({
  type: z.literal('subscribe_checkout_diff_request'),
  subscriptionId: z.string(),
  cwd: z.string(),
  compare: CheckoutDiffCompareSchema,
  requestId: z.string(),
})

export const UnsubscribeCheckoutDiffRequestSchema = z.object({
  type: z.literal('unsubscribe_checkout_diff_request'),
  subscriptionId: z.string(),
})

export const CheckoutCommitRequestSchema = z.object({
  type: z.literal('checkout_commit_request'),
  cwd: z.string(),
  message: z.string().optional(),
  addAll: z.boolean().optional(),
  requestId: z.string(),
})

export const CheckoutMergeRequestSchema = z.object({
  type: z.literal('checkout_merge_request'),
  cwd: z.string(),
  baseRef: z.string().optional(),
  strategy: z.enum(['merge', 'squash']).optional(),
  requireCleanTarget: z.boolean().optional(),
  requestId: z.string(),
})

export const CheckoutMergeFromBaseRequestSchema = z.object({
  type: z.literal('checkout_merge_from_base_request'),
  cwd: z.string(),
  baseRef: z.string().optional(),
  requireCleanTarget: z.boolean().optional(),
  requestId: z.string(),
})

export const CheckoutPushRequestSchema = z.object({
  type: z.literal('checkout_push_request'),
  cwd: z.string(),
  requestId: z.string(),
})

export const CheckoutPrCreateRequestSchema = z.object({
  type: z.literal('checkout_pr_create_request'),
  cwd: z.string(),
  title: z.string().optional(),
  body: z.string().optional(),
  baseRef: z.string().optional(),
  requestId: z.string(),
})

export const CheckoutPrStatusRequestSchema = z.object({
  type: z.literal('checkout_pr_status_request'),
  cwd: z.string(),
  requestId: z.string(),
})

export const ValidateBranchRequestSchema = z.object({
  type: z.literal('validate_branch_request'),
  cwd: z.string(),
  branchName: z.string(),
  requestId: z.string(),
})

export const BranchSuggestionsRequestSchema = z.object({
  type: z.literal('branch_suggestions_request'),
  cwd: z.string(),
  query: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  requestId: z.string(),
})

export const DirectorySuggestionsRequestSchema = z.object({
  type: z.literal('directory_suggestions_request'),
  query: z.string(),
  cwd: z.string().optional(),
  includeFiles: z.boolean().optional(),
  includeDirectories: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  requestId: z.string(),
})

export const PaseoWorktreeListRequestSchema = z.object({
  type: z.literal('paseo_worktree_list_request'),
  cwd: z.string().optional(),
  repoRoot: z.string().optional(),
  requestId: z.string(),
})

export const PaseoWorktreeArchiveRequestSchema = z.object({
  type: z.literal('paseo_worktree_archive_request'),
  worktreePath: z.string().optional(),
  repoRoot: z.string().optional(),
  branchName: z.string().optional(),
  requestId: z.string(),
})

// Highlighted diff token schema
// Note: style can be a compound class name (e.g., "heading meta") from the syntax highlighter
const HighlightTokenSchema = z.object({
  text: z.string(),
  style: z.string().nullable(),
})

const DiffLineSchema = z.object({
  type: z.enum(['add', 'remove', 'context', 'header']),
  content: z.string(),
  tokens: z.array(HighlightTokenSchema).optional(),
})

const DiffHunkSchema = z.object({
  oldStart: z.number(),
  oldCount: z.number(),
  newStart: z.number(),
  newCount: z.number(),
  lines: z.array(DiffLineSchema),
})

const ParsedDiffFileSchema = z.object({
  path: z.string(),
  isNew: z.boolean(),
  isDeleted: z.boolean(),
  additions: z.number(),
  deletions: z.number(),
  hunks: z.array(DiffHunkSchema),
  status: z.enum(['ok', 'too_large', 'binary']).optional(),
})

const FileExplorerEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.enum(['file', 'directory']),
  size: z.number(),
  modifiedAt: z.string(),
})

const FileExplorerFileSchema = z.object({
  path: z.string(),
  kind: z.enum(['text', 'image', 'binary']),
  encoding: z.enum(['utf-8', 'base64', 'none']),
  content: z.string().optional(),
  mimeType: z.string().optional(),
  size: z.number(),
  modifiedAt: z.string(),
})

const FileExplorerDirectorySchema = z.object({
  path: z.string(),
  entries: z.array(FileExplorerEntrySchema),
})

export const FileExplorerRequestSchema = z.object({
  type: z.literal('file_explorer_request'),
  agentId: z.string(),
  path: z.string().optional(),
  mode: z.enum(['list', 'file']),
  requestId: z.string(),
})

export const ProjectIconRequestSchema = z.object({
  type: z.literal('project_icon_request'),
  cwd: z.string(),
  requestId: z.string(),
})

export const FileDownloadTokenRequestSchema = z.object({
  type: z.literal('file_download_token_request'),
  agentId: z.string(),
  path: z.string(),
  requestId: z.string(),
})

export const ClearAgentAttentionMessageSchema = z.object({
  type: z.literal('clear_agent_attention'),
  agentId: z.union([z.string(), z.array(z.string())]),
})

export const ClientHeartbeatMessageSchema = z.object({
  type: z.literal('client_heartbeat'),
  deviceType: z.enum(['web', 'mobile']),
  focusedAgentId: z.string().nullable(),
  lastActivityAt: z.string(),
  appVisible: z.boolean(),
  appVisibilityChangedAt: z.string().optional(),
})

export const PingMessageSchema = z.object({
  type: z.literal('ping'),
  requestId: z.string(),
  clientSentAt: z.number().int().optional(),
})

const ListCommandsDraftConfigSchema = z.object({
  provider: AgentProviderSchema,
  cwd: z.string(),
  modeId: z.string().optional(),
  model: z.string().optional(),
  thinkingOptionId: z.string().optional(),
})

export const ListCommandsRequestSchema = z.object({
  type: z.literal('list_commands_request'),
  agentId: z.string(),
  draftConfig: ListCommandsDraftConfigSchema.optional(),
  requestId: z.string(),
})

export const RegisterPushTokenMessageSchema = z.object({
  type: z.literal('register_push_token'),
  token: z.string(),
})

// ============================================================================
// Terminal Messages
// ============================================================================

export const ListTerminalsRequestSchema = z.object({
  type: z.literal('list_terminals_request'),
  cwd: z.string(),
  requestId: z.string(),
})

export const SubscribeTerminalsRequestSchema = z.object({
  type: z.literal('subscribe_terminals_request'),
  cwd: z.string(),
})

export const UnsubscribeTerminalsRequestSchema = z.object({
  type: z.literal('unsubscribe_terminals_request'),
  cwd: z.string(),
})

export const CreateTerminalRequestSchema = z.object({
  type: z.literal('create_terminal_request'),
  cwd: z.string(),
  name: z.string().optional(),
  requestId: z.string(),
})

export const SubscribeTerminalRequestSchema = z.object({
  type: z.literal('subscribe_terminal_request'),
  terminalId: z.string(),
  requestId: z.string(),
})

export const UnsubscribeTerminalRequestSchema = z.object({
  type: z.literal('unsubscribe_terminal_request'),
  terminalId: z.string(),
})

const TerminalClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string() }),
  z.object({ type: z.literal('resize'), rows: z.number(), cols: z.number() }),
  z.object({
    type: z.literal('mouse'),
    row: z.number(),
    col: z.number(),
    button: z.number(),
    action: z.enum(['down', 'up', 'move']),
  }),
])

export const TerminalInputSchema = z.object({
  type: z.literal('terminal_input'),
  terminalId: z.string(),
  message: TerminalClientMessageSchema,
})

export const KillTerminalRequestSchema = z.object({
  type: z.literal('kill_terminal_request'),
  terminalId: z.string(),
  requestId: z.string(),
})

export const AttachTerminalStreamRequestSchema = z.object({
  type: z.literal('attach_terminal_stream_request'),
  terminalId: z.string(),
  resumeOffset: z.number().int().nonnegative().optional(),
  rows: z.number().int().positive().optional(),
  cols: z.number().int().positive().optional(),
  requestId: z.string(),
})

export const DetachTerminalStreamRequestSchema = z.object({
  type: z.literal('detach_terminal_stream_request'),
  streamId: z.number().int().nonnegative(),
  requestId: z.string(),
})

export const SessionInboundMessageSchema = z.discriminatedUnion('type', [
  VoiceAudioChunkMessageSchema,
  AbortRequestMessageSchema,
  AudioPlayedMessageSchema,
  FetchAgentsRequestMessageSchema,
  FetchAgentRequestMessageSchema,
  DeleteAgentRequestMessageSchema,
  ArchiveAgentRequestMessageSchema,
  UpdateAgentRequestMessageSchema,
  SetVoiceModeMessageSchema,
  SendAgentMessageRequestSchema,
  WaitForFinishRequestSchema,
  DictationStreamStartMessageSchema,
  DictationStreamChunkMessageSchema,
  DictationStreamFinishMessageSchema,
  DictationStreamCancelMessageSchema,
  CreateAgentRequestMessageSchema,
  ListProviderModelsRequestMessageSchema,
  ListAvailableProvidersRequestMessageSchema,
  SpeechModelsListRequestSchema,
  SpeechModelsDownloadRequestSchema,
  ResumeAgentRequestMessageSchema,
  RefreshAgentRequestMessageSchema,
  CancelAgentRequestMessageSchema,
  RestartServerRequestMessageSchema,
  FetchAgentTimelineRequestMessageSchema,
  SetAgentModeRequestMessageSchema,
  SetAgentModelRequestMessageSchema,
  SetAgentThinkingRequestMessageSchema,
  AgentPermissionResponseMessageSchema,
  CheckoutStatusRequestSchema,
  SubscribeCheckoutDiffRequestSchema,
  UnsubscribeCheckoutDiffRequestSchema,
  CheckoutCommitRequestSchema,
  CheckoutMergeRequestSchema,
  CheckoutMergeFromBaseRequestSchema,
  CheckoutPushRequestSchema,
  CheckoutPrCreateRequestSchema,
  CheckoutPrStatusRequestSchema,
  ValidateBranchRequestSchema,
  BranchSuggestionsRequestSchema,
  DirectorySuggestionsRequestSchema,
  PaseoWorktreeListRequestSchema,
  PaseoWorktreeArchiveRequestSchema,
  FileExplorerRequestSchema,
  ProjectIconRequestSchema,
  FileDownloadTokenRequestSchema,
  ClearAgentAttentionMessageSchema,
  ClientHeartbeatMessageSchema,
  PingMessageSchema,
  ListCommandsRequestSchema,
  RegisterPushTokenMessageSchema,
  ListTerminalsRequestSchema,
  SubscribeTerminalsRequestSchema,
  UnsubscribeTerminalsRequestSchema,
  CreateTerminalRequestSchema,
  SubscribeTerminalRequestSchema,
  UnsubscribeTerminalRequestSchema,
  TerminalInputSchema,
  KillTerminalRequestSchema,
  AttachTerminalStreamRequestSchema,
  DetachTerminalStreamRequestSchema,
])

export type SessionInboundMessage = z.infer<typeof SessionInboundMessageSchema>

// ============================================================================
// Session Outbound Messages (Session emits these)
// ============================================================================

export const ActivityLogPayloadSchema = z.object({
  id: z.string(),
  timestamp: z.coerce.date(),
  type: z.enum(['transcript', 'assistant', 'tool_call', 'tool_result', 'error', 'system']),
  content: z.string(),
  metadata: z.record(z.unknown()).optional(),
})

export const ActivityLogMessageSchema = z.object({
  type: z.literal('activity_log'),
  payload: ActivityLogPayloadSchema,
})

export const AssistantChunkMessageSchema = z.object({
  type: z.literal('assistant_chunk'),
  payload: z.object({
    chunk: z.string(),
  }),
})

export const AudioOutputMessageSchema = z.object({
  type: z.literal('audio_output'),
  payload: z.object({
    audio: z.string(), // base64 encoded
    format: z.string(),
    id: z.string(),
    isVoiceMode: z.boolean(), // Mode when audio was generated (for drift protection)
    groupId: z.string().optional(), // Logical utterance id
    chunkIndex: z.number().int().nonnegative().optional(),
    isLastChunk: z.boolean().optional(),
  }),
})

export const TranscriptionResultMessageSchema = z.object({
  type: z.literal('transcription_result'),
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
})

export const DictationStreamAckMessageSchema = z.object({
  type: z.literal('dictation_stream_ack'),
  payload: z.object({
    dictationId: z.string(),
    ackSeq: z.number().int(),
  }),
})

export const DictationStreamFinishAcceptedMessageSchema = z.object({
  type: z.literal('dictation_stream_finish_accepted'),
  payload: z.object({
    dictationId: z.string(),
    timeoutMs: z.number().int().positive(),
  }),
})

export const DictationStreamPartialMessageSchema = z.object({
  type: z.literal('dictation_stream_partial'),
  payload: z.object({
    dictationId: z.string(),
    text: z.string(),
  }),
})

export const DictationStreamFinalMessageSchema = z.object({
  type: z.literal('dictation_stream_final'),
  payload: z.object({
    dictationId: z.string(),
    text: z.string(),
    debugRecordingPath: z.string().optional(),
  }),
})

export const DictationStreamErrorMessageSchema = z.object({
  type: z.literal('dictation_stream_error'),
  payload: z.object({
    dictationId: z.string(),
    error: z.string(),
    retryable: z.boolean(),
    reasonCode: z.string().optional(),
    missingModelIds: z.array(z.string()).optional(),
    debugRecordingPath: z.string().optional(),
  }),
})

export const ServerCapabilityStateSchema = z.object({
  enabled: z.boolean(),
  reason: z.string(),
})

export const ServerVoiceCapabilitiesSchema = z.object({
  dictation: ServerCapabilityStateSchema,
  voice: ServerCapabilityStateSchema,
})

export const ServerCapabilitiesSchema = z
  .object({
    voice: ServerVoiceCapabilitiesSchema.optional(),
  })
  .passthrough()

const ServerInfoHostnameSchema = z.unknown().transform((value): string | null => {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
})

const ServerCapabilitiesFromUnknownSchema = z
  .unknown()
  .optional()
  .transform((value): z.infer<typeof ServerCapabilitiesSchema> | undefined => {
    if (value === undefined) {
      return undefined
    }
    const parsed = ServerCapabilitiesSchema.safeParse(value)
    if (!parsed.success) {
      return undefined
    }
    return parsed.data
  })

export const ServerInfoStatusPayloadSchema = z
  .object({
    status: z.literal('server_info'),
    serverId: z.string().trim().min(1),
    hostname: ServerInfoHostnameSchema.optional(),
    capabilities: ServerCapabilitiesFromUnknownSchema,
  })
  .passthrough()
  .transform((payload) => ({
    ...payload,
    hostname: payload.hostname ?? null,
  }))

export const StatusMessageSchema = z.object({
  type: z.literal('status'),
  payload: z
    .object({
      status: z.string(),
    })
    .passthrough(), // Allow additional fields
})

export const PongMessageSchema = z.object({
  type: z.literal('pong'),
  payload: z.object({
    requestId: z.string(),
    clientSentAt: z.number().int().optional(),
    serverReceivedAt: z.number().int(),
    serverSentAt: z.number().int(),
  }),
})

export const RpcErrorMessageSchema = z.object({
  type: z.literal('rpc_error'),
  payload: z.object({
    requestId: z.string(),
    requestType: z.string().optional(),
    error: z.string(),
    code: z.string().optional(),
  }),
})

const AgentStatusWithRequestSchema = z.object({
  agentId: z.string(),
  requestId: z.string(),
})

const AgentStatusWithTimelineSchema = AgentStatusWithRequestSchema.extend({
  timelineSize: z.number().optional(),
})

export const AgentCreatedStatusPayloadSchema = z
  .object({
    status: z.literal('agent_created'),
    agent: AgentSnapshotPayloadSchema,
  })
  .extend(AgentStatusWithRequestSchema.shape)

export const AgentCreateFailedStatusPayloadSchema = z.object({
  status: z.literal('agent_create_failed'),
  requestId: z.string(),
  error: z.string(),
})

export const AgentResumedStatusPayloadSchema = z
  .object({
    status: z.literal('agent_resumed'),
    agent: AgentSnapshotPayloadSchema,
  })
  .extend(AgentStatusWithTimelineSchema.shape)

export const AgentRefreshedStatusPayloadSchema = z
  .object({
    status: z.literal('agent_refreshed'),
  })
  .extend(AgentStatusWithTimelineSchema.shape)

export const RestartRequestedStatusPayloadSchema = z.object({
  status: z.literal('restart_requested'),
  clientId: z.string(),
  reason: z.string().optional(),
  requestId: z.string(),
})

export const KnownStatusPayloadSchema = z.discriminatedUnion('status', [
  AgentCreatedStatusPayloadSchema,
  AgentCreateFailedStatusPayloadSchema,
  AgentResumedStatusPayloadSchema,
  AgentRefreshedStatusPayloadSchema,
  RestartRequestedStatusPayloadSchema,
])

export type KnownStatusPayload = z.infer<typeof KnownStatusPayloadSchema>

export const ArtifactMessageSchema = z.object({
  type: z.literal('artifact'),
  payload: z.object({
    type: z.enum(['markdown', 'diff', 'image', 'code']),
    id: z.string(),
    title: z.string(),
    content: z.string(),
    isBase64: z.boolean(),
  }),
})

export const ProjectCheckoutLiteNotGitPayloadSchema = z.object({
  cwd: z.string(),
  isGit: z.literal(false),
  currentBranch: z.null(),
  remoteUrl: z.null(),
  isPaseoOwnedWorktree: z.literal(false),
  mainRepoRoot: z.null(),
})

export const ProjectCheckoutLiteGitNonPaseoPayloadSchema = z.object({
  cwd: z.string(),
  isGit: z.literal(true),
  currentBranch: z.string().nullable(),
  remoteUrl: z.string().nullable(),
  isPaseoOwnedWorktree: z.literal(false),
  mainRepoRoot: z.null(),
})

export const ProjectCheckoutLiteGitPaseoPayloadSchema = z.object({
  cwd: z.string(),
  isGit: z.literal(true),
  currentBranch: z.string().nullable(),
  remoteUrl: z.string().nullable(),
  isPaseoOwnedWorktree: z.literal(true),
  mainRepoRoot: z.string(),
})

export const ProjectCheckoutLitePayloadSchema = z.union([
  ProjectCheckoutLiteNotGitPayloadSchema,
  ProjectCheckoutLiteGitNonPaseoPayloadSchema,
  ProjectCheckoutLiteGitPaseoPayloadSchema,
])

export const ProjectPlacementPayloadSchema = z.object({
  projectKey: z.string(),
  projectName: z.string(),
  checkout: ProjectCheckoutLitePayloadSchema,
})

export const AgentUpdateMessageSchema = z.object({
  type: z.literal('agent_update'),
  payload: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('upsert'),
      agent: AgentSnapshotPayloadSchema,
      project: ProjectPlacementPayloadSchema,
    }),
    z.object({
      kind: z.literal('remove'),
      agentId: z.string(),
    }),
  ]),
})

export const AgentStreamMessageSchema = z.object({
  type: z.literal('agent_stream'),
  payload: z.object({
    agentId: z.string(),
    event: AgentStreamEventPayloadSchema,
    timestamp: z.string(),
    // Present for timeline events. Maps 1:1 to canonical in-memory timeline rows.
    seq: z.number().int().nonnegative().optional(),
    epoch: z.string().optional(),
  }),
})

export const AgentStatusMessageSchema = z.object({
  type: z.literal('agent_status'),
  payload: z.object({
    agentId: z.string(),
    status: z.string(),
    info: AgentSnapshotPayloadSchema,
  }),
})

export const AgentListMessageSchema = z.object({
  type: z.literal('agent_list'),
  payload: z.object({
    agents: z.array(AgentSnapshotPayloadSchema),
  }),
})

export const FetchAgentsResponseMessageSchema = z.object({
  type: z.literal('fetch_agents_response'),
  payload: z.object({
    requestId: z.string(),
    subscriptionId: z.string().nullable().optional(),
    entries: z.array(
      z.object({
        agent: AgentSnapshotPayloadSchema,
        project: ProjectPlacementPayloadSchema,
      })
    ),
    pageInfo: z.object({
      nextCursor: z.string().nullable(),
      prevCursor: z.string().nullable(),
      hasMore: z.boolean(),
    }),
  }),
})

export const FetchAgentResponseMessageSchema = z.object({
  type: z.literal('fetch_agent_response'),
  payload: z.object({
    requestId: z.string(),
    agent: AgentSnapshotPayloadSchema.nullable(),
    error: z.string().nullable(),
  }),
})

const AgentTimelineSeqRangeSchema = z.object({
  startSeq: z.number().int().nonnegative(),
  endSeq: z.number().int().nonnegative(),
})

export const AgentTimelineEntryPayloadSchema = z.object({
  provider: AgentProviderSchema,
  item: AgentTimelineItemPayloadSchema,
  timestamp: z.string(),
  seqStart: z.number().int().nonnegative(),
  seqEnd: z.number().int().nonnegative(),
  sourceSeqRanges: z.array(AgentTimelineSeqRangeSchema),
  collapsed: z.array(z.enum(['assistant_merge', 'tool_lifecycle'])),
})

export const FetchAgentTimelineResponseMessageSchema = z.object({
  type: z.literal('fetch_agent_timeline_response'),
  payload: z.object({
    requestId: z.string(),
    agentId: z.string(),
    direction: z.enum(['tail', 'before', 'after']),
    projection: z.enum(['projected', 'canonical']),
    epoch: z.string(),
    reset: z.boolean(),
    staleCursor: z.boolean(),
    gap: z.boolean(),
    window: z.object({
      minSeq: z.number().int().nonnegative(),
      maxSeq: z.number().int().nonnegative(),
      nextSeq: z.number().int().nonnegative(),
    }),
    startCursor: AgentTimelineCursorSchema.nullable(),
    endCursor: AgentTimelineCursorSchema.nullable(),
    hasOlder: z.boolean(),
    hasNewer: z.boolean(),
    entries: z.array(AgentTimelineEntryPayloadSchema),
    error: z.string().nullable(),
  }),
})

export const SendAgentMessageResponseMessageSchema = z.object({
  type: z.literal('send_agent_message_response'),
  payload: z.object({
    requestId: z.string(),
    agentId: z.string(),
    accepted: z.boolean(),
    error: z.string().nullable(),
  }),
})

export const WaitForFinishResponseMessageSchema = z.object({
  type: z.literal('wait_for_finish_response'),
  payload: z.object({
    requestId: z.string(),
    status: z.enum(['idle', 'error', 'permission', 'timeout']),
    final: AgentSnapshotPayloadSchema.nullable(),
    error: z.string().nullable(),
    lastMessage: z.string().nullable(),
  }),
})

export const AgentPermissionRequestMessageSchema = z.object({
  type: z.literal('agent_permission_request'),
  payload: z.object({
    agentId: z.string(),
    request: AgentPermissionRequestPayloadSchema,
  }),
})

export const AgentPermissionResolvedMessageSchema = z.object({
  type: z.literal('agent_permission_resolved'),
  payload: z.object({
    agentId: z.string(),
    requestId: z.string(),
    resolution: AgentPermissionResponseSchema,
  }),
})

export const AgentDeletedMessageSchema = z.object({
  type: z.literal('agent_deleted'),
  payload: z.object({
    agentId: z.string(),
    requestId: z.string(),
  }),
})

export const AgentArchivedMessageSchema = z.object({
  type: z.literal('agent_archived'),
  payload: z.object({
    agentId: z.string(),
    archivedAt: z.string(),
    requestId: z.string(),
  }),
})

const AheadBehindSchema = z.object({
  ahead: z.number(),
  behind: z.number(),
})

const CheckoutStatusCommonSchema = z.object({
  cwd: z.string(),
  error: CheckoutErrorSchema.nullable(),
  requestId: z.string(),
})

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
})

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
})

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
})

export const CheckoutStatusResponseSchema = z.object({
  type: z.literal('checkout_status_response'),
  payload: z.union([
    CheckoutStatusNotGitSchema,
    CheckoutStatusGitNonPaseoSchema,
    CheckoutStatusGitPaseoSchema,
  ]),
})

const CheckoutDiffSubscriptionPayloadSchema = z.object({
  subscriptionId: z.string(),
  cwd: z.string(),
  files: z.array(ParsedDiffFileSchema),
  error: CheckoutErrorSchema.nullable(),
})

export const SubscribeCheckoutDiffResponseSchema = z.object({
  type: z.literal('subscribe_checkout_diff_response'),
  payload: CheckoutDiffSubscriptionPayloadSchema.extend({
    requestId: z.string(),
  }),
})

export const CheckoutDiffUpdateSchema = z.object({
  type: z.literal('checkout_diff_update'),
  payload: CheckoutDiffSubscriptionPayloadSchema,
})

export const CheckoutCommitResponseSchema = z.object({
  type: z.literal('checkout_commit_response'),
  payload: z.object({
    cwd: z.string(),
    success: z.boolean(),
    error: CheckoutErrorSchema.nullable(),
    requestId: z.string(),
  }),
})

export const CheckoutMergeResponseSchema = z.object({
  type: z.literal('checkout_merge_response'),
  payload: z.object({
    cwd: z.string(),
    success: z.boolean(),
    error: CheckoutErrorSchema.nullable(),
    requestId: z.string(),
  }),
})

export const CheckoutMergeFromBaseResponseSchema = z.object({
  type: z.literal('checkout_merge_from_base_response'),
  payload: z.object({
    cwd: z.string(),
    success: z.boolean(),
    error: CheckoutErrorSchema.nullable(),
    requestId: z.string(),
  }),
})

export const CheckoutPushResponseSchema = z.object({
  type: z.literal('checkout_push_response'),
  payload: z.object({
    cwd: z.string(),
    success: z.boolean(),
    error: CheckoutErrorSchema.nullable(),
    requestId: z.string(),
  }),
})

export const CheckoutPrCreateResponseSchema = z.object({
  type: z.literal('checkout_pr_create_response'),
  payload: z.object({
    cwd: z.string(),
    url: z.string().nullable(),
    number: z.number().nullable(),
    error: CheckoutErrorSchema.nullable(),
    requestId: z.string(),
  }),
})

const CheckoutPrStatusSchema = z.object({
  url: z.string(),
  title: z.string(),
  state: z.string(),
  baseRefName: z.string(),
  headRefName: z.string(),
  isMerged: z.boolean(),
})

export const CheckoutPrStatusResponseSchema = z.object({
  type: z.literal('checkout_pr_status_response'),
  payload: z.object({
    cwd: z.string(),
    status: CheckoutPrStatusSchema.nullable(),
    githubFeaturesEnabled: z.boolean(),
    error: CheckoutErrorSchema.nullable(),
    requestId: z.string(),
  }),
})

export const ValidateBranchResponseSchema = z.object({
  type: z.literal('validate_branch_response'),
  payload: z.object({
    exists: z.boolean(),
    resolvedRef: z.string().nullable(),
    isRemote: z.boolean(),
    error: z.string().nullable(),
    requestId: z.string(),
  }),
})

export const BranchSuggestionsResponseSchema = z.object({
  type: z.literal('branch_suggestions_response'),
  payload: z.object({
    branches: z.array(z.string()),
    error: z.string().nullable(),
    requestId: z.string(),
  }),
})

export const DirectorySuggestionsResponseSchema = z.object({
  type: z.literal('directory_suggestions_response'),
  payload: z.object({
    directories: z.array(z.string()),
    entries: z
      .array(
        z.object({
          path: z.string(),
          kind: z.enum(['file', 'directory']),
        })
      )
      .optional()
      .default([]),
    error: z.string().nullable(),
    requestId: z.string(),
  }),
})

const PaseoWorktreeSchema = z.object({
  worktreePath: z.string(),
  branchName: z.string().nullable().optional(),
  head: z.string().nullable().optional(),
})

export const PaseoWorktreeListResponseSchema = z.object({
  type: z.literal('paseo_worktree_list_response'),
  payload: z.object({
    worktrees: z.array(PaseoWorktreeSchema),
    error: CheckoutErrorSchema.nullable(),
    requestId: z.string(),
  }),
})

export const PaseoWorktreeArchiveResponseSchema = z.object({
  type: z.literal('paseo_worktree_archive_response'),
  payload: z.object({
    success: z.boolean(),
    removedAgents: z.array(z.string()).optional(),
    error: CheckoutErrorSchema.nullable(),
    requestId: z.string(),
  }),
})

export const FileExplorerResponseSchema = z.object({
  type: z.literal('file_explorer_response'),
  payload: z.object({
    agentId: z.string(),
    path: z.string(),
    mode: z.enum(['list', 'file']),
    directory: FileExplorerDirectorySchema.nullable(),
    file: FileExplorerFileSchema.nullable(),
    error: z.string().nullable(),
    requestId: z.string(),
  }),
})

const ProjectIconSchema = z.object({
  data: z.string(),
  mimeType: z.string(),
})

export const ProjectIconResponseSchema = z.object({
  type: z.literal('project_icon_response'),
  payload: z.object({
    cwd: z.string(),
    icon: ProjectIconSchema.nullable(),
    error: z.string().nullable(),
    requestId: z.string(),
  }),
})

export const FileDownloadTokenResponseSchema = z.object({
  type: z.literal('file_download_token_response'),
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
})

export const ListProviderModelsResponseMessageSchema = z.object({
  type: z.literal('list_provider_models_response'),
  payload: z.object({
    provider: AgentProviderSchema,
    models: z.array(AgentModelDefinitionSchema).optional(),
    error: z.string().nullable().optional(),
    fetchedAt: z.string(),
    requestId: z.string(),
  }),
})

const ProviderAvailabilitySchema = z.object({
  provider: AgentProviderSchema,
  available: z.boolean(),
  error: z.string().nullable().optional(),
})

export const ListAvailableProvidersResponseSchema = z.object({
  type: z.literal('list_available_providers_response'),
  payload: z.object({
    providers: z.array(ProviderAvailabilitySchema),
    error: z.string().nullable().optional(),
    fetchedAt: z.string(),
    requestId: z.string(),
  }),
})

export const SpeechModelsListResponseSchema = z.object({
  type: z.literal('speech_models_list_response'),
  payload: z.object({
    modelsDir: z.string(),
    models: z.array(
      z.object({
        id: z.string(),
        kind: z.string(),
        description: z.string(),
        modelDir: z.string(),
        isDownloaded: z.boolean(),
        missingFiles: z.array(z.string()).optional(),
      })
    ),
    requestId: z.string(),
  }),
})

export const SpeechModelsDownloadResponseSchema = z.object({
  type: z.literal('speech_models_download_response'),
  payload: z.object({
    modelsDir: z.string(),
    downloadedModelIds: z.array(z.string()),
    error: z.string().nullable(),
    requestId: z.string(),
  }),
})

const AgentSlashCommandSchema = z.object({
  name: z.string(),
  description: z.string(),
  argumentHint: z.string(),
})

export const ListCommandsResponseSchema = z.object({
  type: z.literal('list_commands_response'),
  payload: z.object({
    agentId: z.string(),
    commands: z.array(AgentSlashCommandSchema),
    error: z.string().nullable(),
    requestId: z.string(),
  }),
})

// ============================================================================
// Terminal Outbound Messages
// ============================================================================

const TerminalInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  cwd: z.string(),
})

const TerminalCellSchema = z.object({
  char: z.string(),
  fg: z.number().optional(),
  bg: z.number().optional(),
  fgMode: z.number().optional(),
  bgMode: z.number().optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
})

const TerminalStateSchema = z.object({
  rows: z.number(),
  cols: z.number(),
  grid: z.array(z.array(TerminalCellSchema)),
  scrollback: z.array(z.array(TerminalCellSchema)),
  cursor: z.object({ row: z.number(), col: z.number() }),
})

export const ListTerminalsResponseSchema = z.object({
  type: z.literal('list_terminals_response'),
  payload: z.object({
    cwd: z.string(),
    terminals: z.array(TerminalInfoSchema.omit({ cwd: true })),
    requestId: z.string(),
  }),
})

export const TerminalsChangedSchema = z.object({
  type: z.literal('terminals_changed'),
  payload: z.object({
    cwd: z.string(),
    terminals: z.array(TerminalInfoSchema.omit({ cwd: true })),
  }),
})

export const CreateTerminalResponseSchema = z.object({
  type: z.literal('create_terminal_response'),
  payload: z.object({
    terminal: TerminalInfoSchema.nullable(),
    error: z.string().nullable(),
    requestId: z.string(),
  }),
})

export const SubscribeTerminalResponseSchema = z.object({
  type: z.literal('subscribe_terminal_response'),
  payload: z.object({
    terminalId: z.string(),
    state: TerminalStateSchema.nullable(),
    error: z.string().nullable(),
    requestId: z.string(),
  }),
})

export const TerminalOutputSchema = z.object({
  type: z.literal('terminal_output'),
  payload: z.object({
    terminalId: z.string(),
    state: TerminalStateSchema,
  }),
})

export const KillTerminalResponseSchema = z.object({
  type: z.literal('kill_terminal_response'),
  payload: z.object({
    terminalId: z.string(),
    success: z.boolean(),
    requestId: z.string(),
  }),
})

export const AttachTerminalStreamResponseSchema = z.object({
  type: z.literal('attach_terminal_stream_response'),
  payload: z.object({
    terminalId: z.string(),
    streamId: z.number().int().nonnegative().nullable(),
    replayedFrom: z.number().int().nonnegative(),
    currentOffset: z.number().int().nonnegative(),
    earliestAvailableOffset: z.number().int().nonnegative(),
    reset: z.boolean(),
    error: z.string().nullable(),
    requestId: z.string(),
  }),
})

export const DetachTerminalStreamResponseSchema = z.object({
  type: z.literal('detach_terminal_stream_response'),
  payload: z.object({
    streamId: z.number().int().nonnegative(),
    success: z.boolean(),
    requestId: z.string(),
  }),
})

export const TerminalStreamExitSchema = z.object({
  type: z.literal('terminal_stream_exit'),
  payload: z.object({
    streamId: z.number().int().nonnegative(),
    terminalId: z.string(),
  }),
})

export const SessionOutboundMessageSchema = z.discriminatedUnion('type', [
  ActivityLogMessageSchema,
  AssistantChunkMessageSchema,
  AudioOutputMessageSchema,
  TranscriptionResultMessageSchema,
  DictationStreamAckMessageSchema,
  DictationStreamFinishAcceptedMessageSchema,
  DictationStreamPartialMessageSchema,
  DictationStreamFinalMessageSchema,
  DictationStreamErrorMessageSchema,
  StatusMessageSchema,
  PongMessageSchema,
  RpcErrorMessageSchema,
  ArtifactMessageSchema,
  AgentUpdateMessageSchema,
  AgentStreamMessageSchema,
  AgentStatusMessageSchema,
  FetchAgentsResponseMessageSchema,
  FetchAgentResponseMessageSchema,
  FetchAgentTimelineResponseMessageSchema,
  SendAgentMessageResponseMessageSchema,
  SetVoiceModeResponseMessageSchema,
  SetAgentModeResponseMessageSchema,
  SetAgentModelResponseMessageSchema,
  SetAgentThinkingResponseMessageSchema,
  UpdateAgentResponseMessageSchema,
  WaitForFinishResponseMessageSchema,
  AgentPermissionRequestMessageSchema,
  AgentPermissionResolvedMessageSchema,
  AgentDeletedMessageSchema,
  AgentArchivedMessageSchema,
  CheckoutStatusResponseSchema,
  SubscribeCheckoutDiffResponseSchema,
  CheckoutDiffUpdateSchema,
  CheckoutCommitResponseSchema,
  CheckoutMergeResponseSchema,
  CheckoutMergeFromBaseResponseSchema,
  CheckoutPushResponseSchema,
  CheckoutPrCreateResponseSchema,
  CheckoutPrStatusResponseSchema,
  ValidateBranchResponseSchema,
  BranchSuggestionsResponseSchema,
  DirectorySuggestionsResponseSchema,
  PaseoWorktreeListResponseSchema,
  PaseoWorktreeArchiveResponseSchema,
  FileExplorerResponseSchema,
  ProjectIconResponseSchema,
  FileDownloadTokenResponseSchema,
  ListProviderModelsResponseMessageSchema,
  ListAvailableProvidersResponseSchema,
  SpeechModelsListResponseSchema,
  SpeechModelsDownloadResponseSchema,
  ListCommandsResponseSchema,
  ListTerminalsResponseSchema,
  TerminalsChangedSchema,
  CreateTerminalResponseSchema,
  SubscribeTerminalResponseSchema,
  TerminalOutputSchema,
  KillTerminalResponseSchema,
  AttachTerminalStreamResponseSchema,
  DetachTerminalStreamResponseSchema,
  TerminalStreamExitSchema,
])

export type SessionOutboundMessage = z.infer<typeof SessionOutboundMessageSchema>

// Type exports for individual message types
export type ActivityLogMessage = z.infer<typeof ActivityLogMessageSchema>
export type AssistantChunkMessage = z.infer<typeof AssistantChunkMessageSchema>
export type AudioOutputMessage = z.infer<typeof AudioOutputMessageSchema>
export type TranscriptionResultMessage = z.infer<typeof TranscriptionResultMessageSchema>
export type StatusMessage = z.infer<typeof StatusMessageSchema>
export type ServerCapabilityState = z.infer<typeof ServerCapabilityStateSchema>
export type ServerVoiceCapabilities = z.infer<typeof ServerVoiceCapabilitiesSchema>
export type ServerCapabilities = z.infer<typeof ServerCapabilitiesSchema>
export type ServerInfoStatusPayload = z.infer<typeof ServerInfoStatusPayloadSchema>
export type RpcErrorMessage = z.infer<typeof RpcErrorMessageSchema>
export type ArtifactMessage = z.infer<typeof ArtifactMessageSchema>
export type AgentUpdateMessage = z.infer<typeof AgentUpdateMessageSchema>
export type AgentStreamMessage = z.infer<typeof AgentStreamMessageSchema>
export type AgentStatusMessage = z.infer<typeof AgentStatusMessageSchema>
export type ProjectCheckoutLitePayload = z.infer<typeof ProjectCheckoutLitePayloadSchema>
export type ProjectPlacementPayload = z.infer<typeof ProjectPlacementPayloadSchema>
export type FetchAgentsResponseMessage = z.infer<typeof FetchAgentsResponseMessageSchema>
export type FetchAgentResponseMessage = z.infer<typeof FetchAgentResponseMessageSchema>
export type FetchAgentTimelineResponseMessage = z.infer<
  typeof FetchAgentTimelineResponseMessageSchema
>
export type SendAgentMessageResponseMessage = z.infer<typeof SendAgentMessageResponseMessageSchema>
export type SetVoiceModeResponseMessage = z.infer<typeof SetVoiceModeResponseMessageSchema>
export type UpdateAgentResponseMessage = z.infer<typeof UpdateAgentResponseMessageSchema>
export type WaitForFinishResponseMessage = z.infer<typeof WaitForFinishResponseMessageSchema>
export type AgentPermissionRequestMessage = z.infer<typeof AgentPermissionRequestMessageSchema>
export type AgentPermissionResolvedMessage = z.infer<typeof AgentPermissionResolvedMessageSchema>
export type AgentDeletedMessage = z.infer<typeof AgentDeletedMessageSchema>
export type ListProviderModelsResponseMessage = z.infer<
  typeof ListProviderModelsResponseMessageSchema
>
export type ListAvailableProvidersResponse = z.infer<typeof ListAvailableProvidersResponseSchema>
export type SpeechModelsListResponse = z.infer<typeof SpeechModelsListResponseSchema>
export type SpeechModelsDownloadResponse = z.infer<typeof SpeechModelsDownloadResponseSchema>

// Type exports for payload types
export type ActivityLogPayload = z.infer<typeof ActivityLogPayloadSchema>

// Type exports for inbound message types
export type VoiceAudioChunkMessage = z.infer<typeof VoiceAudioChunkMessageSchema>
export type FetchAgentsRequestMessage = z.infer<typeof FetchAgentsRequestMessageSchema>
export type FetchAgentRequestMessage = z.infer<typeof FetchAgentRequestMessageSchema>
export type SendAgentMessageRequest = z.infer<typeof SendAgentMessageRequestSchema>
export type WaitForFinishRequest = z.infer<typeof WaitForFinishRequestSchema>
export type DictationStreamStartMessage = z.infer<typeof DictationStreamStartMessageSchema>
export type DictationStreamChunkMessage = z.infer<typeof DictationStreamChunkMessageSchema>
export type DictationStreamFinishMessage = z.infer<typeof DictationStreamFinishMessageSchema>
export type DictationStreamCancelMessage = z.infer<typeof DictationStreamCancelMessageSchema>
export type CreateAgentRequestMessage = z.infer<typeof CreateAgentRequestMessageSchema>
export type ListProviderModelsRequestMessage = z.infer<
  typeof ListProviderModelsRequestMessageSchema
>
export type ListAvailableProvidersRequestMessage = z.infer<
  typeof ListAvailableProvidersRequestMessageSchema
>
export type SpeechModelsListRequestMessage = z.infer<typeof SpeechModelsListRequestSchema>
export type SpeechModelsDownloadRequestMessage = z.infer<typeof SpeechModelsDownloadRequestSchema>
export type ResumeAgentRequestMessage = z.infer<typeof ResumeAgentRequestMessageSchema>
export type DeleteAgentRequestMessage = z.infer<typeof DeleteAgentRequestMessageSchema>
export type UpdateAgentRequestMessage = z.infer<typeof UpdateAgentRequestMessageSchema>
export type SetAgentModeRequestMessage = z.infer<typeof SetAgentModeRequestMessageSchema>
export type SetAgentModelRequestMessage = z.infer<typeof SetAgentModelRequestMessageSchema>
export type SetAgentThinkingRequestMessage = z.infer<typeof SetAgentThinkingRequestMessageSchema>
export type AgentPermissionResponseMessage = z.infer<typeof AgentPermissionResponseMessageSchema>
export type CheckoutStatusRequest = z.infer<typeof CheckoutStatusRequestSchema>
export type CheckoutStatusResponse = z.infer<typeof CheckoutStatusResponseSchema>
export type SubscribeCheckoutDiffRequest = z.infer<typeof SubscribeCheckoutDiffRequestSchema>
export type UnsubscribeCheckoutDiffRequest = z.infer<typeof UnsubscribeCheckoutDiffRequestSchema>
export type SubscribeCheckoutDiffResponse = z.infer<typeof SubscribeCheckoutDiffResponseSchema>
export type CheckoutDiffUpdate = z.infer<typeof CheckoutDiffUpdateSchema>
export type CheckoutCommitRequest = z.infer<typeof CheckoutCommitRequestSchema>
export type CheckoutCommitResponse = z.infer<typeof CheckoutCommitResponseSchema>
export type CheckoutMergeRequest = z.infer<typeof CheckoutMergeRequestSchema>
export type CheckoutMergeResponse = z.infer<typeof CheckoutMergeResponseSchema>
export type CheckoutMergeFromBaseRequest = z.infer<typeof CheckoutMergeFromBaseRequestSchema>
export type CheckoutMergeFromBaseResponse = z.infer<typeof CheckoutMergeFromBaseResponseSchema>
export type CheckoutPushRequest = z.infer<typeof CheckoutPushRequestSchema>
export type CheckoutPushResponse = z.infer<typeof CheckoutPushResponseSchema>
export type CheckoutPrCreateRequest = z.infer<typeof CheckoutPrCreateRequestSchema>
export type CheckoutPrCreateResponse = z.infer<typeof CheckoutPrCreateResponseSchema>
export type CheckoutPrStatusRequest = z.infer<typeof CheckoutPrStatusRequestSchema>
export type CheckoutPrStatusResponse = z.infer<typeof CheckoutPrStatusResponseSchema>
export type ValidateBranchRequest = z.infer<typeof ValidateBranchRequestSchema>
export type ValidateBranchResponse = z.infer<typeof ValidateBranchResponseSchema>
export type BranchSuggestionsRequest = z.infer<typeof BranchSuggestionsRequestSchema>
export type BranchSuggestionsResponse = z.infer<typeof BranchSuggestionsResponseSchema>
export type DirectorySuggestionsRequest = z.infer<typeof DirectorySuggestionsRequestSchema>
export type DirectorySuggestionsResponse = z.infer<typeof DirectorySuggestionsResponseSchema>
export type PaseoWorktreeListRequest = z.infer<typeof PaseoWorktreeListRequestSchema>
export type PaseoWorktreeListResponse = z.infer<typeof PaseoWorktreeListResponseSchema>
export type PaseoWorktreeArchiveRequest = z.infer<typeof PaseoWorktreeArchiveRequestSchema>
export type PaseoWorktreeArchiveResponse = z.infer<typeof PaseoWorktreeArchiveResponseSchema>
export type FileExplorerRequest = z.infer<typeof FileExplorerRequestSchema>
export type FileExplorerResponse = z.infer<typeof FileExplorerResponseSchema>
export type ProjectIconRequest = z.infer<typeof ProjectIconRequestSchema>
export type ProjectIconResponse = z.infer<typeof ProjectIconResponseSchema>
export type ProjectIcon = z.infer<typeof ProjectIconSchema>
export type FileDownloadTokenRequest = z.infer<typeof FileDownloadTokenRequestSchema>
export type FileDownloadTokenResponse = z.infer<typeof FileDownloadTokenResponseSchema>
export type RestartServerRequestMessage = z.infer<typeof RestartServerRequestMessageSchema>
export type ClearAgentAttentionMessage = z.infer<typeof ClearAgentAttentionMessageSchema>
export type ClientHeartbeatMessage = z.infer<typeof ClientHeartbeatMessageSchema>
export type ListCommandsRequest = z.infer<typeof ListCommandsRequestSchema>
export type ListCommandsResponse = z.infer<typeof ListCommandsResponseSchema>
export type RegisterPushTokenMessage = z.infer<typeof RegisterPushTokenMessageSchema>

// Terminal message types
export type ListTerminalsRequest = z.infer<typeof ListTerminalsRequestSchema>
export type ListTerminalsResponse = z.infer<typeof ListTerminalsResponseSchema>
export type SubscribeTerminalsRequest = z.infer<typeof SubscribeTerminalsRequestSchema>
export type UnsubscribeTerminalsRequest = z.infer<typeof UnsubscribeTerminalsRequestSchema>
export type TerminalsChanged = z.infer<typeof TerminalsChangedSchema>
export type CreateTerminalRequest = z.infer<typeof CreateTerminalRequestSchema>
export type CreateTerminalResponse = z.infer<typeof CreateTerminalResponseSchema>
export type SubscribeTerminalRequest = z.infer<typeof SubscribeTerminalRequestSchema>
export type SubscribeTerminalResponse = z.infer<typeof SubscribeTerminalResponseSchema>
export type UnsubscribeTerminalRequest = z.infer<typeof UnsubscribeTerminalRequestSchema>
export type TerminalInput = z.infer<typeof TerminalInputSchema>
export type TerminalOutput = z.infer<typeof TerminalOutputSchema>
export type KillTerminalRequest = z.infer<typeof KillTerminalRequestSchema>
export type KillTerminalResponse = z.infer<typeof KillTerminalResponseSchema>
export type AttachTerminalStreamRequest = z.infer<typeof AttachTerminalStreamRequestSchema>
export type AttachTerminalStreamResponse = z.infer<typeof AttachTerminalStreamResponseSchema>
export type DetachTerminalStreamRequest = z.infer<typeof DetachTerminalStreamRequestSchema>
export type DetachTerminalStreamResponse = z.infer<typeof DetachTerminalStreamResponseSchema>
export type TerminalStreamExit = z.infer<typeof TerminalStreamExitSchema>

// ============================================================================
// WebSocket Level Messages (wraps session messages)
// ============================================================================

// WebSocket-only messages (not session messages)
export const WSPingMessageSchema = z.object({
  type: z.literal('ping'),
})

export const WSPongMessageSchema = z.object({
  type: z.literal('pong'),
})

export const WSRecordingStateMessageSchema = z.object({
  type: z.literal('recording_state'),
  isRecording: z.boolean(),
})

// Wrapped session message
export const WSSessionInboundSchema = z.object({
  type: z.literal('session'),
  message: SessionInboundMessageSchema,
})

export const WSSessionOutboundSchema = z.object({
  type: z.literal('session'),
  message: SessionOutboundMessageSchema,
})

// Complete WebSocket message schemas
export const WSInboundMessageSchema = z.discriminatedUnion('type', [
  WSPingMessageSchema,
  WSRecordingStateMessageSchema,
  WSSessionInboundSchema,
])

export const WSOutboundMessageSchema = z.discriminatedUnion('type', [
  WSPongMessageSchema,
  WSSessionOutboundSchema,
])

export type WSInboundMessage = z.infer<typeof WSInboundMessageSchema>
export type WSOutboundMessage = z.infer<typeof WSOutboundMessageSchema>

// ============================================================================
// Helper functions for message conversion
// ============================================================================

/**
 * Extract session message from WebSocket message
 * Returns null if message should be handled at WS level only
 */
export function extractSessionMessage(wsMsg: WSInboundMessage): SessionInboundMessage | null {
  if (wsMsg.type === 'session') {
    return wsMsg.message
  }
  // Ping and recording_state are WS-level only
  return null
}

/**
 * Wrap session message in WebSocket envelope
 */
export function wrapSessionMessage(sessionMsg: SessionOutboundMessage): WSOutboundMessage {
  return {
    type: 'session',
    message: sessionMsg,
  }
}

export function parseServerInfoStatusPayload(payload: unknown): ServerInfoStatusPayload | null {
  const parsed = ServerInfoStatusPayloadSchema.safeParse(payload)
  if (!parsed.success) {
    return null
  }
  return parsed.data
}
