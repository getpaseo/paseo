import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Logger } from "pino";
import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  type AgentSession as PiAgentSession,
  type AgentSessionEvent,
  type AgentSessionServices,
  type BashToolInput,
  type CreateAgentSessionRuntimeFactory,
  type EditToolInput,
  type FindToolInput,
  type GrepToolInput,
  type LsToolInput,
  type ReadToolInput,
  type ResourceLoader,
  type ResolvedCommand,
  type Skill,
  type WriteToolInput,
} from "@mariozechner/pi-coding-agent";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, ImageContent, Model, TextContent } from "@mariozechner/pi-ai";
import { z } from "zod";

import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentLaunchContext,
  AgentMetadata,
  AgentMode,
  AgentModelDefinition,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentRunOptions,
  AgentRunResult,
  AgentRuntimeInfo,
  AgentSession,
  AgentSessionConfig,
  AgentSlashCommand,
  AgentStreamEvent,
  AgentTimelineItem,
  AgentUsage,
  ListModesOptions,
  ListModelsOptions,
  ToolCallDetail,
} from "../agent-sdk-types.js";
import type { ProviderRuntimeSettings } from "../provider-launch-config.js";
import { renderPromptAttachmentAsText } from "../prompt-attachments.js";
import { findExecutable, isCommandAvailable } from "../../../utils/executable.js";
import {
  formatDiagnosticStatus,
  formatProviderDiagnostic,
  formatProviderDiagnosticError,
  resolveBinaryVersion,
  toDiagnosticErrorMessage,
} from "./diagnostic-utils.js";

const PI_PROVIDER = "pi";
const DEFAULT_PI_THINKING_LEVEL: ThinkingLevel = "medium";
const PI_BINARY_COMMAND = process.env.PI_COMMAND ?? process.env.PI_ACP_PI_COMMAND ?? "pi";

const PI_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: false,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
};

interface PiDirectAgentClientOptions {
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
}

interface PiPromptPayload {
  text: string;
  images?: ImageContent[];
}

interface ToolCallOutputSummary {
  output?: string;
  exitCode?: number | null;
}

interface PiModelReference {
  provider?: string;
  id: string;
}

interface PiPersistenceMetadata {
  cwd?: string;
}

interface StartTurnResult {
  turnId: string;
}

interface PiDirectSessionResult {
  runtime: PiDirectSessionRuntimeAdapter;
  modelRegistry: ModelRegistry;
}

export type PiDirectSessionAdapter = Pick<
  PiAgentSession,
  | "abort"
  | "agent"
  | "dispose"
  | "extensionRunner"
  | "getSessionStats"
  | "messages"
  | "model"
  | "prompt"
  | "promptTemplates"
  | "resourceLoader"
  | "sessionId"
  | "sessionManager"
  | "setModel"
  | "setThinkingLevel"
  | "subscribe"
  | "thinkingLevel"
>;

export interface PiDirectSessionRuntimeAdapter {
  readonly session: PiDirectSessionAdapter;
  dispose(): Promise<void>;
}

type PiDirectModelRegistry = Pick<ModelRegistry, "find" | "getAll">;

interface PiToolResultObject {
  output?: string;
  stdout?: string;
  text?: string;
  content?: PiToolResultContent[];
  exitCode?: number;
  code?: number;
  details?: PiToolResultDetails;
}

interface PiToolResultDetails {
  diff?: string;
}

interface PiToolResultTextContent {
  type: "text";
  text: string;
}

interface PiToolResultUnknownContent {
  type: string;
}

type PiToolResultContent = PiToolResultTextContent | PiToolResultUnknownContent;
type PiToolResult = string | PiToolResultObject | null;

interface PiBashToolCall {
  kind: "bash";
  toolName: "bash";
  args: BashToolInput;
}

interface PiReadToolCall {
  kind: "read";
  toolName: "read";
  args: ReadToolInput;
}

interface PiEditToolCall {
  kind: "edit";
  toolName: "edit";
  args: EditToolInput;
}

interface PiWriteToolCall {
  kind: "write";
  toolName: "write";
  args: WriteToolInput;
}

interface PiFindToolCall {
  kind: "find";
  toolName: "find";
  args: FindToolInput;
}

interface PiGrepToolCall {
  kind: "grep";
  toolName: "grep";
  args: GrepToolInput;
}

interface PiLsToolCall {
  kind: "ls";
  toolName: "ls";
  args: LsToolInput;
}

interface PiUnknownToolCall {
  kind: "unknown";
  toolName: string;
  args: unknown;
}

type PiTrackedToolCall =
  | PiBashToolCall
  | PiReadToolCall
  | PiEditToolCall
  | PiWriteToolCall
  | PiFindToolCall
  | PiGrepToolCall
  | PiLsToolCall
  | PiUnknownToolCall;

const PI_THINKING_OPTIONS: ReadonlyArray<{
  id: ThinkingLevel;
  label: string;
  description: string;
  isDefault?: boolean;
}> = [
  { id: "off", label: "Off", description: "No extra reasoning" },
  { id: "minimal", label: "Minimal", description: "Light reasoning" },
  { id: "low", label: "Low", description: "Faster reasoning" },
  { id: "medium", label: "Medium", description: "Balanced reasoning", isDefault: true },
  { id: "high", label: "High", description: "Deeper reasoning" },
  { id: "xhigh", label: "XHigh", description: "Maximum reasoning" },
] as const;

const PiPromptTextBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

const PiToolResultTextContentSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

const PiToolResultUnknownContentSchema = z
  .object({
    type: z.string(),
  })
  .passthrough();

const PiToolResultContentSchema = z.union([
  PiToolResultTextContentSchema,
  PiToolResultUnknownContentSchema,
]);

const PiToolResultDetailsSchema = z
  .object({
    diff: z.string().optional(),
  })
  .passthrough();

const PiToolResultObjectSchema = z
  .object({
    output: z.string().optional(),
    stdout: z.string().optional(),
    text: z.string().optional(),
    content: z.array(PiToolResultContentSchema).optional(),
    exitCode: z.number().optional(),
    code: z.number().optional(),
    details: PiToolResultDetailsSchema.optional(),
  })
  .passthrough();

const PiToolResultSchema = z.union([z.string(), PiToolResultObjectSchema, z.null()]);

const PiPersistenceMetadataSchema = z
  .object({
    cwd: z.string().optional(),
  })
  .passthrough();

const BashToolInputSchema: z.ZodType<BashToolInput> = z.object({
  command: z.string(),
  timeout: z.number().optional(),
});

const ReadToolInputSchema: z.ZodType<ReadToolInput> = z.object({
  path: z.string(),
  offset: z.number().optional(),
  limit: z.number().optional(),
});

const EditToolInputSchema: z.ZodType<EditToolInput> = z.object({
  path: z.string(),
  edits: z.array(
    z.object({
      oldText: z.string(),
      newText: z.string(),
    }),
  ),
});

const LegacyEditToolInputSchema = z.object({
  path: z.string(),
  old_string: z.string().optional(),
  oldString: z.string().optional(),
  new_string: z.string().optional(),
  newString: z.string().optional(),
});

const WriteToolInputSchema: z.ZodType<WriteToolInput> = z.object({
  path: z.string(),
  content: z.string(),
});

const FindToolInputSchema: z.ZodType<FindToolInput> = z.object({
  pattern: z.string(),
  path: z.string().optional(),
  limit: z.number().optional(),
});

const GrepToolInputSchema: z.ZodType<GrepToolInput> = z.object({
  pattern: z.string(),
  path: z.string().optional(),
  glob: z.string().optional(),
  ignoreCase: z.boolean().optional(),
  literal: z.boolean().optional(),
  context: z.number().optional(),
  limit: z.number().optional(),
});

const LsToolInputSchema: z.ZodType<LsToolInput> = z.object({
  path: z.string().optional(),
  limit: z.number().optional(),
});

function normalizePiModelLabel(label: string): string {
  return label.trim().replace(/[_\s]+/g, " ");
}

export function transformPiModels(models: AgentModelDefinition[]): AgentModelDefinition[] {
  return models.map((model) => {
    if (!model.label.includes("/")) {
      return model;
    }

    const segments = model.label.split("/").filter((segment) => segment.length > 0);
    const rawLabel = segments.at(-1);
    if (!rawLabel) {
      return model;
    }

    return {
      ...model,
      label: normalizePiModelLabel(rawLabel),
      description: model.description ?? model.label,
    };
  });
}

function isPiThinkingLevel(value: string | null | undefined): value is ThinkingLevel {
  return (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  );
}

function normalizePiThinkingOption(value: string | null | undefined): ThinkingLevel | null {
  if (!value) {
    return null;
  }
  return isPiThinkingLevel(value) ? value : null;
}

function toAgentUsage(
  stats: ReturnType<PiAgentSession["getSessionStats"]>,
): AgentUsage | undefined {
  const inputTokens = stats.tokens.input;
  const cachedInputTokens = stats.tokens.cacheRead;
  const outputTokens = stats.tokens.output;
  const totalCostUsd = stats.cost;

  if (inputTokens === 0 && cachedInputTokens === 0 && outputTokens === 0 && totalCostUsd === 0) {
    return undefined;
  }

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalCostUsd,
  };
}

function convertPromptInput(prompt: AgentPromptInput): PiPromptPayload {
  if (typeof prompt === "string") {
    return { text: prompt };
  }

  const textParts: string[] = [];
  const images: ImageContent[] = [];

  for (const block of prompt) {
    if (block.type === "text") {
      textParts.push(block.text);
      continue;
    }

    if (block.type === "image") {
      images.push({
        type: "image",
        data: block.data,
        mimeType: block.mimeType,
      });
      continue;
    }

    textParts.push(renderPromptAttachmentAsText(block));
  }

  const payload: PiPromptPayload = {
    text: textParts.join("\n\n"),
  };
  if (images.length > 0) {
    payload.images = images;
  }
  return payload;
}

function parseToolResult(rawResult: unknown): PiToolResult {
  const parsed = PiToolResultSchema.safeParse(rawResult);
  if (parsed.success) {
    return parsed.data;
  }
  return null;
}

