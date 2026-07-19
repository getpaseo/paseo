import { z } from "zod";

export const OmpThinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export const OmpImageContentSchema = z
  .object({ type: z.literal("image"), data: z.string(), mimeType: z.string() })
  .passthrough();
export const OmpTextContentSchema = z
  .object({ type: z.literal("text"), text: z.string() })
  .passthrough();
export const OmpThinkingContentSchema = z
  .object({ type: z.literal("thinking"), thinking: z.string() })
  .passthrough();
export const OmpToolCallContentSchema = z
  .object({
    type: z.literal("toolCall"),
    id: z.string(),
    name: z.string(),
    arguments: z.unknown(),
  })
  .passthrough();

export const OmpAssistantContentSchema = z.discriminatedUnion("type", [
  OmpTextContentSchema,
  OmpThinkingContentSchema,
  OmpToolCallContentSchema,
]);

const OmpUserMessageSchema = z
  .object({
    role: z.literal("user"),
    content: z.union([z.string(), z.array(z.union([OmpTextContentSchema, OmpImageContentSchema]))]),
  })
  .passthrough();
const OmpCustomMessageSchema = z
  .object({
    role: z.literal("custom"),
    content: z.union([z.string(), z.array(z.union([OmpTextContentSchema, OmpImageContentSchema]))]),
  })
  .passthrough();
const OmpAssistantMessageSchema = z
  .object({
    role: z.literal("assistant"),
    content: z.array(OmpAssistantContentSchema),
    provider: z.string().optional(),
    model: z.string().optional(),
    responseId: z.string().optional(),
    responseModel: z.string().optional(),
    errorMessage: z.string().nullable().optional(),
    stopReason: z.string().optional(),
  })
  .passthrough();
const OmpToolResultMessageSchema = z
  .object({
    role: z.literal("toolResult"),
    toolCallId: z.string(),
    toolName: z.string(),
    content: z.unknown(),
    isError: z.boolean().optional(),
    details: z.unknown().optional(),
  })
  .passthrough();
const OmpBashExecutionMessageSchema = z
  .object({
    role: z.literal("bashExecution"),
    command: z.string(),
    output: z.string().optional(),
    exitCode: z.number().nullable().optional(),
    cancelled: z.boolean().optional(),
    timestamp: z.number(),
  })
  .passthrough();

export const OmpAgentMessageSchema = z.discriminatedUnion("role", [
  OmpUserMessageSchema,
  OmpCustomMessageSchema,
  OmpAssistantMessageSchema,
  OmpToolResultMessageSchema,
  OmpBashExecutionMessageSchema,
]);

export const OmpModelSchema = z
  .object({
    provider: z.string(),
    id: z.string(),
    name: z.string().optional(),
    reasoning: z.boolean().optional(),
    contextWindow: z.number().optional(),
    maxTokens: z.number().nullable().optional(),
    api: z.string().optional(),
    baseUrl: z.string().optional(),
    input: z.array(z.string()).optional(),
    cost: z.record(z.string(), z.unknown()).optional(),
    compat: z.unknown().optional(),
  })
  .passthrough();

const OmpContextUsageSchema = z
  .object({
    tokens: z.number().nullable().optional(),
    contextWindow: z.number().nullable().optional(),
    percent: z.number().nullable().optional(),
  })
  .passthrough();

export const OmpSessionStateSchema = z
  .object({
    model: OmpModelSchema.nullable().optional(),
    thinkingLevel: OmpThinkingLevelSchema,
    isStreaming: z.boolean(),
    isCompacting: z.boolean(),
    autoCompactionEnabled: z.boolean().optional(),
    sessionFile: z.string().optional(),
    sessionId: z.string(),
    sessionName: z.string().optional(),
    messageCount: z.number().int().nonnegative(),
    queuedMessageCount: z.number().int().nonnegative(),
    contextUsage: OmpContextUsageSchema.optional(),
    todoPhases: z.unknown().optional(),
  })
  .passthrough();

export const OmpSessionStatsSchema = z
  .object({
    tokens: z
      .object({
        input: z.number().optional(),
        output: z.number().optional(),
        cacheRead: z.number().optional(),
        cacheWrite: z.number().optional(),
        total: z.number().optional(),
      })
      .passthrough()
      .optional(),
    cost: z.number().optional(),
    contextUsage: OmpContextUsageSchema.optional(),
  })
  .passthrough();

export const OmpRpcSlashCommandSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    source: z.enum(["extension", "prompt", "skill", "builtin"]),
    sourceInfo: z.record(z.string(), z.unknown()).optional(),
    input: z.object({ hint: z.string().optional() }).passthrough().nullable().optional(),
  })
  .passthrough();

