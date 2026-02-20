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

/**
 * Per-turn context to track streaming state.
 * This prevents race conditions when multiple stream() calls overlap
 * (e.g., when an interrupt sends a new message before the previous one completes).
 */
interface TurnContext {
  streamedAssistantTextThisTurn: boolean;
  streamedReasoningThisTurn: boolean;
}

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

const DEFAULT_PERMISSION_TIMEOUT_MS = 120_000;

function isMetadata(value: unknown): value is AgentMetadata {
  return typeof value === "object" && value !== null;
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
    const hasEnvOverrides = Object.keys(this.runtimeSettings?.env ?? {}).length > 0;
    const commandMode = this.runtimeSettings?.command?.mode;
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
          this.runtimeSettings
        );
        return spawn(resolved.command, resolved.args, {
          cwd: spawnOptions.cwd,
          env: applyProviderEnv(spawnOptions.env, this.runtimeSettings),
          signal: spawnOptions.signal,
          stdio: ["pipe", "pipe", "pipe"],
        });
      },
    };
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
  private eventQueue: Pushable<AgentStreamEvent> | null = null;
  private persistedHistory: AgentTimelineItem[] = [];
  private historyPending = false;
  private turnCancelRequested = false;
  // NOTE: streamedAssistantTextThisTurn and streamedReasoningThisTurn were removed
  // These flags are now tracked per-turn via TurnContext to prevent race conditions
  // when multiple stream() calls overlap (e.g., interrupt + new message)
  private cancelCurrentTurn: (() => void) | null = null;
  // Track the pending interrupt promise so we can await it in processPrompt
  // This ensures the interrupt's response is consumed before we call query.next()
  private pendingInterruptPromise: Promise<void> | null = null;
  // Track the current turn ID and active turn promise to serialize concurrent stream() calls
  // and prevent race conditions where two processPrompt() loops run against the same query
  private currentTurnId = 0;
  private activeTurnPromise: Promise<void> | null = null;
  private cachedRuntimeInfo: AgentRuntimeInfo | null = null;
  private lastOptionsModel: string | null = null;
  private selectableModelIds: Set<string> | null = null;
  private activeSidechains = new Map<string, string>();
  private compacting = false;
  private queryRestartNeeded = false;
  private userMessageIds: string[] = [];

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
    // Increment turn ID to invalidate any in-flight processPrompt() loops from previous turns.
    // This prevents race conditions where an interrupted turn's events get mixed with the new turn.
    const turnId = ++this.currentTurnId;

    // Cancel the previous turn if one exists. The caller of interrupt() is responsible
    // for awaiting completion - the new turn just signals cancellation and proceeds.
    if (this.cancelCurrentTurn) {
      this.cancelCurrentTurn();
    }

    // Reset cancel flag at the start of each turn to prevent stale state from previous turns
    this.turnCancelRequested = false;

    const slashCommand = this.resolveSlashCommandInvocation(prompt);
    if (slashCommand?.commandName === REWIND_COMMAND_NAME) {
      yield* this.streamRewindCommand(slashCommand);
      return;
    }

    const sdkMessage = this.toSdkUserMessage(prompt);
    const queue = new Pushable<AgentStreamEvent>();
    this.eventQueue = queue;
    let finishedNaturally = false;
    let cancelIssued = false;
    const requestCancel = () => {
      if (cancelIssued) {
        return;
      }
      cancelIssued = true;
      this.turnCancelRequested = true;
      // Store the interrupt promise so processPrompt can await it before calling query.next()
      this.pendingInterruptPromise = this.interruptActiveTurn().catch((error) => {
        this.logger.warn({ err: error }, "Failed to interrupt during cancel");
      });
      this.flushPendingToolCalls();
      // Push turn_canceled before ending the queue so consumers get proper lifecycle signals
      queue.push({
        type: "turn_canceled",
        provider: "claude",
        reason: "Interrupted",
      });
      queue.end();
    };
    this.cancelCurrentTurn = requestCancel;

    // Start forwarding events and track the promise so future turns can wait for completion
    const forwardPromise = this.forwardPromptEvents(sdkMessage, queue, turnId);
    this.activeTurnPromise = forwardPromise;
    forwardPromise.catch((error) => {
      this.logger.error({ err: error }, "Unexpected error in forwardPromptEvents");
    });

    try {
      for await (const event of queue) {
        yield event;
        if (
          event.type === "turn_completed" ||
          event.type === "turn_failed" ||
          event.type === "turn_canceled"
        ) {
          finishedNaturally = true;
          break;
        }
      }
    } finally {
      if (!finishedNaturally && !cancelIssued) {
        requestCancel();
      }
      if (this.eventQueue === queue) {
        this.eventQueue = null;
      }
      if (this.cancelCurrentTurn === requestCancel) {
        this.cancelCurrentTurn = null;
      }
      // Clear the active turn promise if it's still ours
      if (this.activeTurnPromise === forwardPromise) {
        this.activeTurnPromise = null;
      }
    }
  }

  async interrupt(): Promise<void> {
    this.cancelCurrentTurn?.();
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
    this.rejectAllPendingPermissions(new Error("Claude session closed"));
    this.input?.end();
    await this.query?.interrupt?.();
    await this.query?.return?.();
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
    this.logger.debug({ options }, "claude query");
    this.input = input;
    this.query = query({ prompt: input, options });
    await this.primeSelectableModelIds(this.query);
    await this.query.setPermissionMode(this.currentMode);
    return this.query;
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
    const hasEnvOverrides = Object.keys(this.runtimeSettings?.env ?? {}).length > 0;
    const commandMode = this.runtimeSettings?.command?.mode;
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
          this.runtimeSettings
        );
        return spawn(resolved.command, resolved.args, {
          cwd: spawnOptions.cwd,
          env: applyProviderEnv(spawnOptions.env, this.runtimeSettings),
          signal: spawnOptions.signal,
          stdio: ["pipe", "pipe", "pipe"],
        });
      },
    };
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

  private async *processPrompt(
    sdkMessage: SDKUserMessage,
    turnId: number
  ): AsyncGenerator<SDKMessage, void, undefined> {
    // If there's a pending interrupt, await it BEFORE calling ensureQuery().
    // interruptActiveTurn() clears this.query after interrupt() returns,
    // so we must wait for it to complete before we try to get the query.
    if (this.pendingInterruptPromise) {
      await this.pendingInterruptPromise;
      this.pendingInterruptPromise = null;
    }

    // Check if we were superseded while waiting for the interrupt
    if (this.currentTurnId !== turnId) {
      return;
    }

    const query = await this.ensureQuery();
    if (!this.input) {
      throw new Error("Claude session input stream not initialized");
    }

    this.input.push(sdkMessage);

    while (true) {
      // Check if this turn has been superseded by a new one.
      if (this.currentTurnId !== turnId) {
        break;
      }

      const { value, done } = await query.next();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }

      // Double-check turn ID after awaiting, in case a new turn started while we waited
      if (this.currentTurnId !== turnId) {
        break;
      }

      yield value;
      if (value.type === "result") {
        break;
      }
    }
  }

  private async forwardPromptEvents(
    message: SDKUserMessage,
    queue: Pushable<AgentStreamEvent>,
    turnId: number
  ) {
    // Create a turn-local context to track streaming state.
    // This prevents race conditions when a new stream() call interrupts a running one.
    const turnContext: TurnContext = {
      streamedAssistantTextThisTurn: false,
      streamedReasoningThisTurn: false,
    };
    let completedNormally = false;
    try {
      for await (const sdkEvent of this.processPrompt(message, turnId)) {
        // Check if this turn has been superseded before pushing events
        if (this.currentTurnId !== turnId) {
          break;
        }
        const events = this.translateMessageToEvents(sdkEvent, turnContext);
        for (const event of events) {
          queue.push(event);
          if (event.type === "turn_completed") {
            completedNormally = true;
          }
        }
      }
    } catch (error) {
      if (!this.turnCancelRequested && this.currentTurnId === turnId) {
        queue.push({
          type: "turn_failed",
          provider: "claude",
          error: error instanceof Error ? error.message : "Claude stream failed",
        });
      }
    } finally {
      // Emit terminal event for superseded turns so consumers get proper lifecycle signals.
      // Use turn_canceled (not turn_failed) to distinguish intentional interruption from errors.
      // Only emit if not already emitted by requestCancel() (indicated by turnCancelRequested).
      const wasSuperseded = this.currentTurnId !== turnId;
      if (wasSuperseded && !completedNormally && !this.turnCancelRequested) {
        this.flushPendingToolCalls();
        queue.push({
          type: "turn_canceled",
          provider: "claude",
          reason: "Interrupted by new message",
        });
      }
      this.turnCancelRequested = false;
      queue.end();
    }
  }

  private async interruptActiveTurn(): Promise<void> {
    const queryToInterrupt = this.query;
    if (!queryToInterrupt || typeof queryToInterrupt.interrupt !== "function") {
      this.logger.info("interruptActiveTurn: no query to interrupt");
      return;
    }
    try {
      this.logger.info("interruptActiveTurn: calling query.interrupt()...");
      const t0 = Date.now();
      await queryToInterrupt.interrupt();
      this.logger.info({ durationMs: Date.now() - t0 }, "interruptActiveTurn: query.interrupt() returned");
      // After interrupt(), the query iterator is done (returns done: true).
      // Clear it so ensureQuery() creates a fresh query for the next turn.
      // Also end the input stream and call return() to clean up the SDK process.
      this.input?.end();
      this.logger.info("interruptActiveTurn: calling query.return()...");
      const t1 = Date.now();
      await queryToInterrupt.return?.();
      this.logger.info({ durationMs: Date.now() - t1 }, "interruptActiveTurn: query.return() returned");
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
    let toolName: string | undefined;

    if (message.type === "assistant") {
      const content = message.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (isClaudeContentChunk(block) &&
            (block.type === "tool_use" || block.type === "mcp_tool_use" || block.type === "server_tool_use") &&
            typeof block.name === "string"
          ) {
            toolName = block.name;
            break;
          }
        }
      }
    } else if (message.type === "stream_event") {
      const event = message.event;
      if (event.type === "content_block_start") {
        const cb = isClaudeContentChunk(event.content_block) ? event.content_block : null;
        if (cb?.type === "tool_use" && typeof cb.name === "string") {
          toolName = cb.name;
        }
      }
    } else if (message.type === "tool_progress") {
      toolName = message.tool_name;
    }

    if (!toolName) {
      return [];
    }

    const prev = this.activeSidechains.get(parentToolUseId);
    if (prev === toolName) {
      return [];
    }
    this.activeSidechains.set(parentToolUseId, toolName);

    const toolCall = mapClaudeRunningToolCall({
      name: "Task",
      callId: parentToolUseId,
      input: null,
      output: null,
      metadata: { subAgentActivity: toolName },
    });
    if (!toolCall) {
      return [];
    }

    return [
      {
        type: "timeline",
        item: toolCall,
        provider: "claude",
      },
    ];
  }

  private translateMessageToEvents(message: SDKMessage, turnContext: TurnContext): AgentStreamEvent[] {
    const parentToolUseId = "parent_tool_use_id" in message
      ? (message as { parent_tool_use_id: string | null }).parent_tool_use_id
      : null;
    if (parentToolUseId) {
      return this.handleSidechainMessage(message, parentToolUseId);
    }

    const events: AgentStreamEvent[] = [];

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
          const meta = (message as Record<string, unknown>).compact_metadata as
            { trigger?: string; pre_tokens?: number } | undefined;
          events.push({
            type: "timeline",
            item: {
              type: "compaction",
              status: "completed",
              trigger: meta?.trigger === "manual" ? "manual" : "auto",
              preTokens: meta?.pre_tokens,
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
          const timelineItems = this.mapBlocksToTimeline(content, { turnContext });
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
          turnContext,
          suppressAssistantText: turnContext.streamedAssistantTextThisTurn,
          suppressReasoning: turnContext.streamedReasoningThisTurn,
        });
        for (const item of timelineItems) {
          events.push({ type: "timeline", item, provider: "claude" });
        }
        break;
      }
      case "stream_event": {
        const timelineItems = this.mapPartialEvent(message.event, turnContext);
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
          events.push({ type: "turn_failed", provider: "claude", error: errorMessage });
        }
        break;
      }
      default:
        break;
    }

    return events;
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
    if (this.eventQueue) {
      this.eventQueue.push(event);
    }
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
      this.mapBlocksToTimeline(content, { context: "history" })
    );
  }

  private mapBlocksToTimeline(
    content: string | ClaudeContentChunk[],
    options?: {
      context?: "live" | "history";
      turnContext?: TurnContext;
      suppressAssistantText?: boolean;
      suppressReasoning?: boolean;
    }
  ): AgentTimelineItem[] {
    const context = options?.context ?? "live";
    const turnContext = options?.turnContext;
    const suppressAssistant = options?.suppressAssistantText ?? false;
    const suppressReasoning = options?.suppressReasoning ?? false;

    if (typeof content === "string") {
      if (!content || content === "[Request interrupted by user for tool use]") {
        return [];
      }
      if (context === "live" && turnContext) {
        turnContext.streamedAssistantTextThisTurn = true;
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
          if (block.text && block.text !== "[Request interrupted by user for tool use]") {
            if (context === "live" && turnContext) {
              turnContext.streamedAssistantTextThisTurn = true;
            }
            if (!suppressAssistant) {
              items.push({ type: "assistant_message", text: block.text });
            }
          }
          break;
        case "thinking":
        case "thinking_delta":
          if (block.thinking) {
            if (context === "live" && turnContext) {
              turnContext.streamedReasoningThisTurn = true;
            }
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
    const content = typeof block.content === "string" ? block.content : "";
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

  private mapPartialEvent(event: SDKPartialAssistantMessage["event"], turnContext: TurnContext): AgentTimelineItem[] {
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
          ? this.mapBlocksToTimeline([event.content_block], { turnContext })
          : [];
      case "content_block_delta":
        return isClaudeContentChunk(event.delta) ? this.mapBlocksToTimeline([event.delta], { turnContext }) : [];
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
    return [{
      type: "compaction",
      status: "completed",
      trigger: entry.compactMetadata?.trigger === "manual" ? "manual" : "auto",
      preTokens: entry.compactMetadata?.preTokens,
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
