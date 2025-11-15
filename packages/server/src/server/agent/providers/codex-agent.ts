import { randomUUID } from "node:crypto";
import { promises as fs, constants as fsConstants } from "node:fs";
import type { Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  Codex,
  type ApprovalMode,
  type CodexOptions,
  type Input as CodexInput,
  type ModelReasoningEffort,
  type SandboxMode,
  type Thread,
  type ThreadEvent,
  type ThreadItem,
  type ThreadOptions,
  type TurnOptions,
  type Usage as CodexUsage,
} from "@openai/codex-sdk";

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
  ListPersistedAgentsOptions,
  PersistedAgentDescriptor,
} from "../agent-sdk-types.js";

type CodexAgentConfig = AgentSessionConfig & { provider: "codex" };

const CODEX_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
};

const CODEX_MODES: AgentMode[] = [
  {
    id: "read-only",
    label: "Read Only",
    description:
      "Codex can read files and answer questions. Manual approval required for edits, commands, or network ops.",
  },
  {
    id: "auto",
    label: "Auto",
    description:
      "Codex can edit files and run commands inside the workspace but still asks before escalating scope.",
  },
  {
    id: "full-access",
    label: "Full Access",
    description: "Codex can edit files, run commands, and access the network without additional prompts.",
  },
];

const DEFAULT_CODEX_MODE_ID = "auto";

const MODE_PRESETS: Record<
  string,
  Partial<ThreadOptions> & { networkAccessEnabled?: boolean; webSearchEnabled?: boolean }
> = {
  "read-only": {
    sandboxMode: "read-only",
    approvalPolicy: "untrusted",
    networkAccessEnabled: false,
    webSearchEnabled: false,
  },
  auto: {
    sandboxMode: "workspace-write",
    approvalPolicy: "on-request",
    networkAccessEnabled: false,
    webSearchEnabled: false,
  },
  "full-access": {
    sandboxMode: "danger-full-access",
    approvalPolicy: "never",
    networkAccessEnabled: true,
    webSearchEnabled: true,
  },
};

type CodexOptionsOverrides = Partial<ThreadOptions> & { skipGitRepoCheck?: boolean };

const MAX_ROLLOUT_SEARCH_DEPTH = 5;
type ToolCallTimelineItem = Extract<AgentTimelineItem, { type: "tool_call" }>;

function createToolCallTimelineItem(
  data: Omit<ToolCallTimelineItem, "type">
): AgentTimelineItem {
  return { type: "tool_call", ...data };
}

