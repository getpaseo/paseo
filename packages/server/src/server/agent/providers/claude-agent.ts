import { randomUUID } from "node:crypto";
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

type ClaudeContentChunk = { type: string; [key: string]: any };

type PendingPermission = {
  request: AgentPermissionRequest;
  resolve: (result: PermissionResult) => void;
  reject: (error: Error) => void;
  cleanup?: () => void;
};

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
  private toolUseCache = new Map<string, { name: string; server: string }>();
  private pendingPermissions = new Map<string, PendingPermission>();
  private eventQueue: Pushable<AgentStreamEvent> | null = null;

  constructor(
    config: ClaudeAgentConfig,
    defaults?: { agents?: Record<string, AgentDefinition> },
    handle?: AgentPersistenceHandle
  ) {
    this.config = config;
    this.defaults = defaults;
    this.claudeSessionId = handle?.sessionId ?? null;
    this.pendingLocalId = this.claudeSessionId ?? `claude-${randomUUID()}`;
    this.persistence = handle ?? null;
    this.currentMode = (config.modeId as PermissionMode) ?? "default";
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
    void this.forwardPromptEvents(sdkMessage, queue);

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
    }
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    // Claude Agent SDK does not provide a rollout replay API yet.
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
        this.enqueueTimeline({
          type: "command",
          command: "plan:approved",
          status: "granted",
          raw: pending.request,
        });
      }
      const result: PermissionResult = {
        behavior: "allow",
        updatedInput: response.updatedInput ?? pending.request.input ?? {},
        updatedPermissions: this.normalizePermissionUpdates(response.updatedPermissions),
      };
      pending.resolve(result);
      this.enqueueTimeline({
        type: "command",
        command: `permission:${pending.request.name}`,
        status: "granted",
        raw: { request: pending.request, response },
      });
    } else {
      const result: PermissionResult = {
        behavior: "deny",
        message: response.message ?? "Permission request denied",
        interrupt: response.interrupt,
      };
      pending.resolve(result);
      this.enqueueTimeline({
        type: "command",
        command: `permission:${pending.request.name}`,
        status: "denied",
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
      if (!config) continue;
      if ("type" in config || "command" in (config as any) || "url" in (config as any)) {
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
    try {
      for await (const sdkEvent of this.processPrompt(message)) {
        const events = this.translateMessageToEvents(sdkEvent);
        for (const event of events) {
          queue.push(event);
        }
      }
    } catch (error) {
      queue.push({
        type: "turn_failed",
        provider: "claude",
        error: error instanceof Error ? error.message : "Claude stream failed",
      });
    } finally {
      queue.end();
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
      case "assistant": {
        const timelineItems = this.mapBlocksToTimeline(message.message.content);
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

    this.enqueueTimeline({
      type: "command",
      command: `permission:${toolName}`,
      status: "requested",
      raw: { toolName, input },
    });

    this.pushEvent({ type: "permission_requested", provider: "claude", request });

    return await new Promise<PermissionResult>((resolve, reject) => {
      let cleanup: (() => void) | undefined;
      const abortHandler = () => {
        cleanup?.();
        this.pendingPermissions.delete(requestId);
        reject(new Error("Permission request aborted"));
      };

      if (options?.signal) {
        if (options.signal.aborted) {
          abortHandler();
          return;
        }
        options.signal.addEventListener("abort", abortHandler, { once: true });
        cleanup = () => options.signal?.removeEventListener("abort", abortHandler);
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

  private mapBlocksToTimeline(content: string | ClaudeContentChunk[]): AgentTimelineItem[] {
    if (typeof content === "string") {
      if (!content || content === "[Request interrupted by user for tool use]") {
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
            items.push({ type: "assistant_message", text: block.text, raw: block });
          }
          break;
        case "thinking":
        case "thinking_delta":
          if (block.thinking) {
            items.push({ type: "reasoning", text: block.thinking, raw: block });
          }
          break;
        case "tool_use":
        case "server_tool_use":
        case "mcp_tool_use": {
          const name = block.name ?? "tool";
          const server = block.server ?? name;
          this.toolUseCache.set(block.id, { name, server });
          this.enqueueTimeline({
            type: "command",
            command: `permission:${name}`,
            status: "granted",
            raw: block,
          });
          items.push({
            type: "mcp_tool",
            server,
            tool: name,
            status: "pending",
            raw: block,
          });
          break;
        }
        case "tool_result":
        case "mcp_tool_result":
        case "web_fetch_tool_result":
        case "web_search_tool_result":
        case "code_execution_tool_result":
        case "bash_code_execution_tool_result":
        case "text_editor_code_execution_tool_result": {
          const cached = block.tool_use_id
            ? this.toolUseCache.get(block.tool_use_id)
            : undefined;
          const server = cached?.server ?? block.server ?? "tool";
          const tool = cached?.name ?? block.tool_name ?? "tool";
          items.push({
            type: "mcp_tool",
            server,
            tool,
            status: block.is_error ? "failed" : "completed",
            raw: block,
          });
          if (!block.is_error && block.tool_use_id) {
            this.toolUseCache.delete(block.tool_use_id);
          }
          break;
        }
        default:
          break;
      }
    }
    return items;
  }

  private mapPartialEvent(event: SDKPartialAssistantMessage["event"]): AgentTimelineItem[] {
    switch (event.type) {
      case "content_block_start":
        return this.mapBlocksToTimeline([event.content_block as ClaudeContentChunk]);
      case "content_block_delta":
        return this.mapBlocksToTimeline([event.delta as ClaudeContentChunk]);
      default:
        return [];
    }
  }
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
