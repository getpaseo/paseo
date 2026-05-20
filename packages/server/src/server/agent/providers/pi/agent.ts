import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";

import {
  type AgentCapabilityFlags,
  type AgentClient,
  type AgentLaunchContext,
  type AgentMetadata,
  type AgentMode,
  type AgentModelDefinition,
  type McpServerConfig,
  type AgentPermissionRequest,
  type AgentPermissionResponse,
  type AgentPersistenceHandle,
  type AgentPromptInput,
  type AgentRunOptions,
  type AgentRunResult,
  type AgentRuntimeInfo,
  type AgentSession,
  type AgentSessionConfig,
  type AgentSlashCommand,
  type AgentStreamEvent,
  type AgentUsage,
  type ListPersistedAgentsOptions,
  type ListModesOptions,
  type ListModelsOptions,
  type PersistedAgentDescriptor,
} from "../../agent-sdk-types.js";
import { runProviderTurn } from "../provider-runner.js";
import type { ProviderRuntimeSettings } from "../../provider-launch-config.js";
import { renderPromptAttachmentAsText } from "../../prompt-attachments.js";
import { composeSystemPromptParts } from "../../system-prompt.js";
import { findExecutable } from "../../../../utils/executable.js";
import {
  formatDiagnosticStatus,
  formatProviderDiagnostic,
  formatProviderDiagnosticError,
  resolveBinaryVersion,
  toDiagnosticErrorMessage,
} from "../diagnostic-utils.js";
import { streamPiHistory } from "./history-mapper.js";
import { PiCliRuntime } from "./cli-runtime.js";
import { listPiPersistedAgents } from "./session-descriptor.js";
import type { PiRuntime, PiRuntimeSession } from "./runtime.js";
import type {
  PiAgentSessionEvent,
  PiAgentMessage,
  PiImageContent,
  PiModel,
  PiRpcSlashCommand,
  PiRuntimeEvent,
  PiSessionStats,
  PiSessionState,
  PiThinkingLevel,
} from "./rpc-types.js";
import {
  mapToolDetail,
  parseToolArgs,
  parseToolResult,
  resolveToolCallName,
  type PiToolResult,
  type PiTrackedToolCall,
} from "./tool-call-mapper.js";

const PI_PROVIDER = "pi";
const DEFAULT_PI_THINKING_LEVEL: PiThinkingLevel = "medium";
const PI_BINARY_COMMAND = process.env.PI_COMMAND ?? process.env.PI_ACP_PI_COMMAND ?? "pi";

const PI_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: false,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
};

const PI_THINKING_OPTIONS: ReadonlyArray<{
  id: PiThinkingLevel;
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

interface PiRpcAgentClientOptions {
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
  runtime?: PiRuntime;
}

interface PiPromptPayload {
  text: string;
  images?: PiImageContent[];
}

interface PiModelReference {
  provider?: string;
  id: string;
}

interface PiPersistenceMetadata {
  cwd?: string;
  model?: string;
  thinkingOptionId?: string;
  systemPrompt?: string;
}

interface StartTurnResult {
  turnId: string;
}

interface PiRpcAgentSessionOptions {
  runtimeSession: PiRuntimeSession;
  config: AgentSessionConfig;
  initialState: PiSessionState;
  capabilities: AgentCapabilityFlags;
  cleanup?: () => void;
}

interface PiResumeConfig {
  cwd: string;
  model?: string;
  thinkingOptionId?: string;
  config: AgentSessionConfig;
}

interface PiMcpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  auth?: false;
  oauth?: false;
}

interface PiMcpConfigFile {
  path: string;
  cleanup: () => void;
}

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

function isPiThinkingLevel(value: string | null | undefined): value is PiThinkingLevel {
  return (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  );
}

