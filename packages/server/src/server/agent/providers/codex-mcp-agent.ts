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

type ProviderEvent = {
  type: "provider_event";
  provider: string;
  raw: unknown;
};

type TurnState = {
  sawAssistant: boolean;
  sawReasoning: boolean;
  sawError: boolean;
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

const DEFAULT_TIMEOUT_MS = 14 * 24 * 60 * 60 * 1000;

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
    approvalPolicy: "untrusted",
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

function extractThreadItemCallId(item: Record<string, unknown>): string | undefined {
  return (
    normalizeCallId(item.call_id as string | undefined) ??
    normalizeCallId(item.id as string | undefined)
  );
}

function buildCommandDisplayName(command?: unknown): string {
  if (typeof command === "string") {
    const trimmed = command.trim();
    if (trimmed.length) {
      return trimmed;
    }
  }
  if (Array.isArray(command)) {
    const tokens = command.filter((entry): entry is string => typeof entry === "string");
    if (tokens.length > 0) {
      return tokens.join(" ");
    }
  }
  return "Command";
}

function buildFileChangeSummary(files: { path: string; kind: string }[]): string {
  if (!files.length) {
    return "File change";
  }
  if (files.length === 1) {
    return `${files[0].kind ?? "edit"}: ${files[0].path}`;
  }
  return `${files.length} file changes`;
}

function extractTextContent(response: unknown): string | null {
  if (!response || typeof response !== "object") {
    return null;
  }
  const content = (response as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return null;
  }
  const parts = content
    .filter((item) => item && typeof item === "object")
    .map((item) => (item as { type?: string; text?: string }).type === "text"
      ? (item as { text?: string }).text
      : null)
    .filter((text): text is string => typeof text === "string" && text.length > 0);
  if (!parts.length) {
    return null;
  }
  return parts.join("\n");
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
): Record<string, unknown> {
  const preset = MODE_PRESETS[modeId] ?? MODE_PRESETS[DEFAULT_CODEX_MODE_ID];
  const approvalPolicy = config.approvalPolicy ?? preset.approvalPolicy;
  const sandbox = config.sandboxMode ?? preset.sandbox;
  const extra = config.extra?.codex ?? undefined;

  return {
    prompt,
    cwd: config.cwd,
    model: config.model,
    "approval-policy": approvalPolicy,
    sandbox,
    config: extra,
  };
}

function isUnsupportedChatGptModelError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("model is not supported when using Codex with a ChatGPT account");
}

