import { execSync, spawn } from "node:child_process";
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
  type ModelInfo,
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
import { buildToolCallDisplayModel } from "../../../shared/tool-call-display.js";

import type {
  AgentCapabilityFlags,
  AgentClient,
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
  isProviderCommandAvailable,
  type ProviderRuntimeSettings,
} from "../provider-launch-config.js";
import { getOrchestratorModeInstructions } from "../orchestrator-instructions.js";

const fsPromises = promises;

type TurnState = "idle" | "foreground" | "autonomous";

type RunOwner = "foreground" | "autonomous";

type RunLifecycleState =
  | "queued"
  | "awaiting_response"
  | "streaming"
  | "finalizing"
  | "completed"
  | "interrupted"
  | "error";

type SessionLifecycleState = "running" | "permission" | "error" | "idle";

type RoutingReason =
  | "foreground"
  | "task_id"
  | "task_id_new"
  | "parent_message_id"
  | "message_id"
  | "unbound_autonomous"
  | "fallback"
  | "metadata";

type EventIdentifiers = {
  taskId: string | null;
  parentMessageId: string | null;
  messageId: string | null;
};

type RunRoute = {
  run: RunRecord | null;
  reason: RoutingReason;
};

type RunRecord = {
  id: string;
  owner: RunOwner;
  queue: Pushable<AgentStreamEvent> | null;
  state: RunLifecycleState;
  promptReplaySeen: boolean;
  taskIds: Set<string>;
  parentMessageIds: Set<string>;
  messageIds: Set<string>;
};

type ForegroundTurnState = {
  runId: string;
  queue: Pushable<AgentStreamEvent>;
};

function normalizeClaudeModelLabel(model: ModelInfo): string {
  const fallback = model.displayName?.trim() || model.value;
  const prefix = model.description?.split(/[·•]/)[0]?.trim() || "";
  if (!prefix) return fallback;

  // Prefer concrete versioned labels from description (e.g. "Opus 4.6",
  // "Sonnet 4.5"), especially when displayName is generic like
  // "Default (recommended)".
  if (/\d/.test(prefix)) {
    return prefix;
  }

  return fallback;
}

type NormalizeClaudeRuntimeModelIdOptions = {
  runtimeModelId: string;
  supportedModelIds: ReadonlySet<string> | null;
  configuredModelId?: string | null;
  currentModelId?: string | null;
};

function normalizeModelIdCandidate(modelId: string | null | undefined): string | null {
  if (typeof modelId !== "string") {
    return null;
  }
  const trimmed = modelId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function pickSupportedModelId(
  supportedModelIds: ReadonlySet<string>,
  candidate: string | null | undefined
): string | null {
  const normalizedCandidate = normalizeModelIdCandidate(candidate);
  if (!normalizedCandidate) {
    return null;
  }
  return supportedModelIds.has(normalizedCandidate) ? normalizedCandidate : null;
}

export function normalizeClaudeRuntimeModelId(
  options: NormalizeClaudeRuntimeModelIdOptions
): string {
  const runtimeModel = options.runtimeModelId.trim();
  if (!runtimeModel) {
    return runtimeModel;
  }

  const supportedModelIds = options.supportedModelIds;
  if (!supportedModelIds || supportedModelIds.size === 0) {
    return runtimeModel;
  }

  const lowerRuntimeModel = runtimeModel.toLowerCase();
  if (lowerRuntimeModel.includes("sonnet")) {
    const explicitSonnet = pickSupportedModelId(supportedModelIds, "sonnet");
    if (explicitSonnet) {
      return explicitSonnet;
    }
    const defaultAlias = pickSupportedModelId(supportedModelIds, "default");
    if (defaultAlias) {
      return defaultAlias;
    }
  }
  if (lowerRuntimeModel.includes("opus")) {
    const alias = pickSupportedModelId(supportedModelIds, "opus");
    if (alias) {
      return alias;
    }
  }
  if (lowerRuntimeModel.includes("haiku")) {
    const alias = pickSupportedModelId(supportedModelIds, "haiku");
    if (alias) {
      return alias;
    }
  }

  if (supportedModelIds.has(runtimeModel)) {
    return runtimeModel;
  }

  const configuredModelId = pickSupportedModelId(
    supportedModelIds,
    options.configuredModelId
  );
  if (configuredModelId) {
    return configuredModelId;
  }

  const currentModelId = pickSupportedModelId(
    supportedModelIds,
    options.currentModelId
  );
  if (currentModelId) {
    return currentModelId;
  }

  return runtimeModel;
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

const VALID_CLAUDE_MODES = new Set(
  DEFAULT_MODES.map((mode) => mode.id)
);

const REWIND_COMMAND_NAME = "rewind";
const REWIND_COMMAND: AgentSlashCommand = {
  name: REWIND_COMMAND_NAME,
  description: "Rewind tracked files to a previous user message",
  argumentHint: "[user_message_uuid]",
};
const INTERRUPT_TOOL_USE_PLACEHOLDER = "[Request interrupted by user for tool use]";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
};

type ClaudeAgentSessionOptions = {
  defaults?: { agents?: Record<string, AgentDefinition> };
  claudePath: string | null;
  runtimeSettings?: ProviderRuntimeSettings;
  handle?: AgentPersistenceHandle;
  logger: Logger;
};

function resolveClaudeBinary(): string {
  try {
    const claudePath = execSync("which claude", { encoding: "utf8" }).trim();
    if (claudePath) {
      return claudePath;
    }
  } catch {
    // fall through
  }
  throw new Error(
    "Claude CLI not found. Install claude or configure agents.providers.claude.command.mode='replace'."
  );
}

function resolveClaudeSpawnCommand(
  spawnOptions: SpawnOptions,
  runtimeSettings?: ProviderRuntimeSettings
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
      args: [...(commandConfig.args ?? []), ...spawnOptions.args],
    };
  }

  return {
    command: commandConfig.argv[0]!,
    args: [...commandConfig.argv.slice(1), ...spawnOptions.args],
  };
}

function applyRuntimeSettingsToClaudeOptions(
  options: ClaudeOptions,
  runtimeSettings?: ProviderRuntimeSettings
): ClaudeOptions {
  const hasEnvOverrides = Object.keys(runtimeSettings?.env ?? {}).length > 0;
  const commandMode = runtimeSettings?.command?.mode;
  const needsCustomSpawn =
    hasEnvOverrides || commandMode === "append" || commandMode === "replace";

  if (!needsCustomSpawn) {
    return options;
  }

  return {
    ...options,
    spawnClaudeCodeProcess: (spawnOptions) => {
      const resolved = resolveClaudeSpawnCommand(
        spawnOptions,
        runtimeSettings
      );
      return spawn(resolved.command, resolved.args, {
        cwd: spawnOptions.cwd,
        env: applyProviderEnv(spawnOptions.env, runtimeSettings),
        signal: spawnOptions.signal,
        stdio: ["pipe", "pipe", "pipe"],
      });
    },
  };
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
};

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
    const promptType =
      typeof prompt.type === "string" ? prompt.type : "custom";
    return {
      mode:
        promptType === "preset"
          ? ("preset" as const)
          : ("custom" as const),
      preset:
        typeof prompt.preset === "string" && prompt.preset.length > 0
          ? prompt.preset
          : null,
    };
  })();
  const mcpServerNames = options.mcpServers
    ? Object.keys(options.mcpServers).sort()
    : [];

  return {
    cwd: typeof options.cwd === "string" ? options.cwd : null,
    permissionMode:
      typeof options.permissionMode === "string"
        ? options.permissionMode
        : null,
    model: typeof options.model === "string" ? options.model : null,
    includePartialMessages: options.includePartialMessages === true,
    settingSources: Array.isArray(options.settingSources)
      ? options.settingSources
      : [],
    enableFileCheckpointing: options.enableFileCheckpointing === true,
    hasResume: typeof options.resume === "string" && options.resume.length > 0,
    maxThinkingTokens:
      typeof options.maxThinkingTokens === "number"
        ? options.maxThinkingTokens
        : null,
    hasEnv: !!options.env,
    envKeyCount: Object.keys(options.env ?? {}).length,
    hasMcpServers: mcpServerNames.length > 0,
    mcpServerNames,
    systemPromptMode: systemPromptSummary.mode,
    systemPromptPreset: systemPromptSummary.preset,
    hasCanUseTool: typeof options.canUseTool === "function",
    hasSpawnOverride: typeof options.spawnClaudeCodeProcess === "function",
    hasStderrHandler: typeof options.stderr === "function",
  };
}

function isToolResultTextBlock(
  value: unknown
): value is { type: "text"; text: string } {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "text" &&
    typeof (value as { text?: unknown }).text === "string"
  );
}