export const OmpAgentToolResultSchema = z
  .object({
    content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()),
    details: z.unknown().optional(),
    isError: z.boolean().optional(),
  })
  .passthrough();

export const OmpRpcHostToolDefinitionSchema = z
  .object({
    name: z.string(),
    label: z.string().optional(),
    description: z.string(),
    parameters: z.record(z.string(), z.unknown()),
    hidden: z.boolean().optional(),
  })
  .passthrough();
export const OmpRpcHostToolCallRequestSchema = z
  .object({
    type: z.literal("host_tool_call"),
    id: z.string(),
    toolCallId: z.string(),
    toolName: z.string(),
    arguments: z.record(z.string(), z.unknown()),
  })
  .passthrough();
export const OmpRpcHostToolCancelRequestSchema = z
  .object({
    type: z.literal("host_tool_cancel"),
    id: z.string(),
    targetId: z.string(),
  })
  .passthrough();
export const OmpRpcHostToolUpdateSchema = z
  .object({
    type: z.literal("host_tool_update"),
    id: z.string(),
    partialResult: OmpAgentToolResultSchema,
  })
  .passthrough();
export const OmpRpcHostToolResultSchema = z
  .object({
    type: z.literal("host_tool_result"),
    id: z.string(),
    result: OmpAgentToolResultSchema,
    isError: z.boolean().optional(),
  })
  .passthrough();

export const OmpSubagentSubscriptionLevelSchema = z.enum(["off", "progress", "events"]);
export const OmpSubagentStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "aborted",
]);

export const OmpSubagentLifecyclePayloadSchema = z
  .object({
    id: z.string(),
    agent: z.string(),
    agentSource: z.string().optional(),
    description: z.string().optional(),
    status: z.enum(["started", "completed", "failed", "aborted"]),
    sessionFile: z.string().optional(),
    parentToolCallId: z.string().optional(),
    index: z.number().int().nonnegative(),
    detached: z.boolean().optional(),
  })
  .passthrough();
export const OmpSubagentProgressSchema = z
  .object({
    id: z.string(),
    status: OmpSubagentStatusSchema,
    description: z.string().optional(),
    currentTool: z.unknown().optional(),
    recentTools: z.array(z.unknown()).optional(),
    recentOutput: z.array(z.unknown()).optional(),
    resolvedModel: z.string().optional(),
  })
  .passthrough();
export const OmpSubagentProgressPayloadSchema = z
  .object({
    index: z.number().int().nonnegative(),
    agent: z.string(),
    agentSource: z.string().optional(),
    task: z.string(),
    parentToolCallId: z.string().optional(),
    assignment: z.string().optional(),
    progress: OmpSubagentProgressSchema,
    sessionFile: z.string().optional(),
    detached: z.boolean().optional(),
  })
  .passthrough();

export const OmpAssistantMessageEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text_delta"), delta: z.string().optional() }).passthrough(),
  z.object({ type: z.literal("thinking_delta"), delta: z.string().optional() }).passthrough(),
  z.object({ type: z.literal("start") }).passthrough(),
  z.object({ type: z.literal("text_start") }).passthrough(),
  z.object({ type: z.literal("text_end") }).passthrough(),
  z.object({ type: z.literal("thinking_start") }).passthrough(),
  z.object({ type: z.literal("thinking_end") }).passthrough(),
  z.object({ type: z.literal("done") }).passthrough(),
]);

export const OmpAgentSessionEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent_start") }).passthrough(),
  z.object({ type: z.literal("turn_start") }).passthrough(),
  z.object({ type: z.literal("message_start"), message: OmpAgentMessageSchema }).passthrough(),
  z.object({ type: z.literal("message_end"), message: OmpAgentMessageSchema }).passthrough(),
  z
    .object({
      type: z.literal("message_update"),
      message: OmpAgentMessageSchema,
      assistantMessageEvent: OmpAssistantMessageEventSchema,
    })
    .passthrough(),
  z
    .object({
      type: z.literal("tool_execution_start"),
      toolCallId: z.string(),
      toolName: z.string(),
      args: z.unknown(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("tool_execution_update"),
      toolCallId: z.string(),
      toolName: z.string(),
      args: z.unknown().optional(),
      partialResult: z.unknown(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("tool_execution_end"),
      toolCallId: z.string(),
      toolName: z.string(),
      result: z.unknown(),
      isError: z.boolean().optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("compaction_start"),
      reason: z.string().optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("compaction_end"),
      reason: z.string().optional(),
      errorMessage: z.string().optional(),
      aborted: z.boolean().optional(),
    })
    .passthrough(),
  z
    .object({ type: z.literal("agent_end"), messages: z.array(OmpAgentMessageSchema).optional() })
    .passthrough(),
]);

