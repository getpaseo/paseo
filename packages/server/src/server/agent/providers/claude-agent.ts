import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { promises } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  query,
  type AgentDefinition,
  type CanUseTool,
  type McpServerConfig as ClaudeSdkMcpServerConfig,

  type Options,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SpawnOptions,
  type SDKMessage,
  type SDKPartialAssistantMessage,
  type SDKResultMessage,
  type SDKSystemMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";
import {
  mapClaudeCanceledToolCall,
  mapClaudeCompletedToolCall,
  mapClaudeFailedToolCall,
  mapClaudeRunningToolCall,
} from "./claude/tool-call-mapper.js";
import {
  mapTaskNotificationSystemRecordToToolCall,
  mapTaskNotificationUserContentToToolCall,
} from "./claude/task-notification-tool-call.js";
import {
  getClaudeModels,
  normalizeClaudeRuntimeModelId,
} from "./claude/claude-models.js";
import { parsePartialJsonObject } from "./claude/partial-json.js";
import { ClaudeSidechainTracker } from "./claude/sidechain-tracker.js";
import {
  formatDiagnosticStatus,
  formatProviderDiagnostic,
  formatProviderDiagnosticError,
  toDiagnosticErrorMessage,
} from "./diagnostic-utils.js";

import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentLaunchContext,
  AgentMetadata,
  AgentMode,
  AgentModelDefinition,
  AgentPermissionRequest,
  AgentPermissionRequestKind,
  AgentPermissionResponse,
  AgentPermissionUpdate,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentRunOptions,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentSlashCommand,
  AgentStreamEvent,
  AgentTimelineItem,
  AgentUsage,
  AgentRuntimeInfo,
  ListModelsOptions,
  ListPersistedAgentsOptions,
  McpServerConfig,
  PersistedAgentDescriptor,
} from "../agent-sdk-types.js";
import {
  applyProviderEnv,
  type ProviderRuntimeSettings,
} from "../provider-launch-config.js";
import {
  findExecutable,
  quoteWindowsArgument,
  quoteWindowsCommand,
} from "../../../utils/executable.js";
import { getOrchestratorModeInstructions } from "../orchestrator-instructions.js";

const fsPromises = promises;
const CLAUDE_SETTING_SOURCES: NonNullable<Options["settingSources"]> = ["user", "project"];

type TurnState = "idle" | "foreground" | "autonomous";

type EventIdentifiers = {
  taskId: string | null;
  parentMessageId: string | null;
  messageId: string | null;
};

type AutonomousTurnState = {
  id: string;
};

type AsyncMessageInput<T> = {
  push: (item: T) => void;
  end: () => void;
  iterable: AsyncIterable<T>;
};

const CLAUDE_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
};

const DEFAULT_MODES: AgentMode[] = [
  {
    id: "default",
    label: "Always Ask",
    description: "Prompts for permission the first time a tool is used",
  },
  {
    id: "acceptEdits",
    label: "Accept File Edits",
    description: "Automatically approves edit-focused tools without prompting",
  },
  {
    id: "plan",
    label: "Plan Mode",
    description: "Analyze the codebase without executing tools or edits",
  },
  {
    id: "bypassPermissions",
    label: "Bypass",
    description: "Skip all permission prompts (use with caution)",
  },
];

const VALID_CLAUDE_MODES = new Set(DEFAULT_MODES.map((mode) => mode.id));

const REWIND_COMMAND_NAME = "rewind";
const REWIND_COMMAND: AgentSlashCommand = {
  name: REWIND_COMMAND_NAME,
  description: "Rewind tracked files to a previous user message",
  argumentHint: "[user_message_uuid]",
};
const INTERRUPT_TOOL_USE_PLACEHOLDER = "[Request interrupted by user for tool use]";
const INTERRUPT_PLACEHOLDER_PATTERN = /^\[Request interrupted by user(?:[^\]]*)\]$/;
const NO_RESPONSE_REQUESTED_PLACEHOLDER = "No response requested.";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type SlashCommandInvocation = {
  commandName: string;
  args?: string;
  rawInput: string;
};

// Orchestrator instructions moved to shared module.
type ClaudeAgentConfig = AgentSessionConfig & { provider: "claude" };

export type ClaudeContentChunk = { type: string; [key: string]: any };

type ClaudeOptions = Options;

type ClaudeAgentClientOptions = {
  defaults?: { agents?: Record<string, AgentDefinition> };
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
  queryFactory?: typeof query;
};

type ClaudeAgentSessionOptions = {
  defaults?: { agents?: Record<string, AgentDefinition> };
  runtimeSettings?: ProviderRuntimeSettings;
  handle?: AgentPersistenceHandle;
  launchEnv?: Record<string, string>;
  logger: Logger;
  queryFactory?: typeof query;
};

type ClaudeThinkingEffort = "low" | "medium" | "high" | "max";

function resolveClaudeSpawnCommand(
  spawnOptions: SpawnOptions,
  runtimeSettings?: ProviderRuntimeSettings,
): { command: string; args: string[] } {
  const commandConfig = runtimeSettings?.command;
  if (!commandConfig || commandConfig.mode === "default") {
    return {
      command: spawnOptions.command,
      args: [...spawnOptions.args],
    };
  }

  if (commandConfig.mode === "append") {
    return {
      command: spawnOptions.command,
      args: [...spawnOptions.args, ...(commandConfig.args ?? [])],
    };
  }

  return {
    command: commandConfig.argv[0]!,
    args: [...commandConfig.argv.slice(1), ...spawnOptions.args],
  };
}

function applyRuntimeSettingsToClaudeOptions(
  options: ClaudeOptions,
  runtimeSettings?: ProviderRuntimeSettings,
  launchEnv?: Record<string, string>,
): ClaudeOptions {
  return {
    ...options,
    spawnClaudeCodeProcess: (spawnOptions) => {
      const resolved = resolveClaudeSpawnCommand(spawnOptions, runtimeSettings);
      // When the SDK passes a default JS runtime ("node"/"bun"), replace it with
      // process.execPath — the actual node binary running the daemon. This avoids
      // PATH lookup failures in the managed runtime bundle.
      // When the SDK passes a native binary path (from pathToClaudeCodeExecutable)
      // or the user overrides the command via runtime settings, use that directly.
      const isDefaultRuntime =
        resolved.command === "node" || resolved.command === "bun";
      const command = isDefaultRuntime ? process.execPath : resolved.command;
      const child = spawn(
        quoteWindowsCommand(command),
        resolved.args.map((argument) => quoteWindowsArgument(argument)),
        {
        cwd: spawnOptions.cwd,
        env: {
          ...applyProviderEnv(spawnOptions.env, runtimeSettings),
          ...(launchEnv ?? {}),
        },
        shell: process.platform === "win32",
        signal: spawnOptions.signal,
        stdio: ["pipe", "pipe", "pipe"],
        },
      );
      if (typeof options.stderr === "function") {
        child.stderr?.on("data", (chunk: Buffer | string) => {
          options.stderr?.(chunk.toString());
        });
      }
      return child;
    },
  };
}

function isClaudeThinkingEffort(value: string | null | undefined): value is ClaudeThinkingEffort {
  return value === "low" || value === "medium" || value === "high" || value === "max";
}

type ClaudeOptionsLogSummary = {
  cwd: string | null;
  permissionMode: string | null;
  model: string | null;
  includePartialMessages: boolean;
  settingSources: string[];
  enableFileCheckpointing: boolean;
  hasResume: boolean;
  maxThinkingTokens: number | null;
  hasEnv: boolean;
  envKeyCount: number;
  hasMcpServers: boolean;
  mcpServerNames: string[];
  systemPromptMode: "none" | "string" | "preset" | "custom";
  systemPromptPreset: string | null;
  hasCanUseTool: boolean;
  hasSpawnOverride: boolean;
  hasStderrHandler: boolean;
  pathToClaudeCodeExecutable: string | null;
};

const MAX_RECENT_STDERR_CHARS = 4000;
const STDERR_FLUSH_WAIT_MS = 150;
const STDERR_FLUSH_POLL_INTERVAL_MS = 10;

function summarizeClaudeOptionsForLog(options: ClaudeOptions): ClaudeOptionsLogSummary {
  const systemPromptRaw = options.systemPrompt;
  const systemPromptSummary = (() => {
    if (!systemPromptRaw) {
      return { mode: "none" as const, preset: null };
    }
    if (typeof systemPromptRaw === "string") {
      return { mode: "string" as const, preset: null };
    }
    const prompt = systemPromptRaw as Record<string, unknown>;
    const promptType = typeof prompt.type === "string" ? prompt.type : "custom";
    return {
      mode: promptType === "preset" ? ("preset" as const) : ("custom" as const),
      preset: typeof prompt.preset === "string" && prompt.preset.length > 0 ? prompt.preset : null,
    };
  })();
  const mcpServerNames = options.mcpServers ? Object.keys(options.mcpServers).sort() : [];

  return {
    cwd: typeof options.cwd === "string" ? options.cwd : null,
    permissionMode: typeof options.permissionMode === "string" ? options.permissionMode : null,
    model: typeof options.model === "string" ? options.model : null,
    includePartialMessages: options.includePartialMessages === true,
    settingSources: Array.isArray(options.settingSources) ? options.settingSources : [],
    enableFileCheckpointing: options.enableFileCheckpointing === true,
    hasResume: typeof options.resume === "string" && options.resume.length > 0,
    maxThinkingTokens:
      typeof options.maxThinkingTokens === "number" ? options.maxThinkingTokens : null,
    hasEnv: !!options.env,
    envKeyCount: Object.keys(options.env ?? {}).length,
    hasMcpServers: mcpServerNames.length > 0,
    mcpServerNames,
    systemPromptMode: systemPromptSummary.mode,
    systemPromptPreset: systemPromptSummary.preset,
    hasCanUseTool: typeof options.canUseTool === "function",
    hasSpawnOverride: typeof options.spawnClaudeCodeProcess === "function",
    hasStderrHandler: typeof options.stderr === "function",
    pathToClaudeCodeExecutable:
      typeof options.pathToClaudeCodeExecutable === "string"
        ? options.pathToClaudeCodeExecutable
        : null,
  };
}

function isToolResultTextBlock(value: unknown): value is { type: "text"; text: string } {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "text" &&
    typeof (value as { text?: unknown }).text === "string"
  );
}

function normalizeForDeterministicString(value: unknown, seen: WeakSet<object>): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "function") {
    return "[function]";
  }
  if (typeof value === "symbol") {
    return value.toString();
  }
  if (typeof value === "undefined") {
    return "[undefined]";
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeForDeterministicString(entry, seen));
  }
  if (typeof value === "object") {
    const objectValue = value as object;
    if (seen.has(objectValue)) {
      return "[circular]";
    }
    seen.add(objectValue);
    const record = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      normalized[key] = normalizeForDeterministicString(record[key], seen);
    }
    seen.delete(objectValue);
    return normalized;
  }
  return String(value);
}

function deterministicStringify(value: unknown): string {
  if (typeof value === "undefined") {
    return "";
  }
  try {
    const normalized = normalizeForDeterministicString(value, new WeakSet<object>());
    if (typeof normalized === "string") {
      return normalized;
    }
    return JSON.stringify(normalized);
  } catch {
    try {
      return String(value);
    } catch {
      return "[unserializable]";
    }
  }
}

function coerceToolResultContentToString(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content) && content.every((block) => isToolResultTextBlock(block))) {
    return content.map((block) => block.text).join("");
  }
  return deterministicStringify(content);
}

function normalizeClaudeTranscriptText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function isClaudeInterruptPlaceholderText(value: unknown): boolean {
  const normalized = normalizeClaudeTranscriptText(value);
  return normalized !== null && INTERRUPT_PLACEHOLDER_PATTERN.test(normalized);
}

function isClaudeNoResponsePlaceholderText(value: unknown): boolean {
  return normalizeClaudeTranscriptText(value) === NO_RESPONSE_REQUESTED_PLACEHOLDER;
}

function isClaudeTranscriptNoiseText(value: unknown): boolean {
  return isClaudeInterruptPlaceholderText(value) || isClaudeNoResponsePlaceholderText(value);
}

function collectClaudeTextContentParts(content: unknown): string[] {
  if (typeof content === "string") {
    const normalized = normalizeClaudeTranscriptText(content);
    return normalized ? [normalized] : [];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const text = normalizeClaudeTranscriptText((block as { text?: unknown }).text);
    if (text) {
      parts.push(text);
      continue;
    }
    const input = normalizeClaudeTranscriptText((block as { input?: unknown }).input);
    if (input) {
      parts.push(input);
    }
  }

  return parts;
}

function isClaudeTranscriptNoiseContent(content: unknown): boolean {
  const parts = collectClaudeTextContentParts(content);
  return parts.length > 0 && parts.every((part) => isClaudeTranscriptNoiseText(part));
}

export function extractUserMessageText(content: unknown): string | null {
  if (typeof content === "string") {
    const normalized = content.trim();
    if (!normalized || isClaudeTranscriptNoiseText(normalized)) {
      return null;
    }
    return normalized;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const text = typeof block.text === "string" ? block.text : undefined;
    if (text && text.trim()) {
      const trimmed = text.trim();
      if (!isClaudeTranscriptNoiseText(trimmed)) {
        parts.push(trimmed);
      }
      continue;
    }
    const input = typeof block.input === "string" ? block.input : undefined;
    if (input && input.trim()) {
      const trimmed = input.trim();
      if (!isClaudeTranscriptNoiseText(trimmed)) {
        parts.push(trimmed);
      }
    }
  }

  if (parts.length === 0) {
    return null;
  }

  const combined = parts.join("\n\n").trim();
  return combined.length > 0 ? combined : null;
}

type PendingPermission = {
  request: AgentPermissionRequest;
  resolve: (result: PermissionResult) => void;
  reject: (error: Error) => void;
  cleanup?: () => void;
};