function extractTextFromToolResult(result: PiToolResult): string | undefined {
  if (typeof result === "string") {
    return result;
  }
  if (!result) {
    return undefined;
  }

  const directText = result.output ?? result.stdout ?? result.text;
  if (directText) {
    return directText;
  }
  if (!result.content) {
    return undefined;
  }

  const textParts: string[] = [];
  for (const block of result.content) {
    if (block.type === "text" && "text" in block) {
      textParts.push(block.text);
    }
  }

  if (textParts.length === 0) {
    return undefined;
  }
  return textParts.join("\n");
}

function resolveToolCallOutput(result: PiToolResult): ToolCallOutputSummary {
  if (typeof result === "string") {
    return { output: result };
  }
  if (!result) {
    return {};
  }

  const summary: ToolCallOutputSummary = {
    output: extractTextFromToolResult(result),
  };
  if (typeof result.exitCode === "number") {
    summary.exitCode = result.exitCode;
    return summary;
  }
  if (typeof result.code === "number") {
    summary.exitCode = result.code;
    return summary;
  }
  summary.exitCode = null;
  return summary;
}

function normalizeLegacyEditArgs(rawArgs: unknown): EditToolInput | null {
  const parsed = LegacyEditToolInputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return null;
  }

  const oldText = parsed.data.old_string ?? parsed.data.oldString;
  const newText = parsed.data.new_string ?? parsed.data.newString;
  if (!oldText || newText === undefined) {
    return null;
  }

  return {
    path: parsed.data.path,
    edits: [{ oldText, newText }],
  };
}

function parseEditToolArgs(rawArgs: unknown): PiTrackedToolCall {
  const parsed = EditToolInputSchema.safeParse(rawArgs);
  if (parsed.success) {
    return { kind: "edit", toolName: "edit", args: parsed.data };
  }
  const legacyArgs = normalizeLegacyEditArgs(rawArgs);
  if (legacyArgs) {
    return { kind: "edit", toolName: "edit", args: legacyArgs };
  }
  return { kind: "unknown", toolName: "edit", args: rawArgs ?? null };
}

type SimpleToolKind = "bash" | "read" | "write" | "find" | "grep" | "ls";
const SIMPLE_TOOL_SCHEMAS: {
  [K in SimpleToolKind]: { safeParse: (data: unknown) => { success: boolean; data?: unknown } };
} = {
  bash: BashToolInputSchema,
  read: ReadToolInputSchema,
  write: WriteToolInputSchema,
  find: FindToolInputSchema,
  grep: GrepToolInputSchema,
  ls: LsToolInputSchema,
};

function parseToolArgs(toolName: string, rawArgs: unknown): PiTrackedToolCall {
  if (toolName === "edit") {
    return parseEditToolArgs(rawArgs);
  }
  const schema = SIMPLE_TOOL_SCHEMAS[toolName as SimpleToolKind];
  if (schema) {
    const parsed = schema.safeParse(rawArgs);
    if (parsed.success) {
      return { kind: toolName as SimpleToolKind, toolName, args: parsed.data } as PiTrackedToolCall;
    }
  }
  return { kind: "unknown", toolName, args: rawArgs ?? null };
}

function mapFindToolDetail(args: FindToolInput, result: PiToolResult): ToolCallDetail {
  return {
    type: "search",
    query: args.pattern,
    toolName: "search",
    content: typeof result === "string" ? result : undefined,
  };
}

function mapGrepToolDetail(args: GrepToolInput, result: PiToolResult): ToolCallDetail {
  return {
    type: "search",
    query: args.pattern,
    toolName: "grep",
    content: typeof result === "string" ? result : undefined,
  };
}

function mapLsToolDetail(args: LsToolInput, result: PiToolResult): ToolCallDetail {
  const query = args.path ?? "ls";
  return {
    type: "search",
    query,
    content: typeof result === "string" ? result : undefined,
  };
}

function mapToolDetail(toolCall: PiTrackedToolCall, result?: PiToolResult): ToolCallDetail {
  const parsedResult = result ?? null;

  switch (toolCall.kind) {
    case "bash": {
      const summary = resolveToolCallOutput(parsedResult);
      return {
        type: "shell",
        command: toolCall.args.command,
        output: summary.output,
        exitCode: summary.exitCode,
      };
    }
    case "read":
      return {
        type: "read",
        filePath: toolCall.args.path,
        content: extractTextFromToolResult(parsedResult),
        offset: toolCall.args.offset,
        limit: toolCall.args.limit,
      };
    case "edit": {
      const firstEdit = toolCall.args.edits[0];
      const unifiedDiff =
        parsedResult && typeof parsedResult !== "string" ? parsedResult.details?.diff : undefined;

      return {
        type: "edit",
        filePath: toolCall.args.path,
        oldString: firstEdit?.oldText,
        newString: firstEdit?.newText,
        unifiedDiff,
      };
    }
    case "write":
      return {
        type: "write",
        filePath: toolCall.args.path,
        content: toolCall.args.content,
      };
    case "find":
      return mapFindToolDetail(toolCall.args, parsedResult);
    case "grep":
      return mapGrepToolDetail(toolCall.args, parsedResult);
    case "ls":
      return mapLsToolDetail(toolCall.args, parsedResult);
    default:
      return {
        type: "unknown",
        input: toolCall.args,
        output: parsedResult,
      };
  }
}

