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
const CODEX_PROVIDER: AgentClient["provider"] = "codex-mcp";

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

function normalizeCallId(value?: string | null): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
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

function firstDefined<T>(values: Array<T | undefined>): T | undefined {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function firstString(values: Array<string | undefined>): string | undefined {
  return firstDefined(values);
}

const CommandSchema = z.union([
  z.string().min(1),
  z.array(z.string().min(1)).nonempty(),
]);

type Command = z.infer<typeof CommandSchema>;

const ExitCodeSchema = z
  .union([z.number(), z.string().regex(/^-?\d+$/)])
  .transform((value) => (typeof value === "string" ? Number(value) : value));

const PatchChangeDetailsSchema = z
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

type PatchChangeDetails = z.infer<typeof PatchChangeDetailsSchema>;

const PatchChangeEntrySchema = PatchChangeDetailsSchema.extend({
  path: z.string().min(1),
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
  .passthrough();

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
  .transform((data) => ({
    path: firstString([data.path, data.file_path, data.filePath]),
  }));

const ReadFileOutputSchema = z
  .object({
    content: z.string().optional(),
  })
  .passthrough();

const WebSearchInputSchema = z
  .object({
    query: z.string().optional(),
  })
  .passthrough()
  .transform((data) => ({
    query: data.query,
  }));

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
  .transform((data) => ({
    sessionId: firstString([data.sessionId, data.session_id]),
    conversationId: firstString([
      data.conversationId,
      data.conversation_id,
      data.thread_id,
    ]),
    model: data.model,
  }));

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
  .transform((data) => ({
    callId: normalizeCallId(firstString([data.call_id, data.id])),
  }));

const CommandOutputObjectSchema = z
  .object({
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    exit_code: ExitCodeSchema.optional(),
    exitCode: ExitCodeSchema.optional(),
    success: z.boolean().optional(),
  })
  .passthrough();

const ExecCommandBeginEventSchema = z
  .object({
    type: z.literal("exec_command_begin"),
    call_id: z.string().min(1),
    command: CommandSchema,
    cwd: z.string().optional(),
  })
  .passthrough()
  .transform((data) => ({
    type: data.type,
    callId: normalizeCallId(data.call_id),
    command: data.command,
    cwd: data.cwd,
  }));

const ExecCommandEndEventSchema = z
  .object({
    type: z.literal("exec_command_end"),
    call_id: z.string().min(1),
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
  .transform((data) => ({
    type: data.type,
    callId: normalizeCallId(data.call_id),
    command: data.command,
    cwd: data.cwd,
    exitCode: firstDefined([data.exit_code, data.exitCode]),
    output: data.output,
    stdout: data.stdout,
    stderr: data.stderr,
    status: data.status,
    success: data.success,
    error: data.error,
  }));

const PatchApplyBeginEventSchema = z
  .object({
    type: z.literal("patch_apply_begin"),
    call_id: z.string().min(1),
    changes: PatchChangesSchema,
  })
  .passthrough()
  .transform((data) => ({
    type: data.type,
    callId: normalizeCallId(data.call_id),
    changes: data.changes,
  }));

const PatchApplyEndEventSchema = z
  .object({
    type: z.literal("patch_apply_end"),
    call_id: z.string().min(1),
    success: z.boolean().optional(),
    changes: PatchChangesSchema.optional(),
    files: z.array(PatchFileEntrySchema).optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
  })
  .passthrough()
  .transform((data) => ({
    type: data.type,
    callId: normalizeCallId(data.call_id),
    success: data.success,
    changes: data.changes,
    files: data.files,
    stdout: data.stdout,
    stderr: data.stderr,
  }));

const AgentMessageEventSchema = z
  .object({
    type: z.literal("agent_message"),
    message: z.string().optional(),
    text: z.string().optional(),
  })
  .passthrough()
  .transform((data, ctx) => {
    const text = firstString([data.message, data.text]);
    if (!text) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "agent_message missing text",
      });
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
    const text = firstString([data.text, data.delta]);
    if (!text) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "agent_reasoning missing text",
      });
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
    const text = firstString([data.text, data.delta]);
    if (!text) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "agent_reasoning_delta missing text",
      });
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
    type: data.type,
    text: data.text,
  }));

const ThreadItemReasoningSchema = z
  .object({
    type: z.literal("reasoning"),
    text: z.string().min(1),
  })
  .passthrough()
  .transform((data) => ({
    type: data.type,
    text: data.text,
  }));