type ToolUseClassification = "generic" | "command" | "file_change";
type ToolUseCacheEntry = {
  id: string;
  name: string;
  server: string;
  classification: ToolUseClassification;
  started: boolean;
  commandText?: string;
  files?: { path: string; kind: string }[];
  input?: AgentMetadata | null;
};
function isMetadata(value: unknown): value is AgentMetadata {
  return typeof value === "object" && value !== null;
}

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isMcpServerConfig(value: unknown): value is McpServerConfig {
  if (!isMetadata(value)) {
    return false;
  }
  const type = value.type;
  if (type === "stdio") {
    return typeof value.command === "string";
  }
  if (type === "http" || type === "sse") {
    return typeof value.url === "string";
  }
  return false;
}

function isMcpServersRecord(value: unknown): value is Record<string, McpServerConfig> {
  if (!isMetadata(value)) {
    return false;
  }
  for (const config of Object.values(value)) {
    if (!isMcpServerConfig(config)) {
      return false;
    }
  }
  return true;
}

function isPermissionMode(value: string | undefined): value is PermissionMode {
  return typeof value === "string" && VALID_CLAUDE_MODES.has(value);
}

function coerceSessionMetadata(metadata: AgentMetadata | undefined): Partial<AgentSessionConfig> {
  if (!isMetadata(metadata)) {
    return {};
  }

  const result: Partial<AgentSessionConfig> = {};
  if (metadata.provider === "claude" || metadata.provider === "codex") {
    result.provider = metadata.provider;
  }
  if (typeof metadata.cwd === "string") {
    result.cwd = metadata.cwd;
  }
  if (typeof metadata.modeId === "string") {
    result.modeId = metadata.modeId;
  }
  if (typeof metadata.model === "string") {
    result.model = metadata.model;
  }
  if (typeof metadata.title === "string" || metadata.title === null) {
    result.title = metadata.title;
  }
  if (typeof metadata.approvalPolicy === "string") {
    result.approvalPolicy = metadata.approvalPolicy;
  }
  if (typeof metadata.sandboxMode === "string") {
    result.sandboxMode = metadata.sandboxMode;
  }
  if (typeof metadata.networkAccess === "boolean") {
    result.networkAccess = metadata.networkAccess;
  }
  if (typeof metadata.webSearch === "boolean") {
    result.webSearch = metadata.webSearch;
  }
  if (isMetadata(metadata.extra)) {
    const extra: AgentSessionConfig["extra"] = {};
    if (isMetadata(metadata.extra.codex)) {
      extra.codex = metadata.extra.codex;
    }
    if (isClaudeExtra(metadata.extra.claude)) {
      extra.claude = metadata.extra.claude;
    }
    if (extra.codex || extra.claude) {
      result.extra = extra;
    }
  }
  if (typeof metadata.systemPrompt === "string") {
    result.systemPrompt = metadata.systemPrompt;
  }
  if (isMcpServersRecord(metadata.mcpServers)) {
    result.mcpServers = metadata.mcpServers;
  }

  return result;
}

function toClaudeSdkMcpConfig(config: McpServerConfig): ClaudeSdkMcpServerConfig {
  switch (config.type) {
    case "stdio":
      return {
        type: "stdio",
        command: config.command,
        args: config.args,
        env: config.env,
      };
    case "http":
      return {
        type: "http",
        url: config.url,
        headers: config.headers,
      };
    case "sse":
      return {
        type: "sse",
        url: config.url,
        headers: config.headers,
      };
  }
}

function isClaudeContentChunk(value: unknown): value is ClaudeContentChunk {
  return isMetadata(value) && typeof value.type === "string";
}

function isClaudeExtra(value: unknown): value is Partial<ClaudeOptions> {
  return isMetadata(value);
}

function isPermissionUpdate(value: AgentPermissionUpdate): value is PermissionUpdate {
  if (!isMetadata(value)) {
    return false;
  }
  const type = value.type;
  if (type !== "addRules" && type !== "replaceRules" && type !== "removeRules") {
    return false;
  }
  const rules = value.rules;
  const behavior = value.behavior;
  const destination = value.destination;
  return Array.isArray(rules) && typeof behavior === "string" && typeof destination === "string";
}

function resolvePermissionKind(
  toolName: string,
  input: Record<string, unknown>,
): AgentPermissionRequestKind {
  if (toolName === "ExitPlanMode") return "plan";
  if (toolName === "AskUserQuestion" && Array.isArray(input.questions)) {
    return "question";
  }
  return "tool";
}

type TimelineFragment = {
  kind: "assistant" | "reasoning";
  text: string;
};

type TimelineMessageState = {
  id: string;
  assistantText: string;
  reasoningText: string;
  emittedAssistantLength: number;
  emittedReasoningLength: number;
  stopped: boolean;
};

class TimelineAssembler {
  private readonly messages = new Map<string, TimelineMessageState>();
  private readonly finalizedMessageIds = new Set<string>();
  private readonly activeMessageByRun = new Map<string, string>();
  private syntheticMessageCounter = 0;

  consume(input: {
    message: SDKMessage;
    runId: string | null;
    messageIdHint?: string | null;
  }): AgentTimelineItem[] {
    if (input.message.type === "assistant") {
      return this.consumeAssistantMessage(input.message, input.runId, input.messageIdHint ?? null);
    }
    if (input.message.type === "stream_event") {
      return this.consumeStreamEvent(input.message, input.runId, input.messageIdHint ?? null);
    }
    return [];
  }

  private consumeAssistantMessage(
    message: SDKMessage & { type: "assistant" },
    runId: string | null,
    messageIdHint: string | null,
  ): AgentTimelineItem[] {
    const messageId =
      this.readMessageIdFromAssistantMessage(message) ??
      messageIdHint ??
      this.resolveMessageId({ runId, createIfMissing: true, messageId: null });
    if (!messageId) {
      return [];
    }
    if (this.finalizedMessageIds.has(messageId)) {
      return [];
    }
    const state = this.ensureMessageState(messageId, runId);
    const fragments = this.extractFragments(message.message?.content);
    return this.applyAbsoluteFragments(state, fragments);
  }

  private consumeStreamEvent(
    message: SDKMessage & { type: "stream_event" },
    runId: string | null,
    messageIdHint: string | null,
  ): AgentTimelineItem[] {
    const event = message.event as Record<string, unknown>;
    const eventType = readTrimmedString(event.type);
    const streamEventMessageId = this.readMessageIdFromStreamEvent(event) ?? messageIdHint;

    if (eventType === "message_start") {
      const messageId = this.resolveMessageId({
        runId,
        createIfMissing: true,
        messageId: streamEventMessageId,
      });
      if (!messageId) {
        return [];
      }
      this.ensureMessageState(messageId, runId);
      return [];
    }

    if (eventType === "message_stop") {
      const messageId = this.resolveMessageId({
        runId,
        createIfMissing: false,
        messageId: streamEventMessageId,
      });
      if (!messageId) {
        return [];
      }
      return this.finalizeMessage(messageId, runId);
    }

    if (eventType === "content_block_start") {
      return this.consumeDeltaContent(event.content_block, runId, streamEventMessageId);
    }

    if (eventType === "content_block_delta") {
      return this.consumeDeltaContent(event.delta, runId, streamEventMessageId);
    }

    return [];
  }

  private consumeDeltaContent(
    content: unknown,
    runId: string | null,
    messageIdHint: string | null,
  ): AgentTimelineItem[] {
    const fragments = this.extractFragments(content);
    if (fragments.length === 0) {
      return [];
    }
    const messageId = this.resolveMessageId({
      runId,
      createIfMissing: true,
      messageId: messageIdHint,
    });
    if (!messageId) {
      return [];
    }
    const state = this.ensureMessageState(messageId, runId);
    return this.appendFragments(state, fragments);
  }

  private appendFragments(
    state: TimelineMessageState,
    fragments: TimelineFragment[],
  ): AgentTimelineItem[] {
    for (const fragment of fragments) {
      if (fragment.kind === "assistant") {
        state.assistantText += fragment.text;
      } else {
        state.reasoningText += fragment.text;
      }
    }
    return this.emitNewContent(state);
  }

  private applyAbsoluteFragments(
    state: TimelineMessageState,
    fragments: TimelineFragment[],
  ): AgentTimelineItem[] {
    const assistantText = fragments
      .filter((fragment) => fragment.kind === "assistant")
      .map((fragment) => fragment.text)
      .join("");
    const reasoningText = fragments
      .filter((fragment) => fragment.kind === "reasoning")
      .map((fragment) => fragment.text)
      .join("");

    if (assistantText.length > 0) {
      if (!assistantText.startsWith(state.assistantText)) {
        state.emittedAssistantLength = 0;
      }
      state.assistantText = assistantText;
    }
    if (reasoningText.length > 0) {
      if (!reasoningText.startsWith(state.reasoningText)) {
        state.emittedReasoningLength = 0;
      }
      state.reasoningText = reasoningText;
    }
    return this.emitNewContent(state);
  }

  private finalizeMessage(messageId: string, runId: string | null): AgentTimelineItem[] {
    const state = this.messages.get(messageId);
    if (!state) {
      return [];
    }
    state.stopped = true;
    const items = this.emitNewContent(state);
    if (runId && this.activeMessageByRun.get(runId) === messageId) {
      this.activeMessageByRun.delete(runId);
    }
    this.finalizedMessageIds.add(messageId);
    this.messages.delete(messageId);
    return items;
  }

  private emitNewContent(state: TimelineMessageState): AgentTimelineItem[] {
    const items: AgentTimelineItem[] = [];
    const nextAssistantText = state.assistantText.slice(state.emittedAssistantLength);
    if (
      nextAssistantText.length > 0 &&
      nextAssistantText !== INTERRUPT_TOOL_USE_PLACEHOLDER &&
      !isClaudeTranscriptNoiseText(nextAssistantText)
    ) {
      state.emittedAssistantLength = state.assistantText.length;
      items.push({ type: "assistant_message", text: nextAssistantText });
    }

    const nextReasoningText = state.reasoningText.slice(state.emittedReasoningLength);
    if (nextReasoningText.length > 0) {
      state.emittedReasoningLength = state.reasoningText.length;
      items.push({ type: "reasoning", text: nextReasoningText });
    }
    return items;
  }

  private ensureMessageState(messageId: string, runId: string | null): TimelineMessageState {
    const existing = this.messages.get(messageId);
    if (existing) {
      existing.stopped = false;
      if (runId) {
        this.activeMessageByRun.set(runId, messageId);
      }
      return existing;
    }
    const created: TimelineMessageState = {
      id: messageId,
      assistantText: "",
      reasoningText: "",
      emittedAssistantLength: 0,
      emittedReasoningLength: 0,
      stopped: false,
    };
    this.messages.set(messageId, created);
    if (runId) {
      this.activeMessageByRun.set(runId, messageId);
    }
    return created;
  }

  private resolveMessageId(input: {
    runId: string | null;
    createIfMissing: boolean;
    messageId: string | null;
  }): string | null {
    if (input.messageId) {
      return input.messageId;
    }
    if (input.runId) {
      const active = this.activeMessageByRun.get(input.runId);
      if (active) {
        return active;
      }
    }
    if (!input.createIfMissing) {
      return null;
    }
    const synthetic = `synthetic-message-${++this.syntheticMessageCounter}`;
    if (input.runId) {
      this.activeMessageByRun.set(input.runId, synthetic);
    }
    return synthetic;
  }

  private extractFragments(content: unknown): TimelineFragment[] {
    if (typeof content === "string") {
      if (content.length === 0) {
        return [];
      }
      return [{ kind: "assistant", text: content }];
    }
    const blocks = Array.isArray(content) ? content : [content];
    const fragments: TimelineFragment[] = [];
    for (const rawBlock of blocks) {
      if (!isClaudeContentChunk(rawBlock)) {
        continue;
      }
      if (
        (rawBlock.type === "text" || rawBlock.type === "text_delta") &&
        typeof rawBlock.text === "string" &&
        rawBlock.text.length > 0
      ) {
        fragments.push({ kind: "assistant", text: rawBlock.text });
      }
      if (
        (rawBlock.type === "thinking" || rawBlock.type === "thinking_delta") &&
        typeof rawBlock.thinking === "string" &&
        rawBlock.thinking.length > 0
      ) {
        fragments.push({ kind: "reasoning", text: rawBlock.thinking });
      }
    }
    return fragments;
  }

  private readMessageIdFromAssistantMessage(
    message: SDKMessage & { type: "assistant" },
  ): string | null {
    const candidate = message as unknown as {
      message_id?: unknown;
      message?: { id?: unknown } | null;
    };
    return (
      readTrimmedString(candidate.message_id) ?? readTrimmedString(candidate.message?.id) ?? null
    );
  }

  private readMessageIdFromStreamEvent(event: Record<string, unknown>): string | null {
    const message = event.message as { id?: unknown } | undefined;
    return readTrimmedString(event.message_id) ?? readTrimmedString(message?.id) ?? null;
  }
}

function isSyntheticUserEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  return (entry as { isSynthetic?: unknown }).isSynthetic === true;
}

export function readEventIdentifiers(message: SDKMessage): EventIdentifiers {
  const root = message as unknown as Record<string, unknown>;
  const messageType = readTrimmedString(root.type);
  const streamEvent = root.event as Record<string, unknown> | undefined;
  const streamEventMessage = streamEvent?.message as Record<string, unknown> | undefined;
  const messageContainer = root.message as Record<string, unknown> | undefined;

  return {
    taskId:
      readTrimmedString(root.task_id) ??
      readTrimmedString(streamEvent?.task_id) ??
      readTrimmedString(streamEventMessage?.task_id) ??
      readTrimmedString(messageContainer?.task_id) ??
      null,
    parentMessageId:
      readTrimmedString(root.parent_message_id) ??
      readTrimmedString(streamEvent?.parent_message_id) ??
      readTrimmedString(streamEventMessage?.parent_message_id) ??
      readTrimmedString(messageContainer?.parent_message_id) ??
      null,
    messageId:
      readTrimmedString(root.message_id) ??
      readTrimmedString(streamEvent?.message_id) ??
      readTrimmedString(streamEventMessage?.id) ??
      readTrimmedString(streamEventMessage?.message_id) ??
      readTrimmedString(messageContainer?.id) ??
      readTrimmedString(messageContainer?.message_id) ??
      (messageType === "user" ? readTrimmedString(root.uuid) : null) ??
      null,
  };
}