export const OmpTodoItemSchema = z
  .object({
    content: z.string(),
    status: z.enum(["pending", "in_progress", "completed", "abandoned"]),
  })
  .passthrough();
export const OmpTodoPhaseSchema = z
  .object({ name: z.string(), tasks: z.array(OmpTodoItemSchema) })
  .passthrough();
export const OmpTodoReminderEventSchema = z
  .object({ type: z.literal("todo_reminder"), todos: z.array(OmpTodoItemSchema) })
  .passthrough();
export const OmpNoticeEventSchema = z
  .object({
    type: z.literal("notice"),
    level: z.enum(["info", "warning", "error"]),
    message: z.string(),
    source: z.string().optional(),
  })
  .passthrough();
export const OmpGoalSchema = z
  .object({
    id: z.string().optional(),
    objective: z.string().optional(),
    status: z.string().optional(),
    tokenBudget: z.number().optional(),
    tokensUsed: z.number().optional(),
    timeUsedSeconds: z.number().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .passthrough();
export const OmpGoalModeStateSchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: z.string().optional(),
    reason: z.string().optional(),
    goal: OmpGoalSchema.optional(),
  })
  .passthrough();
export const OmpGoalUpdatedEventSchema = z
  .object({
    type: z.literal("goal_updated"),
    goal: OmpGoalSchema.nullable().optional(),
    state: OmpGoalModeStateSchema.optional(),
  })
  .passthrough();
export const OmpAutoRetryStartEventSchema = z
  .object({
    type: z.literal("auto_retry_start"),
    attempt: z.number().int().nonnegative(),
    maxAttempts: z.number().int().positive(),
    delayMs: z.number().int().nonnegative(),
    errorMessage: z.string(),
    errorId: z.number().int().optional(),
  })
  .passthrough();
export const OmpAutoRetryEndEventSchema = z
  .object({
    type: z.literal("auto_retry_end"),
    success: z.boolean(),
    attempt: z.number().int().nonnegative(),
    finalError: z.string().optional(),
    recoveredErrors: z.unknown().optional(),
  })
  .passthrough();
export const OmpRetryFallbackAppliedEventSchema = z
  .object({
    type: z.literal("retry_fallback_applied"),
    from: z.string(),
    to: z.string(),
    role: z.string(),
  })
  .passthrough();
export const OmpRetryFallbackSucceededEventSchema = z
  .object({ type: z.literal("retry_fallback_succeeded"), model: z.string(), role: z.string() })
  .passthrough();
export const OmpAutoCompactionStartEventSchema = z
  .object({ type: z.literal("auto_compaction_start"), reason: z.string(), action: z.string() })
  .passthrough();
export const OmpAutoCompactionEndEventSchema = z
  .object({
    type: z.literal("auto_compaction_end"),
    action: z.string().optional(),
    result: z.unknown().optional(),
    aborted: z.boolean(),
    willRetry: z.boolean(),
    errorMessage: z.string().optional(),
    skipped: z.boolean().optional(),
  })
  .passthrough();
export const OmpAvailableCommandSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    source: z.string().optional(),
    input: z.object({ hint: z.string().optional() }).passthrough().nullable().optional(),
  })
  .passthrough();
export const OmpAvailableCommandsUpdateEventSchema = z
  .object({
    type: z.literal("available_commands_update"),
    commands: z.array(OmpAvailableCommandSchema),
  })
  .passthrough();

const OmpExtensionUiRequestSchema = z
  .object({
    type: z.literal("extension_ui_request"),
    id: z.string(),
    method: z.string(),
    title: z.string().optional(),
    message: z.string().optional(),
    options: z.array(z.string()).optional(),
    placeholder: z.string().optional(),
    url: z.string().optional(),
    launchUrl: z.string().optional(),
    instructions: z.string().optional(),
  })
  .passthrough();
const OmpSubagentLifecycleEventSchema = z
  .object({ type: z.literal("subagent_lifecycle"), payload: OmpSubagentLifecyclePayloadSchema })
  .passthrough();
const OmpSubagentProgressEventSchema = z
  .object({ type: z.literal("subagent_progress"), payload: OmpSubagentProgressPayloadSchema })
  .passthrough();
export const OmpSubagentEventPayloadSchema = z
  .object({ id: z.string(), event: OmpAgentSessionEventSchema })
  .passthrough();
