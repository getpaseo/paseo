import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentMode,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentRunOptions,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  AgentTimelineItem,
  AgentUsage,
  AgentRuntimeInfo,
} from "../agent-sdk-types.js";

type CodexMcpAgentConfig = AgentSessionConfig & { provider: "codex-mcp" };

type TurnState = {
  sawAssistant: boolean;
  sawReasoning: boolean;
  sawError: boolean;
  sawErrorTimeline: boolean;
  completed: boolean;
  failed: boolean;
};

type PendingPermission = {
  request: AgentPermissionRequest;
  resolve: (value: ElicitResponse) => void;
  reject: (error: Error) => void;
};

type ElicitDecision = "approved" | "approved_for_session" | "denied" | "abort";

type ElicitResponse = {
  decision: ElicitDecision;
  reason?: string;
};

type ToolCallTimelineItem = Extract<AgentTimelineItem, { type: "tool_call" }>;
type PatchFileChange = {
  path: string;
  kind?: string;
  before?: string;
  after?: string;
  patch?: string;
};

type CodexToolArguments = { [key: string]: unknown };

const DEFAULT_TIMEOUT_MS = 14 * 24 * 60 * 60 * 1000;
const CODEX_PROVIDER = "codex-mcp" as const;

const CODEX_MCP_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
};

const CODEX_MODES: AgentMode[] = [
  {
    id: "read-only",
    label: "Read Only",
    description:
      "Read files and answer questions. Manual approval required for edits, commands, or network ops.",
  },
  {
    id: "auto",
    label: "Auto",
    description:
      "Edit files and run commands but still request approval before escalating scope.",
  },
  {
    id: "full-access",
    label: "Full Access",
    description: "Edit files, run commands, and access the network without additional prompts.",
  },
];

const DEFAULT_CODEX_MODE_ID = "auto";

const MODE_PRESETS: Record<
  string,
  { approvalPolicy: string; sandbox: string }
> = {
  "read-only": {
    approvalPolicy: "on-request",
    sandbox: "read-only",
  },
  auto: {
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  },
  "full-access": {
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  },
};

const SESSION_HISTORY = new Map<string, AgentTimelineItem[]>();

function createToolCallTimelineItem(
  data: Omit<ToolCallTimelineItem, "type">
): AgentTimelineItem {
  return { type: "tool_call", ...data };
}

function normalizeThreadEventType(type: string): string {
  if (type.startsWith("thread.item.")) {
    return type.slice("thread.".length);
  }
  if (type.startsWith("thread.turn.")) {
    return type.slice("thread.".length);
  }
  return type;
}

function resolveExclusiveValue<T>(
  ctx: z.RefinementCtx,
  entries: Array<{ key: string; value: T | undefined }>,
  label: string,
  required = false
): T | undefined {
  const present = entries.filter((entry) => entry.value !== undefined);
  if (present.length === 0) {
    if (required) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${label} missing`,
      });
    }
    return undefined;
  }
  if (present.length > 1) {
    const keys = present.map((entry) => entry.key).join(", ");
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${label} provided multiple times (${keys})`,
    });
    return undefined;
  }
  return present[0].value;
}