export class ClaudeAgentClient implements AgentClient {
  readonly provider: "claude" = "claude";
  readonly capabilities = CLAUDE_CAPABILITIES;

  private readonly defaults?: { agents?: Record<string, AgentDefinition> };
  private readonly logger: Logger;
  private readonly runtimeSettings?: ProviderRuntimeSettings;
  private readonly queryFactory: typeof query;

  constructor(options: ClaudeAgentClientOptions) {
    this.defaults = options.defaults;
    this.logger = options.logger.child({ module: "agent", provider: "claude" });
    this.runtimeSettings = options.runtimeSettings;
    this.queryFactory = options.queryFactory ?? query;
  }

  async createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const claudeConfig = this.assertConfig(config);
    return new ClaudeAgentSession(claudeConfig, {
      defaults: this.defaults,
      runtimeSettings: this.runtimeSettings,
      launchEnv: launchContext?.env,
      logger: this.logger,
      queryFactory: this.queryFactory,
    });
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const metadata = coerceSessionMetadata(handle.metadata);
    const merged: Partial<AgentSessionConfig> = { ...metadata, ...overrides };
    if (!merged.cwd) {
      throw new Error("Claude resume requires the original working directory in metadata");
    }
    const mergedConfig: AgentSessionConfig = { ...merged, provider: "claude", cwd: merged.cwd };
    const claudeConfig = this.assertConfig(mergedConfig);
    return new ClaudeAgentSession(claudeConfig, {
      defaults: this.defaults,
      runtimeSettings: this.runtimeSettings,
      handle,
      launchEnv: launchContext?.env,
      logger: this.logger,
      queryFactory: this.queryFactory,
    });
  }

  async listModels(_options?: ListModelsOptions): Promise<AgentModelDefinition[]> {
    return getClaudeModels();

  }

  async listPersistedAgents(
    options?: ListPersistedAgentsOptions,
  ): Promise<PersistedAgentDescriptor[]> {
    const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
    const projectsRoot = path.join(configDir, "projects");
    if (!(await pathExists(projectsRoot))) {
      return [];
    }
    const limit = options?.limit ?? 20;
    const candidates = await collectRecentClaudeSessions(projectsRoot, limit * 3);
    const descriptors: PersistedAgentDescriptor[] = [];

    for (const candidate of candidates) {
      const descriptor = await parseClaudeSessionDescriptor(candidate.path, candidate.mtime);
      if (descriptor) {
        descriptors.push(descriptor);
      }
      if (descriptors.length >= limit) {
        break;
      }
    }

    return descriptors;
  }

  async isAvailable(): Promise<boolean> {
    const command = this.runtimeSettings?.command;
    if (command?.mode === "replace") {
      return fs.existsSync(command.argv[0]);
    }
    return true;
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    try {
      const resolvedBinary = findExecutable("claude") ?? "not found";
      const available = await this.isAvailable();
      const version = resolveClaudeVersion(this.runtimeSettings);
      let modelsValue = "Not checked";
      let status = formatDiagnosticStatus(available);

      if (available) {
        try {
          const models = await this.listModels();
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
        diagnostic: formatProviderDiagnostic("Claude Code", [
          { label: "Binary", value: resolvedBinary },
          ...(version ? [{ label: "Version", value: version }] : []),
          { label: "Models", value: modelsValue },
          { label: "Status", value: status },
        ]),
      };
    } catch (error) {
      return {
        diagnostic: formatProviderDiagnosticError("Claude Code", error),
      };
    }
  }

  private assertConfig(config: AgentSessionConfig): ClaudeAgentConfig {
    if (config.provider !== "claude") {
      throw new Error(`ClaudeAgentClient received config for provider '${config.provider}'`);
    }
    return { ...config, provider: "claude" } as ClaudeAgentConfig;
  }
}

function resolveClaudeVersion(runtimeSettings?: ProviderRuntimeSettings): string | null {
  const command = runtimeSettings?.command;

  try {
    if (command?.mode === "replace") {
      return execFileSync(command.argv[0]!, [...command.argv.slice(1), "--version"], {
        encoding: "utf8",
        timeout: 5_000,
      }).trim() || null;
    }

    const executable = findExecutable("claude");
    if (!executable) {
      return null;
    }

    return execFileSync(executable, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
    }).trim() || null;
  } catch {
    return null;
  }
}

class ClaudeAgentSession implements AgentSession {
  readonly provider: "claude" = "claude";
  readonly capabilities = CLAUDE_CAPABILITIES;

  private readonly config: ClaudeAgentConfig;
  private readonly launchEnv?: Record<string, string>;
  private readonly defaults?: { agents?: Record<string, AgentDefinition> };
  private readonly runtimeSettings?: ProviderRuntimeSettings;
  private readonly logger: Logger;
  private readonly queryFactory: typeof query;
  private query: Query | null = null;
  private input: AsyncMessageInput<SDKUserMessage> | null = null;
  private claudeSessionId: string | null;
  private persistence: AgentPersistenceHandle | null;
  private currentMode: PermissionMode;
  private availableModes: AgentMode[] = DEFAULT_MODES;
  private toolUseCache = new Map<string, ToolUseCacheEntry>();
  private toolUseIndexToId = new Map<number, string>();
  private toolUseInputBuffers = new Map<string, string>();
  private pendingPermissions = new Map<string, PendingPermission>();
  private activeForegroundTurnId: string | null = null;
  private autonomousTurn: AutonomousTurnState | null = null;
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private readonly timelineAssembler = new TimelineAssembler();
  private readonly sidechainTracker = new ClaudeSidechainTracker({
    getToolInput: (toolUseId) => this.toolUseCache.get(toolUseId)?.input ?? null,
  });
  private persistedHistory: AgentTimelineItem[] = [];
  private historyPending = false;
  private turnState: TurnState = "idle";
  private nextTurnOrdinal = 1;
  private cancelCurrentTurn: (() => void) | null = null;
  private cachedRuntimeInfo: AgentRuntimeInfo | null = null;
  private lastOptionsModel: string | null = null;
  private lastRuntimeModel: string | null = null;
  private compacting = false;
  private queryPumpPromise: Promise<void> | null = null;
  private queryRestartNeeded = false;
  private pendingInterruptAbort = false;
  private lastForegroundPromptText: string | null = null;
  private foregroundHasVisibleActivity = false;
  private userMessageIds: string[] = [];
  private recentStderr = "";
  private closed = false;

  constructor(config: ClaudeAgentConfig, options: ClaudeAgentSessionOptions) {
    this.config = config;
    this.launchEnv = options.launchEnv;
    this.defaults = options.defaults;
    this.runtimeSettings = options.runtimeSettings;
    this.logger = options.logger;
    this.queryFactory = options.queryFactory ?? query;
    const handle = options.handle;

    if (handle) {
      if (!handle.sessionId) {
        throw new Error("Cannot resume: persistence handle has no sessionId");
      }
      this.claudeSessionId = handle.sessionId;
      this.persistence = handle;
      this.loadPersistedHistory(handle.sessionId);
    } else {
      this.claudeSessionId = null;
      this.persistence = null;
    }

    // Validate mode if provided
    if (config.modeId && !VALID_CLAUDE_MODES.has(config.modeId)) {
      const validModesList = Array.from(VALID_CLAUDE_MODES).join(", ");
      throw new Error(
        `Invalid mode '${config.modeId}' for Claude provider. Valid modes: ${validModesList}`,
      );
    }

    this.currentMode = isPermissionMode(config.modeId) ? config.modeId : "default";
  }

  get id(): string | null {
    return this.claudeSessionId;
  }

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    if (this.cachedRuntimeInfo) {
      return { ...this.cachedRuntimeInfo };
    }
    const info: AgentRuntimeInfo = {
      provider: "claude",
      sessionId: this.claudeSessionId,
      model: this.lastOptionsModel,
      modeId: this.currentMode ?? null,
      ...(this.lastRuntimeModel
        ? {
            extra: {
              runtimeModel: this.lastRuntimeModel,
            },
          }
        : {}),
    };
    this.cachedRuntimeInfo = info;
    return { ...info };
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

    const processEvent = (event: AgentStreamEvent) => {
      if (settled) {
        return;
      }
      const eventTurnId = (event as { turnId?: string }).turnId;
      if (turnId && eventTurnId && eventTurnId !== turnId) {
        return;
      }
      if (event.type === "timeline") {
        timeline.push(event.item);
        if (event.item.type === "assistant_message") {
          if (!finalText) {
            finalText = event.item.text;
          } else if (event.item.text.startsWith(finalText)) {
            finalText = event.item.text;
          } else {
            finalText += event.item.text;
          }
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
        return;
      }
      if (event.type === "turn_canceled") {
        settled = true;
        resolveCompletion();
      }
    };

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

    this.cachedRuntimeInfo = {
      provider: "claude",
      sessionId: this.claudeSessionId,
      model: this.lastOptionsModel,
      modeId: this.currentMode ?? null,
    };

    if (!this.claudeSessionId) {
      throw new Error("Session ID not set after run completed");
    }

    return {
      sessionId: this.claudeSessionId,
      finalText,
      usage,
      timeline,
    };
  }

