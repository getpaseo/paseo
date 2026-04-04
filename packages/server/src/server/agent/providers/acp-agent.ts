import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type AgentCapabilities as ACPAgentCapabilities,
  type Client as ACPClient,
  type ClientCapabilities as ACPClientCapabilities,
  type ConfigOptionUpdate,
  type ContentBlock,
  type CreateTerminalRequest,
  type CurrentModeUpdate,
  type EnvVariable,
  type InitializeResponse,
  type KillTerminalRequest,
  type ListSessionsResponse,
  type LoadSessionResponse,
  type McpServer,
  type NewSessionResponse,
  type PermissionOption,
  type Plan,
  type PromptResponse,
  type ReadTextFileRequest,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ResumeSessionResponse,
  type SessionConfigOption,
  type SessionInfoUpdate,
  type SessionMode,
  type SessionModelState,
  type SessionNotification,
  type SessionUpdate,
  type TerminalOutputRequest,
  type TerminalOutputResponse,
  type ToolCall,
  type ToolCallContent,
  type ToolCallLocation,
  type ToolCallStatus,
  type ToolCallUpdate,
  type ToolKind,
  type Usage,
  type UsageUpdate,
  type WaitForTerminalExitRequest,
  type WriteTextFileRequest,
} from "@agentclientprotocol/sdk";
import type { Logger } from "pino";

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
  AgentPersistenceHandle,
  AgentPromptContentBlock,
  AgentPromptInput,
  AgentRunOptions,
  AgentRunResult,
  AgentRuntimeInfo,
  AgentSession,
  AgentSessionConfig,
  AgentSlashCommand,
  AgentStreamEvent,
  AgentTimelineItem,
  AgentUsage,
  ListModesOptions,
  ListModelsOptions,
  ListPersistedAgentsOptions,
  McpServerConfig,
  PersistedAgentDescriptor,
  ToolCallDetail,
  ToolCallTimelineItem,
} from "../agent-sdk-types.js";
import {
  applyProviderEnv,
  resolveProviderCommandPrefix,
  type ProviderRuntimeSettings,
} from "../provider-launch-config.js";
import { findExecutable } from "../../../utils/executable.js";

const DEFAULT_ACP_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
};

const ACP_CLIENT_CAPABILITIES: ACPClientCapabilities = {
  fs: {
    readTextFile: true,
    writeTextFile: true,
  },
  terminal: true,
};

type ACPAgentClientOptions = {
  provider: string;
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
  defaultCommand: [string, ...string[]];
  defaultModes?: AgentMode[];
  modelTransformer?: (models: AgentModelDefinition[]) => AgentModelDefinition[];
  sessionResponseTransformer?: (response: SessionStateResponse) => SessionStateResponse;
  toolSnapshotTransformer?: (snapshot: ACPToolSnapshot) => ACPToolSnapshot;
  thinkingOptionWriter?: (
    connection: ClientSideConnection,
    sessionId: string,
    thinkingOptionId: string,
  ) => Promise<void>;
  capabilities?: AgentCapabilityFlags;
};

type ACPAgentSessionOptions = {
  provider: string;
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
  defaultCommand: [string, ...string[]];
  defaultModes: AgentMode[];
  modelTransformer?: (models: AgentModelDefinition[]) => AgentModelDefinition[];
  sessionResponseTransformer?: (response: SessionStateResponse) => SessionStateResponse;
  toolSnapshotTransformer?: (snapshot: ACPToolSnapshot) => ACPToolSnapshot;
  thinkingOptionWriter?: (
    connection: ClientSideConnection,
    sessionId: string,
    thinkingOptionId: string,
  ) => Promise<void>;
  capabilities: AgentCapabilityFlags;
  handle?: AgentPersistenceHandle;
  launchEnv?: Record<string, string>;
};

type SpawnedACPProcess = {
  child: ChildProcessWithoutNullStreams;
  connection: ClientSideConnection;
  initialize: InitializeResponse;
};

export type ACPToolSnapshot = {
  toolCallId: string;
  title: string;
  kind?: ToolKind | null;
  status?: ToolCallStatus | null;
  content?: ToolCallContent[] | null;
  locations?: ToolCallLocation[] | null;
  rawInput?: unknown;
  rawOutput?: unknown;
};

type PendingPermission = {
  request: AgentPermissionRequest;
  options: PermissionOption[];
  resolve: (response: RequestPermissionResponse) => void;
  reject: (error: Error) => void;
  turnId: string | null;
};

type MessageAssemblyState = {
  text: string;
};

export type SessionStateResponse = NewSessionResponse | LoadSessionResponse | ResumeSessionResponse;

type TerminalExit = {
  exitCode?: number | null;
  signal?: string | null;
};

type TerminalEntry = {
  id: string;
  child: ChildProcess;
  output: string;
  truncated: boolean;
  outputByteLimit: number | null;
  exit: TerminalExit | null;
  waitForExit: Promise<TerminalExit>;
  resolveExit: (exit: TerminalExit) => void;
  rejectExit: (error: Error) => void;
};

type ConfigOptionSelector = {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
  metadata?: AgentMetadata;
};

export function mapACPUsage(usage: Usage | null | undefined): AgentUsage | undefined {
  if (!usage) {
    return undefined;
  }

  return {
    inputTokens: usage.inputTokens ?? undefined,
    outputTokens: usage.outputTokens ?? undefined,
    cachedInputTokens: usage.cachedReadTokens ?? undefined,
  };
}

export function deriveModesFromACP(
  fallbackModes: AgentMode[],
  modeState?: { availableModes?: SessionMode[] | null; currentModeId?: string | null } | null,
  configOptions?: SessionConfigOption[] | null,
): { modes: AgentMode[]; currentModeId: string | null } {
  if (modeState?.availableModes?.length) {
    return {
      modes: modeState.availableModes.map((mode) => ({
        id: mode.id,
        label: mode.name,
        description: mode.description ?? undefined,
      })),
      currentModeId: modeState.currentModeId ?? null,
    };
  }

  const modeOption = configOptions?.find(
    (option) => option.type === "select" && option.category === "mode",
  );
  if (modeOption?.type === "select") {
    const flatOptions = flattenSelectOptions(modeOption.options);
    return {
      modes: flatOptions.map((option) => ({
        id: option.value,
        label: option.name,
        description: option.description ?? undefined,
      })),
      currentModeId: modeOption.currentValue,
    };
  }

  return {
    modes: fallbackModes,
    currentModeId: null,
  };
}

export function deriveModelDefinitionsFromACP(
  provider: string,
  models: SessionModelState | null | undefined,
  configOptions?: SessionConfigOption[] | null,
): AgentModelDefinition[] {
  const thinkingOptions = deriveSelectorOptions(configOptions, "thought_level");
  const defaultThinkingOptionId = thinkingOptions.find((option) => option.isDefault)?.id ?? null;

  if (models?.availableModels?.length) {
    return models.availableModels.map((model) => ({
      provider,
      id: model.modelId,
      label: model.name,
      description: model.description ?? undefined,
      isDefault: model.modelId === models.currentModelId,
      thinkingOptions: thinkingOptions.length > 0 ? thinkingOptions : undefined,
      defaultThinkingOptionId: defaultThinkingOptionId ?? undefined,
    }));
  }

  const modelOptions = deriveSelectorOptions(configOptions, "model");
  return modelOptions.map((option) => ({
    provider,
    id: option.id,
    label: option.label,
    description: option.description,
    isDefault: option.isDefault,
    thinkingOptions: thinkingOptions.length > 0 ? thinkingOptions : undefined,
    defaultThinkingOptionId: defaultThinkingOptionId ?? undefined,
    metadata: option.metadata,
  }));
}

