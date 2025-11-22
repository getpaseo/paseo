import { randomUUID } from "node:crypto";
import fs, { promises as fsPromises } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  query,
  type AgentDefinition,
  type CanUseTool,
  type McpServerConfig as ClaudeMcpServerConfig,
  type Options as ClaudeOptions,
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

import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentMode,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPermissionUpdate,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentRunOptions,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  AgentTimelineItem,
  AgentUsage,
  ListPersistedAgentsOptions,
  PersistedAgentDescriptor,
} from "../agent-sdk-types.js";

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

type ClaudeAgentConfig = AgentSessionConfig & { provider: "claude" };

export type ClaudeContentChunk = { type: string; [key: string]: any };

export function extractUserMessageText(
  content: string | ClaudeContentChunk[]
): string | null {
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
  input?: Record<string, unknown> | null;
};

const DEFAULT_PERMISSION_TIMEOUT_MS = 120_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class ClaudeAgentClient implements AgentClient {
  readonly provider = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;

  constructor(private readonly defaults?: { agents?: Record<string, AgentDefinition> }) {}

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    const claudeConfig = this.assertConfig(config);
    return new ClaudeAgentSession(claudeConfig, this.defaults);
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>
  ): Promise<AgentSession> {
    const metadata = (handle.metadata ?? {}) as Partial<AgentSessionConfig>;
    const merged = { ...metadata, ...overrides } as Partial<AgentSessionConfig>;
    if (!merged.cwd) {
      throw new Error("Claude resume requires the original working directory in metadata");
    }
    const mergedConfig = { ...merged, provider: "claude" } as AgentSessionConfig;
    const claudeConfig = this.assertConfig(mergedConfig);
    return new ClaudeAgentSession(claudeConfig, this.defaults, handle);
  }

  async listPersistedAgents(options?: ListPersistedAgentsOptions): Promise<PersistedAgentDescriptor[]> {
    const projectsRoot = path.join(os.homedir(), ".claude", "projects");
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
    return config as ClaudeAgentConfig;
  }
}

class ClaudeAgentSession implements AgentSession {
  readonly provider = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;

  private readonly config: ClaudeAgentConfig;
  private readonly defaults?: { agents?: Record<string, AgentDefinition> };
  private query: Query | null = null;
  private input: Pushable<SDKUserMessage> | null = null;
  private claudeSessionId: string | null;
  private pendingLocalId: string;
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
  private streamedAssistantTextThisTurn = false;
  private streamedReasoningThisTurn = false;

  constructor(
    config: ClaudeAgentConfig,
    defaults?: { agents?: Record<string, AgentDefinition> },
    handle?: AgentPersistenceHandle
  ) {
    this.config = config;
    this.defaults = defaults;
    this.claudeSessionId = handle?.sessionId ?? handle?.nativeHandle ?? null;
    this.pendingLocalId = this.claudeSessionId ?? `claude-${randomUUID()}`;
    this.persistence = handle ?? null;
    this.currentMode = (config.modeId as PermissionMode) ?? "default";
    if (this.claudeSessionId) {
      this.loadPersistedHistory(this.claudeSessionId);
    }
  }

  get id(): string | null {
    return this.claudeSessionId;
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

    return {
      sessionId: this.claudeSessionId ?? this.pendingLocalId,
      finalText,
      usage,
      timeline,
    };
  }

  async *stream(
    prompt: AgentPromptInput,
    _options?: AgentRunOptions
  ): AsyncGenerator<AgentStreamEvent> {
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
      void this.interruptActiveTurn();
      queue.end();
    };
    if (this.historyPending && this.persistedHistory.length > 0) {
      for (const item of this.persistedHistory) {
        queue.push({ type: "timeline", item, provider: "claude" });
      }
      this.historyPending = false;
      this.persistedHistory = [];
    }
    void this.forwardPromptEvents(sdkMessage, queue);