  async startTurn(
    prompt: AgentPromptInput,
    _options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
    if (this.closed) {
      throw new Error("Claude session is closed");
    }
    if (this.activeForegroundTurnId) {
      throw new Error("A foreground turn is already active");
    }

    const slashCommand = this.resolveSlashCommandInvocation(prompt);
    if (slashCommand?.commandName === REWIND_COMMAND_NAME) {
      const turnId = this.createTurnId("foreground");
      this.activeForegroundTurnId = turnId;
      this.transitionTurnState("foreground", "rewind command");
      void this.executeRewindTurn(turnId, slashCommand);
      return { turnId };
    }

    if (this.autonomousTurn) {
      this.completeAutonomousTurn();
    }

    const sdkMessage = this.toSdkUserMessage(prompt);
    this.lastForegroundPromptText = this.extractPromptText(prompt);
    const turnId = this.createTurnId("foreground");
    this.activeForegroundTurnId = turnId;
    this.foregroundHasVisibleActivity = false;
    this.transitionTurnState("foreground", "foreground turn started");
    this.clearRecentStderr();

    let cancelIssued = false;
    const requestCancel = () => {
      if (cancelIssued) {
        return;
      }
      cancelIssued = true;
      if (this.cancelCurrentTurn === requestCancel) {
        this.cancelCurrentTurn = null;
      }
      this.rejectAllPendingPermissions(new Error("Permission request aborted"));
      this.finishForegroundTurn({
        type: "turn_canceled",
        provider: "claude",
        reason: "Interrupted",
      });
      void this.interruptActiveTurn().catch((error) => {
        this.logger.warn({ err: error }, "Failed to interrupt during cancel");
      });
    };
    this.cancelCurrentTurn = requestCancel;

    this.notifySubscribers({ type: "turn_started", provider: "claude" });

    try {
      await this.ensureQuery();
      if (!this.input) {
        throw new Error("Claude session input stream not initialized");
      }
      this.startQueryPump();
      this.input.push(sdkMessage);
    } catch (error) {
      this.finishForegroundTurn(
        this.buildTurnFailedEvent(error instanceof Error ? error.message : "Claude stream failed"),
      );
    }

    return { turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  async interrupt(): Promise<void> {
    if (this.cancelCurrentTurn) {
      this.cancelCurrentTurn();
      return;
    }

    if (this.autonomousTurn) {
      this.flushPendingToolCalls();
      this.completeAutonomousTurn();
    }

    await this.interruptActiveTurn();
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    if (!this.historyPending || this.persistedHistory.length === 0) {
      return;
    }
    const history = this.persistedHistory;
    this.persistedHistory = [];
    this.historyPending = false;
    for (const item of history) {
      yield { type: "timeline", item, provider: "claude" };
    }
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return this.availableModes;
  }

  async getCurrentMode(): Promise<string | null> {
    return this.currentMode ?? null;
  }

  async setMode(modeId: string): Promise<void> {
    // Validate mode
    if (!VALID_CLAUDE_MODES.has(modeId)) {
      const validModesList = Array.from(VALID_CLAUDE_MODES).join(", ");
      throw new Error(
        `Invalid mode '${modeId}' for Claude provider. Valid modes: ${validModesList}`,
      );
    }

    const normalized = isPermissionMode(modeId) ? modeId : "default";
    const query = await this.ensureQuery();
    await query.setPermissionMode(normalized);
    this.currentMode = normalized;
  }

  async setModel(modelId: string | null): Promise<void> {
    const normalizedModelId =
      typeof modelId === "string" && modelId.trim().length > 0 ? modelId : null;
    const query = await this.ensureQuery();
    await query.setModel(normalizedModelId ?? undefined);
    this.config.model = normalizedModelId ?? undefined;
    this.lastOptionsModel = normalizedModelId ?? this.lastOptionsModel;
    this.lastRuntimeModel = null;
    this.cachedRuntimeInfo = null;
    // Model change affects persistence metadata, so invalidate cached handle.
    this.persistence = null;
  }

  async setThinkingOption(thinkingOptionId: string | null): Promise<void> {
    const normalizedThinkingOptionId =
      typeof thinkingOptionId === "string" && thinkingOptionId.trim().length > 0
        ? thinkingOptionId
        : null;

    if (!normalizedThinkingOptionId || normalizedThinkingOptionId === "default") {
      this.config.thinkingOptionId = undefined;
    } else if (isClaudeThinkingEffort(normalizedThinkingOptionId)) {
      this.config.thinkingOptionId = normalizedThinkingOptionId;
    } else {
      throw new Error(`Unknown thinking option: ${normalizedThinkingOptionId}`);
    }
    this.queryRestartNeeded = true;
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return Array.from(this.pendingPermissions.values()).map((entry) => entry.request);
  }

  async respondToPermission(requestId: string, response: AgentPermissionResponse): Promise<void> {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) {
      throw new Error(`No pending permission request with id '${requestId}'`);
    }
    this.pendingPermissions.delete(requestId);
    pending.cleanup?.();

    if (response.behavior === "allow") {
      if (pending.request.kind === "plan") {
        await this.setMode("acceptEdits");
        this.pushToolCall(
          mapClaudeCompletedToolCall({
            name: "plan_approval",
            callId: pending.request.id,
            input: pending.request.input ?? null,
            output: { approved: true },
          }),
        );
      }
      const result: PermissionResult = {
        behavior: "allow",
        updatedInput: response.updatedInput ?? pending.request.input ?? {},
        updatedPermissions: this.normalizePermissionUpdates(response.updatedPermissions),
      };
      pending.resolve(result);
    } else {
      if (pending.request.kind === "tool") {
        this.pushToolCall(
          mapClaudeFailedToolCall({
            name: pending.request.name,
            callId:
              (typeof pending.request.metadata?.toolUseId === "string"
                ? pending.request.metadata.toolUseId
                : null) ?? pending.request.id,
            input: pending.request.input ?? null,
            output: null,
            error: { message: response.message ?? "Permission denied" },
          }),
        );
      }
      const result: PermissionResult = {
        behavior: "deny",
        message: response.message ?? "Permission request denied",
        interrupt: response.interrupt,
      };
      pending.resolve(result);
    }

    this.pushEvent({
      type: "permission_resolved",
      provider: "claude",
      requestId,
      resolution: response,
    });
  }

  describePersistence(): AgentPersistenceHandle | null {
    if (this.persistence) {
      return this.persistence;
    }
    if (!this.claudeSessionId) {
      return null;
    }
    this.persistence = {
      provider: "claude",
      sessionId: this.claudeSessionId,
      nativeHandle: this.claudeSessionId,
      metadata: { ...this.config },
    };
    return this.persistence;
  }

  async close(): Promise<void> {
    this.logger.trace(
      {
        claudeSessionId: this.claudeSessionId,
        turnState: this.turnState,
        hasQuery: Boolean(this.query),
        hasInput: Boolean(this.input),
        hasActiveForegroundTurnId: Boolean(this.activeForegroundTurnId),
      },
      "Claude session close: start",
    );
    this.closed = true;
    this.rejectAllPendingPermissions(new Error("Claude session closed"));
    this.cancelCurrentTurn?.();
    this.subscribers.clear();
    this.activeForegroundTurnId = null;
    this.autonomousTurn = null;
    this.cancelCurrentTurn = null;
    this.turnState = "idle";
    this.sidechainTracker.clear();
    this.input?.end();
    this.query?.close?.();
    await this.awaitWithTimeout(this.query?.interrupt?.(), "close query interrupt");
    await this.awaitWithTimeout(this.query?.return?.(), "close query return");
    this.query = null;
    this.input = null;
    this.logger.trace(
      { claudeSessionId: this.claudeSessionId, turnState: this.turnState },
      "Claude session close: completed",
    );
  }

  async listCommands(): Promise<AgentSlashCommand[]> {
    const q = await this.ensureQuery();
    const commands = await q.supportedCommands();
    const commandMap = new Map<string, AgentSlashCommand>();
    for (const cmd of commands) {
      if (!commandMap.has(cmd.name)) {
        commandMap.set(cmd.name, {
          name: cmd.name,
          description: cmd.description,
          argumentHint: cmd.argumentHint,
        });
      }
    }
    if (!commandMap.has(REWIND_COMMAND_NAME)) {
      commandMap.set(REWIND_COMMAND_NAME, REWIND_COMMAND);
    }
    return Array.from(commandMap.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  private resolveSlashCommandInvocation(prompt: AgentPromptInput): SlashCommandInvocation | null {
    if (typeof prompt !== "string") {
      return null;
    }
    const parsed = this.parseSlashCommandInput(prompt);
    if (!parsed) {
      return null;
    }
    return parsed.commandName === REWIND_COMMAND_NAME ? parsed : null;
  }

  private parseSlashCommandInput(text: string): SlashCommandInvocation | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/") || trimmed.length <= 1) {
      return null;
    }
    const withoutPrefix = trimmed.slice(1);
    const firstWhitespaceIdx = withoutPrefix.search(/\s/);
    const commandName =
      firstWhitespaceIdx === -1 ? withoutPrefix : withoutPrefix.slice(0, firstWhitespaceIdx);
    if (!commandName || commandName.includes("/")) {
      return null;
    }
    const rawArgs =
      firstWhitespaceIdx === -1 ? "" : withoutPrefix.slice(firstWhitespaceIdx + 1).trim();
    return rawArgs.length > 0
      ? { commandName, args: rawArgs, rawInput: trimmed }
      : { commandName, rawInput: trimmed };
  }

  private buildRewindSuccessMessage(
    targetUserMessageId: string,
    rewindResult: { filesChanged?: string[]; insertions?: number; deletions?: number },
  ): string {
    const fileCount = Array.isArray(rewindResult.filesChanged)
      ? rewindResult.filesChanged.length
      : undefined;
    const stats: string[] = [];
    if (typeof fileCount === "number") {
      stats.push(`${fileCount} file${fileCount === 1 ? "" : "s"}`);
    }
    if (typeof rewindResult.insertions === "number") {
      stats.push(`${rewindResult.insertions} insertions`);
    }
    if (typeof rewindResult.deletions === "number") {
      stats.push(`${rewindResult.deletions} deletions`);
    }
    if (stats.length > 0) {
      return `Rewound tracked files to message ${targetUserMessageId} (${stats.join(", ")}).`;
    }
    return `Rewound tracked files to message ${targetUserMessageId}.`;
  }

  private async attemptRewind(args: string | undefined): Promise<{
    messageId: string | null;
    result?: { filesChanged?: string[]; insertions?: number; deletions?: number };
    error?: string;
  }> {
    if (typeof args === "string" && args.trim().length > 0) {
      const candidate = args.trim().split(/\s+/)[0] ?? "";
      if (!UUID_PATTERN.test(candidate)) {
        return {
          messageId: null,
          error: "Invalid message UUID. Usage: /rewind <user_message_uuid> or /rewind",
        };
      }
      const rewindResult = await this.rewindFilesOnce(candidate);
      if (rewindResult.canRewind) {
        return { messageId: candidate, result: rewindResult };
      }
      return {
        messageId: null,
        error: rewindResult.error ?? `No file checkpoint found for message ${candidate}.`,
      };
    }

    const candidates = this.getRewindCandidateUserMessageIds();
    if (candidates.length === 0) {
      return {
        messageId: null,
        error: "No prior user message available to rewind. Use /rewind <user_message_uuid>.",
      };
    }

    let lastError: string | undefined;
    for (const candidate of candidates) {
      try {
        const rewindResult = await this.rewindFilesOnce(candidate);
        if (rewindResult.canRewind) {
          return { messageId: candidate, result: rewindResult };
        }
        if (rewindResult.error) {
          lastError = rewindResult.error;
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : "Failed to rewind tracked files.";
      }
    }

    return {
      messageId: null,
      error: lastError ?? "No rewind checkpoints are currently available for this session.",
    };
  }

  private async rewindFilesOnce(messageId: string): Promise<{
    canRewind: boolean;
    error?: string;
    filesChanged?: string[];
    insertions?: number;
    deletions?: number;
  }> {
    try {
      const query = await this.ensureFreshQuery();
      return await query.rewindFiles(messageId, { dryRun: false });
    } catch (error) {
      // The Claude SDK transport can close after a rewind call.
      // If that happens, mark the query stale so a follow-up attempt uses a fresh query.
      this.queryRestartNeeded = true;
      throw error;
    }
  }

  private async ensureFreshQuery(): Promise<Query> {
    if (this.query) {
      this.queryRestartNeeded = true;
    }
    return this.ensureQuery();
  }

  private getRewindCandidateUserMessageIds(): string[] {
    const candidates: string[] = [];
    const pushUnique = (value: string | null | undefined) => {
      if (typeof value === "string" && value.length > 0 && !candidates.includes(value)) {
        candidates.push(value);
      }
    };

    const historyIds = this.readUserMessageIdsFromHistoryFile();
    for (let idx = historyIds.length - 1; idx >= 0; idx -= 1) {
      pushUnique(historyIds[idx]);
    }
    for (let idx = this.persistedHistory.length - 1; idx >= 0; idx -= 1) {
      const item = this.persistedHistory[idx];
      if (item?.type === "user_message") {
        pushUnique(item.messageId);
      }
    }
    for (let idx = this.userMessageIds.length - 1; idx >= 0; idx -= 1) {
      pushUnique(this.userMessageIds[idx]);
    }

    return candidates;
  }

  private readUserMessageIdsFromHistoryFile(): string[] {
    if (!this.claudeSessionId) {
      return [];
    }
    const historyPath = this.resolveHistoryPath(this.claudeSessionId);
    if (!historyPath || !fs.existsSync(historyPath)) {
      return [];
    }
    try {
      const ids: string[] = [];
      const content = fs.readFileSync(historyPath, "utf8");
      for (const line of content.split(/\n+/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const entry = JSON.parse(trimmed);
          if (entry?.type === "user" && typeof entry.uuid === "string") {
            ids.push(entry.uuid);
          }
        } catch {
          // ignore malformed lines
        }
      }
      return ids;
    } catch {
      return [];
    }
  }

  private rememberUserMessageId(messageId: string | null | undefined): void {
    if (typeof messageId !== "string" || messageId.length === 0) {
      return;
    }
    const last = this.userMessageIds[this.userMessageIds.length - 1];
    if (last === messageId) {
      return;
    }
    this.userMessageIds.push(messageId);
  }

  private async ensureQuery(): Promise<Query> {
    if (this.query && !this.queryRestartNeeded) {
      return this.query;
    }

    if (this.queryRestartNeeded && this.query) {
      const oldQuery = this.query;
      const oldInput = this.input;
      // Null out query/input BEFORE awaiting the old iterator's return so the
      // old pump sees this.query !== activeQuery and skips failActiveTurns.
      this.query = null;
      this.input = null;
      this.queryPumpPromise = null;
      this.queryRestartNeeded = false;
      // Reset session identity for explicit restarts so the new query starts
      // a fresh session rather than resuming the previous one.
      this.claudeSessionId = null;
      oldInput?.end();
      oldQuery.close?.();
      try {
        await oldQuery.return?.();
      } catch {
        /* ignore */
      }
    }

    // When the pump died unexpectedly (query became null, e.g. after a session
    // ID overwrite error), preserve claudeSessionId so buildOptions() passes
    // resume: sessionId and the new query auto-resumes the previous session.
    // For explicit restarts above, claudeSessionId was already cleared.
    this.persistence = null;

    const input = createAsyncMessageInput<SDKUserMessage>();
    const options = this.buildOptions();
    this.logger.debug({ options: summarizeClaudeOptionsForLog(options) }, "claude query");
    this.input = input;
    this.query = this.queryFactory({ prompt: input.iterable, options });
    // Do not kick off background control-plane queries here. Methods like
    // supportedCommands()/setPermissionMode() may execute immediately after
    // ensureQuery() (for listCommands()/setMode()), and sharing the same query
    // control plane can cause those calls to wait behind supportedModels().
    return this.query;
  }

  private async awaitWithTimeout(
    promise: Promise<unknown> | undefined,
    label: string,
  ): Promise<void> {
    if (!promise) {
      this.logger.trace({ label }, "Claude query operation skipped (no promise)");
      return;
    }
    const startedAt = Date.now();
    this.logger.trace({ label }, "Claude query operation wait start");
    try {
      await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("timeout")), 3_000);
        }),
      ]);
      this.logger.trace(
        { label, durationMs: Date.now() - startedAt },
        "Claude query operation settled",
      );
    } catch (error) {
      this.logger.warn({ err: error, label }, "Claude query operation did not settle cleanly");
    }
  }

  private buildOptions(): ClaudeOptions {
    const thinkingOptionId =
      this.config.thinkingOptionId && this.config.thinkingOptionId !== "default"
        ? this.config.thinkingOptionId
        : undefined;
    let thinking: ClaudeOptions["thinking"];
    let effort: ClaudeOptions["effort"];
    if (thinkingOptionId && isClaudeThinkingEffort(thinkingOptionId)) {
      thinking = { type: "adaptive" };
      effort = thinkingOptionId;
    }

    const appendedSystemPrompt = [
      getOrchestratorModeInstructions(),
      this.config.systemPrompt?.trim(),
    ]
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      .join("\n\n");

    const claudeBinary = findExecutable("claude");
    this.logger.debug(
      {
        claudeBinary,
        pathEnvKey:
          process.env["Path"] !== undefined
            ? "Path"
            : process.env["PATH"] !== undefined
              ? "PATH"
              : null,
        pathIncludesClaudeLocalBin:
          (process.env["Path"] ?? process.env["PATH"] ?? "")
            .toLowerCase()
            .includes("\\.local\\bin"),
      },
      "Resolved Claude executable",
    );
    const base: ClaudeOptions = {
      cwd: this.config.cwd,
      includePartialMessages: true,
      permissionMode: this.currentMode,
      // Dynamic mode switching can recreate the underlying Claude query. Keep the
      // bypass launch capability available so later setPermissionMode("bypassPermissions")
      // calls do not fail after a model/thinking/rewind-driven restart.
      allowDangerouslySkipPermissions: true,
      agents: this.defaults?.agents,
      canUseTool: this.handlePermissionRequest,
      ...(claudeBinary ? { pathToClaudeCodeExecutable: claudeBinary } : {}),
      // Use Claude Code preset system prompt and load CLAUDE.md files
      // Append provider-agnostic system prompt and orchestrator instructions for agents.
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: appendedSystemPrompt,
      },
      settingSources: CLAUDE_SETTING_SOURCES,
      stderr: (data: string) => {
        this.captureStderr(data);
        this.logger.error({ stderr: data.trim() }, "Claude Agent SDK stderr");
      },
      env: {
        ...process.env,
        // Increase MCP timeouts for long-running tool calls (10 minutes)
        MCP_TIMEOUT: "600000",
        MCP_TOOL_TIMEOUT: "600000",
        ...(this.launchEnv ?? {}),
      },
      // Required for provider-level /rewind support.
      enableFileCheckpointing: true,
      // If we have a session ID from a previous query (e.g., after interrupt),
      // resume that session to continue the conversation history.
      ...(this.claudeSessionId ? { resume: this.claudeSessionId } : {}),
      ...(thinking ? { thinking } : {}),
      ...(effort ? { effort } : {}),
      ...this.config.extra?.claude,
    };

    if (this.config.mcpServers) {
      base.mcpServers = this.normalizeMcpServers(this.config.mcpServers);
    }

    if (this.config.model) {
      base.model = this.config.model;
    }
    this.lastOptionsModel = base.model ?? null;
    if (this.claudeSessionId) {
      base.resume = this.claudeSessionId;
    }
    return this.applyRuntimeSettings(base);
  }

  private applyRuntimeSettings(options: ClaudeOptions): ClaudeOptions {
    return applyRuntimeSettingsToClaudeOptions(options, this.runtimeSettings, this.launchEnv);
  }

  private normalizeMcpServers(
    servers: Record<string, McpServerConfig>,
  ): Record<string, ClaudeSdkMcpServerConfig> {
    const result: Record<string, ClaudeSdkMcpServerConfig> = {};
    for (const [name, config] of Object.entries(servers)) {
      result[name] = toClaudeSdkMcpConfig(config);
    }
    return result;
  }

  private toSdkUserMessage(prompt: AgentPromptInput): SDKUserMessage {
    const content: Array<
      | { type: "text"; text: string }
      | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
    > = [];
    if (Array.isArray(prompt)) {
      for (const chunk of prompt) {
        if (chunk.type === "text") {
          content.push({ type: "text", text: chunk.text });
        } else if (chunk.type === "image") {
          content.push({
            type: "image",
            source: {
              type: "base64",
              media_type: chunk.mimeType,
              data: chunk.data,
            },
          });
        }
      }
    } else {
      content.push({ type: "text", text: prompt });
    }

    const messageId = randomUUID();
    this.rememberUserMessageId(messageId);

    return {
      type: "user",
      message: {
        role: "user",
        content,
      },
      parent_tool_use_id: null,
      uuid: messageId,
      session_id: this.claudeSessionId ?? "",
    };
  }

  private transitionTurnState(next: TurnState, reason: string): void {
    if (this.turnState === next) {
      return;
    }
    this.logger.debug({ from: this.turnState, to: next, reason }, "Claude turn state transition");
    this.turnState = next;
  }

  private syncTurnState(reason: string): void {
    if (this.activeForegroundTurnId) {
      this.transitionTurnState("foreground", reason);
      return;
    }
    if (this.autonomousTurn) {
      this.transitionTurnState("autonomous", reason);
      return;
    }
    this.transitionTurnState("idle", reason);
  }

  private isAbortError(message: SDKMessage): boolean {
    const errors =
      "errors" in message && Array.isArray(message.errors) ? message.errors : [];
    return errors.some((e: string) => /\baborted\b/i.test(e));
  }

  private buildTurnFailedEvent(
    errorMessage: string,
  ): Extract<AgentStreamEvent, { type: "turn_failed" }> {
    const normalized = errorMessage.trim() || "Claude run failed";
    const exitCodeMatch = normalized.match(/\bcode\s+(\d+)\b/i);
    const code = exitCodeMatch ? exitCodeMatch[1] : undefined;
    const diagnostic = this.getRecentStderrDiagnostic();
    return {
      type: "turn_failed",
      provider: "claude",
      error: normalized,
      ...(code ? { code } : {}),
      ...(diagnostic ? { diagnostic } : {}),
    };
  }

  private captureStderr(data: string): void {
    const text = data.trim();
    if (!text) {
      return;
    }
    const combined = this.recentStderr ? `${this.recentStderr}\n${text}` : text;
    this.recentStderr = combined.slice(-MAX_RECENT_STDERR_CHARS);
  }

  private clearRecentStderr(): void {
    this.recentStderr = "";
  }

  private getRecentStderrDiagnostic(): string | undefined {
    return this.recentStderr.trim() || undefined;
  }

  private async awaitRecentStderrAfterProcessExit(error: unknown): Promise<void> {
    if (this.getRecentStderrDiagnostic()) {
      return;
    }
    const message =
      typeof error === "string" ? error : error instanceof Error ? error.message : "";
    if (!/\bprocess exited with code\b/i.test(message) && !/\bterminated by signal\b/i.test(message)) {
      return;
    }

    const startedAt = Date.now();
    while (!this.closed && !this.getRecentStderrDiagnostic()) {
      if (Date.now() - startedAt >= STDERR_FLUSH_WAIT_MS) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, STDERR_FLUSH_POLL_INTERVAL_MS));
    }
  }

  private createTurnId(owner: "foreground" | "autonomous"): string {
    return `${owner}-turn-${this.nextTurnOrdinal++}`;
  }

  private isTerminalTurnEvent(event: AgentStreamEvent): boolean {
    return (
      event.type === "turn_completed" ||
      event.type === "turn_failed" ||
      event.type === "turn_canceled"
    );
  }

  private extractPromptText(prompt: AgentPromptInput): string | null {
    if (typeof prompt === "string") {
      return prompt;
    }
    const textParts = prompt
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text);
    return textParts.length > 0 ? textParts.join("\n") : null;
  }

  private async executeRewindTurn(
    _turnId: string,
    invocation: SlashCommandInvocation,
  ): Promise<void> {
    this.notifySubscribers({ type: "turn_started", provider: "claude" });
    try {
      const rewindAttempt = await this.attemptRewind(invocation.args);
      if (!rewindAttempt.messageId || !rewindAttempt.result) {
        this.finishForegroundTurn({
          type: "turn_failed",
          provider: "claude",
          error:
            rewindAttempt.error ??
            "No prior user message available to rewind. Use /rewind <user_message_uuid>.",
        });
        return;
      }
      this.notifySubscribers({
        type: "timeline",
        provider: "claude",
        item: {
          type: "assistant_message",
          text: this.buildRewindSuccessMessage(rewindAttempt.messageId, rewindAttempt.result),
        },
      });
      this.finishForegroundTurn({ type: "turn_completed", provider: "claude" });
    } catch (error) {
      this.finishForegroundTurn({
        type: "turn_failed",
        provider: "claude",
        error: error instanceof Error ? error.message : "Failed to rewind tracked files",
      });
    }
  }

  private shouldRecoverInterruptedQueryAbort(
    error: unknown,
    consecutiveRecoveries: number,
  ): boolean {
    if (consecutiveRecoveries >= 3) {
      return false;
    }
    const message =
      typeof error === "string"
        ? error
        : error instanceof Error
          ? `${error.message}\n${error.stack ?? ""}`
          : JSON.stringify(error);
    return message.toLowerCase().includes("request was aborted");
  }

  private finishForegroundTurn(
    event: Extract<AgentStreamEvent, { type: "turn_completed" | "turn_failed" | "turn_canceled" }>,
  ): void {
    if (event.type === "turn_failed" || event.type === "turn_canceled") {
      this.flushPendingToolCalls();
    }
    this.notifySubscribers(event);
    this.activeForegroundTurnId = null;
    this.lastForegroundPromptText = null;
    this.cancelCurrentTurn = null;
    this.syncTurnState("foreground turn terminal");
  }

  private dispatchEvents(events: AgentStreamEvent[]): void {
    let terminalSeen = false;
    for (const event of events) {
      this.notifySubscribers(event);
      terminalSeen ||= this.isTerminalTurnEvent(event);
    }

    if (terminalSeen) {
      if (this.activeForegroundTurnId) {
        this.activeForegroundTurnId = null;
        this.lastForegroundPromptText = null;
        this.cancelCurrentTurn = null;
        this.syncTurnState("foreground turn terminal");
      } else if (this.autonomousTurn) {
        this.autonomousTurn = null;
        this.syncTurnState("autonomous turn terminal");
      }
    }
  }

  private startAutonomousTurn(): void {
    if (this.autonomousTurn) {
      return;
    }
    this.autonomousTurn = {
      id: this.createTurnId("autonomous"),
    };
    this.notifySubscribers({ type: "turn_started", provider: "claude" });
    this.syncTurnState("autonomous turn started");
  }

  private completeAutonomousTurn(): void {
    if (!this.autonomousTurn) {
      return;
    }
    this.notifySubscribers({ type: "turn_completed", provider: "claude" });
    this.autonomousTurn = null;
    this.syncTurnState("autonomous turn completed");
  }

  private failActiveTurns(errorMessage: string): void {
    const failure = this.buildTurnFailedEvent(errorMessage);
    this.flushPendingToolCalls();
    if (this.activeForegroundTurnId) {
      this.finishForegroundTurn(failure);
      return;
    }
    if (this.autonomousTurn) {
      this.dispatchEvents([failure]);
    }
  }

  private startQueryPump(): void {
    if (this.closed || this.queryPumpPromise) {
      return;
    }

    const pump = this.runQueryPump().catch((error) => {
      this.logger.trace({ err: error }, "Claude query pump exited unexpectedly");
    });

    this.queryPumpPromise = pump;
    pump.finally(() => {
      if (this.queryPumpPromise === pump) {
        this.queryPumpPromise = null;
      }
    });
  }

  private async runQueryPump(): Promise<void> {
    let activeQuery: Query;
    try {
      activeQuery = await this.ensureQuery();
    } catch (error) {
      this.logger.trace({ err: error }, "Failed to initialize Claude query pump");
      this.failActiveTurns(error instanceof Error ? error.message : "Claude stream failed");
      return;
    }

    let consecutiveInterruptAbortRecoveries = 0;
    try {
      while (!this.closed && this.query === activeQuery) {
        try {
          for await (const message of activeQuery) {
            this.logger.trace(
              {
                claudeSessionId: this.claudeSessionId,
                messageType: message.type,
                messageSubtype: "subtype" in message ? message.subtype : undefined,
                messageUuid: "uuid" in message ? message.uuid : undefined,
              },
              "Claude query pump: raw SDK message",
            );
            consecutiveInterruptAbortRecoveries = 0;
            if (await this.handleMissingResumedConversation(message, activeQuery)) {
              return;
            }
            this.routeSdkMessageFromPump(message);
          }
          if (!this.closed && this.query === activeQuery) {
            this.failActiveTurns("Claude stream ended before terminal result");
          }
          return;
        } catch (error) {
          if (
            !this.closed &&
            this.query === activeQuery &&
            this.shouldRecoverInterruptedQueryAbort(error, consecutiveInterruptAbortRecoveries)
          ) {
            consecutiveInterruptAbortRecoveries += 1;
            this.logger.debug(
              { recoveries: consecutiveInterruptAbortRecoveries },
              "Recovering Claude query pump after interrupt abort",
            );
            continue;
          }
          if (!this.closed && this.query === activeQuery) {
            await this.awaitRecentStderrAfterProcessExit(error);
            this.failActiveTurns(error instanceof Error ? error.message : "Claude stream failed");
          }
          return;
        }
      }
    } finally {
      if (this.query === activeQuery) {
        this.query = null;
        this.input = null;
      }
    }
  }

  private routeSdkMessageFromPump(message: SDKMessage): void {
    // Suppress stale results from interrupted requests. The cancel path already
    // emitted the terminal event; this result is leftover from the killed API
    // request. Consume the flag on ANY result so it doesn't linger.
    if (message.type === "result" && this.pendingInterruptAbort) {
      this.pendingInterruptAbort = false;
      if (message.subtype !== "success") {
        this.logger.debug("Suppressing stale non-success result from interrupted request");
        return;
      }
    }
    if (
      message.type === "result" &&
      message.subtype !== "success" &&
      this.isAbortError(message)
    ) {
      this.logger.debug("Suppressing abort result by content");
      return;
    }

    const isForeground = Boolean(this.activeForegroundTurnId);
    const assistantishMessage =
      message.type === "assistant" ||
      message.type === "stream_event" ||
      message.type === "tool_progress" ||
      (message.type === "system" && message.subtype === "task_notification");

    if (!isForeground && assistantishMessage) {
      this.startAutonomousTurn();
    }
    if (!isForeground && !this.autonomousTurn && message.type === "result") {
      return;
    }

    const turnId = this.activeForegroundTurnId ?? this.autonomousTurn?.id ?? null;
    const identifiers = readEventIdentifiers(message);

    this.logger.trace(
      {
        claudeSessionId: this.claudeSessionId,
        messageType: message.type,
        turnId,
      },
      "Claude query pump: SDK message",
    );

    const messageEvents = this.translateMessageToEvents(message, {
      suppressAssistantText: true,
      suppressReasoning: true,
    });
    const assistantTimelineEvents = this.timelineAssembler
      .consume({
        message,
        runId: turnId,
        messageIdHint: identifiers.messageId,
      })
      .map(
        (item) =>
          ({
            type: "timeline",
            item,
            provider: "claude",
          }) satisfies AgentStreamEvent,
      );

    // User message dedup: suppress echoed user messages that match the foreground prompt
    const filteredMessageEvents = messageEvents.filter((event) => {
      if (
        event.type === "timeline" &&
        event.item.type === "user_message" &&
        this.activeForegroundTurnId &&
        this.lastForegroundPromptText
      ) {
        if (event.item.text.trim() === this.lastForegroundPromptText.trim()) {
          return false;
        }
      }
      return true;
    });

    const events = [...filteredMessageEvents, ...assistantTimelineEvents];

    if (events.length === 0) {
      return;
    }

    if (
      this.pendingInterruptAbort &&
      message.type === "result" &&
      events.some((event) => event.type === "turn_completed" || event.type === "turn_failed") &&
      (!this.activeForegroundTurnId || !this.foregroundHasVisibleActivity)
    ) {
      this.pendingInterruptAbort = false;
      this.logger.debug("Suppressing stale Claude interrupt terminal result");
      return;
    }
    if (
      this.activeForegroundTurnId &&
      events.some(
        (event) =>
          event.type === "timeline" ||
          event.type === "permission_requested" ||
          event.type === "permission_resolved",
      )
    ) {
      this.foregroundHasVisibleActivity = true;
    }

    this.dispatchEvents(events);
  }

  private async handleMissingResumedConversation(
    message: SDKMessage,
    query: Query,
  ): Promise<boolean> {
    const staleResumeError = this.readMissingResumedConversationError(message);
    if (!staleResumeError) {
      return false;
    }

    this.logger.warn(
      {
        claudeSessionId: this.claudeSessionId,
        error: staleResumeError,
      },
      "Claude resumed session no longer exists; invalidating persisted session",
    );

    this.failActiveTurns(staleResumeError);
    this.input?.end();
    await this.awaitWithTimeout(
      query.return?.(),
      "query pump return on missing resumed conversation",
    );
    if (this.query === query) {
      this.query = null;
      this.input = null;
    }
    this.claudeSessionId = null;
    this.persistence = null;
    this.persistedHistory = [];
    this.historyPending = false;
    this.cachedRuntimeInfo = null;
    this.queryRestartNeeded = false;
    this.autonomousTurn = null;
    this.activeForegroundTurnId = null;
    this.syncTurnState("missing resumed conversation");
    return true;
  }

  private async interruptActiveTurn(): Promise<void> {
    const queryToInterrupt = this.query;
    if (!queryToInterrupt || typeof queryToInterrupt.interrupt !== "function") {
      this.logger.trace("interruptActiveTurn: no query to interrupt");
      return;
    }
    this.pendingInterruptAbort = true;
    try {
      await this.awaitWithTimeout(
        queryToInterrupt.interrupt(),
        "interruptActiveTurn query.interrupt()",
      );
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to interrupt active turn");
    }
  }

  private translateMessageToEvents(
    message: SDKMessage,
    options?: {
      suppressAssistantText?: boolean;
      suppressReasoning?: boolean;
    },
  ): AgentStreamEvent[] {
    const parentToolUseId =
      "parent_tool_use_id" in message
        ? (message as { parent_tool_use_id: string | null }).parent_tool_use_id
        : null;
    if (parentToolUseId) {
      return this.sidechainTracker.handleMessage(message, parentToolUseId);
    }

    const events: AgentStreamEvent[] = [];
    const fallbackThreadSessionId = this.captureSessionIdFromMessage(message);
    if (fallbackThreadSessionId) {
      events.push({
        type: "thread_started",
        provider: "claude",
        sessionId: fallbackThreadSessionId,
      });
    }

    switch (message.type) {
      case "system":
        if (message.subtype === "init") {
          const threadSessionId = this.handleSystemMessage(message);
          if (threadSessionId) {
            events.push({
              type: "thread_started",
              provider: "claude",
              sessionId: threadSessionId,
            });
          }
        } else if (message.subtype === "status") {
          const status = (message as { status?: string }).status;
          if (status === "compacting") {
            this.compacting = true;
            events.push({
              type: "timeline",
              item: { type: "compaction", status: "loading" },
              provider: "claude",
            });
          }
        } else if (message.subtype === "compact_boundary") {
          const compactMetadata = readCompactionMetadata(message as Record<string, unknown>);
          events.push({
            type: "timeline",
            item: {
              type: "compaction",
              status: "completed",
              trigger: compactMetadata?.trigger === "manual" ? "manual" : "auto",
              preTokens: compactMetadata?.preTokens,
            },
            provider: "claude",
          });
        } else if (message.subtype === "task_notification") {
          const taskNotificationItem = mapTaskNotificationSystemRecordToToolCall(message);
          if (taskNotificationItem) {
            events.push({
              type: "timeline",
              item: taskNotificationItem,
              provider: "claude",
            });
          }
        }
        break;
      case "user": {
        if (isSyntheticUserEntry(message)) {
          break;
        }
        if (this.compacting) {
          this.compacting = false;
          break;
        }
        const messageId =
          typeof message.uuid === "string" && message.uuid.length > 0 ? message.uuid : undefined;
        this.rememberUserMessageId(messageId);
        const content = message.message?.content;
        const taskNotificationItem = mapTaskNotificationUserContentToToolCall({
          content,
          messageId,
        });
        if (taskNotificationItem) {
          events.push({
            type: "timeline",
            item: taskNotificationItem,
            provider: "claude",
          });
          break;
        }
        if (typeof content === "string" && content.length > 0) {
          if (!isClaudeTranscriptNoiseText(content)) {
            events.push({
              type: "timeline",
              item: {
                type: "user_message",
                text: content,
                ...(messageId ? { messageId } : {}),
              },
              provider: "claude",
            });
          }
        } else if (Array.isArray(content)) {
          const timelineItems = this.mapBlocksToTimeline(content, {
            textMessageType: "user_message",
          });
          for (const item of timelineItems) {
            if (item.type === "user_message" && messageId && !item.messageId) {
              events.push({
                type: "timeline",
                item: { ...item, messageId },
                provider: "claude",
              });
              continue;
            }
            events.push({ type: "timeline", item, provider: "claude" });
          }
        }
        break;
      }
      case "assistant": {
        const timelineItems = this.mapBlocksToTimeline(message.message.content, {
          suppressAssistantText: options?.suppressAssistantText ?? false,
          suppressReasoning: options?.suppressReasoning ?? false,
        });
        for (const item of timelineItems) {
          events.push({ type: "timeline", item, provider: "claude" });
        }
        break;
      }
      case "stream_event": {
        const timelineItems = this.mapPartialEvent(message.event, {
          suppressAssistantText: options?.suppressAssistantText ?? false,
          suppressReasoning: options?.suppressReasoning ?? false,
        });
        for (const item of timelineItems) {
          events.push({ type: "timeline", item, provider: "claude" });
        }
        break;
      }
      case "result": {
        const usage = this.convertUsage(message);
        if (message.subtype === "success") {
          events.push({ type: "turn_completed", provider: "claude", usage });
        } else {
          const errorMessage =
            "errors" in message && Array.isArray(message.errors) && message.errors.length > 0
              ? message.errors.join("\n")
              : "Claude run failed";
          events.push(this.buildTurnFailedEvent(errorMessage));
        }
        break;
      }
      default:
        break;
    }

    return events;
  }

  private captureSessionIdFromMessage(message: SDKMessage): string | null {
    const msg = message as unknown as {
      session_id?: unknown;
      sessionId?: unknown;
      session?: { id?: unknown } | null;
    };
    const sessionIdRaw =
      typeof msg.session_id === "string"
        ? msg.session_id
        : typeof msg.sessionId === "string"
          ? msg.sessionId
          : typeof msg.session?.id === "string"
            ? msg.session.id
            : "";
    const sessionId = sessionIdRaw.trim();
    if (!sessionId) {
      return null;
    }
    if (this.claudeSessionId === null) {
      this.claudeSessionId = sessionId;
      this.persistence = null;
      return sessionId;
    }
    if (this.claudeSessionId === sessionId) {
      return null;
    }
    // Session ID changed mid-stream (e.g. a hook caused Claude to restart
    // with a new session). Accept the new ID and continue — the turn should
    // not be failed just because the underlying subprocess cycled.
    this.logger.warn(
      { existingSessionId: this.claudeSessionId, newSessionId: sessionId },
      "Claude session ID changed in message; accepting new session",
    );
    this.claudeSessionId = sessionId;
    this.persistence = null;
    return sessionId;
  }

  private handleSystemMessage(message: SDKSystemMessage): string | null {
    if (message.subtype !== "init") {
      return null;
    }

    const msg = message as unknown as {
      session_id?: unknown;
      sessionId?: unknown;
      session?: { id?: unknown } | null;
    };
    const newSessionIdRaw =
      typeof msg.session_id === "string"
        ? msg.session_id
        : typeof msg.sessionId === "string"
          ? msg.sessionId
          : typeof msg.session?.id === "string"
            ? msg.session.id
            : "";
    const newSessionId = newSessionIdRaw.trim();
    if (!newSessionId) {
      return null;
    }
    const existingSessionId = this.claudeSessionId;
    let threadStartedSessionId: string | null = null;

    if (existingSessionId === null) {
      this.claudeSessionId = newSessionId;
      threadStartedSessionId = newSessionId;
      this.logger.debug({ sessionId: newSessionId }, "Claude session ID set for the first time");
    } else if (existingSessionId === newSessionId) {
      this.logger.debug({ sessionId: newSessionId }, "Claude session ID unchanged (same value)");
    } else {
      // Session ID changed in an init message (e.g. a hook restarted Claude
      // with a new session mid-turn). Accept the new ID and continue.
      this.logger.warn(
        { existingSessionId, newSessionId },
        "Claude session ID changed in init message; accepting new session",
      );
      this.claudeSessionId = newSessionId;
      threadStartedSessionId = newSessionId;
    }
    this.availableModes = DEFAULT_MODES;
    this.currentMode = message.permissionMode;
    this.persistence = null;
    if (message.model) {
      const normalizedRuntimeModel = normalizeClaudeRuntimeModelId(message.model);
      this.logger.debug(
        { runtimeModel: message.model, normalizedRuntimeModel },
        "Captured runtime model from SDK init",
      );
      if (normalizedRuntimeModel) {
        this.lastOptionsModel = normalizedRuntimeModel;
      } else if (!this.lastOptionsModel) {
        this.lastOptionsModel = this.config.model ?? null;
      }
      this.lastRuntimeModel = message.model;
      this.cachedRuntimeInfo = null;
    }
    return threadStartedSessionId;
  }

  private readMissingResumedConversationError(message: SDKMessage): string | null {
    if (message.type !== "result" || message.subtype !== "error_during_execution") {
      return null;
    }
    if (!this.claudeSessionId) {
      return null;
    }
    const errors = "errors" in message && Array.isArray(message.errors) ? message.errors : [];
    for (const entry of errors) {
      if (typeof entry !== "string") {
        continue;
      }
      const match = entry.match(/^No conversation found with session ID:\s*(.+)$/);
      if (!match) {
        continue;
      }
      if (match[1]?.trim() === this.claudeSessionId) {
        return entry.trim();
      }
    }
    return null;
  }

  private convertUsage(message: SDKResultMessage): AgentUsage | undefined {
    if (!message.usage) {
      return undefined;
    }
    return {
      inputTokens: message.usage.input_tokens,
      cachedInputTokens: message.usage.cache_read_input_tokens,
      outputTokens: message.usage.output_tokens,
      totalCostUsd: message.total_cost_usd,
    };
  }

  private handlePermissionRequest: CanUseTool = async (
    toolName,
    input,
    options,
  ): Promise<PermissionResult> => {
    const requestId = `permission-${randomUUID()}`;
    const kind = resolvePermissionKind(toolName, input);
    const metadata: AgentMetadata = {};
    if (options.toolUseID) {
      metadata.toolUseId = options.toolUseID;
    }
    if (toolName === "ExitPlanMode" && typeof input.plan === "string") {
      metadata.planText = input.plan;
    }
    const toolDetail =
      kind === "tool"
        ? mapClaudeRunningToolCall({
            name: toolName,
            callId: options.toolUseID ?? requestId,
            input,
            output: null,
          })?.detail
        : undefined;

    const request: AgentPermissionRequest = {
      id: requestId,
      provider: "claude",
      name: toolName,
      kind,
      input,
      detail: toolDetail,
      suggestions: options.suggestions?.map((suggestion) => ({ ...suggestion })),
      metadata: Object.keys(metadata).length ? metadata : undefined,
    };

    this.pushEvent({ type: "permission_requested", provider: "claude", request });

    return await new Promise<PermissionResult>((resolve, reject) => {
      const cleanupFns: Array<() => void> = [];
      const cleanup = () => {
        while (cleanupFns.length) {
          const fn = cleanupFns.pop();
          try {
            fn?.();
          } catch {
            // ignore cleanup errors
          }
        }
      };

      const abortHandler = () => {
        this.pendingPermissions.delete(requestId);
        cleanup();
        reject(new Error("Permission request aborted"));
      };

      if (options?.signal) {
        if (options.signal.aborted) {
          abortHandler();
          return;
        }
        options.signal.addEventListener("abort", abortHandler, { once: true });
        cleanupFns.push(() => options.signal?.removeEventListener("abort", abortHandler));
      }

      this.pendingPermissions.set(requestId, {
        request,
        resolve,
        reject,
        cleanup,
      });
    });
  };

  private enqueueTimeline(item: AgentTimelineItem) {
    this.pushEvent({ type: "timeline", item, provider: "claude" });
  }

  private flushPendingToolCalls() {
    for (const [id, entry] of this.toolUseCache) {
      if (entry.started) {
        this.pushToolCall(
          mapClaudeCanceledToolCall({
            name: entry.name,
            callId: id,
            input: entry.input ?? null,
            output: null,
          }),
        );
      }
    }
    this.toolUseCache.clear();
    this.sidechainTracker.clear();
  }

  private pushToolCall(
    item: Extract<AgentTimelineItem, { type: "tool_call" }> | null,
    target?: AgentTimelineItem[],
  ) {
    if (!item) {
      return;
    }
    if (target) {
      target.push(item);
      return;
    }
    this.enqueueTimeline(item);
  }

  private pushEvent(event: AgentStreamEvent) {
    this.notifySubscribers(event);
  }

  private notifySubscribers(event: AgentStreamEvent): void {
    const turnId = this.activeForegroundTurnId ?? this.autonomousTurn?.id;
    const tagged = turnId ? { ...event, turnId } : event;
    for (const callback of this.subscribers) {
      try {
        callback(tagged);
      } catch (error) {
        this.logger.warn({ err: error }, "Subscriber callback threw");
      }
    }
  }

  private normalizePermissionUpdates(
    updates?: AgentPermissionUpdate[],
  ): PermissionUpdate[] | undefined {
    if (!updates || updates.length === 0) {
      return undefined;
    }
    const normalized = updates.filter(isPermissionUpdate);
    return normalized.length > 0 ? normalized : undefined;
  }

  private rejectAllPendingPermissions(error: Error) {
    for (const [id, pending] of this.pendingPermissions) {
      pending.cleanup?.();
      pending.reject(error);
      this.pendingPermissions.delete(id);
    }
  }

  private loadPersistedHistory(sessionId: string): void {
    try {
      const historyPath = this.resolveHistoryPath(sessionId);
      if (!historyPath || !fs.existsSync(historyPath)) {
        return;
      }
      this.ingestPersistedHistory(fs.readFileSync(historyPath, "utf8"));
    } catch (error) {
      // ignore history load failures
    }
  }

  private ingestPersistedHistory(content: string): void {
    if (!content) {
      return;
    }

    const timeline: AgentTimelineItem[] = [];
    for (const line of content.split(/\r?\n/)) {
      this.ingestPersistedHistoryLine(line, timeline);
    }

    if (timeline.length > 0) {
      this.persistedHistory = [...this.persistedHistory, ...timeline];
      this.historyPending = true;
    }
  }

  private ingestPersistedHistoryLine(line: string, timeline: AgentTimelineItem[]): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }

    if (entry.isSidechain) {
      return;
    }
    if (entry.type === "user" && typeof entry.uuid === "string") {
      this.rememberUserMessageId(entry.uuid);
    }

    const items = this.convertHistoryEntry(entry);
    if (items.length > 0) {
      timeline.push(...items);
    }
  }

  private resolveHistoryPath(sessionId: string): string | null {
    const cwd = this.config.cwd;
    if (!cwd) return null;
    // Match Claude CLI's path sanitization: replace slashes, dots, and underscores with dashes
    const sanitized = cwd.replace(/[\\/\.]/g, "-").replace(/_/g, "-");
    const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
    const dir = path.join(configDir, "projects", sanitized);
    return path.join(dir, `${sessionId}.jsonl`);
  }

  private convertHistoryEntry(entry: any): AgentTimelineItem[] {
    return convertClaudeHistoryEntry(entry, (content) => this.mapBlocksToTimeline(content));
  }

  // Maps Claude content blocks into AgentTimelineItems.
  //
  // textMessageType controls what type text blocks emit:
  //   - "assistant_message" (default): one item per text block (streaming granularity)
  //   - "user_message": coalesces all text blocks into a single user_message
  //     (matches extractUserMessageText semantics: trim each block, join with "\n\n")
  //
  // suppressAssistantText only applies when textMessageType is "assistant_message" — user text
  // must never be suppressed since the TimelineAssembler only handles assistant text.
  //
  // NOTE: convertClaudeHistoryEntry uses extractUserMessageText directly instead of this function
  // for user entries. Both paths must produce equivalent user_message items.
  private mapBlocksToTimeline(
    content: string | ClaudeContentChunk[],
    options?: {
      textMessageType?: "assistant_message" | "user_message";
      suppressAssistantText?: boolean;
      suppressReasoning?: boolean;
    },
  ): AgentTimelineItem[] {
    const textMessageType = options?.textMessageType ?? "assistant_message";
    const suppressText =
      textMessageType === "assistant_message" && (options?.suppressAssistantText ?? false);
    const suppressReasoning = options?.suppressReasoning ?? false;

    if (typeof content === "string") {
      if (
        !content ||
        content === INTERRUPT_TOOL_USE_PLACEHOLDER ||
        isClaudeTranscriptNoiseText(content)
      ) {
        return [];
      }
      if (suppressText) {
        return [];
      }
      return [{ type: textMessageType, text: content }];
    }

    const items: AgentTimelineItem[] = [];
    // User SDK entries can arrive as multiple text blocks, but Paseo treats them as one message.
    const userTextParts: string[] = [];
    for (const block of content) {
      switch (block.type) {
        case "text":
        case "text_delta":
          if (
            block.text &&
            block.text !== INTERRUPT_TOOL_USE_PLACEHOLDER &&
            !isClaudeTranscriptNoiseText(block.text)
          ) {
            if (textMessageType === "user_message") {
              const trimmed = block.text.trim();
              if (trimmed) {
                userTextParts.push(trimmed);
              }
            } else if (!suppressText) {
              items.push({ type: "assistant_message", text: block.text });
            }
          }
          break;
        case "thinking":
        case "thinking_delta":
          if (block.thinking) {
            if (!suppressReasoning) {
              items.push({ type: "reasoning", text: block.thinking });
            }
          }
          break;
        case "tool_use":
        case "server_tool_use":
        case "mcp_tool_use": {
          this.handleToolUseStart(block, items);
          break;
        }
        case "tool_result":
        case "mcp_tool_result":
        case "web_fetch_tool_result":
        case "web_search_tool_result":
        case "code_execution_tool_result":
        case "bash_code_execution_tool_result":
        case "text_editor_code_execution_tool_result": {
          this.handleToolResult(block, items);
          break;
        }
        default:
          break;
      }
    }

    if (textMessageType === "user_message" && userTextParts.length > 0) {
      items.unshift({
        type: "user_message",
        text: userTextParts.join("\n\n"),
      });
    }

    return items;
  }

  private handleToolUseStart(block: ClaudeContentChunk, items: AgentTimelineItem[]): void {
    const entry = this.upsertToolUseEntry(block);
    if (!entry) {
      return;
    }
    if (entry.started) {
      return;
    }
    entry.started = true;
    this.toolUseCache.set(entry.id, entry);
    this.pushToolCall(
      mapClaudeRunningToolCall({
        name: entry.name,
        callId: entry.id,
        input: entry.input ?? this.normalizeToolInput(block.input) ?? null,
        output: null,
      }),
      items,
    );
  }

  private handleToolResult(block: ClaudeContentChunk, items: AgentTimelineItem[]): void {
    const entry =
      typeof block.tool_use_id === "string" ? this.toolUseCache.get(block.tool_use_id) : undefined;
    const toolName = entry?.name ?? block.tool_name ?? "tool";
    const callId =
      typeof block.tool_use_id === "string" && block.tool_use_id.length > 0
        ? block.tool_use_id
        : (entry?.id ?? null);

    // Extract output from block.content (SDK always returns content in string form)
    const output = this.buildToolOutput(block, entry);

    if (block.is_error) {
      this.pushToolCall(
        mapClaudeFailedToolCall({
          name: toolName,
          callId,
          input: entry?.input ?? null,
          output: output ?? null,
          error: block,
        }),
        items,
      );
    } else {
      this.pushToolCall(
        mapClaudeCompletedToolCall({
          name: toolName,
          callId,
          input: entry?.input ?? null,
          output: output ?? null,
        }),
        items,
      );
    }

    if (typeof block.tool_use_id === "string") {
      this.toolUseCache.delete(block.tool_use_id);
      this.sidechainTracker.delete(block.tool_use_id);
    }
  }

  private buildToolOutput(
    block: ClaudeContentChunk,
    entry: ToolUseCacheEntry | undefined,
  ): AgentMetadata | undefined {
    if (block.is_error) {
      return undefined;
    }

    const server = entry?.server ?? block.server ?? "tool";
    const tool = entry?.name ?? block.tool_name ?? "tool";
    const content = coerceToolResultContentToString(block.content);
    const input = entry?.input;

    // Build structured result based on tool type
    const structured = this.buildStructuredToolResult(server, tool, content, input);

    if (structured) {
      return structured;
    }

    // Fallback format - try to parse JSON first
    const result: AgentMetadata = {};

    if (content.length > 0) {
      try {
        // If content is a JSON string, parse it
        result.output = JSON.parse(content);
      } catch {
        // If not JSON, return unchanged (no extra wrapping)
        result.output = content;
      }
    }

    // Preserve file changes tracked during tool execution
    if (entry?.files?.length) {
      result.files = entry.files;
    }

    return Object.keys(result).length > 0 ? result : undefined;
  }

  private buildStructuredToolResult(
    server: string,
    tool: string,
    output: string,
    input?: AgentMetadata | null,
  ): AgentMetadata | undefined {
    const normalizedServer = server.toLowerCase();
    const normalizedTool = tool.toLowerCase();

    // Command execution tools
    if (
      normalizedServer.includes("bash") ||
      normalizedServer.includes("shell") ||
      normalizedServer.includes("command") ||
      normalizedTool.includes("bash") ||
      normalizedTool.includes("shell") ||
      normalizedTool.includes("command") ||
      (input && (typeof input.command === "string" || Array.isArray(input.command)))
    ) {
      const command = this.extractCommandText(input ?? {}) ?? "command";
      return {
        type: "command",
        command,
        output,
        cwd: typeof input?.cwd === "string" ? input.cwd : undefined,
      };
    }

    // File write tools (new files or complete replacements)
    if (
      normalizedTool.includes("write") ||
      normalizedTool === "write_file" ||
      normalizedTool === "create_file"
    ) {
      if (input && typeof input.file_path === "string") {
        return {
          type: "file_write",
          filePath: input.file_path,
          oldContent: "",
          newContent: typeof input.content === "string" ? input.content : output,
        };
      }
    }

    // File edit/patch tools
    if (
      normalizedTool.includes("edit") ||
      normalizedTool.includes("patch") ||
      normalizedTool === "apply_patch" ||
      normalizedTool === "apply_diff"
    ) {
      if (input && typeof input.file_path === "string") {
        // Support both old_str/new_str and old_string/new_string parameter names
        const oldContent =
          typeof input.old_str === "string"
            ? input.old_str
            : typeof input.old_string === "string"
              ? input.old_string
              : undefined;
        const newContent =
          typeof input.new_str === "string"
            ? input.new_str
            : typeof input.new_string === "string"
              ? input.new_string
              : undefined;
        return {
          type: "file_edit",
          filePath: input.file_path,
          diff:
            typeof input.patch === "string"
              ? input.patch
              : typeof input.diff === "string"
                ? input.diff
                : undefined,
          oldContent,
          newContent,
        };
      }
    }

    // File read tools
    if (
      normalizedTool.includes("read") ||
      normalizedTool === "read_file" ||
      normalizedTool === "view_file"
    ) {
      if (input && typeof input.file_path === "string") {
        return {
          type: "file_read",
          filePath: input.file_path,
          content: output,
        };
      }
    }

    return undefined;
  }

  private mapPartialEvent(
    event: SDKPartialAssistantMessage["event"],
    options?: {
      suppressAssistantText?: boolean;
      suppressReasoning?: boolean;
    },
  ): AgentTimelineItem[] {
    if (event.type === "content_block_start") {
      const block = isClaudeContentChunk(event.content_block) ? event.content_block : null;
      if (
        block?.type === "tool_use" &&
        typeof event.index === "number" &&
        typeof block.id === "string"
      ) {
        this.toolUseIndexToId.set(event.index, block.id);
        this.toolUseInputBuffers.delete(block.id);
      }
    } else if (event.type === "content_block_delta") {
      const delta = isClaudeContentChunk(event.delta) ? event.delta : null;
      if (delta?.type === "input_json_delta") {
        const partialJson = typeof delta.partial_json === "string" ? delta.partial_json : undefined;
        this.handleToolInputDelta(event.index, partialJson);
        return [];
      }
    } else if (event.type === "content_block_stop" && typeof event.index === "number") {
      const toolId = this.toolUseIndexToId.get(event.index);
      if (toolId) {
        this.toolUseIndexToId.delete(event.index);
        this.toolUseInputBuffers.delete(toolId);
      }
    }

    switch (event.type) {
      case "content_block_start":
        return isClaudeContentChunk(event.content_block)
          ? this.mapBlocksToTimeline([event.content_block], {
              suppressAssistantText: options?.suppressAssistantText,
              suppressReasoning: options?.suppressReasoning,
            })
          : [];
      case "content_block_delta":
        return isClaudeContentChunk(event.delta)
          ? this.mapBlocksToTimeline([event.delta], {
              suppressAssistantText: options?.suppressAssistantText,
              suppressReasoning: options?.suppressReasoning,
            })
          : [];
      default:
        return [];
    }
  }

  private upsertToolUseEntry(block: ClaudeContentChunk): ToolUseCacheEntry | null {
    const id = typeof block.id === "string" ? block.id : undefined;
    if (!id) {
      return null;
    }
    const existing =
      this.toolUseCache.get(id) ??
      ({
        id,
        name: typeof block.name === "string" && block.name.length > 0 ? block.name : "tool",
        server:
          typeof block.server === "string" && block.server.length > 0
            ? block.server
            : typeof block.name === "string" && block.name.length > 0
              ? block.name
              : "tool",
        classification: "generic",
        started: false,
      } satisfies ToolUseCacheEntry);

    if (typeof block.name === "string" && block.name.length > 0) {
      existing.name = block.name;
    }
    if (typeof block.server === "string" && block.server.length > 0) {
      existing.server = block.server;
    } else if (!existing.server) {
      existing.server = existing.name;
    }

    if (
      block.type === "tool_use" ||
      block.type === "mcp_tool_use" ||
      block.type === "server_tool_use"
    ) {
      const input = this.normalizeToolInput(block.input);
      if (input) {
        this.applyToolInput(existing, input);
      }
    }

    this.toolUseCache.set(id, existing);
    return existing;
  }

  private handleToolInputDelta(index: number | undefined, partialJson: string | undefined): void {
    if (typeof index !== "number" || typeof partialJson !== "string") {
      return;
    }
    const toolId = this.toolUseIndexToId.get(index);
    if (!toolId) {
      return;
    }
    const buffer = (this.toolUseInputBuffers.get(toolId) ?? "") + partialJson;
    this.toolUseInputBuffers.set(toolId, buffer);
    const entry = this.toolUseCache.get(toolId);
    const parsed = parsePartialJsonObject(buffer);
    if (!entry || !parsed) {
      return;
    }
    const normalized = this.normalizeToolInput(parsed.value);
    if (!normalized) {
      return;
    }
    if (!parsed.complete && Object.keys(normalized).length === 0) {
      return;
    }
    if (this.areToolInputsEqual(entry.input ?? undefined, normalized)) {
      return;
    }
    this.applyToolInput(entry, normalized);
    this.toolUseCache.set(toolId, entry);
    this.pushToolCall(
      mapClaudeRunningToolCall({
        name: entry.name,
        callId: toolId,
        input: normalized,
        output: null,
      }),
    );
  }

  private normalizeToolInput(input: unknown): AgentMetadata | null {
    if (!isMetadata(input)) {
      return null;
    }
    return input;
  }

  private areToolInputsEqual(left: AgentMetadata | undefined, right: AgentMetadata): boolean {
    if (!left) {
      return false;
    }
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }
    return rightKeys.every((key) => left[key] === right[key]);
  }

  private applyToolInput(entry: ToolUseCacheEntry, input: AgentMetadata): void {
    entry.input = input;
    if (this.isCommandTool(entry.name, input)) {
      entry.classification = "command";
      entry.commandText = this.extractCommandText(input) ?? entry.commandText;
    } else {
      const files = this.extractFileChanges(input);
      if (files?.length) {
        entry.classification = "file_change";
        entry.files = files;
      }
    }
  }

  private isCommandTool(name: string, input: AgentMetadata): boolean {
    const normalized = name.toLowerCase();
    if (
      normalized.includes("bash") ||
      normalized.includes("shell") ||
      normalized.includes("terminal") ||
      normalized.includes("command")
    ) {
      return true;
    }
    if (typeof input.command === "string" || Array.isArray(input.command)) {
      return true;
    }
    return false;
  }

  private extractCommandText(input: AgentMetadata): string | undefined {
    const command = input.command;
    if (typeof command === "string" && command.length > 0) {
      return command;
    }
    if (Array.isArray(command)) {
      const tokens = command.filter((value): value is string => typeof value === "string");
      if (tokens.length > 0) {
        return tokens.join(" ");
      }
    }
    if (typeof input.description === "string" && input.description.length > 0) {
      return input.description;
    }
    return undefined;
  }

  private extractFileChanges(input: AgentMetadata): { path: string; kind: string }[] | undefined {
    if (typeof input.file_path === "string" && input.file_path.length > 0) {
      const relative = this.relativizePath(input.file_path);
      if (relative) {
        return [{ path: relative, kind: this.detectFileKind(input.file_path) }];
      }
    }
    if (typeof input.patch === "string" && input.patch.length > 0) {
      const files = this.parsePatchFileList(input.patch);
      if (files.length > 0) {
        return files.map((entry) => ({
          path: this.relativizePath(entry.path) ?? entry.path,
          kind: entry.kind,
        }));
      }
    }
    if (Array.isArray(input.files)) {
      const files: { path: string; kind: string }[] = [];
      for (const value of input.files) {
        if (typeof value === "string" && value.length > 0) {
          files.push({
            path: this.relativizePath(value) ?? value,
            kind: this.detectFileKind(value),
          });
        }
      }
      if (files.length > 0) {
        return files;
      }
    }
    return undefined;
  }

  private detectFileKind(filePath: string): string {
    try {
      return fs.existsSync(filePath) ? "update" : "add";
    } catch {
      return "update";
    }
  }

  private relativizePath(target?: string): string | undefined {
    if (!target) {
      return undefined;
    }
    const cwd = this.config.cwd;
    if (cwd && target.startsWith(cwd)) {
      const relative = path.relative(cwd, target);
      return relative.length > 0 ? relative : path.basename(target);
    }
    return target;
  }

  private parsePatchFileList(patch: string): { path: string; kind: string }[] {
    const files: { path: string; kind: string }[] = [];
    const seen = new Set<string>();
    for (const line of patch.split(/\r?\n/)) {
      const trimmed = line.trim();
      let kind: string | null = null;
      let parsedPath: string | null = null;
      if (trimmed.startsWith("*** Add File:")) {
        kind = "add";
        parsedPath = trimmed.replace("*** Add File:", "").trim();
      } else if (trimmed.startsWith("*** Delete File:")) {
        kind = "delete";
        parsedPath = trimmed.replace("*** Delete File:", "").trim();
      } else if (trimmed.startsWith("*** Update File:")) {
        kind = "update";
        parsedPath = trimmed.replace("*** Update File:", "").trim();
      }
      if (kind && parsedPath && !seen.has(`${kind}:${parsedPath}`)) {
        seen.add(`${kind}:${parsedPath}`);
        files.push({ path: parsedPath, kind });
      }
    }
    return files;
  }
}