export class ACPAgentClient implements AgentClient {
  readonly provider: string;
  readonly capabilities: AgentCapabilityFlags;

  protected readonly logger: Logger;
  protected readonly runtimeSettings?: ProviderRuntimeSettings;
  protected readonly defaultCommand: [string, ...string[]];
  protected readonly defaultModes: AgentMode[];
  private readonly modelTransformer?: (models: AgentModelDefinition[]) => AgentModelDefinition[];
  private readonly sessionResponseTransformer?: (
    response: SessionStateResponse,
  ) => SessionStateResponse;
  private readonly toolSnapshotTransformer?: (snapshot: ACPToolSnapshot) => ACPToolSnapshot;
  private readonly thinkingOptionWriter?: (
    connection: ClientSideConnection,
    sessionId: string,
    thinkingOptionId: string,
  ) => Promise<void>;

  constructor(options: ACPAgentClientOptions) {
    this.provider = options.provider;
    this.capabilities = options.capabilities ?? DEFAULT_ACP_CAPABILITIES;
    this.logger = options.logger.child({ module: "agent", provider: options.provider });
    this.runtimeSettings = options.runtimeSettings;
    this.defaultCommand = options.defaultCommand;
    this.defaultModes = options.defaultModes ?? [];
    this.modelTransformer = options.modelTransformer;
    this.sessionResponseTransformer = options.sessionResponseTransformer;
    this.toolSnapshotTransformer = options.toolSnapshotTransformer;
    this.thinkingOptionWriter = options.thinkingOptionWriter;
  }

  async createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    this.assertProvider(config);
    const session = new ACPAgentSession(
      { ...config, provider: this.provider },
      {
        provider: this.provider,
        logger: this.logger,
        runtimeSettings: this.runtimeSettings,
        defaultCommand: this.defaultCommand,
        defaultModes: this.defaultModes,
        modelTransformer: this.modelTransformer,
        sessionResponseTransformer: this.sessionResponseTransformer,
        toolSnapshotTransformer: this.toolSnapshotTransformer,
        thinkingOptionWriter: this.thinkingOptionWriter,
        capabilities: this.capabilities,
        launchEnv: launchContext?.env,
      },
    );
    await session.initializeNewSession();
    return session;
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    if (handle.provider !== this.provider) {
      throw new Error(`Cannot resume ${handle.provider} handle with ${this.provider} provider`);
    }

    const storedConfig = coerceSessionConfigMetadata(handle.metadata);
    const cwd = overrides?.cwd ?? storedConfig.cwd;
    if (!cwd) {
      throw new Error(`${this.provider} resume requires the original working directory`);
    }

    const mergedConfig: AgentSessionConfig = {
      ...storedConfig,
      ...overrides,
      provider: this.provider,
      cwd,
    };
    const session = new ACPAgentSession(mergedConfig, {
      provider: this.provider,
      logger: this.logger,
      runtimeSettings: this.runtimeSettings,
      defaultCommand: this.defaultCommand,
      defaultModes: this.defaultModes,
      modelTransformer: this.modelTransformer,
      sessionResponseTransformer: this.sessionResponseTransformer,
      toolSnapshotTransformer: this.toolSnapshotTransformer,
      thinkingOptionWriter: this.thinkingOptionWriter,
      capabilities: this.capabilities,
      handle,
      launchEnv: launchContext?.env,
    });
    await session.initializeResumedSession();
    return session;
  }

  async listModels(options?: ListModelsOptions): Promise<AgentModelDefinition[]> {
    const cwd = options?.cwd ?? process.cwd();
    const probe = await this.spawnProcess(undefined);
    try {
      const response = await probe.connection.newSession({
        cwd,
        mcpServers: [],
      });
      const transformed = this.transformSessionResponse(response);
      const models = deriveModelDefinitionsFromACP(
        this.provider,
        transformed.models,
        transformed.configOptions,
      );
      return this.modelTransformer ? this.modelTransformer(models) : models;
    } finally {
      await this.closeProbe(probe);
    }
  }

  async listModes(options?: ListModesOptions): Promise<AgentMode[]> {
    const cwd = options?.cwd ?? process.cwd();
    const probe = await this.spawnProcess(undefined);
    try {
      const response = await probe.connection.newSession({
        cwd,
        mcpServers: [],
      });
      const transformed = this.transformSessionResponse(response);
      const modeInfo = deriveModesFromACP(
        this.defaultModes,
        transformed.modes,
        transformed.configOptions,
      );
      return modeInfo.modes;
    } finally {
      await this.closeProbe(probe);
    }
  }

  async listPersistedAgents(
    options?: ListPersistedAgentsOptions,
  ): Promise<PersistedAgentDescriptor[]> {
    const probe = await this.spawnProcess(undefined);
    try {
      if (!probe.initialize.agentCapabilities?.sessionCapabilities?.list) {
        return [];
      }

      const sessions: PersistedAgentDescriptor[] = [];
      let cursor: string | null | undefined;
      do {
        const page: ListSessionsResponse = await probe.connection.listSessions({
          ...(cursor ? { cursor } : {}),
        });
        for (const session of page.sessions) {
          sessions.push({
            provider: this.provider,
            sessionId: session.sessionId,
            cwd: session.cwd,
            title: session.title ?? null,
            lastActivityAt: session.updatedAt ? new Date(session.updatedAt) : new Date(0),
            persistence: {
              provider: this.provider,
              sessionId: session.sessionId,
              nativeHandle: session.sessionId,
              metadata: {
                provider: this.provider,
                cwd: session.cwd,
                title: session.title ?? null,
              },
            },
            timeline: [],
          });
        }
        cursor = page.nextCursor ?? null;
      } while (cursor && (!options?.limit || sessions.length < options.limit));

      return typeof options?.limit === "number" ? sessions.slice(0, options.limit) : sessions;
    } finally {
      await this.closeProbe(probe);
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      this.resolveLaunchCommand();
      return true;
    } catch {
      return false;
    }
  }

  protected async spawnProcess(
    launchEnv?: Record<string, string>,
  ): Promise<SpawnedACPProcess> {
    const { command, args } = this.resolveLaunchCommand();
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: {
        ...applyProviderEnv(process.env as Record<string, string | undefined>, this.runtimeSettings),
        ...(launchEnv ?? {}),
      },
      shell: process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stderrChunks: string[] = [];
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(chunk.toString());
    });

    const spawnErrorPromise = new Promise<never>((_, reject) => {
      child.once("error", (error) => {
        const stderr = stderrChunks.join("").trim();
        reject(new Error(stderr ? `${String(error)}\n${stderr}` : String(error)));
      });
    });

    if (!child.stdin || !child.stdout) {
      throw new Error(`${this.provider} ACP process did not expose stdio pipes`);
    }

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    const connection = new ClientSideConnection(() => this.buildProbeClient(), stream);
    const initialize = (await Promise.race([
      connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: ACP_CLIENT_CAPABILITIES,
        clientInfo: { name: "Paseo", version: "dev" },
      }),
      spawnErrorPromise,
    ])) as InitializeResponse;

    return { child, connection, initialize };
  }

  protected buildProbeClient(): ACPClient {
    return {
      async requestPermission(): Promise<RequestPermissionResponse> {
        return { outcome: { outcome: "cancelled" } };
      },
      async sessionUpdate(): Promise<void> {},
      async readTextFile(params: ReadTextFileRequest) {
        const content = await fs.readFile(params.path, "utf8");
        return { content };
      },
      async writeTextFile(params: WriteTextFileRequest) {
        await fs.mkdir(path.dirname(params.path), { recursive: true });
        await fs.writeFile(params.path, params.content, "utf8");
        return {};
      },
      async createTerminal() {
        throw new Error("ACP model probe does not support terminal execution");
      },
    };
  }

  protected async closeProbe(probe: SpawnedACPProcess): Promise<void> {
    try {
      if (probe.initialize.agentCapabilities?.sessionCapabilities?.close) {
        // No active session to close here; ignore capability.
      }
    } finally {
      probe.child.kill("SIGTERM");
      await waitForChildExit(probe.child, 2_000);
    }
  }

  protected resolveLaunchCommand(): { command: string; args: string[] } {
    const prefix = resolveProviderCommandPrefix(this.runtimeSettings?.command, () => {
      const resolved = findExecutable(this.defaultCommand[0]);
      if (!resolved) {
        throw new Error(`${this.provider} command '${this.defaultCommand[0]}' not found`);
      }
      return resolved;
    });
    return {
      command: prefix.command,
      args: [...prefix.args, ...this.defaultCommand.slice(1)],
    };
  }

  private assertProvider(config: AgentSessionConfig): void {
    if (config.provider !== this.provider) {
      throw new Error(`Expected ${this.provider} config, received ${config.provider}`);
    }
  }

  protected transformSessionResponse(response: SessionStateResponse): SessionStateResponse {
    return this.sessionResponseTransformer ? this.sessionResponseTransformer(response) : response;
  }
}