function buildCommandDisplayName(command?: unknown): string {
  if (typeof command === "string") {
    const trimmed = command.trim();
    if (trimmed.length) {
      return trimmed;
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

function coerceSandboxMode(value?: string): SandboxMode | undefined {
  if (!value) return undefined;
  if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") {
    return value;
  }
  return undefined;
}

function coerceApprovalMode(value?: string): ApprovalMode | undefined {
  if (!value) return undefined;
  if (value === "never" || value === "on-request" || value === "on-failure" || value === "untrusted") {
    return value;
  }
  return undefined;
}

function coerceReasoningEffort(value?: string): ModelReasoningEffort | undefined {
  if (!value) return undefined;
  if (value === "minimal" || value === "low" || value === "medium" || value === "high") {
    return value;
  }
  return undefined;
}

function normalizeExtraOptions(extra?: Record<string, unknown>): CodexOptionsOverrides | undefined {
  if (!extra) return undefined;
  const allowedKeys = new Set([
    "model",
    "sandboxMode",
    "skipGitRepoCheck",
    "modelReasoningEffort",
    "networkAccessEnabled",
    "webSearchEnabled",
    "approvalPolicy",
  ]);

  const normalized: CodexOptionsOverrides = {};
  for (const [key, value] of Object.entries(extra)) {
    if (!allowedKeys.has(key)) continue;
    (normalized as Record<string, unknown>)[key] = value;
  }
  return normalized;
}

export class CodexAgentClient implements AgentClient {
  readonly provider = "codex" as const;
  readonly capabilities = CODEX_CAPABILITIES;
  private readonly codex: Codex;

  constructor(options?: CodexOptions) {
    this.codex = new Codex(options);
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    const codexConfig = this.assertConfig(config);
    return CodexAgentSession.create(this.codex, codexConfig);
  }

  async resumeSession(handle: AgentPersistenceHandle, overrides?: Partial<AgentSessionConfig>): Promise<AgentSession> {
    const metadata = (handle.metadata ?? {}) as Partial<AgentSessionConfig>;
    const merged = { ...metadata, ...overrides } as Partial<AgentSessionConfig>;
    if (!merged.cwd) {
      throw new Error("Codex resume requires the original working directory in metadata");
    }
    const mergedConfig = { ...merged, provider: "codex" } as AgentSessionConfig;
    const codexConfig = this.assertConfig(mergedConfig);
    return CodexAgentSession.create(this.codex, codexConfig, handle);
  }

  async listPersistedAgents(options?: ListPersistedAgentsOptions): Promise<PersistedAgentDescriptor[]> {
    const sessionRoot = resolveCodexSessionRoot();
    if (!sessionRoot) {
      return [];
    }
    if (!(await fileExists(sessionRoot))) {
      return [];
    }
    const limit = options?.limit ?? 20;
    const candidates = await collectRecentRolloutFiles(sessionRoot, limit * 3);
    const descriptors: PersistedAgentDescriptor[] = [];
    for (const candidate of candidates) {
      const descriptor = await parseRolloutDescriptor(candidate.path, candidate.mtime, sessionRoot);
      if (descriptor) {
        descriptors.push(descriptor);
      }
      if (descriptors.length >= limit) {
        break;
      }
    }
    return descriptors;
  }

  private assertConfig(config: AgentSessionConfig): CodexAgentConfig {
    if (config.provider !== "codex") {
      throw new Error(`CodexAgentClient received config for provider '${config.provider}'`);
    }
    return config as CodexAgentConfig;
  }
}

class CodexAgentSession implements AgentSession {
  static async create(codex: Codex, config: CodexAgentConfig, handle?: AgentPersistenceHandle): Promise<CodexAgentSession> {
    const session = new CodexAgentSession(codex, config, handle);
    if (handle) {
      await session.loadReplayHistory(handle);
    }
    return session;
  }

  readonly provider = "codex" as const;
  readonly capabilities = CODEX_CAPABILITIES;

  private readonly codex: Codex;
  private config: CodexAgentConfig;
  private threadOptions: ThreadOptions;
  private thread: Thread | null;
  private threadId: string | null;
  private persistence: AgentPersistenceHandle | null;
  private pendingLocalId: string;
  private currentMode: string;
  private availableModes: AgentMode[] = CODEX_MODES;
  private readonly codexSessionDir: string | null;
  private rolloutPath: string | null;
  private historyEvents: AgentStreamEvent[] = [];
  private pendingPermissions = new Map<string, AgentPermissionRequest>();

  constructor(codex: Codex, config: CodexAgentConfig, handle?: AgentPersistenceHandle) {
    this.codex = codex;
    this.config = { ...config };
    this.currentMode = this.config.modeId ?? DEFAULT_CODEX_MODE_ID;
    this.threadOptions = this.buildThreadOptions(this.currentMode);
    this.codexSessionDir = this.resolveCodexSessionDir(handle);
    this.rolloutPath = this.readRolloutPath(handle);
    this.threadId = handle?.sessionId ?? handle?.nativeHandle ?? null;
    this.pendingLocalId = this.threadId ?? `codex-${randomUUID()}`;
    this.persistence = handle ?? null;
    if (handle && !this.threadId) {
      throw new Error("Codex resume requires a thread id");
    }
    this.thread = handle
      ? this.codex.resumeThread(this.threadId!, this.threadOptions)
      : this.codex.startThread(this.threadOptions);
  }

  get id(): string | null {
    return this.threadId;
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
      sessionId: this.threadId ?? this.pendingLocalId,
      finalText,
      usage,
      timeline,
    };
  }

  async *stream(prompt: AgentPromptInput, options?: AgentRunOptions): AsyncGenerator<AgentStreamEvent> {
    const thread = this.thread;
    if (!thread) {
      throw new Error("Codex session is closed");
    }

    const replayEvents = this.drainHistoryEvents();
    for (const event of replayEvents) {
      yield event;
    }

    const input = this.toCodexInput(prompt);
    const turnOptions = this.buildTurnOptions(options);
    const { events } = await thread.runStreamed(input, turnOptions);

    for await (const rawEvent of events) {
      yield* this.translateEvent(rawEvent);
      if (rawEvent.type === "turn.completed" || rawEvent.type === "turn.failed" || rawEvent.type === "error") {
        break;
      }
    }
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    const replayEvents = this.drainHistoryEvents();
    for (const event of replayEvents) {
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
    if (modeId === this.currentMode) {
      return;
    }
    if (!this.availableModes.some((mode) => mode.id === modeId)) {
      throw new Error(`Mode '${modeId}' not supported by Codex`);
    }

    this.currentMode = modeId;
    this.config.modeId = modeId;
    this.threadOptions = this.buildThreadOptions(modeId);

    if (this.threadId) {
      this.thread = this.codex.resumeThread(this.threadId, this.threadOptions);
    } else {
      this.pendingLocalId = `codex-${randomUUID()}`;
      this.thread = this.codex.startThread(this.threadOptions);
    }
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return Array.from(this.pendingPermissions.values());
  }

  async respondToPermission(requestId: string, response: AgentPermissionResponse): Promise<void> {
    const request = this.pendingPermissions.get(requestId);
    if (!request) {
      throw new Error(`No pending Codex permission request with id '${requestId}'`);
    }

    this.pendingPermissions.delete(requestId);

    const status = response.behavior === "allow" ? "granted" : "denied";
    this.enqueueHistoryEvent({
      type: "timeline",
      provider: "codex",
      item: createToolCallTimelineItem({
        server: "permission",
        tool: request.name,
        status,
        callId: request.id,
        displayName: request.title ?? request.name,
        kind: "permission",
        input: request.input,
        raw: { request, response },
      }),
    });

    this.enqueueHistoryEvent({
      type: "permission_resolved",
      provider: "codex",
      requestId,
      resolution: response,
    });
  }

  describePersistence(): AgentPersistenceHandle | null {
    if (this.persistence) {
      return this.persistence;
    }
    if (!this.threadId) {
      return null;
    }
    this.persistence = {
      provider: "codex",
      sessionId: this.threadId,
      nativeHandle: this.threadId,
      metadata: {
        ...this.config,
        codexSessionDir: this.codexSessionDir ?? undefined,
        codexRolloutPath: this.rolloutPath ?? undefined,
      },
    };
    return this.persistence;
  }

  async close(): Promise<void> {
    this.thread = null;
    this.pendingPermissions.clear();
  }

  private drainHistoryEvents(): AgentStreamEvent[] {
    if (!this.historyEvents.length) {
      return [];
    }
    const events = [...this.historyEvents];
    this.historyEvents = [];
    return events;
  }

  private enqueueHistoryEvent(event: AgentStreamEvent): void {
    this.historyEvents.push(event);
  }

  private buildThreadOptions(modeId: string): ThreadOptions {
    const options: ThreadOptions = {
      workingDirectory: this.config.cwd,
      skipGitRepoCheck: true,
    };

    const preset = MODE_PRESETS[modeId] ?? MODE_PRESETS[DEFAULT_CODEX_MODE_ID];
    if (preset) {
      Object.assign(options, preset);
    }

    if (this.config.model) {
      options.model = this.config.model;
    }
    if (this.config.sandboxMode) {
      options.sandboxMode = coerceSandboxMode(this.config.sandboxMode) ?? options.sandboxMode;
    }
    if (this.config.approvalPolicy) {
      options.approvalPolicy = coerceApprovalMode(this.config.approvalPolicy) ?? options.approvalPolicy;
    }
    if (typeof this.config.networkAccess === "boolean") {
      options.networkAccessEnabled = this.config.networkAccess;
    }
    if (typeof this.config.webSearch === "boolean") {
      options.webSearchEnabled = this.config.webSearch;
    }
    if (this.config.reasoningEffort) {
      options.modelReasoningEffort =
        coerceReasoningEffort(this.config.reasoningEffort) ?? options.modelReasoningEffort;
    }

    const extra = normalizeExtraOptions(this.config.extra?.codex as Record<string, unknown> | undefined);
    if (extra) {
      Object.assign(options, extra);
    }

    return options;
  }

  private async loadReplayHistory(handle: AgentPersistenceHandle): Promise<void> {
    const threadIdentifier = handle.sessionId ?? handle.nativeHandle;
    if (!threadIdentifier || !this.codexSessionDir) {
      return;
    }

    let rolloutFile = this.rolloutPath;
    if (rolloutFile && !(await fileExists(rolloutFile))) {
      rolloutFile = null;
    }

    if (!rolloutFile) {
      rolloutFile = await findRolloutFile(threadIdentifier, this.codexSessionDir);
    }

    if (!rolloutFile) {
      return;
    }

    this.rolloutPath = rolloutFile;

    try {
      const events = await parseRolloutFile(rolloutFile, threadIdentifier);
      if (events.length) {
        this.historyEvents = events;
      }
    } catch (error) {
      console.warn(`[CodexAgentSession] Failed to parse rollout ${rolloutFile}:`, error);
    }
  }

  private resolveCodexSessionDir(handle?: AgentPersistenceHandle): string | null {
    const metadataDir = readMetadataString(handle, "codexSessionDir");
    if (metadataDir) {
      return metadataDir;
    }

    const extraDir = readCodexExtraString(this.config, "sessionDir");
    if (extraDir) {
      return extraDir;
    }

    if (process.env.CODEX_SESSION_DIR) {
      return process.env.CODEX_SESSION_DIR;
    }

    const extraHome = readCodexExtraString(this.config, "home");
    const codexHome = extraHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
    return path.join(codexHome, "sessions");
  }

  private readRolloutPath(handle?: AgentPersistenceHandle): string | null {
    const metadataRollout = readMetadataString(handle, "codexRolloutPath");
    if (metadataRollout) {
      return metadataRollout;
    }
    const extraRollout = readCodexExtraString(this.config, "rolloutPath");
    return extraRollout ?? null;
  }

  private buildTurnOptions(options?: AgentRunOptions): TurnOptions {
    if (!options?.outputSchema) {
      return {};
    }
    return { outputSchema: options.outputSchema };
  }

  private toCodexInput(prompt: AgentPromptInput): CodexInput {
    if (typeof prompt === "string") {
      return prompt;
    }
    return prompt.map((chunk) => ({ type: "text", text: chunk.text }));
  }

  private *translateEvent(event: ThreadEvent): Generator<AgentStreamEvent> {
    yield { type: "provider_event", provider: "codex", raw: event };

    const permissionEvents = this.handlePermissionEvent(event);
    if (permissionEvents) {
      for (const permissionEvent of permissionEvents) {
        yield permissionEvent;
      }
      return;
    }

    switch (event.type) {
      case "thread.started":
        this.threadId = event.thread_id;
        this.pendingLocalId = event.thread_id;
        this.persistence = null;
        yield { type: "thread_started", provider: "codex", sessionId: event.thread_id };
        break;
      case "turn.started":
        yield { type: "turn_started", provider: "codex" };
        break;
      case "turn.completed":
        yield {
          type: "turn_completed",
          provider: "codex",
          usage: this.convertUsage(event.usage),
        };
        break;
      case "turn.failed":
        yield {
          type: "turn_failed",
          provider: "codex",
          error: event.error?.message ?? "Codex turn failed",
        };
        break;
      case "item.started":
      case "item.updated":
      case "item.completed": {
        const item = this.threadItemToTimeline(event.item);
        if (item) {
          yield { type: "timeline", provider: "codex", item };
        }
        break;
      }
      case "error": {
        const message = event.message ?? "Codex stream error";
        yield {
          type: "timeline",
          provider: "codex",
          item: { type: "error", message, raw: event },
        };
        yield { type: "turn_failed", provider: "codex", error: message };
        break;
      }
      default:
        break;
    }
  }

  private handlePermissionEvent(event: ThreadEvent): AgentStreamEvent[] | null {
    const eventType = typeof (event as { type?: string }).type === "string" ? (event as { type?: string }).type : null;
    if (!eventType) {
      return null;
    }

    if (eventType === "exec_approval_request") {
      const request = this.buildExecPermissionRequest(event as any);
      return this.enqueuePermissionRequest(request);
    }

    if (eventType === "apply_patch_approval_request") {
      const request = this.buildPatchPermissionRequest(event as any);
      return this.enqueuePermissionRequest(request);
    }

    return null;
  }

  private enqueuePermissionRequest(request: AgentPermissionRequest | null): AgentStreamEvent[] | null {
    if (!request) {
      return null;
    }

    this.pendingPermissions.set(request.id, request);

    const events: AgentStreamEvent[] = [
      {
        type: "timeline",
        provider: "codex",
        item: createToolCallTimelineItem({
          server: "permission",
          tool: request.name,
          status: "requested",
          callId: request.id,
          displayName: request.title ?? request.name,
          kind: "permission",
          input: request.input,
          raw: request.raw,
        }),
      },
      { type: "permission_requested", provider: "codex", request },
    ];

    return events;
  }

  private buildExecPermissionRequest(raw: any): AgentPermissionRequest | null {
    if (!raw || typeof raw !== "object") {
      return null;
    }

    const commandParts: string[] = Array.isArray(raw.command)
      ? raw.command.filter((entry: unknown) => typeof entry === "string")
      : typeof raw.command === "string"
        ? [raw.command]
        : [];
    const commandText = commandParts.join(" ").trim();
    const cwd = typeof raw.cwd === "string" && raw.cwd.length ? raw.cwd : undefined;
    const requestId = typeof raw.call_id === "string" && raw.call_id.length ? raw.call_id : randomUUID();
    const reason = typeof raw.reason === "string" && raw.reason.length ? raw.reason : undefined;
    const risk = raw.risk && typeof raw.risk === "object" ? raw.risk : undefined;
    const parsedCommand = Array.isArray(raw.parsed_cmd) ? raw.parsed_cmd : undefined;

    const metadata: Record<string, unknown> = {
      callId: raw.call_id,
      command: commandText || undefined,
      cwd,
      reason,
    };
    if (risk) {
      metadata.risk = risk;
    }
    if (parsedCommand) {
      metadata.parsedCommand = parsedCommand;
    }

    const description = reason ?? (risk?.description as string | undefined);

    const request: AgentPermissionRequest = {
      id: `permission-${requestId}`,
      provider: "codex",
      name: "exec_command",
      kind: "tool",
      title: commandText ? `Run command: ${commandText}` : "Run shell command",
      description: description ?? undefined,
      input: {
        command: commandParts,
        cwd,
        reason,
        risk,
        parsedCommand,
      },
      metadata: sanitizeMetadata(metadata),
      raw,
    };

    return request;
  }

  private buildPatchPermissionRequest(raw: any): AgentPermissionRequest | null {
    if (!raw || typeof raw !== "object") {
      return null;
    }

    const requestId = typeof raw.call_id === "string" && raw.call_id.length ? raw.call_id : randomUUID();
    const changes = raw.changes && typeof raw.changes === "object" ? raw.changes : undefined;
    const filePaths = changes ? Object.keys(changes) : [];
    const grantRoot = typeof raw.grant_root === "string" && raw.grant_root.length ? raw.grant_root : undefined;
    const reason = typeof raw.reason === "string" && raw.reason.length ? raw.reason : undefined;

    const title =
      filePaths.length > 0
        ? `Apply patch to ${filePaths.length} file${filePaths.length === 1 ? "" : "s"}`
        : "Apply patch";

    const metadata: Record<string, unknown> = {
      callId: raw.call_id,
      files: filePaths.length ? filePaths : undefined,
      grantRoot,
      reason,
    };

    const input: Record<string, unknown> = {
      changes,
      files: filePaths,
      grantRoot,
      reason,
    };

    const request: AgentPermissionRequest = {
      id: `permission-${requestId}`,
      provider: "codex",
      name: "apply_patch",
      kind: "tool",
      title,
      description: reason ?? undefined,
      input,
      suggestions: grantRoot ? [{ grantRoot }] : undefined,
      metadata: sanitizeMetadata(metadata),
      raw,
    };

    return request;
  }

  private threadItemToTimeline(item: ThreadItem): AgentTimelineItem | null {
    switch (item.type) {
      case "agent_message":
        return { type: "assistant_message", text: item.text, raw: item };
      case "reasoning":
        return { type: "reasoning", text: item.text, raw: item };
      case "command_execution":
        return createToolCallTimelineItem({
          server: "command",
          tool: "shell",
          status: item.status,
          callId: (item as any)?.call_id,
          displayName: buildCommandDisplayName(item.command),
          kind: "execute",
          input: { command: item.command, cwd: (item as any)?.cwd },
          output: (item as any)?.output,
          error: (item as any)?.error,
          raw: item,
        });
      case "file_change": {
        const files = item.changes.map((change) => ({ path: change.path, kind: change.kind }));
        return createToolCallTimelineItem({
          server: "file_change",
          tool: "apply_patch",
          status: "completed",
          callId: (item as any)?.call_id,
          displayName: buildFileChangeSummary(files),
          kind: "edit",
          output: { files },
          raw: item,
        });
      }
      case "mcp_tool_call":
        return createToolCallTimelineItem({
          server: item.server,
          tool: item.tool,
          status: item.status,
          callId: (item as any)?.call_id,
          displayName: `${item.server}.${item.tool}`,
          kind: "tool",
          input: (item as any)?.input,
          output: (item as any)?.output,
          raw: item,
        });
      case "web_search":
        return createToolCallTimelineItem({
          server: "web_search",
          tool: "web_search",
          status: (item as any)?.status ?? "completed",
          callId: (item as any)?.call_id,
          displayName: item.query ? `Web search: ${item.query}` : "Web search",
          kind: "search",
          input: { query: item.query },
          raw: item,
        });
      case "todo_list":
        return { type: "todo", items: item.items, raw: item };
      case "error":
        return { type: "error", message: item.message, raw: item };
      default:
        return null;
    }
  }

  private convertUsage(usage?: CodexUsage): AgentUsage | undefined {
    if (!usage) {
      return undefined;
    }
    return {
      inputTokens: usage.input_tokens,
      cachedInputTokens: usage.cached_input_tokens,
      outputTokens: usage.output_tokens,
    };
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function findRolloutFile(threadId: string, root: string): Promise<string | null> {
  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isFile()) {
        const matchesThread = entry.name.includes(threadId);
        const matchesPrefix = entry.name.startsWith("rollout-");
        const matchesExtension = entry.name.endsWith(".json") || entry.name.endsWith(".jsonl");
        if (matchesThread && matchesPrefix && matchesExtension) {
          return entryPath;
        }
      } else if (entry.isDirectory() && depth < MAX_ROLLOUT_SEARCH_DEPTH) {
        stack.push({ dir: entryPath, depth: depth + 1 });
      }
    }
  }
  return null;
}

async function parseRolloutFile(filePath: string, threadId: string): Promise<AgentStreamEvent[]> {
  const content = await fs.readFile(filePath, "utf8");
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const events: AgentStreamEvent[] = [{ type: "thread_started", provider: "codex", sessionId: threadId }];
  const commandCalls = new Map<string, { command: string }>();

  for (const line of lines) {
    const entry = parseRolloutEntry(line);
    if (!entry) continue;

    if (entry.type === "response_item") {
      handleRolloutResponseItem(entry.payload, events, commandCalls);
    } else if (entry.type === "event_msg") {
      handleRolloutEventMessage(entry.payload, events);
    }
  }

  return events;
}

function parseRolloutEntry(line: string): { type: string; payload?: any } | null {
  if (!line) {
    return null;
  }
  try {
    const parsed = JSON.parse(line);
    if (parsed && typeof parsed === "object" && "type" in parsed) {
      return parsed as { type: string; payload?: any };
    }
    if (parsed && typeof parsed === "object" && typeof (parsed as any).output === "string") {
      return parseRolloutEntry((parsed as any).output);
    }
  } catch {
    return null;
  }
  return null;
}

function handleRolloutResponseItem(
  payload: any,
  events: AgentStreamEvent[],
  commandCalls: Map<string, { command: string }>
): void {
  if (!payload || typeof payload !== "object") {
    return;
  }

  switch (payload.type) {
    case "message": {
      if (payload.role !== "assistant") {
        return;
      }
      const text = extractMessageText(payload.content);
      if (text) {
        events.push({ type: "timeline", provider: "codex", item: { type: "assistant_message", text, raw: payload } });
      }
      break;
    }
    case "reasoning": {
      const text = extractReasoningText(payload);
      if (text) {
        events.push({ type: "timeline", provider: "codex", item: { type: "reasoning", text, raw: payload } });
      }
      break;
    }
    case "function_call": {
      handleRolloutFunctionCall(payload, events, commandCalls);
      break;
    }
    case "function_call_output": {
      finalizeRolloutFunctionCall(payload, events, commandCalls);
      break;
    }
    case "custom_tool_call": {
      handleRolloutCustomToolCall(payload, events);
      break;
    }
    default:
      break;
  }
}

function handleRolloutEventMessage(payload: any, events: AgentStreamEvent[]): void {
  if (!payload || typeof payload !== "object") {
    return;
  }
  if (payload.type === "agent_reasoning" && typeof payload.text === "string") {
    events.push({ type: "timeline", provider: "codex", item: { type: "reasoning", text: payload.text, raw: payload } });
  }
}

function handleRolloutFunctionCall(
  payload: any,
  events: AgentStreamEvent[],
  commandCalls: Map<string, { command: string }>
): void {
  const name = typeof payload.name === "string" ? payload.name : undefined;
  if (!name) {
    return;
  }

  if (name === "shell") {
    const args = safeJsonParse(payload.arguments);
    const command = formatCommand(args);
    if (command && typeof payload.call_id === "string") {
      commandCalls.set(payload.call_id, { command });
    }
    return;
  }

  if (name === "update_plan") {
    const args = safeJsonParse(payload.arguments);
    const planItems = parsePlanItems(args);
    if (planItems.length) {
      events.push({ type: "timeline", provider: "codex", item: { type: "todo", items: planItems, raw: payload } });
    }
    return;
  }

  events.push({
    type: "timeline",
    provider: "codex",
    item: createToolCallTimelineItem({
      server: "codex",
      tool: name,
      status: payload.status ?? "in_progress",
      callId: typeof payload.call_id === "string" ? payload.call_id : undefined,
      displayName: `${name}`,
      kind: "tool",
      input: safeJsonParse(payload.arguments),
      raw: payload,
    }),
  });
}

function finalizeRolloutFunctionCall(
  payload: any,
  events: AgentStreamEvent[],
  commandCalls: Map<string, { command: string }>
): void {
  if (typeof payload.call_id !== "string") {
    return;
  }
  const command = commandCalls.get(payload.call_id);
  if (!command) {
    return;
  }
  const result = safeJsonParse(payload.output);
  const exitCode = result?.metadata?.exit_code;
  const status = exitCode === undefined || exitCode === 0 ? "completed" : "failed";
  events.push({
    type: "timeline",
    provider: "codex",
    item: createToolCallTimelineItem({
      server: "command",
      tool: "shell",
      status,
      callId: payload.call_id,
      displayName: buildCommandDisplayName(command.command),
      kind: "execute",
      input: { command: command.command },
      output: result,
      raw: { payload, result },
    }),
  });
  commandCalls.delete(payload.call_id);
}

function handleRolloutCustomToolCall(payload: any, events: AgentStreamEvent[]): void {
  if (payload?.name === "apply_patch" && typeof payload.input === "string") {
    const files = parsePatchFiles(payload.input);
    if (files.length) {
      events.push({
        type: "timeline",
        provider: "codex",
        item: createToolCallTimelineItem({
          server: "file_change",
          tool: "apply_patch",
          status: "completed",
          displayName: buildFileChangeSummary(files),
          kind: "edit",
          output: { files },
          raw: payload,
        }),
      });
    }
    return;
  }

  if (typeof payload?.name === "string") {
    events.push({
      type: "timeline",
      provider: "codex",
      item: createToolCallTimelineItem({
        server: "codex",
        tool: payload.name,
        status: payload.status ?? "completed",
        displayName: payload.name,
        kind: "tool",
        input: payload.input,
        output: payload.output,
        raw: payload,
      }),
    });
  }
}

type RolloutCandidate = {
  path: string;
  mtime: Date;
};

async function collectRecentRolloutFiles(rootDir: string, limit: number): Promise<RolloutCandidate[]> {
  const candidates: RolloutCandidate[] = [];
  async function traverse(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const files = entries.filter(
      (entry) =>
        entry.isFile() &&
        entry.name.startsWith("rollout-") &&
        (entry.name.endsWith(".json") || entry.name.endsWith(".jsonl"))
    );
    for (const entry of files) {
      const fullPath = path.join(dir, entry.name);
      try {
        const stat = await fs.stat(fullPath);
        candidates.push({ path: fullPath, mtime: stat.mtime });
      } catch {
        // ignore stat failures
      }
    }
    const directories = entries
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => b.name.localeCompare(a.name));
    for (const dirEntry of directories) {
      await traverse(path.join(dir, dirEntry.name));
    }
  }
  await traverse(rootDir);
  return candidates
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
    .slice(0, limit);
}