const ThreadItemUserMessageSchema = z
  .object({
    type: z.literal("user_message"),
    text: z.string().min(1),
  })
  .passthrough()
  .transform((data) => ({
    type: data.type,
    text: data.text,
  }));

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
).transform((data) => ({
  type: data.type,
  callId: data.callId,
  command: data.command,
  status: data.status,
  success: data.success,
  error: data.error,
  exitCode: firstDefined([data.exit_code, data.exitCode]),
  aggregatedOutput: data.aggregated_output,
  cwd: data.cwd,
}));

const FileChangeItemSchema = ThreadItemCallIdSchema.and(
  z
    .object({
      type: z.literal("file_change"),
      changes: PatchChangesSchema.optional(),
    })
    .passthrough()
).transform((data) => ({
  type: data.type,
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
  const inputParsed = ReadFileInputSchema.safeParse(data.input);
  const input = inputParsed.success ? inputParsed.data : undefined;
  const outputParsed = ReadFileOutputSchema.safeParse(data.output);
  const output = outputParsed.success ? outputParsed.data : undefined;
  const path = firstString([
    input?.path,
    data.path,
    data.file_path,
    data.filePath,
  ]);
  if (!path) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "read_file missing path",
    });
    return z.NEVER;
  }
  const content = firstString([
    typeof data.output === "string" ? data.output : undefined,
    output?.content,
    data.content,
    data.text,
  ]);
  return {
    type: data.type,
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
  const server = firstString([
    typeof data.server === "string" ? data.server : undefined,
    serverObject?.name,
    serverObject?.id,
    data.server_name,
    data.serverId,
    data.server_id,
    data.mcp_server,
  ]);
  let tool = firstString([
    typeof data.tool === "string" ? data.tool : undefined,
    toolObject?.name,
    toolObject?.tool,
    data.tool_name,
    data.toolId,
    data.tool_id,
    data.name,
  ]);
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
  const input = firstDefined([
    data.input,
    data.arguments,
    data.args,
    data.params,
    data.request,
    toolObject?.input,
  ]);
  const output = firstDefined([
    data.output,
    data.result,
    data.response,
    data.return,
    data.returns,
    data.result_content,
    data.content,
    data.structuredContent,
    data.structured_content,
  ]);
  const status = firstString([data.status, data.state, data.outcome]);
  return {
    type: data.type,
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
  const input =
    typeof data.input === "object" && data.input !== null
      ? WebSearchInputSchema.safeParse(data.input).success
        ? WebSearchInputSchema.parse(data.input)
        : undefined
      : undefined;
  const query = firstString([
    data.query,
    input?.query,
    data.search_query,
    data.searchQuery,
  ]);
  if (!query) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "web_search missing query",
    });
    return z.NEVER;
  }
  const results = firstDefined([
    data.output,
    data.results,
    data.search_results,
    data.searchResults,
    data.items,
    data.documents,
    data.data,
    data.content,
    data.response,
    data.result,
  ]);
  return {
    type: data.type,
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
    type: data.type,
    items: data.items,
  }));

const ErrorItemSchema = z
  .object({
    type: z.literal("error"),
    message: z.string().min(1),
  })
  .passthrough()
  .transform((data) => ({
    type: data.type,
    message: data.message,
  }));

const ThreadItemSchema = z.union([
  ThreadItemMessageSchema,
  ThreadItemReasoningSchema,
  ThreadItemUserMessageSchema,
  CommandExecutionItemSchema,
  FileChangeItemSchema,
  ReadFileItemSchema,
  McpToolCallItemSchema,
  WebSearchItemSchema,
  TodoListItemSchema,
  ErrorItemSchema,
]);

type ThreadItem = z.infer<typeof ThreadItemSchema>;

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
  ThreadStartedEventSchema,
  TurnStartedEventSchema,
  TurnCompletedEventSchema,
  TurnFailedEventSchema,
  ThreadItemEventSchema,
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
    const callIdValue = firstString([
      data.codex_call_id,
      data.codex_mcp_tool_call_id,
      data.codex_event_id,
      data.call_id,
    ]);
    const callId = normalizeCallId(callIdValue);
    if (!callId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "permission request missing call_id",
      });
      return z.NEVER;
    }
    let command = data.codex_command;
    if (command === undefined) {
      command = data.command;
    }
    if (!command) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "permission request missing command",
      });
      return z.NEVER;
    }
    let cwd = data.codex_cwd;
    if (cwd === undefined) {
      cwd = data.cwd;
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
    agentControlMcp: z.unknown().optional(),
    extra: z
      .object({
        codex: z.unknown().optional(),
        claude: z.unknown().optional(),
      })
      .optional(),
    mcpServers: z.unknown().optional(),
    parentAgentId: z.string().optional(),
  })
  .passthrough();