    try {
      for await (const event of queue) {
        yield event;
        if (event.type === "turn_completed" || event.type === "turn_failed") {
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
    const normalized = modeId as PermissionMode;
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
          server: "plan",
          tool: "plan_approval",
          status: "granted",
          callId: pending.request.id,
          displayName: "Plan approved",
          kind: "plan",
          raw: pending.request,
        });
      }
      const result: PermissionResult = {
        behavior: "allow",
        updatedInput: response.updatedInput ?? pending.request.input ?? {},
        updatedPermissions: this.normalizePermissionUpdates(response.updatedPermissions),
      };
      pending.resolve(result);
      this.pushToolCall({
        server: "permission",
        tool: pending.request.name,
        status: "granted",
        callId: pending.request.id,
        displayName: pending.request.title ?? pending.request.name,
        kind: "permission",
        input: pending.request.input,
        raw: { request: pending.request, response },
      });
    } else {
      const result: PermissionResult = {
        behavior: "deny",
        message: response.message ?? "Permission request denied",
        interrupt: response.interrupt,
      };
      pending.resolve(result);
      this.pushToolCall({
        server: "permission",
        tool: pending.request.name,
        status: "denied",
        callId: pending.request.id,
        displayName: pending.request.title ?? pending.request.name,
        kind: "permission",
        input: pending.request.input,
        raw: { request: pending.request, response },
      });
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
    await this.query?.return?.();
    this.query = null;
    this.input = null;
  }

  private async ensureQuery(): Promise<Query> {
    if (this.query) {
      return this.query;
    }

    const input = new Pushable<SDKUserMessage>();
    const options = this.buildOptions();
    this.input = input;
    this.query = query({ prompt: input, options });
    return this.query;
  }

  private buildOptions(): ClaudeOptions {
    const base: ClaudeOptions = {
      cwd: this.config.cwd,
      includePartialMessages: true,
      permissionMode: this.currentMode,
      agents: this.defaults?.agents,
      canUseTool: this.handlePermissionRequest,
      ...this.config.extra?.claude,
    };

    if (this.config.mcpServers) {
      base.mcpServers = this.normalizeMcpServers(this.config.mcpServers);
    }
    if (this.config.model) {
      base.model = this.config.model;
    }
    if (this.claudeSessionId) {
      base.resume = this.claudeSessionId;
      base.continue = true;
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
      if (!isRecord(config)) continue;
      if ("type" in config || "command" in config || "url" in config) {
        result[name] = config as ClaudeMcpServerConfig;
      }
    }
    return Object.keys(result).length ? result : undefined;
  }

  private toSdkUserMessage(prompt: AgentPromptInput): SDKUserMessage {
    const text = Array.isArray(prompt)
      ? prompt.map((chunk) => chunk.text).join("\n\n")
      : prompt;

    return {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text }],
      },
      parent_tool_use_id: null,
      session_id: this.claudeSessionId ?? this.pendingLocalId,
    };
  }

  private async *processPrompt(
    sdkMessage: SDKUserMessage
  ): AsyncGenerator<SDKMessage, void, undefined> {
    const query = await this.ensureQuery();
    if (!this.input) {
      throw new Error("Claude session input stream not initialized");
    }

    this.input.push(sdkMessage);

    while (true) {
      const { value, done } = await query.next();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      yield value;
      if (value.type === "result") {
        break;
      }
    }
  }

  private async forwardPromptEvents(message: SDKUserMessage, queue: Pushable<AgentStreamEvent>) {
    this.streamedAssistantTextThisTurn = false;
    this.streamedReasoningThisTurn = false;
    try {
      for await (const sdkEvent of this.processPrompt(message)) {
        const events = this.translateMessageToEvents(sdkEvent);
        for (const event of events) {
          queue.push(event);
        }
      }
    } catch (error) {
      if (!this.turnCancelRequested) {
        queue.push({
          type: "turn_failed",
          provider: "claude",
          error: error instanceof Error ? error.message : "Claude stream failed",
        });
      }
    } finally {
      this.turnCancelRequested = false;
      queue.end();
    }
  }

  private async interruptActiveTurn(): Promise<void> {
    if (!this.query || typeof this.query.interrupt !== "function") {
      return;
    }
    try {
      await this.query.interrupt();
    } catch (error) {
      console.warn("[ClaudeAgentSession] Failed to interrupt active turn:", error);
    }
  }

  private translateMessageToEvents(message: SDKMessage): AgentStreamEvent[] {
    const events: AgentStreamEvent[] = [{ type: "provider_event", provider: "claude", raw: message }];

    switch (message.type) {
      case "system":
        if (message.subtype === "init") {
          this.handleSystemMessage(message as SDKSystemMessage);
        }
        break;
      case "user": {
        const content = (message as SDKUserMessage).message?.content;
        if (Array.isArray(content)) {
          const timelineItems = this.mapBlocksToTimeline(content);
          for (const item of timelineItems) {
            events.push({ type: "timeline", item, provider: "claude" });
          }
        }
        break;
      }
      case "assistant": {
        const timelineItems = this.mapBlocksToTimeline(message.message.content, {
          suppressAssistantText: this.streamedAssistantTextThisTurn,
          suppressReasoning: this.streamedReasoningThisTurn,
        });
        for (const item of timelineItems) {
          events.push({ type: "timeline", item, provider: "claude" });
        }
        break;
      }
      case "stream_event": {
        const timelineItems = this.mapPartialEvent(message.event);
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
    this.claudeSessionId = message.session_id;
    this.availableModes = DEFAULT_MODES;
    this.currentMode = message.permissionMode;
    this.persistence = null;
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
    const metadata: Record<string, unknown> = {};
    const permissionOptions = options as { toolUseID?: string } | undefined;
    if (permissionOptions?.toolUseID) {
      metadata.toolUseId = permissionOptions.toolUseID;
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
      suggestions: options?.suggestions as AgentPermissionUpdate[] | undefined,
      metadata: Object.keys(metadata).length ? metadata : undefined,
      raw: { toolName, input, options },
    };

    this.pushToolCall({
      server: "permission",
      tool: toolName,
      status: "requested",
      callId: requestId,
      displayName: request.title ?? toolName,
      kind: "permission",
      input,
      raw: { toolName, input },
    });

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
        this.pushToolCall({
          server: "permission",
          tool: toolName,
          status: "denied",
          callId: requestId,
          displayName: request.title ?? toolName,
          kind: "permission",
          input,
          raw: { reason: "timeout", toolName, input },
        });
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

  private emitPlanTodoItems(input: Record<string, unknown>) {
    const planText = typeof input.plan === "string" ? input.plan : JSON.stringify(input);
    const todoItems = planText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((text) => ({ text, completed: false }));
    this.enqueueTimeline({
      type: "todo",
      items: todoItems.length > 0 ? todoItems : [{ text: planText, completed: false }],
      raw: input,
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

  private getToolKind(classification?: ToolUseClassification): string | undefined {
    switch (classification) {
      case "command":
        return "execute";
      case "file_change":
        return "edit";
      case "generic":
      default:
        return "tool";
    }
  }

  private buildToolDisplayName(entry?: ToolUseCacheEntry): string | undefined {
    if (!entry) {
      return undefined;
    }
    return entry.commandText ?? entry.name;
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
    return updates as PermissionUpdate[];
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
    const dir = path.join(os.homedir(), ".claude", "projects", sanitized);
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
      suppressAssistantText?: boolean;
      suppressReasoning?: boolean;
    }
  ): AgentTimelineItem[] {
    const context = options?.context ?? "live";
    const suppressAssistant = options?.suppressAssistantText ?? false;
    const suppressReasoning = options?.suppressReasoning ?? false;

    if (typeof content === "string") {
      if (!content || content === "[Request interrupted by user for tool use]") {
        return [];
      }
      if (context === "live") {
        this.streamedAssistantTextThisTurn = true;
      }
      if (suppressAssistant) {
        return [];
      }
      return [{ type: "assistant_message", text: content, raw: content }];
    }

    const items: AgentTimelineItem[] = [];
    for (const block of content) {
      switch (block.type) {
        case "text":
        case "text_delta":
          if (block.text && block.text !== "[Request interrupted by user for tool use]") {
            if (context === "live") {
              this.streamedAssistantTextThisTurn = true;
            }
            if (!suppressAssistant) {
              items.push({ type: "assistant_message", text: block.text, raw: block });
            }
          }
          break;
        case "thinking":
        case "thinking_delta":
          if (block.thinking) {
            if (context === "live") {
              this.streamedReasoningThisTurn = true;
            }
            if (!suppressReasoning) {
              items.push({ type: "reasoning", text: block.thinking, raw: block });
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
        server: entry.server,
        tool: entry.name,
        status: "pending",
        callId: entry.id,
        displayName: this.buildToolDisplayName(entry),
        kind: this.getToolKind(entry.classification),
        input: entry.input ?? this.normalizeToolInput(block.input),
        raw: block,
      },
      items
    );
  }

  private handleToolResult(block: ClaudeContentChunk, items: AgentTimelineItem[]): void {
    const entry = typeof block.tool_use_id === "string" ? this.toolUseCache.get(block.tool_use_id) : undefined;
    const server = entry?.server ?? block.server ?? "tool";
    const tool = entry?.name ?? block.tool_name ?? "tool";
    const status = block.is_error ? "failed" : "completed";
    const rawPayload =
      !block.is_error && entry?.classification === "file_change" && entry.files?.length
        ? { block, files: entry.files }
        : block;
    this.pushToolCall(
      {
        server,
        tool,
        status,
        callId: typeof block.tool_use_id === "string" ? block.tool_use_id : undefined,
        displayName: this.buildToolDisplayName(entry),
        kind: this.getToolKind(entry?.classification),
        input: entry?.input,
        output: !block.is_error && entry?.files?.length ? { files: entry.files } : undefined,
        error: block.is_error ? block : undefined,
        raw: rawPayload,
      },
      items
    );
    if (typeof block.tool_use_id === "string") {
      this.toolUseCache.delete(block.tool_use_id);
    }
  }

  private mapPartialEvent(event: SDKPartialAssistantMessage["event"]): AgentTimelineItem[] {
    if (event.type === "content_block_start" && (event.content_block as ClaudeContentChunk | undefined)?.type === "tool_use") {
      const block = event.content_block as ClaudeContentChunk;
      if (typeof event.index === "number" && typeof block?.id === "string") {
        this.toolUseIndexToId.set(event.index, block.id);
        this.toolUseInputBuffers.delete(block.id);
      }
    } else if (event.type === "content_block_delta" && (event.delta as ClaudeContentChunk | undefined)?.type === "input_json_delta") {
      this.handleToolInputDelta(event.index, (event.delta as { partial_json?: string })?.partial_json);
      return [];
    } else if (event.type === "content_block_stop" && typeof event.index === "number") {
      const toolId = this.toolUseIndexToId.get(event.index);
      if (toolId) {
        this.toolUseIndexToId.delete(event.index);
        this.toolUseInputBuffers.delete(toolId);
      }
    }

    switch (event.type) {
      case "content_block_start":
        return this.mapBlocksToTimeline([event.content_block as ClaudeContentChunk]);
      case "content_block_delta":
        return this.mapBlocksToTimeline([event.delta as ClaudeContentChunk]);
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

    if (block.type === "tool_use") {
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
      server: entry.server,
      tool: entry.name,
      status: "pending",
      callId: toolId,
      displayName: this.buildToolDisplayName(entry),
      kind: this.getToolKind(entry.classification),
      input: normalized,
      raw: { type: "tool_use", id: toolId, input: parsed },
    });
  }

  private normalizeToolInput(input: unknown): Record<string, unknown> | null {
    if (!input || typeof input !== "object") {
      return null;
    }
    return input as Record<string, unknown>;
  }

  private applyToolInput(entry: ToolUseCacheEntry, input: Record<string, unknown>): void {
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

  private isCommandTool(name: string, input: Record<string, unknown>): boolean {
    const normalized = name.toLowerCase();
    if (normalized.includes("bash") || normalized.includes("shell") || normalized.includes("terminal") || normalized.includes("command")) {
      return true;
    }
    if (typeof input.command === "string" || Array.isArray(input.command)) {
      return true;
    }
    return false;
  }

  private extractCommandText(input: Record<string, unknown>): string | undefined {
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

  private extractFileChanges(input: Record<string, unknown>): { path: string; kind: string }[] | undefined {
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

function normalizeHistoryBlocks(
  content: string | ClaudeContentChunk[]
): ClaudeContentChunk[] | null {
  if (Array.isArray(content)) {
    return content;
  }
  if (content && typeof content === "object") {
    return [content as ClaudeContentChunk];
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

  const content = message.content as string | ClaudeContentChunk[];
  const normalizedBlocks = normalizeHistoryBlocks(content);
  const hasToolBlock = normalizedBlocks?.some((block) => hasToolLikeBlock(block)) ?? false;
  const timeline: AgentTimelineItem[] = [];

  if (entry.type === "user") {
    const text = extractUserMessageText(content);
    if (text) {
      timeline.push({
        type: "user_message",
        text,
        raw: message,
      });
    }
  }

  if (hasToolBlock && normalizedBlocks) {
    const mapped = mapBlocks(Array.isArray(content) ? content : normalizedBlocks);
    if (entry.type === "user") {
      const toolItems = mapped.filter((item) => item.type === "tool_call");
      return timeline.length ? [...timeline, ...toolItems] : toolItems;
    }
    return mapped;
  }

  if (entry.type === "assistant" && content) {
    return mapBlocks(content);
  }

  return timeline;
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
      resolve({ value: undefined as any, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.queue.length > 0) {
          const value = this.queue.shift()!;
          return Promise.resolve({ value, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as any, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
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