function hasToolLikeBlock(block?: ClaudeContentChunk | null): boolean {
  if (!block || typeof block !== "object") {
    return false;
  }
  const type = typeof block.type === "string" ? block.type.toLowerCase() : "";
  return type.includes("tool");
}

function readCompactionMetadata(
  source: Record<string, unknown>,
): { trigger?: string; preTokens?: number } | null {
  const candidates = [source.compact_metadata, source.compactMetadata, source.compactionMetadata];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const metadata = candidate as Record<string, unknown>;
    const trigger = typeof metadata.trigger === "string" ? metadata.trigger : undefined;
    const preTokensRaw = metadata.preTokens ?? metadata.pre_tokens;
    const preTokens = typeof preTokensRaw === "number" ? preTokensRaw : undefined;
    return { trigger, preTokens };
  }
  return null;
}

function normalizeHistoryBlocks(content: unknown): ClaudeContentChunk[] | null {
  if (Array.isArray(content)) {
    const blocks = content.filter((entry) => isClaudeContentChunk(entry));
    return blocks.length > 0 ? blocks : null;
  }
  if (isClaudeContentChunk(content)) {
    return [content];
  }
  return null;
}

export function convertClaudeHistoryEntry(
  entry: any,
  mapBlocks: (content: string | ClaudeContentChunk[]) => AgentTimelineItem[],
): AgentTimelineItem[] {
  if (entry.type === "system" && entry.subtype === "compact_boundary") {
    const compactMetadata = readCompactionMetadata(entry as Record<string, unknown>);
    return [
      {
        type: "compaction",
        status: "completed",
        trigger: compactMetadata?.trigger === "manual" ? "manual" : "auto",
        preTokens: compactMetadata?.preTokens,
      },
    ];
  }

  const taskNotificationItem = mapTaskNotificationSystemRecordToToolCall(entry);
  if (taskNotificationItem) {
    return [taskNotificationItem];
  }

  if (entry.isCompactSummary) {
    return [];
  }
  if (entry.type === "user" && isSyntheticUserEntry(entry)) {
    return [];
  }

  const message = entry?.message;
  if (!message || !("content" in message)) {
    return [];
  }

  const content = message.content;
  if (
    (entry.type === "user" || entry.type === "assistant") &&
    isClaudeTranscriptNoiseContent(content)
  ) {
    return [];
  }
  const normalizedBlocks = normalizeHistoryBlocks(content);
  const contentValue = typeof content === "string" ? content : normalizedBlocks;
  const hasToolBlock = normalizedBlocks?.some((block) => hasToolLikeBlock(block)) ?? false;
  const userMessageId =
    entry.type === "user" && typeof entry.uuid === "string" && entry.uuid.length > 0
      ? entry.uuid
      : null;

  if (entry.type === "user") {
    const taskNotificationItem = mapTaskNotificationUserContentToToolCall({
      content,
      messageId: userMessageId,
    });
    if (taskNotificationItem) {
      return [taskNotificationItem];
    }
  }

  const timeline: AgentTimelineItem[] = [];

  if (entry.type === "user") {
    const text = extractUserMessageText(content);
    if (text) {
      timeline.push({
        type: "user_message",
        text,
        ...(userMessageId ? { messageId: userMessageId } : {}),
      });
    }
  }

  if (hasToolBlock && normalizedBlocks) {
    const mapped = mapBlocks(normalizedBlocks);
    if (entry.type === "user") {
      const toolItems = mapped.filter((item) => item.type === "tool_call");
      return timeline.length ? [...timeline, ...toolItems] : toolItems;
    }
    return mapped;
  }

  if (entry.type === "assistant" && contentValue) {
    return mapBlocks(contentValue);
  }

  return timeline;
}