function parseModelReference(modelId: string | null): PiModelReference | null {
  if (!modelId) {
    return null;
  }
  if (modelId.includes("/")) {
    const [provider, ...rest] = modelId.split("/");
    const id = rest.join("/");
    if (provider && id) {
      return { provider, id };
    }
  }
  if (modelId.includes(":")) {
    const [provider, ...rest] = modelId.split(":");
    const id = rest.join(":");
    if (provider && id) {
      return { provider, id };
    }
  }
  return { id: modelId };
}

function mapResolvedCommand(command: ResolvedCommand): AgentSlashCommand {
  return {
    name: command.invocationName,
    description: command.description ?? "Extension command",
    argumentHint: "",
  };
}

function mapSkillCommand(skill: Skill): AgentSlashCommand {
  return {
    name: `skill:${skill.name}`,
    description: skill.description || "Skill",
    argumentHint: "",
  };
}

function buildSlashCommands(session: PiDirectSessionAdapter): AgentSlashCommand[] {
  const commands: AgentSlashCommand[] = [];
  const extensionCommands = session.extensionRunner?.getRegisteredCommands() ?? [];

  for (const command of extensionCommands) {
    commands.push(mapResolvedCommand(command));
  }

  for (const template of session.promptTemplates) {
    commands.push({
      name: template.name,
      description: template.description ?? "Prompt template",
      argumentHint: "",
    });
  }

  const resourceLoader: ResourceLoader = session.resourceLoader;
  const skills = resourceLoader.getSkills().skills;
  for (const skill of skills) {
    commands.push(mapSkillCommand(skill));
  }

  return commands;
}

function applySystemPrompt(session: PiAgentSession, systemPrompt: string | undefined): void {
  const trimmed = systemPrompt?.trim();
  if (!trimmed) {
    return;
  }

  // Pi does not expose a public setter for composing an additional system prompt,
  // so this escape hatch is isolated to one typed boundary.
  const sessionObject = session as object;
  const baseSystemPrompt = Reflect.get(sessionObject, "_baseSystemPrompt");
  const currentBase =
    typeof baseSystemPrompt === "string" ? baseSystemPrompt : session.agent.state.systemPrompt;
  const combinedPrompt = currentBase ? `${currentBase}\n\n${trimmed}` : trimmed;
  Reflect.set(sessionObject, "_baseSystemPrompt", combinedPrompt);
  session.agent.state.systemPrompt = combinedPrompt;
}

function isTextContentBlock(block: unknown): block is TextContent {
  return PiPromptTextBlockSchema.safeParse(block).success;
}

function getUserMessageText(content: string | (TextContent | ImageContent)[]): string {
  if (typeof content === "string") {
    return content;
  }

  const textParts: string[] = [];
  for (const block of content) {
    if (isTextContentBlock(block)) {
      textParts.push(block.text);
    }
  }
  return textParts.join("\n\n");
}

function parsePersistenceMetadata(metadata: AgentMetadata | undefined): PiPersistenceMetadata {
  const parsed = PiPersistenceMetadataSchema.safeParse(metadata);
  if (parsed.success) {
    return parsed.data;
  }
  return {};
}

function getStreamEventTurnId(event: AgentStreamEvent): string | undefined {
  switch (event.type) {
    case "turn_started":
    case "turn_completed":
    case "turn_failed":
    case "turn_canceled":
    case "timeline":
    case "permission_requested":
    case "permission_resolved":
      return event.turnId;
    default:
      return undefined;
  }
}

function isPiRequestAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") {
    return true;
  }

  return /\brequest was aborted\b/i.test(toDiagnosticErrorMessage(error));
}

function resolveThinkingOptionId(
  cachedThinkingOptionId: string | null,
  sessionThinkingLevel: ThinkingLevel,
): ThinkingLevel | null {
  const currentThinking = cachedThinkingOptionId ?? sessionThinkingLevel;
  return normalizePiThinkingOption(currentThinking);
}

function mapThinkingOption(option: (typeof PI_THINKING_OPTIONS)[number]) {
  const mappedOption = {
    id: option.id,
    label: option.label,
    description: option.description,
  };
  if (option.isDefault) {
    return {
      ...mappedOption,
      isDefault: true,
    };
  }
  return mappedOption;
}

function findModelInRegistry(
  registry: PiDirectModelRegistry,
  parsedReference: PiModelReference,
): Model<Api> | undefined {
  if (parsedReference.provider) {
    return (
      registry.find(parsedReference.provider, parsedReference.id) ??
      createProviderModelFallback(registry, {
        provider: parsedReference.provider,
        id: parsedReference.id,
      })
    );
  }

  return registry.getAll().find((entry) => {
    if (entry.id === parsedReference.id) {
      return true;
    }
    return `${entry.provider}/${entry.id}` === parsedReference.id;
  });
}