export class ACPAgentSession implements AgentSession, ACPClient {
  readonly provider: string;
  readonly capabilities: AgentCapabilityFlags;

  private readonly logger: Logger;
  private readonly runtimeSettings?: ProviderRuntimeSettings;
  private readonly defaultCommand: [string, ...string[]];
  private readonly defaultModes: AgentMode[];
  protected readonly modelTransformer?: (models: AgentModelDefinition[]) => AgentModelDefinition[];
  private readonly sessionResponseTransformer?: (
    response: SessionStateResponse,
  ) => SessionStateResponse;
  private readonly toolSnapshotTransformer?: (snapshot: ACPToolSnapshot) => ACPToolSnapshot;
  private readonly thinkingOptionWriter?: (
    connection: ClientSideConnection,
    sessionId: string,
    thinkingOptionId: string,
  ) => Promise<void>;
  private readonly launchEnv?: Record<string, string>;
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly messageAssemblies = new Map<string, MessageAssemblyState>();
  private readonly toolCalls = new Map<string, ACPToolSnapshot>();
  private readonly terminalEntries = new Map<string, TerminalEntry>();
  private readonly persistedHistory: AgentTimelineItem[] = [];
  private readonly initialHandle?: AgentPersistenceHandle;

  private readonly config: AgentSessionConfig;
  private child: ChildProcessWithoutNullStreams | null = null;
  private connection: ClientSideConnection | null = null;
  private agentCapabilities: ACPAgentCapabilities | null = null;
  private sessionId: string | null = null;
  private currentMode: string | null = null;
  private availableModes: AgentMode[];
  private availableModels: AgentModelDefinition[] = [];
  private currentModel: string | null = null;
  private thinkingOptionId: string | null = null;
  private currentTitle: string | null = null;
  private lastActivityAt: string | null = null;
  private configOptions: SessionConfigOption[] = [];
  private cachedCommands: AgentSlashCommand[] = [];
  private currentTurnUsage: AgentUsage | undefined;
  private activeForegroundTurnId: string | null = null;
  private closed = false;
  private historyPending = false;
  private replayingHistory = false;
  private suppressUserEchoMessageId: string | null = null;
  private suppressUserEchoText: string | null = null;
  private bootstrapThreadEventPending = false;

  constructor(config: AgentSessionConfig, options: ACPAgentSessionOptions) {
    this.provider = options.provider;
    this.capabilities = options.capabilities;
    this.logger = options.logger.child({ module: "agent", provider: options.provider });
    this.runtimeSettings = options.runtimeSettings;
    this.defaultCommand = options.defaultCommand;
    this.defaultModes = options.defaultModes;
    this.modelTransformer = options.modelTransformer;
    this.sessionResponseTransformer = options.sessionResponseTransformer;
    this.toolSnapshotTransformer = options.toolSnapshotTransformer;
    this.thinkingOptionWriter = options.thinkingOptionWriter;
    this.availableModes = options.defaultModes;
    this.launchEnv = options.launchEnv;
    this.initialHandle = options.handle;
    this.config = { ...config, provider: options.provider };
    this.currentMode = config.modeId ?? null;
    this.currentModel = config.model ?? null;
    this.thinkingOptionId = config.thinkingOptionId ?? null;
    this.currentTitle = config.title ?? null;
  }

  get id(): string | null {
    return this.sessionId;
  }

  async initializeNewSession(): Promise<void> {
    const spawned = await this.spawnProcess();
    this.child = spawned.child;
    this.connection = spawned.connection;
    this.agentCapabilities = spawned.initialize.agentCapabilities ?? null;

    const response = await this.connection.newSession({
      cwd: this.config.cwd,
      mcpServers: normalizeMcpServers(this.config.mcpServers),
    });
    this.sessionId = response.sessionId;
    this.bootstrapThreadEventPending = true;
    this.applySessionState(response);
    await this.applyConfiguredOverrides();
  }

  async initializeResumedSession(): Promise<void> {
    const handle = this.initialHandle;
    if (!handle) {
      throw new Error("Resume requested without persistence handle");
    }

    const spawned = await this.spawnProcess();
    this.child = spawned.child;
    this.connection = spawned.connection;
    this.agentCapabilities = spawned.initialize.agentCapabilities ?? null;
    this.sessionId = handle.sessionId;
    this.bootstrapThreadEventPending = true;

    const sessionCapabilities = this.agentCapabilities?.sessionCapabilities;
    if (this.agentCapabilities?.loadSession) {
      this.replayingHistory = true;
      const response = await this.connection.loadSession({
        sessionId: handle.sessionId,
        cwd: this.config.cwd,
        mcpServers: normalizeMcpServers(this.config.mcpServers),
      });
      this.replayingHistory = false;
      this.historyPending = this.persistedHistory.length > 0;
      this.applySessionState(response);
    } else if (sessionCapabilities?.resume) {
      const response = await this.connection.unstable_resumeSession({
        sessionId: handle.sessionId,
        cwd: this.config.cwd,
        mcpServers: normalizeMcpServers(this.config.mcpServers),
      });
      this.applySessionState(response);
    } else {
      throw new Error(`${this.provider} does not support ACP session resume`);
    }

    await this.applyConfiguredOverrides();
  }

