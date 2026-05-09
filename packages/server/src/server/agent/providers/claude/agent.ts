import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { promises } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type AgentDefinition,
  type CanUseTool,
  type McpServerConfig as ClaudeSdkMcpServerConfig,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKPartialAssistantMessage,
  type SDKTaskProgressMessage,
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
} from "./tool-call-mapper.js";
import {
  mapTaskNotificationSystemRecordToToolCall,
  mapTaskNotificationUserContentToToolCall,
} from "./task-notification-tool-call.js";
import { getClaudeModels, normalizeClaudeRuntimeModelId } from "./models.js";
import { parsePartialJsonObject } from "./partial-json.js";
import { ClaudeSidechainTracker } from "./sidechain-tracker.js";
import {
  formatDiagnosticStatus,
  formatProviderDiagnostic,
  formatProviderDiagnosticError,
  toDiagnosticErrorMessage,
} from "../diagnostic-utils.js";
import { appendOrReplaceGrowingAssistantMessage, runProviderTurn } from "../provider-runner.js";
import { renderPromptAttachmentAsText } from "../../prompt-attachments.js";
import { claudeQuery, type ClaudeOptions, type ClaudeQueryFactory } from "./query.js";

import type {
  AgentPermissionAction,
  AgentCapabilityFlags,
  AgentClient,
  AgentCreateSessionOptions,
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
} from "../../agent-sdk-types.js";
import {
  createProviderEnv,
  createProviderEnvSpec,
  type ProviderRuntimeSettings,
} from "../../provider-launch-config.js";
import { findExecutable, isCommandAvailable } from "../../../../utils/executable.js";
import { withTimeout } from "../../../../utils/promise-timeout.js";
import { execCommand } from "../../../../utils/spawn.js";
import { getOrchestratorModeInstructions } from "../../orchestrator-instructions.js";