function createProviderModelFallback(
  registry: PiDirectModelRegistry,
  parsedReference: { provider: string; id: string },
): Model<Api> | undefined {
  const providerDefault = registry
    .getAll()
    .find((model) => model.provider === parsedReference.provider);
  if (!providerDefault) {
    return undefined;
  }

  return {
    id: parsedReference.id,
    name: parsedReference.id,
    api: providerDefault.api,
    provider: parsedReference.provider,
    baseUrl: providerDefault.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
    compat: providerDefault.compat,
  };
}

export class PiDirectAgentSession implements AgentSession {
  readonly provider = PI_PROVIDER;
  readonly capabilities = PI_CAPABILITIES;

  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private readonly activeToolCalls = new Map<string, PiTrackedToolCall>();
  private activeTurnId: string | null = null;
  private lastKnownThinkingOptionId: string | null;
  private latestUsage: AgentUsage | undefined;

  constructor(
    private readonly runtime: PiDirectSessionRuntimeAdapter,
    private readonly modelRegistry: PiDirectModelRegistry,
    private readonly config: AgentSessionConfig,
  ) {
    const session = this.session;
    this.lastKnownThinkingOptionId =
      normalizePiThinkingOption(config.thinkingOptionId) ?? session.thinkingLevel ?? null;

    session.subscribe((event) => {
      this.handleSessionEvent(event);
    });
  }

  private get session(): PiDirectSessionAdapter {
    return this.runtime.session;
  }

  get id(): string | null {
    return this.session.sessionId;
  }

  private emit(event: AgentStreamEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }

  private currentTurnIdForEvent(): string | undefined {
    return this.activeTurnId ?? undefined;
  }

  private emitToolCallEvent(
    toolCallId: string,
    toolCall: PiTrackedToolCall,
    status: "running" | "completed" | "failed",
    result: PiToolResult,
    error: unknown,
  ): void {
    const turnId = this.currentTurnIdForEvent();
    const detail = mapToolDetail(toolCall, result);
    const baseItem = {
      type: "tool_call" as const,
      callId: toolCallId,
      name: toolCall.toolName,
      detail,
    };
    const item =
      status === "failed" ? { ...baseItem, status, error } : { ...baseItem, status, error: null };
    this.emit({
      type: "timeline",
      provider: PI_PROVIDER,
      turnId,
      item,
    });
  }

  private handleMessageUpdate(
    event: Extract<AgentSessionEvent, { type: "message_update" }>,
    turnId: string | undefined,
  ): void {
    if (event.message.role !== "assistant") {
      return;
    }
    if (event.assistantMessageEvent.type === "text_delta") {
      this.emit({
        type: "timeline",
        provider: PI_PROVIDER,
        turnId,
        item: {
          type: "assistant_message",
          text: event.assistantMessageEvent.delta ?? "",
        },
      });
      return;
    }
    if (event.assistantMessageEvent.type === "thinking_delta") {
      this.emit({
        type: "timeline",
        provider: PI_PROVIDER,
        turnId,
        item: {
          type: "reasoning",
          text: event.assistantMessageEvent.delta ?? "",
        },
      });
    }
  }

  private handleSessionEvent(event: AgentSessionEvent): void {
    const turnId = this.currentTurnIdForEvent();

    switch (event.type) {
      case "agent_start":
        this.emit({
          type: "thread_started",
          provider: PI_PROVIDER,
          sessionId: this.session.sessionId,
        });
        return;
      case "turn_start":
        this.emit({
          type: "turn_started",
          provider: PI_PROVIDER,
          turnId,
        });
        return;
      case "message_update":
        this.handleMessageUpdate(event, turnId);
        return;
      case "tool_execution_start": {
        const toolCall = parseToolArgs(event.toolName, event.args);
        this.activeToolCalls.set(event.toolCallId, toolCall);
        this.emitToolCallEvent(event.toolCallId, toolCall, "running", null, null);
        return;
      }
      case "tool_execution_update": {
        const toolCall = this.activeToolCalls.get(event.toolCallId);
        if (!toolCall) {
          return;
        }

        const partialResult = parseToolResult(event.partialResult);
        this.emitToolCallEvent(event.toolCallId, toolCall, "running", partialResult, null);
        return;
      }
      case "tool_execution_end": {
        const toolCall =
          this.activeToolCalls.get(event.toolCallId) ?? parseToolArgs(event.toolName, null);
        this.activeToolCalls.delete(event.toolCallId);

        const result = parseToolResult(event.result);
        const error = event.isError ? event.result : null;
        const status = event.isError ? "failed" : "completed";
        this.emitToolCallEvent(event.toolCallId, toolCall, status, result, error);
        return;
      }
      case "turn_end":
        return;
      case "compaction_start":
        this.emit({
          type: "timeline",
          provider: PI_PROVIDER,
          turnId,
          item: {
            type: "compaction",
            status: "loading",
            trigger: event.reason === "manual" ? "manual" : "auto",
          },
        });
        return;
      case "compaction_end":
        this.emit({
          type: "timeline",
          provider: PI_PROVIDER,
          turnId,
          item: {
            type: "compaction",
            status: "completed",
          },
        });
        return;
      case "agent_end": {
        this.latestUsage = toAgentUsage(this.session.getSessionStats());
        const currentTurnId = turnId;
        this.activeTurnId = null;
        if (this.session.agent.state.errorMessage) {
          this.emit({
            type: "turn_failed",
            provider: PI_PROVIDER,
            turnId: currentTurnId,
            error: this.session.agent.state.errorMessage,
          });
          return;
        }
        this.emit({
          type: "turn_completed",
          provider: PI_PROVIDER,
          turnId: currentTurnId,
          usage: this.latestUsage,
        });
        return;
      }
      default:
        return;
    }
  }