  async run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    const timeline: AgentTimelineItem[] = [];
    let finalText = "";
    let usage: AgentUsage | undefined;
    let turnId: string | null = null;
    let settled = false;
    let resolveCompletion!: () => void;
    let rejectCompletion!: (error: Error) => void;
    const buffered: AgentStreamEvent[] = [];

    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });

    const processEvent = (event: AgentStreamEvent) => {
      if (settled) {
        return;
      }
      if (turnId && "turnId" in event && event.turnId && event.turnId !== turnId) {
        return;
      }
      if (event.type === "timeline") {
        timeline.push(event.item);
        if (event.item.type === "assistant_message") {
          finalText = event.item.text.startsWith(finalText)
            ? event.item.text
            : `${finalText}${event.item.text}`;
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

    const unsubscribe = this.subscribe((event) => {
      if (!turnId) {
        buffered.push(event);
        return;
      }
      processEvent(event);
    });

    try {
      const started = await this.startTurn(prompt, options);
      turnId = started.turnId;
      for (const event of buffered) {
        processEvent(event);
      }
      if (!settled) {
        await completion;
      }
    } finally {
      unsubscribe();
    }

    if (!this.sessionId) {
      throw new Error("ACP session did not expose a session id");
    }

    return {
      sessionId: this.sessionId,
      finalText,
      usage,
      timeline,
    };
  }

  async startTurn(prompt: AgentPromptInput, _options?: AgentRunOptions): Promise<{ turnId: string }> {
    if (this.closed) {
      throw new Error(`${this.provider} session is closed`);
    }
    if (!this.connection || !this.sessionId) {
      throw new Error(`${this.provider} session is not initialized`);
    }
    if (this.activeForegroundTurnId) {
      throw new Error("A foreground turn is already active");
    }

    const turnId = randomUUID();
    const messageId = randomUUID();
    this.activeForegroundTurnId = turnId;
    this.suppressUserEchoMessageId = messageId;
    this.suppressUserEchoText = extractPromptText(prompt);
    this.emitBootstrapThreadEvent();
    this.pushEvent({ type: "turn_started", provider: this.provider, turnId });

    void this.connection
      .prompt({
        sessionId: this.sessionId,
        messageId,
        prompt: toACPContentBlocks(prompt),
      })
      .then((response) => {
        this.handlePromptResponse(response, turnId);
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.finishTurn({
          type: "turn_failed",
          provider: this.provider,
          error: message,
          diagnostic: this.collectDiagnostic(message),
          turnId,
        });
      });

    return { turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    if (this.sessionId) {
      callback({
        type: "thread_started",
        provider: this.provider,
        sessionId: this.sessionId,
      });
    }
    return () => {
      this.subscribers.delete(callback);
    };
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    if (!this.historyPending || this.persistedHistory.length === 0) {
      return;
    }
    const history = [...this.persistedHistory];
    this.persistedHistory.length = 0;
    this.historyPending = false;
    for (const item of history) {
      yield { type: "timeline", provider: this.provider, item };
    }
  }

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    return {
      provider: this.provider,
      sessionId: this.sessionId,
      model: this.currentModel,
      thinkingOptionId: this.thinkingOptionId,
      modeId: this.currentMode,
      extra: {
        title: this.currentTitle,
        updatedAt: this.lastActivityAt,
      },
    };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return [...this.availableModes];
  }

  async getCurrentMode(): Promise<string | null> {
    return this.currentMode;
  }

  async listCommands(): Promise<AgentSlashCommand[]> {
    return this.cachedCommands;
  }

  async setMode(modeId: string): Promise<void> {
    if (!this.connection || !this.sessionId) {
      throw new Error("ACP session not initialized");
    }

    const modeExists = this.availableModes.some((mode) => mode.id === modeId);
    if (!modeExists && this.availableModes.length > 0) {
      throw new Error(`Unknown ${this.provider} mode '${modeId}'`);
    }

    if (this.availableModes.length > 0) {
      await this.connection.setSessionMode({ sessionId: this.sessionId, modeId });
      this.currentMode = modeId;
      return;
    }

    const modeOption = this.getSelectConfigOption("mode");
    if (!modeOption) {
      throw new Error(`${this.provider} does not expose ACP mode switching`);
    }
    await this.connection.setSessionConfigOption({
      sessionId: this.sessionId,
      configId: modeOption.id,
      value: modeId,
    });
    this.currentMode = modeId;
  }

  async setModel(modelId: string | null): Promise<void> {
    if (!this.connection || !this.sessionId) {
      throw new Error("ACP session not initialized");
    }
    if (!modelId) {
      this.currentModel = null;
      return;
    }

    const modelExists = this.availableModels.some((model) => model.id === modelId);
    if (!modelExists && this.availableModels.length > 0) {
      throw new Error(`Unknown ${this.provider} model '${modelId}'`);
    }

    if ("unstable_setSessionModel" in this.connection) {
      try {
        await this.connection.unstable_setSessionModel({
          sessionId: this.sessionId,
          modelId,
        });
        this.currentModel = modelId;
        return;
      } catch {
        // Fall through to config option path.
      }
    }

    const modelOption = this.getSelectConfigOption("model");
    if (!modelOption) {
      throw new Error(`${this.provider} does not expose ACP model selection`);
    }
    await this.connection.setSessionConfigOption({
      sessionId: this.sessionId,
      configId: modelOption.id,
      value: modelId,
    });
    this.currentModel = modelId;
  }

  async setThinkingOption(thinkingOptionId: string | null): Promise<void> {
    if (!this.connection || !this.sessionId) {
      throw new Error("ACP session not initialized");
    }
    if (!thinkingOptionId) {
      this.thinkingOptionId = null;
      return;
    }

    if (this.thinkingOptionWriter) {
      await this.thinkingOptionWriter(this.connection, this.sessionId, thinkingOptionId);
      this.thinkingOptionId = thinkingOptionId;
      return;
    }

    const option = this.getSelectConfigOption("thought_level");
    if (!option) {
      throw new Error(`${this.provider} does not expose ACP thought-level selection`);
    }
    await this.connection.setSessionConfigOption({
      sessionId: this.sessionId,
      configId: option.id,
      value: thinkingOptionId,
    });
    this.thinkingOptionId = thinkingOptionId;
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return Array.from(this.pendingPermissions.values(), (entry) => entry.request);
  }

  async respondToPermission(requestId: string, response: AgentPermissionResponse): Promise<void> {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) {
      throw new Error(`No pending permission request with id '${requestId}'`);
    }

    this.pendingPermissions.delete(requestId);
    const selectedOption = selectPermissionOption(pending.options, response);
    pending.resolve(
      selectedOption
        ? {
            outcome: {
              outcome: "selected",
              optionId: selectedOption.optionId,
            },
          }
        : { outcome: { outcome: "cancelled" } },
    );

    this.pushEvent({
      type: "permission_resolved",
      provider: this.provider,
      requestId,
      resolution: response,
      turnId: pending.turnId ?? undefined,
    });

    if (response.behavior === "deny" && response.interrupt && this.connection && this.sessionId) {
      await this.connection.cancel({ sessionId: this.sessionId });
    }
  }

  describePersistence(): AgentPersistenceHandle | null {
    if (!this.sessionId) {
      return null;
    }
    return {
      provider: this.provider,
      sessionId: this.sessionId,
      nativeHandle: this.sessionId,
      metadata: {
        ...this.config,
        title: this.currentTitle,
      },
    };
  }

  async interrupt(): Promise<void> {
    if (!this.connection || !this.sessionId) {
      return;
    }

    for (const pending of this.pendingPermissions.values()) {
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }
    this.pendingPermissions.clear();

    if (this.activeForegroundTurnId) {
      await this.connection.cancel({ sessionId: this.sessionId });
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    for (const pending of this.pendingPermissions.values()) {
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }
    this.pendingPermissions.clear();

    if (this.connection && this.sessionId) {
      try {
        if (this.activeForegroundTurnId) {
          await this.connection.cancel({ sessionId: this.sessionId });
        }
      } catch {}

      try {
        if (this.agentCapabilities?.sessionCapabilities?.close) {
          await this.connection.unstable_closeSession({ sessionId: this.sessionId });
        }
      } catch (error) {
        this.logger.debug({ err: error }, "ACP closeSession failed during shutdown");
      }
    }

    for (const terminal of this.terminalEntries.values()) {
      terminal.child.kill("SIGTERM");
    }
    this.terminalEntries.clear();

    if (this.child) {
      this.child.kill("SIGTERM");
      await waitForChildExit(this.child, 2_000);
    }

    this.subscribers.clear();
    this.connection = null;
    this.child = null;
    this.activeForegroundTurnId = null;
  }

  async requestPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const requestId = randomUUID();
    let toolSnapshot =
      this.toolCalls.get(params.toolCall.toolCallId) ??
      mergeToolSnapshot(params.toolCall.toolCallId, params.toolCall);
    if (this.toolSnapshotTransformer) {
      toolSnapshot = this.toolSnapshotTransformer(toolSnapshot);
    }
    const request = mapPermissionRequest(
      this.provider,
      requestId,
      params,
      toolSnapshot,
    );

    const promise = new Promise<RequestPermissionResponse>((resolve, reject) => {
      this.pendingPermissions.set(requestId, {
        request,
        options: params.options,
        resolve,
        reject,
        turnId: this.activeForegroundTurnId,
      });
    });

    this.pushEvent({
      type: "permission_requested",
      provider: this.provider,
      request,
      turnId: this.activeForegroundTurnId ?? undefined,
    });
    return promise;
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    if (params.sessionId !== this.sessionId) {
      return;
    }

    const events = this.translateSessionUpdate(params.update);
    if (this.replayingHistory) {
      for (const event of events) {
        if (event.type === "timeline") {
          this.persistedHistory.push(event.item);
        }
      }
      return;
    }

    for (const event of events) {
      this.pushEvent(event);
    }
  }

  async readTextFile(params: ReadTextFileRequest): Promise<{ content: string }> {
    const raw = await fs.readFile(params.path, "utf8");
    if (!params.line && !params.limit) {
      return { content: raw };
    }
    const lines = raw.split(/\r?\n/);
    const start = Math.max((params.line ?? 1) - 1, 0);
    const end = params.limit ? start + params.limit : undefined;
    return { content: lines.slice(start, end).join("\n") };
  }

  async writeTextFile(params: WriteTextFileRequest): Promise<Record<string, never>> {
    await fs.mkdir(path.dirname(params.path), { recursive: true });
    await fs.writeFile(params.path, params.content, "utf8");
    return {};
  }

  async createTerminal(params: CreateTerminalRequest): Promise<{ terminalId: string }> {
    const terminalId = randomUUID();
    const env = Object.fromEntries((params.env ?? []).map((entry: EnvVariable) => [entry.name, entry.value]));
    const child = spawn(params.command, params.args ?? [], {
      cwd: params.cwd ?? this.config.cwd,
      env: {
        ...applyProviderEnv(process.env as Record<string, string | undefined>, this.runtimeSettings),
        ...env,
      },
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    let resolveExit!: (exit: TerminalExit) => void;
    let rejectExit!: (error: Error) => void;
    const waitForExit = new Promise<TerminalExit>((resolve, reject) => {
      resolveExit = resolve;
      rejectExit = reject;
    });

    const entry: TerminalEntry = {
      id: terminalId,
      child,
      output: "",
      truncated: false,
      outputByteLimit: params.outputByteLimit ?? null,
      exit: null,
      waitForExit,
      resolveExit,
      rejectExit,
    };

    child.stdout.on("data", (chunk: Buffer | string) => appendTerminalOutput(entry, chunk.toString()));
    child.stderr.on("data", (chunk: Buffer | string) => appendTerminalOutput(entry, chunk.toString()));
    child.once("error", (error) => rejectExit(error instanceof Error ? error : new Error(String(error))));
    child.once("exit", (code, signal) => {
      const exit = { exitCode: code, signal };
      entry.exit = exit;
      resolveExit(exit);
    });

    this.terminalEntries.set(terminalId, entry);
    return { terminalId };
  }

  async terminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
    const entry = this.getTerminalEntry(params.terminalId);
    return {
      output: entry.output,
      truncated: entry.truncated,
      exitStatus: entry.exit ?? undefined,
    };
  }

  async waitForTerminalExit(params: WaitForTerminalExitRequest): Promise<TerminalExit> {
    const entry = this.getTerminalEntry(params.terminalId);
    return entry.waitForExit;
  }

  async releaseTerminal(params: { sessionId: string; terminalId: string }): Promise<void> {
    const entry = this.getTerminalEntry(params.terminalId);
    if (!entry.exit) {
      entry.child.kill("SIGTERM");
    }
    this.terminalEntries.delete(params.terminalId);
  }

  async killTerminal(params: KillTerminalRequest): Promise<Record<string, never>> {
    const entry = this.getTerminalEntry(params.terminalId);
    if (!entry.exit) {
      entry.child.kill("SIGTERM");
    }
    return {};
  }

  private async spawnProcess(): Promise<SpawnedACPProcess> {
    const prefix = resolveProviderCommandPrefix(this.runtimeSettings?.command, () => {
      const resolved = findExecutable(this.defaultCommand[0]);
      if (!resolved) {
        throw new Error(`${this.provider} command '${this.defaultCommand[0]}' not found`);
      }
      return resolved;
    });

    const command = prefix.command;
    const args = [...prefix.args, ...this.defaultCommand.slice(1)];
    const child = spawn(command, args, {
      cwd: this.config.cwd,
      env: {
        ...applyProviderEnv(process.env as Record<string, string | undefined>, this.runtimeSettings),
        ...(this.launchEnv ?? {}),
      },
      shell: process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stderrChunks: string[] = [];
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(chunk.toString());
    });
    child.once("exit", (code, signal) => {
      if (this.closed) {
        return;
      }
      if (this.activeForegroundTurnId) {
        this.synthesizeCanceledToolCalls();
        this.finishTurn({
          type: "turn_failed",
          provider: this.provider,
          error: `ACP agent exited unexpectedly (${code ?? "null"}${signal ? `, ${signal}` : ""})`,
          diagnostic: stderrChunks.join("").trim() || undefined,
          turnId: this.activeForegroundTurnId,
        });
      }
    });

    if (!child.stdin || !child.stdout) {
      throw new Error(`${this.provider} ACP process did not expose stdio pipes`);
    }

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    const connection = new ClientSideConnection(() => this, stream);
    const initialize = await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: ACP_CLIENT_CAPABILITIES,
      clientInfo: { name: "Paseo", version: "dev" },
    });

    return { child, connection, initialize };
  }

  private applySessionState(response: SessionStateResponse): void {
    const transformed = this.sessionResponseTransformer
      ? this.sessionResponseTransformer(response)
      : response;

    this.configOptions = transformed.configOptions ?? [];

    const modeInfo = deriveModesFromACP(this.defaultModes, transformed.modes, this.configOptions);
    this.availableModes = modeInfo.modes;
    this.availableModels = this.deriveAvailableModels(transformed.models);
    this.currentMode = modeInfo.currentModeId ?? this.currentMode;

    this.currentModel =
      transformed.models?.currentModelId ?? deriveCurrentConfigValue(this.configOptions, "model");
    this.thinkingOptionId =
      deriveCurrentConfigValue(this.configOptions, "thought_level") ?? this.thinkingOptionId;
  }

  private async applyConfiguredOverrides(): Promise<void> {
    if (this.config.modeId && this.config.modeId !== this.currentMode) {
      await this.setMode(this.config.modeId);
    }
    if (this.config.model && this.config.model !== this.currentModel) {
      await this.setModel(this.config.model);
    }
    if (this.config.thinkingOptionId && this.config.thinkingOptionId !== this.thinkingOptionId) {
      await this.setThinkingOption(this.config.thinkingOptionId);
    }
  }

  private translateSessionUpdate(update: SessionUpdate): AgentStreamEvent[] {
    switch (update.sessionUpdate) {
      case "user_message_chunk": {
        const item = this.createMessageTimelineItem("user_message", update);
        if (!item) {
          return [];
        }
        const shouldSuppress =
          this.suppressUserEchoMessageId &&
          update.messageId === this.suppressUserEchoMessageId &&
          this.suppressUserEchoText &&
          item.text === this.suppressUserEchoText;
        if (shouldSuppress) {
          return [];
        }
        return [this.wrapTimeline(item)];
      }
      case "agent_message_chunk": {
        const item = this.createMessageTimelineItem("assistant_message", update);
        return item ? [this.wrapTimeline(item)] : [];
      }
      case "agent_thought_chunk": {
        const item = this.createMessageTimelineItem("reasoning", update);
        return item ? [this.wrapTimeline(item)] : [];
      }
      case "tool_call": {
        let snapshot = mergeToolSnapshot(update.toolCallId, update);
        if (this.toolSnapshotTransformer) {
          snapshot = this.toolSnapshotTransformer(snapshot);
        }
        this.toolCalls.set(update.toolCallId, snapshot);
        return [this.wrapTimeline(mapToolSnapshotToTimeline(snapshot, this.terminalEntries))];
      }
      case "tool_call_update": {
        const previous = this.toolCalls.get(update.toolCallId);
        let snapshot = mergeToolSnapshot(update.toolCallId, update, previous);
        if (this.toolSnapshotTransformer) {
          snapshot = this.toolSnapshotTransformer(snapshot);
        }
        this.toolCalls.set(update.toolCallId, snapshot);
        return [this.wrapTimeline(mapToolSnapshotToTimeline(snapshot, this.terminalEntries))];
      }
      case "plan":
        return [this.wrapTimeline(mapPlanToTimeline(update))];
      case "current_mode_update":
        this.handleCurrentModeUpdate(update);
        return [];
      case "config_option_update":
        this.handleConfigOptionUpdate(update);
        return [];
      case "session_info_update":
        this.handleSessionInfoUpdate(update);
        return [];
      case "usage_update":
        this.handleUsageUpdate(update);
        return [];
      case "available_commands_update":
        this.cachedCommands = update.availableCommands.map((command) => ({
          name: command.name,
          description: command.description,
          argumentHint: "",
        }));
        return [];
      default:
        return [];
    }
  }

  private createMessageTimelineItem(
    type: "user_message" | "assistant_message" | "reasoning",
    update: Extract<
      SessionUpdate,
      { sessionUpdate: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk" }
    >,
  ):
    | { type: "user_message"; text: string; messageId?: string }
    | { type: "assistant_message"; text: string }
    | { type: "reasoning"; text: string }
    | null {
    const chunkText = contentBlockToText(update.content);
    if (!chunkText) {
      return null;
    }
    const key = `${type}:${update.messageId ?? "default"}`;
    const state = this.messageAssemblies.get(key) ?? { text: "" };
    state.text += chunkText;
    this.messageAssemblies.set(key, state);

    if (type === "user_message") {
      return { type: "user_message", text: state.text, messageId: update.messageId ?? undefined };
    }
    if (type === "assistant_message") {
      return { type: "assistant_message", text: chunkText };
    }
    return { type: "reasoning", text: chunkText };
  }

  private handleCurrentModeUpdate(update: CurrentModeUpdate): void {
    this.currentMode = update.currentModeId;
  }

  private handleConfigOptionUpdate(update: ConfigOptionUpdate): void {
    this.configOptions = update.configOptions;
    const modeInfo = deriveModesFromACP(this.defaultModes, null, this.configOptions);
    this.availableModes = modeInfo.modes;
    this.availableModels = this.deriveAvailableModels(null);
    this.currentMode = modeInfo.currentModeId ?? this.currentMode;
    this.currentModel = deriveCurrentConfigValue(this.configOptions, "model") ?? this.currentModel;
    this.thinkingOptionId =
      deriveCurrentConfigValue(this.configOptions, "thought_level") ?? this.thinkingOptionId;
  }

  private deriveAvailableModels(
    models: SessionModelState | null | undefined,
  ): AgentModelDefinition[] {
    const availableModels = deriveModelDefinitionsFromACP(this.provider, models, this.configOptions);
    return this.modelTransformer ? this.modelTransformer(availableModels) : availableModels;
  }

  private handleSessionInfoUpdate(update: SessionInfoUpdate): void {
    if ("title" in update) {
      this.currentTitle = update.title ?? null;
    }
    if ("updatedAt" in update) {
      this.lastActivityAt = update.updatedAt ?? null;
    }
  }

  private handleUsageUpdate(update: UsageUpdate): void {
    void update;
  }

  private handlePromptResponse(response: PromptResponse, turnId: string): void {
    this.currentTurnUsage = mapACPUsage(response.usage) ?? this.currentTurnUsage;

    switch (response.stopReason) {
      case "cancelled":
        this.synthesizeCanceledToolCalls();
        this.finishTurn({
          type: "turn_canceled",
          provider: this.provider,
          reason: "Interrupted",
          turnId,
        });
        break;
      case "end_turn":
      case "max_tokens":
      case "max_turn_requests":
      case "refusal":
      default:
        this.finishTurn({
          type: "turn_completed",
          provider: this.provider,
          usage: this.currentTurnUsage,
          turnId,
        });
        break;
    }
  }

  private wrapTimeline(item: AgentTimelineItem): AgentStreamEvent {
    return {
      type: "timeline",
      provider: this.provider,
      item,
      turnId: this.activeForegroundTurnId ?? undefined,
    };
  }

  private pushEvent(event: AgentStreamEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }

  private finishTurn(event: Extract<AgentStreamEvent, { type: "turn_completed" | "turn_failed" | "turn_canceled" }>): void {
    this.activeForegroundTurnId = null;
    this.suppressUserEchoMessageId = null;
    this.suppressUserEchoText = null;
    this.pushEvent(event);
  }

  private emitBootstrapThreadEvent(): void {
    if (!this.bootstrapThreadEventPending || !this.sessionId) {
      return;
    }
    this.bootstrapThreadEventPending = false;
    this.pushEvent({
      type: "thread_started",
      provider: this.provider,
      sessionId: this.sessionId,
    });
  }

  private synthesizeCanceledToolCalls(): void {
    for (const snapshot of this.toolCalls.values()) {
      const mapped = mapToolSnapshotToTimeline(snapshot, this.terminalEntries);
      if (mapped.status === "running") {
        this.pushEvent(
          this.wrapTimeline({
            ...mapped,
            status: "canceled",
            error: null,
          }),
        );
      }
    }
  }

  private collectDiagnostic(message: string): string | undefined {
    const parts: string[] = [message];
    if (this.child?.exitCode != null) {
      parts.push(`exitCode=${this.child.exitCode}`);
    }
    if (this.child?.signalCode) {
      parts.push(`signal=${this.child.signalCode}`);
    }
    return parts.length > 0 ? parts.join(" | ") : undefined;
  }

  private getSelectConfigOption(category: string): Extract<SessionConfigOption, { type: "select" }> | null {
    const option = this.configOptions.find(
      (entry): entry is Extract<SessionConfigOption, { type: "select" }> =>
        entry.type === "select" && entry.category === category,
    );
    return option ?? null;
  }

  private getTerminalEntry(terminalId: string): TerminalEntry {
    const entry = this.terminalEntries.get(terminalId);
    if (!entry) {
      throw new Error(`Unknown terminal '${terminalId}'`);
    }
    return entry;
  }
}

