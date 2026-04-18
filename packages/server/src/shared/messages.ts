import { z } from "zod";
import { AGENT_LIFECYCLE_STATUSES } from "./agent-lifecycle.js";
import { MAX_EXPLICIT_AGENT_TITLE_CHARS } from "../server/agent/agent-title-limits.js";
import { AgentProviderSchema } from "../server/agent/provider-manifest.js";
import { TOOL_CALL_ICON_NAMES } from "../server/agent/agent-sdk-types.js";
import {
  ChatCreateRequestSchema,
  ChatListRequestSchema,
  ChatInspectRequestSchema,
  ChatDeleteRequestSchema,
  ChatPostRequestSchema,
  ChatReadRequestSchema,
  ChatWaitRequestSchema,
  ChatCreateResponseSchema,
  ChatListResponseSchema,
  ChatInspectResponseSchema,
  ChatDeleteResponseSchema,
  ChatPostResponseSchema,
  ChatReadResponseSchema,
  ChatWaitResponseSchema,
} from "../server/chat/chat-rpc-schemas.js";
import {
  ScheduleCreateRequestSchema,
  ScheduleListRequestSchema,
  ScheduleInspectRequestSchema,
  ScheduleLogsRequestSchema,
  SchedulePauseRequestSchema,
  ScheduleResumeRequestSchema,
  ScheduleDeleteRequestSchema,
  ScheduleCreateResponseSchema,
  ScheduleListResponseSchema,
  ScheduleInspectResponseSchema,
  ScheduleLogsResponseSchema,
  SchedulePauseResponseSchema,
  ScheduleResumeResponseSchema,
  ScheduleDeleteResponseSchema,
} from "../server/schedule/rpc-schemas.js";
import {
  LoopRunRequestSchema,
  LoopListRequestSchema,
  LoopInspectRequestSchema,
  LoopLogsRequestSchema,
  LoopStopRequestSchema,
  LoopRunResponseSchema,
  LoopListResponseSchema,
  LoopInspectResponseSchema,
  LoopLogsResponseSchema,
  LoopStopResponseSchema,
} from "../server/loop/rpc-schemas.js";
// ---------------------------------------------------------------------------
// Mutable daemon config schemas (shared between server store and client)
// ---------------------------------------------------------------------------

export const MutableDaemonConfigSchema = z
  .object({
    mcp: z
      .object({
        injectIntoAgents: z.boolean(),
      })
      .passthrough(),
  })
  .passthrough();

export const MutableDaemonConfigPatchSchema = z
  .object({
    mcp: MutableDaemonConfigSchema.shape.mcp.partial().optional(),
  })
  .partial()
  .passthrough();

export type MutableDaemonConfig = z.infer<typeof MutableDaemonConfigSchema>;
export type MutableDaemonConfigPatch = z.infer<typeof MutableDaemonConfigPatchSchema>;
import type { LiteralUnion } from "./literal-union.js";
import type {
  AgentCapabilityFlags,
  AgentModelDefinition,
  AgentMode,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  ProviderSnapshotEntry,
  ProviderStatus,
  AgentRuntimeInfo,
  AgentTimelineItem,
  ToolCallDetail,
  ToolCallTimelineItem,
  AgentUsage,
} from "../server/agent/agent-sdk-types.js";

export const AgentStatusSchema = z.enum(AGENT_LIFECYCLE_STATUSES);

const AgentModeSchema: z.ZodType<AgentMode> = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  icon: z.string().optional(),
  colorTier: z.string().optional(),
});

const ProviderStatusSchema: z.ZodType<ProviderStatus> = z.enum([
  "ready",
  "loading",
  "error",
  "unavailable",
]);

const AgentSelectOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  isDefault: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const AgentFeatureToggleSchema = z.object({
  type: z.literal("toggle"),
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  tooltip: z.string().optional(),
  icon: z.string().optional(),
  value: z.boolean(),
});

export const AgentFeatureSelectSchema = z.object({
  type: z.literal("select"),
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  tooltip: z.string().optional(),
  icon: z.string().optional(),
  value: z.string().nullable(),
  options: z.array(AgentSelectOptionSchema),
});

export const AgentFeatureSchema = z.discriminatedUnion("type", [
  AgentFeatureToggleSchema,
  AgentFeatureSelectSchema,
]);

const AgentModelDefinitionSchema: z.ZodType<AgentModelDefinition> = z.object({
  provider: AgentProviderSchema,
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  isDefault: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional(),
  thinkingOptions: z.array(AgentSelectOptionSchema).optional(),
  defaultThinkingOptionId: z.string().optional(),
});

const ProviderSnapshotEntrySchema: z.ZodType<ProviderSnapshotEntry> = z.object({
  provider: AgentProviderSchema,
  status: ProviderStatusSchema,
  error: z.string().optional(),
  models: z.array(AgentModelDefinitionSchema).optional(),
  modes: z.array(AgentModeSchema).optional(),
  fetchedAt: z.string().optional(),
  label: z.string().optional(),
  description: z.string().optional(),
  defaultModeId: z.string().nullable().optional(),
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
  contextWindowMaxTokens: z.number().optional(),
  contextWindowUsedTokens: z.number().optional(),
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
  featureValues: z.record(z.unknown()).optional(),
  title: z.string().trim().min(1).max(MAX_EXPLICIT_AGENT_TITLE_CHARS).optional().nullable(),
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
});

const AgentPermissionUpdateSchema = z.record(z.unknown());
const AgentPermissionActionSchema = z.object({
  id: z.string(),
  label: z.string(),
  behavior: z.enum(["allow", "deny"]),
  variant: z.enum(["primary", "secondary", "danger"]).optional(),
  intent: z.enum(["implement", "implement_resume", "dismiss"]).optional(),
});

export const AgentPermissionResponseSchema: z.ZodType<AgentPermissionResponse> = z.union([
  z.object({
    behavior: z.literal("allow"),
    selectedActionId: z.string().optional(),
    updatedInput: z.record(z.unknown()).optional(),
    updatedPermissions: z.array(AgentPermissionUpdateSchema).optional(),
  }),
  z.object({
    behavior: z.literal("deny"),
    selectedActionId: z.string().optional(),
    message: z.string().optional(),
    interrupt: z.boolean().optional(),
  }),
]);