const OmpSubagentEventSchema = z
  .object({
    type: z.literal("subagent_event"),
    payload: OmpSubagentEventPayloadSchema,
  })
  .passthrough();

export const OmpRuntimeEventSchema = z.discriminatedUnion("type", [
  ...OmpAgentSessionEventSchema.options,
  OmpExtensionUiRequestSchema,
  z.object({ type: z.literal("command_output"), text: z.string().optional() }).passthrough(),
  z
    .object({
      type: z.literal("prompt_result"),
      id: z.string().optional(),
      agentInvoked: z.boolean().optional(),
    })
    .passthrough(),
  z.object({ type: z.literal("process_exit"), error: z.string() }).passthrough(),
  OmpSubagentLifecycleEventSchema,
  OmpSubagentProgressEventSchema,
  OmpSubagentEventSchema,
  OmpTodoReminderEventSchema,
  OmpNoticeEventSchema,
  OmpGoalUpdatedEventSchema,
  OmpAutoRetryStartEventSchema,
  OmpAutoRetryEndEventSchema,
  OmpRetryFallbackAppliedEventSchema,
  OmpRetryFallbackSucceededEventSchema,
  OmpAutoCompactionStartEventSchema,
  OmpAutoCompactionEndEventSchema,
  OmpAvailableCommandsUpdateEventSchema,
  OmpRpcHostToolCallRequestSchema,
  OmpRpcHostToolCancelRequestSchema,
  OmpRpcHostToolUpdateSchema,
]);

const OmpCommandBase = { id: z.string().optional() };
export const OmpRpcCommandSchema = z.discriminatedUnion("type", [
  z.object({
    ...OmpCommandBase,
    type: z.literal("prompt"),
    message: z.string(),
    images: z.array(OmpImageContentSchema).optional(),
  }),
  z.object({
    ...OmpCommandBase,
    type: z.literal("compact"),
    customInstructions: z.string().optional(),
  }),
  z.object({ ...OmpCommandBase, type: z.literal("set_auto_compaction"), enabled: z.boolean() }),
  z.object({ ...OmpCommandBase, type: z.literal("abort") }),
  z.object({ ...OmpCommandBase, type: z.literal("get_state") }),
  z.object({ ...OmpCommandBase, type: z.literal("get_messages") }),
  z.object({ ...OmpCommandBase, type: z.literal("get_available_models") }),
  z.object({
    ...OmpCommandBase,
    type: z.literal("set_model"),
    provider: z.string(),
    modelId: z.string(),
  }),
  z.object({
    ...OmpCommandBase,
    type: z.literal("set_thinking_level"),
    level: OmpThinkingLevelSchema,
  }),
  z.object({ ...OmpCommandBase, type: z.literal("get_session_stats") }),
  z.object({ ...OmpCommandBase, type: z.literal("get_available_commands") }),
  z.object({
    ...OmpCommandBase,
    type: z.literal("set_subagent_subscription"),
    level: OmpSubagentSubscriptionLevelSchema,
  }),
  z.object({
    ...OmpCommandBase,
    type: z.literal("set_host_tools"),
    tools: z.array(OmpRpcHostToolDefinitionSchema),
  }),
  z.object({ ...OmpCommandBase, type: z.literal("branch"), entryId: z.string() }),
  z.object({ ...OmpCommandBase, type: z.literal("get_branch_messages") }),
  z.object({
    ...OmpCommandBase,
    type: z.literal("handoff"),
    customInstructions: z.string().optional(),
  }),
]);

export const OmpPromptAckSchema = z
  .object({ agentInvoked: z.boolean().optional() })
  .passthrough()
  .optional();
export const OmpMessagesResultSchema = z
  .object({ messages: z.array(OmpAgentMessageSchema).optional() })
  .passthrough();
export const OmpModelsResultSchema = z
  .object({ models: z.array(OmpModelSchema).optional() })
  .passthrough();
export const OmpCommandsResultSchema = z
  .object({ commands: z.array(OmpRpcSlashCommandSchema).optional() })
  .passthrough();
export const OmpHostToolsResultSchema = z
  .object({ toolNames: z.array(z.string()).optional() })
  .passthrough();
export const OmpBranchResultSchema = z
  .object({ text: z.string().optional(), cancelled: z.boolean().optional() })
  .passthrough();
export const OmpBranchMessagesResultSchema = z
  .object({
    messages: z.array(z.object({ entryId: z.string(), text: z.string() }).passthrough()).optional(),
  })
  .passthrough();