function flattenSelectOptions(
  options: Extract<SessionConfigOption, { type: "select" }>["options"],
): Array<{ value: string; name: string; description?: string | null; group?: string }> {
  const flattened: Array<{ value: string; name: string; description?: string | null; group?: string }> = [];
  for (const option of options) {
    if ("value" in option) {
      flattened.push(option);
      continue;
    }
    for (const groupOption of option.options) {
      flattened.push({ ...groupOption, group: option.group });
    }
  }
  return flattened;
}

function deriveSelectorOptions(
  configOptions: SessionConfigOption[] | null | undefined,
  category: string,
): ConfigOptionSelector[] {
  const option = configOptions?.find(
    (entry): entry is Extract<SessionConfigOption, { type: "select" }> =>
      entry.type === "select" && entry.category === category,
  );
  if (!option) {
    return [];
  }

  return flattenSelectOptions(option.options).map((value) => ({
    id: value.value,
    label: value.name,
    description: value.description ?? undefined,
    isDefault: value.value === option.currentValue,
    metadata: value.group ? { group: value.group } : undefined,
  }));
}

function deriveCurrentConfigValue(
  configOptions: SessionConfigOption[] | null | undefined,
  category: string,
): string | null {
  const option = configOptions?.find(
    (entry): entry is Extract<SessionConfigOption, { type: "select" }> =>
      entry.type === "select" && entry.category === category,
  );
  return option?.currentValue ?? null;
}