function normalizeForDeterministicString(
  value: unknown,
  seen: WeakSet<object>
): unknown {
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
    return value.map((entry) =>
      normalizeForDeterministicString(entry, seen)
    );
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
    const normalized = normalizeForDeterministicString(
      value,
      new WeakSet<object>()
    );
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


export function extractUserMessageText(content: unknown): string | null {
  if (typeof content === "string") {
    const normalized = content.trim();
    return normalized.length > 0 ? normalized : null;
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
      parts.push(text.trim());
      continue;
    }
    const input = typeof block.input === "string" ? block.input : undefined;
    if (input && input.trim()) {
      parts.push(input.trim());
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

type SubAgentActionEntry = {
  index: number;
  toolName: string;
  summary?: string;
};

type SubAgentActivityState = {
  subAgentType?: string;
  description?: string;
  actions: SubAgentActionEntry[];
  actionKeys: string[];
  nextActionIndex: number;
  actionIndexByKey: Map<string, number>;
};

type SubAgentActionCandidate = {
  key: string;
  toolName: string;
  input: unknown;
};

const DEFAULT_PERMISSION_TIMEOUT_MS = 120_000;
const MAX_SUB_AGENT_LOG_ENTRIES = 200;
const MAX_SUB_AGENT_SUMMARY_CHARS = 160;

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

function toClaudeSdkMcpConfig(
  config: McpServerConfig
): ClaudeSdkMcpServerConfig {
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
  input: Record<string, unknown>
): AgentPermissionRequestKind {
  if (toolName === "ExitPlanMode") return "plan";
  if (toolName === "AskUserQuestion" && Array.isArray(input.questions)) {
    return "question";
  }
  return "tool";
}

const ACTIVE_RUN_STATES = new Set<RunLifecycleState>([
  "queued",
  "awaiting_response",
  "streaming",
  "finalizing",
]);

class RunTracker {
  private readonly runs = new Map<string, RunRecord>();
  private readonly runByTaskId = new Map<string, string>();
  private readonly runByParentMessageId = new Map<string, string>();
  private readonly runByMessageId = new Map<string, string>();

  createRun(input: {
    id: string;
    owner: RunOwner;
    queue: Pushable<AgentStreamEvent> | null;
    promptReplaySeen?: boolean;
  }): RunRecord {
    const run: RunRecord = {
      id: input.id,
      owner: input.owner,
      queue: input.queue,
      state: "queued",
      promptReplaySeen: input.promptReplaySeen ?? true,
      taskIds: new Set<string>(),
      parentMessageIds: new Set<string>(),
      messageIds: new Set<string>(),
    };
    this.runs.set(run.id, run);
    return run;
  }

  getRun(runId: string): RunRecord | null {
    return this.runs.get(runId) ?? null;
  }

  getForegroundRun(): RunRecord | null {
    for (const run of this.runs.values()) {
      if (run.owner === "foreground" && this.isActive(run.state)) {
        return run;
      }
    }
    return null;
  }

  listActiveRuns(owner?: RunOwner): RunRecord[] {
    const runs: RunRecord[] = [];
    for (const run of this.runs.values()) {
      if (!this.isActive(run.state)) {
        continue;
      }
      if (owner && run.owner !== owner) {
        continue;
      }
      runs.push(run);
    }
    return runs;
  }

  hasActiveRuns(owner?: RunOwner): boolean {
    for (const run of this.runs.values()) {
      if (!this.isActive(run.state)) {
        continue;
      }
      if (owner && run.owner !== owner) {
        continue;
      }
      return true;
    }
    return false;
  }

  getLatestActiveRun(owner?: RunOwner): RunRecord | null {
    let latest: RunRecord | null = null;
    for (const run of this.runs.values()) {
      if (!this.isActive(run.state)) {
        continue;
      }
      if (owner && run.owner !== owner) {
        continue;
      }
      latest = run;
    }
    return latest;
  }

  isRunActive(run: RunRecord | null): boolean {
    if (!run) {
      return false;
    }
    return this.isActive(run.state);
  }

  resolveByIdentifiers(identifiers: EventIdentifiers): RunRoute {
    if (identifiers.taskId) {
      const run = this.resolveMappedRun(this.runByTaskId, identifiers.taskId);
      if (run) {
        return { run, reason: "task_id" };
      }
    }
    if (identifiers.parentMessageId) {
      const run = this.resolveMappedRun(
        this.runByParentMessageId,
        identifiers.parentMessageId
      );
      if (run) {
        return { run, reason: "parent_message_id" };
      }
    }
    if (identifiers.messageId) {
      const run = this.resolveMappedRun(
        this.runByMessageId,
        identifiers.messageId
      );
      if (run) {
        return { run, reason: "message_id" };
      }
    }
    return { run: null, reason: "metadata" };
  }

  bindIdentifiers(run: RunRecord, identifiers: EventIdentifiers): void {
    if (identifiers.taskId) {
      run.taskIds.add(identifiers.taskId);
      this.runByTaskId.set(identifiers.taskId, run.id);
    }
    if (identifiers.parentMessageId) {
      run.parentMessageIds.add(identifiers.parentMessageId);
      this.runByParentMessageId.set(identifiers.parentMessageId, run.id);
    }
    if (identifiers.messageId) {
      run.messageIds.add(identifiers.messageId);
      this.runByMessageId.set(identifiers.messageId, run.id);
    }
  }

  transition(run: RunRecord, nextState: RunLifecycleState): void {
    run.state = nextState;
  }

  complete(run: RunRecord, terminalState: "completed" | "interrupted" | "error"): void {
    run.state = terminalState;
    this.clearRunIndex(run);
  }

  deriveLifecycle(pendingPermissionCount: number): SessionLifecycleState {
    for (const run of this.runs.values()) {
      if (this.isActive(run.state)) {
        return "running";
      }
    }
    if (pendingPermissionCount > 0) {
      return "permission";
    }
    for (const run of this.runs.values()) {
      if (run.state === "error") {
        return "error";
      }
    }
    return "idle";
  }

  private resolveMappedRun(
    mapping: Map<string, string>,
    identifier: string
  ): RunRecord | null {
    const runId = mapping.get(identifier);
    if (!runId) {
      return null;
    }
    const run = this.runs.get(runId);
    if (!run || !this.isActive(run.state)) {
      mapping.delete(identifier);
      return null;
    }
    return run;
  }

  private clearRunIndex(run: RunRecord): void {
    for (const taskId of run.taskIds) {
      this.runByTaskId.delete(taskId);
    }
    for (const parentMessageId of run.parentMessageIds) {
      this.runByParentMessageId.delete(parentMessageId);
    }
    for (const messageId of run.messageIds) {
      this.runByMessageId.delete(messageId);
    }
    run.taskIds.clear();
    run.parentMessageIds.clear();
    run.messageIds.clear();
  }

  private isActive(state: RunLifecycleState): boolean {
    return ACTIVE_RUN_STATES.has(state);
  }
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
  private readonly activeMessageByRun = new Map<string, string>();
  private syntheticMessageCounter = 0;

  consume(input: {
    message: SDKMessage;
    runId: string | null;
    messageIdHint?: string | null;
  }): AgentTimelineItem[] {
    if (input.message.type === "assistant") {
      return this.consumeAssistantMessage(
        input.message,
        input.runId,
        input.messageIdHint ?? null
      );
    }
    if (input.message.type === "stream_event") {
      return this.consumeStreamEvent(
        input.message,
        input.runId,
        input.messageIdHint ?? null
      );
    }
    return [];
  }

  private consumeAssistantMessage(
    message: SDKMessage & { type: "assistant" },
    runId: string | null,
    messageIdHint: string | null
  ): AgentTimelineItem[] {
    const messageId =
      this.readMessageIdFromAssistantMessage(message) ??
      messageIdHint ??
      this.resolveMessageId({ runId, createIfMissing: true, messageId: null });
    if (!messageId) {
      return [];
    }
    const state = this.ensureMessageState(messageId, runId);
    const fragments = this.extractFragments(message.message?.content);
    return this.applyAbsoluteFragments(state, fragments);
  }

  private consumeStreamEvent(
    message: SDKMessage & { type: "stream_event" },
    runId: string | null,
    messageIdHint: string | null
  ): AgentTimelineItem[] {
    const event = message.event as Record<string, unknown>;
    const eventType = readTrimmedString(event.type);
    const streamEventMessageId =
      this.readMessageIdFromStreamEvent(event) ?? messageIdHint;

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
      return this.consumeDeltaContent(
        event.content_block,
        runId,
        streamEventMessageId
      );
    }

    if (eventType === "content_block_delta") {
      return this.consumeDeltaContent(event.delta, runId, streamEventMessageId);
    }

    return [];
  }

  private consumeDeltaContent(
    content: unknown,
    runId: string | null,
    messageIdHint: string | null
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
    fragments: TimelineFragment[]
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
    fragments: TimelineFragment[]
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

  private finalizeMessage(
    messageId: string,
    runId: string | null
  ): AgentTimelineItem[] {
    const state = this.messages.get(messageId);
    if (!state) {
      return [];
    }
    state.stopped = true;
    const items = this.emitNewContent(state);
    if (runId && this.activeMessageByRun.get(runId) === messageId) {
      this.activeMessageByRun.delete(runId);
    }
    return items;
  }

  private emitNewContent(state: TimelineMessageState): AgentTimelineItem[] {
    const items: AgentTimelineItem[] = [];
    const nextAssistantText = state.assistantText.slice(state.emittedAssistantLength);
    if (
      nextAssistantText.length > 0 &&
      nextAssistantText !== INTERRUPT_TOOL_USE_PLACEHOLDER
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

  private ensureMessageState(
    messageId: string,
    runId: string | null
  ): TimelineMessageState {
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
    message: SDKMessage & { type: "assistant" }
  ): string | null {
    const candidate = message as unknown as {
      message_id?: unknown;
      message?: { id?: unknown } | null;
    };
    return readTrimmedString(candidate.message_id) ??
      readTrimmedString(candidate.message?.id) ??
      null;
  }

  private readMessageIdFromStreamEvent(
    event: Record<string, unknown>
  ): string | null {
    const message = event.message as { id?: unknown } | undefined;
    return (
      readTrimmedString(event.message_id) ??
      readTrimmedString(message?.id) ??
      null
    );
  }
}

function isMetadataOnlySdkMessage(message: SDKMessage): boolean {
  if (message.type === "system") {
    return true;
  }
  if (message.type !== "user") {
    return false;
  }
  return isTaskNotificationUserContent(message.message?.content);
}

function readEventIdentifiers(message: SDKMessage): EventIdentifiers {
  const root = message as unknown as Record<string, unknown>;
  const messageType = readTrimmedString(root.type);
  const streamEvent = root.event as Record<string, unknown> | undefined;
  const streamEventMessage = streamEvent?.message as
    | Record<string, unknown>
    | undefined;
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

function isTaskNotificationUserContent(content: unknown): boolean {
  if (typeof content === "string") {
    return content.includes("<task-notification>");
  }
  if (!Array.isArray(content)) {
    return false;
  }
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      typeof (block as { text?: unknown }).text === "string" &&
      (block as { text: string }).text.includes("<task-notification>")
    ) {
      return true;
    }
  }
  return false;
}

export class ClaudeAgentClient implements AgentClient {
  readonly provider: "claude" = "claude";
  readonly capabilities = CLAUDE_CAPABILITIES;

  private readonly defaults?: { agents?: Record<string, AgentDefinition> };
  private readonly logger: Logger;
  private readonly claudePath: string | null;
  private readonly runtimeSettings?: ProviderRuntimeSettings;

  constructor(options: ClaudeAgentClientOptions) {
    this.defaults = options.defaults;
    this.logger = options.logger.child({ module: "agent", provider: "claude" });
    this.runtimeSettings = options.runtimeSettings;
    try {
      this.claudePath = execSync("which claude", { encoding: "utf8" }).trim() || null;
    } catch {
      this.claudePath = null;
    }
  }

  private applyRuntimeSettings(options: ClaudeOptions): ClaudeOptions {
    return applyRuntimeSettingsToClaudeOptions(
      options,
      this.runtimeSettings
    );
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    const claudeConfig = this.assertConfig(config);
    return new ClaudeAgentSession(claudeConfig, {
      defaults: this.defaults,
      claudePath: this.claudePath,
      runtimeSettings: this.runtimeSettings,
      logger: this.logger,
    });
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>
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
      claudePath: this.claudePath,
      runtimeSettings: this.runtimeSettings,
      handle,
      logger: this.logger,
    });
  }

  async listModels(options?: ListModelsOptions): Promise<AgentModelDefinition[]> {
    const prompt = (async function* empty() {})();
    const claudeOptions: Options = {
      cwd: options?.cwd ?? process.cwd(),
      permissionMode: "plan",
      includePartialMessages: false,
      ...(this.claudePath ? { pathToClaudeCodeExecutable: this.claudePath } : {}),
    };

    const claudeQuery = query({
      prompt,
      options: this.applyRuntimeSettings(claudeOptions),
    });
    try {
      const models: ModelInfo[] = await claudeQuery.supportedModels();
      return models.map((model) => ({
        provider: "claude" as const,
        id: model.value,
        label: normalizeClaudeModelLabel(model),
        description: model.description,
        thinkingOptions: [
          { id: "off", label: "Off", isDefault: true },
          { id: "on", label: "On" },
        ],
        defaultThinkingOptionId: "off",
        metadata: {
          description: model.description,
        },
      }));
    } finally {
      if (typeof claudeQuery.return === "function") {
        try {
          await claudeQuery.return();
        } catch {
          // ignore shutdown errors
        }
      }
    }
  }

  async listPersistedAgents(options?: ListPersistedAgentsOptions): Promise<PersistedAgentDescriptor[]> {
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
    const commandConfig = this.runtimeSettings?.command;
    if (commandConfig?.mode === "replace") {
      return isProviderCommandAvailable(commandConfig, resolveClaudeBinary);
    }
    return this.claudePath !== null;
  }

  private assertConfig(config: AgentSessionConfig): ClaudeAgentConfig {
    if (config.provider !== "claude") {
      throw new Error(`ClaudeAgentClient received config for provider '${config.provider}'`);
    }
    return { ...config, provider: "claude" };
  }
}

class ClaudeAgentSession implements AgentSession {
  readonly provider: "claude" = "claude";
  readonly capabilities = CLAUDE_CAPABILITIES;

  private readonly config: ClaudeAgentConfig;
  private readonly defaults?: { agents?: Record<string, AgentDefinition> };
  private readonly claudePath: string | null;
  private readonly runtimeSettings?: ProviderRuntimeSettings;
  private readonly logger: Logger;
  private query: Query | null = null;
  private input: Pushable<SDKUserMessage> | null = null;
  private claudeSessionId: string | null;
  private persistence: AgentPersistenceHandle | null;
  private currentMode: PermissionMode;
  private availableModes: AgentMode[] = DEFAULT_MODES;
  private toolUseCache = new Map<string, ToolUseCacheEntry>();
  private toolUseIndexToId = new Map<number, string>();
  private toolUseInputBuffers = new Map<string, string>();
  private pendingPermissions = new Map<string, PendingPermission>();
  private activeForegroundTurn: ForegroundTurnState | null = null;
  private liveEventQueue = new Pushable<AgentStreamEvent>();
  private readonly runTracker = new RunTracker();
  private readonly timelineAssembler = new TimelineAssembler();
  private persistedHistory: AgentTimelineItem[] = [];
  private historyPending = false;
  private turnState: TurnState = "idle";
  private preReplayMetadataSeen = false;
  private pendingAutonomousWakeReservations = 0;
  private nextRunOrdinal = 1;
  private cancelCurrentTurn: (() => void) | null = null;
  private pendingInterruptPromise: Promise<void> | null = null;
  private activeTurnPromise: Promise<void> | null = null;
  private cachedRuntimeInfo: AgentRuntimeInfo | null = null;
  private lastOptionsModel: string | null = null;
  private selectableModelIds: Set<string> | null = null;
  private activeSidechains = new Map<string, SubAgentActivityState>();
  private compacting = false;
  private queryPumpPromise: Promise<void> | null = null;
  private queryRestartNeeded = false;
  private userMessageIds: string[] = [];
  private readonly localUserMessageIds = new Set<string>();
  private suppressLocalReplayActivity = false;
  private closed = false;

  constructor(
    config: ClaudeAgentConfig,
    options: ClaudeAgentSessionOptions
  ) {
    this.config = config;
    this.defaults = options.defaults;
    this.claudePath = options.claudePath;
    this.runtimeSettings = options.runtimeSettings;
    this.logger = options.logger;
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
        `Invalid mode '${config.modeId}' for Claude provider. Valid modes: ${validModesList}`
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
    };
    this.cachedRuntimeInfo = info;
    return { ...info };
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
          if (!finalText) {
            finalText = event.item.text;
          } else if (event.item.text.startsWith(finalText)) {
            finalText = event.item.text;
          } else {
            finalText += event.item.text;
          }
        }
      } else if (event.type === "turn_completed") {
        usage = event.usage;
      } else if (event.type === "turn_failed") {
        throw new Error(event.error);
      }
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

  async *stream(
    prompt: AgentPromptInput,
    options?: AgentRunOptions
  ): AsyncGenerator<AgentStreamEvent> {
    void options;
    if (this.cancelCurrentTurn) {
      this.cancelCurrentTurn();
    }
    this.suppressLocalReplayActivity = false;
    this.pendingAutonomousWakeReservations = 0;

    const slashCommand = this.resolveSlashCommandInvocation(prompt);
    if (slashCommand?.commandName === REWIND_COMMAND_NAME) {
      yield* this.streamRewindCommand(slashCommand);
      return;
    }

    await this.awaitPendingInterruptPromise();
    if (
      this.turnState === "autonomous" &&
      this.runTracker.hasActiveRuns("autonomous")
    ) {
      await this.transitionAutonomousToForeground();
    }

    const sdkMessage = this.toSdkUserMessage(prompt);
    const queue = new Pushable<AgentStreamEvent>();
    const run = this.createRun("foreground", queue);
    this.runTracker.bindIdentifiers(run, {
      taskId: null,
      parentMessageId: null,
      messageId: typeof sdkMessage.uuid === "string" ? sdkMessage.uuid : null,
    });
    const foregroundTurn: ForegroundTurnState = {
      runId: run.id,
      queue,
    };
    this.activeForegroundTurn = foregroundTurn;
    this.preReplayMetadataSeen = false;
    this.transitionTurnState("foreground", "foreground stream started");

    let finishedNaturally = false;
    let cancelIssued = false;
    let queueDrainedWithoutTerminal = false;
    const turnPromise = Promise.resolve();
    this.activeTurnPromise = turnPromise;

    const requestCancel = () => {
      if (cancelIssued) {
        return;
      }
      cancelIssued = true;
      if (this.activeForegroundTurn?.runId === run.id) {
        this.activeForegroundTurn = null;
      }
      if (this.cancelCurrentTurn === requestCancel) {
        this.cancelCurrentTurn = null;
      }
      this.cancelRun(run, {
        type: "turn_canceled",
        provider: "claude",
        reason: "Interrupted",
      });
      this.pendingInterruptPromise = this.interruptActiveTurn().catch((error) => {
        this.logger.warn({ err: error }, "Failed to interrupt during cancel");
      });
    };
    this.cancelCurrentTurn = requestCancel;

    try {
      await this.ensureQuery();
      if (!this.input) {
        throw new Error("Claude session input stream not initialized");
      }
      this.startQueryPump();
      this.input.push(sdkMessage);
    } catch (error) {
      this.failRun(
        run,
        error instanceof Error ? error.message : "Claude stream failed"
      );
      finishedNaturally = true;
    }

    try {
      for await (const event of queue) {
        const isTerminalEvent =
          event.type === "turn_completed" ||
          event.type === "turn_failed" ||
          event.type === "turn_canceled";
        if (isTerminalEvent) {
          finishedNaturally = true;
        }
        yield event;
        if (isTerminalEvent) {
          break;
        }
      }
      if (!finishedNaturally && !cancelIssued) {
        queueDrainedWithoutTerminal = true;
      }
    } finally {
      if (!finishedNaturally && !cancelIssued && !queueDrainedWithoutTerminal) {
        requestCancel();
      }
      if (this.activeForegroundTurn === foregroundTurn) {
        this.activeForegroundTurn = null;
      }
      if (this.cancelCurrentTurn === requestCancel) {
        this.cancelCurrentTurn = null;
      }
      if (this.activeTurnPromise === turnPromise) {
        this.activeTurnPromise = null;
      }
    }
  }

  async interrupt(): Promise<void> {
    if (this.cancelCurrentTurn) {
      this.cancelCurrentTurn();
      return;
    }

    const autonomousRuns = this.runTracker.listActiveRuns("autonomous");
    if (autonomousRuns.length > 0) {
      this.flushPendingToolCalls();
      for (const run of autonomousRuns) {
        this.emitRunEvent(run, {
          type: "turn_canceled",
          provider: "claude",
          reason: "Interrupted",
        });
      }
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

  async *streamLiveEvents(): AsyncGenerator<AgentStreamEvent> {
    if (this.claudeSessionId) {
      this.startQueryPump();
    }

    for await (const event of this.liveEventQueue) {
      yield event;
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
        `Invalid mode '${modeId}' for Claude provider. Valid modes: ${validModesList}`
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
    } else if (normalizedThinkingOptionId === "on") {
      this.config.thinkingOptionId = "on";
    } else if (normalizedThinkingOptionId === "off") {
      this.config.thinkingOptionId = "off";
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
        })
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
          })
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
      metadata: this.config,
    };
    return this.persistence;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.rejectAllPendingPermissions(new Error("Claude session closed"));
    this.cancelCurrentTurn?.();
    this.activeForegroundTurn?.queue.end();
    this.activeForegroundTurn = null;
    this.cancelCurrentTurn = null;
    this.turnState = "idle";
    this.suppressLocalReplayActivity = false;
    this.pendingAutonomousWakeReservations = 0;
    this.liveEventQueue.end();
    this.activeTurnPromise = null;
    this.input?.end();
    await this.awaitWithTimeout(this.query?.interrupt?.(), "close query interrupt");
    await this.awaitWithTimeout(this.query?.return?.(), "close query return");
    this.query = null;
    this.input = null;
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
    return Array.from(commandMap.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
  }

  private resolveSlashCommandInvocation(
    prompt: AgentPromptInput
  ): SlashCommandInvocation | null {
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
      firstWhitespaceIdx === -1
        ? withoutPrefix
        : withoutPrefix.slice(0, firstWhitespaceIdx);
    if (!commandName || commandName.includes("/")) {
      return null;
    }
    const rawArgs =
      firstWhitespaceIdx === -1
        ? ""
        : withoutPrefix.slice(firstWhitespaceIdx + 1).trim();
    return rawArgs.length > 0
      ? { commandName, args: rawArgs, rawInput: trimmed }
      : { commandName, rawInput: trimmed };
  }

  private async *streamRewindCommand(
    invocation: SlashCommandInvocation
  ): AsyncGenerator<AgentStreamEvent> {
    yield { type: "turn_started", provider: "claude" };

    try {
      const rewindAttempt = await this.attemptRewind(invocation.args);
      if (!rewindAttempt.messageId || !rewindAttempt.result) {
        yield {
          type: "turn_failed",
          provider: "claude",
          error:
            rewindAttempt.error ??
            "No prior user message available to rewind. Use /rewind <user_message_uuid>.",
        };
        return;
      }
      yield {
        type: "timeline",
        provider: "claude",
        item: {
          type: "assistant_message",
          text: this.buildRewindSuccessMessage(
            rewindAttempt.messageId,
            rewindAttempt.result
          ),
        },
      };
      yield { type: "turn_completed", provider: "claude" };
    } catch (error) {
      yield {
        type: "turn_failed",
        provider: "claude",
        error:
          error instanceof Error
            ? error.message
            : "Failed to rewind tracked files",
      };
    }
  }

  private buildRewindSuccessMessage(
    targetUserMessageId: string,
    rewindResult: { filesChanged?: string[]; insertions?: number; deletions?: number }
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

  private async attemptRewind(
    args: string | undefined
  ): Promise<{
    messageId: string | null;
    result?: { filesChanged?: string[]; insertions?: number; deletions?: number };
    error?: string;
  }> {
    if (typeof args === "string" && args.trim().length > 0) {
      const candidate = args.trim().split(/\s+/)[0] ?? "";
      if (!UUID_PATTERN.test(candidate)) {
        return {
          messageId: null,
          error:
            "Invalid message UUID. Usage: /rewind <user_message_uuid> or /rewind",
        };
      }
      const rewindResult = await this.rewindFilesOnce(candidate);
      if (rewindResult.canRewind) {
        return { messageId: candidate, result: rewindResult };
      }
      return {
        messageId: null,
        error:
          rewindResult.error ??
          `No file checkpoint found for message ${candidate}.`,
      };
    }

    const candidates = this.getRewindCandidateUserMessageIds();
    if (candidates.length === 0) {
      return {
        messageId: null,
        error:
          "No prior user message available to rewind. Use /rewind <user_message_uuid>.",
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
        lastError =
          error instanceof Error
            ? error.message
            : "Failed to rewind tracked files.";
      }
    }

    return {
      messageId: null,
      error:
        lastError ??
        "No rewind checkpoints are currently available for this session.",
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
      if (
        typeof value === "string" &&
        value.length > 0 &&
        !candidates.includes(value)
      ) {
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

  private async primeSelectableModelIds(query: Query): Promise<void> {
    try {
      const models = await query.supportedModels();
      const ids = models
        .map((model) => model.value?.trim())
        .filter((id): id is string => typeof id === "string" && id.length > 0);
      this.selectableModelIds = new Set(ids);
      this.logger.debug({ modelIds: ids }, "Primed Claude selectable model IDs");
    } catch (error) {
      this.selectableModelIds = null;
      this.logger.warn({ err: error }, "Failed to prime Claude selectable model IDs");
    }
  }

  private async ensureQuery(): Promise<Query> {
    if (this.query && !this.queryRestartNeeded) {
      return this.query;
    }

    if (this.queryRestartNeeded && this.query) {
      this.input?.end();
      try { await this.query.return?.(); } catch { /* ignore */ }
      this.query = null;
      this.input = null;
      this.queryRestartNeeded = false;
    }

    const input = new Pushable<SDKUserMessage>();
    const options = this.buildOptions();
    this.logger.debug(
      { options: summarizeClaudeOptionsForLog(options) },
      "claude query"
    );
    this.input = input;
    this.query = query({ prompt: input, options });
    // Do not block query readiness on control-plane calls. We need `next()` to
    // start immediately so autonomous wake events are not missed between turns.
    void this.awaitWithTimeout(
      this.primeSelectableModelIds(this.query),
      "prime selectable model ids"
    );
    return this.query;
  }

  private async awaitWithTimeout(
    promise: Promise<unknown> | undefined,
    label: string
  ): Promise<void> {
    if (!promise) {
      return;
    }
    try {
      await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("timeout")), 3_000);
        }),
      ]);
    } catch (error) {
      this.logger.warn({ err: error, label }, "Claude query operation did not settle cleanly");
    }
  }

  private buildOptions(): ClaudeOptions {
    const configuredThinkingOptionId = this.config.thinkingOptionId;
    const thinkingOptionId =
      configuredThinkingOptionId && configuredThinkingOptionId !== "default"
        ? configuredThinkingOptionId
        : "off";
    let maxThinkingTokens: number | undefined;
    if (thinkingOptionId === "on") {
      maxThinkingTokens = 10000;
    } else if (thinkingOptionId === "off") {
      maxThinkingTokens = 0;
    }

    const appendedSystemPrompt = [
      getOrchestratorModeInstructions(),
      this.config.systemPrompt?.trim(),
    ]
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      .join("\n\n");

    const base: ClaudeOptions = {
      cwd: this.config.cwd,
      includePartialMessages: true,
      permissionMode: this.currentMode,
      agents: this.defaults?.agents,
      canUseTool: this.handlePermissionRequest,
      ...(this.claudePath ? { pathToClaudeCodeExecutable: this.claudePath } : {}),
      // Use Claude Code preset system prompt and load CLAUDE.md files
      // Append provider-agnostic system prompt and orchestrator instructions for agents.
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: appendedSystemPrompt,
      },
      settingSources: ["user", "project"],
      stderr: (data: string) => {
        this.logger.error({ stderr: data.trim() }, "Claude Agent SDK stderr");
      },
      env: {
        ...process.env,
        // Increase MCP timeouts for long-running tool calls (10 minutes)
        MCP_TIMEOUT: "600000",
        MCP_TOOL_TIMEOUT: "600000",
      },
      // Required for provider-level /rewind support.
      enableFileCheckpointing: true,
      // If we have a session ID from a previous query (e.g., after interrupt),
      // resume that session to continue the conversation history.
      ...(this.claudeSessionId ? { resume: this.claudeSessionId } : {}),
      ...(maxThinkingTokens !== undefined ? { maxThinkingTokens } : {}),
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
    return applyRuntimeSettingsToClaudeOptions(
      options,
      this.runtimeSettings
    );
  }

  private normalizeMcpServers(
    servers: Record<string, McpServerConfig>
  ): Record<string, ClaudeSdkMcpServerConfig> {
    const result: Record<string, ClaudeSdkMcpServerConfig> = {};
    for (const [name, config] of Object.entries(servers)) {
      result[name] = toClaudeSdkMcpConfig(config);
    }
    return result;
  }

  private toSdkUserMessage(prompt: AgentPromptInput): SDKUserMessage {
    const content: Array<{ type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } }> = [];
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
    this.localUserMessageIds.add(messageId);

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

  private async awaitPendingInterruptPromise(): Promise<void> {
    if (!this.pendingInterruptPromise) {
      return;
    }
    await this.pendingInterruptPromise;
    this.pendingInterruptPromise = null;
  }

  private createRun(
    owner: RunOwner,
    queue: Pushable<AgentStreamEvent> | null
  ): RunRecord {
    const runId = `${owner}-run-${this.nextRunOrdinal++}`;
    const run = this.runTracker.createRun({
      id: runId,
      owner,
      queue,
      promptReplaySeen: owner === "autonomous",
    });
    this.logger.debug({ runId, owner, state: run.state }, "Created Claude run");
    return run;
  }

  private transitionTurnState(next: TurnState, reason: string): void {
    if (this.turnState === next) {
      return;
    }
    this.logger.debug(
      { from: this.turnState, to: next, reason },
      "Claude turn state transition"
    );
    this.turnState = next;
  }

  private transitionTurnStateFromActiveRuns(reason: string): void {
    if (this.runTracker.hasActiveRuns("foreground")) {
      this.transitionTurnState("foreground", reason);
      return;
    }
    if (this.runTracker.hasActiveRuns("autonomous")) {
      this.transitionTurnState("autonomous", reason);
      return;
    }
    this.transitionTurnState("idle", reason);
  }

  private failRun(run: RunRecord, errorMessage: string): void {
    this.emitRunEvent(run, {
      type: "turn_failed",
      provider: "claude",
      error: errorMessage,
    });
  }

  private cancelRun(
    run: RunRecord,
    event: Extract<AgentStreamEvent, { type: "turn_canceled" }>
  ): void {
    this.flushPendingToolCalls();
    this.emitRunEvent(run, event);
  }

  private emitRunEvent(run: RunRecord, event: AgentStreamEvent): void {
    this.logger.debug(
      { runId: run.id, owner: run.owner, eventType: event.type },
      "Claude run event dispatch"
    );
    if (run.owner === "foreground" && run.queue) {
      run.queue.push(event);
      if (
        event.type === "turn_completed" ||
        event.type === "turn_failed" ||
        event.type === "turn_canceled"
      ) {
        run.queue.end();
      }
    } else {
      this.liveEventQueue.push(event);
    }
    this.handleRunTerminalEvent(run, event);
  }

  private handleRunTerminalEvent(run: RunRecord, event: AgentStreamEvent): void {
    if (event.type === "turn_completed") {
      this.runTracker.complete(run, "completed");
    } else if (event.type === "turn_failed") {
      this.runTracker.complete(run, "error");
    } else if (event.type === "turn_canceled") {
      this.runTracker.complete(run, "interrupted");
    } else {
      return;
    }

    if (this.activeForegroundTurn?.runId === run.id) {
      this.activeForegroundTurn = null;
      this.preReplayMetadataSeen = false;
    }
    this.transitionTurnStateFromActiveRuns(`run ${run.id} terminal`);
    this.logDerivedSessionLifecycle("terminal_event");
  }

  private logDerivedSessionLifecycle(context: string): void {
    const lifecycle = this.runTracker.deriveLifecycle(this.pendingPermissions.size);
    this.logger.debug({ lifecycle, context }, "Claude session lifecycle derived");
  }

  private async transitionAutonomousToForeground(): Promise<void> {
    const autonomousRuns = this.runTracker.listActiveRuns("autonomous");
    if (autonomousRuns.length === 0) {
      this.transitionTurnStateFromActiveRuns("no autonomous runs to transition");
      return;
    }

    this.logger.debug(
      { runIds: autonomousRuns.map((run) => run.id) },
      "Transitioning autonomous runs to foreground ownership"
    );
    this.flushPendingToolCalls();
    for (const run of autonomousRuns) {
      this.emitRunEvent(run, {
        type: "turn_canceled",
        provider: "claude",
        reason: "Interrupted by foreground prompt",
      });
    }
    this.pendingInterruptPromise = this.interruptActiveTurn().catch((error) => {
      this.logger.warn(
        { err: error },
        "Failed to interrupt autonomous run during foreground transition"
      );
    });
    await this.awaitPendingInterruptPromise();
    this.transitionTurnStateFromActiveRuns("autonomous interrupted for foreground");
  }

  private routeMessage(
    normalized: {
      message: SDKMessage;
      identifiers: EventIdentifiers;
      metadataOnly: boolean;
    }
  ): RunRoute {
    if (normalized.metadataOnly) {
      if (
        normalized.message.type === "user" &&
        isTaskNotificationUserContent(normalized.message.message?.content)
      ) {
        this.reserveAutonomousWake("task_notification");
      }
      this.notePreReplayMetadata(normalized.message);
      return { run: null, reason: "metadata" };
    }

    const hasIdentifiers = Boolean(
      normalized.identifiers.taskId ||
        normalized.identifiers.parentMessageId ||
        normalized.identifiers.messageId
    );

    const byIdentifiers = this.runTracker.resolveByIdentifiers(normalized.identifiers);
    if (byIdentifiers.run) {
      return byIdentifiers;
    }

    if (this.turnState === "autonomous") {
      const activeAutonomousRun = this.runTracker.getLatestActiveRun("autonomous");
      if (activeAutonomousRun) {
        return { run: activeAutonomousRun, reason: "unbound_autonomous" };
      }
    }

    const foregroundRun = this.activeForegroundTurn
      ? this.runTracker.getRun(this.activeForegroundTurn.runId)
      : null;

    // A previously unseen task_id during foreground ownership is deterministic
    // evidence of a distinct autonomous wake/run, not foreground response text.
    if (
      this.turnState === "foreground" &&
      foregroundRun &&
      normalized.identifiers.taskId
    ) {
      const incomingTaskId = normalized.identifiers.taskId;
      // Foreground must claim its first task_id; otherwise early foreground
      // result events can be misrouted to autonomous fallback runs.
      if (foregroundRun.taskIds.size === 0) {
        if (foregroundRun.state !== "finalizing") {
          return { run: foregroundRun, reason: "foreground" };
        }
      } else if (foregroundRun.taskIds.has(incomingTaskId)) {
        return { run: foregroundRun, reason: "foreground" };
      }

      const autonomousRun = this.createRun("autonomous", null);
      this.emitRunEvent(autonomousRun, { type: "turn_started", provider: "claude" });
      return { run: autonomousRun, reason: "task_id_new" };
    }

    if (
      this.turnState === "foreground" &&
      foregroundRun &&
      this.shouldPreferForegroundRun({
        run: foregroundRun,
        message: normalized.message,
      })
    ) {
      return { run: foregroundRun, reason: "foreground" };
    }

    if (!hasIdentifiers) {
      if (this.pendingAutonomousWakeReservations > 0) {
        const reservedAutonomousRun = this.claimOrCreateAutonomousRun(
          "reservation_unbound"
        );
        return {
          run: reservedAutonomousRun,
          reason: "unbound_autonomous",
        };
      }
      const activeAutonomousRun = this.runTracker.getLatestActiveRun("autonomous");
      if (activeAutonomousRun) {
        return { run: activeAutonomousRun, reason: "unbound_autonomous" };
      }
    }

    if (this.pendingAutonomousWakeReservations > 0) {
      const reservedAutonomousRun = this.claimOrCreateAutonomousRun(
        "reservation_fallback"
      );
      return { run: reservedAutonomousRun, reason: "fallback" };
    }

    const autonomousRun = this.createRun("autonomous", null);
    this.emitRunEvent(autonomousRun, { type: "turn_started", provider: "claude" });
    return { run: autonomousRun, reason: "fallback" };
  }

  private shouldPreferForegroundRun(input: {
    run: RunRecord;
    message: SDKMessage;
  }): boolean {
    const { run, message } = input;
    if (
      run.state === "completed" ||
      run.state === "interrupted" ||
      run.state === "error"
    ) {
      return false;
    }

    // Before prompt replay is observed, prefer foreground by default so the
    // first turn cannot be stranded in autonomous fallback. If metadata churn
    // was observed pre-replay, stay conservative and wait for replay.
    if (!run.promptReplaySeen) {
      // Keep pre-replay result events with the foreground run so stale result
      // bursts cannot consume autonomous wake reservations.
      if (message.type === "result") {
        return true;
      }
      if (
        message.type === "assistant" ||
        message.type === "stream_event" ||
        message.type === "tool_progress"
      ) {
        return !this.preReplayMetadataSeen;
      }
      return true;
    }

    if (
      run.state === "finalizing" &&
      (message.type === "assistant" || message.type === "stream_event")
    ) {
      return false;
    }

    return true;
  }

  private notePreReplayMetadata(message: SDKMessage): void {
    if (this.turnState !== "foreground") {
      return;
    }
    const foregroundRun = this.activeForegroundTurn
      ? this.runTracker.getRun(this.activeForegroundTurn.runId)
      : null;
    if (!foregroundRun || foregroundRun.promptReplaySeen) {
      return;
    }
    if (message.type === "system" && message.subtype === "init") {
      return;
    }
    this.preReplayMetadataSeen = true;
  }

  private reserveAutonomousWake(reason: string): void {
    this.pendingAutonomousWakeReservations += 1;
    this.logger.debug(
      {
        reason,
        pendingAutonomousWakeReservations: this.pendingAutonomousWakeReservations,
      },
      "Reserved autonomous wake"
    );
  }

  private claimOrCreateAutonomousRun(reason: string): RunRecord {
    const existing = this.runTracker.getLatestActiveRun("autonomous");
    if (existing) {
      if (this.pendingAutonomousWakeReservations > 0) {
        this.pendingAutonomousWakeReservations -= 1;
      }
      this.logger.debug(
        {
          reason,
          runId: existing.id,
          pendingAutonomousWakeReservations: this.pendingAutonomousWakeReservations,
        },
        "Claimed autonomous wake reservation on existing run"
      );
      return existing;
    }

    const run = this.createRun("autonomous", null);
    this.emitRunEvent(run, { type: "turn_started", provider: "claude" });
    if (this.pendingAutonomousWakeReservations > 0) {
      this.pendingAutonomousWakeReservations -= 1;
    }
    this.logger.debug(
      {
        reason,
        runId: run.id,
        pendingAutonomousWakeReservations: this.pendingAutonomousWakeReservations,
      },
      "Claimed autonomous wake reservation with new run"
    );
    return run;
  }

  private startQueryPump(): void {
    if (this.closed || this.queryPumpPromise) {
      return;
    }

    const pump = this.runQueryPump().catch((error) => {
      this.logger.warn({ err: error }, "Claude query pump exited unexpectedly");
    });

    this.queryPumpPromise = pump;
    pump.finally(() => {
      if (this.queryPumpPromise === pump) {
        this.queryPumpPromise = null;
      }
    });
  }

  private async runQueryPump(): Promise<void> {
    while (!this.closed) {
      if (!this.claudeSessionId && !this.activeForegroundTurn && !this.query) {
        await this.waitForLiveHistoryPoll();
        continue;
      }

      let q: Query;
      try {
        q = await this.ensureQuery();
      } catch (error) {
        this.logger.warn({ err: error }, "Failed to initialize Claude query pump");
        await this.waitForLiveHistoryPoll();
        continue;
      }

      let next: IteratorResult<SDKMessage, void>;
      try {
        next = await q.next();
      } catch (error) {
        this.logger.warn({ err: error }, "Claude query pump next() failed");
        for (const run of this.runTracker.listActiveRuns()) {
          this.failRun(
            run,
            error instanceof Error ? error.message : "Claude stream failed"
          );
        }
        this.input?.end();
        await this.awaitWithTimeout(q.return?.(), "query pump return after failure");
        if (this.query === q) {
          this.query = null;
          this.input = null;
        }
        await this.waitForLiveHistoryPoll();
        continue;
      }

      if (next.done) {
        this.input?.end();
        await this.awaitWithTimeout(q.return?.(), "query pump return on done");
        if (this.query === q) {
          this.query = null;
          this.input = null;
        }
        const activeRuns = this.runTracker.listActiveRuns();
        if (activeRuns.length > 0) {
          for (const run of activeRuns) {
            this.failRun(run, "Claude stream ended before terminal result");
          }
        }
        await this.waitForLiveHistoryPoll();
        continue;
      }

      const sdkMessage = next.value;
      if (!sdkMessage) {
        continue;
      }

      try {
        this.routeSdkMessageFromPump(sdkMessage);
      } catch (error) {
        this.logger.warn({ err: error }, "Failed to route Claude SDK message from query pump");
      }
    }
  }

  private routeSdkMessageFromPump(message: SDKMessage): void {
    if (this.shouldSuppressLocalReplayActivity(message)) {
      return;
    }

    const identifiers = readEventIdentifiers(message);
    const metadataOnly = isMetadataOnlySdkMessage(message);
    const route = this.routeMessage({
      message,
      identifiers,
      metadataOnly,
    });
    const suppressTerminalEvents = this.shouldSuppressReplayResultTerminal({
      run: route.run,
      message,
    });
    if (route.run) {
      this.transitionTurnStateFromActiveRuns(`routed via ${route.reason}`);
      this.runTracker.bindIdentifiers(route.run, identifiers);
      if (!suppressTerminalEvents) {
        this.updateRunLifecycleForMessage(route.run, message, identifiers);
      }
    }

    this.logger.debug(
      {
        routeReason: route.reason,
        runId: route.run?.id ?? null,
        turnState: this.turnState,
        metadataOnly,
        identifiers,
      },
      "Claude query pump routing decision"
    );

    const messageEvents = this.translateMessageToEvents(message, {
      suppressAssistantText: true,
      suppressReasoning: true,
      suppressTerminalEvents,
    });
    const assistantTimelineItems = this.timelineAssembler.consume({
      message,
      runId: route.run?.id ?? null,
      messageIdHint: identifiers.messageId,
    });
    const assistantTimelineEvents: AgentStreamEvent[] = assistantTimelineItems.map(
      (item) => ({
        type: "timeline",
        item,
        provider: "claude",
      })
    );
    const events = [...messageEvents, ...assistantTimelineEvents];

    if (events.length === 0) {
      return;
    }

    if (!route.run) {
      this.dispatchMetadataEvents(events);
      return;
    }

    for (const event of events) {
      this.emitRunEvent(route.run, event);
    }
  }

  private shouldSuppressReplayResultTerminal(input: {
    run: RunRecord | null;
    message: SDKMessage;
  }): boolean {
    const { run, message } = input;
    if (!run || run.owner !== "foreground" || message.type !== "result") {
      return false;
    }
    if (run.promptReplaySeen) {
      return false;
    }
    if (run.state === "streaming" || run.state === "finalizing") {
      return false;
    }

    const resultSubtype =
      "subtype" in message && typeof message.subtype === "string"
        ? message.subtype
        : null;

    // Pre-replay success results are stale in practice (leftover from an
    // earlier query segment) and must not end the current foreground run.
    if (resultSubtype === "success") {
      return true;
    }

    // For non-success results, keep the metadata-churn guard to avoid
    // suppressing legitimate hard failures.
    return this.preReplayMetadataSeen;
  }

  private dispatchMetadataEvents(events: AgentStreamEvent[]): void {
    for (const event of events) {
      this.pushEvent(event);
    }
  }

  private updateRunLifecycleForMessage(
    run: RunRecord,
    message: SDKMessage,
    identifiers: EventIdentifiers
  ): void {
    if (
      message.type === "user" &&
      identifiers.messageId &&
      run.messageIds.has(identifiers.messageId)
    ) {
      run.promptReplaySeen = true;
      this.preReplayMetadataSeen = false;
    }

    if (run.state === "queued") {
      this.runTracker.transition(run, "awaiting_response");
    }

    if (
      message.type === "assistant" ||
      message.type === "stream_event" ||
      message.type === "tool_progress"
    ) {
      this.runTracker.transition(run, "streaming");
      this.logDerivedSessionLifecycle("streaming_event");
      return;
    }

    if (message.type === "result") {
      this.runTracker.transition(run, "finalizing");
      this.logDerivedSessionLifecycle("result_event");
      return;
    }

    this.logDerivedSessionLifecycle("non_terminal_event");
  }

  private shouldSuppressLocalReplayActivity(message: SDKMessage): boolean {
    const localReplay = this.isLocalReplayUserMessage(message);
    if (!this.activeForegroundTurn && localReplay) {
      this.suppressLocalReplayActivity = true;
      this.logger.debug(
        { uuid: (message as { uuid?: string }).uuid },
        "Suppressing local replay user message from live pump"
      );
      return true;
    }

    if (!this.suppressLocalReplayActivity) {
      return false;
    }

    // Suppress only replay scaffolding. Do not suppress autonomous
    // assistant/result events; otherwise task-notification replies can be dropped.
    if (localReplay) {
      return true;
    }

    if (message.type === "system") {
      return true;
    }

    const identifiers = readEventIdentifiers(message);
    const hasIdentifiers = Boolean(
      identifiers.taskId || identifiers.parentMessageId || identifiers.messageId
    );

    if (message.type !== "user" && !hasIdentifiers) {
      if (this.pendingAutonomousWakeReservations > 0) {
        this.suppressLocalReplayActivity = false;
        return false;
      }
      return true;
    }

    if (message.type === "user") {
      this.suppressLocalReplayActivity = false;
      return false;
    }

    this.suppressLocalReplayActivity = false;
    return false;
  }

  private isLocalReplayUserMessage(message: SDKMessage): boolean {
    if (message.type !== "user") {
      return false;
    }
    const uuid = readTrimmedString(
      (message as unknown as { uuid?: unknown }).uuid
    );
    if (!uuid) {
      return false;
    }
    return this.localUserMessageIds.has(uuid);
  }

  private async interruptActiveTurn(): Promise<void> {
    const queryToInterrupt = this.query;
    if (!queryToInterrupt || typeof queryToInterrupt.interrupt !== "function") {
      this.logger.debug("interruptActiveTurn: no query to interrupt");
      return;
    }
    try {
      this.logger.debug("interruptActiveTurn: calling query.interrupt()...");
      const t0 = Date.now();
      await queryToInterrupt.interrupt();
      this.logger.debug({ durationMs: Date.now() - t0 }, "interruptActiveTurn: query.interrupt() returned");
      // After interrupt(), the query iterator is done (returns done: true).
      // Clear it so ensureQuery() creates a fresh query for the next turn.
      // Also end the input stream and call return() to clean up the SDK process.
      this.input?.end();
      this.logger.debug("interruptActiveTurn: calling query.return()...");
      const t1 = Date.now();
      await queryToInterrupt.return?.();
      this.logger.debug({ durationMs: Date.now() - t1 }, "interruptActiveTurn: query.return() returned");
      this.query = null;
      this.input = null;
      this.queryRestartNeeded = false;
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to interrupt active turn");
      // If interrupt fails, the SDK iterator may remain in an indeterminate state.
      // Force a teardown/recreate path so the next turn cannot reuse stale query state.
      this.queryRestartNeeded = true;
    }
  }

  private handleSidechainMessage(
    message: SDKMessage,
    parentToolUseId: string
  ): AgentStreamEvent[] {
    const state =
      this.activeSidechains.get(parentToolUseId) ??
      ({
        actions: [],
        actionKeys: [],
        nextActionIndex: 1,
        actionIndexByKey: new Map<string, number>(),
      } satisfies SubAgentActivityState);
    this.activeSidechains.set(parentToolUseId, state);

    const contextUpdated = this.updateSubAgentContextFromTaskInput(
      state,
      parentToolUseId
    );
    const actionCandidates = this.extractSubAgentActionCandidates(message);
    let actionUpdated = false;
    for (const action of actionCandidates) {
      if (this.appendSubAgentAction(state, action)) {
        actionUpdated = true;
      }
    }

    if (!contextUpdated && !actionUpdated) {
      return [];
    }

    const toolCall = mapClaudeRunningToolCall({
      name: "Task",
      callId: parentToolUseId,
      input: null,
      output: null,
    });
    if (!toolCall) {
      return [];
    }

    const detail: Extract<AgentTimelineItem, { type: "tool_call" }>["detail"] = {
      type: "sub_agent",
      ...(state.subAgentType ? { subAgentType: state.subAgentType } : {}),
      ...(state.description ? { description: state.description } : {}),
      log: state.actions
        .map((action) =>
          action.summary
            ? `[${action.toolName}] ${action.summary}`
            : `[${action.toolName}]`
        )
        .join("\n"),
      actions: state.actions.map((action) => ({
        index: action.index,
        toolName: action.toolName,
        ...(action.summary ? { summary: action.summary } : {}),
      })),
    };

    return [
      {
        type: "timeline",
        item: {
          ...toolCall,
          detail,
        },
        provider: "claude",
      },
    ];
  }

  private updateSubAgentContextFromTaskInput(
    state: SubAgentActivityState,
    parentToolUseId: string
  ): boolean {
    const taskInput = this.toolUseCache.get(parentToolUseId)?.input;
    const nextSubAgentType = this.normalizeSubAgentText(taskInput?.subagent_type);
    const nextDescription = this.normalizeSubAgentText(taskInput?.description);

    let changed = false;
    if (nextSubAgentType && nextSubAgentType !== state.subAgentType) {
      state.subAgentType = nextSubAgentType;
      changed = true;
    }
    if (nextDescription && nextDescription !== state.description) {
      state.description = nextDescription;
      changed = true;
    }
    return changed;
  }

  private normalizeSubAgentText(value: unknown): string | undefined {
    const normalized = readTrimmedString(value)?.replace(/\s+/g, " ");
    if (!normalized) {
      return undefined;
    }
    if (normalized.length <= MAX_SUB_AGENT_SUMMARY_CHARS) {
      return normalized;
    }
    return `${normalized.slice(0, MAX_SUB_AGENT_SUMMARY_CHARS)}...`;
  }

  private extractSubAgentActionCandidates(
    message: SDKMessage
  ): SubAgentActionCandidate[] {
    if (message.type === "assistant") {
      const content = message.message?.content;
      if (!Array.isArray(content)) {
        return [];
      }
      const actions: SubAgentActionCandidate[] = [];
      for (const block of content) {
        if (
          !isClaudeContentChunk(block) ||
          !(
            block.type === "tool_use" ||
            block.type === "mcp_tool_use" ||
            block.type === "server_tool_use"
          ) ||
          typeof block.name !== "string"
        ) {
          continue;
        }
        const key =
          readTrimmedString(block.id) ??
          `assistant:${block.name}:${actions.length}`;
        actions.push({
          key,
          toolName: block.name,
          input: block.input ?? null,
        });
      }
      return actions;
    }

    if (message.type === "stream_event") {
      const event = message.event;
      if (event.type !== "content_block_start") {
        return [];
      }
      const block = isClaudeContentChunk(event.content_block)
        ? event.content_block
        : null;
      if (
        !block ||
        !(
          block.type === "tool_use" ||
          block.type === "mcp_tool_use" ||
          block.type === "server_tool_use"
        ) ||
        typeof block.name !== "string"
      ) {
        return [];
      }
      const key =
        readTrimmedString(block.id) ??
        `stream:${block.name}:${typeof event.index === "number" ? event.index : 0}`;
      return [
        {
          key,
          toolName: block.name,
          input: block.input ?? null,
        },
      ];
    }

    if (message.type === "tool_progress") {
      const toolName = readTrimmedString(message.tool_name);
      if (!toolName) {
        return [];
      }
      const key =
        readTrimmedString(message.tool_use_id) ?? `progress:${toolName}`;
      return [{ key, toolName, input: null }];
    }

    return [];
  }

  private appendSubAgentAction(
    state: SubAgentActivityState,
    candidate: SubAgentActionCandidate
  ): boolean {
    const normalizedToolName = readTrimmedString(candidate.toolName);
    if (!normalizedToolName) {
      return false;
    }

    const summary = this.deriveSubAgentActionSummary(
      normalizedToolName,
      candidate.input
    );
    const existingIndex = state.actionIndexByKey.get(candidate.key);

    if (existingIndex !== undefined) {
      const existing = state.actions[existingIndex];
      if (!existing) {
        return false;
      }
      const nextSummary = existing.summary ?? summary;
      const unchanged =
        existing.toolName === normalizedToolName &&
        existing.summary === nextSummary;
      if (unchanged) {
        return false;
      }
      state.actions[existingIndex] = {
        ...existing,
        toolName: normalizedToolName,
        ...(nextSummary ? { summary: nextSummary } : {}),
      };
      return true;
    }

    const nextEntry: SubAgentActionEntry = {
      index: state.nextActionIndex,
      toolName: normalizedToolName,
      ...(summary ? { summary } : {}),
    };
    state.nextActionIndex += 1;
    state.actions.push(nextEntry);
    state.actionKeys.push(candidate.key);
    this.trimSubAgentTail(state);
    this.rebuildSubAgentActionIndex(state);
    return true;
  }

  private trimSubAgentTail(state: SubAgentActivityState): void {
    while (state.actions.length > MAX_SUB_AGENT_LOG_ENTRIES) {
      state.actions.shift();
      state.actionKeys.shift();
    }
  }

  private rebuildSubAgentActionIndex(state: SubAgentActivityState): void {
    state.actionIndexByKey.clear();
    for (let index = 0; index < state.actionKeys.length; index += 1) {
      const key = state.actionKeys[index];
      if (key) {
        state.actionIndexByKey.set(key, index);
      }
    }
  }

  private deriveSubAgentActionSummary(
    toolName: string,
    input: unknown
  ): string | undefined {
    const runningToolCall = mapClaudeRunningToolCall({
      name: toolName,
      callId: `sub-agent-summary-${toolName}`,
      input,
      output: null,
    });
    if (!runningToolCall) {
      return undefined;
    }
    const display = buildToolCallDisplayModel({
      name: runningToolCall.name,
      status: runningToolCall.status,
      error: runningToolCall.error,
      detail: runningToolCall.detail,
      metadata: runningToolCall.metadata,
    });
    return this.normalizeSubAgentText(display.summary);
  }

  private translateMessageToEvents(
    message: SDKMessage,
    options?: {
      suppressAssistantText?: boolean;
      suppressReasoning?: boolean;
      suppressTerminalEvents?: boolean;
    }
  ): AgentStreamEvent[] {
    const parentToolUseId = "parent_tool_use_id" in message
      ? (message as { parent_tool_use_id: string | null }).parent_tool_use_id
      : null;
    if (parentToolUseId) {
      return this.handleSidechainMessage(message, parentToolUseId);
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
          const compactMetadata = readCompactionMetadata(
            message as Record<string, unknown>
          );
          events.push({
            type: "timeline",
            item: {
              type: "compaction",
              status: "completed",
              trigger:
                compactMetadata?.trigger === "manual" ? "manual" : "auto",
              preTokens: compactMetadata?.preTokens,
            },
            provider: "claude",
          });
        }
        break;
      case "user": {
        if (this.compacting) {
          this.compacting = false;
          break;
        }
        const messageId =
          typeof message.uuid === "string" && message.uuid.length > 0
            ? message.uuid
            : undefined;
        this.rememberUserMessageId(messageId);
        const content = message.message?.content;
        if (typeof content === "string" && content.length > 0) {
          // String content from user messages (e.g., local command output)
          events.push({
            type: "timeline",
            item: {
              type: "user_message",
              text: content,
              ...(messageId ? { messageId } : {}),
            },
            provider: "claude",
          });
        } else if (Array.isArray(content)) {
          const timelineItems = this.mapBlocksToTimeline(content);
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
        if (options?.suppressTerminalEvents) {
          break;
        }
        const usage = this.convertUsage(message);
        if (message.subtype === "success") {
          events.push({ type: "turn_completed", provider: "claude", usage });
        } else {
          const errorMessage =
            "errors" in message && Array.isArray(message.errors) && message.errors.length > 0
              ? message.errors.join("\n")
              : "Claude run failed";
          events.push({ type: "turn_failed", provider: "claude", error: errorMessage });
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
    throw new Error(
      `CRITICAL: Claude session ID overwrite detected! ` +
        `Existing: ${this.claudeSessionId}, New: ${sessionId}. ` +
        `This indicates a session identity corruption bug.`
    );
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
      // First time setting session ID (empty → filled) - this is expected
      this.claudeSessionId = newSessionId;
      threadStartedSessionId = newSessionId;
      this.logger.debug(
        { sessionId: newSessionId },
        "Claude session ID set for the first time"
      );
    } else if (existingSessionId === newSessionId) {
      // Same session ID - no-op, but log for visibility
      this.logger.debug(
        { sessionId: newSessionId },
        "Claude session ID unchanged (same value)"
      );
    } else {
      // CRITICAL: Session ID is being overwritten with a different value
      // This should NEVER happen and indicates a serious bug
      throw new Error(
        `CRITICAL: Claude session ID overwrite detected! ` +
          `Existing: ${existingSessionId}, New: ${newSessionId}. ` +
          `This indicates a session identity corruption bug.`
      );
    }
    this.availableModes = DEFAULT_MODES;
    this.currentMode = message.permissionMode;
    this.persistence = null;
    // Capture actual model from SDK init message (not just the configured model)
    if (message.model) {
      const normalizedModel = normalizeClaudeRuntimeModelId({
        runtimeModelId: message.model,
        supportedModelIds: this.selectableModelIds,
        configuredModelId: this.config.model ?? null,
        currentModelId: this.lastOptionsModel,
      });
      this.logger.debug(
        { model: message.model, normalizedModel },
        "Captured model from SDK init"
      );
      this.lastOptionsModel = normalizedModel;
      // Invalidate cached runtime info so it picks up the new model
      this.cachedRuntimeInfo = null;
    }
    return threadStartedSessionId;
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
    options
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
      const timeout = setTimeout(() => {
        this.pendingPermissions.delete(requestId);
        cleanup();
        const error = new Error("Permission request timed out");
        this.pushEvent({
          type: "permission_resolved",
          provider: "claude",
          requestId,
          resolution: { behavior: "deny", message: "timeout" },
        });
        reject(error);
      }, DEFAULT_PERMISSION_TIMEOUT_MS);
      cleanupFns.push(() => clearTimeout(timeout));

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
          })
        );
      }
    }
    this.toolUseCache.clear();
    this.activeSidechains.clear();
  }

  private pushToolCall(
    item: Extract<AgentTimelineItem, { type: "tool_call" }> | null,
    target?: AgentTimelineItem[]
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
    const foregroundTurn = this.activeForegroundTurn;
    if (foregroundTurn) {
      const run = this.runTracker.getRun(foregroundTurn.runId);
      if (
        run &&
        run.owner === "foreground" &&
        run.queue === foregroundTurn.queue &&
        this.runTracker.isRunActive(run)
      ) {
        foregroundTurn.queue.push(event);
        return;
      }
      this.activeForegroundTurn = null;
    }
    this.liveEventQueue.push(event);
  }

  private normalizePermissionUpdates(
    updates?: AgentPermissionUpdate[]
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

  private waitForLiveHistoryPoll(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 250));
  }

  private loadPersistedHistory(sessionId: string) {
    try {
      const historyPath = this.resolveHistoryPath(sessionId);
      if (!historyPath || !fs.existsSync(historyPath)) {
        return;
      }
      const content = fs.readFileSync(historyPath, "utf8");
      const timeline: AgentTimelineItem[] = [];
      for (const line of content.split(/\n+/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const entry = JSON.parse(trimmed);
          if (entry.isSidechain) {
            continue;
          }
          if (entry.type === "user" && typeof entry.uuid === "string") {
            this.rememberUserMessageId(entry.uuid);
          }
          const items = this.convertHistoryEntry(entry);
          if (items.length > 0) {
            timeline.push(...items);
          }
        } catch (error) {
          // ignore malformed history line
        }
      }
      if (timeline.length > 0) {
        this.persistedHistory = timeline;
        this.historyPending = true;
      }
    } catch (error) {
      // ignore history load failures
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
    return convertClaudeHistoryEntry(entry, (content) =>
      this.mapBlocksToTimeline(content)
    );
  }

  private mapBlocksToTimeline(
    content: string | ClaudeContentChunk[],
    options?: {
      suppressAssistantText?: boolean;
      suppressReasoning?: boolean;
    }
  ): AgentTimelineItem[] {
    const suppressAssistant = options?.suppressAssistantText ?? false;
    const suppressReasoning = options?.suppressReasoning ?? false;

    if (typeof content === "string") {
      if (!content || content === INTERRUPT_TOOL_USE_PLACEHOLDER) {
        return [];
      }
      if (suppressAssistant) {
        return [];
      }
      return [{ type: "assistant_message", text: content }];
    }

    const items: AgentTimelineItem[] = [];
    for (const block of content) {
      switch (block.type) {
        case "text":
        case "text_delta":
          if (block.text && block.text !== INTERRUPT_TOOL_USE_PLACEHOLDER) {
            if (!suppressAssistant) {
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
      items
    );
  }

  private handleToolResult(block: ClaudeContentChunk, items: AgentTimelineItem[]): void {
    const entry = typeof block.tool_use_id === "string" ? this.toolUseCache.get(block.tool_use_id) : undefined;
    const toolName = entry?.name ?? block.tool_name ?? "tool";
    const callId =
      typeof block.tool_use_id === "string" && block.tool_use_id.length > 0
        ? block.tool_use_id
        : entry?.id ?? null;

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
        items
      );
    } else {
      this.pushToolCall(
        mapClaudeCompletedToolCall({
          name: toolName,
          callId,
          input: entry?.input ?? null,
          output: output ?? null,
        }),
        items
      );
    }

    if (typeof block.tool_use_id === "string") {
      this.toolUseCache.delete(block.tool_use_id);
      this.activeSidechains.delete(block.tool_use_id);
    }
  }

  private buildToolOutput(
    block: ClaudeContentChunk,
    entry: ToolUseCacheEntry | undefined
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
    input?: AgentMetadata | null
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
        const oldContent = typeof input.old_str === "string" ? input.old_str : typeof input.old_string === "string" ? input.old_string : undefined;
        const newContent = typeof input.new_str === "string" ? input.new_str : typeof input.new_string === "string" ? input.new_string : undefined;
        return {
          type: "file_edit",
          filePath: input.file_path,
          diff: typeof input.patch === "string" ? input.patch : typeof input.diff === "string" ? input.diff : undefined,
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
    }
  ): AgentTimelineItem[] {
    if (event.type === "content_block_start") {
      const block = isClaudeContentChunk(event.content_block) ? event.content_block : null;
      if (block?.type === "tool_use" && typeof event.index === "number" && typeof block.id === "string") {
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

    if (block.type === "tool_use" || block.type === "mcp_tool_use" || block.type === "server_tool_use") {
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(buffer);
    } catch {
      return;
    }
    const entry = this.toolUseCache.get(toolId);
    const normalized = this.normalizeToolInput(parsed);
    if (!entry || !normalized) {
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
      })
    );
  }

  private normalizeToolInput(input: unknown): AgentMetadata | null {
    if (!isMetadata(input)) {
      return null;
    }
    return input;
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
    if (normalized.includes("bash") || normalized.includes("shell") || normalized.includes("terminal") || normalized.includes("command")) {
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
          files.push({ path: this.relativizePath(value) ?? value, kind: this.detectFileKind(value) });
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
  source: Record<string, unknown>
): { trigger?: string; preTokens?: number } | null {
  const candidates = [
    source.compact_metadata,
    source.compactMetadata,
    source.compactionMetadata,
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const metadata = candidate as Record<string, unknown>;
    const trigger =
      typeof metadata.trigger === "string" ? metadata.trigger : undefined;
    const preTokensRaw = metadata.preTokens ?? metadata.pre_tokens;
    const preTokens =
      typeof preTokensRaw === "number" ? preTokensRaw : undefined;
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
  mapBlocks: (content: string | ClaudeContentChunk[]) => AgentTimelineItem[]
): AgentTimelineItem[] {
  if (entry.type === "system" && entry.subtype === "compact_boundary") {
    const compactMetadata = readCompactionMetadata(
      entry as Record<string, unknown>
    );
    return [{
      type: "compaction",
      status: "completed",
      trigger: compactMetadata?.trigger === "manual" ? "manual" : "auto",
      preTokens: compactMetadata?.preTokens,
    }];
  }

  if (entry.isCompactSummary) {
    return [];
  }

  const message = entry?.message;
  if (!message || !("content" in message)) {
    return [];
  }

  const content = message.content;
  const normalizedBlocks = normalizeHistoryBlocks(content);
  const contentValue =
    typeof content === "string"
      ? content
      : normalizedBlocks;
  const hasToolBlock = normalizedBlocks?.some((block) => hasToolLikeBlock(block)) ?? false;
  const timeline: AgentTimelineItem[] = [];

  if (entry.type === "user") {
    const text = extractUserMessageText(content);
    if (text) {
      const messageId =
        typeof entry.uuid === "string" && entry.uuid.length > 0
          ? entry.uuid
          : undefined;
      timeline.push({
        type: "user_message",
        text,
        ...(messageId ? { messageId } : {}),
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

class Pushable<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private resolvers: Array<(value: IteratorResult<T, void>) => void> = [];
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
          const value = this.queue.shift();
          if (value !== undefined) {
            return Promise.resolve({ value, done: false });
          }
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

async function collectRecentClaudeSessions(root: string, limit: number): Promise<ClaudeSessionCandidate[]> {
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
  return candidates
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
    .slice(0, limit);
}

async function parseClaudeSessionDescriptor(
  filePath: string,
  mtime: Date
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
    return message.content.trim();
  }
  if (typeof message.text === "string") {
    return message.text.trim();
  }
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block && typeof block.text === "string") {
        return block.text.trim();
      }
    }
  }
  return null;
}
