import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { promises } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  query,
  type AgentDefinition,
  type CanUseTool,
  type McpServerConfig,
  type ModelInfo,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKPartialAssistantMessage,
  type SDKResultMessage,
  type SDKSystemMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";

import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentCommandResult,
  AgentMetadata,
  AgentMode,
  AgentModelDefinition,
  AgentPermissionRequest,
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
  PersistedAgentDescriptor,
} from "../agent-sdk-types.js";
import { getOrchestratorModeInstructions } from "../orchestrator-instructions.js";
import { getSelfIdentificationInstructions } from "../self-identification-instructions.js";

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
    label: "Bypass Permissions",
    description: "Skip all permission prompts (use with caution)",
  },
];

const VALID_CLAUDE_MODES = new Set(
  DEFAULT_MODES.map((mode) => mode.id)
);

// Orchestrator instructions moved to shared module.
type ClaudeAgentConfig = AgentSessionConfig & { provider: "claude" };

export type ClaudeContentChunk = { type: string; [key: string]: any };

type ClaudeMcpServerConfig = McpServerConfig;
type ClaudeOptions = Options;

type ClaudeAgentClientOptions = {
  defaults?: { agents?: Record<string, AgentDefinition> };
  logger: Logger;
};

type ClaudeAgentSessionOptions = {
  defaults?: { agents?: Record<string, AgentDefinition> };
  handle?: AgentPersistenceHandle;
  logger: Logger;
};