function normalizeMcpServers(servers?: Record<string, McpServerConfig>): McpServer[] {
  if (!servers) {
    return [];
  }

  return Object.entries(servers).map(([name, config]) => {
    if (config.type === "stdio") {
      return {
        name,
        command: config.command,
        args: config.args ?? [],
        env: Object.entries(config.env ?? {}).map(([envName, value]) => ({
          name: envName,
          value,
        })),
      } satisfies McpServer;
    }

    if (config.type === "http") {
      return {
        type: "http",
        name,
        url: config.url,
        headers: Object.entries(config.headers ?? {}).map(([headerName, value]) => ({
          name: headerName,
          value,
        })),
      } satisfies McpServer;
    }

    return {
      type: "sse",
      name,
      url: config.url,
      headers: Object.entries(config.headers ?? {}).map(([headerName, value]) => ({
        name: headerName,
        value,
      })),
    } satisfies McpServer;
  });
}

function toACPContentBlocks(prompt: AgentPromptInput): ContentBlock[] {
  if (typeof prompt === "string") {
    return [{ type: "text", text: prompt }];
  }

  return prompt.map((block: AgentPromptContentBlock) => {
    if (block.type === "text") {
      return { type: "text", text: block.text };
    }
    return {
      type: "image",
      data: block.data,
      mimeType: block.mimeType,
    };
  });
}