type StoredSessionConfig = z.infer<typeof AgentSessionConfigSchema>;

function normalizePatchChange(path: string, details: PatchChangeDetails): PatchFileChange {
  const before = firstString([
    details.before,
    details.original,
    details.old,
    details.previous,
    details.from,
  ]);
  const after = firstString([
    details.after,
    details.new,
    details.next,
    details.to,
  ]);
  const patch = firstString([
    details.patch,
    details.diff,
    details.unified_diff,
    details.unifiedDiff,
  ]);
  let kind = firstString([
    details.kind,
    details.type,
    details.action,
    details.change_type,
  ]);
  if (!kind) {
    if (before === undefined && after !== undefined) {
      kind = "create";
    } else if (before !== undefined && after === undefined) {
      kind = "delete";
    } else if (before !== undefined || after !== undefined || patch !== undefined) {
      kind = "edit";
    }
  }
  return { path, kind, before, after, patch };
}

function parsePatchChanges(changes: unknown): PatchFileChange[] {
  const parsed = PatchChangesSchema.parse(changes);
  if (Array.isArray(parsed)) {
    return parsed.map((entry) => normalizePatchChange(entry.path, entry));
  }
  return Object.entries(parsed).map(([path, value]) => {
    if (typeof value === "string") {
      return { path, kind: "edit", patch: value };
    }
    return normalizePatchChange(path, value);
  });
}

function parsePatchFiles(files: unknown): PatchFileChange[] {
  if (files === undefined) {
    return [];
  }
  const parsed = z.array(PatchFileEntrySchema).parse(files);
  return parsed.map((entry) => ({
    path: entry.path,
    kind: firstString([entry.kind, entry.type, entry.action]),
  }));
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

  const configPayload = {
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
        conversation_id: conversationId,
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
    metadata.conversation_id = conversationId;
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
      const shouldUpdate =
        !this.lockConversationId ||
        !this.conversationId ||
        this.conversationId !== identifiers.conversationId;
      if (shouldUpdate) {
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
        const outputExitCode = outputRecord
          ? firstDefined([outputRecord.exit_code, outputRecord.exitCode])
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
        this.emitEvent({ type: "turn_completed", provider: CODEX_PROVIDER, usage });
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
        const timelineItem = this.threadItemToTimeline(event.item);
        if (timelineItem) {
          this.emitEvent({
            type: "timeline",
            provider: CODEX_PROVIDER,
            item: timelineItem,
          });
        }
        if (event.item.type === "command_execution") {
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

  private threadItemToTimeline(item: ThreadItem): AgentTimelineItem | null {
    switch (item.type) {
      case "agent_message":
        return { type: "assistant_message", text: item.text };
      case "reasoning":
        return { type: "reasoning", text: item.text };
      case "user_message":
        return { type: "user_message", text: item.text };
      case "command_execution": {
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
      case "file_change": {
        const changes = item.changes ? parsePatchChanges(item.changes) : [];
        const summaryFiles = changes.map((change) => {
          if (!change.kind) {
            throw new Error(`file_change missing kind for ${change.path}`);
          }
          return { path: change.path, kind: change.kind };
        });
        return createToolCallTimelineItem({
          server: "file_change",
          tool: "apply_patch",
          status: "completed",
          callId: item.callId,
          displayName: buildFileChangeSummary(summaryFiles),
          kind: "edit",
          output: { files: changes },
        });
      }
      case "read_file":
      case "file_read": {
        const displayName = `Read ${item.path}`;
        const output =
          item.content !== undefined ? item.content : item.output;
        return createToolCallTimelineItem({
          server: "file_read",
          tool: "read_file",
          status: item.status,
          callId: item.callId,
          displayName,
          kind: "read",
          input: item.input ? item.input : { path: item.path },
          output,
        });
      }
      case "mcp_tool_call": {
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
      case "web_search": {
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
      case "todo_list":
        return { type: "todo", items: item.items };
      case "error":
        return { type: "error", message: item.message };
    }
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