async function parseRolloutDescriptor(
  filePath: string,
  mtime: Date,
  sessionRoot: string
): Promise<PersistedAgentDescriptor | null> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }

  let sessionId: string | null = null;
  let cwd: string | null = null;
  let title: string | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!sessionId && entry?.type === "session_meta" && entry.payload) {
      sessionId = typeof entry.payload.id === "string" ? entry.payload.id : null;
      if (typeof entry.payload.cwd === "string" && entry.payload.cwd.length > 0) {
        cwd = entry.payload.cwd;
      }
    } else if (!title && entry?.type === "response_item" && entry.payload?.role === "user") {
      title = extractCodexUserPrompt(entry.payload);
    }
    if (sessionId && cwd && title) {
      break;
    }
  }

  if (!sessionId || !cwd) {
    return null;
  }

  const persistence: AgentPersistenceHandle = {
    provider: "codex",
    sessionId,
    nativeHandle: sessionId,
    metadata: sanitizeMetadata({
      provider: "codex",
      cwd,
      codexSessionDir: sessionRoot,
      codexRolloutPath: filePath,
    }),
  };

  return {
    provider: "codex",
    sessionId,
    cwd,
    title: (title ?? "").trim() || `Codex session ${sessionId.slice(0, 8)}`,
    lastActivityAt: mtime,
    persistence,
  };
}