  async run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    const timeline: AgentTimelineItem[] = [];
    let finalText = "";
    let usage: AgentUsage | undefined;
    let turnId: string | null = null;
    const bufferedEvents: AgentStreamEvent[] = [];
    let settled = false;
    let resolveCompletion!: () => void;
    let rejectCompletion!: (error: Error) => void;

    function processEvent(event: AgentStreamEvent): void {
      if (settled) {
        return;
      }

      const eventTurnId = getStreamEventTurnId(event);
      if (turnId && eventTurnId && eventTurnId !== turnId) {
        return;
      }
      if (event.type === "timeline") {
        timeline.push(event.item);
        if (event.item.type === "assistant_message") {
          finalText += event.item.text;
        }
        return;
      }
      if (event.type === "turn_completed") {
        usage = event.usage;
        settled = true;
        resolveCompletion();
        return;
      }
      if (event.type === "turn_failed") {
        settled = true;
        rejectCompletion(new Error(event.error));
      }
    }

    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const unsubscribe = this.subscribe((event) => {
      if (!turnId) {
        bufferedEvents.push(event);
        return;
      }
      processEvent(event);
    });

    try {
      const result = await this.startTurn(prompt, options);
      turnId = result.turnId;
      for (const event of bufferedEvents) {
        processEvent(event);
      }
      if (!settled) {
        await completion;
      }
    } finally {
      unsubscribe();
    }

    return {
      sessionId: this.session.sessionId,
      finalText,
      usage,
      timeline,
    };
  }

  async startTurn(prompt: AgentPromptInput, _options?: AgentRunOptions): Promise<StartTurnResult> {
    if (this.activeTurnId) {
      throw new Error("A Pi turn is already active");
    }

    const payload = convertPromptInput(prompt);
    const turnId = randomUUID();
    this.activeTurnId = turnId;

    void this.session
      .prompt(payload.text, payload.images ? { images: payload.images } : undefined)
      .catch((error) => {
        const failedTurnId = this.activeTurnId ?? turnId;
        this.activeTurnId = null;
        if (isPiRequestAbortError(error)) {
          this.emit({
            type: "turn_canceled",
            provider: PI_PROVIDER,
            turnId: failedTurnId,
            reason: toDiagnosticErrorMessage(error),
          });
          return;
        }
        this.emit({
          type: "turn_failed",
          provider: PI_PROVIDER,
          turnId: failedTurnId,
          error: toDiagnosticErrorMessage(error),
        });
      });

    return { turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    const pendingToolCalls = new Map<string, PiTrackedToolCall>();
    let userIndex = 0;

    for (const message of this.session.messages) {
      if (message.role === "user") {
        const text = getUserMessageText(message.content);
        if (text) {
          yield {
            type: "timeline",
            provider: PI_PROVIDER,
            item: {
              type: "user_message",
              text,
              messageId: `pi-user-${userIndex}`,
            },
          };
        }
        userIndex += 1;
        continue;
      }

      if (message.role === "assistant") {
        for (const content of message.content) {
          if (content.type === "text" && content.text) {
            yield {
              type: "timeline",
              provider: PI_PROVIDER,
              item: { type: "assistant_message", text: content.text },
            };
            continue;
          }

          if (content.type === "thinking" && content.thinking) {
            yield {
              type: "timeline",
              provider: PI_PROVIDER,
              item: { type: "reasoning", text: content.thinking },
            };
            continue;
          }

          if (content.type === "toolCall") {
            const tracked = parseToolArgs(content.name, content.arguments);
            pendingToolCalls.set(content.id, tracked);
            yield {
              type: "timeline",
              provider: PI_PROVIDER,
              item: {
                type: "tool_call",
                callId: content.id,
                name: tracked.toolName,
                status: "running",
                detail: mapToolDetail(tracked, null),
                error: null,
              },
            };
          }
        }
        continue;
      }

      if (message.role === "toolResult") {
        const tracked =
          pendingToolCalls.get(message.toolCallId) ?? parseToolArgs(message.toolName, null);
        pendingToolCalls.delete(message.toolCallId);
        const result = parseToolResult({ content: message.content });
        const detail = mapToolDetail(tracked, result);

        if (message.isError) {
          const errorText = extractTextFromToolResult(result) ?? "Tool call failed";
          yield {
            type: "timeline",
            provider: PI_PROVIDER,
            item: {
              type: "tool_call",
              callId: message.toolCallId,
              name: tracked.toolName,
              status: "failed",
              detail,
              error: errorText,
            },
          };
        } else {
          yield {
            type: "timeline",
            provider: PI_PROVIDER,
            item: {
              type: "tool_call",
              callId: message.toolCallId,
              name: tracked.toolName,
              status: "completed",
              detail,
              error: null,
            },
          };
        }
        continue;
      }

      if (message.role === "bashExecution") {
        const callId = `pi-bash-${message.timestamp}`;
        const exitCode = message.exitCode ?? null;
        const detail: ToolCallDetail = {
          type: "shell",
          command: message.command,
          output: message.output,
          exitCode,
        };
        yield {
          type: "timeline",
          provider: PI_PROVIDER,
          item: {
            type: "tool_call",
            callId,
            name: "bash",
            status: message.cancelled ? "canceled" : "completed",
            detail,
            error: null,
          },
        };
      }
    }
  }

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    const thinkingOptionId = resolveThinkingOptionId(
      this.lastKnownThinkingOptionId,
      this.session.thinkingLevel,
    );

    return {
      provider: PI_PROVIDER,
      sessionId: this.session.sessionId,
      model: this.session.model ? `${this.session.model.provider}/${this.session.model.id}` : null,
      thinkingOptionId,
      modeId: null,
    };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return [];
  }

  async getCurrentMode(): Promise<string | null> {
    return null;
  }

  async setMode(modeId: string): Promise<void> {
    void modeId;
    throw new Error("Pi does not expose selectable modes");
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return [];
  }

  async respondToPermission(requestId: string, response: AgentPermissionResponse): Promise<void> {
    void requestId;
    void response;
  }

  describePersistence(): AgentPersistenceHandle | null {
    return {
      provider: PI_PROVIDER,
      sessionId: this.session.sessionId,
      nativeHandle: this.session.sessionManager.getSessionFile(),
      metadata: {
        cwd: this.session.sessionManager.getCwd(),
      },
    };
  }

  async interrupt(): Promise<void> {
    await this.session.abort();
  }

  async close(): Promise<void> {
    await this.runtime.dispose();
  }

  async listCommands(): Promise<AgentSlashCommand[]> {
    return buildSlashCommands(this.session);
  }

  async setModel(modelId: string | null): Promise<void> {
    const parsedReference = parseModelReference(modelId);
    if (!parsedReference) {
      return;
    }

    const model = findModelInRegistry(this.modelRegistry, parsedReference);
    if (!model) {
      throw new Error(`Unknown Pi model: ${modelId}`);
    }

    await this.session.setModel(model);
    this.config.model = `${model.provider}/${model.id}`;
  }

  async setThinkingOption(thinkingOptionId: string | null): Promise<void> {
    const thinkingLevel = normalizePiThinkingOption(thinkingOptionId) ?? DEFAULT_PI_THINKING_LEVEL;
    this.session.setThinkingLevel(thinkingLevel);
    this.lastKnownThinkingOptionId = thinkingLevel;
    this.config.thinkingOptionId = thinkingLevel;
  }
}