function extractPromptText(prompt: AgentPromptInput): string {
  if (typeof prompt === "string") {
    return prompt;
  }
  return prompt
    .filter((block): block is Extract<AgentPromptContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function contentBlockToText(content: ContentBlock): string {
  switch (content.type) {
    case "text":
      return content.text;
    case "resource_link":
      return content.title ?? content.uri;
    case "resource":
      return "text" in content.resource ? content.resource.text : `[resource:${content.resource.mimeType ?? "binary"}]`;
    case "image":
      return "[image]";
    case "audio":
      return "[audio]";
    default:
      return "";
  }
}

function mergeToolSnapshot(
  toolCallId: string,
  update: ToolCall | ToolCallUpdate,
  previous?: ACPToolSnapshot,
): ACPToolSnapshot {
  const isFull = "title" in update && typeof update.title === "string";
  return {
    toolCallId,
    title: (update.title ?? previous?.title ?? toolCallId) as string,
    kind: update.kind ?? previous?.kind ?? null,
    status: update.status ?? previous?.status ?? null,
    content: update.content !== undefined ? update.content : previous?.content ?? null,
    locations: update.locations !== undefined ? update.locations : previous?.locations ?? null,
    rawInput: update.rawInput !== undefined ? update.rawInput : previous?.rawInput,
    rawOutput: update.rawOutput !== undefined ? update.rawOutput : previous?.rawOutput,
    ...(isFull ? {} : {}),
  };
}

function mapPlanToTimeline(plan: Plan): AgentTimelineItem {
  return {
    type: "todo",
    items: plan.entries.map((entry) => ({
      text: entry.content,
      completed: entry.status === "completed",
    })),
  };
}

function mapToolSnapshotToTimeline(
  snapshot: ACPToolSnapshot,
  terminals: Map<string, TerminalEntry>,
): ToolCallTimelineItem {
  const status = mapToolStatus(snapshot.status);
  const detail = mapToolDetail(snapshot, terminals);
  const base = {
    type: "tool_call" as const,
    callId: snapshot.toolCallId,
    name: snapshot.kind ?? snapshot.title,
    detail,
    metadata: {
      kind: snapshot.kind ?? undefined,
      title: snapshot.title,
    },
  };
  if (status === "failed") {
    return {
      ...base,
      status: "failed",
      error: { message: readErrorMessage(snapshot.rawOutput) },
    };
  }
  if (status === "completed") {
    return {
      ...base,
      status: "completed",
      error: null,
    };
  }
  return {
    ...base,
    status: "running",
    error: null,
  };
}

function mapToolStatus(status: ToolCallStatus | null | undefined): ToolCallTimelineItem["status"] {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "pending":
    case "in_progress":
    default:
      return "running";
  }
}

function mapToolDetail(snapshot: ACPToolSnapshot, terminals: Map<string, TerminalEntry>): ToolCallDetail {
  const firstLocation = snapshot.locations?.[0]?.path;
  const textContent = extractToolText(snapshot.content);
  const diffContent = extractDiffContent(snapshot.content);
  const terminalContent = extractTerminalContent(snapshot.content, terminals);
  const rawInput = readRecord(snapshot.rawInput);
  const rawOutput = readRecord(snapshot.rawOutput);

  switch (snapshot.kind) {
    case "read":
      return {
        type: "read",
        filePath:
          firstLocation ?? readString(rawInput, ["path", "filePath", "file"]) ?? snapshot.title,
        content: textContent ?? readString(rawOutput, ["content", "text"]),
        offset: readNumber(rawInput, ["offset", "line"]),
        limit: readNumber(rawInput, ["limit"]),
      };
    case "edit":
    case "delete":
      return {
        type: "edit",
        filePath:
          firstLocation ?? readString(rawInput, ["path", "filePath", "file"]) ?? snapshot.title,
        oldString: diffContent?.oldText ?? readString(rawInput, ["oldText", "oldString"]),
        newString:
          snapshot.kind === "delete"
            ? ""
            : diffContent?.newText ?? readString(rawInput, ["newText", "newString"]),
        unifiedDiff: textContent ?? undefined,
      };
    case "search":
      return {
        type: "search",
        query: readString(rawInput, ["query", "pattern"]) ?? snapshot.title,
        toolName: "search",
        content: textContent ?? readString(rawOutput, ["content", "text"]),
        filePaths: snapshot.locations?.map((location) => location.path),
      };
    case "execute":
      return {
        type: "shell",
        command:
          terminalContent?.command ??
          buildShellCommand(rawInput) ??
          readString(rawInput, ["command"]) ??
          snapshot.title,
        cwd: terminalContent?.cwd ?? readString(rawInput, ["cwd"]),
        output: terminalContent?.output ?? textContent ?? readString(rawOutput, ["output", "text"]),
        exitCode: terminalContent?.exitCode ?? readNumber(rawOutput, ["exitCode"]),
      };
    case "fetch":
      return {
        type: "fetch",
        url: readString(rawInput, ["url"]) ?? snapshot.title,
        prompt: readString(rawInput, ["prompt"]),
        result: textContent ?? readString(rawOutput, ["result", "text", "content"]),
        code: readNumber(rawOutput, ["status", "code"]),
      };
    case "think":
      return {
        type: "plain_text",
        label: snapshot.title,
        icon: "brain",
        text: textContent ?? stringifyUnknown(snapshot.rawOutput),
      };
    case "switch_mode":
      return {
        type: "plain_text",
        label: snapshot.title,
        icon: "sparkles",
        text: textContent ?? stringifyUnknown(snapshot.rawInput),
      };
    default:
      if (terminalContent) {
        return {
          type: "shell",
          command: terminalContent.command ?? snapshot.title,
          cwd: terminalContent.cwd,
          output: terminalContent.output,
          exitCode: terminalContent.exitCode,
        };
      }
      if (textContent) {
        return {
          type: "plain_text",
          label: snapshot.title,
          text: textContent,
          icon: "wrench",
        };
      }
      return {
        type: "unknown",
        input: snapshot.rawInput ?? null,
        output: snapshot.rawOutput ?? null,
      };
  }
}

function extractToolText(content: ToolCallContent[] | null | undefined): string | undefined {
  if (!content) {
    return undefined;
  }
  const parts: string[] = [];
  for (const item of content) {
    if (item.type === "content") {
      const text = contentBlockToText(item.content);
      if (text) {
        parts.push(text);
      }
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function extractDiffContent(
  content: ToolCallContent[] | null | undefined,
): { oldText?: string | null; newText: string } | null {
  const diff = content?.find((item): item is Extract<ToolCallContent, { type: "diff" }> => item.type === "diff");
  return diff ? { oldText: diff.oldText ?? undefined, newText: diff.newText } : null;
}

function extractTerminalContent(
  content: ToolCallContent[] | null | undefined,
  terminals: Map<string, TerminalEntry>,
):
  | {
      command?: string;
      cwd?: string;
      output?: string;
      exitCode?: number | null;
    }
  | undefined {
  const terminal = content?.find(
    (item): item is Extract<ToolCallContent, { type: "terminal" }> => item.type === "terminal",
  );
  if (!terminal) {
    return undefined;
  }
  const entry = terminals.get(terminal.terminalId);
  if (!entry) {
    return undefined;
  }
  return {
    output: entry.output,
    exitCode: entry.exit?.exitCode ?? null,
  };
}

function mapPermissionRequest(
  provider: string,
  requestId: string,
  params: RequestPermissionRequest,
  snapshot: ACPToolSnapshot,
): AgentPermissionRequest {
  const kind: AgentPermissionRequestKind = snapshot.kind === "switch_mode" ? "mode" : "tool";
  return {
    id: requestId,
    provider,
    name: snapshot.kind ?? snapshot.title,
    kind,
    title: params.toolCall.title ?? snapshot.title,
    detail: mapToolDetail(snapshot, new Map()),
    metadata: {
      toolCallId: params.toolCall.toolCallId,
      rawRequest: params,
      options: params.options,
    },
  };
}

function selectPermissionOption(
  options: PermissionOption[],
  response: AgentPermissionResponse,
): PermissionOption | null {
  const order =
    response.behavior === "allow"
      ? ["allow_once", "allow_always"]
      : ["reject_once", "reject_always"];
  for (const kind of order) {
    const match = options.find((option) => option.kind === kind);
    if (match) {
      return match;
    }
  }
  return null;
}

function appendTerminalOutput(entry: TerminalEntry, chunk: string): void {
  entry.output += chunk;
  const limit = entry.outputByteLimit;
  if (!limit) {
    return;
  }
  while (Buffer.byteLength(entry.output, "utf8") > limit && entry.output.length > 0) {
    entry.output = entry.output.slice(1);
    entry.truncated = true;
  }
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(
  record: Record<string, unknown> | null,
  keys: string[],
): string | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function readNumber(
  record: Record<string, unknown> | null,
  keys: string[],
): number | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function buildShellCommand(record: Record<string, unknown> | null): string | undefined {
  if (!record) {
    return undefined;
  }
  const command = readString(record, ["command"]);
  const args = Array.isArray(record["args"])
    ? record["args"].filter((value): value is string => typeof value === "string")
    : [];
  if (!command) {
    return undefined;
  }
  return args.length > 0 ? `${command} ${args.join(" ")}` : command;
}

function readErrorMessage(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  const record = readRecord(value);
  return readString(record, ["message", "error"]) ?? "Tool call failed";
}

function stringifyUnknown(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function coerceSessionConfigMetadata(metadata: AgentMetadata | undefined): Partial<AgentSessionConfig> {
  if (!metadata || typeof metadata !== "object") {
    return {};
  }
  return metadata as Partial<AgentSessionConfig>;
}

async function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}