function normalizePiThinkingOption(value: string | null | undefined): PiThinkingLevel | null {
  if (!value) {
    return null;
  }
  return isPiThinkingLevel(value) ? value : null;
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

function toAgentUsage(stats: PiSessionStats): AgentUsage | undefined {
  const inputTokens = stats.tokens?.input ?? 0;
  const cachedInputTokens = stats.tokens?.cacheRead ?? 0;
  const outputTokens = stats.tokens?.output ?? 0;
  const totalCostUsd = stats.cost ?? 0;
  const contextWindowMaxTokens = stats.contextUsage?.contextWindow ?? undefined;
  const contextWindowUsedTokens = stats.contextUsage?.tokens ?? undefined;

  if (
    inputTokens === 0 &&
    cachedInputTokens === 0 &&
    outputTokens === 0 &&
    totalCostUsd === 0 &&
    contextWindowMaxTokens === undefined &&
    contextWindowUsedTokens === undefined
  ) {
    return undefined;
  }

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalCostUsd,
    ...(typeof contextWindowMaxTokens === "number" ? { contextWindowMaxTokens } : {}),
    ...(typeof contextWindowUsedTokens === "number" ? { contextWindowUsedTokens } : {}),
  };
}

function convertPromptInput(prompt: AgentPromptInput): PiPromptPayload {
  if (typeof prompt === "string") {
    return { text: prompt };
  }

  const textParts: string[] = [];
  const images: PiImageContent[] = [];

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

function parsePersistenceMetadata(metadata: AgentMetadata | undefined): PiPersistenceMetadata {
  if (!metadata) {
    return {};
  }
  return {
    ...(typeof metadata.cwd === "string" ? { cwd: metadata.cwd } : {}),
    ...(typeof metadata.model === "string" ? { model: metadata.model } : {}),
    ...(typeof metadata.thinkingOptionId === "string"
      ? { thinkingOptionId: metadata.thinkingOptionId }
      : {}),
    ...(typeof metadata.systemPrompt === "string" ? { systemPrompt: metadata.systemPrompt } : {}),
  };
}

function buildResumeConfig(
  metadata: PiPersistenceMetadata,
  overrides: Partial<AgentSessionConfig> | undefined,
): PiResumeConfig {
  const overrideConfig = overrides ?? {};
  const cwd = overrideConfig.cwd ?? metadata.cwd ?? process.cwd();
  const model = overrideConfig.model ?? metadata.model;
  const thinkingOptionId = overrideConfig.thinkingOptionId ?? metadata.thinkingOptionId;
  return {
    cwd,
    model,
    thinkingOptionId,
    config: {
      ...overrideConfig,
      provider: PI_PROVIDER,
      cwd,
      model,
      thinkingOptionId,
      systemPrompt: overrideConfig.systemPrompt ?? metadata.systemPrompt,
    },
  };
}

function toPiMcpConfig(config: McpServerConfig): PiMcpServerConfig {
  if (config.type === "stdio") {
    return {
      command: config.command,
      ...(config.args ? { args: config.args } : {}),
      ...(config.env ? { env: config.env } : {}),
    };
  }

  return {
    url: config.url,
    ...(config.headers ? { headers: config.headers } : {}),
    auth: false,
    oauth: false,
  };
}

function createPiMcpConfigFile(servers: Record<string, McpServerConfig>): PiMcpConfigFile {
  const dir = mkdtempSync(join(tmpdir(), "paseo-pi-mcp-"));
  const filePath = join(dir, "mcp.json");
  const mcpServers: Record<string, PiMcpServerConfig> = {};
  for (const [name, serverConfig] of Object.entries(servers)) {
    mcpServers[name] = toPiMcpConfig(serverConfig);
  }
  writeFileSync(filePath, `${JSON.stringify({ mcpServers }, null, 2)}\n`, "utf8");
  return {
    path: filePath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function isPiMcpAdapterCommand(command: PiRpcSlashCommand): boolean {
  if (command.source !== "extension" || !/^mcp(?::\d+)?$/.test(command.name)) {
    return false;
  }
  if (!command.sourceInfo) {
    return true;
  }
  return JSON.stringify(command.sourceInfo).includes("pi-mcp-adapter");
}

function withPiMcpCapability(supportsMcpServers: boolean): AgentCapabilityFlags {
  return {
    ...PI_CAPABILITIES,
    supportsMcpServers,
  };
}

function isPiRequestAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") {
    return true;
  }

  return /\brequest was aborted\b|\babort(ed)?\b/i.test(toDiagnosticErrorMessage(error));
}

function resolveThinkingOptionId(
  cachedThinkingOptionId: string | null,
  sessionThinkingLevel: PiThinkingLevel,
): PiThinkingLevel | null {
  const currentThinking = cachedThinkingOptionId ?? sessionThinkingLevel;
  return normalizePiThinkingOption(currentThinking);
}

function modelToId(model: PiModel | null | undefined): string | null {
  return model?.provider && model.id ? `${model.provider}/${model.id}` : null;
}

function latestPiErrorMessage(messages: PiAgentMessage[]): string | null {
  const latestAssistant = messages.findLast((message) => message.role === "assistant");
  return latestAssistant && "errorMessage" in latestAssistant
    ? (latestAssistant.errorMessage ?? null)
    : null;
}

function mapPiModel(model: PiModel): AgentModelDefinition {
  return {
    provider: PI_PROVIDER,
    id: `${model.provider}/${model.id}`,
    label: `${model.provider}/${model.name ?? model.id}`,
    description: `${model.provider}/${model.id}`,
    metadata: {
      provider: model.provider,
      modelId: model.id,
    },
    thinkingOptions: model.reasoning ? PI_THINKING_OPTIONS.map(mapThinkingOption) : undefined,
    defaultThinkingOptionId: model.reasoning ? DEFAULT_PI_THINKING_LEVEL : undefined,
  };
}

function createRuntime(logger: Logger, runtimeSettings?: ProviderRuntimeSettings): PiRuntime {
  return new PiCliRuntime({ logger, runtimeSettings });
}

export class PiRpcAgentSession implements AgentSession {
  readonly provider = PI_PROVIDER;
  readonly capabilities: AgentCapabilityFlags;

  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private readonly activeToolCalls = new Map<string, PiTrackedToolCall>();
  private activeTurnId: string | null = null;
  private lastKnownThinkingOptionId: string | null;
  private state: PiSessionState;
  private closed = false;

  constructor(options: PiRpcAgentSessionOptions) {
    this.runtimeSession = options.runtimeSession;
    this.config = options.config;
    this.state = options.initialState;
    this.capabilities = options.capabilities;
    this.cleanup = options.cleanup;
    this.lastKnownThinkingOptionId =
      normalizePiThinkingOption(options.config.thinkingOptionId) ??
      this.state.thinkingLevel ??
      null;

    this.runtimeSession.onEvent((event) => {
      this.handleRuntimeEvent(event);
    });
  }

  private readonly runtimeSession: PiRuntimeSession;
  private readonly config: AgentSessionConfig;
  private readonly cleanup?: () => void;

  get id(): string | null {
    return this.state.sessionId;
  }

  async run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    return runProviderTurn({
      prompt,
      runOptions: options,
      startTurn: (p, o) => this.startTurn(p, o),
      subscribe: (callback) => this.subscribe(callback),
      getSessionId: () => this.state.sessionId,
      reduceFinalText: ({ current, item }) =>
        item.type === "assistant_message" ? `${current}${item.text}` : current,
    });
  }

  async startTurn(prompt: AgentPromptInput, _options?: AgentRunOptions): Promise<StartTurnResult> {
    if (this.activeTurnId) {
      throw new Error("A Pi turn is already active");
    }

    const payload = convertPromptInput(prompt);
    const turnId = randomUUID();
    this.activeTurnId = turnId;

    void this.runtimeSession.prompt(payload.text, payload.images).catch((error) => {
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
    yield* streamPiHistory(PI_PROVIDER, await this.runtimeSession.getMessages());
  }

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    await this.refreshState();
    return {
      provider: PI_PROVIDER,
      sessionId: this.state.sessionId,
      model: modelToId(this.state.model),
      thinkingOptionId: resolveThinkingOptionId(
        this.lastKnownThinkingOptionId,
        this.state.thinkingLevel,
      ),
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
      sessionId: this.state.sessionId,
      nativeHandle: this.state.sessionFile,
      metadata: {
        cwd: this.config.cwd,
        ...(this.config.model ? { model: this.config.model } : {}),
        ...(this.config.thinkingOptionId ? { thinkingOptionId: this.config.thinkingOptionId } : {}),
      },
    };
  }

  async interrupt(): Promise<void> {
    await this.runtimeSession.abort();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      await this.runtimeSession.close();
    } finally {
      this.cleanup?.();
    }
  }

  async listCommands(): Promise<AgentSlashCommand[]> {
    const commands = await this.runtimeSession.getCommands();
    return commands.map((command) => ({
      name: command.name,
      description: command.description ?? command.source,
      argumentHint: "",
    }));
  }

  async setModel(modelId: string | null): Promise<void> {
    const parsedReference = parseModelReference(modelId);
    if (!parsedReference) {
      return;
    }
    if (!parsedReference.provider) {
      throw new Error(`Pi model id must include a provider: ${modelId}`);
    }

    const model = await this.runtimeSession.setModel(parsedReference.provider, parsedReference.id);
    this.state = {
      ...this.state,
      model,
    };
    this.config.model = `${model.provider}/${model.id}`;
  }

  async setThinkingOption(thinkingOptionId: string | null): Promise<void> {
    const thinkingLevel = normalizePiThinkingOption(thinkingOptionId) ?? DEFAULT_PI_THINKING_LEVEL;
    await this.runtimeSession.setThinkingLevel(thinkingLevel);
    this.lastKnownThinkingOptionId = thinkingLevel;
    this.config.thinkingOptionId = thinkingLevel;
    this.state = {
      ...this.state,
      thinkingLevel,
    };
  }

  private emit(event: AgentStreamEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }

  private currentTurnIdForEvent(): string | undefined {
    return this.activeTurnId ?? undefined;
  }

  private handleRuntimeEvent(event: PiRuntimeEvent): void {
    if (event.type === "extension_ui_request") {
      this.runtimeSession.cancelExtensionUiRequest(event.id);
      return;
    }
    if (event.type === "process_exit") {
      this.handleProcessExit(event.error);
      return;
    }
    this.handleSessionEvent(event);
  }

  private handleProcessExit(error: string): void {
    if (!this.activeTurnId) {
      return;
    }
    const turnId = this.activeTurnId;
    this.activeTurnId = null;
    this.emit({
      type: "turn_failed",
      provider: PI_PROVIDER,
      turnId,
      error,
    });
  }

  private handleSessionEvent(event: PiAgentSessionEvent): void {
    const turnId = this.currentTurnIdForEvent();

    switch (event.type) {
      case "agent_start":
        this.emit({
          type: "thread_started",
          provider: PI_PROVIDER,
          sessionId: this.state.sessionId,
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
      case "agent_end":
        this.completeTurn(turnId, event.messages ?? []);
        return;
      default:
        return;
    }
  }

  private handleMessageUpdate(
    event: Extract<PiAgentSessionEvent, { type: "message_update" }>,
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
      name: resolveToolCallName(toolCall, result),
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

  private completeTurn(turnId: string | undefined, messages: PiAgentMessage[]): void {
    this.activeTurnId = null;
    const errorMessage = latestPiErrorMessage(messages);
    if (typeof errorMessage === "string" && errorMessage.length > 0) {
      this.emit({
        type: "turn_failed",
        provider: PI_PROVIDER,
        turnId,
        error: errorMessage,
      });
      return;
    }
    this.emit({
      type: "turn_completed",
      provider: PI_PROVIDER,
      turnId,
    });
    void this.refreshAfterTurn(turnId);
  }

  private async refreshState(): Promise<void> {
    this.state = await this.runtimeSession.getState();
  }

  private async refreshAfterTurn(turnId: string | undefined): Promise<void> {
    await this.refreshState().catch(() => undefined);
    const usage = await this.runtimeSession
      .getSessionStats()
      .then(toAgentUsage)
      .catch(() => undefined);
    if (usage) {
      this.emit({
        type: "usage_updated",
        provider: PI_PROVIDER,
        turnId,
        usage,
      });
    }
  }
}

export class PiRpcAgentClient implements AgentClient {
  readonly provider = PI_PROVIDER;
  readonly capabilities = PI_CAPABILITIES;

  private readonly logger: Logger;
  private readonly runtimeSettings?: ProviderRuntimeSettings;
  private readonly runtime: PiRuntime;

  constructor(options: PiRpcAgentClientOptions) {
    this.logger = options.logger;
    this.runtimeSettings = options.runtimeSettings;
    this.runtime = options.runtime ?? createRuntime(options.logger, options.runtimeSettings);
  }

  async createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const mcpConfig = await this.prepareMcpConfig(config.cwd, config.mcpServers);
    let runtimeSession: PiRuntimeSession;
    try {
      runtimeSession = await this.runtime.startSession({
        cwd: config.cwd,
        model: config.model,
        thinkingOptionId:
          normalizePiThinkingOption(config.thinkingOptionId) ?? DEFAULT_PI_THINKING_LEVEL,
        systemPrompt: composeSystemPromptParts(
          config.systemPrompt,
          config.daemonAppendSystemPrompt,
        ),
        env: launchContext?.env,
        mcpConfigPath: mcpConfig?.path,
      });
    } catch (error) {
      mcpConfig?.cleanup();
      throw error;
    }
    try {
      return new PiRpcAgentSession({
        runtimeSession,
        config,
        initialState: await runtimeSession.getState(),
        capabilities: withPiMcpCapability(mcpConfig !== null),
        cleanup: mcpConfig?.cleanup,
      });
    } catch (error) {
      await runtimeSession.close().catch(() => undefined);
      mcpConfig?.cleanup();
      throw error;
    }
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

    const persistenceMetadata = parsePersistenceMetadata(handle.metadata);
    const resumeConfig = buildResumeConfig(persistenceMetadata, overrides);

    const mcpConfig = await this.prepareMcpConfig(resumeConfig.cwd, resumeConfig.config.mcpServers);
    let runtimeSession: PiRuntimeSession;
    try {
      runtimeSession = await this.runtime.startSession({
        cwd: resumeConfig.cwd,
        session: sessionFile,
        model: resumeConfig.model,
        thinkingOptionId: normalizePiThinkingOption(resumeConfig.thinkingOptionId) ?? undefined,
        systemPrompt: composeSystemPromptParts(
          resumeConfig.config.systemPrompt,
          resumeConfig.config.daemonAppendSystemPrompt,
        ),
        mcpConfigPath: mcpConfig?.path,
      });
    } catch (error) {
      mcpConfig?.cleanup();
      throw error;
    }
    try {
      return new PiRpcAgentSession({
        runtimeSession,
        config: resumeConfig.config,
        initialState: await runtimeSession.getState(),
        capabilities: withPiMcpCapability(mcpConfig !== null),
        cleanup: mcpConfig?.cleanup,
      });
    } catch (error) {
      await runtimeSession.close().catch(() => undefined);
      mcpConfig?.cleanup();
      throw error;
    }
  }

  async listModels(options: ListModelsOptions): Promise<AgentModelDefinition[]> {
    const runtimeSession = await this.runtime.startSession({ cwd: options.cwd });
    try {
      return transformPiModels((await runtimeSession.getAvailableModels()).map(mapPiModel));
    } finally {
      await runtimeSession.close();
    }
  }

  async listModes(_options: ListModesOptions): Promise<AgentMode[]> {
    return [];
  }

  async listPersistedAgents(
    options?: ListPersistedAgentsOptions,
  ): Promise<PersistedAgentDescriptor[]> {
    return await listPiPersistedAgents({
      ...options,
      runtimeSettings: this.runtimeSettings,
    });
  }

  async isAvailable(): Promise<boolean> {
    const binary = await this.resolvePiBinary();
    if (!binary) {
      return false;
    }
    const runtimeSession = await this.runtime.startSession({ cwd: homedir() }).catch(() => null);
    if (!runtimeSession) {
      return false;
    }
    try {
      return (await runtimeSession.getAvailableModels()).length > 0;
    } catch {
      return false;
    } finally {
      await runtimeSession.close().catch(() => undefined);
    }
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    try {
      const available = await this.isAvailable();
      const binary = await this.resolvePiBinary();
      const version = binary ? await resolveBinaryVersion(binary) : "unknown";
      const authConfigPath = join(homedir(), ".pi", "agent", "auth.json");
      let modelsValue = "Not checked";
      let configuredProvidersValue = "none";
      let mcpToolsValue = "Not checked";
      let status = formatDiagnosticStatus(available);

      if (binary) {
        const runtimeSession = await this.runtime
          .startSession({ cwd: homedir() })
          .catch((error) => {
            status = formatDiagnosticStatus(false, {
              source: "startup",
              cause: error,
            });
            return null;
          });
        if (runtimeSession) {
          try {
            const models = await runtimeSession.getAvailableModels();
            modelsValue = String(models.length);
            const configuredProviders = Array.from(
              new Set(models.map((model) => model.provider)),
            ).sort();
            configuredProvidersValue =
              configuredProviders.length > 0 ? configuredProviders.join(", ") : "none";
            const commands = await runtimeSession.getCommands();
            mcpToolsValue = commands.some(isPiMcpAdapterCommand)
              ? "yes (pi-mcp-adapter loaded)"
              : "no (install pi-mcp-adapter)";
          } catch (error) {
            modelsValue = `Error - ${toDiagnosticErrorMessage(error)}`;
            mcpToolsValue = `Error - ${toDiagnosticErrorMessage(error)}`;
            status = formatDiagnosticStatus(available, {
              source: "model fetch",
              cause: error,
            });
          } finally {
            await runtimeSession.close().catch(() => undefined);
          }
        }
      }

      return {
        diagnostic: formatProviderDiagnostic("Pi", [
          { label: "Binary", value: binary ?? "not found" },
          { label: "Version", value: version },
          { label: "Configured providers", value: configuredProvidersValue },
          {
            label: "Auth config (~/.pi/agent/auth.json)",
            value: existsSync(authConfigPath) ? "found" : "not found",
          },
          { label: "Models", value: modelsValue },
          { label: "Paseo MCP tools", value: mcpToolsValue },
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

  private async prepareMcpConfig(
    cwd: string,
    servers: Record<string, McpServerConfig> | undefined,
  ): Promise<PiMcpConfigFile | null> {
    if (!servers || Object.keys(servers).length === 0) {
      return null;
    }
    if (!(await this.detectMcpAdapter(cwd))) {
      return null;
    }
    return createPiMcpConfigFile(servers);
  }

  private async detectMcpAdapter(cwd: string): Promise<boolean> {
    const runtimeSession = await this.runtime.startSession({ cwd }).catch((error) => {
      this.logger.debug({ err: error, cwd }, "Pi MCP adapter probe failed to start");
      return null;
    });
    if (!runtimeSession) {
      return false;
    }
    try {
      return (await runtimeSession.getCommands()).some(isPiMcpAdapterCommand);
    } catch (error) {
      this.logger.debug({ err: error, cwd }, "Pi MCP adapter probe failed");
      return false;
    } finally {
      await runtimeSession.close().catch(() => undefined);
    }
  }

  private async resolvePiBinary(): Promise<string | null> {
    const command = this.runtimeSettings?.command;
    if (command?.mode === "replace" && command.argv[0]) {
      return await findExecutable(command.argv[0]);
    }
    return await findExecutable(PI_BINARY_COMMAND);
  }
}