function appendCallerAgentId(url: string, agentId: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("callerAgentId", agentId);
    return parsed.toString();
  } catch {
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}callerAgentId=${encodeURIComponent(agentId)}`;
  }
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
type ToolCallTimelineItem = Extract<AgentTimelineItem, { type: "tool_call" }>;

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
  if (typeof metadata.reasoningEffort === "string") {
    result.reasoningEffort = metadata.reasoningEffort;
  }
  if (isMetadata(metadata.agentControlMcp)) {
    const url = metadata.agentControlMcp.url;
    const headers = metadata.agentControlMcp.headers;
    if (typeof url === "string") {
      const agentControlMcp: AgentSessionConfig["agentControlMcp"] = { url };
      if (isMetadata(headers)) {
        const normalizedHeaders: { [key: string]: string } = {};
        for (const [key, value] of Object.entries(headers)) {
          if (typeof value === "string") {
            normalizedHeaders[key] = value;
          }
        }
        if (Object.keys(normalizedHeaders).length > 0) {
          agentControlMcp.headers = normalizedHeaders;
        }
      }
      result.agentControlMcp = agentControlMcp;
    }
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
  if (isMetadata(metadata.mcpServers)) {
    result.mcpServers = metadata.mcpServers;
  }
  if (typeof metadata.parentAgentId === "string") {
    result.parentAgentId = metadata.parentAgentId;
  }

  return result;
}

function isClaudeMcpServerConfig(value: unknown): value is ClaudeMcpServerConfig {
  if (!isMetadata(value)) {
    return false;
  }
  return typeof value.type === "string" || typeof value.command === "string" || typeof value.url === "string";
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

export class ClaudeAgentClient implements AgentClient {
  readonly provider: "claude" = "claude";
  readonly capabilities = CLAUDE_CAPABILITIES;

  private readonly defaults?: { agents?: Record<string, AgentDefinition> };
  private readonly logger: Logger;

  constructor(options: ClaudeAgentClientOptions) {
    this.defaults = options.defaults;
    this.logger = options.logger.child({ module: "agent", provider: "claude" });
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    const claudeConfig = this.assertConfig(config);
    return new ClaudeAgentSession(claudeConfig, {
      defaults: this.defaults,
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
    };

    const claudeQuery = query({ prompt, options: claudeOptions });
    try {
      const models: ModelInfo[] = await claudeQuery.supportedModels();
      return models.map((model) => ({
        provider: "claude" as const,
        id: model.value,
        label: model.displayName,
        description: model.description,
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
  private managedAgentId: string | null = null;

  constructor(
    config: ClaudeAgentConfig,
    options: ClaudeAgentSessionOptions
  ) {
    this.config = config;
    this.defaults = options.defaults;
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
    _options?: AgentRunOptions
  ): AsyncGenerator<AgentStreamEvent> {
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
      // Push turn_canceled before ending the queue so consumers get proper lifecycle signals
      queue.push({
        type: "turn_canceled",
        provider: "claude",
        reason: "Interrupted",
      });
      queue.end();
    };
    this.cancelCurrentTurn = requestCancel;
    if (this.historyPending && this.persistedHistory.length > 0) {
      for (const item of this.persistedHistory) {
        queue.push({ type: "timeline", item, provider: "claude" });
      }
      this.historyPending = false;
      this.persistedHistory = [];
    }

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
        this.pushToolCall({
          name: "plan_approval",
          status: "granted",
          callId: pending.request.id,
        });
      }
      const result: PermissionResult = {
        behavior: "allow",
        updatedInput: response.updatedInput ?? pending.request.input ?? {},
        updatedPermissions: this.normalizePermissionUpdates(response.updatedPermissions),
      };
      pending.resolve(result);
    } else {
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
    const { model: _ignoredModel, ...restConfig } = this.config;
    this.persistence = {
      provider: "claude",
      sessionId: this.claudeSessionId,
      nativeHandle: this.claudeSessionId,
      metadata: restConfig,
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

  setManagedAgentId(agentId: string): void {
    this.managedAgentId = agentId;
  }

  async listCommands(): Promise<AgentSlashCommand[]> {
    const q = await this.ensureQuery();
    const commands = await q.supportedCommands();
    return commands.map((cmd) => ({
      name: cmd.name,
      description: cmd.description,
      argumentHint: cmd.argumentHint,
    }));
  }

  async executeCommand(commandName: string, args?: string): Promise<AgentCommandResult> {
    const commandPrompt = args ? `/${commandName} ${args}` : `/${commandName}`;

    // Commands return their output in a user message with <local-command-stdout> tags,
    // NOT as an assistant message. We need to extract that specifically.
    const events = this.stream(commandPrompt);
    const timeline: AgentTimelineItem[] = [];
    let commandOutput = "";
    let usage: AgentUsage | undefined;

    for await (const event of events) {
      if (event.type === "timeline") {
        timeline.push(event.item);
        // Check for command output in user messages
        if (event.item.type === "user_message") {
          const text = event.item.text;
          const match = text.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
          if (match) {
            commandOutput = match[1].trim();
          }
        }
        // Also capture assistant messages (some commands may produce both)
        if (event.item.type === "assistant_message" && !commandOutput) {
          commandOutput = event.item.text;
        }
      } else if (event.type === "turn_completed") {
        usage = event.usage;
      } else if (event.type === "turn_failed") {
        throw new Error(event.error);
      }
    }

    return {
      text: commandOutput,
      timeline,
      usage,
    };
  }

  private async ensureQuery(): Promise<Query> {
    if (this.query) {
      return this.query;
    }

    const input = new Pushable<SDKUserMessage>();
    const options = this.buildOptions();
    this.logger.debug({ options }, "claude query");
    this.input = input;
    this.query = query({ prompt: input, options });
    await this.query.setPermissionMode(this.currentMode);
    return this.query;
  }

  private buildOptions(): ClaudeOptions {
    const base: ClaudeOptions = {
      cwd: this.config.cwd,
      includePartialMessages: true,
      permissionMode: this.currentMode,
      agents: this.defaults?.agents,
      canUseTool: this.handlePermissionRequest,
      // Use Claude Code preset system prompt and load CLAUDE.md files
      // Append orchestrator mode instructions for agents
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: [
          getOrchestratorModeInstructions(),
          this.currentMode === "plan" ? "" : getSelfIdentificationInstructions(),
        ]
          .filter(Boolean)
          .join("\n"),
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
      // If we have a session ID from a previous query (e.g., after interrupt),
      // resume that session to continue the conversation history.
      ...(this.claudeSessionId ? { resume: this.claudeSessionId } : {}),
      ...this.config.extra?.claude,
    };

    // Always include the agent-control MCP server so agents can launch other agents
    if (!this.config.agentControlMcp) {
      throw new Error("agentControlMcp is required for ClaudeAgentSession");
    }
    const agentControlConfig = this.config.agentControlMcp;
    const agentControlUrl = this.managedAgentId
      ? appendCallerAgentId(agentControlConfig.url, this.managedAgentId)
      : agentControlConfig.url;
    const defaultMcpServers: Record<string, ClaudeMcpServerConfig> = {
      "agent-control": {
        type: "http",
        url: agentControlUrl,
        ...(agentControlConfig.headers ? { headers: agentControlConfig.headers } : {}),
      },
    };

    if (this.config.mcpServers) {
      const normalizedUserServers = this.normalizeMcpServers(this.config.mcpServers);
      // Merge user-provided MCP servers with defaults, user servers take precedence
      base.mcpServers = { ...defaultMcpServers, ...normalizedUserServers };
    } else {
      base.mcpServers = defaultMcpServers;
    }

    if (this.config.model) {
      base.model = this.config.model;
    }
    this.lastOptionsModel = base.model ?? null;
    if (this.claudeSessionId) {
      base.resume = this.claudeSessionId;
    }
    return base;
  }

  private normalizeMcpServers(
    servers: ClaudeAgentConfig["mcpServers"]
  ): Record<string, ClaudeMcpServerConfig> | undefined {
    if (!servers) {
      return undefined;
    }
    const result: Record<string, ClaudeMcpServerConfig> = {};
    for (const [name, config] of Object.entries(servers)) {
      if (isClaudeMcpServerConfig(config)) {
        result[name] = config;
      }
    }
    return Object.keys(result).length ? result : undefined;
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

    return {
      type: "user",
      message: {
        role: "user",
        content,
      },
      parent_tool_use_id: null,
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
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to interrupt active turn");
    }
  }

  private translateMessageToEvents(message: SDKMessage, turnContext: TurnContext): AgentStreamEvent[] {
    const events: AgentStreamEvent[] = [];

    switch (message.type) {
      case "system":
        if (message.subtype === "init") {
          this.handleSystemMessage(message);
        }
        break;
      case "user": {
        const content = message.message?.content;
        if (typeof content === "string" && content.length > 0) {
          // String content from user messages (e.g., local command output)
          events.push({
            type: "timeline",
            item: { type: "user_message", text: content },
            provider: "claude",
          });
        } else if (Array.isArray(content)) {
          const timelineItems = this.mapBlocksToTimeline(content, { turnContext });
          for (const item of timelineItems) {
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

  private handleSystemMessage(message: SDKSystemMessage): void {
    if (message.subtype !== "init") {
      return;
    }

    const newSessionId = message.session_id;
    const existingSessionId = this.claudeSessionId;

    if (existingSessionId === null) {
      // First time setting session ID (empty → filled) - this is expected
      this.claudeSessionId = newSessionId;
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
      this.logger.debug({ model: message.model }, "Captured model from SDK init");
      this.lastOptionsModel = message.model;
      // Invalidate cached runtime info so it picks up the new model
      this.cachedRuntimeInfo = null;
    }
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
    if (toolName === "ExitPlanMode") {
      this.emitPlanTodoItems(input);
    }

    const requestId = `permission-${randomUUID()}`;
    const metadata: AgentMetadata = {};
    if (options.toolUseID) {
      metadata.toolUseId = options.toolUseID;
    }
    if (toolName === "ExitPlanMode" && typeof input.plan === "string") {
      metadata.planText = input.plan;
    }

    const request: AgentPermissionRequest = {
      id: requestId,
      provider: "claude",
      name: toolName,
      kind: toolName === "ExitPlanMode" ? "plan" : "tool",
      input,
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

  private emitPlanTodoItems(input: AgentMetadata) {
    const planText = typeof input.plan === "string" ? input.plan : JSON.stringify(input);
    const todoItems = planText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((text) => ({ text, completed: false }));
    this.enqueueTimeline({
      type: "todo",
      items: todoItems.length > 0 ? todoItems : [{ text: planText, completed: false }],
    });
  }

  private enqueueTimeline(item: AgentTimelineItem) {
    this.pushEvent({ type: "timeline", item, provider: "claude" });
  }

  private pushToolCall(
    data: Omit<ToolCallTimelineItem, "type">,
    target?: AgentTimelineItem[]
  ) {
    const item: AgentTimelineItem = { type: "tool_call", ...data };
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
    const sanitized = cwd.replace(/[\\/]/g, "-").replace(/_/g, "-");
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
      {
        name: entry.name,
        status: "pending",
        callId: entry.id,
        input: entry.input ?? this.normalizeToolInput(block.input),
      },
      items
    );
  }

  private handleToolResult(block: ClaudeContentChunk, items: AgentTimelineItem[]): void {
    const entry = typeof block.tool_use_id === "string" ? this.toolUseCache.get(block.tool_use_id) : undefined;
    const toolName = entry?.name ?? block.tool_name ?? "tool";
    const status = block.is_error ? "failed" : "completed";

    // Extract output from block.content (SDK always returns content in string form)
    const output = this.buildToolOutput(block, entry);

    this.pushToolCall(
      {
        name: toolName,
        status,
        callId: typeof block.tool_use_id === "string" ? block.tool_use_id : undefined,
        input: entry?.input,
        output,
        error: block.is_error ? block : undefined,
      },
      items
    );
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
    this.pushToolCall({
      name: entry.name,
      status: "pending",
      callId: toolId,
      input: normalized,
    });
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
      timeline.push({
        type: "user_message",
        text,
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

const CLAUDE_PERSISTED_TIMELINE_LIMIT = 20;

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
    timeline: timeline.slice(0, CLAUDE_PERSISTED_TIMELINE_LIMIT),
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