export class PiDirectAgentClient implements AgentClient {
  readonly provider = PI_PROVIDER;
  readonly capabilities = PI_CAPABILITIES;

  private readonly logger: Logger;
  private readonly runtimeSettings?: ProviderRuntimeSettings;
  private modelRegistry: ModelRegistry | null = null;

  constructor(options: PiDirectAgentClientOptions) {
    this.logger = options.logger;
    this.runtimeSettings = options.runtimeSettings;
  }

  private async getSessionServices(cwd: string, agentDir?: string): Promise<AgentSessionServices> {
    return createAgentSessionServices({
      cwd,
      ...(agentDir ? { agentDir } : {}),
      ...(this.modelRegistry ? { modelRegistry: this.modelRegistry } : {}),
    });
  }

  private resolveConfiguredModel(
    registry: PiDirectModelRegistry,
    modelId: string | null | undefined,
  ): Model<Api> | undefined {
    const parsedReference = parseModelReference(modelId ?? null);
    if (!parsedReference) {
      return undefined;
    }

    return findModelInRegistry(registry, parsedReference);
  }

  private async createSdkRuntime(
    config: AgentSessionConfig,
    sessionManager: SessionManager,
    options: { defaultThinkingLevel?: ThinkingLevel } = {},
  ): Promise<PiDirectSessionResult> {
    const createRuntime: CreateAgentSessionRuntimeFactory = async ({
      cwd,
      agentDir,
      sessionManager: runtimeSessionManager,
      sessionStartEvent,
    }) => {
      const thinkingLevel =
        normalizePiThinkingOption(config.thinkingOptionId) ?? options.defaultThinkingLevel;
      const services = await this.getSessionServices(cwd, agentDir);
      const model = this.resolveConfiguredModel(services.modelRegistry, config.model);

      return {
        ...(await createAgentSessionFromServices({
          services,
          sessionManager: runtimeSessionManager,
          sessionStartEvent,
          ...(thinkingLevel ? { thinkingLevel } : {}),
          ...(model ? { model } : {}),
        })),
        services,
        diagnostics: services.diagnostics,
      };
    };

    const runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: sessionManager.getCwd(),
      agentDir: getAgentDir(),
      sessionManager,
    });
    await runtime.session.bindExtensions({});
    applySystemPrompt(runtime.session, config.systemPrompt);
    return { runtime, modelRegistry: runtime.services.modelRegistry };
  }

  async createSession(
    config: AgentSessionConfig,
    _launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const { runtime, modelRegistry } = await this.createSdkRuntime(
      config,
      SessionManager.create(config.cwd),
      {
        defaultThinkingLevel: DEFAULT_PI_THINKING_LEVEL,
      },
    );
    return new PiDirectAgentSession(runtime, modelRegistry, config);
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    _launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const sessionFile = handle.nativeHandle;
    if (!sessionFile) {
      throw new Error("Pi resume requires a native session file handle");
    }

    const initialManager = SessionManager.open(sessionFile);
    const persistenceMetadata = parsePersistenceMetadata(handle.metadata);
    const cwd = overrides?.cwd ?? persistenceMetadata.cwd ?? initialManager.getCwd();
    const resumedManager = SessionManager.open(sessionFile, undefined, cwd);
    const mergedConfig: AgentSessionConfig = {
      provider: PI_PROVIDER,
      cwd,
      model: overrides?.model,
      thinkingOptionId: overrides?.thinkingOptionId,
      systemPrompt: overrides?.systemPrompt,
      featureValues: overrides?.featureValues,
      title: overrides?.title,
      approvalPolicy: overrides?.approvalPolicy,
      sandboxMode: overrides?.sandboxMode,
      networkAccess: overrides?.networkAccess,
      webSearch: overrides?.webSearch,
      extra: overrides?.extra,
      mcpServers: overrides?.mcpServers,
      internal: overrides?.internal,
      modeId: overrides?.modeId,
    };

    const { runtime, modelRegistry } = await this.createSdkRuntime(mergedConfig, resumedManager);
    return new PiDirectAgentSession(runtime, modelRegistry, mergedConfig);
  }

  async listModels(options: ListModelsOptions): Promise<AgentModelDefinition[]> {
    const services = await this.getSessionServices(options.cwd);
    const models = services.modelRegistry.getAvailable().map((model) => ({
      provider: PI_PROVIDER,
      id: `${model.provider}/${model.id}`,
      label: `${model.provider}/${model.name}`,
      description: `${model.provider}/${model.id}`,
      metadata: {
        provider: model.provider,
        modelId: model.id,
      } satisfies AgentMetadata,
      thinkingOptions: model.reasoning ? PI_THINKING_OPTIONS.map(mapThinkingOption) : undefined,
      defaultThinkingOptionId: model.reasoning ? DEFAULT_PI_THINKING_LEVEL : undefined,
    }));

    return transformPiModels(models);
  }

  async listModes(_options: ListModesOptions): Promise<AgentMode[]> {
    return [];
  }

  async isAvailable(): Promise<boolean> {
    const command = this.runtimeSettings?.command;
    if (command?.mode === "replace" && command.argv[0]) {
      if (!existsSync(command.argv[0])) {
        return false;
      }
    } else if (!(await isCommandAvailable(PI_BINARY_COMMAND))) {
      return false;
    }

    const registry = ModelRegistry.create(AuthStorage.create());
    return registry.getAvailable().length > 0;
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    try {
      const available = await this.isAvailable();
      const binaryOverride = this.runtimeSettings?.command;
      const binary =
        binaryOverride?.mode === "replace" && binaryOverride.argv[0]
          ? binaryOverride.argv[0]
          : await findExecutable(PI_BINARY_COMMAND);
      const version = binary ? await resolveBinaryVersion(binary) : "unknown";
      const authConfigPath = join(homedir(), ".pi", "agent", "auth.json");
      let modelsValue = "Not checked";
      let status = formatDiagnosticStatus(available);
      const registry = ModelRegistry.create(AuthStorage.create());
      const configuredProviders = Array.from(
        new Set(registry.getAvailable().map((model) => model.provider)),
      ).sort();

      if (available) {
        try {
          const models = await this.listModels({ cwd: homedir(), force: false });
          modelsValue = String(models.length);
        } catch (error) {
          modelsValue = `Error - ${toDiagnosticErrorMessage(error)}`;
          status = formatDiagnosticStatus(available, {
            source: "model fetch",
            cause: error,
          });
        }
      }

      return {
        diagnostic: formatProviderDiagnostic("Pi", [
          { label: "Binary", value: binary ?? "not found" },
          { label: "Version", value: version },
          {
            label: "Configured providers",
            value: configuredProviders.length > 0 ? configuredProviders.join(", ") : "none",
          },
          {
            label: "Auth config (~/.pi/agent/auth.json)",
            value: existsSync(authConfigPath) ? "found" : "not found",
          },
          { label: "Models", value: modelsValue },
          { label: "Status", value: status },
        ]),
      };
    } catch (error) {
      this.logger.debug({ err: error }, "Pi diagnostic lookup failed");
      return {
        diagnostic: formatProviderDiagnosticError("Pi", error),
      };
    }
  }
}