function extractCodexUserPrompt(payload: any): string | null {
  const content = payload?.content;
  if (!Array.isArray(content)) {
    return null;
  }
  for (const block of content) {
    if (block && typeof block === "object" && typeof block.text === "string") {
      return block.text.trim();
    }
  }
  return null;
}

function resolveCodexSessionRoot(): string | null {
  if (process.env.CODEX_SESSION_DIR) {
    return process.env.CODEX_SESSION_DIR;
  }
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  return path.join(codexHome, "sessions");
}

function extractMessageText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as any).type === "output_text" && typeof (block as any).text === "string") {
      parts.push((block as any).text);
    }
  }
  return parts.join("\n").trim();
}

function extractReasoningText(payload: any): string {
  if (Array.isArray(payload?.summary)) {
    const text = payload.summary
      .map((item: any) => (typeof item?.text === "string" ? item.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
    if (text) {
      return text;
    }
  }
  if (typeof payload?.text === "string") {
    return payload.text;
  }
  return "";
}

function parsePlanItems(args: any): { text: string; completed: boolean }[] {
  const plan = Array.isArray(args?.plan) ? args.plan : [];
  const items: { text: string; completed: boolean }[] = [];
  for (const step of plan) {
    if (!step || typeof step !== "object") {
      continue;
    }
    const text = typeof step.step === "string" ? step.step : typeof step.text === "string" ? step.text : "";
    if (!text) {
      continue;
    }
    const status = typeof step.status === "string" ? step.status : "";
    items.push({ text, completed: status === "completed" });
  }
  return items;
}

function parsePatchFiles(patch: string): { path: string; kind: string }[] {
  const files: { path: string; kind: string }[] = [];
  const seen = new Set<string>();
  const lines = patch.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    let kind: string | null = null;
    let pathValue: string | null = null;
    if (trimmed.startsWith("*** Add File:")) {
      kind = "add";
      pathValue = trimmed.replace("*** Add File:", "").trim();
    } else if (trimmed.startsWith("*** Delete File:")) {
      kind = "delete";
      pathValue = trimmed.replace("*** Delete File:", "").trim();
    } else if (trimmed.startsWith("*** Update File:")) {
      kind = "update";
      pathValue = trimmed.replace("*** Update File:", "").trim();
    }
    if (kind && pathValue && !seen.has(`${kind}:${pathValue}`)) {
      seen.add(`${kind}:${pathValue}`);
      files.push({ path: pathValue, kind });
    }
  }
  return files;
}

function safeJsonParse<T = any>(value: unknown): T | null {
  if (typeof value !== "string") {
    return null;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function formatCommand(args: any): string | null {
  if (!args) {
    return null;
  }
  if (Array.isArray(args.command)) {
    return args.command.join(" ");
  }
  if (typeof args.command === "string") {
    return args.command;
  }
  return null;
}

function readCodexExtraString(config: CodexAgentConfig, key: string): string | undefined {
  const extras = config.extra?.codex;
  if (!extras || typeof extras !== "object") {
    return undefined;
  }
  const value = (extras as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readMetadataString(handle: AgentPersistenceHandle | undefined, key: string): string | undefined {
  if (!handle?.metadata || typeof handle.metadata !== "object") {
    return undefined;
  }
  const value = (handle.metadata as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sanitizeMetadata(metadata: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(metadata).filter(([_, value]) => value !== undefined && value !== null);
  if (!entries.length) {
    return undefined;
  }
  return Object.fromEntries(entries);
}