function createAsyncMessageInput<T>(): AsyncMessageInput<T> {
  const queue: T[] = [];
  const resolvers: Array<(value: IteratorResult<T, void>) => void> = [];
  let closed = false;

  return {
    push(item: T) {
      if (closed) {
        return;
      }
      const resolve = resolvers.shift();
      if (resolve) {
        resolve({ value: item, done: false });
        return;
      }
      queue.push(item);
    },
    end() {
      closed = true;
      while (resolvers.length > 0) {
        const resolve = resolvers.shift();
        resolve?.({ value: undefined, done: true });
      }
    },
    iterable: {
      [Symbol.asyncIterator](): AsyncIterator<T, void> {
        return {
          next: (): Promise<IteratorResult<T, void>> => {
            if (queue.length > 0) {
              const value = queue.shift();
              if (value !== undefined) {
                return Promise.resolve({ value, done: false });
              }
            }
            if (closed) {
              return Promise.resolve({ value: undefined, done: true });
            }
            return new Promise<IteratorResult<T, void>>((resolve) => {
              resolvers.push(resolve);
            });
          },
        };
      },
    },
  };
}

type ClaudeSessionCandidate = {
  path: string;
  mtime: Date;
};

async function pathExists(target: string): Promise<boolean> {
  try {
    await fsPromises.access(target);
    return true;
  } catch {
    return false;
  }
}