function resolveExclusiveString(
  ctx: z.RefinementCtx,
  entries: Array<{ key: string; value: string | undefined }>,
  label: string,
  required = false
): string | undefined {
  const value = resolveExclusiveValue(ctx, entries, label, required);
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${label} cannot be empty`,
    });
    return undefined;
  }
  return trimmed;
}

function resolvePreferredString(
  ctx: z.RefinementCtx,
  entries: Array<{ key: string; value: string | undefined }>,
  label: string,
  required = false
): string | undefined {
  for (const entry of entries) {
    if (entry.value === undefined) {
      continue;
    }
    const trimmed = entry.value.trim();
    if (!trimmed) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${label} cannot be empty`,
      });
      return undefined;
    }
    return trimmed;
  }
  if (required) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${label} missing`,
    });
  }
  return undefined;
}

const CommandSchema = z.union([
  z.string().min(1),
  z.array(z.string().min(1)).nonempty(),
]);

type Command = z.infer<typeof CommandSchema>;

const CallIdSchema = z.string().transform((value, ctx) => {
  const trimmed = value.trim();
  if (!trimmed) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "call_id cannot be empty",
    });
    return z.NEVER;
  }
  return trimmed;
});

const ExitCodeSchema = z
  .union([z.number(), z.string().regex(/^-?\d+$/)])
  .transform((value) => (typeof value === "string" ? Number(value) : value));

type PatchChangeDetailsInput = {
  before?: string;
  original?: string;
  old?: string;
  previous?: string;
  from?: string;
  after?: string;
  new?: string;
  next?: string;
  to?: string;
  patch?: string;
  diff?: string;
  unified_diff?: string;
  unifiedDiff?: string;
  kind?: string;
  type?: string;
  action?: string;
  change_type?: string;
};

function normalizePatchChangeDetails(
  data: PatchChangeDetailsInput,
  ctx: z.RefinementCtx
): Omit<PatchFileChange, "path"> | null {
  const hasBeforeCandidate =
    data.before !== undefined ||
    data.original !== undefined ||
    data.old !== undefined ||
    data.previous !== undefined ||
    data.from !== undefined;
  const before = resolveExclusiveValue(
    ctx,
    [
      { key: "before", value: data.before },
      { key: "original", value: data.original },
      { key: "old", value: data.old },
      { key: "previous", value: data.previous },
      { key: "from", value: data.from },
    ],
    "patch change before",
    hasBeforeCandidate
  );
  if (hasBeforeCandidate && before === undefined) {
    return null;
  }
  const hasAfterCandidate =
    data.after !== undefined ||
    data.new !== undefined ||
    data.next !== undefined ||
    data.to !== undefined;
  const after = resolveExclusiveValue(
    ctx,
    [
      { key: "after", value: data.after },
      { key: "new", value: data.new },
      { key: "next", value: data.next },
      { key: "to", value: data.to },
    ],
    "patch change after",
    hasAfterCandidate
  );
  if (hasAfterCandidate && after === undefined) {
    return null;
  }
  const hasPatchCandidate =
    data.patch !== undefined ||
    data.diff !== undefined ||
    data.unified_diff !== undefined ||
    data.unifiedDiff !== undefined;
  const patch = resolveExclusiveValue(
    ctx,
    [
      { key: "patch", value: data.patch },
      { key: "diff", value: data.diff },
      { key: "unified_diff", value: data.unified_diff },
      { key: "unifiedDiff", value: data.unifiedDiff },
    ],
    "patch change patch",
    hasPatchCandidate
  );
  if (hasPatchCandidate && patch === undefined) {
    return null;
  }
  const hasKindCandidate =
    data.kind !== undefined ||
    data.type !== undefined ||
    data.action !== undefined ||
    data.change_type !== undefined;
  const kind = resolveExclusiveString(
    ctx,
    [
      { key: "kind", value: data.kind },
      { key: "type", value: data.type },
      { key: "action", value: data.action },
      { key: "change_type", value: data.change_type },
    ],
    "patch change kind",
    hasKindCandidate
  );
  if (hasKindCandidate && !kind) {
    return null;
  }
  let resolvedKind = kind;
  if (!resolvedKind) {
    if (before === undefined && after !== undefined) {
      resolvedKind = "create";
    } else if (before !== undefined && after === undefined) {
      resolvedKind = "delete";
    } else if (before !== undefined || after !== undefined || patch !== undefined) {
      resolvedKind = "edit";
    }
  }
  return { before, after, patch, kind: resolvedKind };
}

const PatchChangeDetailsBaseSchema = z
  .object({
    before: z.string().optional(),
    original: z.string().optional(),
    old: z.string().optional(),
    previous: z.string().optional(),
    from: z.string().optional(),
    after: z.string().optional(),
    new: z.string().optional(),
    next: z.string().optional(),
    to: z.string().optional(),
    patch: z.string().optional(),
    diff: z.string().optional(),
    unified_diff: z.string().optional(),
    unifiedDiff: z.string().optional(),
    kind: z.string().optional(),
    type: z.string().optional(),
    action: z.string().optional(),
    change_type: z.string().optional(),
  })
  .passthrough();

const PatchChangeDetailsSchema = PatchChangeDetailsBaseSchema.transform((data, ctx) => {
  const normalized = normalizePatchChangeDetails(data, ctx);
  if (!normalized) {
    return z.NEVER;
  }
  return normalized;
});

const PatchChangeEntrySchema = PatchChangeDetailsBaseSchema.extend({
  path: z.string().min(1),
}).transform((data, ctx) => {
  const normalized = normalizePatchChangeDetails(data, ctx);
  if (!normalized) {
    return z.NEVER;
  }
  return { path: data.path, ...normalized };
});

const PatchChangesSchema = z.union([
  z.array(PatchChangeEntrySchema),
  z.record(z.union([z.string(), PatchChangeDetailsSchema])),
]);

const PatchFileEntrySchema = z
  .object({
    path: z.string().min(1),
    kind: z.string().optional(),
    type: z.string().optional(),
    action: z.string().optional(),
  })
  .passthrough()
  .transform((data, ctx) => {
    const hasKindCandidate =
      data.kind !== undefined || data.type !== undefined || data.action !== undefined;
    const kind = resolveExclusiveString(
      ctx,
      [
        { key: "kind", value: data.kind },
        { key: "type", value: data.type },
        { key: "action", value: data.action },
      ],
      "patch file kind",
      hasKindCandidate
    );
    if (hasKindCandidate && !kind) {
      return z.NEVER;
    }
    return { path: data.path, kind };
  });

const McpToolObjectSchema = z
  .object({
    name: z.string().optional(),
    tool: z.string().optional(),
    input: z.unknown().optional(),
  })
  .passthrough();

const McpServerObjectSchema = z
  .object({
    name: z.string().optional(),
    id: z.string().optional(),
  })
  .passthrough();

const ReadFileInputSchema = z
  .object({
    path: z.string().optional(),
    file_path: z.string().optional(),
    filePath: z.string().optional(),
  })
  .passthrough()
  .transform((data, ctx) => {
    const path = resolveExclusiveString(
      ctx,
      [
        { key: "path", value: data.path },
        { key: "file_path", value: data.file_path },
        { key: "filePath", value: data.filePath },
      ],
      "read_file input path",
      true
    );
    if (!path) {
      return z.NEVER;
    }
    return { path };
  });

const ReadFileOutputSchema = z
  .object({
    content: z.string().optional(),
  })
  .passthrough();

const WebSearchInputSchema = z
  .object({
    query: z.string().optional(),
    search_query: z.string().optional(),
    searchQuery: z.string().optional(),
  })
  .passthrough()
  .transform((data, ctx) => {
    const query = resolveExclusiveString(
      ctx,
      [
        { key: "query", value: data.query },
        { key: "search_query", value: data.search_query },
        { key: "searchQuery", value: data.searchQuery },
      ],
      "web_search input query",
      true
    );
    if (!query) {
      return z.NEVER;
    }
    return { query };
  });

const TextContentItemSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

const ResponseBaseSchema = z
  .object({
    sessionId: z.string().optional(),
    session_id: z.string().optional(),
    conversationId: z.string().optional(),
    conversation_id: z.string().optional(),
    thread_id: z.string().optional(),
    model: z.string().optional(),
    meta: z.unknown().optional(),
    content: z.array(z.unknown()).optional(),
  })
  .passthrough();

const SessionIdentifiersSchema = z
  .object({
    sessionId: z.string().optional(),
    session_id: z.string().optional(),
    conversationId: z.string().optional(),
    conversation_id: z.string().optional(),
    thread_id: z.string().optional(),
    model: z.string().optional(),
  })
  .passthrough()
  .transform((data, ctx) => {
    const hasSessionCandidate =
      data.sessionId !== undefined || data.session_id !== undefined;
    const sessionId = resolveExclusiveString(
      ctx,
      [
        { key: "sessionId", value: data.sessionId },
        { key: "session_id", value: data.session_id },
      ],
      "session id",
      hasSessionCandidate
    );
    if (hasSessionCandidate && !sessionId) {
      return z.NEVER;
    }
    const hasConversationCandidate =
      data.conversationId !== undefined ||
      data.conversation_id !== undefined ||
      data.thread_id !== undefined;
    const conversationId = resolveExclusiveString(
      ctx,
      [
        { key: "conversationId", value: data.conversationId },
        { key: "conversation_id", value: data.conversation_id },
        { key: "thread_id", value: data.thread_id },
      ],
      "conversation id",
      hasConversationCandidate
    );
    if (hasConversationCandidate && !conversationId) {
      return z.NEVER;
    }
    return {
      sessionId,
      conversationId,
      model: data.model,
    };
  });

type SessionIdentifiers = z.infer<typeof SessionIdentifiersSchema>;

const RawMcpEventSchema = z
  .object({
    type: z.string(),
    data: z.unknown().optional(),
    item: z.unknown().optional(),
  })
  .passthrough();

type RawMcpEvent = z.infer<typeof RawMcpEventSchema>;

const RawEventDataSchema = z
  .object({
    type: z.string(),
  })
  .passthrough();

const UsageSchema = z
  .object({
    input_tokens: z.number().optional(),
    cached_input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    total_cost_usd: z.number().optional(),
  })
  .passthrough()
  .transform((data) => ({
    inputTokens: data.input_tokens,
    cachedInputTokens: data.cached_input_tokens,
    outputTokens: data.output_tokens,
    totalCostUsd: data.total_cost_usd,
  }));

const ThreadItemCallIdSchema = z
  .object({
    call_id: z.string().optional(),
    id: z.string().optional(),
  })
  .passthrough()
  .transform((data, ctx) => {
    const hasCallIdCandidate = data.call_id !== undefined || data.id !== undefined;
    const callId = resolveExclusiveString(
      ctx,
      [
        { key: "call_id", value: data.call_id },
        { key: "id", value: data.id },
      ],
      "thread item call_id",
      hasCallIdCandidate
    );
    if (hasCallIdCandidate && !callId) {
      return z.NEVER;
    }
    return { callId };
  });

const CommandOutputObjectSchema = z
  .object({
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    exit_code: ExitCodeSchema.optional(),
    exitCode: ExitCodeSchema.optional(),
    success: z.boolean().optional(),
  })
  .passthrough()
  .transform((data, ctx) => {
    const hasExitCodeCandidate =
      data.exit_code !== undefined || data.exitCode !== undefined;
    const exitCode = resolveExclusiveValue(
      ctx,
      [
        { key: "exit_code", value: data.exit_code },
        { key: "exitCode", value: data.exitCode },
      ],
      "command output exit_code",
      hasExitCodeCandidate
    );
    if (hasExitCodeCandidate && exitCode === undefined) {
      return z.NEVER;
    }
    return {
      stdout: data.stdout,
      stderr: data.stderr,
      exitCode,
      success: data.success,
    };
  });

const ExecCommandBeginEventSchema = z
  .object({
    type: z.literal("exec_command_begin"),
    call_id: CallIdSchema,
    command: CommandSchema,
    cwd: z.string().optional(),
  })
  .passthrough()
  .transform((data) => ({
    type: data.type,
    callId: data.call_id,
    command: data.command,
    cwd: data.cwd,
  }));

const ExecCommandEndEventSchema = z
  .object({
    type: z.literal("exec_command_end"),
    call_id: CallIdSchema,
    command: CommandSchema,
    cwd: z.string().optional(),
    exit_code: ExitCodeSchema.optional(),
    exitCode: ExitCodeSchema.optional(),
    output: z.union([z.string(), CommandOutputObjectSchema]).optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    status: z.string().optional(),
    success: z.boolean().optional(),
    error: z.unknown().optional(),
  })
  .passthrough()
  .transform((data, ctx) => {
    const hasExitCodeCandidate =
      data.exit_code !== undefined || data.exitCode !== undefined;
    const exitCode = resolveExclusiveValue(
      ctx,
      [
        { key: "exit_code", value: data.exit_code },
        { key: "exitCode", value: data.exitCode },
      ],
      "exec_command_end exit_code",
      hasExitCodeCandidate
    );
    if (hasExitCodeCandidate && exitCode === undefined) {
      return z.NEVER;
    }
    return {
      type: data.type,
      callId: data.call_id,
      command: data.command,
      cwd: data.cwd,
      exitCode,
      output: data.output,
      stdout: data.stdout,
      stderr: data.stderr,
      status: data.status,
      success: data.success,
      error: data.error,
    };
  });

const PatchApplyBeginEventSchema = z
  .object({
    type: z.literal("patch_apply_begin"),
    call_id: CallIdSchema,
    changes: PatchChangesSchema,
  })
  .passthrough()
  .transform((data) => ({
    type: data.type,
    callId: data.call_id,
    changes: data.changes,
  }));

const PatchApplyEndEventSchema = z
  .object({
    type: z.literal("patch_apply_end"),
    call_id: CallIdSchema,
    success: z.boolean().optional(),
    changes: PatchChangesSchema.optional(),
    files: z.array(PatchFileEntrySchema).optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
  })
  .passthrough()
  .transform((data) => ({
    type: data.type,
    callId: data.call_id,
    success: data.success,
    changes: data.changes,
    files: data.files,
    stdout: data.stdout,
    stderr: data.stderr,
  }));

const McpToolCallInvocationSchema = z
  .object({
    server: z.string(),
    tool: z.string(),
    arguments: z.unknown().optional(),
  })
  .passthrough();

const McpToolCallBeginEventSchema = z
  .object({
    type: z.literal("mcp_tool_call_begin"),
    call_id: CallIdSchema,
    invocation: McpToolCallInvocationSchema,
  })
  .passthrough()
  .transform((data) => ({
    type: data.type,
    callId: data.call_id,
    server: data.invocation.server,
    tool: data.invocation.tool,
    input: data.invocation.arguments,
  }));

const McpToolCallEndEventSchema = z
  .object({
    type: z.literal("mcp_tool_call_end"),
    call_id: CallIdSchema,
    invocation: McpToolCallInvocationSchema,
    result: z.unknown().optional(),
  })
  .passthrough()
  .transform((data) => ({
    type: data.type,
    callId: data.call_id,
    server: data.invocation.server,
    tool: data.invocation.tool,
    input: data.invocation.arguments,
    result: data.result,
  }));

const AgentMessageEventSchema = z
  .object({
    type: z.literal("agent_message"),
    message: z.string().optional(),
    text: z.string().optional(),
  })
  .passthrough()
  .transform((data, ctx) => {
    const text = resolveExclusiveString(
      ctx,
      [
        { key: "message", value: data.message },
        { key: "text", value: data.text },
      ],
      "agent_message text",
      true
    );
    if (!text) {
      return z.NEVER;
    }
    return { type: data.type, text };
  });

const AgentReasoningEventSchema = z
  .object({
    type: z.literal("agent_reasoning"),
    text: z.string().optional(),
    delta: z.string().optional(),
  })
  .passthrough()
  .transform((data, ctx) => {
    const text = resolveExclusiveString(
      ctx,
      [
        { key: "text", value: data.text },
        { key: "delta", value: data.delta },
      ],
      "agent_reasoning text",
      true
    );
    if (!text) {
      return z.NEVER;
    }
    return { type: data.type, text };
  });

const AgentReasoningDeltaEventSchema = z
  .object({
    type: z.literal("agent_reasoning_delta"),
    text: z.string().optional(),
    delta: z.string().optional(),
  })
  .passthrough()
  .transform((data, ctx) => {
    const text = resolveExclusiveString(
      ctx,
      [
        { key: "text", value: data.text },
        { key: "delta", value: data.delta },
      ],
      "agent_reasoning_delta text",
      true
    );
    if (!text) {
      return z.NEVER;
    }
    return { type: data.type, text };
  });

const TaskStartedEventSchema = z.object({
  type: z.literal("task_started"),
});

const TaskCompleteEventSchema = z.object({
  type: z.literal("task_complete"),
});

const TurnAbortedEventSchema = z.object({
  type: z.literal("turn_aborted"),
});

const ThreadStartedEventSchema = z
  .object({
    type: z.literal("thread.started"),
    thread_id: z.string().min(1),
  })
  .passthrough()
  .transform((data) => ({
    type: data.type,
    threadId: data.thread_id,
  }));

const TurnStartedEventSchema = z.object({
  type: z.literal("turn.started"),
});

const TurnCompletedEventSchema = z
  .object({
    type: z.literal("turn.completed"),
    usage: z.unknown().optional(),
  })
  .passthrough()
  .transform((data, ctx) => {
    if (data.usage === undefined) {
      return { type: data.type, usage: undefined };
    }
    const parsed = UsageSchema.safeParse(data.usage);
    if (!parsed.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "turn.completed usage invalid",
      });
      return z.NEVER;
    }
    return { type: data.type, usage: parsed.data };
  });

const TurnFailedEventSchema = z
  .object({
    type: z.literal("turn.failed"),
    error: z.object({ message: z.string().min(1) }),
  })
  .passthrough()
  .transform((data) => ({
    type: data.type,
    error: data.error.message,
  }));

const ThreadItemMessageSchema = z
  .object({
    type: z.literal("agent_message"),
    text: z.string().min(1),
  })
  .passthrough()
  .transform((data) => ({
    type: "agent_message" as const,
    text: data.text,
  }));

const ThreadItemAgentMessageSchema = z
  .object({
    type: z.literal("AgentMessage"),
    content: z.array(z.unknown()).optional(),
  })
  .passthrough()
  .transform((data, ctx) => {
    const text = extractContentText(data.content);
    if (!text) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "agent message content missing",
      });
      return z.NEVER;
    }
    return { type: "agent_message" as const, text };
  });

const ThreadItemReasoningSchema = z
  .object({
    type: z.literal("reasoning"),
    text: z.string().min(1),
  })
  .passthrough()
  .transform((data) => ({
    type: "reasoning" as const,
    text: data.text,
  }));

const ThreadItemReasoningSummarySchema = z
  .object({
    type: z.literal("Reasoning"),
    summary_text: z.array(z.unknown()).optional(),
    summary: z.array(z.unknown()).optional(),
  })
  .passthrough()
  .transform((data, ctx) => {
    const text = extractSummaryText(
      data.summary_text !== undefined ? data.summary_text : data.summary
    );
    if (!text) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "reasoning summary missing",
      });
      return z.NEVER;
    }
    return { type: "reasoning" as const, text };
  });

const ThreadItemUserMessageSchema = z
  .object({
    type: z.literal("user_message"),
    text: z.string().min(1),
  })
  .passthrough()
  .transform((data) => ({
    type: "user_message" as const,
    text: data.text,
  }));

const ThreadItemUserMessageContentSchema = z
  .object({
    type: z.literal("UserMessage"),
    content: z.array(z.unknown()).optional(),
  })
  .passthrough()
  .transform((data, ctx) => {
    const text = extractContentText(data.content);
    if (!text) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "user message content missing",
      });
      return z.NEVER;
    }
    return { type: "user_message" as const, text };
  });

const CommandExecutionItemSchema = ThreadItemCallIdSchema.and(
  z
    .object({
      type: z.literal("command_execution"),
      command: CommandSchema,
      status: z.string().optional(),
      success: z.boolean().optional(),
      error: z.unknown().optional(),
      exit_code: ExitCodeSchema.optional(),
      exitCode: ExitCodeSchema.optional(),
      aggregated_output: z.string().optional(),
      cwd: z.string().optional(),
    })
    .passthrough()
).transform((data, ctx) => {
  const hasExitCodeCandidate =
    data.exit_code !== undefined || data.exitCode !== undefined;
  const exitCode = resolveExclusiveValue(
    ctx,
    [
      { key: "exit_code", value: data.exit_code },
      { key: "exitCode", value: data.exitCode },
    ],
    "command_execution exit_code",
    hasExitCodeCandidate
  );
  if (hasExitCodeCandidate && exitCode === undefined) {
    return z.NEVER;
  }
  return {
    type: "command_execution" as const,
    callId: data.callId,
    command: data.command,
    status: data.status,
    success: data.success,
    error: data.error,
    exitCode,
    aggregatedOutput: data.aggregated_output,
    cwd: data.cwd,
  };
});

const FileChangeItemSchema = ThreadItemCallIdSchema.and(
  z
    .object({
      type: z.literal("file_change"),
      changes: PatchChangesSchema.optional(),
    })
    .passthrough()
).transform((data) => ({
  type: "file_change" as const,
  callId: data.callId,
  changes: data.changes,
}));

const ReadFileItemSchema = ThreadItemCallIdSchema.and(
  z
    .object({
      type: z.union([z.literal("read_file"), z.literal("file_read")]),
      input: z.unknown().optional(),
      output: z.unknown().optional(),
      path: z.string().optional(),
      file_path: z.string().optional(),
      filePath: z.string().optional(),
      content: z.string().optional(),
      text: z.string().optional(),
      status: z.string().optional(),
    })
    .passthrough()
).transform((data, ctx) => {
  let input: z.infer<typeof ReadFileInputSchema> | undefined;
  if (data.input !== undefined) {
    const inputParsed = ReadFileInputSchema.safeParse(data.input);
    if (!inputParsed.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "read_file input invalid",
      });
      return z.NEVER;
    }
    input = inputParsed.data;
  }
  let output: z.infer<typeof ReadFileOutputSchema> | undefined;
  let outputText: string | undefined;
  if (data.output !== undefined) {
    if (typeof data.output === "string") {
      outputText = data.output;
    } else {
      const outputParsed = ReadFileOutputSchema.safeParse(data.output);
      if (!outputParsed.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "read_file output invalid",
        });
        return z.NEVER;
      }
      output = outputParsed.data;
    }
  }
  const path = resolveExclusiveString(
    ctx,
    [
      { key: "input.path", value: input?.path },
      { key: "path", value: data.path },
      { key: "file_path", value: data.file_path },
      { key: "filePath", value: data.filePath },
    ],
    "read_file path",
    true
  );
  if (!path) {
    return z.NEVER;
  }
  const hasContentCandidate =
    outputText !== undefined ||
    output?.content !== undefined ||
    data.content !== undefined ||
    data.text !== undefined;
  const content = resolveExclusiveValue(
    ctx,
    [
      { key: "output", value: outputText },
      { key: "output.content", value: output?.content },
      { key: "content", value: data.content },
      { key: "text", value: data.text },
    ],
    "read_file content",
    hasContentCandidate
  );
  if (hasContentCandidate && content === undefined) {
    return z.NEVER;
  }
  return {
    type: data.type as "read_file" | "file_read",
    callId: data.callId,
    status: data.status,
    path,
    input,
    output: data.output,
    content,
  };
});

const McpToolCallItemSchema = ThreadItemCallIdSchema.and(
  z
    .object({
      type: z.literal("mcp_tool_call"),
      server: z.union([z.string(), McpServerObjectSchema]).optional(),
      server_name: z.string().optional(),
      serverId: z.string().optional(),
      server_id: z.string().optional(),
      mcp_server: z.string().optional(),
      tool: z.union([z.string(), McpToolObjectSchema]).optional(),
      tool_name: z.string().optional(),
      toolId: z.string().optional(),
      tool_id: z.string().optional(),
      name: z.string().optional(),
      input: z.unknown().optional(),
      arguments: z.unknown().optional(),
      args: z.unknown().optional(),
      params: z.unknown().optional(),
      request: z.unknown().optional(),
      output: z.unknown().optional(),
      result: z.unknown().optional(),
      response: z.unknown().optional(),
      return: z.unknown().optional(),
      returns: z.unknown().optional(),
      result_content: z.unknown().optional(),
      content: z.unknown().optional(),
      structuredContent: z.unknown().optional(),
      structured_content: z.unknown().optional(),
      status: z.string().optional(),
      state: z.string().optional(),
      outcome: z.string().optional(),
    })
    .passthrough()
).transform((data, ctx) => {
  const serverObject =
    typeof data.server === "object" && data.server !== null
      ? McpServerObjectSchema.safeParse(data.server).success
        ? McpServerObjectSchema.parse(data.server)
        : undefined
      : undefined;
  const toolObject =
    typeof data.tool === "object" && data.tool !== null
      ? McpToolObjectSchema.safeParse(data.tool).success
        ? McpToolObjectSchema.parse(data.tool)
        : undefined
      : undefined;
  const serverFromObject = serverObject
    ? resolveExclusiveString(
        ctx,
        [
          { key: "server.name", value: serverObject.name },
          { key: "server.id", value: serverObject.id },
        ],
        "mcp_tool_call server",
        true
      )
    : undefined;
  if (serverObject && !serverFromObject) {
    return z.NEVER;
  }
  const toolFromObject = toolObject
    ? resolveExclusiveString(
        ctx,
        [
          { key: "tool.name", value: toolObject.name },
          { key: "tool.tool", value: toolObject.tool },
        ],
        "mcp_tool_call tool",
        true
      )
    : undefined;
  if (toolObject && !toolFromObject) {
    return z.NEVER;
  }
  const hasServerCandidate =
    typeof data.server === "string" ||
    serverFromObject !== undefined ||
    data.server_name !== undefined ||
    data.serverId !== undefined ||
    data.server_id !== undefined ||
    data.mcp_server !== undefined;
  const server = resolveExclusiveString(
    ctx,
    [
      { key: "server", value: typeof data.server === "string" ? data.server : undefined },
      { key: "server.object", value: serverFromObject },
      { key: "server_name", value: data.server_name },
      { key: "serverId", value: data.serverId },
      { key: "server_id", value: data.server_id },
      { key: "mcp_server", value: data.mcp_server },
    ],
    "mcp_tool_call server",
    hasServerCandidate
  );
  if (hasServerCandidate && !server) {
    return z.NEVER;
  }
  const hasToolCandidate =
    typeof data.tool === "string" ||
    toolFromObject !== undefined ||
    data.tool_name !== undefined ||
    data.toolId !== undefined ||
    data.tool_id !== undefined ||
    data.name !== undefined;
  let tool = resolveExclusiveString(
    ctx,
    [
      { key: "tool", value: typeof data.tool === "string" ? data.tool : undefined },
      { key: "tool.object", value: toolFromObject },
      { key: "tool_name", value: data.tool_name },
      { key: "toolId", value: data.toolId },
      { key: "tool_id", value: data.tool_id },
      { key: "name", value: data.name },
    ],
    "mcp_tool_call tool",
    hasToolCandidate
  );
  if (hasToolCandidate && !tool) {
    return z.NEVER;
  }
  let resolvedServer = server;
  if (!resolvedServer && tool && tool.includes(".")) {
    const [serverName, ...toolParts] = tool.split(".");
    if (serverName.length > 0) {
      resolvedServer = serverName;
    }
    const toolName = toolParts.join(".");
    tool = toolName.length > 0 ? toolName : tool;
  }
  if (!resolvedServer || !tool) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "mcp_tool_call missing server or tool",
    });
    return z.NEVER;
  }
  const hasInputCandidate =
    data.input !== undefined ||
    data.arguments !== undefined ||
    data.args !== undefined ||
    data.params !== undefined ||
    data.request !== undefined ||
    toolObject?.input !== undefined;
  const input = resolveExclusiveValue(
    ctx,
    [
      { key: "input", value: data.input },
      { key: "arguments", value: data.arguments },
      { key: "args", value: data.args },
      { key: "params", value: data.params },
      { key: "request", value: data.request },
      { key: "tool.input", value: toolObject?.input },
    ],
    "mcp_tool_call input",
    hasInputCandidate
  );
  if (hasInputCandidate && input === undefined) {
    return z.NEVER;
  }
  const hasOutputCandidate =
    data.output !== undefined ||
    data.result !== undefined ||
    data.response !== undefined ||
    data.return !== undefined ||
    data.returns !== undefined ||
    data.result_content !== undefined ||
    data.content !== undefined ||
    data.structuredContent !== undefined ||
    data.structured_content !== undefined;
  const output = resolveExclusiveValue(
    ctx,
    [
      { key: "output", value: data.output },
      { key: "result", value: data.result },
      { key: "response", value: data.response },
      { key: "return", value: data.return },
      { key: "returns", value: data.returns },
      { key: "result_content", value: data.result_content },
      { key: "content", value: data.content },
      { key: "structuredContent", value: data.structuredContent },
      { key: "structured_content", value: data.structured_content },
    ],
    "mcp_tool_call output",
    hasOutputCandidate
  );
  if (hasOutputCandidate && output === undefined) {
    return z.NEVER;
  }
  const hasStatusCandidate =
    data.status !== undefined || data.state !== undefined || data.outcome !== undefined;
  const status = resolveExclusiveString(
    ctx,
    [
      { key: "status", value: data.status },
      { key: "state", value: data.state },
      { key: "outcome", value: data.outcome },
    ],
    "mcp_tool_call status",
    hasStatusCandidate
  );
  if (hasStatusCandidate && !status) {
    return z.NEVER;
  }
  return {
    type: "mcp_tool_call" as const,
    callId: data.callId,
    server: resolvedServer,
    tool,
    status,
    input,
    output,
  };
});

const WebSearchItemSchema = ThreadItemCallIdSchema.and(
  z
    .object({
      type: z.literal("web_search"),
      input: z.unknown().optional(),
      output: z.unknown().optional(),
      query: z.string().optional(),
      search_query: z.string().optional(),
      searchQuery: z.string().optional(),
      results: z.unknown().optional(),
      search_results: z.unknown().optional(),
      searchResults: z.unknown().optional(),
      items: z.unknown().optional(),
      documents: z.unknown().optional(),
      data: z.unknown().optional(),
      content: z.unknown().optional(),
      response: z.unknown().optional(),
      result: z.unknown().optional(),
      status: z.string().optional(),
    })
    .passthrough()
).transform((data, ctx) => {
  let input: z.infer<typeof WebSearchInputSchema> | undefined;
  if (data.input !== undefined) {
    if (typeof data.input !== "object" || data.input === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "web_search input invalid",
      });
      return z.NEVER;
    }
    const inputParsed = WebSearchInputSchema.safeParse(data.input);
    if (!inputParsed.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "web_search input invalid",
      });
      return z.NEVER;
    }
    input = inputParsed.data;
  }
  const query = resolveExclusiveString(
    ctx,
    [
      { key: "query", value: data.query },
      { key: "search_query", value: data.search_query },
      { key: "searchQuery", value: data.searchQuery },
      { key: "input.query", value: input?.query },
    ],
    "web_search query",
    true
  );
  if (!query) {
    return z.NEVER;
  }
  const hasResultsCandidate =
    data.output !== undefined ||
    data.results !== undefined ||
    data.search_results !== undefined ||
    data.searchResults !== undefined ||
    data.items !== undefined ||
    data.documents !== undefined ||
    data.data !== undefined ||
    data.content !== undefined ||
    data.response !== undefined ||
    data.result !== undefined;
  const results = resolveExclusiveValue(
    ctx,
    [
      { key: "output", value: data.output },
      { key: "results", value: data.results },
      { key: "search_results", value: data.search_results },
      { key: "searchResults", value: data.searchResults },
      { key: "items", value: data.items },
      { key: "documents", value: data.documents },
      { key: "data", value: data.data },
      { key: "content", value: data.content },
      { key: "response", value: data.response },
      { key: "result", value: data.result },
    ],
    "web_search results",
    hasResultsCandidate
  );
  if (hasResultsCandidate && results === undefined) {
    return z.NEVER;
  }
  return {
    type: "web_search" as const,
    callId: data.callId,
    query,
    status: data.status,
    input: data.input,
    output: data.output,
    results,
  };
});

const TodoListItemSchema = z
  .object({
    type: z.literal("todo_list"),
    items: z.array(
      z.object({
        text: z.string().min(1),
        completed: z.boolean(),
      })
    ),
  })
  .passthrough()
  .transform((data) => ({
    type: "todo_list" as const,
    items: data.items,
  }));

const ErrorItemSchema = z
  .object({
    type: z.literal("error"),
    message: z.string().min(1),
  })
  .passthrough()
  .transform((data) => ({
    type: "error" as const,
    message: data.message,
  }));

const ThreadItemSchema = z.union([
  ThreadItemMessageSchema,
  ThreadItemAgentMessageSchema,
  ThreadItemReasoningSchema,
  ThreadItemReasoningSummarySchema,
  ThreadItemUserMessageSchema,
  ThreadItemUserMessageContentSchema,
  CommandExecutionItemSchema,
  FileChangeItemSchema,
  ReadFileItemSchema,
  McpToolCallItemSchema,
  WebSearchItemSchema,
  TodoListItemSchema,
  ErrorItemSchema,
]);

type ThreadItem = z.infer<typeof ThreadItemSchema>;
type ThreadItemByType<T extends ThreadItem["type"]> = Extract<
  ThreadItem,
  { type: T }
>;
type ReadFileThreadItem = Extract<
  ThreadItem,
  { type: "read_file" | "file_read" }
>;

function isThreadItemType<T extends ThreadItem["type"]>(
  item: ThreadItem,
  type: T
): item is ThreadItemByType<T> {
  return item.type === type;
}

const TodoListInputSchema = z
  .union([
    z.array(
      z.union([
        z.string().min(1),
        z
          .object({
            text: z.string().min(1),
            completed: z.boolean().optional(),
          })
          .passthrough(),
      ])
    ),
    z
      .object({
        items: z.array(
          z.union([
            z.string().min(1),
            z
              .object({
                text: z.string().min(1),
                completed: z.boolean().optional(),
              })
              .passthrough(),
          ])
        ),
      })
      .passthrough(),
  ])
  .transform((data, ctx) => {
    const rawItems = Array.isArray(data) ? data : data.items;
    if (rawItems.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "todo_list items missing",
      });
      return z.NEVER;
    }
    return rawItems.map((item) => {
      if (typeof item === "string") {
        return { text: item, completed: false };
      }
      return {
        text: item.text,
        completed: item.completed ?? false,
      };
    });
  });

const RawResponseItemSchema = z
  .object({
    type: z.literal("raw_response_item"),
    item: z.unknown(),
  })
  .passthrough();

const RawToolCallSchema = z
  .object({
    type: z.union([
      z.literal("custom_tool_call"),
      z.literal("tool_call"),
      z.literal("function_call"),
    ]),
    call_id: z.string().optional(),
    id: z.string().optional(),
    name: z.string().optional(),
    tool_name: z.string().optional(),
    input: z.unknown().optional(),
    arguments: z.unknown().optional(),
    args: z.unknown().optional(),
    params: z.unknown().optional(),
    request: z.unknown().optional(),
    output: z.unknown().optional(),
    result: z.unknown().optional(),
    response: z.unknown().optional(),
    return: z.unknown().optional(),
    returns: z.unknown().optional(),
    status: z.string().optional(),
  })
  .passthrough()
  .transform((data, ctx) => {
    const callId = resolveExclusiveString(
      ctx,
      [
        { key: "call_id", value: data.call_id },
        { key: "id", value: data.id },
      ],
      "raw tool call id",
      false
    );
    const toolName = resolveExclusiveString(
      ctx,
      [
        { key: "name", value: data.name },
        { key: "tool_name", value: data.tool_name },
      ],
      "raw tool call name",
      true
    );
    if (!toolName) {
      return z.NEVER;
    }
    const input = resolveExclusiveValue(
      ctx,
      [
        { key: "input", value: data.input },
        { key: "arguments", value: data.arguments },
        { key: "args", value: data.args },
        { key: "params", value: data.params },
        { key: "request", value: data.request },
      ],
      "raw tool call input",
      false
    );
    const output = resolveExclusiveValue(
      ctx,
      [
        { key: "output", value: data.output },
        { key: "result", value: data.result },
        { key: "response", value: data.response },
        { key: "return", value: data.return },
        { key: "returns", value: data.returns },
      ],
      "raw tool call output",
      false
    );
    return {
      callId,
      toolName,
      input,
      output,
      status: data.status,
    };
  });

const RawWebSearchCallSchema = z
  .object({
    type: z.literal("web_search_call"),
    status: z.string().optional(),
    action: z
      .object({
        query: z.string().min(1),
      })
      .passthrough(),
  })
  .passthrough()
  .transform((data) => ({
    query: data.action.query,
    status: data.status,
  }));

const RawResponseItemEventSchema = RawResponseItemSchema.transform((data) => ({
  type: data.type,
  item: data.item,
}));

const ThreadItemEventSchema = z
  .object({
    type: z.union([
      z.literal("item.started"),
      z.literal("item.updated"),
      z.literal("item.completed"),
    ]),
    item: z.unknown(),
  })
  .passthrough()
  .transform((data, ctx) => {
    const parsed = ThreadItemSchema.safeParse(data.item);
    if (!parsed.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid thread item",
      });
      return z.NEVER;
    }
    return { type: data.type, item: parsed.data };
  });

const ErrorEventSchema = z
  .object({
    type: z.literal("error"),
    message: z.string().min(1),
  })
  .passthrough()
  .transform((data) => ({
    type: data.type,
    message: data.message,
  }));

const CodexEventSchema = z.union([
  AgentMessageEventSchema,
  AgentReasoningEventSchema,
  AgentReasoningDeltaEventSchema,
  TaskStartedEventSchema,
  TaskCompleteEventSchema,
  TurnAbortedEventSchema,
  ExecCommandBeginEventSchema,
  ExecCommandEndEventSchema,
  PatchApplyBeginEventSchema,
  PatchApplyEndEventSchema,
  McpToolCallBeginEventSchema,
  McpToolCallEndEventSchema,
  ThreadStartedEventSchema,
  TurnStartedEventSchema,
  TurnCompletedEventSchema,
  TurnFailedEventSchema,
  ThreadItemEventSchema,
  RawResponseItemEventSchema,
  ErrorEventSchema,
]);

type CodexEvent = z.infer<typeof CodexEventSchema>;
type ThreadEvent = Extract<
  CodexEvent,
  {
    type:
      | "thread.started"
      | "turn.started"
      | "turn.completed"
      | "turn.failed"
      | "item.started"
      | "item.updated"
      | "item.completed"
      | "error";
  }
>;

const PermissionParamsSchema = z
  .object({
    codex_call_id: z.string().optional(),
    codex_mcp_tool_call_id: z.string().optional(),
    codex_event_id: z.string().optional(),
    call_id: z.string().optional(),
    codex_command: CommandSchema.optional(),
    command: CommandSchema.optional(),
    codex_cwd: z.string().optional(),
    cwd: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough()
  .transform((data, ctx) => {
    const callId = resolvePreferredString(
      ctx,
      [
        { key: "codex_call_id", value: data.codex_call_id },
        { key: "codex_mcp_tool_call_id", value: data.codex_mcp_tool_call_id },
        { key: "codex_event_id", value: data.codex_event_id },
        { key: "call_id", value: data.call_id },
      ],
      "permission call_id",
      true
    );
    if (!callId) {
      return z.NEVER;
    }
    const command = resolveExclusiveValue(
      ctx,
      [
        { key: "codex_command", value: data.codex_command },
        { key: "command", value: data.command },
      ],
      "permission command",
      true
    );
    if (!command) {
      return z.NEVER;
    }
    const hasCwdCandidate = data.codex_cwd !== undefined || data.cwd !== undefined;
    const cwd = resolveExclusiveString(
      ctx,
      [
        { key: "codex_cwd", value: data.codex_cwd },
        { key: "cwd", value: data.cwd },
      ],
      "permission cwd",
      hasCwdCandidate
    );
    if (hasCwdCandidate && !cwd) {
      return z.NEVER;
    }
    return {
      callId,
      command,
      cwd,
      message: data.message,
      raw: data,
    };
  });

type PermissionParams = z.infer<typeof PermissionParamsSchema>;

const AgentControlMcpConfigSchema = z.object({
  url: z.string(),
  headers: z.record(z.string()).optional(),
});

type AgentSessionExtra = NonNullable<AgentSessionConfig["extra"]>;

const AgentSessionExtraSchema = z.object({
  codex: z.record(z.unknown()).optional(),
  claude: z.custom<AgentSessionExtra["claude"]>().optional(),
});

const AgentSessionConfigSchema = z
  .object({
    provider: z.string(),
    cwd: z.string(),
    modeId: z.string().optional(),
    model: z.string().optional(),
    title: z.string().nullable().optional(),
    approvalPolicy: z.string().optional(),
    sandboxMode: z.string().optional(),
    networkAccess: z.boolean().optional(),
    webSearch: z.boolean().optional(),
    reasoningEffort: z.string().optional(),
    agentControlMcp: AgentControlMcpConfigSchema.optional(),
    extra: AgentSessionExtraSchema.optional(),
    mcpServers: z.record(z.unknown()).optional(),
    parentAgentId: z.string().optional(),
  })
  .passthrough();

type StoredSessionConfig = z.infer<typeof AgentSessionConfigSchema>;

function parsePatchChanges(changes: unknown): PatchFileChange[] {
  const parsed = PatchChangesSchema.parse(changes);
  if (Array.isArray(parsed)) {
    return parsed;
  }
  return Object.entries(parsed).map(([path, value]) => {
    if (typeof value === "string") {
      return { path, kind: "edit", patch: value };
    }
    return { path, ...value };
  });
}

function parsePatchFiles(files: unknown): PatchFileChange[] {
  if (files === undefined) {
    return [];
  }
  return z.array(PatchFileEntrySchema).parse(files);
}

function extractPatchPaths(text: string): string[] {
  const paths = new Set<string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("+++ ") && !trimmed.startsWith("--- ")) {
      continue;
    }
    const rawPath = trimmed.slice(4).trim();
    if (!rawPath || rawPath === "/dev/null") {
      continue;
    }
    const cleaned = rawPath.replace(/^([ab])\//, "");
    if (cleaned) {
      paths.add(cleaned);
    }
  }
  return Array.from(paths);
}

function normalizeCommand(command: Command): string {
  return typeof command === "string" ? command : command.join(" ");
}

function buildFileChangeSummary(files: { path: string; kind: string }[]): string {
  if (files.length === 1) {
    return `${files[0].kind}: ${files[0].path}`;
  }
  return `${files.length} file changes`;
}

function extractContentText(content: unknown): string | null {
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const item of content) {
    const parsed = z.object({ text: z.string() }).safeParse(item);
    if (parsed.success) {
      parts.push(parsed.data.text);
    }
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.join("");
}

function extractSummaryText(summary: unknown): string | null {
  if (!Array.isArray(summary)) {
    return null;
  }
  const parts: string[] = [];
  for (const item of summary) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    const parsed = z.object({ text: z.string() }).safeParse(item);
    if (parsed.success) {
      parts.push(parsed.data.text);
    }
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.join("\n");
}

function normalizeStructuredPayload(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    (!trimmed.startsWith("{") && !trimmed.startsWith("["))
  ) {
    return value;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function isKeyedObject(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null;
}

function normalizeToolName(toolName: string): string {
  if (!toolName.startsWith("mcp__")) {
    return toolName;
  }
  const parts = toolName.split("__").filter((part) => part.length > 0);
  if (parts.length < 3) {
    return toolName;
  }
  const serverName = parts[1];
  const toolParts = parts.slice(2);
  return `${serverName}.${toolParts.join("__")}`;
}

function extractMcpToolResultPayload(result: unknown): {
  output: unknown;
  success: boolean;
} {
  let success = true;
  let payload = result;

  if (isKeyedObject(result)) {
    if ("Ok" in result) {
      payload = result.Ok;
      success = true;
    } else if ("ok" in result) {
      payload = result.ok;
      success = true;
    } else if ("Err" in result) {
      payload = result.Err;
      success = false;
    } else if ("err" in result) {
      payload = result.err;
      success = false;
    }
  }

  if (isKeyedObject(payload)) {
    if ("structuredContent" in payload && payload.structuredContent !== undefined) {
      return { output: payload.structuredContent, success };
    }
    if ("structured_content" in payload && payload.structured_content !== undefined) {
      return { output: payload.structured_content, success };
    }
    if ("content" in payload && payload.content !== undefined) {
      return { output: payload.content, success };
    }
  }

  return { output: payload, success };
}

function extractWebSearchQuery(
  input: unknown,
  output: unknown
): string | null {
  if (typeof input === "string") {
    const trimmed = input.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (input !== undefined) {
    const parsed = WebSearchInputSchema.safeParse(input);
    if (parsed.success) {
      return parsed.data.query;
    }
  }
  if (output !== undefined) {
    const parsed = WebSearchInputSchema.safeParse(output);
    if (parsed.success) {
      return parsed.data.query;
    }
  }
  return null;
}

function extractTodoItems(input: unknown, output: unknown) {
  if (input !== undefined) {
    const parsed = TodoListInputSchema.safeParse(input);
    if (parsed.success) {
      return parsed.data;
    }
  }
  if (output !== undefined) {
    const parsed = TodoListInputSchema.safeParse(output);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return null;
}

function mapRawResponseItemToThreadItem(item: unknown): ThreadItem | null {
  const webSearchParsed = RawWebSearchCallSchema.safeParse(item);
  if (webSearchParsed.success) {
    const parsed = ThreadItemSchema.safeParse({
      type: "web_search",
      query: webSearchParsed.data.query,
      status: webSearchParsed.data.status,
    });
    return parsed.success ? parsed.data : null;
  }

  const toolCallParsed = RawToolCallSchema.safeParse(item);
  if (!toolCallParsed.success) {
    return null;
  }
  const toolName = normalizeToolName(toolCallParsed.data.toolName);
  const toolNameLower = toolName.toLowerCase();
  const toolNameSuffix = toolNameLower.includes(".")
    ? toolNameLower.split(".").slice(-1)[0]
    : toolNameLower;
  const callId = toolCallParsed.data.callId;
  const input = normalizeStructuredPayload(toolCallParsed.data.input);
  const output = normalizeStructuredPayload(toolCallParsed.data.output);

  if (toolNameLower === "apply_patch") {
    let changes: PatchFileChange[] | undefined;
    const changeSource =
      isKeyedObject(input) && "changes" in input ? input.changes : input;
    if (changeSource !== undefined) {
      const parsedChanges = PatchChangesSchema.safeParse(changeSource);
      if (parsedChanges.success) {
        changes = parsePatchChanges(parsedChanges.data);
      }
    }
    if (!changes && isKeyedObject(input) && typeof input.patch === "string") {
      const patchContent = input.patch;
      const paths = extractPatchPaths(patchContent);
      if (paths.length > 0) {
        changes = paths.map((path) => ({ path, kind: "edit", patch: patchContent }));
      }
    }
    const parsed = ThreadItemSchema.safeParse({
      type: "file_change",
      call_id: callId,
      changes,
    });
    return parsed.success ? parsed.data : null;
  }

  if (toolNameSuffix === "web_search") {
    const query = extractWebSearchQuery(input, output);
    if (!query) {
      return null;
    }
    const parsed = ThreadItemSchema.safeParse({
      type: "web_search",
      call_id: callId,
      query,
      input: typeof input === "object" && input !== null ? input : { query },
      output,
    });
    return parsed.success ? parsed.data : null;
  }

  if (toolNameSuffix === "todo_list") {
    const items = extractTodoItems(input, output);
    if (!items) {
      return null;
    }
    const parsed = ThreadItemSchema.safeParse({
      type: "todo_list",
      items,
    });
    return parsed.success ? parsed.data : null;
  }

  if (toolName.includes(".")) {
    const [serverName, ...toolParts] = toolName.split(".");
    const tool = toolParts.join(".");
    if (!serverName || !tool) {
      return null;
    }
    const parsed = ThreadItemSchema.safeParse({
      type: "mcp_tool_call",
      call_id: callId,
      server: serverName,
      tool,
      input,
      output,
      status: toolCallParsed.data.status,
    });
    return parsed.success ? parsed.data : null;
  }

  return null;
}

function extractTextContent(response: unknown): string | null {
  const parsed = ResponseBaseSchema.parse(response);
  const content = parsed.content;
  if (!content) {
    return null;
  }
  const parts: string[] = [];
  for (const item of content) {
    const textParsed = TextContentItemSchema.safeParse(item);
    if (textParsed.success) {
      parts.push(textParsed.data.text);
    }
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.join("\n");
}

function normalizeEvent(raw: unknown): CodexEvent {
  const base = RawMcpEventSchema.parse(raw);
  const dataParse = RawEventDataSchema.safeParse(base.data);
  let eventType = base.type;
  let eventRecord: RawMcpEvent = base;
  if ((eventType === "event" || eventType.length === 0) && dataParse.success) {
    eventType = dataParse.data.type;
    eventRecord = { ...base, ...dataParse.data, type: eventType };
  }
  const normalizedType = normalizeThreadEventType(eventType);
  if (normalizedType !== eventType) {
    eventRecord = { ...eventRecord, type: normalizedType };
  }
  const snakeCaseTypeMap: Record<string, string> = {
    thread_started: "thread.started",
    turn_started: "turn.started",
    turn_completed: "turn.completed",
    turn_failed: "turn.failed",
    item_started: "item.started",
    item_updated: "item.updated",
    item_completed: "item.completed",
  };
  const snakeCaseType = snakeCaseTypeMap[normalizedType];
  if (snakeCaseType !== undefined) {
    eventRecord = { ...eventRecord, type: snakeCaseType };
  }
  if (normalizedType === "task_started") {
    eventRecord = { ...eventRecord, type: "turn.started" };
  } else if (normalizedType === "task_complete") {
    eventRecord = { ...eventRecord, type: "turn.completed" };
  }
  const rawResponseParsed = RawResponseItemSchema.safeParse(eventRecord);
  if (rawResponseParsed.success) {
    const mappedItem = mapRawResponseItemToThreadItem(rawResponseParsed.data.item);
    if (mappedItem) {
      return CodexEventSchema.parse({ type: "item.completed", item: mappedItem });
    }
  }
  const patchEndParsed = PatchApplyEndEventSchema.safeParse(eventRecord);
  if (patchEndParsed.success) {
    const changes = patchEndParsed.data.changes
      ? patchEndParsed.data.changes
      : patchEndParsed.data.files;
    const parsed = ThreadItemSchema.safeParse({
      type: "file_change",
      call_id: patchEndParsed.data.callId,
      changes,
    });
    if (parsed.success) {
      return CodexEventSchema.parse({ type: "item.completed", item: parsed.data });
    }
  }
  const isTopLevelItemEvent = z
    .union([
      z.literal("file_change"),
      z.literal("read_file"),
      z.literal("file_read"),
      z.literal("mcp_tool_call"),
      z.literal("web_search"),
      z.literal("todo_list"),
    ])
    .safeParse(normalizedType).success;
  if (isTopLevelItemEvent && !("item" in eventRecord)) {
    const itemRecord = { ...eventRecord, type: normalizedType };
    eventRecord = {
      type: "item.completed",
      item: itemRecord,
    };
  }
  return CodexEventSchema.parse(eventRecord);
}

function toPromptText(prompt: AgentPromptInput): string {
  if (typeof prompt === "string") {
    return prompt;
  }
  return prompt.map((chunk) => chunk.text).join("");
}

function getCodexMcpCommand(): string {
  try {
    const version = execSync("codex --version", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    const match = version.match(/codex-cli\s+(\d+\.\d+\.\d+(?:-alpha\.\d+)?)/);
    if (!match) return "mcp-server";

    const versionStr = match[1];
    const [major, minor, patch] = versionStr.split(/[-.]/).map(Number);

    if (major > 0 || minor > 43) return "mcp-server";
    if (minor === 43 && patch === 0) {
      if (versionStr.includes("-alpha.")) {
        const alphaNum = parseInt(versionStr.split("-alpha.")[1], 10);
        return alphaNum >= 5 ? "mcp-server" : "mcp";
      }
      return "mcp-server";
    }
    return "mcp";
  } catch {
    return "mcp-server";
  }
}

function buildCodexMcpConfig(
  config: AgentSessionConfig,
  prompt: string,
  modeId: string
): {
  prompt: string;
  cwd?: string;
  "approval-policy": string;
  sandbox: string;
  config?: unknown;
  model?: string;
} {
  const preset =
    MODE_PRESETS[modeId] !== undefined
      ? MODE_PRESETS[modeId]
      : MODE_PRESETS[DEFAULT_CODEX_MODE_ID];
  const approvalPolicy =
    config.approvalPolicy !== undefined
      ? config.approvalPolicy
      : preset.approvalPolicy;
  const sandbox =
    config.sandboxMode !== undefined ? config.sandboxMode : preset.sandbox;
  const extra = config.extra ? config.extra.codex : undefined;

  const configPayload: {
    prompt: string;
    cwd?: string;
    "approval-policy": string;
    sandbox: string;
    config?: unknown;
    model?: string;
  } = {
    prompt,
    cwd: config.cwd,
    "approval-policy": approvalPolicy,
    sandbox,
    config: extra,
  };
  if (typeof config.model === "string" && config.model.length > 0) {
    configPayload.model = config.model;
  }
  return configPayload;
}

function isUnsupportedChatGptModelError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("model is not supported when using Codex with a ChatGPT account");
}

function isMissingConversationIdError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Session not found for conversation_id");
}

function isMissingConversationIdResponse(response: unknown): boolean {
  const text = extractTextContent(response);
  return !!text && text.includes("Session not found for conversation_id");
}

class Pushable<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private resolvers: ((value: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(item: T) {
    if (this.closed) {
      return;
    }
    if (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift()!;
      resolve({ value: item, done: false });
    } else {
      this.queue.push(item);
    }
  }

  end() {
    this.closed = true;
    while (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift()!;
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T, void> {
    return {
      next: (): Promise<IteratorResult<T, void>> => {
        if (this.queue.length > 0) {
          const value = this.queue.shift()!;
          return Promise.resolve({ value, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<T, void>>((resolve) => {
          this.resolvers.push(resolve);
        });
      },
    };
  }
}

class CodexMcpAgentSession implements AgentSession {
  readonly provider = CODEX_PROVIDER;
  readonly capabilities = CODEX_MCP_CAPABILITIES;

  private readonly client: Client;
  private transport: StdioClientTransport | null = null;
  private connected = false;
  private config: AgentSessionConfig;
  private currentMode: string;
  private sessionId: string | null = null;
  private conversationId: string | null = null;
  private runtimeModel: string | null = null;
  private pendingLocalId: string | null = null;
  private persistence: AgentPersistenceHandle | null = null;
  private cachedRuntimeInfo: AgentRuntimeInfo | null = null;
  private pendingPermissions = new Map<string, AgentPermissionRequest>();
  private pendingPermissionHandlers = new Map<string, PendingPermission>();
  private resolvedPermissionRequests = new Set<string>();
  private eventQueue: Pushable<AgentStreamEvent> | null = null;
  private currentAbortController: AbortController | null = null;
  private lockConversationId = false;
  private historyPending = false;
  private persistedHistory: AgentTimelineItem[] = [];
  private pendingHistory: AgentTimelineItem[] = [];
  private turnState: TurnState | null = null;
  private pendingPatchChanges = new Map<string, PatchFileChange[]>();
  private patchChangesByCallId = new Map<string, PatchFileChange[]>();

  constructor(config: CodexMcpAgentConfig, resumeHandle?: AgentPersistenceHandle) {
    this.config = config;
    this.currentMode =
      config.modeId !== undefined ? config.modeId : DEFAULT_CODEX_MODE_ID;
    this.pendingLocalId = `codex-mcp-${randomUUID()}`;

    if (resumeHandle) {
      this.sessionId = resumeHandle.sessionId;
      const metadata = resumeHandle.metadata;
      if (metadata) {
        const parsed = SessionIdentifiersSchema.parse(metadata);
        if (parsed.conversationId) {
          this.conversationId = parsed.conversationId;
          this.lockConversationId = true;
        }
      }
      const history = this.sessionId ? SESSION_HISTORY.get(this.sessionId) : undefined;
      this.persistedHistory = history ? [...history] : [];
      this.historyPending = this.persistedHistory.length > 0;
    }

    this.client = new Client(
      { name: "voice-dev-codex-mcp", version: "1.0.0" },
      { capabilities: { elicitation: {} } }
    );

    this.client.setNotificationHandler(
      z
        .object({
          method: z.literal("codex/event"),
          params: z.object({ msg: z.any() }).passthrough(),
        })
        .passthrough(),
      (data) => {
        const msg = data.params.msg;
        this.updateIdentifiersFromEvent(msg);
        this.handleMcpEvent(msg);
      }
    );

    this.client.setRequestHandler(ElicitRequestSchema, async (request) => {
      const permission = this.buildPermissionRequest(request.params);
      return this.handlePermissionRequest(permission);
    });
  }

  get id(): string | null {
    if (this.sessionId) {
      return this.sessionId;
    }
    if (this.pendingLocalId) {
      return this.pendingLocalId;
    }
    return null;
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    const mcpCommand = getCodexMcpCommand();
    const env: Record<string, string> = {};
    for (const key of Object.keys(process.env)) {
      const value = process.env[key];
      if (typeof value === "string") {
        env[key] = value;
      }
    }
    this.transport = new StdioClientTransport({
      command: "codex",
      args: [mcpCommand],
      env,
    });

    await this.client.connect(this.transport);
    this.connected = true;
  }

  async run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    const events = this.stream(prompt, options);
    const timeline: AgentTimelineItem[] = [];
    let finalText = "";
    let usage: AgentUsage | undefined;

    for await (const event of events) {
      if (event.type === "timeline") {
        timeline.push(event.item);
        if (event.item.type === "assistant_message") {
          finalText = event.item.text;
        }
      } else if (event.type === "turn_completed") {
        usage = event.usage;
      } else if (event.type === "turn_failed") {
        throw new Error(event.error);
      }
    }

    const resolvedSessionId = this.sessionId
      ? this.sessionId
      : this.pendingLocalId;
    const resolvedModel = this.runtimeModel
      ? this.runtimeModel
      : this.config.model;

    this.cachedRuntimeInfo = {
      provider: CODEX_PROVIDER,
      sessionId: resolvedSessionId ? resolvedSessionId : null,
      model: resolvedModel ? resolvedModel : null,
      modeId: this.currentMode ? this.currentMode : null,
    };

    return {
      sessionId: resolvedSessionId ? resolvedSessionId : "",
      finalText,
      usage,
      timeline,
    };
  }

  async *stream(
    prompt: AgentPromptInput,
    options?: AgentRunOptions
  ): AsyncGenerator<AgentStreamEvent> {
    await this.connect();
    const queue = new Pushable<AgentStreamEvent>();
    this.eventQueue = queue;
    this.turnState = {
      sawAssistant: false,
      sawReasoning: false,
      sawError: false,
      sawErrorTimeline: false,
      completed: false,
      failed: false,
    };

    const abortController = new AbortController();
    this.currentAbortController = abortController;

    const promptText = toPromptText(prompt);
    this.emitEvent({
      type: "timeline",
      provider: "codex-mcp",
      item: { type: "user_message", text: promptText },
    });

    void this.forwardPrompt(promptText, options, abortController.signal).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.emitEvent({
        type: "timeline",
        provider: "codex-mcp",
        item: { type: "error", message },
      });
      this.emitEvent({
        type: "turn_failed",
        provider: "codex-mcp",
        error: message,
      });
      queue.end();
    });

    try {
      for await (const event of queue) {
        yield event;
        if (event.type === "turn_completed" || event.type === "turn_failed") {
          break;
        }
      }
    } finally {
      if (this.eventQueue === queue) {
        this.eventQueue = null;
      }
      if (this.currentAbortController === abortController) {
        this.currentAbortController = null;
      }
      if (this.turnState) {
        this.turnState = null;
      }
    }
  }

  async interrupt(): Promise<void> {
    this.currentAbortController?.abort();
    if (
      this.eventQueue &&
      this.turnState &&
      !this.turnState.completed &&
      !this.turnState.failed
    ) {
      this.emitEvent({
        type: "turn_failed",
        provider: "codex-mcp",
        error: "Codex MCP turn interrupted",
      });
      this.eventQueue.end();
    }
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    if (!this.historyPending || this.persistedHistory.length === 0) {
      return;
    }
    const history = this.persistedHistory;
    this.persistedHistory = [];
    this.historyPending = false;
    for (const item of history) {
      yield {
        type: "timeline",
        provider: CODEX_PROVIDER,
        item,
      };
    }
  }

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    if (this.cachedRuntimeInfo) {
      return { ...this.cachedRuntimeInfo };
    }
    const resolvedSessionId = this.sessionId
      ? this.sessionId
      : this.pendingLocalId;
    const resolvedModel = this.runtimeModel
      ? this.runtimeModel
      : this.config.model;
    const info: AgentRuntimeInfo = {
      provider: CODEX_PROVIDER,
      sessionId: resolvedSessionId ? resolvedSessionId : null,
      model: resolvedModel ? resolvedModel : null,
      modeId: this.currentMode ? this.currentMode : null,
    };
    this.cachedRuntimeInfo = info;
    return { ...info };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return CODEX_MODES;
  }

  async getCurrentMode(): Promise<string | null> {
    return this.currentMode ? this.currentMode : null;
  }

  async setMode(modeId: string): Promise<void> {
    this.currentMode = modeId;
    this.config.modeId = modeId;
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return Array.from(this.pendingPermissions.values());
  }

  async respondToPermission(
    requestId: string,
    response: AgentPermissionResponse
  ): Promise<void> {
    const pending = this.pendingPermissionHandlers.get(requestId);
    if (!pending) {
      throw new Error(`No pending Codex MCP permission request with id '${requestId}'`);
    }
    this.pendingPermissionHandlers.delete(requestId);
    this.pendingPermissions.delete(requestId);
    this.resolvedPermissionRequests.add(requestId);
    const status = response.behavior === "allow" ? "granted" : "denied";
    this.emitEvent({
      type: "timeline",
      provider: "codex-mcp",
      item: createToolCallTimelineItem({
        server: "permission",
        tool: pending.request.name,
        status,
        callId: pending.request.id,
        displayName: pending.request.title ? pending.request.title : pending.request.name,
        kind: "permission",
        input: pending.request.input,
      }),
    });

    this.emitEvent({
      type: "permission_resolved",
      provider: "codex-mcp",
      requestId,
      resolution: response,
    });

    const decision: ElicitDecision =
      response.behavior === "allow"
        ? "approved"
        : response.interrupt
          ? "abort"
          : "denied";
    const reason = response.behavior === "deny" ? response.message : undefined;
    pending.resolve({ decision, reason });
  }

  private async handlePermissionRequest(
    permission: AgentPermissionRequest
  ): Promise<ElicitResponse> {
    const response = await new Promise<ElicitResponse>((resolve, reject) => {
      const hasPending =
        this.pendingPermissions.has(permission.id) ||
        this.pendingPermissionHandlers.has(permission.id);
      this.pendingPermissions.set(permission.id, permission);
      this.pendingPermissionHandlers.set(permission.id, {
        request: permission,
        resolve,
        reject,
      });
      if (!hasPending) {
        this.emitPermissionRequested(permission);
      }
    });

    return response;
  }

  describePersistence(): AgentPersistenceHandle | null {
    if (this.persistence) {
      this.updatePersistenceConversationId();
      return this.persistence;
    }
    if (!this.sessionId) {
      return null;
    }
    const { model: _ignoredModel, ...restConfig } = this.config;
    const conversationId = this.conversationId
      ? this.conversationId
      : this.sessionId;
    this.persistence = {
      provider: CODEX_PROVIDER,
      sessionId: this.sessionId,
      nativeHandle: this.sessionId,
      metadata: {
        ...restConfig,
        conversationId,
      },
    };
    this.updatePersistenceConversationId();
    return this.persistence;
  }

  private updatePersistenceConversationId(): void {
    const conversationId = this.conversationId ? this.conversationId : this.sessionId;
    if (!conversationId || !this.persistence?.metadata) {
      return;
    }
    const metadata = this.persistence.metadata;
    metadata.conversationId = conversationId;
  }

  async close(): Promise<void> {
    for (const pending of this.pendingPermissionHandlers.values()) {
      pending.reject(new Error("Codex MCP session closed"));
    }
    this.pendingPermissionHandlers.clear();
    this.pendingPermissions.clear();
    this.resolvedPermissionRequests.clear();
    this.eventQueue?.end();
    this.eventQueue = null;

    if (!this.connected) return;
    const pid = this.transport?.pid ? this.transport.pid : null;
    let closed = false;
    try {
      await this.client.close();
      closed = true;
    } catch {
      try {
        await this.transport?.close?.();
        closed = true;
      } catch {
        // ignore
      }
    }
    if (!closed && pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // ignore
      }
    }
    this.transport = null;
    this.connected = false;
    this.sessionId = null;
    this.conversationId = null;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  setManagedAgentId(_agentId: string): void {
    // Codex MCP sessions do not currently use the agent-control MCP channel.
  }

  private async forwardPrompt(
    prompt: string,
    _options: AgentRunOptions | undefined,
    signal: AbortSignal
  ): Promise<void> {
    const turnState = this.turnState;
    if (!turnState) {
      return;
    }

    let response: unknown;
    try {
      if (!this.sessionId) {
        const config = buildCodexMcpConfig(this.config, prompt, this.currentMode);
        const attempt = async (arguments_: CodexToolArguments) =>
          this.client.callTool(
            { name: "codex", arguments: arguments_ },
            undefined,
            { signal, timeout: DEFAULT_TIMEOUT_MS }
          );
        try {
          response = await attempt(config);
        } catch (error) {
          if (config.model && isUnsupportedChatGptModelError(error)) {
            const { model: _ignoredModel, ...fallback } = config;
            this.runtimeModel = null;
            this.config.model = undefined;
            response = await attempt(fallback);
          } else {
            throw error;
          }
        }
      } else {
        const conversationId = this.conversationId
          ? this.conversationId
          : this.sessionId;
        try {
          response = await this.client.callTool(
            {
              name: "codex-reply",
              arguments: {
                sessionId: this.sessionId,
                conversationId,
                prompt,
              },
            },
            undefined,
            { signal, timeout: DEFAULT_TIMEOUT_MS }
          );
          if (isMissingConversationIdResponse(response)) {
            const replayPrompt = this.buildResumePrompt(prompt);
            const config = buildCodexMcpConfig(this.config, replayPrompt, this.currentMode);
            const attempt = async (arguments_: CodexToolArguments) =>
              this.client.callTool(
                { name: "codex", arguments: arguments_ },
                undefined,
                { signal, timeout: DEFAULT_TIMEOUT_MS }
              );
            try {
              response = await attempt(config);
            } catch (fallbackError) {
              if (config.model && isUnsupportedChatGptModelError(fallbackError)) {
                const { model: _ignoredModel, ...fallback } = config;
                this.runtimeModel = null;
                this.config.model = undefined;
                response = await attempt(fallback);
              } else {
                throw fallbackError;
              }
            }
          }
        } catch (error) {
          if (isMissingConversationIdError(error)) {
            const replayPrompt = this.buildResumePrompt(prompt);
            const config = buildCodexMcpConfig(this.config, replayPrompt, this.currentMode);
            const attempt = async (arguments_: CodexToolArguments) =>
              this.client.callTool(
                { name: "codex", arguments: arguments_ },
                undefined,
                { signal, timeout: DEFAULT_TIMEOUT_MS }
              );
            try {
              response = await attempt(config);
            } catch (fallbackError) {
              if (config.model && isUnsupportedChatGptModelError(fallbackError)) {
                const { model: _ignoredModel, ...fallback } = config;
                this.runtimeModel = null;
                this.config.model = undefined;
                response = await attempt(fallback);
              } else {
                throw fallbackError;
              }
            }
          } else {
            throw error;
          }
        }
      }
    } catch (error) {
      if (signal.aborted) {
        this.emitEvent({
          type: "turn_failed",
          provider: "codex-mcp",
          error: "Codex MCP turn interrupted",
        });
        this.eventQueue?.end();
        return;
      }
      throw error;
    }

    this.updateIdentifiersFromResponse(response);
    if (!turnState.sawAssistant) {
      const text = extractTextContent(response);
      if (text) {
        this.emitEvent({
          type: "timeline",
          provider: "codex-mcp",
          item: { type: "assistant_message", text },
        });
      }
    }

    if (!turnState.completed && !turnState.failed) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    if (!turnState.completed && !turnState.failed) {
      if (turnState.sawError) {
        this.emitEvent({
          type: "turn_failed",
          provider: "codex-mcp",
          error: "Codex MCP turn failed",
        });
      } else {
        this.emitEvent({
          type: "turn_completed",
          provider: "codex-mcp",
        });
      }
    }
    this.eventQueue?.end();
  }

  private emitEvent(event: AgentStreamEvent): void {
    if (event.type === "timeline") {
      this.recordHistory(event.item);
      if (event.item.type === "assistant_message") {
        this.turnState && (this.turnState.sawAssistant = true);
      }
      if (event.item.type === "reasoning") {
        this.turnState && (this.turnState.sawReasoning = true);
      }
      if (event.item.type === "error") {
        if (this.turnState) {
          this.turnState.sawError = true;
          this.turnState.sawErrorTimeline = true;
        }
      }
    }
    if (event.type === "turn_completed") {
      this.turnState && (this.turnState.completed = true);
    }
    if (event.type === "turn_failed") {
      this.turnState && (this.turnState.failed = true);
    }
    this.eventQueue?.push(event);
  }

  private emitPermissionRequested(request: AgentPermissionRequest): void {
    this.emitEvent({
      type: "timeline",
      provider: "codex-mcp",
      item: createToolCallTimelineItem({
        server: "permission",
        tool: request.name,
        status: "requested",
        callId: request.id,
        displayName: request.title ? request.title : request.name,
        kind: "permission",
        input: request.input,
      }),
    });
    this.emitEvent({
      type: "permission_requested",
      provider: "codex-mcp",
      request,
    });
  }

  private recordHistory(item: AgentTimelineItem): void {
    if (this.sessionId) {
      const history = SESSION_HISTORY.get(this.sessionId) || [];
      history.push(item);
      SESSION_HISTORY.set(this.sessionId, history);
      return;
    }
    this.pendingHistory.push(item);
  }

  private flushPendingHistory(): void {
    if (!this.sessionId || this.pendingHistory.length === 0) {
      return;
    }
    const history = SESSION_HISTORY.get(this.sessionId) || [];
    history.push(...this.pendingHistory);
    SESSION_HISTORY.set(this.sessionId, history);
    this.pendingHistory = [];
  }

  private applySessionIdentifiers(identifiers: SessionIdentifiers): void {
    if (!this.sessionId && identifiers.sessionId) {
      this.sessionId = identifiers.sessionId;
      this.flushPendingHistory();
    }
    if (identifiers.conversationId && identifiers.conversationId.length > 0) {
      const shouldUpdate = !this.lockConversationId || !this.conversationId;
      if (shouldUpdate && this.conversationId !== identifiers.conversationId) {
        this.conversationId = identifiers.conversationId;
        this.updatePersistenceConversationId();
      }
    }
    if (identifiers.model && identifiers.model.length > 0) {
      this.runtimeModel = identifiers.model;
    }
  }

  private updateIdentifiersFromResponse(response: unknown): void {
    const parsedResponse = ResponseBaseSchema.parse(response);
    this.applySessionIdentifiers(SessionIdentifiersSchema.parse(parsedResponse));
    if (parsedResponse.meta !== undefined) {
      const metaParsed = SessionIdentifiersSchema.safeParse(parsedResponse.meta);
      if (metaParsed.success) {
        this.applySessionIdentifiers(metaParsed.data);
      }
    }
    const content = parsedResponse.content;
    if (content) {
      for (const item of content) {
        const itemParsed = SessionIdentifiersSchema.safeParse(item);
        if (itemParsed.success) {
          this.applySessionIdentifiers(itemParsed.data);
        }
      }
    }
  }

  private updateIdentifiersFromEvent(event: unknown): void {
    const base = RawMcpEventSchema.parse(event);
    this.applySessionIdentifiers(SessionIdentifiersSchema.parse(base));
    if (base.data !== undefined) {
      const parsed = SessionIdentifiersSchema.safeParse(base.data);
      if (parsed.success) {
        this.applySessionIdentifiers(parsed.data);
      }
    }
  }

  private handleMcpEvent(event: unknown): void {
    const rawResponseParsed = RawResponseItemSchema.safeParse(event);
    if (rawResponseParsed.success) {
      const mappedItem = mapRawResponseItemToThreadItem(rawResponseParsed.data.item);
      if (mappedItem) {
        const mappedEvent = ThreadItemEventSchema.parse({
          type: "item.completed",
          item: mappedItem,
        });
        this.emitEvent({
          type: "provider_event",
          provider: CODEX_PROVIDER,
          raw: mappedEvent,
        });
        this.handleThreadEvent(mappedEvent);
        return;
      }
    }
    const parsedEvent = normalizeEvent(event);
    this.emitEvent({
      type: "provider_event",
      provider: CODEX_PROVIDER,
      raw: parsedEvent,
    });

    switch (parsedEvent.type) {
      case "thread.started":
      case "turn.started":
      case "turn.completed":
      case "turn.failed":
      case "item.started":
      case "item.updated":
      case "item.completed":
      case "error":
        this.handleThreadEvent(parsedEvent);
        return;
      case "agent_message":
        this.emitEvent({
          type: "timeline",
          provider: CODEX_PROVIDER,
          item: { type: "assistant_message", text: parsedEvent.text },
        });
        return;
      case "agent_reasoning":
      case "agent_reasoning_delta":
        this.emitEvent({
          type: "timeline",
          provider: CODEX_PROVIDER,
          item: { type: "reasoning", text: parsedEvent.text },
        });
        return;
      case "task_started":
        this.emitEvent({ type: "turn_started", provider: CODEX_PROVIDER });
        return;
      case "task_complete":
        this.emitEvent({ type: "turn_completed", provider: CODEX_PROVIDER });
        return;
      case "turn_aborted":
        this.emitEvent({
          type: "turn_failed",
          provider: CODEX_PROVIDER,
          error: "Codex MCP turn aborted",
        });
        return;
      case "exec_command_begin": {
        const callId = parsedEvent.callId;
        if (!callId) {
          throw new Error("exec_command_begin missing call_id");
        }
        const commandText = normalizeCommand(parsedEvent.command);
        this.emitEvent({
          type: "timeline",
          provider: CODEX_PROVIDER,
          item: createToolCallTimelineItem({
            server: "command",
            tool: "shell",
            status: "running",
            callId,
            displayName: commandText,
            kind: "execute",
            input: { command: parsedEvent.command, cwd: parsedEvent.cwd },
          }),
        });
        return;
      }
      case "exec_command_end": {
        const callId = parsedEvent.callId;
        if (!callId) {
          throw new Error("exec_command_end missing call_id");
        }
        const commandText = normalizeCommand(parsedEvent.command);
        const outputRecord =
          typeof parsedEvent.output === "object" &&
          parsedEvent.output !== null
            ? parsedEvent.output
            : undefined;
        const outputExitCode =
          outputRecord &&
          "exitCode" in outputRecord &&
          typeof outputRecord.exitCode === "number"
            ? outputRecord.exitCode
            : undefined;
        let resolvedExitCode = parsedEvent.exitCode;
        if (resolvedExitCode === undefined && outputExitCode !== undefined) {
          resolvedExitCode = outputExitCode;
        }
        if (resolvedExitCode === undefined) {
          if (parsedEvent.success === true) {
            resolvedExitCode = 0;
          } else if (parsedEvent.success === false) {
            resolvedExitCode = 1;
          } else if (parsedEvent.status === "failed") {
            resolvedExitCode = 1;
          } else if (parsedEvent.status === "completed") {
            resolvedExitCode = 0;
          }
        }
        let outputText: string | undefined;
        if (typeof parsedEvent.output === "string") {
          outputText = parsedEvent.output;
        } else if (outputRecord) {
          if (typeof outputRecord.stdout === "string") {
            outputText = outputRecord.stdout;
          } else if (typeof outputRecord.stderr === "string") {
            outputText = outputRecord.stderr;
          }
        }
        if (outputText === undefined) {
          if (typeof parsedEvent.stdout === "string") {
            outputText = parsedEvent.stdout;
          } else if (typeof parsedEvent.stderr === "string") {
            outputText = parsedEvent.stderr;
          }
        }
        let structuredOutput: unknown = outputRecord;
        if (outputText !== undefined || resolvedExitCode !== undefined) {
          const commandOutput: {
            type: "command";
            command: string;
            output?: string;
            exitCode?: number;
            cwd?: string;
          } = {
            type: "command",
            command: commandText,
            cwd: parsedEvent.cwd,
          };
          if (outputText !== undefined) {
            commandOutput.output = outputText;
          }
          if (resolvedExitCode !== undefined) {
            commandOutput.exitCode = resolvedExitCode;
          }
          structuredOutput = commandOutput;
        }
        const failed =
          parsedEvent.success === false ||
          parsedEvent.status === "failed" ||
          parsedEvent.error !== undefined ||
          (resolvedExitCode !== undefined && resolvedExitCode !== 0);
        if (failed) {
          this.turnState && (this.turnState.sawError = true);
        }
        this.emitEvent({
          type: "timeline",
          provider: CODEX_PROVIDER,
          item: createToolCallTimelineItem({
            server: "command",
            tool: "shell",
            status: failed ? "failed" : "completed",
            callId,
            displayName: commandText,
            kind: "execute",
            input: { command: parsedEvent.command, cwd: parsedEvent.cwd },
            output: structuredOutput,
          }),
        });
        if (failed) {
          const errorMessage =
            resolvedExitCode !== undefined
              ? `Command failed with exit code ${resolvedExitCode}`
              : "Command failed";
          this.emitEvent({
            type: "timeline",
            provider: CODEX_PROVIDER,
            item: { type: "error", message: errorMessage },
          });
        }
        return;
      }
      case "patch_apply_begin": {
        const callId = parsedEvent.callId;
        if (!callId) {
          throw new Error("patch_apply_begin missing call_id");
        }
        const normalizedChanges = parsePatchChanges(parsedEvent.changes);
        const files = normalizedChanges.map((change) => {
          if (!change.kind) {
            throw new Error(`patch_apply_begin missing kind for ${change.path}`);
          }
          return { path: change.path, kind: change.kind };
        });
        this.pendingPatchChanges.set(callId, normalizedChanges);
        this.patchChangesByCallId.set(callId, normalizedChanges);
        this.emitEvent({
          type: "timeline",
          provider: CODEX_PROVIDER,
          item: createToolCallTimelineItem({
            server: "file_change",
            tool: "apply_patch",
            status: "running",
            callId,
            displayName: buildFileChangeSummary(files),
            kind: "edit",
            input: { changes: parsedEvent.changes, files },
          }),
        });
        return;
      }
      case "patch_apply_end": {
        const callId = parsedEvent.callId;
        if (!callId) {
          throw new Error("patch_apply_end missing call_id");
        }
        if (parsedEvent.success === undefined) {
          throw new Error("patch_apply_end missing success");
        }
        const endChanges = parsedEvent.changes
          ? parsePatchChanges(parsedEvent.changes)
          : [];
        const fileRecords = parsedEvent.files
          ? parsePatchFiles(parsedEvent.files)
          : [];
        const pendingChanges = this.pendingPatchChanges.get(callId);
        const files =
          pendingChanges && pendingChanges.length > 0
            ? pendingChanges
            : endChanges.length > 0
              ? endChanges
              : fileRecords;
        this.pendingPatchChanges.delete(callId);
        if (files.length > 0) {
          this.patchChangesByCallId.set(callId, files);
        }
        const output: {
          files: PatchFileChange[];
          stdout?: string;
          stderr?: string;
          success: boolean;
        } = {
          files,
          success: parsedEvent.success,
        };
        if (parsedEvent.stdout !== undefined) {
          output.stdout = parsedEvent.stdout;
        }
        if (parsedEvent.stderr !== undefined) {
          output.stderr = parsedEvent.stderr;
        }
        const summaryFiles = files.map((file) => {
          if (!file.kind) {
            throw new Error(`patch_apply_end missing kind for ${file.path}`);
          }
          return { path: file.path, kind: file.kind };
        });
        this.emitEvent({
          type: "timeline",
          provider: CODEX_PROVIDER,
          item: createToolCallTimelineItem({
            server: "file_change",
            tool: "apply_patch",
            status: parsedEvent.success ? "completed" : "failed",
            callId,
            displayName: buildFileChangeSummary(summaryFiles),
            kind: "edit",
            output,
          }),
        });
        if (!parsedEvent.success) {
          this.turnState && (this.turnState.sawError = true);
        }
        return;
      }
      case "mcp_tool_call_begin": {
        return;
      }
      case "mcp_tool_call_end": {
        const input = normalizeStructuredPayload(parsedEvent.input);
        const { output, success } = extractMcpToolResultPayload(parsedEvent.result);
        const normalizedOutput = normalizeStructuredPayload(output);
        if (!success) {
          this.turnState && (this.turnState.sawError = true);
        }
        this.emitEvent({
          type: "timeline",
          provider: CODEX_PROVIDER,
          item: createToolCallTimelineItem({
            server: parsedEvent.server,
            tool: parsedEvent.tool,
            status: success ? "completed" : "failed",
            callId: parsedEvent.callId,
            displayName: `${parsedEvent.server}.${parsedEvent.tool}`,
            kind: "tool",
            input,
            output: normalizedOutput,
          }),
        });
        return;
      }
    }
  }

  private handleThreadEvent(event: ThreadEvent): void {
    switch (event.type) {
      case "thread.started": {
        this.sessionId = event.threadId;
        this.flushPendingHistory();
        const sessionId = this.sessionId
          ? this.sessionId
          : this.pendingLocalId
            ? this.pendingLocalId
            : "";
        this.emitEvent({
          type: "thread_started",
          provider: CODEX_PROVIDER,
          sessionId,
        });
        return;
      }
      case "turn.started":
        this.emitEvent({ type: "turn_started", provider: CODEX_PROVIDER });
        return;
      case "turn.completed": {
        const usage: AgentUsage | undefined = event.usage;
        if (this.turnState?.sawError) {
          this.emitEvent({
            type: "turn_failed",
            provider: CODEX_PROVIDER,
            error: "Codex MCP turn failed",
          });
        } else {
          this.emitEvent({ type: "turn_completed", provider: CODEX_PROVIDER, usage });
        }
        return;
      }
      case "turn.failed": {
        if (!this.turnState?.sawErrorTimeline) {
          this.emitEvent({
            type: "timeline",
            provider: CODEX_PROVIDER,
            item: { type: "error", message: event.error },
          });
        }
        this.emitEvent({
          type: "turn_failed",
          provider: CODEX_PROVIDER,
          error: event.error,
        });
        return;
      }
      case "item.started":
      case "item.updated":
      case "item.completed": {
        const timelineItem = this.threadItemToTimeline(event.item, event.type);
        if (timelineItem) {
          this.emitEvent({
            type: "timeline",
            provider: CODEX_PROVIDER,
            item: timelineItem,
          });
        }
        if (isThreadItemType(event.item, "command_execution")) {
          let resolvedExitCode = event.item.exitCode;
          if (resolvedExitCode === undefined) {
            if (event.item.success === true) {
              resolvedExitCode = 0;
            } else if (event.item.success === false) {
              resolvedExitCode = 1;
            } else if (event.item.status === "failed") {
              resolvedExitCode = 1;
            } else if (event.item.status === "completed") {
              resolvedExitCode = 0;
            }
          }
          const hasError =
            event.item.success === false ||
            event.item.status === "failed" ||
            event.item.error !== undefined ||
            (resolvedExitCode !== undefined && resolvedExitCode !== 0);
          if (hasError) {
            this.turnState && (this.turnState.sawError = true);
            const errorMessage =
              resolvedExitCode !== undefined
                ? `Command failed with exit code ${resolvedExitCode}`
                : "Command failed";
            this.emitEvent({
              type: "timeline",
              provider: CODEX_PROVIDER,
              item: { type: "error", message: errorMessage },
            });
          }
        }
        return;
      }
      case "error":
        this.emitEvent({
          type: "timeline",
          provider: CODEX_PROVIDER,
          item: { type: "error", message: event.message },
        });
        this.emitEvent({
          type: "turn_failed",
          provider: CODEX_PROVIDER,
          error: event.message,
        });
        return;
    }
  }

  private threadItemToTimeline(
    item: ThreadItem,
    eventType?: "item.started" | "item.updated" | "item.completed"
  ): AgentTimelineItem | null {
    if (isThreadItemType(item, "agent_message")) {
      return { type: "assistant_message", text: item.text };
    }
    if (isThreadItemType(item, "reasoning")) {
      return { type: "reasoning", text: item.text };
    }
    if (isThreadItemType(item, "user_message")) {
      return { type: "user_message", text: item.text };
    }
    if (isThreadItemType(item, "command_execution")) {
      const command = normalizeCommand(item.command);
      let resolvedExitCode = item.exitCode;
      if (resolvedExitCode === undefined) {
        if (item.success === true) {
          resolvedExitCode = 0;
        } else if (item.success === false) {
          resolvedExitCode = 1;
        } else if (item.status === "failed") {
          resolvedExitCode = 1;
        } else if (item.status === "completed") {
          resolvedExitCode = 0;
        }
      }
      const commandOutput: {
        type: "command";
        command: string;
        output?: string;
        exitCode?: number;
        cwd?: string;
      } = {
        type: "command",
        command,
        cwd: item.cwd,
      };
      if (item.aggregatedOutput !== undefined) {
        commandOutput.output = item.aggregatedOutput;
      }
      if (resolvedExitCode !== undefined) {
        commandOutput.exitCode = resolvedExitCode;
      }
      return createToolCallTimelineItem({
        server: "command",
        tool: "shell",
        status: item.status,
        callId: item.callId,
        displayName: command,
        kind: "execute",
        input: { command: item.command, cwd: item.cwd },
        output: commandOutput,
        error: item.error,
      });
    }
    if (isThreadItemType(item, "file_change")) {
      let changes = item.changes ? parsePatchChanges(item.changes) : [];
      if (changes.length === 0 && item.callId) {
        const cached = this.patchChangesByCallId.get(item.callId);
        if (cached && cached.length > 0) {
          changes = cached;
        }
      }
      const summaryFiles = changes.map((change) => {
        if (!change.kind) {
          throw new Error(`file_change missing kind for ${change.path}`);
        }
        return { path: change.path, kind: change.kind };
      });
      const status =
        eventType === "item.started" || eventType === "item.updated"
          ? "running"
          : "completed";
      return createToolCallTimelineItem({
        server: "file_change",
        tool: "apply_patch",
        status,
        callId: item.callId,
        displayName: buildFileChangeSummary(summaryFiles),
        kind: "edit",
        output: { files: changes },
      });
    }
    if (item.type === "read_file" || item.type === "file_read") {
      if (eventType && eventType !== "item.completed") {
        return null;
      }
      const readItem = item as ReadFileThreadItem;
      const displayName = `Read ${readItem.path}`;
      const output =
        readItem.content !== undefined ? readItem.content : readItem.output;
      return createToolCallTimelineItem({
        server: "file_read",
        tool: "read_file",
        status: readItem.status,
        callId: readItem.callId,
        displayName,
        kind: "read",
        input: readItem.input ? readItem.input : { path: readItem.path },
        output,
      });
    }
    if (isThreadItemType(item, "mcp_tool_call")) {
      if (eventType && eventType !== "item.completed") {
        return null;
      }
      return createToolCallTimelineItem({
        server: item.server,
        tool: item.tool,
        status: item.status,
        callId: item.callId,
        displayName: `${item.server}.${item.tool}`,
        kind: "tool",
        input: item.input,
        output: item.output,
      });
    }
    if (isThreadItemType(item, "web_search")) {
      if (eventType && eventType !== "item.completed") {
        return null;
      }
      const displayName = `Web search: ${item.query}`;
      const output =
        item.results !== undefined ? item.results : item.output;
      return createToolCallTimelineItem({
        server: "web_search",
        tool: "web_search",
        status: item.status,
        callId: item.callId,
        displayName,
        kind: "search",
        input: item.input ? item.input : { query: item.query },
        output,
      });
    }
    if (isThreadItemType(item, "todo_list")) {
      return { type: "todo", items: item.items };
    }
    if (isThreadItemType(item, "error")) {
      return { type: "error", message: item.message };
    }
    return null;
  }

  private buildResumePrompt(prompt: string): string {
    const historyLines: string[] = [];
    for (const item of this.persistedHistory) {
      if (item.type === "user_message") {
        historyLines.push(`User: ${item.text}`);
      }
      if (item.type === "assistant_message") {
        historyLines.push(`Assistant: ${item.text}`);
      }
    }
    if (historyLines.length === 0) {
      return prompt;
    }
    return ["Previous conversation:", ...historyLines, "", `User: ${prompt}`].join("\n");
  }

  private buildPermissionRequest(params: unknown): AgentPermissionRequest {
    const parsed: PermissionParams = PermissionParamsSchema.parse(params);
    const requestId = `permission-${parsed.callId}`;
    const commandText = normalizeCommand(parsed.command);
    const title = `Run command: ${commandText}`;

    return {
      id: requestId,
      provider: CODEX_PROVIDER,
      name: "CodexBash",
      kind: "tool",
      title,
      description: parsed.message,
      input: {
        command: parsed.command,
        cwd: parsed.cwd,
      },
      metadata: {
        callId: parsed.callId,
        raw: parsed.raw,
      },
    };
  }
}

export class CodexMcpAgentClient implements AgentClient {
  readonly provider = CODEX_PROVIDER;
  readonly capabilities = CODEX_MCP_CAPABILITIES;

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    const sessionConfig: CodexMcpAgentConfig = {
      ...config,
      provider: CODEX_PROVIDER,
    };
    const session = new CodexMcpAgentSession(sessionConfig);
    await session.connect();
    return session;
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>
  ): Promise<AgentSession> {
    const metadata = handle.metadata ? handle.metadata : {};
    const parsedMetadata = AgentSessionConfigSchema.parse(metadata);
    const storedConfig: StoredSessionConfig = parsedMetadata;
    const merged: AgentSessionConfig = {
      ...storedConfig,
      ...overrides,
      provider: CODEX_PROVIDER,
      cwd: overrides && overrides.cwd ? overrides.cwd : storedConfig.cwd,
    };
    if (!merged.cwd) {
      merged.cwd = process.cwd();
    }
    const sessionConfig: CodexMcpAgentConfig = {
      ...merged,
      provider: CODEX_PROVIDER,
    };
    const session = new CodexMcpAgentSession(sessionConfig, handle);
    await session.connect();
    return session;
  }
}