function extractCommandText(command?: unknown): string | null {
  if (typeof command === "string") {
    return command;
  }
  if (Array.isArray(command)) {
    const tokens = command.filter((value): value is string => typeof value === "string");
    if (tokens.length > 0) {
      return tokens.join(" ");
    }
  }
  return null;
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

class CodexMcpAgentSession implements AgentSession {
  readonly provider = "codex-mcp" as AgentClient["provider"];
  readonly capabilities = CODEX_MCP_CAPABILITIES;

  private readonly client: Client;
  private transport: StdioClientTransport | null = null;
  private connected = false;
  private config: AgentSessionConfig;
  private currentMode: string;
  private sessionId: string | null = null;
  private conversationId: string | null = null;
  private runtimeModel: string | null = null;
  private modelRejected = false;
  private pendingLocalId: string | null = null;
  private persistence: AgentPersistenceHandle | null = null;
  private cachedRuntimeInfo: AgentRuntimeInfo | null = null;
  private pendingPermissions = new Map<string, AgentPermissionRequest>();
  private pendingPermissionHandlers = new Map<string, PendingPermission>();
  private pendingToolEvents = new Map<string, Array<() => void>>();
  private resolvedPermissionRequests = new Set<string>();
  private eventQueue: Pushable<AgentStreamEvent | ProviderEvent> | null = null;
  private currentAbortController: AbortController | null = null;
  private historyPending = false;
  private persistedHistory: AgentTimelineItem[] = [];
  private pendingHistory: AgentTimelineItem[] = [];
  private turnState: TurnState | null = null;

  constructor(config: CodexMcpAgentConfig, resumeHandle?: AgentPersistenceHandle) {
    this.config = config;
    this.currentMode = config.modeId ?? DEFAULT_CODEX_MODE_ID;
    this.pendingLocalId = `codex-mcp-${randomUUID()}`;

    if (resumeHandle) {
      this.sessionId = resumeHandle.sessionId;
      const metadata = resumeHandle.metadata;
      if (metadata && typeof metadata === "object") {
        const record = metadata as Record<string, unknown>;
        const conversationId = record.conversationId;
        if (typeof conversationId === "string") {
          this.conversationId = conversationId;
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
      if (!permission) {
        return { decision: "denied" as const };
      }

      const response = await new Promise<ElicitResponse>((resolve, reject) => {
        this.pendingPermissions.set(permission.id, permission);
        this.pendingPermissionHandlers.set(permission.id, {
          request: permission,
          resolve,
          reject,
        });
        this.emitPermissionRequested(permission);
      });

      return response;
    });
  }

  get id(): string | null {
    return this.sessionId ?? this.pendingLocalId;
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    const mcpCommand = getCodexMcpCommand();
    this.transport = new StdioClientTransport({
      command: "codex",
      args: [mcpCommand],
      env: Object.keys(process.env).reduce((acc, key) => {
        const value = process.env[key];
        if (typeof value === "string") acc[key] = value;
        return acc;
      }, {} as Record<string, string>),
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

    this.cachedRuntimeInfo = {
      provider: "codex-mcp" as AgentRuntimeInfo["provider"],
      sessionId: this.sessionId ?? this.pendingLocalId ?? null,
      model: this.runtimeModel ?? this.config.model ?? null,
      modeId: this.currentMode ?? null,
    };

    return {
      sessionId: this.sessionId ?? this.pendingLocalId ?? "",
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
    const queue = new Pushable<AgentStreamEvent | ProviderEvent>();
    this.eventQueue = queue;
    this.turnState = {
      sawAssistant: false,
      sawReasoning: false,
      sawError: false,
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
        yield event as AgentStreamEvent;
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
        provider: "codex-mcp" as AgentStreamEvent["provider"],
        item,
      };
    }
  }

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    if (this.cachedRuntimeInfo) {
      return { ...this.cachedRuntimeInfo };
    }
    const info: AgentRuntimeInfo = {
      provider: "codex-mcp" as AgentRuntimeInfo["provider"],
      sessionId: this.sessionId ?? this.pendingLocalId ?? null,
      model: this.runtimeModel ?? this.config.model ?? null,
      modeId: this.currentMode ?? null,
    };
    this.cachedRuntimeInfo = info;
    return { ...info };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return CODEX_MODES;
  }

  async getCurrentMode(): Promise<string | null> {
    return this.currentMode ?? null;
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
        displayName: pending.request.title ?? pending.request.name,
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
    pending.resolve({ decision, reason: response.message });
    this.flushQueuedToolEvents(requestId, response.behavior === "allow");
  }

  describePersistence(): AgentPersistenceHandle | null {
    if (this.persistence) {
      return this.persistence;
    }
    if (!this.sessionId) {
      return null;
    }
    const { model: _ignoredModel, ...restConfig } = this.config;
    this.persistence = {
      provider: "codex-mcp" as AgentPersistenceHandle["provider"],
      sessionId: this.sessionId,
      nativeHandle: this.sessionId,
      metadata: {
        ...restConfig,
        conversationId: this.conversationId ?? undefined,
      },
    };
    return this.persistence;
  }

  async close(): Promise<void> {
    for (const pending of this.pendingPermissionHandlers.values()) {
      pending.reject(new Error("Codex MCP session closed"));
    }
    this.pendingPermissionHandlers.clear();
    this.pendingPermissions.clear();
    this.pendingToolEvents.clear();
    this.resolvedPermissionRequests.clear();
    this.eventQueue?.end();
    this.eventQueue = null;

    if (!this.connected) return;
    const pid = this.transport?.pid ?? null;
    try {
      await this.client.close();
    } catch {
      try {
        await this.transport?.close?.();
      } catch {
        // ignore
      }
    }
    if (pid) {
      try {
        process.kill(pid, 0);
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
        const attempt = async (arguments_: Record<string, unknown>) =>
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
            this.modelRejected = true;
            this.runtimeModel = null;
            this.config.model = undefined;
            response = await attempt(fallback);
          } else {
            throw error;
          }
        }
      } else {
        const conversationId = this.conversationId ?? this.sessionId;
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
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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
    if (this.modelRejected && !this.runtimeModel) {
      this.runtimeModel = "default";
    }

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

  private emitEvent(event: AgentStreamEvent | ProviderEvent): void {
    if (event.type === "timeline") {
      this.recordHistory(event.item);
      if (event.item.type === "assistant_message") {
        this.turnState && (this.turnState.sawAssistant = true);
      }
      if (event.item.type === "reasoning") {
        this.turnState && (this.turnState.sawReasoning = true);
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
        displayName: request.title ?? request.name,
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

  private getEffectiveApprovalPolicy(): string {
    const modeId = this.currentMode ?? this.config.modeId ?? DEFAULT_CODEX_MODE_ID;
    const preset = MODE_PRESETS[modeId] ?? MODE_PRESETS[DEFAULT_CODEX_MODE_ID];
    return this.config.approvalPolicy ?? preset.approvalPolicy;
  }

  private shouldGatePermissions(): boolean {
    const approvalPolicy = this.getEffectiveApprovalPolicy();
    return approvalPolicy === "on-request" || approvalPolicy === "untrusted";
  }

  private queuePermissionGatedEvent(
    callId: string | undefined,
    event: Record<string, unknown>,
    emitEvent: () => void
  ): boolean {
    if (!this.shouldGatePermissions()) {
      return false;
    }
    if (!callId) {
      return false;
    }
    const requestId = `permission-${callId}`;
    if (this.resolvedPermissionRequests.has(requestId)) {
      return false;
    }
    if (!this.pendingPermissions.has(requestId) && !this.pendingPermissionHandlers.has(requestId)) {
      const permission = this.buildPermissionRequest(event);
      if (!permission) {
        return false;
      }
      this.pendingPermissions.set(permission.id, permission);
      this.pendingPermissionHandlers.set(permission.id, {
        request: permission,
        resolve: () => {},
        reject: () => {},
      });
      this.emitPermissionRequested(permission);
    }
    this.queueToolEvent(requestId, emitEvent);
    return true;
  }

  private ensurePermissionRequestFromEvent(event: Record<string, unknown>): void {
    const callId = normalizeCallId(event.call_id as string | undefined);
    if (!callId) {
      return;
    }
    const requestId = `permission-${callId}`;
    if (this.resolvedPermissionRequests.has(requestId)) {
      return;
    }
    if (this.pendingPermissions.has(requestId) || this.pendingPermissionHandlers.has(requestId)) {
      return;
    }
    const permission = this.buildPermissionRequest(event);
    if (!permission) {
      return;
    }
    this.pendingPermissions.set(permission.id, permission);
    this.pendingPermissionHandlers.set(permission.id, {
      request: permission,
      resolve: () => {},
      reject: () => {},
    });
    this.emitPermissionRequested(permission);
  }

  private queueToolEvent(requestId: string, emitEvent: () => void): void {
    const queued = this.pendingToolEvents.get(requestId);
    if (queued) {
      queued.push(emitEvent);
      return;
    }
    this.pendingToolEvents.set(requestId, [emitEvent]);
  }

  private flushQueuedToolEvents(requestId: string, allow: boolean): void {
    const queued = this.pendingToolEvents.get(requestId);
    if (!queued) {
      return;
    }
    this.pendingToolEvents.delete(requestId);
    if (!allow) {
      return;
    }
    for (const emitEvent of queued) {
      emitEvent();
    }
  }

  private recordHistory(item: AgentTimelineItem): void {
    if (this.sessionId) {
      const history = SESSION_HISTORY.get(this.sessionId) ?? [];
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
    const history = SESSION_HISTORY.get(this.sessionId) ?? [];
    history.push(...this.pendingHistory);
    SESSION_HISTORY.set(this.sessionId, history);
    this.pendingHistory = [];
  }

  private updateIdentifiersFromResponse(response: unknown): void {
    const record = response && typeof response === "object" ? (response as Record<string, unknown>) : null;
    if (!record) return;
    const meta = record.meta && typeof record.meta === "object" ? (record.meta as Record<string, unknown>) : null;
    const sessionId = meta?.sessionId ?? record.sessionId;
    const conversationId = meta?.conversationId ?? record.conversationId;
    const model = meta?.model ?? record.model;
    if (typeof sessionId === "string") {
      this.sessionId = sessionId;
      this.flushPendingHistory();
    }
    if (typeof conversationId === "string") {
      this.conversationId = conversationId;
    }
    if (typeof model === "string" && model.length > 0) {
      this.runtimeModel = model;
    }

    const content = record.content;
    if (Array.isArray(content)) {
      for (const item of content) {
        if (!item || typeof item !== "object") continue;
        const sessionCandidate = (item as Record<string, unknown>).sessionId;
        const conversationCandidate = (item as Record<string, unknown>).conversationId;
        if (!this.sessionId && typeof sessionCandidate === "string") {
          this.sessionId = sessionCandidate;
          this.flushPendingHistory();
        }
        if (!this.conversationId && typeof conversationCandidate === "string") {
          this.conversationId = conversationCandidate;
        }
        const modelCandidate = (item as Record<string, unknown>).model;
        if (typeof modelCandidate === "string" && modelCandidate.length > 0) {
          this.runtimeModel = modelCandidate;
        }
      }
    }
  }

  private updateIdentifiersFromEvent(event: unknown): void {
    if (!event || typeof event !== "object") {
      return;
    }
    const candidates = [event];
    if ((event as { data?: unknown }).data && typeof (event as { data?: unknown }).data === "object") {
      candidates.push((event as { data?: unknown }).data as Record<string, unknown>);
    }
    for (const candidate of candidates) {
      const record = candidate as Record<string, unknown>;
      const sessionId = record.session_id ?? record.sessionId;
      const conversationId = record.conversation_id ?? record.conversationId;
      const model = record.model;
      if (!this.sessionId && typeof sessionId === "string") {
        this.sessionId = sessionId;
        this.flushPendingHistory();
      }
      if (!this.conversationId && typeof conversationId === "string") {
        this.conversationId = conversationId;
      }
      if (typeof model === "string" && model.length > 0) {
        this.runtimeModel = model;
      }
    }
  }

  private handleMcpEvent(event: unknown): void {
    this.emitEvent({
      type: "provider_event",
      provider: "codex-mcp",
      raw: event,
    });

    if (!event || typeof event !== "object") {
      return;
    }
    const type = (event as { type?: unknown }).type;
    if (typeof type !== "string") {
      return;
    }

    if (type.includes(".") || type.startsWith("turn.") || type.startsWith("thread.") || type.startsWith("item.")) {
      this.handleThreadEvent(event as Record<string, unknown>);
      return;
    }

    switch (type) {
      case "agent_message": {
        const text = (event as { message?: string; text?: string }).message ??
          (event as { text?: string }).text ??
          "";
        if (text) {
          this.emitEvent({
            type: "timeline",
            provider: "codex-mcp",
            item: { type: "assistant_message", text },
          });
        }
        break;
      }
      case "agent_reasoning":
      case "agent_reasoning_delta": {
        const text = (event as { text?: string; delta?: string }).text ??
          (event as { delta?: string }).delta ??
          "";
        if (text) {
          this.emitEvent({
            type: "timeline",
            provider: "codex-mcp",
            item: { type: "reasoning", text },
          });
        }
        break;
      }
      case "task_started": {
        this.emitEvent({ type: "turn_started", provider: "codex-mcp" });
        break;
      }
      case "task_complete": {
        this.emitEvent({ type: "turn_completed", provider: "codex-mcp" });
        break;
      }
      case "turn_aborted": {
        this.emitEvent({
          type: "turn_failed",
          provider: "codex-mcp",
          error: "Codex MCP turn aborted",
        });
        break;
      }
      case "exec_command_begin": {
        const callId = normalizeCallId((event as { call_id?: string }).call_id);
        const command = (event as { command?: unknown }).command;
        const cwd = (event as { cwd?: string }).cwd;
        const emitEvent = () => {
          this.emitEvent({
            type: "timeline",
            provider: "codex-mcp",
            item: createToolCallTimelineItem({
              server: "command",
              tool: "shell",
              status: "running",
              callId,
              displayName: buildCommandDisplayName(command),
              kind: "execute",
              input: { command, cwd },
            }),
          });
        };
        if (this.queuePermissionGatedEvent(callId, event as Record<string, unknown>, emitEvent)) {
          break;
        }
        emitEvent();
        break;
      }
      case "exec_command_end": {
        const callId = normalizeCallId((event as { call_id?: string }).call_id);
        const command = (event as { command?: unknown }).command;
        const cwd = (event as { cwd?: string }).cwd;
        const exitCodeRaw = (event as { exit_code?: unknown; exitCode?: unknown }).exit_code ??
          (event as { exitCode?: unknown }).exitCode;
        const exitCode = typeof exitCodeRaw === "number" ? exitCodeRaw : undefined;
        const output = (event as { output?: string; stdout?: string }).output ??
          (event as { stdout?: string }).stdout ??
          (event as { stderr?: string }).stderr ??
          "";
        const structuredOutput =
          typeof output === "string"
            ? {
                type: "command" as const,
                command: extractCommandText(command) ?? "command",
                output,
                exitCode,
                cwd,
              }
            : undefined;
        const emitEvent = () => {
          if (typeof exitCode === "number" && exitCode !== 0) {
            this.turnState && (this.turnState.sawError = true);
          }
          this.emitEvent({
            type: "timeline",
            provider: "codex-mcp",
            item: createToolCallTimelineItem({
              server: "command",
              tool: "shell",
              status: exitCode && exitCode !== 0 ? "failed" : "completed",
              callId,
              displayName: buildCommandDisplayName(command),
              kind: "execute",
              input: { command, cwd },
              output: structuredOutput,
            }),
          });
          if (typeof exitCode === "number" && exitCode !== 0) {
            this.emitEvent({
              type: "timeline",
              provider: "codex-mcp",
              item: { type: "error", message: `Command failed with exit code ${exitCode}` },
            });
          }
        };
        if (this.queuePermissionGatedEvent(callId, event as Record<string, unknown>, emitEvent)) {
          break;
        }
        emitEvent();
        break;
      }
      case "exec_approval_request": {
        if (this.shouldGatePermissions()) {
          this.ensurePermissionRequestFromEvent(event as Record<string, unknown>);
        }
        break;
      }
      case "patch_apply_begin": {
        const callId = normalizeCallId((event as { call_id?: string }).call_id);
        const changes = (event as { changes?: Record<string, unknown> }).changes ?? {};
        const files = Object.keys(changes).map((file) => ({ path: file, kind: "edit" }));
        this.emitEvent({
          type: "timeline",
          provider: "codex-mcp",
          item: createToolCallTimelineItem({
            server: "file_change",
            tool: "apply_patch",
            status: "running",
            callId,
            displayName: buildFileChangeSummary(files),
            kind: "edit",
            input: { changes },
          }),
        });
        break;
      }
      case "patch_apply_end": {
        const callId = normalizeCallId((event as { call_id?: string }).call_id);
        const success = (event as { success?: boolean }).success ?? true;
        const files = (event as { files?: { path: string; kind: string }[] }).files ?? [];
        this.emitEvent({
          type: "timeline",
          provider: "codex-mcp",
          item: createToolCallTimelineItem({
            server: "file_change",
            tool: "apply_patch",
            status: success ? "completed" : "failed",
            callId,
            displayName: buildFileChangeSummary(files),
            kind: "edit",
            output: { files },
          }),
        });
        if (!success) {
          this.turnState && (this.turnState.sawError = true);
        }
        break;
      }
      default:
        break;
    }
  }

  private handleThreadEvent(event: Record<string, unknown>): void {
    const type = event.type as string;
    switch (type) {
      case "thread.started": {
        const threadId = event.thread_id as string | undefined;
        if (threadId) {
          this.sessionId = threadId;
          this.flushPendingHistory();
        }
        this.emitEvent({
          type: "thread_started",
          provider: "codex-mcp",
          sessionId: threadId ?? this.pendingLocalId ?? "",
        });
        break;
      }
      case "turn.started":
        this.emitEvent({ type: "turn_started", provider: "codex-mcp" });
        break;
      case "turn.completed": {
        const usage = this.convertUsage((event as { usage?: unknown }).usage);
        this.emitEvent({ type: "turn_completed", provider: "codex-mcp", usage });
        break;
      }
      case "turn.failed": {
        const error = (event as { error?: { message?: string } }).error?.message ?? "Codex MCP turn failed";
        this.emitEvent({ type: "turn_failed", provider: "codex-mcp", error });
        break;
      }
      case "item.started":
      case "item.updated":
      case "item.completed": {
        const item = event.item as Record<string, unknown> | undefined;
        if (!item) break;
        const timelineItem = this.threadItemToTimeline(item);
        if (timelineItem) {
          this.emitEvent({
            type: "timeline",
            provider: "codex-mcp",
            item: timelineItem,
          });
        }
        if (item.type === "command_execution") {
          const exitCode = item.exit_code ?? item.exitCode;
          if (typeof exitCode === "number" && exitCode !== 0) {
            this.turnState && (this.turnState.sawError = true);
            this.emitEvent({
              type: "timeline",
              provider: "codex-mcp",
              item: { type: "error", message: `Command failed with exit code ${exitCode}` },
            });
          }
        }
        break;
      }
      case "error": {
        const message = (event.message as string | undefined) ?? "Codex MCP stream error";
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
        break;
      }
      default:
        break;
    }
  }

  private threadItemToTimeline(item: Record<string, unknown>): AgentTimelineItem | null {
    const callId = extractThreadItemCallId(item);
    switch (item.type) {
      case "agent_message":
        return { type: "assistant_message", text: item.text as string };
      case "reasoning":
        return { type: "reasoning", text: item.text as string };
      case "user_message":
        return { type: "user_message", text: item.text as string };
      case "command_execution": {
        const aggregatedOutput = (item as { aggregated_output?: unknown }).aggregated_output;
        const exitCode = (item as { exit_code?: unknown; exitCode?: unknown }).exit_code ??
          (item as { exitCode?: unknown }).exitCode;
        const cwd = (item as { cwd?: string }).cwd;
        const commandValue = item.command;
        const command =
          typeof commandValue === "string"
            ? commandValue
            : Array.isArray(commandValue)
              ? (commandValue as string[]).join(" ")
              : "command";

        const structuredOutput =
          typeof aggregatedOutput === "string"
            ? {
                type: "command" as const,
                command,
                output: aggregatedOutput,
                exitCode: typeof exitCode === "number" ? exitCode : undefined,
                cwd,
              }
            : undefined;

        return createToolCallTimelineItem({
          server: "command",
          tool: "shell",
          status: item.status as string | undefined,
          callId,
          displayName: buildCommandDisplayName(item.command),
          kind: "execute",
          input: { command: item.command, cwd },
          output: structuredOutput,
          error: item.error,
        });
      }
      case "file_change": {
        const changes = (item.changes as Array<{ path: string; kind: string }> | undefined) ?? [];
        const files = changes.map((change) => ({
          path: change.path,
          kind: change.kind,
        }));
        return createToolCallTimelineItem({
          server: "file_change",
          tool: "apply_patch",
          status: "completed",
          callId,
          displayName: buildFileChangeSummary(files),
          kind: "edit",
          output: { files },
        });
      }
      case "mcp_tool_call":
        return createToolCallTimelineItem({
          server: item.server as string,
          tool: item.tool as string,
          status: item.status as string | undefined,
          callId,
          displayName: `${item.server}.${item.tool}`,
          kind: "tool",
          input: item.input,
          output: item.output,
        });
      case "web_search":
        return createToolCallTimelineItem({
          server: "web_search",
          tool: "web_search",
          status: (item as { status?: string }).status ?? "completed",
          callId,
          displayName: item.query ? `Web search: ${item.query}` : "Web search",
          kind: "search",
          input: { query: item.query },
        });
      case "todo_list":
        return { type: "todo", items: item.items as any };
      case "error":
        return { type: "error", message: item.message as string };
      default:
        return null;
    }
  }

  private convertUsage(usage?: unknown): AgentUsage | undefined {
    if (!usage || typeof usage !== "object") {
      return undefined;
    }
    const record = usage as Record<string, unknown>;
    return {
      inputTokens: typeof record.input_tokens === "number" ? record.input_tokens : undefined,
      cachedInputTokens:
        typeof record.cached_input_tokens === "number" ? record.cached_input_tokens : undefined,
      outputTokens: typeof record.output_tokens === "number" ? record.output_tokens : undefined,
      totalCostUsd: typeof record.total_cost_usd === "number" ? record.total_cost_usd : undefined,
    };
  }

  private buildPermissionRequest(params: unknown): AgentPermissionRequest | null {
    if (!params || typeof params !== "object") {
      return null;
    }
    const record = params as Record<string, unknown>;
    const callId =
      (record.codex_call_id as string | undefined) ??
      (record.codex_mcp_tool_call_id as string | undefined) ??
      (record.codex_event_id as string | undefined) ??
      (record.call_id as string | undefined) ??
      randomUUID();
    const requestId = `permission-${callId}`;
    const command = record.codex_command ?? record.command;
    const cwd = record.codex_cwd ?? record.cwd;
    const commandText = extractCommandText(command);
    const message = typeof record.message === "string" ? record.message : undefined;

    return {
      id: requestId,
      provider: "codex-mcp" as AgentPermissionRequest["provider"],
      name: "exec_command",
      kind: "tool",
      title: commandText ? `Run command: ${commandText}` : "Run shell command",
      description: message,
      input: {
        command,
        cwd,
      },
      metadata: {
        callId,
        raw: record,
      },
    };
  }
}

export class CodexMcpAgentClient implements AgentClient {
  readonly provider = "codex-mcp" as AgentClient["provider"];
  readonly capabilities = CODEX_MCP_CAPABILITIES;

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    const session = new CodexMcpAgentSession(config as CodexMcpAgentConfig);
    await session.connect();
    return session;
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>
  ): Promise<AgentSession> {
    const metadata = handle.metadata && typeof handle.metadata === "object"
      ? (handle.metadata as Record<string, unknown>)
      : {};
    const storedConfig = metadata as Partial<AgentSessionConfig>;
    const merged: AgentSessionConfig = {
      ...storedConfig,
      ...overrides,
      provider: "codex-mcp",
      cwd:
        overrides?.cwd ??
        storedConfig.cwd ??
        process.cwd(),
    };
    const session = new CodexMcpAgentSession(
      merged as CodexMcpAgentConfig,
      handle
    );
    await session.connect();
    return session;
  }
}