async function collectRecentClaudeSessions(
  root: string,
  limit: number,
): Promise<ClaudeSessionCandidate[]> {
  let projectDirs: string[];
  try {
    projectDirs = await fsPromises.readdir(root);
  } catch {
    return [];
  }
  const candidates: ClaudeSessionCandidate[] = [];
  for (const dirName of projectDirs) {
    const projectPath = path.join(root, dirName);
    let stats: fs.Stats;
    try {
      stats = await fsPromises.stat(projectPath);
    } catch {
      continue;
    }
    if (!stats.isDirectory()) {
      continue;
    }
    let files: string[];
    try {
      files = await fsPromises.readdir(projectPath);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".jsonl")) {
        continue;
      }
      const fullPath = path.join(projectPath, file);
      try {
        const fileStats = await fsPromises.stat(fullPath);
        candidates.push({ path: fullPath, mtime: fileStats.mtime });
      } catch {
        // ignore stat errors for individual files
      }
    }
  }
  return candidates.sort((a, b) => b.mtime.getTime() - a.mtime.getTime()).slice(0, limit);
}

async function parseClaudeSessionDescriptor(
  filePath: string,
  mtime: Date,
): Promise<PersistedAgentDescriptor | null> {
  let content: string;
  try {
    content = await fsPromises.readFile(filePath, "utf8");
  } catch {
    return null;
  }

  let sessionId: string | null = null;
  let cwd: string | null = null;
  let title: string | null = null;
  const timeline: AgentTimelineItem[] = [];

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.isSidechain) {
      continue;
    }
    if (entry?.type === "user" && isSyntheticUserEntry(entry)) {
      continue;
    }
    if (!sessionId && typeof entry.sessionId === "string") {
      sessionId = entry.sessionId;
    }
    if (!cwd && typeof entry.cwd === "string") {
      cwd = entry.cwd;
    }
    if (entry.type === "user" && entry.message) {
      const text = extractClaudeUserText(entry.message);
      if (text) {
        if (!title) {
          title = text;
        }
        timeline.push({ type: "user_message", text });
      }
    } else if (entry.type === "assistant" && entry.message) {
      const text = extractClaudeUserText(entry.message);
      if (text) {
        timeline.push({ type: "assistant_message", text });
      }
    }
    if (sessionId && cwd && title) {
      break;
    }
  }

  if (!sessionId || !cwd) {
    return null;
  }

  const persistence: AgentPersistenceHandle = {
    provider: "claude",
    sessionId,
    nativeHandle: sessionId,
    metadata: {
      provider: "claude",
      cwd,
    },
  };

  return {
    provider: "claude",
    sessionId,
    cwd,
    title: (title ?? "").trim() || `Claude session ${sessionId.slice(0, 8)}`,
    lastActivityAt: mtime,
    persistence,
    timeline,
  };
}

function extractClaudeUserText(message: any): string | null {
  if (!message) {
    return null;
  }
  if (typeof message.content === "string") {
    const normalized = message.content.trim();
    return normalized && !isClaudeTranscriptNoiseText(normalized) ? normalized : null;
  }
  if (typeof message.text === "string") {
    const normalized = message.text.trim();
    return normalized && !isClaudeTranscriptNoiseText(normalized) ? normalized : null;
  }
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block && typeof block.text === "string") {
        const normalized = block.text.trim();
        if (normalized && !isClaudeTranscriptNoiseText(normalized)) {
          return normalized;
        }
      }
    }
  }
  return null;
}