const fsPromises = promises;
const CLAUDE_SETTING_SOURCES: NonNullable<ClaudeOptions["settingSources"]> = ["user", "project"];

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function normalizeClaudeAskUserQuestionUpdatedInput(
  updatedInput: AgentMetadata | undefined,
  fallbackInput: AgentMetadata | undefined,
): AgentMetadata {
  const fallback = isMetadata(fallbackInput) ? fallbackInput : {};
  const base = isMetadata(updatedInput) ? updatedInput : {};
  // Paseo's shared question UI serializes answers by question header, but Claude's
  // AskUserQuestion tool expects answer keys to match the full question text. Merge
  // the original request payload back in so provider callbacks that only return
  // `{ answers }` still satisfy Claude's full tool input schema.
  const merged = { ...fallback, ...base };
  const questions =
    (Array.isArray(base.questions) ? base.questions : null) ??
    (Array.isArray(fallback.questions) ? fallback.questions : null);
  const answers = isMetadata(base.answers) ? base.answers : null;

  if (!questions || !answers) {
    return merged;
  }

  const normalizedAnswers: Record<string, string> = {};
  for (const item of questions) {
    const question = isMetadata(item) ? item : null;
    if (!question) {
      continue;
    }

    const questionText = readNonEmptyString(question.question);
    if (!questionText) {
      continue;
    }

    const header = readNonEmptyString(question.header);
    const answer =
      readNonEmptyString(answers[questionText]) ??
      (header ? readNonEmptyString(answers[header]) : null);
    if (answer) {
      normalizedAnswers[questionText] = answer;
    }
  }

  if (Object.keys(normalizedAnswers).length === 0) {
    return merged;
  }

  return {
    ...merged,
    answers: normalizedAnswers,
  };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toObjectRecord(value: unknown): Record<string, unknown> | undefined {
  return isObjectRecord(value) ? value : undefined;
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isImageMimeType(
  value: string,
): value is "image/jpeg" | "image/png" | "image/gif" | "image/webp" {
  return (
    value === "image/jpeg" ||
    value === "image/png" ||
    value === "image/gif" ||
    value === "image/webp"
  );
}

type TurnState = "idle" | "foreground" | "autonomous";

interface EventIdentifiers {
  taskId: string | null;
  parentMessageId: string | null;
  messageId: string | null;
}

interface AutonomousTurnState {
  id: string;
}

interface AsyncMessageInput<T> {
  push: (item: T) => void;
  end: () => void;
  iterable: AsyncIterable<T>;
}

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

interface SlashCommandInvocation {
  commandName: string;
  args?: string;
  rawInput: string;
}

type ClaudeAgentConfig = AgentSessionConfig & { provider: "claude" };

export interface ClaudeContentChunk {
  type: string;
  [key: string]: unknown;
}

interface ClaudeAgentClientOptions {
  defaults?: { agents?: Record<string, AgentDefinition> };
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
  queryFactory?: ClaudeQueryFactory;
  resolveBinary?: () => Promise<string>;
}

interface ClaudeAgentSessionOptions {
  defaults?: { agents?: Record<string, AgentDefinition> };
  runtimeSettings?: ProviderRuntimeSettings;
  handle?: AgentPersistenceHandle;
  launchEnv?: Record<string, string>;
  persistSession?: boolean;
  logger: Logger;
  queryFactory?: ClaudeQueryFactory;
  resolveBinary: () => Promise<string>;
}

type ClaudeThinkingEffort = "low" | "medium" | "high" | "xhigh" | "max";

function resolvePathEnvKey(): "Path" | "PATH" | null {
  if (process.env["Path"] !== undefined) return "Path";
  if (process.env["PATH"] !== undefined) return "PATH";
  return null;
}

function errorToMessageString(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "";
}

function firstStringField(
  input: Record<string, unknown>,
  primaryKey: string,
  secondaryKey: string,
): string | undefined {
  const primary = input[primaryKey];
  if (typeof primary === "string") return primary;
  const secondary = input[secondaryKey];
  if (typeof secondary === "string") return secondary;
  return undefined;
}

function extractSessionIdRaw(msg: {
  session_id?: unknown;
  sessionId?: unknown;
  session?: { id?: unknown } | null;
}): string {
  if (typeof msg.session_id === "string") return msg.session_id;
  if (typeof msg.sessionId === "string") return msg.sessionId;
  if (typeof msg.session?.id === "string") return msg.session.id;
  return "";
}

function isClaudeThinkingEffort(value: string | null | undefined): value is ClaudeThinkingEffort {
  return (
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  );
}

function sanitizeClaudeProjectPath(cwd: string): string {
  return cwd.replace(/[\\/._:]/g, "-");
}

interface ClaudeOptionsLogSummary {
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
  persistSession: boolean | null;
}

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
    const prompt = toObjectRecord(systemPromptRaw);
    const promptType = typeof prompt?.type === "string" ? prompt.type : "custom";
    return {
      mode: promptType === "preset" ? ("preset" as const) : ("custom" as const),
      preset: typeof prompt?.preset === "string" && prompt.preset.length > 0 ? prompt.preset : null,
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
    persistSession: typeof options.persistSession === "boolean" ? options.persistSession : null,
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
    const objectValue = value;
    if (seen.has(objectValue)) {
      return "[circular]";
    }
    seen.add(objectValue);
    const record = toObjectRecord(value);
    if (!record) {
      seen.delete(objectValue);
      return "[invalid]";
    }
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      normalized[key] = normalizeForDeterministicString(record[key], seen);
    }
    seen.delete(objectValue);
    return normalized;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "[unsupported]";
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
    if (typeof value === "string") {
      return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    return "[unserializable]";
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

const LOCAL_COMMAND_STDOUT_PATTERN =
  /^\s*<local-command-stdout>[\s\S]*<\/local-command-stdout>\s*$/;

function isClaudeLocalCommandStdout(value: unknown): boolean {
  const normalized = normalizeClaudeTranscriptText(value);
  return normalized !== null && LOCAL_COMMAND_STDOUT_PATTERN.test(normalized);
}

function isClaudeTranscriptNoiseText(value: unknown): boolean {
  return (
    isClaudeInterruptPlaceholderText(value) ||
    isClaudeNoResponsePlaceholderText(value) ||
    isClaudeLocalCommandStdout(value)
  );
}

function collectClaudeTextContentParts(content: unknown): string[] {
  if (typeof content === "string") {
    const normalized = normalizeClaudeTranscriptText(content);
    return normalized ? [normalized] : [];
  }

  if (!isUnknownArray(content)) {
    return [];
  }

  const parts: string[] = [];
  for (const block of content) {
    const blockRecord = toObjectRecord(block);
    if (!blockRecord) {
      continue;
    }
    const text = normalizeClaudeTranscriptText(blockRecord.text);
    if (text) {
      parts.push(text);
      continue;
    }
    const input = normalizeClaudeTranscriptText(blockRecord.input);
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

interface PendingPermission {
  request: AgentPermissionRequest;
  resolve: (result: PermissionResult) => void;
  reject: (error: Error) => void;
  cleanup?: () => void;
}

type ToolUseClassification = "generic" | "command" | "file_change";
interface ToolUseCacheEntry {
  id: string;
  name: string;
  server: string;
  classification: ToolUseClassification;
  started: boolean;
  commandText?: string;
  files?: { path: string; kind: string }[];
  input?: AgentMetadata | null;
}
function isMetadata(value: unknown): value is AgentMetadata {
  return typeof value === "object" && value !== null;
}

function createDefaultToolUseCacheEntry(id: string, block: ClaudeContentChunk): ToolUseCacheEntry {
  const nameFromBlock =
    typeof block.name === "string" && block.name.length > 0 ? block.name : "tool";
  let server: string;
  if (typeof block.server === "string" && block.server.length > 0) {
    server = block.server;
  } else if (typeof block.name === "string" && block.name.length > 0) {
    server = block.name;
  } else {
    server = "tool";
  }
  return {
    id,
    name: nameFromBlock,
    server,
    classification: "generic",
    started: false,
  };
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
  throw new Error("Unhandled MCP server config type");
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

function getClaudeModeLabel(modeId: PermissionMode): string {
  return DEFAULT_MODES.find((mode) => mode.id === modeId)?.label ?? modeId;
}

function buildClaudePlanPermissionActions(
  resumeMode: PermissionMode | null,
): AgentPermissionAction[] {
  const actions: AgentPermissionAction[] = [
    {
      id: "reject",
      label: "Reject",
      behavior: "deny",
      variant: "danger",
      intent: "dismiss",
    },
    {
      id: "implement",
      label: "Implement",
      behavior: "allow",
      variant: "primary",
      intent: "implement",
    },
  ];

  if (resumeMode === "bypassPermissions") {
    actions.push({
      id: "implement_resume",
      label: `Implement with ${getClaudeModeLabel(resumeMode)}`,
      behavior: "allow",
      variant: "secondary",
      intent: "implement_resume",
    });
  }

  return actions;
}

interface TimelineFragment {
  kind: "assistant" | "reasoning";
  text: string;
}

interface TimelineMessageState {
  id: string;
  assistantText: string;
  reasoningText: string;
  emittedAssistantLength: number;
  emittedReasoningLength: number;
  stopped: boolean;
}

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
    const event = toObjectRecord(message.event) ?? {};
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
    const candidate = toObjectRecord(message);
    const messageContainer = toObjectRecord(candidate?.message);
    return (
      readTrimmedString(candidate?.message_id) ?? readTrimmedString(messageContainer?.id) ?? null
    );
  }

  private readMessageIdFromStreamEvent(event: Record<string, unknown>): string | null {
    const messageContainer = toObjectRecord(event.message);
    return readTrimmedString(event.message_id) ?? readTrimmedString(messageContainer?.id) ?? null;
  }
}

function isSyntheticUserEntry(entry: unknown): boolean {
  const candidate = toObjectRecord(entry);
  if (!candidate) {
    return false;
  }
  return candidate.isSynthetic === true || candidate.isMeta === true;
}

function firstTrimmedString(sources: readonly unknown[]): string | null {
  for (const source of sources) {
    const value = readTrimmedString(source);
    if (value) {
      return value;
    }
  }
  return null;
}

export function readEventIdentifiers(message: SDKMessage): EventIdentifiers {
  const root = toObjectRecord(message) ?? {};
  const messageType = readTrimmedString(root.type);
  const streamEvent = toObjectRecord(root.event);
  const streamEventMessage = toObjectRecord(streamEvent?.message);
  const messageContainer = toObjectRecord(root.message);

  const messageIdFromUuid = messageType === "user" ? root.uuid : undefined;

  return {
    taskId: firstTrimmedString([
      root.task_id,
      streamEvent?.task_id,
      streamEventMessage?.task_id,
      messageContainer?.task_id,
    ]),
    parentMessageId: firstTrimmedString([
      root.parent_message_id,
      streamEvent?.parent_message_id,
      streamEventMessage?.parent_message_id,
      messageContainer?.parent_message_id,
    ]),
    messageId: firstTrimmedString([
      root.message_id,
      streamEvent?.message_id,
      streamEventMessage?.id,
      streamEventMessage?.message_id,
      messageContainer?.id,
      messageContainer?.message_id,
      messageIdFromUuid,
    ]),
  };
}

const claudeDebug = process.env.PASEO_CLAUDE_DEBUG === "1";

export class ClaudeAgentClient implements AgentClient {
  readonly provider = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;

  private readonly defaults?: { agents?: Record<string, AgentDefinition> };
  private readonly logger: Logger;
  private readonly runtimeSettings?: ProviderRuntimeSettings;
  private readonly queryFactory?: ClaudeQueryFactory;
  private readonly resolveBinary: () => Promise<string>;

  constructor(options: ClaudeAgentClientOptions) {
    this.defaults = options.defaults;
    this.logger = options.logger.child({ module: "agent", provider: "claude" });
    this.runtimeSettings = options.runtimeSettings;
    this.queryFactory = options.queryFactory;
    this.resolveBinary = options.resolveBinary ?? (() => resolveClaudeBinary(this.runtimeSettings));
  }

  async createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
    options?: AgentCreateSessionOptions,
  ): Promise<AgentSession> {
    const claudeConfig = this.assertConfig(config);
    return new ClaudeAgentSession(claudeConfig, {
      defaults: this.defaults,
      runtimeSettings: this.runtimeSettings,
      launchEnv: launchContext?.env,
      persistSession: options?.persistSession,
      logger: this.logger,
      queryFactory: this.queryFactory,
      resolveBinary: this.resolveBinary,
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
    const mergedConfig: AgentSessionConfig = {
      ...merged,
      provider: "claude",
      cwd: merged.cwd,
    };
    const claudeConfig = this.assertConfig(mergedConfig);
    return new ClaudeAgentSession(claudeConfig, {
      defaults: this.defaults,
      runtimeSettings: this.runtimeSettings,
      handle,
      launchEnv: launchContext?.env,
      logger: this.logger,
      queryFactory: this.queryFactory,
      resolveBinary: this.resolveBinary,
    });
  }

  async listModels(_options: ListModelsOptions): Promise<AgentModelDefinition[]> {
    // Claude exposes a static catalog here; cwd/force are intentionally irrelevant.
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
    const parsed = await Promise.all(
      candidates.map((candidate) => parseClaudeSessionDescriptor(candidate.path, candidate.mtime)),
    );
    return parsed
      .filter((descriptor): descriptor is PersistedAgentDescriptor => descriptor !== null)
      .slice(0, limit);
  }

  async isAvailable(): Promise<boolean> {
    const command = this.runtimeSettings?.command;
    if (command?.mode === "replace") {
      return await isCommandAvailable(command.argv[0]);
    }
    return await isCommandAvailable("claude");
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    try {
      const resolvedBinary = (await findExecutable("claude")) ?? "not found";
      const available = await this.isAvailable();
      const version = await resolveClaudeVersion(this.runtimeSettings);
      const auth = available ? await resolveClaudeAuth(this.runtimeSettings) : null;
      let modelsValue = "Not checked";
      let status = formatDiagnosticStatus(available);

      if (available) {
        try {
          const models = await this.listModels({
            cwd: os.homedir(),
            force: false,
          });
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
          ...(auth ? [{ label: "Auth", value: auth }] : []),
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

async function resolveClaudeBinary(runtimeSettings?: ProviderRuntimeSettings): Promise<string> {
  const command = runtimeSettings?.command;
  if (command?.mode === "replace") {
    const foundOverride = await findExecutable(command.argv[0]);
    if (foundOverride) {
      return foundOverride;
    }
  }

  const found = await findExecutable("claude");
  if (found) {
    return found;
  }
  throw new Error(
    "Claude binary not found. Install Claude Code (https://github.com/anthropics/claude-code) and ensure it is available in your shell PATH.",
  );
}

async function resolveClaudeVersion(
  runtimeSettings?: ProviderRuntimeSettings,
): Promise<string | null> {
  const command = runtimeSettings?.command;
  const envSpec = createProviderEnvSpec({ runtimeSettings });

  try {
    if (command?.mode === "replace") {
      const { stdout } = await execCommand(
        command.argv[0],
        [...command.argv.slice(1), "--version"],
        { ...envSpec, timeout: 5_000 },
      );
      return stdout.trim() || null;
    }

    const executable = await findExecutable("claude");
    if (!executable) {
      return null;
    }

    const { stdout } = await execCommand(executable, ["--version"], {
      ...envSpec,
      timeout: 5_000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function resolveClaudeAuth(
  runtimeSettings?: ProviderRuntimeSettings,
): Promise<string | null> {
  const command = runtimeSettings?.command;

  const run = async (
    executable: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string }> => {
    try {
      return await execCommand(executable, args, {
        ...createProviderEnvSpec({ runtimeSettings }),
        timeout: 5_000,
      });
    } catch (error) {
      const err = toObjectRecord(error);
      const stdout = typeof err?.stdout === "string" ? err.stdout : "";
      const stderr = typeof err?.stderr === "string" ? err.stderr : "";
      const fallbackMessage = typeof err?.message === "string" ? err.message : "";
      return { stdout, stderr: stderr || fallbackMessage };
    }
  };

  try {
    let result: { stdout: string; stderr: string };
    if (command?.mode === "replace") {
      result = await run(command.argv[0], [...command.argv.slice(1), "auth", "status"]);
    } else {
      const executable = await findExecutable("claude");
      if (!executable) {
        return null;
      }
      result = await run(executable, ["auth", "status"]);
    }

    const combined = [result.stdout, result.stderr]
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .join("\n");
    return combined || null;
  } catch {
    return null;
  }
}

function extractContextWindowSize(modelUsage: unknown): number | undefined {
  const usageRecord = toObjectRecord(modelUsage);
  if (!usageRecord) {
    return undefined;
  }

  let maxContextWindow: number | undefined;
  for (const value of Object.values(usageRecord)) {
    const valueRecord = toObjectRecord(value);
    if (!valueRecord) {
      continue;
    }
    const contextWindow = valueRecord.contextWindow;
    if (
      typeof contextWindow !== "number" ||
      !Number.isFinite(contextWindow) ||
      contextWindow <= 0
    ) {
      continue;
    }
    maxContextWindow = Math.max(maxContextWindow ?? 0, contextWindow);
  }

  return maxContextWindow;
}

function readUsageTotalTokens(usage: unknown): number | undefined {
  if (!usage || typeof usage !== "object") {
    return undefined;
  }
  const totalTokens = (usage as { total_tokens?: unknown }).total_tokens;
  if (typeof totalTokens !== "number" || !Number.isFinite(totalTokens) || totalTokens < 0) {
    return undefined;
  }
  return totalTokens;
}

function readContextWindowUsedTokensFromTaskProgress(
  message: SDKTaskProgressMessage,
): number | undefined {
  return readUsageTotalTokens(message.usage);
}

function readUsageFromTaskNotification(message: { usage?: unknown }): number | undefined {
  return readUsageTotalTokens(message.usage);
}

function readStreamRequestInputTokens(event: Record<string, unknown>): number | undefined {
  const messageUsage = toObjectRecord(toObjectRecord(event.message)?.usage);
  if (!messageUsage) {
    return undefined;
  }
  const usage = messageUsage;
  const inputTokens =
    typeof usage.input_tokens === "number" && Number.isFinite(usage.input_tokens)
      ? usage.input_tokens
      : undefined;
  const cacheCreationInputTokens =
    typeof usage.cache_creation_input_tokens === "number" &&
    Number.isFinite(usage.cache_creation_input_tokens)
      ? usage.cache_creation_input_tokens
      : 0;
  const cacheReadInputTokens =
    typeof usage.cache_read_input_tokens === "number" &&
    Number.isFinite(usage.cache_read_input_tokens)
      ? usage.cache_read_input_tokens
      : 0;
  if (typeof inputTokens !== "number" || inputTokens < 0) {
    return undefined;
  }
  return inputTokens + cacheCreationInputTokens + cacheReadInputTokens;
}

function readStreamRequestOutputTokens(event: Record<string, unknown>): number | undefined {
  const outputTokens = toObjectRecord(event.usage)?.output_tokens;
  if (typeof outputTokens !== "number" || !Number.isFinite(outputTokens) || outputTokens < 0) {
    return undefined;
  }
  return outputTokens;
}

class ClaudeAgentSession implements AgentSession {
  readonly provider = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;

  private readonly config: ClaudeAgentConfig;
  private readonly launchEnv?: Record<string, string>;
  private readonly defaults?: { agents?: Record<string, AgentDefinition> };
  private readonly runtimeSettings?: ProviderRuntimeSettings;
  private readonly persistSession?: boolean;
  private readonly logger: Logger;
  private readonly queryFactory?: ClaudeQueryFactory;
  private readonly resolveBinary: () => Promise<string>;
  private query: Query | null = null;
  private input: AsyncMessageInput<SDKUserMessage> | null = null;
  private claudeSessionId: string | null;
  private persistence: AgentPersistenceHandle | null;
  private currentMode: PermissionMode;
  private planResumeMode: PermissionMode | null = null;
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
  private lastContextWindowUsedTokens: number | undefined;
  private lastContextWindowMaxTokens: number | undefined;
  private lastStreamRequestInputTokens: number | undefined;
  private lastStreamRequestOutputTokens: number | undefined;
  private userMessageIds: string[] = [];
  private recentStderr = "";
  private closed = false;

  constructor(config: ClaudeAgentConfig, options: ClaudeAgentSessionOptions) {
    this.config = config;
    this.launchEnv = options.launchEnv;
    this.defaults = options.defaults;
    this.runtimeSettings = options.runtimeSettings;
    this.persistSession = options.persistSession;
    this.logger = options.logger;
    this.queryFactory = options.queryFactory;
    this.resolveBinary = options.resolveBinary;
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
    if (this.currentMode !== "plan") {
      this.planResumeMode = this.currentMode;
    }
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
    const result = await runProviderTurn({
      prompt,
      runOptions: options,
      startTurn: (p, o) => this.startTurn(p, o),
      subscribe: (callback) => this.subscribe(callback),
      getSessionId: () => this.claudeSessionId ?? "",
      reduceFinalText: appendOrReplaceGrowingAssistantMessage,
    });

    this.cachedRuntimeInfo = {
      provider: "claude",
      sessionId: this.claudeSessionId,
      model: this.lastOptionsModel,
      modeId: this.currentMode ?? null,
    };

    if (!this.claudeSessionId) {
      throw new Error("Session ID not set after run completed");
    }

    return result;
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
    const previousMode = this.currentMode;
    const activeQuery = await this.ensureQuery();
    await activeQuery.setPermissionMode(normalized);
    if (normalized === "plan") {
      if (previousMode !== "plan") {
        this.planResumeMode = previousMode;
      }
    } else {
      this.planResumeMode = normalized;
    }
    this.currentMode = normalized;
  }

  async setModel(modelId: string | null): Promise<void> {
    const normalizedModelId =
      typeof modelId === "string" && modelId.trim().length > 0 ? modelId : null;
    const activeQuery = await this.ensureQuery();
    await activeQuery.setModel(normalizedModelId ?? undefined);
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
        const selectedActionId = response.selectedActionId;
        const shouldResumePriorMode =
          selectedActionId === "implement_resume" && this.planResumeMode === "bypassPermissions";
        const targetMode: PermissionMode = shouldResumePriorMode
          ? "bypassPermissions"
          : "acceptEdits";
        await this.setMode(targetMode);
        this.pushToolCall(
          mapClaudeCompletedToolCall({
            name: "plan_approval",
            callId: pending.request.id,
            input: pending.request.input ?? null,
            output: {
              approved: true,
              actionId: selectedActionId ?? "implement",
            },
          }),
        );
      }
      const updatedInput =
        pending.request.kind === "question"
          ? normalizeClaudeAskUserQuestionUpdatedInput(
              response.updatedInput,
              pending.request.input ?? undefined,
            )
          : (response.updatedInput ?? pending.request.input ?? {});
      const result: PermissionResult = {
        behavior: "allow",
        updatedInput,
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
    rewindResult: {
      filesChanged?: string[];
      insertions?: number;
      deletions?: number;
    },
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
    result?: {
      filesChanged?: string[];
      insertions?: number;
      deletions?: number;
    };
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
      const activeQuery = await this.ensureFreshQuery();
      return await activeQuery.rewindFiles(messageId, { dryRun: false });
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
      oldInput?.end();
      oldQuery.close?.();
      try {
        await oldQuery.return?.();
      } catch {
        /* ignore */
      }
    }

    // Preserve claudeSessionId across query recreation so buildOptions() passes
    // resume: sessionId and the new query continues the existing conversation.
    this.persistence = null;

    const input = createAsyncMessageInput<SDKUserMessage>();
    const options = await this.buildOptions();
    this.logger.debug({ options: summarizeClaudeOptionsForLog(options) }, "claude query");
    this.input = input;
    this.query = claudeQuery(
      { prompt: input.iterable, options },
      {
        runtimeSettings: this.runtimeSettings,
        launchEnv: this.launchEnv,
        queryFactory: this.queryFactory,
      },
    );
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
      await withTimeout(promise, 3_000, "timeout");
      this.logger.trace(
        { label, durationMs: Date.now() - startedAt },
        "Claude query operation settled",
      );
    } catch (error) {
      this.logger.warn({ err: error, label }, "Claude query operation did not settle cleanly");
    }
  }

  private resolveThinkingConfig(): {
    thinking: ClaudeOptions["thinking"];
    effort: ClaudeOptions["effort"];
  } {
    const thinkingOptionId =
      this.config.thinkingOptionId && this.config.thinkingOptionId !== "default"
        ? this.config.thinkingOptionId
        : undefined;
    if (thinkingOptionId && isClaudeThinkingEffort(thinkingOptionId)) {
      return { thinking: { type: "adaptive" }, effort: thinkingOptionId };
    }
    return { thinking: undefined, effort: undefined };
  }

  private buildAppendedSystemPrompt(): string {
    return [getOrchestratorModeInstructions(), this.config.systemPrompt?.trim()]
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      .join("\n\n");
  }

  private async buildOptions(): Promise<ClaudeOptions> {
    const { thinking, effort } = this.resolveThinkingConfig();
    const appendedSystemPrompt = this.buildAppendedSystemPrompt();
    const extraClaudeOptions = this.config.extra?.claude;
    const sdkEnv = createProviderEnv({
      baseEnv: process.env,
      runtimeSettings: this.runtimeSettings,
      overlays: [
        extraClaudeOptions?.env,
        {
          // Increase MCP timeouts for long-running tool calls (10 minutes)
          MCP_TIMEOUT: "600000",
          MCP_TOOL_TIMEOUT: "600000",
        },
        this.launchEnv,
      ],
    });

    const claudeBinary = await this.resolveBinary();
    this.logger.debug(
      {
        claudeBinary,
        pathEnvKey: resolvePathEnvKey(),
        pathIncludesClaudeLocalBin: (process.env["Path"] ?? process.env["PATH"] ?? "")
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
      pathToClaudeCodeExecutable: claudeBinary,
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
      // Required for provider-level /rewind support.
      enableFileCheckpointing: true,
      // If we have a session ID from a previous query (e.g., after interrupt),
      // resume that session to continue the conversation history.
      ...(this.claudeSessionId ? { resume: this.claudeSessionId } : {}),
      ...(thinking ? { thinking } : {}),
      ...(effort ? { effort } : {}),
      ...extraClaudeOptions,
      ...(this.persistSession === undefined ? {} : { persistSession: this.persistSession }),
      env: sdkEnv,
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
    if (this.runtimeSettings?.disallowedTools?.length) {
      base.disallowedTools = [
        ...(base.disallowedTools ?? []),
        ...this.runtimeSettings.disallowedTools,
      ];
    }
    return base;
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
      | {
          type: "image";
          source: {
            type: "base64";
            media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
            data: string;
          };
        }
    > = [];
    if (Array.isArray(prompt)) {
      for (const chunk of prompt) {
        if (chunk.type === "text") {
          content.push({ type: "text", text: chunk.text });
        } else if (chunk.type === "image") {
          if (isImageMimeType(chunk.mimeType)) {
            content.push({
              type: "image",
              source: {
                type: "base64",
                media_type: chunk.mimeType,
                data: chunk.data,
              },
            });
          }
        } else {
          content.push({ type: "text", text: renderPromptAttachmentAsText(chunk) });
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
    const errors = "errors" in message && Array.isArray(message.errors) ? message.errors : [];
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
    const message = errorToMessageString(error);
    if (
      !/\bprocess exited with code\b/i.test(message) &&
      !/\bterminated by signal\b/i.test(message)
    ) {
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
    let message: string;
    if (typeof error === "string") {
      message = error;
    } else if (error instanceof Error) {
      message = `${error.message}\n${error.stack ?? ""}`;
    } else {
      message = JSON.stringify(error);
    }
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
    void pump.finally(() => {
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
    const logRawMessage = (message: SDKMessage): void => {
      if (!claudeDebug) {
        return;
      }
      this.logger.trace(
        {
          claudeSessionId: this.claudeSessionId,
          messageType: message.type,
          messageSubtype: "subtype" in message ? message.subtype : undefined,
          messageUuid: "uuid" in message ? message.uuid : undefined,
        },
        "Claude query pump: raw SDK message",
      );
    };
    const handlePumpedMessage = async (message: SDKMessage): Promise<boolean> => {
      logRawMessage(message);
      consecutiveInterruptAbortRecoveries = 0;
      if (await this.handleMissingResumedConversation(message, activeQuery)) {
        return true;
      }
      this.routeSdkMessageFromPump(message);
      return false;
    };
    const drainActiveQuery = async (): Promise<boolean> => {
      for await (const message of activeQuery) {
        if (await handlePumpedMessage(message)) {
          return true;
        }
      }
      return false;
    };
    try {
      while (!this.closed && this.query === activeQuery) {
        try {
          if (await drainActiveQuery()) {
            return;
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

  private isEchoedForegroundUserMessage(event: AgentStreamEvent): boolean {
    if (
      event.type !== "timeline" ||
      event.item.type !== "user_message" ||
      !this.activeForegroundTurnId ||
      !this.lastForegroundPromptText
    ) {
      return false;
    }
    return event.item.text.trim() === this.lastForegroundPromptText.trim();
  }

  private shouldSuppressStaleResult(message: SDKMessage): boolean {
    // Suppress stale results from interrupted requests. The cancel path already
    // emitted the terminal event; this result is leftover from the killed API
    // request. Consume the flag on ANY result so it doesn't linger.
    if (message.type === "result" && this.pendingInterruptAbort) {
      this.pendingInterruptAbort = false;
      if (message.subtype !== "success") {
        this.logger.debug("Suppressing stale non-success result from interrupted request");
        return true;
      }
    }
    if (message.type === "result" && message.subtype !== "success" && this.isAbortError(message)) {
      this.logger.debug("Suppressing abort result by content");
      return true;
    }
    return false;
  }

  private isAssistantishMessage(message: SDKMessage): boolean {
    return (
      message.type === "assistant" ||
      message.type === "stream_event" ||
      message.type === "tool_progress" ||
      (message.type === "system" && message.subtype === "task_notification")
    );
  }

  private routeSdkMessageFromPump(message: SDKMessage): void {
    if (this.shouldSuppressStaleResult(message)) {
      return;
    }

    const isForeground = Boolean(this.activeForegroundTurnId);
    if (!isForeground && this.isAssistantishMessage(message)) {
      this.startAutonomousTurn();
    }
    if (!isForeground && !this.autonomousTurn && message.type === "result") {
      return;
    }

    const turnId = this.activeForegroundTurnId ?? this.autonomousTurn?.id ?? null;
    const identifiers = readEventIdentifiers(message);

    if (claudeDebug) {
      this.logger.trace(
        {
          claudeSessionId: this.claudeSessionId,
          messageType: message.type,
          turnId,
        },
        "Claude query pump: SDK message",
      );
    }

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
    const filteredMessageEvents = messageEvents.filter(
      (event) => !this.isEchoedForegroundUserMessage(event),
    );

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
    activeQuery: Query,
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
      activeQuery.return?.(),
      "query pump return on missing resumed conversation",
    );
    if (this.query === activeQuery) {
      this.query = null;
      this.input = null;
    }
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
    const sessionCapture = this.captureSessionIdFromMessage(message);
    if (sessionCapture.notice) {
      events.push({
        type: "timeline",
        provider: "claude",
        item: sessionCapture.notice,
      });
    }
    if (sessionCapture.threadStartedSessionId) {
      events.push({
        type: "thread_started",
        provider: "claude",
        sessionId: sessionCapture.threadStartedSessionId,
      });
    }

    switch (message.type) {
      case "system":
        this.appendSystemMessageEvents(message, events);
        break;
      case "user":
        this.appendUserMessageEvents(message, events);
        break;
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
      case "stream_event":
        this.appendStreamEventEvents(message, events, options);
        break;
      case "result":
        this.appendResultEvents(message, events);
        break;
      default:
        break;
    }

    return events;
  }

  private appendSystemMessageEvents(
    message: Extract<SDKMessage, { type: "system" }>,
    events: AgentStreamEvent[],
  ): void {
    if (message.subtype === "init") {
      const sessionUpdate = this.handleSystemMessage(message);
      if (sessionUpdate.notice) {
        events.push({
          type: "timeline",
          provider: "claude",
          item: sessionUpdate.notice,
        });
      }
      if (sessionUpdate.threadStartedSessionId) {
        events.push({
          type: "thread_started",
          provider: "claude",
          sessionId: sessionUpdate.threadStartedSessionId,
        });
      }
      return;
    }
    if (message.subtype === "status") {
      const status = toObjectRecord(message)?.status;
      if (status === "compacting") {
        this.compacting = true;
        events.push({
          type: "timeline",
          item: { type: "compaction", status: "loading" },
          provider: "claude",
        });
      }
      return;
    }
    if (message.subtype === "compact_boundary") {
      const compactMetadata = readCompactionMetadata(message);
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
      return;
    }
    if (message.subtype === "task_notification") {
      // TODO: subagent timelines are best-effort. Subagent task_notifications
      // arrive without parent_tool_use_id but with tool_use_id pointing at the
      // parent's Task call, so they slip past the sidechain router and pollute
      // the parent timeline. Drop them here; eventually thread them into the
      // parent Task tool call's sub_agent log instead.
      const taskUseId = message.tool_use_id;
      const cachedTool = taskUseId ? this.toolUseCache.get(taskUseId) : undefined;
      if (cachedTool?.name === "Task") {
        return;
      }
      const taskNotificationItem = mapTaskNotificationSystemRecordToToolCall(message);
      if (taskNotificationItem) {
        events.push({
          type: "timeline",
          item: taskNotificationItem,
          provider: "claude",
        });
      }
      const usage = readUsageFromTaskNotification(message);
      if (typeof usage === "number") {
        this.lastContextWindowUsedTokens = usage;
        events.push(this.createUsageUpdatedEvent(usage));
      }
      return;
    }
    if (message.subtype === "task_progress") {
      this.lastContextWindowUsedTokens =
        readContextWindowUsedTokensFromTaskProgress(message) ?? this.lastContextWindowUsedTokens;
      if (typeof this.lastContextWindowUsedTokens === "number") {
        events.push(this.createUsageUpdatedEvent(this.lastContextWindowUsedTokens));
      }
    }
  }

  private appendUserMessageEvents(
    message: Extract<SDKMessage, { type: "user" }>,
    events: AgentStreamEvent[],
  ): void {
    if (isSyntheticUserEntry(message)) {
      return;
    }
    if (this.compacting) {
      this.compacting = false;
      return;
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
      return;
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
      return;
    }
    if (Array.isArray(content)) {
      this.appendUserContentArrayEvents(content, messageId, events);
    }
  }

  private appendUserContentArrayEvents(
    content: ReadonlyArray<unknown>,
    messageId: string | undefined,
    events: AgentStreamEvent[],
  ): void {
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

  private appendStreamEventEvents(
    message: Extract<SDKMessage, { type: "stream_event" }>,
    events: AgentStreamEvent[],
    options: { suppressAssistantText?: boolean; suppressReasoning?: boolean } | undefined,
  ): void {
    const usageUpdatedEvent = this.trackStreamEventUsage(message.event);
    if (usageUpdatedEvent) {
      events.push(usageUpdatedEvent);
    }
    const timelineItems = this.mapPartialEvent(message.event, {
      suppressAssistantText: options?.suppressAssistantText ?? false,
      suppressReasoning: options?.suppressReasoning ?? false,
    });
    for (const item of timelineItems) {
      events.push({ type: "timeline", item, provider: "claude" });
    }
  }

  private appendResultEvents(
    message: Extract<SDKMessage, { type: "result" }>,
    events: AgentStreamEvent[],
  ): void {
    const usage = this.convertUsage(message, message.modelUsage);
    if (message.subtype === "success") {
      events.push({ type: "turn_completed", provider: "claude", usage });
      return;
    }
    const errorMessage =
      "errors" in message && Array.isArray(message.errors) && message.errors.length > 0
        ? message.errors.join("\n")
        : "Claude run failed";
    events.push(this.buildTurnFailedEvent(errorMessage));
  }

  private createClaudeSessionChangedNotice(
    oldSessionId: string,
    newSessionId: string,
  ): AgentTimelineItem {
    return {
      type: "assistant_message",
      text: `Claude switched to a new session: ${oldSessionId} -> ${newSessionId}`,
    };
  }

  private captureSessionIdFromMessage(message: SDKMessage): {
    threadStartedSessionId: string | null;
    notice: AgentTimelineItem | null;
  } {
    const msgRecord = toObjectRecord(message) ?? {};
    const sessionId = extractSessionIdRaw({
      session_id: msgRecord.session_id,
      sessionId: msgRecord.sessionId,
      session: isObjectRecord(msgRecord.session) ? { id: msgRecord.session.id } : null,
    }).trim();
    if (!sessionId) {
      return { threadStartedSessionId: null, notice: null };
    }
    if (this.claudeSessionId === null) {
      this.claudeSessionId = sessionId;
      this.persistence = null;
      return { threadStartedSessionId: sessionId, notice: null };
    }
    if (this.claudeSessionId === sessionId) {
      return { threadStartedSessionId: null, notice: null };
    }
    const oldSessionId = this.claudeSessionId;
    // Session ID changed mid-stream (e.g. a hook caused Claude to restart
    // with a new session). Accept the new ID and continue — the turn should
    // not be failed just because the underlying subprocess cycled.
    this.logger.warn(
      { existingSessionId: this.claudeSessionId, newSessionId: sessionId },
      "Claude session ID changed in message; accepting new session",
    );
    this.claudeSessionId = sessionId;
    this.persistence = null;
    return {
      threadStartedSessionId: sessionId,
      notice: this.createClaudeSessionChangedNotice(oldSessionId, sessionId),
    };
  }

  private handleSystemMessage(message: SDKSystemMessage): {
    threadStartedSessionId: string | null;
    notice: AgentTimelineItem | null;
  } {
    if (message.subtype !== "init") {
      return { threadStartedSessionId: null, notice: null };
    }

    const msgRecord = toObjectRecord(message) ?? {};
    const newSessionId = extractSessionIdRaw({
      session_id: msgRecord.session_id,
      sessionId: msgRecord.sessionId,
      session: isObjectRecord(msgRecord.session) ? { id: msgRecord.session.id } : null,
    }).trim();
    if (!newSessionId) {
      return { threadStartedSessionId: null, notice: null };
    }
    const existingSessionId = this.claudeSessionId;
    let threadStartedSessionId: string | null = null;
    let notice: AgentTimelineItem | null = null;

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
      notice = this.createClaudeSessionChangedNotice(existingSessionId, newSessionId);
    }
    this.availableModes = DEFAULT_MODES;
    this.currentMode = message.permissionMode;
    if (this.currentMode !== "plan") {
      this.planResumeMode = this.currentMode;
    }
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
    return { threadStartedSessionId, notice };
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

  private convertUsage(message: SDKResultMessage, modelUsage?: unknown): AgentUsage | undefined {
    if (!message.usage) {
      return undefined;
    }
    const usage: AgentUsage = {
      inputTokens: message.usage.input_tokens,
      cachedInputTokens: message.usage.cache_read_input_tokens,
      outputTokens: message.usage.output_tokens,
      totalCostUsd: message.total_cost_usd,
    };
    const contextWindowMaxTokens = extractContextWindowSize(modelUsage ?? message.modelUsage);
    if (contextWindowMaxTokens !== undefined) {
      this.lastContextWindowMaxTokens = contextWindowMaxTokens;
      usage.contextWindowMaxTokens = contextWindowMaxTokens;
    } else if (this.lastContextWindowMaxTokens !== undefined) {
      usage.contextWindowMaxTokens = this.lastContextWindowMaxTokens;
    }
    if (typeof this.lastContextWindowUsedTokens === "number") {
      // task_progress.total_tokens is the accurate context window fill level.
      // Prefer it over result.usage which contains accumulated session totals.
      usage.contextWindowUsedTokens = this.lastContextWindowUsedTokens;
    } else if (
      typeof this.lastStreamRequestInputTokens === "number" &&
      typeof this.lastStreamRequestOutputTokens === "number"
    ) {
      usage.contextWindowUsedTokens =
        this.lastStreamRequestInputTokens + this.lastStreamRequestOutputTokens;
    } else if (message.usage) {
      // Fallback: derive from result.usage when no task_progress has been
      // received yet. These values are accumulated across all API calls, but
      // for the first turn they equal the per-call values so the estimate is
      // reasonable. Once a task_progress arrives it takes over permanently.
      const usageWithCacheCreation = message.usage as typeof message.usage & {
        cache_creation_input_tokens?: number;
      };
      const derived =
        (message.usage.input_tokens ?? 0) +
        (usageWithCacheCreation.cache_creation_input_tokens ?? 0) +
        (message.usage.cache_read_input_tokens ?? 0) +
        (message.usage.output_tokens ?? 0);
      if (Number.isFinite(derived) && derived > 0) {
        usage.contextWindowUsedTokens = derived;
      }
    }
    return usage;
  }

  private createUsageUpdatedEvent(contextWindowUsedTokens: number): AgentStreamEvent {
    const usage: AgentUsage = {
      contextWindowUsedTokens,
    };
    if (this.lastContextWindowMaxTokens !== undefined) {
      usage.contextWindowMaxTokens = this.lastContextWindowMaxTokens;
    }
    return {
      type: "usage_updated",
      provider: "claude",
      usage,
    };
  }

  private trackStreamEventUsage(event: unknown): AgentStreamEvent | null {
    const streamEvent = toObjectRecord(event);
    if (!streamEvent) {
      return null;
    }
    const eventType = readTrimmedString(streamEvent.type);
    if (eventType === "message_start") {
      const inputTokens = readStreamRequestInputTokens(streamEvent);
      if (typeof inputTokens !== "number") {
        return null;
      }
      this.lastStreamRequestInputTokens = inputTokens;
      this.lastStreamRequestOutputTokens = 0;
    } else if (eventType === "message_delta") {
      const outputTokens = readStreamRequestOutputTokens(streamEvent);
      if (typeof outputTokens !== "number") {
        return null;
      }
      this.lastStreamRequestOutputTokens = outputTokens;
    } else {
      return null;
    }

    if (
      typeof this.lastStreamRequestInputTokens !== "number" ||
      typeof this.lastStreamRequestOutputTokens !== "number"
    ) {
      return null;
    }
    return this.createUsageUpdatedEvent(
      this.lastStreamRequestInputTokens + this.lastStreamRequestOutputTokens,
    );
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
      suggestions: options.suggestions?.map((suggestion) => ({
        ...suggestion,
      })),
      actions: kind === "plan" ? buildClaudePlanPermissionActions(this.planResumeMode) : undefined,
      metadata: Object.keys(metadata).length ? metadata : undefined,
    };

    this.pushEvent({
      type: "permission_requested",
      provider: "claude",
      request,
    });

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
    } catch {
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
      const parsed: unknown = JSON.parse(trimmed);
      const record = toObjectRecord(parsed);
      if (!record) {
        return;
      }
      entry = record;
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
    const sanitized = sanitizeClaudeProjectPath(cwd);
    const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
    const dir = path.join(configDir, "projects", sanitized);
    return path.join(dir, `${sessionId}.jsonl`);
  }

  private convertHistoryEntry(entry: ClaudeHistoryEntry): AgentTimelineItem[] {
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
    content: string | ReadonlyArray<unknown>,
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
      if (!isClaudeContentChunk(block)) {
        continue;
      }
      this.mapBlockToTimeline(block, {
        items,
        userTextParts,
        textMessageType,
        suppressText,
        suppressReasoning,
      });
    }

    if (textMessageType === "user_message" && userTextParts.length > 0) {
      items.unshift({
        type: "user_message",
        text: userTextParts.join("\n\n"),
      });
    }

    return items;
  }

  private appendTextBlockToTimeline(
    block: ClaudeContentChunk,
    context: {
      items: AgentTimelineItem[];
      userTextParts: string[];
      textMessageType: "assistant_message" | "user_message";
      suppressText: boolean;
    },
  ): void {
    const { items, userTextParts, textMessageType, suppressText } = context;
    const text = typeof block.text === "string" ? block.text : "";
    if (!text || text === INTERRUPT_TOOL_USE_PLACEHOLDER || isClaudeTranscriptNoiseText(text)) {
      return;
    }
    if (textMessageType === "user_message") {
      const trimmed = text.trim();
      if (trimmed) {
        userTextParts.push(trimmed);
      }
      return;
    }
    if (!suppressText) {
      items.push({ type: "assistant_message", text });
    }
  }

  private mapBlockToTimeline(
    block: ClaudeContentChunk,
    context: {
      items: AgentTimelineItem[];
      userTextParts: string[];
      textMessageType: "assistant_message" | "user_message";
      suppressText: boolean;
      suppressReasoning: boolean;
    },
  ): void {
    switch (block.type) {
      case "text":
      case "text_delta":
        this.appendTextBlockToTimeline(block, context);
        break;
      case "thinking":
      case "thinking_delta":
        if (typeof block.thinking === "string" && block.thinking && !context.suppressReasoning) {
          context.items.push({ type: "reasoning", text: block.thinking });
        }
        break;
      case "tool_use":
      case "server_tool_use":
      case "mcp_tool_use":
        this.handleToolUseStart(block, context.items);
        break;
      case "tool_result":
      case "mcp_tool_result":
      case "web_fetch_tool_result":
      case "web_search_tool_result":
      case "code_execution_tool_result":
      case "bash_code_execution_tool_result":
      case "text_editor_code_execution_tool_result":
        this.handleToolResult(block, context.items);
        break;
      default:
        break;
    }
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
    const blockToolName = typeof block.tool_name === "string" ? block.tool_name : undefined;
    const toolName = entry?.name ?? blockToolName ?? "tool";
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

    const blockServer = typeof block.server === "string" ? block.server : undefined;
    const blockToolName = typeof block.tool_name === "string" ? block.tool_name : undefined;
    const server = entry?.server ?? blockServer ?? "tool";
    const tool = entry?.name ?? blockToolName ?? "tool";
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

  private isCommandExecutionTool(
    normalizedServer: string,
    normalizedTool: string,
    input: AgentMetadata | null | undefined,
  ): boolean {
    if (
      normalizedServer.includes("bash") ||
      normalizedServer.includes("shell") ||
      normalizedServer.includes("command")
    ) {
      return true;
    }
    if (
      normalizedTool.includes("bash") ||
      normalizedTool.includes("shell") ||
      normalizedTool.includes("command")
    ) {
      return true;
    }
    return Boolean(input && (typeof input.command === "string" || Array.isArray(input.command)));
  }

  private static isFileWriteTool(normalizedTool: string): boolean {
    return (
      normalizedTool.includes("write") ||
      normalizedTool === "write_file" ||
      normalizedTool === "create_file"
    );
  }

  private static isFileEditTool(normalizedTool: string): boolean {
    return (
      normalizedTool.includes("edit") ||
      normalizedTool.includes("patch") ||
      normalizedTool === "apply_patch" ||
      normalizedTool === "apply_diff"
    );
  }

  private static isFileReadTool(normalizedTool: string): boolean {
    return (
      normalizedTool.includes("read") ||
      normalizedTool === "read_file" ||
      normalizedTool === "view_file"
    );
  }

  private buildStructuredToolResult(
    server: string,
    tool: string,
    output: string,
    input?: AgentMetadata | null,
  ): AgentMetadata | undefined {
    const normalizedServer = server.toLowerCase();
    const normalizedTool = tool.toLowerCase();

    if (this.isCommandExecutionTool(normalizedServer, normalizedTool, input)) {
      const command = this.extractCommandText(input ?? {}) ?? "command";
      return {
        type: "command",
        command,
        output,
        cwd: typeof input?.cwd === "string" ? input.cwd : undefined,
      };
    }

    if (
      ClaudeAgentSession.isFileWriteTool(normalizedTool) &&
      input &&
      typeof input.file_path === "string"
    ) {
      return {
        type: "file_write",
        filePath: input.file_path,
        oldContent: "",
        newContent: typeof input.content === "string" ? input.content : output,
      };
    }

    if (
      ClaudeAgentSession.isFileEditTool(normalizedTool) &&
      input &&
      typeof input.file_path === "string"
    ) {
      // Support both old_str/new_str and old_string/new_string parameter names
      const oldContent = firstStringField(input, "old_str", "old_string");
      const newContent = firstStringField(input, "new_str", "new_string");
      const diff = firstStringField(input, "patch", "diff");
      return {
        type: "file_edit",
        filePath: input.file_path,
        diff,
        oldContent,
        newContent,
      };
    }

    if (
      ClaudeAgentSession.isFileReadTool(normalizedTool) &&
      input &&
      typeof input.file_path === "string"
    ) {
      return {
        type: "file_read",
        filePath: input.file_path,
        content: output,
      };
    }

    return undefined;
  }

  private updatePartialEventToolState(event: SDKPartialAssistantMessage["event"]): boolean {
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
      return false;
    }
    if (event.type === "content_block_delta") {
      const delta = isClaudeContentChunk(event.delta) ? event.delta : null;
      if (delta?.type === "input_json_delta") {
        const partialJson = typeof delta.partial_json === "string" ? delta.partial_json : undefined;
        this.handleToolInputDelta(event.index, partialJson);
        return true;
      }
      return false;
    }
    if (event.type === "content_block_stop" && typeof event.index === "number") {
      const toolId = this.toolUseIndexToId.get(event.index);
      if (toolId) {
        this.toolUseIndexToId.delete(event.index);
        this.toolUseInputBuffers.delete(toolId);
      }
    }
    return false;
  }

  private mapPartialEvent(
    event: SDKPartialAssistantMessage["event"],
    options?: {
      suppressAssistantText?: boolean;
      suppressReasoning?: boolean;
    },
  ): AgentTimelineItem[] {
    if (this.updatePartialEventToolState(event)) {
      return [];
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
    const existing = this.toolUseCache.get(id) ?? createDefaultToolUseCacheEntry(id, block);

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

function readCompactionMetadata(source: unknown): { trigger?: string; preTokens?: number } | null {
  const sourceRecord = toObjectRecord(source);
  if (!sourceRecord) {
    return null;
  }
  const candidates = [
    sourceRecord.compact_metadata,
    sourceRecord.compactMetadata,
    sourceRecord.compactionMetadata,
  ];
  for (const candidate of candidates) {
    const metadata = toObjectRecord(candidate);
    if (!metadata) {
      continue;
    }
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

interface ClaudeHistoryEntry {
  type?: unknown;
  subtype?: unknown;
  isCompactSummary?: unknown;
  isSidechain?: unknown;
  uuid?: unknown;
  message?: { content?: unknown; [key: string]: unknown };
  [key: string]: unknown;
}

function convertClaudeHistoryEntryPreamble(
  entry: ClaudeHistoryEntry,
): { shortCircuit: AgentTimelineItem[] } | { proceed: { content: unknown } } {
  if (entry.type === "system" && entry.subtype === "compact_boundary") {
    const compactMetadata = readCompactionMetadata(entry);
    return {
      shortCircuit: [
        {
          type: "compaction",
          status: "completed",
          trigger: compactMetadata?.trigger === "manual" ? "manual" : "auto",
          preTokens: compactMetadata?.preTokens,
        },
      ],
    };
  }

  const taskNotificationItem = mapTaskNotificationSystemRecordToToolCall(entry);
  if (taskNotificationItem) {
    return { shortCircuit: [taskNotificationItem] };
  }

  if (entry.isCompactSummary) {
    return { shortCircuit: [] };
  }
  if (entry.type === "user" && isSyntheticUserEntry(entry)) {
    return { shortCircuit: [] };
  }

  const message = entry?.message;
  if (!message || !("content" in message)) {
    return { shortCircuit: [] };
  }

  const content = message.content;
  if (
    (entry.type === "user" || entry.type === "assistant") &&
    isClaudeTranscriptNoiseContent(content)
  ) {
    return { shortCircuit: [] };
  }

  return { proceed: { content } };
}

export function convertClaudeHistoryEntry(
  entry: ClaudeHistoryEntry,
  mapBlocks: (content: string | ClaudeContentChunk[]) => AgentTimelineItem[],
): AgentTimelineItem[] {
  const preamble = convertClaudeHistoryEntryPreamble(entry);
  if ("shortCircuit" in preamble) {
    return preamble.shortCircuit;
  }
  const { content } = preamble.proceed;
  const normalizedBlocks = normalizeHistoryBlocks(content);
  const contentValue = typeof content === "string" ? content : normalizedBlocks;
  const hasToolBlock = normalizedBlocks?.some((block) => hasToolLikeBlock(block)) ?? false;
  const userMessageId =
    entry.type === "user" && typeof entry.uuid === "string" && entry.uuid.length > 0
      ? entry.uuid
      : null;

  if (entry.type === "user") {
    const userTaskNotificationItem = mapTaskNotificationUserContentToToolCall({
      content,
      messageId: userMessageId,
    });
    if (userTaskNotificationItem) {
      return [userTaskNotificationItem];
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

interface ClaudeSessionCandidate {
  path: string;
  mtime: Date;
}

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
  const projectFileLists = await Promise.all(
    projectDirs.map(async (dirName) => {
      const projectPath = path.join(root, dirName);
      try {
        const stats = await fsPromises.stat(projectPath);
        if (!stats.isDirectory()) return { projectPath, files: [] as string[] };
        const files = await fsPromises.readdir(projectPath);
        return { projectPath, files };
      } catch {
        return { projectPath, files: [] as string[] };
      }
    }),
  );
  const fileEntries = projectFileLists.flatMap(({ projectPath, files }) =>
    files.filter((f) => f.endsWith(".jsonl")).map((f) => path.join(projectPath, f)),
  );
  const statResults = await Promise.all(
    fileEntries.map(async (fullPath) => {
      try {
        const fileStats = await fsPromises.stat(fullPath);
        return { path: fullPath, mtime: fileStats.mtime };
      } catch {
        return null;
      }
    }),
  );
  const candidates: ClaudeSessionCandidate[] = statResults.filter(
    (entry): entry is ClaudeSessionCandidate => entry !== null,
  );
  return candidates.sort((a, b) => b.mtime.getTime() - a.mtime.getTime()).slice(0, limit);
}

interface ClaudeSessionDescriptorAccumulator {
  sessionId: string | null;
  cwd: string | null;
  title: string | null;
  timeline: AgentTimelineItem[];
}

function isFinishedAccumulator(acc: ClaudeSessionDescriptorAccumulator): boolean {
  return Boolean(acc.sessionId && acc.cwd && acc.title);
}

function applyClaudeSessionEntryToAccumulator(
  entryRaw: unknown,
  acc: ClaudeSessionDescriptorAccumulator,
): void {
  const entry = toObjectRecord(entryRaw);
  if (!entry) {
    return;
  }
  if (entry.isSidechain) {
    return;
  }
  if (entry.type === "user" && isSyntheticUserEntry(entry)) {
    return;
  }
  if (!acc.sessionId && typeof entry.sessionId === "string") {
    acc.sessionId = entry.sessionId;
  }
  if (!acc.cwd && typeof entry.cwd === "string") {
    acc.cwd = entry.cwd;
  }
  if (entry.type === "user" && entry.message) {
    const text = extractClaudeUserText(entry.message);
    if (text) {
      if (!acc.title) {
        acc.title = text;
      }
      acc.timeline.push({ type: "user_message", text });
    }
    return;
  }
  if (entry.type === "assistant" && entry.message) {
    const text = extractClaudeUserText(entry.message);
    if (text) {
      acc.timeline.push({ type: "assistant_message", text });
    }
  }
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

  const acc: ClaudeSessionDescriptorAccumulator = {
    sessionId: null,
    cwd: null,
    title: null,
    timeline: [],
  };

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    applyClaudeSessionEntryToAccumulator(entry, acc);
    if (isFinishedAccumulator(acc)) {
      break;
    }
  }

  const { sessionId, cwd, title, timeline } = acc;

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

function extractClaudeUserText(messageRaw: unknown): string | null {
  const message = toObjectRecord(messageRaw);
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
  if (isUnknownArray(message.content)) {
    for (const block of message.content) {
      const blockRecord = toObjectRecord(block);
      if (blockRecord && typeof blockRecord.text === "string") {
        const normalized = blockRecord.text.trim();
        if (normalized && !isClaudeTranscriptNoiseText(normalized)) {
          return normalized;
        }
      }
    }
  }
  return null;
}