export type OmpThinkingLevel = z.infer<typeof OmpThinkingLevelSchema>;
export type OmpImageContent = z.infer<typeof OmpImageContentSchema>;
export type OmpTextContent = z.infer<typeof OmpTextContentSchema>;
export type OmpThinkingContent = z.infer<typeof OmpThinkingContentSchema>;
export type OmpToolCallContent = z.infer<typeof OmpToolCallContentSchema>;
export type OmpAssistantContent = z.infer<typeof OmpAssistantContentSchema>;
export type OmpAgentMessage = z.infer<typeof OmpAgentMessageSchema>;
export type OmpModel = z.infer<typeof OmpModelSchema>;
export type OmpSessionState = z.infer<typeof OmpSessionStateSchema>;
export type OmpSessionStats = z.infer<typeof OmpSessionStatsSchema>;
export type OmpRpcSlashCommand = z.infer<typeof OmpRpcSlashCommandSchema>;
export type OmpAgentToolResult = z.infer<typeof OmpAgentToolResultSchema>;
export type OmpRpcHostToolDefinition = z.infer<typeof OmpRpcHostToolDefinitionSchema>;
export type OmpRpcHostToolCallRequest = z.infer<typeof OmpRpcHostToolCallRequestSchema>;
export type OmpRpcHostToolUpdate = z.infer<typeof OmpRpcHostToolUpdateSchema>;
export type OmpRpcHostToolResult = z.infer<typeof OmpRpcHostToolResultSchema>;
export type OmpSubagentSubscriptionLevel = z.infer<typeof OmpSubagentSubscriptionLevelSchema>;
export type OmpSubagentStatus = z.infer<typeof OmpSubagentStatusSchema>;
export type OmpSubagentLifecyclePayload = z.infer<typeof OmpSubagentLifecyclePayloadSchema>;
export type OmpSubagentProgressPayload = z.infer<typeof OmpSubagentProgressPayloadSchema>;
export type OmpSubagentEventPayload = z.infer<typeof OmpSubagentEventPayloadSchema>;
export type OmpAssistantMessageEvent = z.infer<typeof OmpAssistantMessageEventSchema>;
export type OmpAgentSessionEvent = z.infer<typeof OmpAgentSessionEventSchema>;
export type OmpRuntimeEvent = z.infer<typeof OmpRuntimeEventSchema>;
export type OmpTodoItem = z.infer<typeof OmpTodoItemSchema>;
export type OmpTodoPhase = z.infer<typeof OmpTodoPhaseSchema>;
export type OmpTodoReminderEvent = z.infer<typeof OmpTodoReminderEventSchema>;
export type OmpNoticeEvent = z.infer<typeof OmpNoticeEventSchema>;
export type OmpGoal = z.infer<typeof OmpGoalSchema>;
export type OmpGoalUpdatedEvent = z.infer<typeof OmpGoalUpdatedEventSchema>;
export type OmpAutoRetryStartEvent = z.infer<typeof OmpAutoRetryStartEventSchema>;
export type OmpAutoRetryEndEvent = z.infer<typeof OmpAutoRetryEndEventSchema>;
export type OmpRetryFallbackAppliedEvent = z.infer<typeof OmpRetryFallbackAppliedEventSchema>;
export type OmpRetryFallbackSucceededEvent = z.infer<typeof OmpRetryFallbackSucceededEventSchema>;
export type OmpAutoCompactionStartEvent = z.infer<typeof OmpAutoCompactionStartEventSchema>;
export type OmpAutoCompactionEndEvent = z.infer<typeof OmpAutoCompactionEndEventSchema>;
export type OmpAvailableCommand = z.infer<typeof OmpAvailableCommandSchema>;
export type OmpAvailableCommandsUpdateEvent = z.infer<typeof OmpAvailableCommandsUpdateEventSchema>;
export type OmpRpcCommand = z.infer<typeof OmpRpcCommandSchema>;
export type OmpPromptAck = z.infer<typeof OmpPromptAckSchema> & { requestId?: string };

export interface OmpSubagentSnapshot {
  id: string;
  index: number;
  agent: string;
  description?: string;
  status: OmpSubagentStatus;
  task?: string;
  assignment?: string;
  sessionFile?: string;
  parentToolCallId?: string;
  lastUpdate?: number;
}

export interface OmpSubagentMessagesResult {
  sessionFile: string;
  fromByte: number;
  nextByte: number;
  reset: boolean;
  messages: OmpAgentMessage[];
}

export interface OmpSubagentMessagesSelector {
  subagentId?: string;
  sessionFile?: string;
  fromByte?: number;
}