export const AgentPermissionRequestPayloadSchema: z.ZodType<AgentPermissionRequest> = z.object({
  id: z.string(),
  provider: AgentProviderSchema,
  name: z.string(),
  kind: z.enum(["tool", "plan", "question", "mode", "other"]),
  title: z.string().optional(),
  description: z.string().optional(),
  input: z.record(z.unknown()).optional(),
  detail: z.lazy(() => ToolCallDetailPayloadSchema).optional(),
  suggestions: z.array(AgentPermissionUpdateSchema).optional(),
  actions: z.array(AgentPermissionActionSchema).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const UnknownValueSchema = z.union([
  z.null(),
  z.boolean(),
  z.number(),
  z.string(),
  z.array(z.unknown()),
  z.object({}).passthrough(),
]);

const NonNullUnknownSchema = z.union([
  z.boolean(),
  z.number(),
  z.string(),
  z.array(z.unknown()),
  z.object({}).passthrough(),
]);

const WorktreeSetupCommandSnapshotSchema = z.object({
  index: z.number().int().positive(),
  command: z.string(),
  cwd: z.string(),
  log: z.string(),
  status: z.enum(["running", "completed", "failed"]),
  exitCode: z.number().nullable(),
  durationMs: z.number().nonnegative().optional(),
});

const WorktreeSetupDetailPayloadSchema = z.object({
  type: z.literal("worktree_setup"),
  worktreePath: z.string(),
  branchName: z.string(),
  log: z.string(),
  commands: z.array(WorktreeSetupCommandSnapshotSchema),
  truncated: z.boolean().optional(),
});

const ToolCallDetailPayloadSchema: z.ZodType<ToolCallDetail> = z.discriminatedUnion("type", [
  WorktreeSetupDetailPayloadSchema,
  z.object({
    type: z.literal("shell"),
    command: z.string(),
    cwd: z.string().optional(),
    output: z.string().optional(),
    exitCode: z.number().nullable().optional(),
  }),
  z.object({
    type: z.literal("read"),
    filePath: z.string(),
    content: z.string().optional(),
    offset: z.number().optional(),
    limit: z.number().optional(),
  }),
  z.object({
    type: z.literal("edit"),
    filePath: z.string(),
    oldString: z.string().optional(),
    newString: z.string().optional(),
    unifiedDiff: z.string().optional(),
  }),
  z.object({
    type: z.literal("write"),
    filePath: z.string(),
    content: z.string().optional(),
  }),
  z.object({
    type: z.literal("search"),
    query: z.string(),
    toolName: z.enum(["search", "grep", "glob", "web_search"]).optional(),
    content: z.string().optional(),
    filePaths: z.array(z.string()).optional(),
    webResults: z
      .array(
        z.object({
          title: z.string(),
          url: z.string(),
        }),
      )
      .optional(),
    annotations: z.array(z.string()).optional(),
    numFiles: z.number().optional(),
    numMatches: z.number().optional(),
    durationMs: z.number().optional(),
    durationSeconds: z.number().optional(),
    truncated: z.boolean().optional(),
    mode: z.enum(["content", "files_with_matches", "count"]).optional(),
  }),
  z.object({
    type: z.literal("fetch"),
    url: z.string(),
    prompt: z.string().optional(),
    result: z.string().optional(),
    code: z.number().optional(),
    codeText: z.string().optional(),
    bytes: z.number().optional(),
    durationMs: z.number().optional(),
  }),
  z.object({
    type: z.literal("sub_agent"),
    subAgentType: z.string().optional(),
    description: z.string().optional(),
    log: z.string(),
    actions: z.array(
      z.object({
        index: z.number().int().positive(),
        toolName: z.string(),
        summary: z.string().optional(),
      }),
    ),
  }),
  z.object({
    type: z.literal("plain_text"),
    label: z.string().optional(),
    text: z.string().optional(),
    icon: z.enum(TOOL_CALL_ICON_NAMES).optional(),
  }),
  z.object({
    type: z.literal("plan"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("unknown"),
    input: UnknownValueSchema,
    output: UnknownValueSchema,
  }),
]);

const ToolCallBasePayloadSchema = z
  .object({
    type: z.literal("tool_call"),
    callId: z.string(),
    name: z.string(),
    detail: ToolCallDetailPayloadSchema,
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

const ToolCallRunningPayloadSchema = ToolCallBasePayloadSchema.extend({
  status: z.literal("running"),
  error: z.null(),
});

const ToolCallCompletedPayloadSchema = ToolCallBasePayloadSchema.extend({
  status: z.literal("completed"),
  error: z.null(),
});

const ToolCallFailedPayloadSchema = ToolCallBasePayloadSchema.extend({
  status: z.literal("failed"),
  error: NonNullUnknownSchema,
});

const ToolCallCanceledPayloadSchema = ToolCallBasePayloadSchema.extend({
  status: z.literal("canceled"),
  error: z.null(),
});

const ToolCallTimelineItemPayloadSchema: z.ZodType<ToolCallTimelineItem, z.ZodTypeDef, unknown> =
  z.union([
    ToolCallRunningPayloadSchema,
    ToolCallCompletedPayloadSchema,
    ToolCallFailedPayloadSchema,
    ToolCallCanceledPayloadSchema,
  ]);

export const AgentTimelineItemPayloadSchema: z.ZodType<AgentTimelineItem, z.ZodTypeDef, unknown> =
  z.union([
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
    ToolCallTimelineItemPayloadSchema,
    z.object({
      type: z.literal("todo"),
      items: z.array(
        z.object({
          text: z.string(),
          completed: z.boolean(),
        }),
      ),
    }),
    z.object({
      type: z.literal("error"),
      message: z.string(),
    }),
    z.object({
      type: z.literal("compaction"),
      status: z.enum(["loading", "completed"]),
      trigger: z.enum(["auto", "manual"]).optional(),
      preTokens: z.number().optional(),
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
    code: z.string().optional(),
    diagnostic: z.string().optional(),
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
    notification: z
      .object({
        title: z.string(),
        body: z.string(),
        data: z.object({
          serverId: z.string(),
          agentId: z.string(),
          reason: z.enum(["finished", "error", "permission"]),
        }),
      })
      .optional(),
  }),
]);

const AgentPersistenceHandleSchema: z.ZodType<AgentPersistenceHandle | null> = z
  .object({
    provider: AgentProviderSchema,
    sessionId: z.string(),
    nativeHandle: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .nullable();

const AgentRuntimeInfoSchema: z.ZodType<AgentRuntimeInfo> = z.object({
  provider: AgentProviderSchema,
  sessionId: z.string().nullable(),
  model: z.string().nullable().optional(),
  thinkingOptionId: z.string().nullable().optional(),
  modeId: z.string().nullable().optional(),
  extra: z.record(z.unknown()).optional(),
});

export const AgentSnapshotPayloadSchema = z.object({
  id: z.string(),
  provider: AgentProviderSchema,
  cwd: z.string(),
  model: z.string().nullable(),
  features: z.array(AgentFeatureSchema).optional(),
  thinkingOptionId: z.string().nullable().optional(),
  effectiveThinkingOptionId: z.string().nullable().optional(),
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

export type AgentStreamEventPayload = z.infer<typeof AgentStreamEventPayloadSchema>;

// ============================================================================
// Session Inbound Messages (Session receives these)
// ============================================================================

export const VoiceAudioChunkMessageSchema = z.object({
  type: z.literal("voice_audio_chunk"),
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

const AgentDirectoryFilterSchema = z.object({
  labels: z.record(z.string()).optional(),
  projectKeys: z.array(z.string()).optional(),
  statuses: z.array(AgentStatusSchema).optional(),
  includeArchived: z.boolean().optional(),
  requiresAttention: z.boolean().optional(),
  thinkingOptionId: z.string().nullable().optional(),
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

export const CloseItemsRequestMessageSchema = z.object({
  type: z.literal("close_items_request"),
  agentIds: z.array(z.string()).default([]),
  terminalIds: z.array(z.string()).default([]),
  requestId: z.string(),
});

export const UpdateAgentRequestMessageSchema = z.object({
  type: z.literal("update_agent_request"),
  agentId: z.string(),
  name: z.string().optional(),
  labels: z.record(z.string()).optional(),
  requestId: z.string(),
});

export const SetVoiceModeMessageSchema = z.object({
  type: z.literal("set_voice_mode"),
  enabled: z.boolean(),
  agentId: z.string().optional(),
  requestId: z.string().optional(),
});

export const GitHubPrAttachmentSchema = z.object({
  type: z.literal("github_pr"),
  mimeType: z.literal("application/github-pr"),
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  body: z.string().nullable().optional(),
  baseRefName: z.string().nullable().optional(),
  headRefName: z.string().nullable().optional(),
});

export const GitHubIssueAttachmentSchema = z.object({
  type: z.literal("github_issue"),
  mimeType: z.literal("application/github-issue"),
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  body: z.string().nullable().optional(),
});

export const AgentAttachmentSchema = z.discriminatedUnion("type", [
  GitHubPrAttachmentSchema,
  GitHubIssueAttachmentSchema,
]);

function normalizeAgentAttachments(input: unknown): AgentAttachment[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const normalized: AgentAttachment[] = [];
  for (const item of input) {
    const parsed = AgentAttachmentSchema.safeParse(item);
    if (parsed.success) {
      normalized.push(parsed.data);
    }
  }
  return normalized;
}

const AgentAttachmentsSchema = z.unknown().transform(normalizeAgentAttachments).optional();

const ImageAttachmentSchema = z.object({
  data: z.string(), // base64 encoded image
  mimeType: z.string(), // e.g., "image/jpeg", "image/png"
});

export const SendAgentMessageSchema = z.object({
  type: z.literal("send_agent_message"),
  agentId: z.string(),
  text: z.string(),
  messageId: z.string().optional(), // Client-provided ID for deduplication
  images: z.array(ImageAttachmentSchema).optional(),
  attachments: AgentAttachmentsSchema,
});

// ============================================================================
// Agent RPCs (requestId-correlated)
// ============================================================================

export const FetchAgentsRequestMessageSchema = z.object({
  type: z.literal("fetch_agents_request"),
  requestId: z.string(),
  filter: AgentDirectoryFilterSchema.optional(),
  sort: z
    .array(
      z.object({
        key: z.enum(["status_priority", "created_at", "updated_at", "title"]),
        direction: z.enum(["asc", "desc"]),
      }),
    )
    .optional(),
  page: z
    .object({
      limit: z.number().int().positive().max(200),
      cursor: z.string().min(1).optional(),
    })
    .optional(),
  subscribe: z
    .object({
      subscriptionId: z.string().optional(),
    })
    .optional(),
});

const WorkspaceStateBucketSchema = z.enum([
  "needs_input",
  "failed",
  "running",
  "attention",
  "done",
]);

export const FetchWorkspacesRequestMessageSchema = z.object({
  type: z.literal("fetch_workspaces_request"),
  requestId: z.string(),
  filter: z
    .object({
      query: z.string().optional(),
      projectId: z.string().optional(),
      idPrefix: z.string().optional(),
    })
    .optional(),
  sort: z
    .array(
      z.object({
        key: z.enum(["status_priority", "activity_at", "name", "project_id"]),
        direction: z.enum(["asc", "desc"]),
      }),
    )
    .optional(),
  page: z
    .object({
      limit: z.number().int().positive().max(200),
      cursor: z.string().min(1).optional(),
    })
    .optional(),
  subscribe: z
    .object({
      subscriptionId: z.string().optional(),
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
  images: z.array(ImageAttachmentSchema).optional(),
  attachments: AgentAttachmentsSchema,
});

export const WaitForFinishRequestSchema = z.object({
  type: z.literal("wait_for_finish_request"),
  requestId: z.string(),
  /** Accepts full ID, unique prefix, or exact full title (server resolves). */
  agentId: z.string(),
  timeoutMs: z.number().int().positive().optional(),
});

export const GetDaemonConfigRequestMessageSchema = z.object({
  type: z.literal("get_daemon_config_request"),
  requestId: z.string(),
});

export const SetDaemonConfigRequestMessageSchema = z.object({
  type: z.literal("set_daemon_config_request"),
  requestId: z.string(),
  config: MutableDaemonConfigPatchSchema,
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
  refName: z.string().min(1).optional(),
  action: z.enum(["branch-off", "checkout"]).optional(),
  githubPrNumber: z.number().int().positive().optional(),
});

export type GitSetupOptions = z.infer<typeof GitSetupOptionsSchema>;

export const CreateAgentRequestMessageSchema = z.object({
  type: z.literal("create_agent_request"),
  config: AgentSessionConfigSchema,
  workspaceId: z.string().optional(),
  worktreeName: z.string().optional(),
  initialPrompt: z.string().optional(),
  clientMessageId: z.string().optional(),
  outputSchema: z.record(z.unknown()).optional(),
  images: z.array(ImageAttachmentSchema).optional(),
  attachments: AgentAttachmentsSchema,
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

export const ListProviderModesRequestMessageSchema = z.object({
  type: z.literal("list_provider_modes_request"),
  provider: AgentProviderSchema,
  cwd: z.string().optional(),
  requestId: z.string(),
});

export const ListAvailableProvidersRequestMessageSchema = z.object({
  type: z.literal("list_available_providers_request"),
  requestId: z.string(),
});

export const GetProvidersSnapshotRequestMessageSchema = z.object({
  type: z.literal("get_providers_snapshot_request"),
  cwd: z.string().optional(),
  requestId: z.string(),
});

export const RefreshProvidersSnapshotRequestMessageSchema = z.object({
  type: z.literal("refresh_providers_snapshot_request"),
  cwd: z.string().optional(),
  providers: z.array(AgentProviderSchema).optional(),
  requestId: z.string(),
});

export const ProviderDiagnosticRequestMessageSchema = z.object({
  type: z.literal("provider_diagnostic_request"),
  provider: AgentProviderSchema,
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
  requestId: z.string().optional(),
});

export const RestartServerRequestMessageSchema = z.object({
  type: z.literal("restart_server_request"),
  reason: z.string().optional(),
  requestId: z.string(),
});

export const ShutdownServerRequestMessageSchema = z.object({
  type: z.literal("shutdown_server_request"),
  requestId: z.string(),
});

export const AgentTimelineCursorSchema = z.object({
  epoch: z.string(),
  seq: z.number().int().nonnegative(),
});

export const FetchAgentTimelineRequestMessageSchema = z.object({
  type: z.literal("fetch_agent_timeline_request"),
  agentId: z.string(),
  requestId: z.string(),
  direction: z.enum(["tail", "before", "after"]).optional(),
  cursor: AgentTimelineCursorSchema.optional(),
  // 0 means "all matching rows for this query window".
  limit: z.number().int().nonnegative().optional(),
  // Default should be projected for app timeline loading.
  projection: z.enum(["projected", "canonical"]).optional(),
});

export const SetAgentModeRequestMessageSchema = z.object({
  type: z.literal("set_agent_mode_request"),
  agentId: z.string(),
  modeId: z.string(),
  requestId: z.string(),
});

export const SetAgentModeResponseMessageSchema = z.object({
  type: z.literal("set_agent_mode_response"),
  payload: z.object({
    requestId: z.string(),
    agentId: z.string(),
    accepted: z.boolean(),
    error: z.string().nullable(),
  }),
});

export const SetAgentModelRequestMessageSchema = z.object({
  type: z.literal("set_agent_model_request"),
  agentId: z.string(),
  modelId: z.string().nullable(),
  requestId: z.string(),
});

export const SetAgentModelResponseMessageSchema = z.object({
  type: z.literal("set_agent_model_response"),
  payload: z.object({
    requestId: z.string(),
    agentId: z.string(),
    accepted: z.boolean(),
    error: z.string().nullable(),
  }),
});

export const SetAgentThinkingRequestMessageSchema = z.object({
  type: z.literal("set_agent_thinking_request"),
  agentId: z.string(),
  thinkingOptionId: z.string().nullable(),
  requestId: z.string(),
});

export const SetAgentThinkingResponseMessageSchema = z.object({
  type: z.literal("set_agent_thinking_response"),
  payload: z.object({
    requestId: z.string(),
    agentId: z.string(),
    accepted: z.boolean(),
    error: z.string().nullable(),
  }),
});

export const SetAgentFeatureRequestMessageSchema = z.object({
  type: z.literal("set_agent_feature_request"),
  agentId: z.string(),
  featureId: z.string(),
  value: z.unknown(),
  requestId: z.string(),
});

export const SetAgentFeatureResponseMessageSchema = z.object({
  type: z.literal("set_agent_feature_response"),
  payload: z.object({
    requestId: z.string(),
    agentId: z.string(),
    accepted: z.boolean(),
    error: z.string().nullable(),
  }),
});

export const UpdateAgentResponseMessageSchema = z.object({
  type: z.literal("update_agent_response"),
  payload: z.object({
    requestId: z.string(),
    agentId: z.string(),
    accepted: z.boolean(),
    error: z.string().nullable(),
  }),
});

export const SetVoiceModeResponseMessageSchema = z.object({
  type: z.literal("set_voice_mode_response"),
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
});

export const AgentPermissionResponseMessageSchema = z.object({
  type: z.literal("agent_permission_response"),
  agentId: z.string(),
  requestId: z.string(),
  response: AgentPermissionResponseSchema,
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
  ignoreWhitespace: z.boolean().optional(),
});

export const CheckoutStatusRequestSchema = z.object({
  type: z.literal("checkout_status_request"),
  cwd: z.string(),
  requestId: z.string(),
});

export const SubscribeCheckoutDiffRequestSchema = z.object({
  type: z.literal("subscribe_checkout_diff_request"),
  subscriptionId: z.string(),
  cwd: z.string(),
  compare: CheckoutDiffCompareSchema,
  requestId: z.string(),
});

export const UnsubscribeCheckoutDiffRequestSchema = z.object({
  type: z.literal("unsubscribe_checkout_diff_request"),
  subscriptionId: z.string(),
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

export const CheckoutPullRequestSchema = z.object({
  type: z.literal("checkout_pull_request"),
  cwd: z.string(),
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

export const CheckoutSwitchBranchRequestSchema = z.object({
  type: z.literal("checkout_switch_branch_request"),
  cwd: z.string(),
  branch: z.string(),
  requestId: z.string(),
});

export const StashSaveRequestSchema = z.object({
  type: z.literal("stash_save_request"),
  cwd: z.string(),
  /** Branch name to tag the stash with for later identification. */
  branch: z.string().optional(),
  requestId: z.string(),
});

export const StashPopRequestSchema = z.object({
  type: z.literal("stash_pop_request"),
  cwd: z.string(),
  /** Zero-based index from stash_list_response. */
  stashIndex: z.number().int().min(0),
  requestId: z.string(),
});

export const StashListRequestSchema = z.object({
  type: z.literal("stash_list_request"),
  cwd: z.string(),
  /** If true, only return paseo-created stashes. Default true. */
  paseoOnly: z.boolean().optional(),
  requestId: z.string(),
});

export const BranchSuggestionsRequestSchema = z.object({
  type: z.literal("branch_suggestions_request"),
  cwd: z.string(),
  query: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  requestId: z.string(),
});

export const GitHubSearchItemSchema = z.object({
  kind: z.enum(["issue", "pr"]),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
  body: z.string().nullable(),
  labels: z.array(z.string()),
  baseRefName: z.string().nullable().optional(),
  headRefName: z.string().nullable().optional(),
});

export const GitHubSearchKindSchema = z.enum(["github-issue", "github-pr"]);

export const GitHubSearchRequestSchema = z.object({
  type: z.literal("github_search_request"),
  cwd: z.string(),
  query: z.string(),
  limit: z.number().int().min(1).max(50).optional(),
  kinds: z.array(GitHubSearchKindSchema).optional(),
  requestId: z.string(),
});

export const DirectorySuggestionsRequestSchema = z.object({
  type: z.literal("directory_suggestions_request"),
  query: z.string(),
  cwd: z.string().optional(),
  includeFiles: z.boolean().optional(),
  includeDirectories: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional(),
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

export const CreatePaseoWorktreeRequestSchema = z.object({
  type: z.literal("create_paseo_worktree_request"),
  cwd: z.string(),
  worktreeSlug: z.string().optional(),
  attachments: AgentAttachmentsSchema,
  refName: z.string().min(1).optional(),
  action: z.enum(["branch-off", "checkout"]).optional(),
  githubPrNumber: z.number().int().positive().optional(),
  requestId: z.string(),
});

export const WorkspaceSetupStatusRequestSchema = z.object({
  type: z.literal("workspace_setup_status_request"),
  workspaceId: z.string(),
  requestId: z.string(),
});

// TODO(2026-07): Remove once most clients are on >=0.1.50 and support arbitrary editor ids.
export const LEGACY_EDITOR_TARGET_IDS = [
  "cursor",
  "vscode",
  "zed",
  "finder",
  "explorer",
  "file-manager",
] as const;

export const KNOWN_EDITOR_TARGET_IDS = [...LEGACY_EDITOR_TARGET_IDS, "webstorm"] as const;

export const KnownEditorTargetIdSchema = z.enum(KNOWN_EDITOR_TARGET_IDS);
export const LegacyEditorTargetIdSchema = z.enum(LEGACY_EDITOR_TARGET_IDS);
export const EditorTargetIdSchema = z.string().trim().min(1);

const KNOWN_EDITOR_TARGET_ID_SET = new Set<string>(KNOWN_EDITOR_TARGET_IDS);
const LEGACY_EDITOR_TARGET_ID_SET = new Set<string>(LEGACY_EDITOR_TARGET_IDS);

export function isKnownEditorTargetId(value: string): value is KnownEditorTargetId {
  return KNOWN_EDITOR_TARGET_ID_SET.has(value);
}

export function isLegacyEditorTargetId(value: string): value is LegacyEditorTargetId {
  return LEGACY_EDITOR_TARGET_ID_SET.has(value);
}

export const EditorTargetDescriptorPayloadSchema = z.object({
  id: EditorTargetIdSchema,
  label: z.string(),
});

export const ListAvailableEditorsRequestSchema = z.object({
  type: z.literal("list_available_editors_request"),
  requestId: z.string(),
});

export const OpenInEditorRequestSchema = z.object({
  type: z.literal("open_in_editor_request"),
  path: z.string(),
  editorId: EditorTargetIdSchema,
  requestId: z.string(),
});

export const OpenProjectRequestSchema = z.object({
  type: z.literal("open_project_request"),
  cwd: z.string(),
  requestId: z.string(),
});

export const ArchiveWorkspaceRequestSchema = z.object({
  type: z.literal("archive_workspace_request"),
  workspaceId: z.string(),
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
  cwd: z.string(),
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
  cwd: z.string(),
  path: z.string(),
  requestId: z.string(),
});

export const ClearAgentAttentionMessageSchema = z.object({
  type: z.literal("clear_agent_attention"),
  agentId: z.union([z.string(), z.array(z.string())]),
  requestId: z.string().optional(),
});

export const ClientHeartbeatMessageSchema = z.object({
  type: z.literal("client_heartbeat"),
  deviceType: z.enum(["web", "mobile"]),
  focusedAgentId: z.string().nullable(),
  lastActivityAt: z.string(),
  appVisible: z.boolean(),
  appVisibilityChangedAt: z.string().optional(),
});

export const PingMessageSchema = z.object({
  type: z.literal("ping"),
  requestId: z.string(),
  clientSentAt: z.number().int().optional(),
});

const ListCommandsDraftConfigSchema = z.object({
  provider: AgentProviderSchema,
  cwd: z.string(),
  modeId: z.string().optional(),
  model: z.string().optional(),
  thinkingOptionId: z.string().optional(),
  featureValues: z.record(z.unknown()).optional(),
});

export const ListProviderFeaturesRequestMessageSchema = z.object({
  type: z.literal("list_provider_features_request"),
  draftConfig: ListCommandsDraftConfigSchema,
  requestId: z.string(),
});

export const ListCommandsRequestSchema = z.object({
  type: z.literal("list_commands_request"),
  agentId: z.string(),
  draftConfig: ListCommandsDraftConfigSchema.optional(),
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
  cwd: z.string().optional(),
  requestId: z.string(),
});

export const SubscribeTerminalsRequestSchema = z.object({
  type: z.literal("subscribe_terminals_request"),
  cwd: z.string(),
});

export const UnsubscribeTerminalsRequestSchema = z.object({
  type: z.literal("unsubscribe_terminals_request"),
  cwd: z.string(),
});

export const CreateTerminalRequestSchema = z.object({
  type: z.literal("create_terminal_request"),
  cwd: z.string(),
  name: z.string().optional(),
  agentId: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  requestId: z.string(),
});

export const StartWorkspaceScriptRequestSchema = z.object({
  type: z.literal("start_workspace_script_request"),
  workspaceId: z.string(),
  scriptName: z.string(),
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

export const CaptureTerminalRequestSchema = z.object({
  type: z.literal("capture_terminal_request"),
  terminalId: z.string(),
  start: z.number().int().optional(),
  end: z.number().int().optional(),
  stripAnsi: z.boolean().default(true),
  requestId: z.string(),
});

export const SessionInboundMessageSchema = z.discriminatedUnion("type", [
  VoiceAudioChunkMessageSchema,
  AbortRequestMessageSchema,
  AudioPlayedMessageSchema,
  FetchAgentsRequestMessageSchema,
  FetchWorkspacesRequestMessageSchema,
  FetchAgentRequestMessageSchema,
  DeleteAgentRequestMessageSchema,
  ArchiveAgentRequestMessageSchema,
  CloseItemsRequestMessageSchema,
  UpdateAgentRequestMessageSchema,
  SetVoiceModeMessageSchema,
  SendAgentMessageRequestSchema,
  WaitForFinishRequestSchema,
  GetDaemonConfigRequestMessageSchema,
  SetDaemonConfigRequestMessageSchema,
  DictationStreamStartMessageSchema,
  DictationStreamChunkMessageSchema,
  DictationStreamFinishMessageSchema,
  DictationStreamCancelMessageSchema,
  CreateAgentRequestMessageSchema,
  ListProviderModelsRequestMessageSchema,
  ListProviderModesRequestMessageSchema,
  ListProviderFeaturesRequestMessageSchema,
  ListAvailableProvidersRequestMessageSchema,
  GetProvidersSnapshotRequestMessageSchema,
  RefreshProvidersSnapshotRequestMessageSchema,
  ProviderDiagnosticRequestMessageSchema,
  ResumeAgentRequestMessageSchema,
  RefreshAgentRequestMessageSchema,
  CancelAgentRequestMessageSchema,
  ShutdownServerRequestMessageSchema,
  RestartServerRequestMessageSchema,
  FetchAgentTimelineRequestMessageSchema,
  SetAgentModeRequestMessageSchema,
  SetAgentModelRequestMessageSchema,
  SetAgentThinkingRequestMessageSchema,
  SetAgentFeatureRequestMessageSchema,
  AgentPermissionResponseMessageSchema,
  CheckoutStatusRequestSchema,
  SubscribeCheckoutDiffRequestSchema,
  UnsubscribeCheckoutDiffRequestSchema,
  CheckoutCommitRequestSchema,
  CheckoutMergeRequestSchema,
  CheckoutMergeFromBaseRequestSchema,
  CheckoutPullRequestSchema,
  CheckoutPushRequestSchema,
  CheckoutPrCreateRequestSchema,
  CheckoutPrStatusRequestSchema,
  CheckoutSwitchBranchRequestSchema,
  StashSaveRequestSchema,
  StashPopRequestSchema,
  StashListRequestSchema,
  ValidateBranchRequestSchema,
  BranchSuggestionsRequestSchema,
  GitHubSearchRequestSchema,
  DirectorySuggestionsRequestSchema,
  PaseoWorktreeListRequestSchema,
  PaseoWorktreeArchiveRequestSchema,
  CreatePaseoWorktreeRequestSchema,
  WorkspaceSetupStatusRequestSchema,
  ListAvailableEditorsRequestSchema,
  OpenInEditorRequestSchema,
  OpenProjectRequestSchema,
  ArchiveWorkspaceRequestSchema,
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
  StartWorkspaceScriptRequestSchema,
  SubscribeTerminalRequestSchema,
  UnsubscribeTerminalRequestSchema,
  TerminalInputSchema,
  KillTerminalRequestSchema,
  CaptureTerminalRequestSchema,
  ChatCreateRequestSchema,
  ChatListRequestSchema,
  ChatInspectRequestSchema,
  ChatDeleteRequestSchema,
  ChatPostRequestSchema,
  ChatReadRequestSchema,
  ChatWaitRequestSchema,
  ScheduleCreateRequestSchema,
  ScheduleListRequestSchema,
  ScheduleInspectRequestSchema,
  ScheduleLogsRequestSchema,
  SchedulePauseRequestSchema,
  ScheduleResumeRequestSchema,
  ScheduleDeleteRequestSchema,
  LoopRunRequestSchema,
  LoopListRequestSchema,
  LoopInspectRequestSchema,
  LoopLogsRequestSchema,
  LoopStopRequestSchema,
]);

export type SessionInboundMessage = z.infer<typeof SessionInboundMessageSchema>;

// ============================================================================
// Session Outbound Messages (Session emits these)
// ============================================================================

export const ActivityLogPayloadSchema = z.object({
  id: z.string(),
  timestamp: z.coerce.date(),
  type: z.enum(["transcript", "assistant", "tool_call", "tool_result", "error", "system"]),
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
    isVoiceMode: z.boolean(), // Mode when audio was generated (for drift protection)
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

export const VoiceInputStateMessageSchema = z.object({
  type: z.literal("voice_input_state"),
  payload: z.object({
    isSpeaking: z.boolean(),
  }),
});

export const DictationStreamAckMessageSchema = z.object({
  type: z.literal("dictation_stream_ack"),
  payload: z.object({
    dictationId: z.string(),
    ackSeq: z.number().int(),
  }),
});

export const DictationStreamFinishAcceptedMessageSchema = z.object({
  type: z.literal("dictation_stream_finish_accepted"),
  payload: z.object({
    dictationId: z.string(),
    timeoutMs: z.number().int().positive(),
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
    reasonCode: z.string().optional(),
    missingModelIds: z.array(z.string()).optional(),
    debugRecordingPath: z.string().optional(),
  }),
});

export const ServerCapabilityStateSchema = z.object({
  enabled: z.boolean(),
  reason: z.string(),
});

export const ServerVoiceCapabilitiesSchema = z.object({
  dictation: ServerCapabilityStateSchema,
  voice: ServerCapabilityStateSchema,
});

export const ServerCapabilitiesSchema = z
  .object({
    voice: ServerVoiceCapabilitiesSchema.optional(),
  })
  .passthrough();

const ServerInfoHostnameSchema = z.unknown().transform((value): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
});

const ServerInfoVersionSchema = z.unknown().transform((value): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
});

const ServerCapabilitiesFromUnknownSchema = z
  .unknown()
  .optional()
  .transform((value): z.infer<typeof ServerCapabilitiesSchema> | undefined => {
    if (value === undefined) {
      return undefined;
    }
    const parsed = ServerCapabilitiesSchema.safeParse(value);
    if (!parsed.success) {
      return undefined;
    }
    return parsed.data;
  });

export const ServerInfoStatusPayloadSchema = z
  .object({
    status: z.literal("server_info"),
    serverId: z.string().trim().min(1),
    hostname: ServerInfoHostnameSchema.optional(),
    version: ServerInfoVersionSchema.optional(),
    capabilities: ServerCapabilitiesFromUnknownSchema,
    // COMPAT(providersSnapshot): added in v0.1.48, remove gating when all clients use snapshot
    features: z
      .object({
        providersSnapshot: z.boolean().optional(),
      })
      .optional(),
  })
  .passthrough()
  .transform((payload) => ({
    ...payload,
    hostname: payload.hostname ?? null,
    version: payload.version ?? null,
  }));

export const StatusMessageSchema = z.object({
  type: z.literal("status"),
  payload: z
    .object({
      status: z.string(),
    })
    .passthrough(), // Allow additional fields
});

export const PongMessageSchema = z.object({
  type: z.literal("pong"),
  payload: z.object({
    requestId: z.string(),
    clientSentAt: z.number().int().optional(),
    serverReceivedAt: z.number().int(),
    serverSentAt: z.number().int(),
  }),
});

export const RpcErrorMessageSchema = z.object({
  type: z.literal("rpc_error"),
  payload: z.object({
    requestId: z.string(),
    requestType: z.string().optional(),
    error: z.string(),
    code: z.string().optional(),
  }),
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
  errorCode: z.string().optional(),
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

export const ShutdownRequestedStatusPayloadSchema = z.object({
  status: z.literal("shutdown_requested"),
  clientId: z.string(),
  requestId: z.string(),
});

export const DaemonConfigChangedStatusPayloadSchema = z
  .object({
    status: z.literal("daemon_config_changed"),
    config: MutableDaemonConfigSchema,
  })
  .passthrough();

export const KnownStatusPayloadSchema = z.discriminatedUnion("status", [
  AgentCreatedStatusPayloadSchema,
  AgentCreateFailedStatusPayloadSchema,
  AgentResumedStatusPayloadSchema,
  AgentRefreshedStatusPayloadSchema,
  ShutdownRequestedStatusPayloadSchema,
  RestartRequestedStatusPayloadSchema,
  DaemonConfigChangedStatusPayloadSchema,
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

export const ProjectCheckoutLiteNotGitPayloadSchema = z
  .object({
    cwd: z.string(),
    isGit: z.literal(false),
    currentBranch: z.null(),
    remoteUrl: z.null(),
    worktreeRoot: z.null().optional(),
    isPaseoOwnedWorktree: z.literal(false),
    mainRepoRoot: z.null(),
  })
  .transform((value) => ({
    ...value,
    worktreeRoot: null,
  }));

export const ProjectCheckoutLiteGitNonPaseoPayloadSchema = z
  .object({
    cwd: z.string(),
    isGit: z.literal(true),
    currentBranch: z.string().nullable(),
    remoteUrl: z.string().nullable(),
    worktreeRoot: z.string().optional(),
    isPaseoOwnedWorktree: z.literal(false),
    mainRepoRoot: z.null(),
  })
  .transform((value) => ({
    ...value,
    worktreeRoot: value.worktreeRoot ?? value.cwd,
  }));

export const ProjectCheckoutLiteGitPaseoPayloadSchema = z
  .object({
    cwd: z.string(),
    isGit: z.literal(true),
    currentBranch: z.string().nullable(),
    remoteUrl: z.string().nullable(),
    worktreeRoot: z.string().optional(),
    isPaseoOwnedWorktree: z.literal(true),
    mainRepoRoot: z.string(),
  })
  .transform((value) => ({
    ...value,
    worktreeRoot: value.worktreeRoot ?? value.cwd,
  }));

export const ProjectCheckoutLitePayloadSchema = z.union([
  ProjectCheckoutLiteNotGitPayloadSchema,
  ProjectCheckoutLiteGitNonPaseoPayloadSchema,
  ProjectCheckoutLiteGitPaseoPayloadSchema,
]);

export const ProjectPlacementPayloadSchema = z.object({
  projectKey: z.string(),
  projectName: z.string(),
  checkout: ProjectCheckoutLitePayloadSchema,
});

export const WorkspaceScriptLifecycleSchema = z.enum(["running", "stopped"]);
export const WorkspaceScriptHealthSchema = z.enum(["healthy", "unhealthy"]);

export const WorkspaceScriptPayloadSchema = z.object({
  scriptName: z.string(),
  type: z.enum(["script", "service"]).optional().default("service"),
  hostname: z.string(),
  port: z.number().int().positive().nullable(),
  proxyUrl: z.string().nullable().optional().default(null),
  lifecycle: WorkspaceScriptLifecycleSchema,
  health: WorkspaceScriptHealthSchema.nullable(),
  exitCode: z.number().nullable().optional().default(null),
});

const WorkspaceGitRuntimePayloadSchema = z
  .object({
    currentBranch: z.string().nullable().optional(),
    remoteUrl: z.string().nullable().optional(),
    isPaseoOwnedWorktree: z.boolean().optional(),
    isDirty: z.boolean().nullable().optional(),
    aheadBehind: z
      .object({
        ahead: z.number(),
        behind: z.number(),
      })
      .nullable()
      .optional(),
    aheadOfOrigin: z.number().nullable().optional(),
    behindOfOrigin: z.number().nullable().optional(),
  })
  .optional()
  .nullable();

const WorkspaceGitHubRuntimePayloadSchema = z
  .object({
    featuresEnabled: z.boolean().optional(),
    pullRequest: z
      .object({
        url: z.string(),
        title: z.string(),
        state: z.string(),
        baseRefName: z.string(),
        headRefName: z.string(),
        isMerged: z.boolean(),
      })
      .nullable()
      .optional(),
    error: z
      .object({
        message: z.string(),
      })
      .nullable()
      .optional(),
    refreshedAt: z.string().nullable().optional(),
  })
  .optional()
  .nullable();

export const WorkspaceDescriptorPayloadSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  projectDisplayName: z.string(),
  projectRootPath: z.string(),
  workspaceDirectory: z.string(),
  projectKind: z.enum(["git", "non_git", "directory"]),
  // COMPAT(workspaces): keep legacy directory workspace kind parseable.
  workspaceKind: z.enum(["directory", "local_checkout", "checkout", "worktree"]),
  name: z.string(),
  status: WorkspaceStateBucketSchema,
  activityAt: z.string().nullable(),
  diffStat: z
    .object({
      additions: z.number(),
      deletions: z.number(),
    })
    .nullable()
    .optional(),
  scripts: z.array(WorkspaceScriptPayloadSchema).default([]),
  gitRuntime: WorkspaceGitRuntimePayloadSchema,
  githubRuntime: WorkspaceGitHubRuntimePayloadSchema,
});

export const AgentUpdateMessageSchema = z.object({
  type: z.literal("agent_update"),
  payload: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("upsert"),
      agent: AgentSnapshotPayloadSchema,
      project: ProjectPlacementPayloadSchema,
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
    // Present for timeline events. Maps 1:1 to canonical in-memory timeline rows.
    seq: z.number().int().nonnegative().optional(),
    epoch: z.string().optional(),
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
    subscriptionId: z.string().nullable().optional(),
    entries: z.array(
      z.object({
        agent: AgentSnapshotPayloadSchema,
        project: ProjectPlacementPayloadSchema,
      }),
    ),
    pageInfo: z.object({
      nextCursor: z.string().nullable(),
      prevCursor: z.string().nullable(),
      hasMore: z.boolean(),
    }),
  }),
});

export const FetchWorkspacesResponseMessageSchema = z.object({
  type: z.literal("fetch_workspaces_response"),
  payload: z.object({
    requestId: z.string(),
    subscriptionId: z.string().nullable().optional(),
    entries: z.array(WorkspaceDescriptorPayloadSchema),
    pageInfo: z.object({
      nextCursor: z.string().nullable(),
      prevCursor: z.string().nullable(),
      hasMore: z.boolean(),
    }),
  }),
});

export const WorkspaceUpdateMessageSchema = z.object({
  type: z.literal("workspace_update"),
  payload: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("upsert"),
      workspace: WorkspaceDescriptorPayloadSchema,
    }),
    z.object({
      kind: z.literal("remove"),
      id: z.string(),
    }),
  ]),
});

export const ScriptStatusUpdateMessageSchema = z.object({
  type: z.literal("script_status_update"),
  payload: z.object({
    workspaceId: z.string(),
    scripts: z.array(WorkspaceScriptPayloadSchema),
  }),
});

export const WorkspaceSetupProgressMessageSchema = z.object({
  type: z.literal("workspace_setup_progress"),
  payload: z.object({
    workspaceId: z.string(),
    status: z.enum(["running", "completed", "failed"]),
    detail: WorktreeSetupDetailPayloadSchema,
    error: z.string().nullable(),
  }),
});

export const WorkspaceSetupSnapshotSchema = z.object({
  status: z.enum(["running", "completed", "failed"]),
  detail: WorktreeSetupDetailPayloadSchema,
  error: z.string().nullable(),
});

export const WorkspaceSetupStatusResponseMessageSchema = z.object({
  type: z.literal("workspace_setup_status_response"),
  payload: z.object({
    requestId: z.string(),
    workspaceId: z.string(),
    snapshot: WorkspaceSetupSnapshotSchema.nullable(),
  }),
});

export const OpenProjectResponseMessageSchema = z.object({
  type: z.literal("open_project_response"),
  payload: z.object({
    requestId: z.string(),
    workspace: WorkspaceDescriptorPayloadSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const StartWorkspaceScriptResponseMessageSchema = z.object({
  type: z.literal("start_workspace_script_response"),
  payload: z.object({
    requestId: z.string(),
    workspaceId: z.string(),
    scriptName: z.string(),
    terminalId: z.string().nullable(),
    error: z.string().nullable(),
  }),
});

export const ListAvailableEditorsResponseMessageSchema = z.object({
  type: z.literal("list_available_editors_response"),
  payload: z.object({
    requestId: z.string(),
    editors: z.array(EditorTargetDescriptorPayloadSchema),
    error: z.string().nullable(),
  }),
});

export const OpenInEditorResponseMessageSchema = z.object({
  type: z.literal("open_in_editor_response"),
  payload: z.object({
    requestId: z.string(),
    error: z.string().nullable(),
  }),
});

export const ArchiveWorkspaceResponseMessageSchema = z.object({
  type: z.literal("archive_workspace_response"),
  payload: z.object({
    requestId: z.string(),
    workspaceId: z.string(),
    archivedAt: z.string().nullable(),
    error: z.string().nullable(),
  }),
});

export const FetchAgentResponseMessageSchema = z.object({
  type: z.literal("fetch_agent_response"),
  payload: z.object({
    requestId: z.string(),
    agent: AgentSnapshotPayloadSchema.nullable(),
    project: ProjectPlacementPayloadSchema.nullable().optional(),
    error: z.string().nullable(),
  }),
});

const AgentTimelineSeqRangeSchema = z.object({
  startSeq: z.number().int().nonnegative(),
  endSeq: z.number().int().nonnegative(),
});

export const AgentTimelineEntryPayloadSchema = z.object({
  provider: AgentProviderSchema,
  item: AgentTimelineItemPayloadSchema,
  timestamp: z.string(),
  seqStart: z.number().int().nonnegative(),
  seqEnd: z.number().int().nonnegative(),
  sourceSeqRanges: z.array(AgentTimelineSeqRangeSchema),
  collapsed: z.array(z.enum(["assistant_merge", "tool_lifecycle"])),
});

export const FetchAgentTimelineResponseMessageSchema = z.object({
  type: z.literal("fetch_agent_timeline_response"),
  payload: z.object({
    requestId: z.string(),
    agentId: z.string(),
    agent: AgentSnapshotPayloadSchema.nullable(),
    direction: z.enum(["tail", "before", "after"]),
    projection: z.enum(["projected", "canonical"]),
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
});

export const CancelAgentResponseMessageSchema = z.object({
  type: z.literal("cancel_agent_response"),
  payload: z.object({
    requestId: z.string(),
    agentId: z.string(),
    agent: AgentSnapshotPayloadSchema.nullable(),
  }),
});

export const ClearAgentAttentionResponseMessageSchema = z.object({
  type: z.literal("clear_agent_attention_response"),
  payload: z.object({
    requestId: z.string(),
    agentId: z.string().or(z.array(z.string())),
    agents: z.array(AgentSnapshotPayloadSchema),
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
    lastMessage: z.string().nullable(),
  }),
});

export const GetDaemonConfigResponseMessageSchema = z.object({
  type: z.literal("get_daemon_config_response"),
  payload: z
    .object({
      requestId: z.string(),
      config: MutableDaemonConfigSchema,
    })
    .passthrough(),
});

export const SetDaemonConfigResponseMessageSchema = z.object({
  type: z.literal("set_daemon_config_response"),
  payload: z
    .object({
      requestId: z.string(),
      config: MutableDaemonConfigSchema,
    })
    .passthrough(),
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

const CloseItemsAgentResultSchema = z.object({
  agentId: z.string(),
  archivedAt: z.string(),
});

const CloseItemsTerminalResultSchema = z.object({
  terminalId: z.string(),
  success: z.boolean(),
});

export const CloseItemsResponseSchema = z.object({
  type: z.literal("close_items_response"),
  payload: z.object({
    agents: z.array(CloseItemsAgentResultSchema),
    terminals: z.array(CloseItemsTerminalResultSchema),
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
  behindOfOrigin: z.null(),
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
  behindOfOrigin: z.number().nullable(),
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
  behindOfOrigin: z.number().nullable(),
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

const CheckoutDiffSubscriptionPayloadSchema = z.object({
  subscriptionId: z.string(),
  cwd: z.string(),
  files: z.array(ParsedDiffFileSchema),
  error: CheckoutErrorSchema.nullable(),
});

export const SubscribeCheckoutDiffResponseSchema = z.object({
  type: z.literal("subscribe_checkout_diff_response"),
  payload: CheckoutDiffSubscriptionPayloadSchema.extend({
    requestId: z.string(),
  }),
});

export const CheckoutDiffUpdateSchema = z.object({
  type: z.literal("checkout_diff_update"),
  payload: CheckoutDiffSubscriptionPayloadSchema,
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

export const CheckoutPullResponseSchema = z.object({
  type: z.literal("checkout_pull_response"),
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
  isMerged: z.boolean(),
  checks: z
    .array(
      z.object({
        name: z.string(),
        status: z.string(),
        url: z.string().nullable(),
      }),
    )
    .optional(),
  checksStatus: z.string().optional(),
  reviewDecision: z.string().nullable().optional(),
});

export const CheckoutPrStatusResponseSchema = z.object({
  type: z.literal("checkout_pr_status_response"),
  payload: z.object({
    cwd: z.string(),
    status: CheckoutPrStatusSchema.nullable(),
    githubFeaturesEnabled: z.boolean(),
    error: CheckoutErrorSchema.nullable(),
    requestId: z.string(),
  }),
});

export const CheckoutSwitchBranchResponseSchema = z.object({
  type: z.literal("checkout_switch_branch_response"),
  payload: z.object({
    cwd: z.string(),
    success: z.boolean(),
    branch: z.string(),
    error: CheckoutErrorSchema.nullable(),
    requestId: z.string(),
  }),
});

const StashEntrySchema = z.object({
  index: z.number().int().min(0),
  message: z.string(),
  branch: z.string().nullable(),
  isPaseo: z.boolean(),
});

export const StashSaveResponseSchema = z.object({
  type: z.literal("stash_save_response"),
  payload: z.object({
    cwd: z.string(),
    success: z.boolean(),
    error: CheckoutErrorSchema.nullable(),
    requestId: z.string(),
  }),
});

export const StashPopResponseSchema = z.object({
  type: z.literal("stash_pop_response"),
  payload: z.object({
    cwd: z.string(),
    success: z.boolean(),
    error: CheckoutErrorSchema.nullable(),
    requestId: z.string(),
  }),
});

export const StashListResponseSchema = z.object({
  type: z.literal("stash_list_response"),
  payload: z.object({
    cwd: z.string(),
    entries: z.array(StashEntrySchema),
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

export const BranchSuggestionsResponseSchema = z.object({
  type: z.literal("branch_suggestions_response"),
  payload: z.object({
    branches: z.array(z.string()),
    error: z.string().nullable(),
    requestId: z.string(),
  }),
});

export const GitHubSearchResponseSchema = z.object({
  type: z.literal("github_search_response"),
  payload: z.object({
    items: z.array(GitHubSearchItemSchema),
    githubFeaturesEnabled: z.boolean(),
    error: z.string().nullable(),
    requestId: z.string(),
  }),
});

export const DirectorySuggestionsResponseSchema = z.object({
  type: z.literal("directory_suggestions_response"),
  payload: z.object({
    directories: z.array(z.string()),
    entries: z
      .array(
        z.object({
          path: z.string(),
          kind: z.enum(["file", "directory"]),
        }),
      )
      .optional()
      .default([]),
    error: z.string().nullable(),
    requestId: z.string(),
  }),
});

const PaseoWorktreeSchema = z.object({
  worktreePath: z.string(),
  createdAt: z.string(),
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

export const CreatePaseoWorktreeResponseSchema = z.object({
  type: z.literal("create_paseo_worktree_response"),
  payload: z.object({
    workspace: WorkspaceDescriptorPayloadSchema.nullable(),
    error: z.string().nullable(),
    errorCode: z.string().optional(),
    setupTerminalId: z.string().nullable(),
    requestId: z.string(),
  }),
});

export const FileExplorerResponseSchema = z.object({
  type: z.literal("file_explorer_response"),
  payload: z.object({
    cwd: z.string(),
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
    cwd: z.string(),
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

export const ListProviderModesResponseMessageSchema = z.object({
  type: z.literal("list_provider_modes_response"),
  payload: z.object({
    provider: AgentProviderSchema,
    modes: z.array(AgentModeSchema).optional(),
    error: z.string().nullable().optional(),
    fetchedAt: z.string(),
    requestId: z.string(),
  }),
});

export const ListProviderFeaturesResponseMessageSchema = z.object({
  type: z.literal("list_provider_features_response"),
  payload: z.object({
    provider: AgentProviderSchema,
    features: z.array(AgentFeatureSchema).optional(),
    error: z.string().nullable().optional(),
    fetchedAt: z.string(),
    requestId: z.string(),
  }),
});

const ProviderAvailabilitySchema = z.object({
  provider: AgentProviderSchema,
  available: z.boolean(),
  error: z.string().nullable().optional(),
});

export const ListAvailableProvidersResponseSchema = z.object({
  type: z.literal("list_available_providers_response"),
  payload: z.object({
    providers: z.array(ProviderAvailabilitySchema),
    error: z.string().nullable().optional(),
    fetchedAt: z.string(),
    requestId: z.string(),
  }),
});

// COMPAT(providersSnapshot): added in v0.1.48, remove gating when all clients use snapshot
export const GetProvidersSnapshotResponseMessageSchema = z.object({
  type: z.literal("get_providers_snapshot_response"),
  payload: z.object({
    entries: z.array(ProviderSnapshotEntrySchema),
    generatedAt: z.string(),
    requestId: z.string(),
  }),
});

// COMPAT(providersSnapshot): added in v0.1.48, remove gating when all clients use snapshot
export const ProvidersSnapshotUpdateMessageSchema = z.object({
  type: z.literal("providers_snapshot_update"),
  payload: z.object({
    cwd: z.string().optional(),
    entries: z.array(ProviderSnapshotEntrySchema),
    generatedAt: z.string(),
  }),
});

// COMPAT(providersSnapshot): added in v0.1.48, remove gating when all clients use snapshot
export const RefreshProvidersSnapshotResponseMessageSchema = z.object({
  type: z.literal("refresh_providers_snapshot_response"),
  payload: z.object({
    requestId: z.string(),
    acknowledged: z.boolean(),
  }),
});

// COMPAT(providersSnapshot): added in v0.1.48, remove gating when all clients use snapshot
export const ProviderDiagnosticResponseMessageSchema = z.object({
  type: z.literal("provider_diagnostic_response"),
  payload: z.object({
    provider: AgentProviderSchema,
    diagnostic: z.string(),
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

// ============================================================================
// Terminal Outbound Messages
// ============================================================================

const TerminalInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  cwd: z.string(),
  title: z.string().optional(),
});

export const TerminalCellSchema = z
  .object({
    char: z.string(),
    fg: z.number().optional(),
    bg: z.number().optional(),
    fgMode: z.number().optional(),
    bgMode: z.number().optional(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    dim: z.boolean().optional(),
    inverse: z.boolean().optional(),
    strikethrough: z.boolean().optional(),
  })
  .strict();

export const TerminalCursorStyleSchema = z.enum(["block", "underline", "bar"]);

export const TerminalCursorSchema = z
  .object({
    row: z.number(),
    col: z.number(),
    hidden: z.boolean().optional(),
    style: TerminalCursorStyleSchema.optional(),
    blink: z.boolean().optional(),
  })
  .strict();

export const TerminalStateSchema = z
  .object({
    rows: z.number(),
    cols: z.number(),
    grid: z.array(z.array(TerminalCellSchema)),
    scrollback: z.array(z.array(TerminalCellSchema)),
    cursor: TerminalCursorSchema,
    title: z.string().optional(),
  })
  .strict();

export const ListTerminalsResponseSchema = z.object({
  type: z.literal("list_terminals_response"),
  payload: z.object({
    cwd: z.string().optional(),
    terminals: z.array(TerminalInfoSchema.omit({ cwd: true })),
    requestId: z.string(),
  }),
});

export const TerminalsChangedSchema = z.object({
  type: z.literal("terminals_changed"),
  payload: z.object({
    cwd: z.string(),
    terminals: z.array(TerminalInfoSchema.omit({ cwd: true })),
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
  payload: z.union([
    z.object({
      terminalId: z.string(),
      slot: z.number().int().min(0).max(255),
      error: z.null(),
      requestId: z.string(),
    }),
    z.object({
      terminalId: z.string(),
      error: z.string(),
      requestId: z.string(),
    }),
  ]),
});

export const KillTerminalResponseSchema = z.object({
  type: z.literal("kill_terminal_response"),
  payload: z.object({
    terminalId: z.string(),
    success: z.boolean(),
    requestId: z.string(),
  }),
});

export const CaptureTerminalResponseSchema = z.object({
  type: z.literal("capture_terminal_response"),
  payload: z.object({
    terminalId: z.string(),
    lines: z.array(z.string()),
    totalLines: z.number().int().nonnegative(),
    requestId: z.string(),
  }),
});

export const TerminalStreamExitSchema = z.object({
  type: z.literal("terminal_stream_exit"),
  payload: z.object({
    terminalId: z.string(),
  }),
});

export const SessionOutboundMessageSchema = z.discriminatedUnion("type", [
  ActivityLogMessageSchema,
  AssistantChunkMessageSchema,
  AudioOutputMessageSchema,
  TranscriptionResultMessageSchema,
  VoiceInputStateMessageSchema,
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
  WorkspaceUpdateMessageSchema,
  ScriptStatusUpdateMessageSchema,
  WorkspaceSetupProgressMessageSchema,
  WorkspaceSetupStatusResponseMessageSchema,
  AgentStreamMessageSchema,
  AgentStatusMessageSchema,
  FetchAgentsResponseMessageSchema,
  FetchWorkspacesResponseMessageSchema,
  OpenProjectResponseMessageSchema,
  StartWorkspaceScriptResponseMessageSchema,
  ListAvailableEditorsResponseMessageSchema,
  OpenInEditorResponseMessageSchema,
  ArchiveWorkspaceResponseMessageSchema,
  FetchAgentResponseMessageSchema,
  FetchAgentTimelineResponseMessageSchema,
  CancelAgentResponseMessageSchema,
  ClearAgentAttentionResponseMessageSchema,
  SendAgentMessageResponseMessageSchema,
  SetVoiceModeResponseMessageSchema,
  GetDaemonConfigResponseMessageSchema,
  SetDaemonConfigResponseMessageSchema,
  SetAgentModeResponseMessageSchema,
  SetAgentModelResponseMessageSchema,
  SetAgentThinkingResponseMessageSchema,
  SetAgentFeatureResponseMessageSchema,
  UpdateAgentResponseMessageSchema,
  WaitForFinishResponseMessageSchema,
  AgentPermissionRequestMessageSchema,
  AgentPermissionResolvedMessageSchema,
  AgentDeletedMessageSchema,
  AgentArchivedMessageSchema,
  CloseItemsResponseSchema,
  CheckoutStatusResponseSchema,
  SubscribeCheckoutDiffResponseSchema,
  CheckoutDiffUpdateSchema,
  CheckoutCommitResponseSchema,
  CheckoutMergeResponseSchema,
  CheckoutMergeFromBaseResponseSchema,
  CheckoutPullResponseSchema,
  CheckoutPushResponseSchema,
  CheckoutPrCreateResponseSchema,
  CheckoutPrStatusResponseSchema,
  CheckoutSwitchBranchResponseSchema,
  StashSaveResponseSchema,
  StashPopResponseSchema,
  StashListResponseSchema,
  ValidateBranchResponseSchema,
  BranchSuggestionsResponseSchema,
  GitHubSearchResponseSchema,
  DirectorySuggestionsResponseSchema,
  PaseoWorktreeListResponseSchema,
  PaseoWorktreeArchiveResponseSchema,
  CreatePaseoWorktreeResponseSchema,
  FileExplorerResponseSchema,
  ProjectIconResponseSchema,
  FileDownloadTokenResponseSchema,
  ListProviderModelsResponseMessageSchema,
  ListProviderModesResponseMessageSchema,
  ListProviderFeaturesResponseMessageSchema,
  ListAvailableProvidersResponseSchema,
  GetProvidersSnapshotResponseMessageSchema,
  ProvidersSnapshotUpdateMessageSchema,
  RefreshProvidersSnapshotResponseMessageSchema,
  ProviderDiagnosticResponseMessageSchema,
  ListCommandsResponseSchema,
  ListTerminalsResponseSchema,
  TerminalsChangedSchema,
  CreateTerminalResponseSchema,
  SubscribeTerminalResponseSchema,
  KillTerminalResponseSchema,
  CaptureTerminalResponseSchema,
  TerminalStreamExitSchema,
  ChatCreateResponseSchema,
  ChatListResponseSchema,
  ChatInspectResponseSchema,
  ChatDeleteResponseSchema,
  ChatPostResponseSchema,
  ChatReadResponseSchema,
  ChatWaitResponseSchema,
  ScheduleCreateResponseSchema,
  ScheduleListResponseSchema,
  ScheduleInspectResponseSchema,
  ScheduleLogsResponseSchema,
  SchedulePauseResponseSchema,
  ScheduleResumeResponseSchema,
  ScheduleDeleteResponseSchema,
  LoopRunResponseSchema,
  LoopListResponseSchema,
  LoopInspectResponseSchema,
  LoopLogsResponseSchema,
  LoopStopResponseSchema,
]);

export type SessionOutboundMessage = z.infer<typeof SessionOutboundMessageSchema>;

// Type exports for individual message types
export type ActivityLogMessage = z.infer<typeof ActivityLogMessageSchema>;
export type AssistantChunkMessage = z.infer<typeof AssistantChunkMessageSchema>;
export type AudioOutputMessage = z.infer<typeof AudioOutputMessageSchema>;
export type TranscriptionResultMessage = z.infer<typeof TranscriptionResultMessageSchema>;
export type StatusMessage = z.infer<typeof StatusMessageSchema>;
export type ServerCapabilityState = z.infer<typeof ServerCapabilityStateSchema>;
export type ServerVoiceCapabilities = z.infer<typeof ServerVoiceCapabilitiesSchema>;
export type ServerCapabilities = z.infer<typeof ServerCapabilitiesSchema>;
export type ServerInfoStatusPayload = z.infer<typeof ServerInfoStatusPayloadSchema>;
export type RpcErrorMessage = z.infer<typeof RpcErrorMessageSchema>;
export type ArtifactMessage = z.infer<typeof ArtifactMessageSchema>;
export type AgentUpdateMessage = z.infer<typeof AgentUpdateMessageSchema>;
export type WorkspaceSetupProgressMessage = z.infer<typeof WorkspaceSetupProgressMessageSchema>;
export type WorkspaceSetupSnapshot = z.infer<typeof WorkspaceSetupSnapshotSchema>;
export type WorkspaceSetupStatusResponseMessage = z.infer<
  typeof WorkspaceSetupStatusResponseMessageSchema
>;
export type AgentStreamMessage = z.infer<typeof AgentStreamMessageSchema>;
export type AgentStatusMessage = z.infer<typeof AgentStatusMessageSchema>;
export type ProjectCheckoutLitePayload = z.infer<typeof ProjectCheckoutLitePayloadSchema>;
export type ProjectPlacementPayload = z.infer<typeof ProjectPlacementPayloadSchema>;
export type WorkspaceStateBucket = z.infer<typeof WorkspaceStateBucketSchema>;
export type WorkspaceDescriptorPayload = z.infer<typeof WorkspaceDescriptorPayloadSchema>;
export type WorkspaceScriptLifecycle = z.infer<typeof WorkspaceScriptLifecycleSchema>;
export type WorkspaceScriptHealth = z.infer<typeof WorkspaceScriptHealthSchema>;
export type WorkspaceScriptPayload = z.infer<typeof WorkspaceScriptPayloadSchema>;
export type KnownEditorTargetId = z.infer<typeof KnownEditorTargetIdSchema>;
export type LegacyEditorTargetId = z.infer<typeof LegacyEditorTargetIdSchema>;
export type EditorTargetId = LiteralUnion<KnownEditorTargetId, string>;
export type EditorTargetDescriptorPayload = z.infer<typeof EditorTargetDescriptorPayloadSchema>;
export type FetchAgentsResponseMessage = z.infer<typeof FetchAgentsResponseMessageSchema>;
export type FetchWorkspacesResponseMessage = z.infer<typeof FetchWorkspacesResponseMessageSchema>;
export type ScriptStatusUpdateMessage = z.infer<typeof ScriptStatusUpdateMessageSchema>;
export type OpenProjectResponseMessage = z.infer<typeof OpenProjectResponseMessageSchema>;
export type StartWorkspaceScriptResponseMessage = z.infer<
  typeof StartWorkspaceScriptResponseMessageSchema
>;
export type ListAvailableEditorsResponseMessage = z.infer<
  typeof ListAvailableEditorsResponseMessageSchema
>;
export type OpenInEditorResponseMessage = z.infer<typeof OpenInEditorResponseMessageSchema>;
export type ArchiveWorkspaceResponseMessage = z.infer<typeof ArchiveWorkspaceResponseMessageSchema>;
export type FetchAgentResponseMessage = z.infer<typeof FetchAgentResponseMessageSchema>;
export type FetchAgentTimelineResponseMessage = z.infer<
  typeof FetchAgentTimelineResponseMessageSchema
>;
export type CancelAgentResponseMessage = z.infer<typeof CancelAgentResponseMessageSchema>;
export type SendAgentMessageResponseMessage = z.infer<typeof SendAgentMessageResponseMessageSchema>;
export type SetVoiceModeResponseMessage = z.infer<typeof SetVoiceModeResponseMessageSchema>;
export type SetAgentModeResponseMessage = z.infer<typeof SetAgentModeResponseMessageSchema>;
export type SetAgentModelResponseMessage = z.infer<typeof SetAgentModelResponseMessageSchema>;
export type SetAgentThinkingResponseMessage = z.infer<typeof SetAgentThinkingResponseMessageSchema>;
export type SetAgentFeatureResponseMessage = z.infer<typeof SetAgentFeatureResponseMessageSchema>;
export type UpdateAgentResponseMessage = z.infer<typeof UpdateAgentResponseMessageSchema>;
export type WaitForFinishResponseMessage = z.infer<typeof WaitForFinishResponseMessageSchema>;
export type AgentPermissionRequestMessage = z.infer<typeof AgentPermissionRequestMessageSchema>;
export type AgentPermissionResolvedMessage = z.infer<typeof AgentPermissionResolvedMessageSchema>;
export type AgentDeletedMessage = z.infer<typeof AgentDeletedMessageSchema>;
export type ListProviderModelsResponseMessage = z.infer<
  typeof ListProviderModelsResponseMessageSchema
>;
export type ListProviderModesResponseMessage = z.infer<
  typeof ListProviderModesResponseMessageSchema
>;
export type ListProviderFeaturesResponseMessage = z.infer<
  typeof ListProviderFeaturesResponseMessageSchema
>;
export type ListAvailableProvidersResponse = z.infer<typeof ListAvailableProvidersResponseSchema>;
export type GetProvidersSnapshotResponseMessage = z.infer<
  typeof GetProvidersSnapshotResponseMessageSchema
>;
export type ProvidersSnapshotUpdateMessage = z.infer<typeof ProvidersSnapshotUpdateMessageSchema>;
export type RefreshProvidersSnapshotResponseMessage = z.infer<
  typeof RefreshProvidersSnapshotResponseMessageSchema
>;
export type ProviderDiagnosticResponseMessage = z.infer<
  typeof ProviderDiagnosticResponseMessageSchema
>;
export type ChatCreateResponse = z.infer<typeof ChatCreateResponseSchema>;
export type ChatListResponse = z.infer<typeof ChatListResponseSchema>;
export type ChatInspectResponse = z.infer<typeof ChatInspectResponseSchema>;
export type ChatDeleteResponse = z.infer<typeof ChatDeleteResponseSchema>;
export type ChatPostResponse = z.infer<typeof ChatPostResponseSchema>;
export type ChatReadResponse = z.infer<typeof ChatReadResponseSchema>;
export type ChatWaitResponse = z.infer<typeof ChatWaitResponseSchema>;
export type ScheduleCreateResponse = z.infer<typeof ScheduleCreateResponseSchema>;
export type ScheduleListResponse = z.infer<typeof ScheduleListResponseSchema>;
export type ScheduleInspectResponse = z.infer<typeof ScheduleInspectResponseSchema>;
export type ScheduleLogsResponse = z.infer<typeof ScheduleLogsResponseSchema>;
export type SchedulePauseResponse = z.infer<typeof SchedulePauseResponseSchema>;
export type ScheduleResumeResponse = z.infer<typeof ScheduleResumeResponseSchema>;
export type ScheduleDeleteResponse = z.infer<typeof ScheduleDeleteResponseSchema>;
export type LoopRunResponse = z.infer<typeof LoopRunResponseSchema>;
export type LoopListResponse = z.infer<typeof LoopListResponseSchema>;
export type LoopInspectResponse = z.infer<typeof LoopInspectResponseSchema>;
export type LoopLogsResponse = z.infer<typeof LoopLogsResponseSchema>;
export type LoopStopResponse = z.infer<typeof LoopStopResponseSchema>;

// Type exports for payload types
export type ActivityLogPayload = z.infer<typeof ActivityLogPayloadSchema>;

// Type exports for inbound message types
export type VoiceAudioChunkMessage = z.infer<typeof VoiceAudioChunkMessageSchema>;
export type FetchAgentsRequestMessage = z.infer<typeof FetchAgentsRequestMessageSchema>;
export type FetchWorkspacesRequestMessage = z.infer<typeof FetchWorkspacesRequestMessageSchema>;
export type FetchAgentRequestMessage = z.infer<typeof FetchAgentRequestMessageSchema>;
export type SendAgentMessageRequest = z.infer<typeof SendAgentMessageRequestSchema>;
export type WaitForFinishRequest = z.infer<typeof WaitForFinishRequestSchema>;
export type DictationStreamStartMessage = z.infer<typeof DictationStreamStartMessageSchema>;
export type DictationStreamChunkMessage = z.infer<typeof DictationStreamChunkMessageSchema>;
export type DictationStreamFinishMessage = z.infer<typeof DictationStreamFinishMessageSchema>;
export type DictationStreamCancelMessage = z.infer<typeof DictationStreamCancelMessageSchema>;
export type CreateAgentRequestMessage = z.infer<typeof CreateAgentRequestMessageSchema>;
export type AgentAttachment = z.infer<typeof AgentAttachmentSchema>;
export type ListProviderModelsRequestMessage = z.infer<
  typeof ListProviderModelsRequestMessageSchema
>;
export type ListProviderModesRequestMessage = z.infer<typeof ListProviderModesRequestMessageSchema>;
export type ListProviderFeaturesRequestMessage = z.infer<
  typeof ListProviderFeaturesRequestMessageSchema
>;
export type ListAvailableProvidersRequestMessage = z.infer<
  typeof ListAvailableProvidersRequestMessageSchema
>;
export type GetProvidersSnapshotRequestMessage = z.infer<
  typeof GetProvidersSnapshotRequestMessageSchema
>;
export type RefreshProvidersSnapshotRequestMessage = z.infer<
  typeof RefreshProvidersSnapshotRequestMessageSchema
>;
export type ProviderDiagnosticRequestMessage = z.infer<
  typeof ProviderDiagnosticRequestMessageSchema
>;
export type ChatCreateRequest = z.infer<typeof ChatCreateRequestSchema>;
export type ChatListRequest = z.infer<typeof ChatListRequestSchema>;
export type ChatInspectRequest = z.infer<typeof ChatInspectRequestSchema>;
export type ChatDeleteRequest = z.infer<typeof ChatDeleteRequestSchema>;
export type ChatPostRequest = z.infer<typeof ChatPostRequestSchema>;
export type ChatReadRequest = z.infer<typeof ChatReadRequestSchema>;
export type ChatWaitRequest = z.infer<typeof ChatWaitRequestSchema>;
export type ScheduleCreateRequest = z.infer<typeof ScheduleCreateRequestSchema>;
export type ScheduleListRequest = z.infer<typeof ScheduleListRequestSchema>;
export type ScheduleInspectRequest = z.infer<typeof ScheduleInspectRequestSchema>;
export type ScheduleLogsRequest = z.infer<typeof ScheduleLogsRequestSchema>;
export type SchedulePauseRequest = z.infer<typeof SchedulePauseRequestSchema>;
export type ScheduleResumeRequest = z.infer<typeof ScheduleResumeRequestSchema>;
export type ScheduleDeleteRequest = z.infer<typeof ScheduleDeleteRequestSchema>;
export type LoopRunRequest = z.infer<typeof LoopRunRequestSchema>;
export type LoopListRequest = z.infer<typeof LoopListRequestSchema>;
export type LoopInspectRequest = z.infer<typeof LoopInspectRequestSchema>;
export type LoopLogsRequest = z.infer<typeof LoopLogsRequestSchema>;
export type LoopStopRequest = z.infer<typeof LoopStopRequestSchema>;
export type ResumeAgentRequestMessage = z.infer<typeof ResumeAgentRequestMessageSchema>;
export type DeleteAgentRequestMessage = z.infer<typeof DeleteAgentRequestMessageSchema>;
export type UpdateAgentRequestMessage = z.infer<typeof UpdateAgentRequestMessageSchema>;
export type SetAgentModeRequestMessage = z.infer<typeof SetAgentModeRequestMessageSchema>;
export type SetAgentModelRequestMessage = z.infer<typeof SetAgentModelRequestMessageSchema>;
export type SetAgentThinkingRequestMessage = z.infer<typeof SetAgentThinkingRequestMessageSchema>;
export type SetAgentFeatureRequestMessage = z.infer<typeof SetAgentFeatureRequestMessageSchema>;
export type AgentPermissionResponseMessage = z.infer<typeof AgentPermissionResponseMessageSchema>;
export type CheckoutStatusRequest = z.infer<typeof CheckoutStatusRequestSchema>;
export type CheckoutStatusResponse = z.infer<typeof CheckoutStatusResponseSchema>;
export type SubscribeCheckoutDiffRequest = z.infer<typeof SubscribeCheckoutDiffRequestSchema>;
export type UnsubscribeCheckoutDiffRequest = z.infer<typeof UnsubscribeCheckoutDiffRequestSchema>;
export type SubscribeCheckoutDiffResponse = z.infer<typeof SubscribeCheckoutDiffResponseSchema>;
export type CheckoutDiffUpdate = z.infer<typeof CheckoutDiffUpdateSchema>;
export type CheckoutCommitRequest = z.infer<typeof CheckoutCommitRequestSchema>;
export type CheckoutCommitResponse = z.infer<typeof CheckoutCommitResponseSchema>;
export type CheckoutMergeRequest = z.infer<typeof CheckoutMergeRequestSchema>;
export type CheckoutMergeResponse = z.infer<typeof CheckoutMergeResponseSchema>;
export type CheckoutMergeFromBaseRequest = z.infer<typeof CheckoutMergeFromBaseRequestSchema>;
export type CheckoutMergeFromBaseResponse = z.infer<typeof CheckoutMergeFromBaseResponseSchema>;
export type CheckoutPullRequest = z.infer<typeof CheckoutPullRequestSchema>;
export type CheckoutPullResponse = z.infer<typeof CheckoutPullResponseSchema>;
export type CheckoutPushRequest = z.infer<typeof CheckoutPushRequestSchema>;
export type CheckoutPushResponse = z.infer<typeof CheckoutPushResponseSchema>;
export type CheckoutPrCreateRequest = z.infer<typeof CheckoutPrCreateRequestSchema>;
export type CheckoutPrCreateResponse = z.infer<typeof CheckoutPrCreateResponseSchema>;
export type CheckoutPrStatusRequest = z.infer<typeof CheckoutPrStatusRequestSchema>;
export type CheckoutPrStatusResponse = z.infer<typeof CheckoutPrStatusResponseSchema>;
export type CheckoutSwitchBranchRequest = z.infer<typeof CheckoutSwitchBranchRequestSchema>;
export type CheckoutSwitchBranchResponse = z.infer<typeof CheckoutSwitchBranchResponseSchema>;
export type StashSaveRequest = z.infer<typeof StashSaveRequestSchema>;
export type StashSaveResponse = z.infer<typeof StashSaveResponseSchema>;
export type StashPopRequest = z.infer<typeof StashPopRequestSchema>;
export type StashPopResponse = z.infer<typeof StashPopResponseSchema>;
export type StashListRequest = z.infer<typeof StashListRequestSchema>;
export type StashListResponse = z.infer<typeof StashListResponseSchema>;
export type StashEntry = z.infer<typeof StashEntrySchema>;
export type ValidateBranchRequest = z.infer<typeof ValidateBranchRequestSchema>;
export type ValidateBranchResponse = z.infer<typeof ValidateBranchResponseSchema>;
export type BranchSuggestionsRequest = z.infer<typeof BranchSuggestionsRequestSchema>;
export type BranchSuggestionsResponse = z.infer<typeof BranchSuggestionsResponseSchema>;
export type GitHubSearchItem = z.infer<typeof GitHubSearchItemSchema>;
export type GitHubSearchKind = z.infer<typeof GitHubSearchKindSchema>;
export type GitHubSearchRequest = z.infer<typeof GitHubSearchRequestSchema>;
export type GitHubSearchResponse = z.infer<typeof GitHubSearchResponseSchema>;
export type CreatePaseoWorktreeRequest = z.infer<typeof CreatePaseoWorktreeRequestSchema>;
export type DirectorySuggestionsRequest = z.infer<typeof DirectorySuggestionsRequestSchema>;
export type DirectorySuggestionsResponse = z.infer<typeof DirectorySuggestionsResponseSchema>;
export type PaseoWorktreeListRequest = z.infer<typeof PaseoWorktreeListRequestSchema>;
export type PaseoWorktreeListResponse = z.infer<typeof PaseoWorktreeListResponseSchema>;
export type PaseoWorktreeArchiveRequest = z.infer<typeof PaseoWorktreeArchiveRequestSchema>;
export type PaseoWorktreeArchiveResponse = z.infer<typeof PaseoWorktreeArchiveResponseSchema>;
export type WorkspaceSetupStatusRequest = z.infer<typeof WorkspaceSetupStatusRequestSchema>;
export type ListAvailableEditorsRequest = z.infer<typeof ListAvailableEditorsRequestSchema>;
export type OpenInEditorRequest = z.infer<typeof OpenInEditorRequestSchema>;
export type OpenProjectRequest = z.infer<typeof OpenProjectRequestSchema>;
export type ArchiveWorkspaceRequest = z.infer<typeof ArchiveWorkspaceRequestSchema>;
export type FileExplorerRequest = z.infer<typeof FileExplorerRequestSchema>;
export type FileExplorerResponse = z.infer<typeof FileExplorerResponseSchema>;
export type ProjectIconRequest = z.infer<typeof ProjectIconRequestSchema>;
export type ProjectIconResponse = z.infer<typeof ProjectIconResponseSchema>;
export type ProjectIcon = z.infer<typeof ProjectIconSchema>;
export type FileDownloadTokenRequest = z.infer<typeof FileDownloadTokenRequestSchema>;
export type FileDownloadTokenResponse = z.infer<typeof FileDownloadTokenResponseSchema>;
export type RestartServerRequestMessage = z.infer<typeof RestartServerRequestMessageSchema>;
export type ShutdownServerRequestMessage = z.infer<typeof ShutdownServerRequestMessageSchema>;
export type ClearAgentAttentionMessage = z.infer<typeof ClearAgentAttentionMessageSchema>;
export type ClearAgentAttentionResponseMessage = z.infer<
  typeof ClearAgentAttentionResponseMessageSchema
>;
export type ClientHeartbeatMessage = z.infer<typeof ClientHeartbeatMessageSchema>;
export type ListCommandsRequest = z.infer<typeof ListCommandsRequestSchema>;
export type ListCommandsResponse = z.infer<typeof ListCommandsResponseSchema>;
export type RegisterPushTokenMessage = z.infer<typeof RegisterPushTokenMessageSchema>;

// Terminal message types
export type ListTerminalsRequest = z.infer<typeof ListTerminalsRequestSchema>;
export type ListTerminalsResponse = z.infer<typeof ListTerminalsResponseSchema>;
export type SubscribeTerminalsRequest = z.infer<typeof SubscribeTerminalsRequestSchema>;
export type UnsubscribeTerminalsRequest = z.infer<typeof UnsubscribeTerminalsRequestSchema>;
export type TerminalsChanged = z.infer<typeof TerminalsChangedSchema>;
export type CreateTerminalRequest = z.infer<typeof CreateTerminalRequestSchema>;
export type CreateTerminalResponse = z.infer<typeof CreateTerminalResponseSchema>;
export type StartWorkspaceScriptRequest = z.infer<typeof StartWorkspaceScriptRequestSchema>;
export type StartWorkspaceScriptResponse = z.infer<
  typeof StartWorkspaceScriptResponseMessageSchema
>;
export type SubscribeTerminalRequest = z.infer<typeof SubscribeTerminalRequestSchema>;
export type SubscribeTerminalResponse = z.infer<typeof SubscribeTerminalResponseSchema>;
export type UnsubscribeTerminalRequest = z.infer<typeof UnsubscribeTerminalRequestSchema>;
export type TerminalInput = z.infer<typeof TerminalInputSchema>;
export type TerminalCell = z.infer<typeof TerminalCellSchema>;
export type TerminalCursorStyle = z.infer<typeof TerminalCursorStyleSchema>;
export type TerminalCursor = z.infer<typeof TerminalCursorSchema>;
export type TerminalState = z.infer<typeof TerminalStateSchema>;
export type CloseItemsRequest = z.infer<typeof CloseItemsRequestMessageSchema>;
export type CloseItemsResponse = z.infer<typeof CloseItemsResponseSchema>;
export type KillTerminalRequest = z.infer<typeof KillTerminalRequestSchema>;
export type KillTerminalResponse = z.infer<typeof KillTerminalResponseSchema>;
export type CaptureTerminalRequest = z.infer<typeof CaptureTerminalRequestSchema>;
export type CaptureTerminalResponse = z.infer<typeof CaptureTerminalResponseSchema>;
export type TerminalStreamExit = z.infer<typeof TerminalStreamExitSchema>;

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

export const WSHelloMessageSchema = z.object({
  type: z.literal("hello"),
  clientId: z.string().min(1),
  clientType: z.enum(["mobile", "browser", "cli", "mcp"]),
  protocolVersion: z.number().int(),
  appVersion: z.string().optional(),
  capabilities: z
    .object({
      voice: z.boolean().optional(),
      pushNotifications: z.boolean().optional(),
    })
    .passthrough()
    .optional(),
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
  WSHelloMessageSchema,
  WSRecordingStateMessageSchema,
  WSSessionInboundSchema,
]);

export const WSOutboundMessageSchema = z.discriminatedUnion("type", [
  WSPongMessageSchema,
  WSSessionOutboundSchema,
]);

export type WSInboundMessage = z.infer<typeof WSInboundMessageSchema>;
export type WSOutboundMessage = z.infer<typeof WSOutboundMessageSchema>;
export type WSHelloMessage = z.infer<typeof WSHelloMessageSchema>;

// ============================================================================
// Helper functions for message conversion
// ============================================================================

/**
 * Extract session message from WebSocket message
 * Returns null if message should be handled at WS level only
 */
export function extractSessionMessage(wsMsg: WSInboundMessage): SessionInboundMessage | null {
  if (wsMsg.type === "session") {
    return wsMsg.message;
  }
  // Ping and recording_state are WS-level only
  return null;
}

/**
 * Wrap session message in WebSocket envelope
 */
export function wrapSessionMessage(sessionMsg: SessionOutboundMessage): WSOutboundMessage {
  return {
    type: "session",
    message: sessionMsg,
  };
}

export function parseServerInfoStatusPayload(payload: unknown): ServerInfoStatusPayload | null {
  const parsed = ServerInfoStatusPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return null;
  }
  return parsed.data;
}
