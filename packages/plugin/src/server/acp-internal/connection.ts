import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawnProcess, terminateProcess } from "../process.js";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  CLIENT_METHODS,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type AgentCapabilities,
  type ContentBlock,
  type NewSessionResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionNotification,
  type SessionUpdate,
  type ToolCall,
  type ToolCallContent,
  type ToolCallUpdate,
  type Stream,
} from "@agentclientprotocol/sdk";
import { z } from "zod";
import type {
  AcpConfigAccess,
  AcpConfigChange,
  AcpConfigureContext,
  AcpRequest,
  AcpToolCallSnapshot,
  AcpTransformer,
  AcpVendorUpdate,
  RunAcpProviderOptions,
} from "../acp.js";
import {
  PROVIDER_PROTOCOL_VERSION,
  ProviderEventSchema,
  ProviderInputSchema,
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderCatalog,
  type ProviderCapability,
  type ProviderCommand,
  type ProviderConfigState,
  type ProviderConnectRequest,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderLaunch,
  type ProviderModel,
  type ProviderPermissionResponse,
  type ProviderPersistence,
  type ProviderSessionConfig,
  type ProviderSetting,
  type ProviderTimelineItem,
  type ProviderUsage,
} from "../provider.js";

const ADAPTER_CAPABILITIES = [
  "prompt.message",
  "prompt.command",
  "session.configure",
  "permission",
] as const;

interface AcpBoundarySession {
  runtime: AcpRuntime;
  capabilities: readonly ProviderCapability[];
  mutationLane: Promise<void>;
}

export async function createAcpProviderConnection(
  options: RunAcpProviderOptions,
  request: ProviderConnectRequest,
): Promise<ProviderConnection> {
  if (!request.versions.includes(PROVIDER_PROTOCOL_VERSION)) {
    throw new Error(`ACP adapter requires provider protocol ${PROVIDER_PROTOCOL_VERSION}`);
  }
  const probe = await AcpRuntime.start({
    options,
    launch: request.launch,
    boundarySessionId: "capability-probe",
    env: {},
    emit: () => undefined,
  });
  const supportedCapabilities: ProviderCapability[] = [...ADAPTER_CAPABILITIES];
  if (probe.agentCapabilities.promptCapabilities?.image) {
    supportedCapabilities.push("prompt.image");
  }
  if (probe.agentCapabilities.sessionCapabilities?.list) {
    supportedCapabilities.push("session.list");
  }
  if (probe.agentCapabilities.loadSession) {
    supportedCapabilities.push("session.persistence");
  }
  if (options.acpOptions?.deferTurnOnRunningTools) {
    supportedCapabilities.push("prompt.steer");
  }
  await probe.close();
  const capabilities = negotiateProviderCapabilities(request.capabilities, supportedCapabilities);
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<string, AcpBoundarySession>();
  const inFlight = new Set<Promise<void>>();
  let closed = false;
  let closePromise: Promise<void> | null = null;
  const emit = (event: ProviderEvent) => {
    if (closed) return;
    const parsed = ProviderEventSchema.parse(event);
    for (const listener of listeners) listener(parsed);
  };
  const state: AcpConnectionState = {
    options,
    launch: request.launch,
    capabilities,
    sessions,
    emit,
    isClosed: () => closed,
  };

  return {
    version: PROVIDER_PROTOCOL_VERSION,
    capabilities,
    async send(input) {
      if (closed) throw new Error("ACP provider connection is closed");
      input = ProviderInputSchema.parse(input);
      validateAdmission(input, { capabilities, sessions });
      const operation = Promise.resolve().then(async () => {
        if (closed) return undefined;
        await dispatch(input, state);
        return undefined;
      });
      const settled = operation.catch((error) => {
        emitOperationFailure(input, emit, error);
      });
      inFlight.add(settled);
      void settled.finally(() => inFlight.delete(settled));
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        await Promise.all(inFlight);
        const active = [...sessions.values()];
        sessions.clear();
        await Promise.all(active.map(({ runtime }) => runtime.closeSession()));
        listeners.clear();
      })();
      return closePromise;
    },
  };
}

interface AcpConnectionState {
  launch?: ProviderLaunch;
  options: RunAcpProviderOptions;
  capabilities: readonly ProviderCapability[];
  sessions: Map<string, AcpBoundarySession>;
  emit(event: ProviderEvent): void;
  isClosed(): boolean;
}

function validateAdmission(
  input: ProviderInput,
  state: Pick<AcpConnectionState, "capabilities" | "sessions">,
): void {
  if (input.type === "session.open") {
    if (state.sessions.has(input.sessionId))
      throw new Error(`Session already exists: ${input.sessionId}`);
    requireProviderCapabilities(state.capabilities, input);
    return;
  }
  if (!("sessionId" in input)) {
    requireProviderCapabilities(state.capabilities, input);
    return;
  }
  const session = requireSession(state as AcpConnectionState, input.sessionId);
  requireProviderCapabilities(session.capabilities, input);
}

function emitOperationFailure(
  input: ProviderInput,
  emit: (event: ProviderEvent) => void,
  error: unknown,
): void {
  const failure = { message: describeError(error) };
  if (input.type === "session.prompt") {
    emit({
      type: "session.prompt_result",
      sessionId: input.sessionId,
      clientMessageId: input.prompt.clientMessageId,
      result: { type: "failed", error: failure },
    });
    return;
  }
  if ("requestId" in input) {
    emit({ type: "request.failed", requestId: input.requestId, error: failure });
    return;
  }
  if ("sessionId" in input) {
    emit({ type: "session.runtime_failed", sessionId: input.sessionId, error: failure });
  }
}

async function dispatch(input: ProviderInput, state: AcpConnectionState): Promise<void> {
  switch (input.type) {
    case "catalog":
      await discover(input, state);
      return;
    case "sessions":
      await listSessions(input, state);
      return;
    case "session.open":
      await openSession(input, state);
      return;
    case "session.prompt": {
      const session = requireSession(state, input.sessionId);
      await mutateSession(session, () => session.runtime.prompt(input));
      return;
    }
    case "session.interrupt": {
      const session = requireSession(state, input.sessionId);
      const retired = await session.runtime.interrupt();
      state.emit({ type: "request.completed", requestId: input.requestId });
      if (retired) retireSession(state, input.sessionId);
      return;
    }
    case "session.permission":
      requireSession(state, input.sessionId).runtime.respondToPermission(
        input.permissionId,
        input.response,
      );
      return;
    case "session.configure": {
      const session = requireSession(state, input.sessionId);
      await mutateSession(session, () => session.runtime.configure(input.changes));
      state.emit({ type: "request.completed", requestId: input.requestId });
      return;
    }
    case "session.close": {
      const session = requireSession(state, input.sessionId);
      state.sessions.delete(input.sessionId);
      await session.runtime.closeSession();
      state.emit({ type: "session.closed", sessionId: input.sessionId });
      state.emit({ type: "request.completed", requestId: input.requestId });
      return;
    }
    case "session.archive":
    case "session.unarchive":
    case "session.revert":
      state.emit({
        type: "request.failed",
        requestId: input.requestId,
        error: { message: `${input.type} is not supported by this ACP provider` },
      });
  }
}

async function discover(
  input: Extract<ProviderInput, { type: "catalog" }>,
  state: AcpConnectionState,
): Promise<void> {
  const runtime = await AcpRuntime.start({
    options: state.options,
    launch: state.launch,
    boundarySessionId: "catalog",
    cwd: input.cwd,
    env: {},
    emit: state.emit,
  });
  try {
    let catalog = await runtime.discover(input.cwd);
    const context = runtime.configContext();
    for (const transformer of state.options.transformers ?? []) {
      if (transformer.discover) {
        catalog = await transformer.discover(catalog, context);
      }
    }
    state.emit({ type: "catalog", requestId: input.requestId, catalog });
  } finally {
    await runtime.closeSession();
  }
}

async function listSessions(
  input: Extract<ProviderInput, { type: "sessions" }>,
  state: AcpConnectionState,
): Promise<void> {
  const runtime = await AcpRuntime.start({
    options: state.options,
    launch: state.launch,
    boundarySessionId: "sessions",
    env: {},
    emit: state.emit,
  });
  try {
    const response = await runtime.listSessions(input.cwd);
    const selected = input.limit ? response.sessions.slice(0, input.limit) : response.sessions;
    state.emit({
      type: "sessions",
      requestId: input.requestId,
      sessions: selected.map((session) => ({
        persistence: nativePersistence(session.sessionId),
        cwd: session.cwd,
        title: session.title ?? undefined,
        updatedAt: session.updatedAt ?? undefined,
      })),
    });
  } finally {
    await runtime.close();
  }
}

function retireSession(state: AcpConnectionState, sessionId: string): void {
  if (state.sessions.delete(sessionId)) {
    state.emit({ type: "session.closed", sessionId });
  }
}

async function openSession(
  input: Extract<ProviderInput, { type: "session.open" }>,
  state: AcpConnectionState,
): Promise<void> {
  if (state.sessions.has(input.sessionId))
    throw new Error(`Session already exists: ${input.sessionId}`);
  const runtime = await AcpRuntime.start({
    options: state.options,
    launch: state.launch,
    boundarySessionId: input.sessionId,
    cwd: input.config.cwd,
    env: input.config.env,
    emit: state.emit,
    onRetired: () => retireSession(state, input.sessionId),
  });
  try {
    const capabilities = await runtime.open(input, state.capabilities, state.isClosed);
    if (state.isClosed()) {
      await runtime.closeSession();
      return;
    }
    state.sessions.set(input.sessionId, {
      runtime,
      capabilities,
      mutationLane: Promise.resolve(),
    });
    state.emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
  } catch (error) {
    await runtime.close();
    throw error;
  }
}

async function mutateSession(
  session: AcpBoundarySession,
  operation: () => Promise<void>,
): Promise<void> {
  const result = session.mutationLane.then(operation);
  session.mutationLane = result.catch(() => undefined);
  return result;
}

function requireSession(state: AcpConnectionState, sessionId: string): AcpBoundarySession {
  const session = state.sessions.get(sessionId);
  if (!session) throw new Error(`Unknown session: ${sessionId}`);
  return session;
}

interface StartRuntimeOptions {
  launch?: ProviderLaunch;
  options: RunAcpProviderOptions;
  boundarySessionId: string;
  cwd?: string;
  env: Readonly<Record<string, string>>;
  emit(event: ProviderEvent): void;
  onRetired?: () => void;
}

interface PendingPermission {
  request: RequestPermissionRequest;
  turnId: string | undefined;
  resolve(response: RequestPermissionResponse): void;
}

type DeferredTurnOutcome =
  | { type: "complete"; terminalizeTools: boolean }
  | { type: "cancel" }
  | { type: "fail"; error: { message: string } };

interface DeferredTurnState {
  timer: ReturnType<typeof setTimeout> | null;
  resolve(outcome: DeferredTurnOutcome): void;
}

type DeferredReplyState = "idle" | "open" | "settled_with_open_tools" | "settled";

interface ActivePrompt {
  turnId: string;
  settled: Promise<void>;
  cancelling: boolean;
  wirePromptsInFlight: number;
  wirePromptLane: Promise<void>;
  lastPromptResponseWireSeq: number | null;
  crossedEndTurn: boolean;
  replyState: DeferredReplyState;
  deferred: DeferredTurnState | null;
}

const DEFAULT_DEFERRED_SETTLE_DELAY_MS = 500;
const DEFAULT_DEFERRED_QUIET_LIMIT_MS = 120_000;

type AcpToolCallSource = AcpToolCallSnapshot & {
  diff?: Extract<ToolCallContent, { type: "diff" }>;
};

interface AcpToolCallState {
  source: AcpToolCallSource;
  presentation: AcpToolCallSnapshot;
}

class AcpRuntime {
  readonly connection: ClientSideConnection;
  agentCapabilities: AgentCapabilities = {};
  nativeSessionId = "";
  private readonly child: ChildProcessWithoutNullStreams | null;
  private emit: (event: ProviderEvent) => void;
  private readonly messages = new Map<string, string>();
  private readonly toolCalls = new Map<string, AcpToolCallState>();
  private mcpServerNames: readonly string[] = [];
  private readonly liveOpenToolIds = new Set<string>();
  private readonly canceledToolCallIds = new Set<string>();
  // Running tool rows published by transformers; the turn's terminal closes any left open.
  private readonly vendorToolCalls = new Map<string, ToolCallTimelineItem>();
  private readonly pendingCompactions = new Set<string>();
  private readonly permissions = new Map<string, PendingPermission>();
  private readonly transformers: readonly AcpTransformer[];
  private configOptions: SessionConfigOption[] = [];
  private modes: NewSessionResponse["modes"] = null;
  private commandWaiter: (() => void) | null = null;
  private receivedInitialCommands = false;
  private messageSequence = 0;
  /**
   * Fallback ids for streamed chunks that carry no `messageId`, one per
   * chunk kind. Consecutive chunks of a kind continue the same timeline
   * item; a chunk of another kind, a tool call, a plan, or a turn boundary
   * ends it (#4699).
   */
  private readonly fallbackChunkIds = new Map<
    "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk",
    string
  >();
  /**
   * Replay updates count as history until the session reports ready.
   * Once ready, suppress late replay rows until the first prompt.
   */
  private replayWindow: "replay" | "skip" | null = null;
  private lastLoadHistoryAt = 0;
  private lastPartialWireAt = 0;
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private deferredRetirement: Promise<boolean> | null = null;
  private deferredFinalized = false;
  private processFailed = false;
  private processFailureMessage: string | null = null;
  private configTransaction = false;
  private stagedTransformerConfig: ProviderConfigState | null = null;
  private readonly closeConnector: (options?: {
    force?: boolean;
    timeoutMs?: number;
  }) => Promise<void>;
  private readonly whenConnectorClosed: () => Promise<void> | null;
  private notificationLane: Promise<void> = Promise.resolve();
  private incomingWireSeq = 0;
  private readonly sessionUpdateWireSeqs: number[] = [];
  private autoAccept = false;
  private activePrompt: ActivePrompt | null = null;
  private lastUsage: ProviderUsage = {};

  static async start(options: StartRuntimeOptions): Promise<AcpRuntime> {
    let child: ChildProcessWithoutNullStreams | null = null;
    let spawnFailure: Promise<never> | null = null;
    let stream: Stream;
    let closeConnector: (options?: {
      force?: boolean;
      timeoutMs?: number;
    }) => Promise<void> = async () => {};
    let whenConnectorClosed: () => Promise<void> | null = () => null;
    let onPartialWireRead: (() => void) | null = null;
    if (options.options.command) {
      // COMPAT(pluginProviderLaunch): added in v0.10.0, remove after 2027-03-29 once plugin host floor >= v0.10.0.
      // Standalone callers and older hosts do not send a daemon-resolved launch.
      const launch = options.launch ?? {
        command: options.options.command[0],
        args: options.options.command.slice(1),
        env: process.env,
      };
      child = spawnProcess(launch.command, launch.args, {
        cwd: options.cwd,
        env: { ...launch.env, ...options.env },
        stdio: "pipe",
      });
      spawnFailure = new Promise<never>((_resolve, reject) => child!.once("error", reject));
      child.stderr.on("data", () => undefined);
      const output = Writable.toWeb(child.stdin) as unknown as Parameters<typeof ndJsonStream>[0];
      const rawInput = Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>;
      const input = observePartialWireReads(rawInput, () => onPartialWireRead?.()) as Parameters<
        typeof ndJsonStream
      >[1];
      stream = ndJsonStream(output, input);
    } else {
      const owned = ownConnectorStream(await options.options.connector());
      stream = owned.stream;
      closeConnector = owned.close;
      whenConnectorClosed = owned.whenClosed;
    }
    const runtime = new AcpRuntime(stream, child, closeConnector, whenConnectorClosed, options);
    onPartialWireRead = () => runtime.notePartialWireRead();
    try {
      const initialize = withTimeout(
        runtime.call(
          runtime.connection.initialize({
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {},
            clientInfo: { name: "paseo", version: "1" },
          }),
        ),
        options.options.acpOptions?.startupTimeoutMs ?? 10_000,
        `ACP provider ${options.options.id} did not initialize`,
      );
      const initialized = spawnFailure
        ? await Promise.race([initialize, spawnFailure])
        : await initialize;
      runtime.agentCapabilities = initialized.agentCapabilities ?? {};
      return runtime;
    } catch (error) {
      await runtime.close();
      throw error;
    }
  }

  private constructor(
    stream: Stream,
    child: ChildProcessWithoutNullStreams | null,
    closeConnector: (options?: { force?: boolean; timeoutMs?: number }) => Promise<void>,
    whenConnectorClosed: () => Promise<void> | null,
    private readonly options: StartRuntimeOptions,
  ) {
    this.child = child;
    this.closeConnector = closeConnector;
    this.whenConnectorClosed = whenConnectorClosed;
    this.emit = options.emit;
    this.transformers = options.options.transformers ?? [];
    const client: Client = {
      requestPermission: (request) => this.requestPermission(request),
      sessionUpdate: (notification) => {
        const wireSeq = this.sessionUpdateWireSeqs.shift() ?? ++this.incomingWireSeq;
        return this.enqueueNotification(() => this.sessionUpdate(notification, wireSeq));
      },
    };
    this.connection = new ClientSideConnection(
      () => client,
      routeIncomingMessages(
        stream,
        (method, params) => this.vendorNotification(method, params),
        (message) => this.observeWireMessage(message),
      ),
    );
    if (!child) void this.connection.closed.then(() => this.handleUnexpectedTransportClose());
    child?.on("error", (error) => {
      const message = describeError(error);
      this.processFailed = true;
      this.processFailureMessage = message;
      this.settlePendingWork(message);
      if (this.closing || !this.nativeSessionId) return;
      this.emit({
        type: "session.runtime_failed",
        sessionId: this.options.boundarySessionId,
        error: { message },
      });
    });
    child?.once("close", (code, signal) => {
      if (this.closing || this.processFailed || !this.nativeSessionId) return;
      const message = `ACP process exited (${signal ?? code ?? "unknown"})`;
      this.processFailed = true;
      this.processFailureMessage = message;
      this.settlePendingWork(message);
      this.emit({
        type: "session.runtime_failed",
        sessionId: this.options.boundarySessionId,
        error: { message },
      });
    });
  }

  async open(
    input: Extract<ProviderInput, { type: "session.open" }>,
    connectionCapabilities: readonly ProviderCapability[],
    isConnectionClosed: () => boolean,
  ): Promise<readonly ProviderCapability[]> {
    const mcpServers = toAcpMcpServers(input.config);
    this.mcpServerNames = mcpServers.map((server) => server.name);
    let nativeSessionId = readNativeSessionId(input.persistence);
    const metadata: Record<string, unknown> = {
      _paseo: {
        systemPrompt: input.config.systemPrompt,
        providerOptions: input.config.providerOptions,
        toolPolicy: input.config.toolPolicy,
        persist: input.config.persist,
      },
    };
    for (const transformer of this.transformers) {
      const prepared = transformer.sessionOpen?.({
        persistence: input.persistence,
        systemPrompt: input.config.systemPrompt,
        agentMetadata: jsonValue(this.agentCapabilities._meta ?? null),
      });
      nativeSessionId ??= prepared?.sessionId ?? null;
      Object.assign(metadata, prepared?.metadata);
    }
    let response: Pick<NewSessionResponse, "modes" | "configOptions">;
    if (nativeSessionId) {
      // ACP agents replay the loaded session's updates before session/load resolves,
      // so the native id must be registered first for them to pass the session filter.
      this.nativeSessionId = nativeSessionId;
      this.replayWindow = input.history === "replay" ? "replay" : "skip";
      response = await this.call(
        this.connection.loadSession({
          sessionId: nativeSessionId,
          cwd: input.config.cwd,
          mcpServers,
          _meta: metadata,
        }),
      );
      await this.drainNotifications();
      if (!this.options.options.acpOptions?.loadReplayQuietPeriodMs) this.replayWindow = null;
    } else {
      const newSession = await this.call(
        this.connection.newSession({
          cwd: input.config.cwd,
          mcpServers,
          _meta: metadata,
        }),
      );
      response = newSession;
      this.nativeSessionId = newSession.sessionId;
    }
    this.modes = response.modes ?? null;
    this.configOptions = response.configOptions ?? [];
    await this.applyInitialConfig(input.config);
    const sessionCapabilities = connectionCapabilities.filter(
      (capability) =>
        capability !== "session.configure" ||
        this.options.options.acpOptions?.autoAcceptMode !== undefined ||
        this.modes !== null ||
        this.configOptions.length > 0 ||
        this.transformers.some((transformer) => transformer.configure !== undefined),
    );
    this.emit({
      type: "session.opened",
      requestId: input.requestId,
      sessionId: input.sessionId,
      capabilities: sessionCapabilities,
      restoration: "core",
      persistence: nativePersistence(this.nativeSessionId),
      title: input.config.title,
      cwd: input.config.cwd,
    });
    this.emitConfig();
    await this.finishSessionOpen(isConnectionClosed);
    return sessionCapabilities;
  }

  private async finishSessionOpen(isConnectionClosed: () => boolean): Promise<void> {
    if (this.options.options.acpOptions?.waitForInitialCommands) {
      await this.waitForInitialCommands();
    }
    const quietPeriod = this.options.options.acpOptions?.loadReplayQuietPeriodMs;
    if (this.replayWindow && quietPeriod && quietPeriod > 0) {
      await this.waitForLoadReplay(quietPeriod, isConnectionClosed);
      this.replayWindow = "skip";
    }
    if (this.processFailed && !isConnectionClosed()) {
      throw new Error(this.processFailureMessage ?? "ACP process exited during session open");
    }
  }

  async discover(cwd?: string): Promise<ProviderCatalog> {
    if (cwd === undefined && this.options.options.acpOptions?.workspaceOnlyCatalog) {
      return { models: [], modes: [] };
    }
    const response = await this.call(
      this.connection.newSession({ cwd: cwd ?? process.cwd(), mcpServers: [] }),
    );
    this.nativeSessionId = response.sessionId;
    this.modes = response.modes ?? null;
    this.configOptions = response.configOptions ?? [];
    let catalog = toProviderCatalog(this.modes, this.configOptions);
    if (this.options.options.acpOptions?.perModelThinkingOptions) {
      catalog = { ...catalog, models: await this.modelsWithOwnThinkingOptions(catalog) };
    }
    const autoAcceptMode = this.options.options.acpOptions?.autoAcceptMode;
    if (!autoAcceptMode) return catalog;
    return {
      ...catalog,
      modes: [...catalog.modes, { ...autoAcceptMode.mode, isUnattended: true }],
      defaultMode: autoAcceptMode.default ? autoAcceptMode.mode.id : catalog.defaultMode,
    };
  }

  /**
   * Selects each model in the discovery session to read the thinking options the agent lists for
   * it, then selects the opening model again for the transformers that run after discovery.
   */
  private async modelsWithOwnThinkingOptions(catalog: ProviderCatalog): Promise<ProviderModel[]> {
    const models: ProviderModel[] = [];
    for (const model of catalog.models) {
      await this.selectModel(model.id);
      const { thinkingOptions, thinkingOption } = toProviderConfigState(
        this.modes,
        this.configOptions,
      );
      models.push({
        ...model,
        thinkingOptions: [...thinkingOptions],
        defaultThinkingOptionId: thinkingOption,
      });
    }
    if (catalog.defaultModel) await this.selectModel(catalog.defaultModel);
    return models;
  }

  private async selectModel(model: string): Promise<void> {
    if (selectedValue(modelOption(this.configOptions)) === model) return;
    await this.applyNativeConfigChange({ target: "model", value: model });
  }

  async prompt(input: Extract<ProviderInput, { type: "session.prompt" }>): Promise<void> {
    if (this.closing || this.processFailed || this.deferredRetirement) {
      throw new Error("ACP session is closed");
    }
    if (input.prompt.delivery === "steer") {
      this.steerDeferredPrompt(input);
      return;
    }
    const active = this.activePrompt;
    if (active) {
      if (active.deferred && active.wirePromptsInFlight === 0) {
        // Wire session/prompt already resolved; finish the deferred turn without sending
        // session/cancel so running background tools stay alive into the follow-up turn.
        this.finishDeferredTurn(active, { type: "complete", terminalizeTools: false });
      } else {
        const retired = await this.interrupt();
        if (retired) {
          // Notify caller that the session closed before failing the replacement prompt.
          this.options.onRetired?.();
          throw new Error("ACP session retired after stopping deferred background work");
        }
      }
      await active.settled;
      if (this.closing || this.processFailed || this.deferredRetirement) {
        throw new Error("ACP session is closed");
      }
    }
    const prompt = toAcpPrompt(input.prompt);
    this.replayWindow = null;
    const turnId = `acp:${input.prompt.clientMessageId}`;
    this.fallbackChunkIds.clear();
    this.emit({
      type: "timeline.item",
      sessionId: this.options.boundarySessionId,
      item: {
        type: "user_message",
        id: input.prompt.clientMessageId,
        text: prompt
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n"),
        clientMessageId: input.prompt.clientMessageId,
      },
    });
    this.emit({
      type: "session.prompt_result",
      sessionId: this.options.boundarySessionId,
      clientMessageId: input.prompt.clientMessageId,
      result: { type: "turn", turnId },
    });
    this.emit({
      type: "session.turn",
      sessionId: this.options.boundarySessionId,
      turnId,
      state: "started",
    });
    const activePrompt: ActivePrompt = {
      turnId,
      settled: Promise.resolve(),
      cancelling: false,
      wirePromptsInFlight: 1,
      wirePromptLane: Promise.resolve(),
      lastPromptResponseWireSeq: null,
      crossedEndTurn: false,
      replyState: "idle",
      deferred: null,
    };
    // The SDK dispatches notifications without awaiting them, so the prompt response can resolve
    // while earlier session updates are still queued. Apply them before the turn ends.
    const settled = this.call(
      this.connection.prompt({ sessionId: this.nativeSessionId, prompt }),
    ).then(
      async (response): Promise<void> => {
        await this.drainNotifications();
        activePrompt.wirePromptsInFlight -= 1;
        if (response.usage) {
          this.lastUsage = {
            ...this.lastUsage,
            inputTokens: response.usage.inputTokens,
            outputTokens: response.usage.outputTokens,
            cachedInputTokens: response.usage.cachedReadTokens ?? undefined,
          };
          this.emit({
            type: "session.usage",
            sessionId: this.options.boundarySessionId,
            turnId,
            usage: this.lastUsage,
          });
        }
        const state = response.stopReason === "cancelled" ? "canceled" : "completed";
        if (response.stopReason === "end_turn" && this.shouldDeferTurn(activePrompt)) {
          await this.settleDeferredPrompt(activePrompt);
          return undefined;
        }
        this.finishPromptTurn(turnId, state);
        return undefined;
      },
      async (error): Promise<void> => {
        await this.drainNotifications();
        activePrompt.wirePromptsInFlight -= 1;
        this.finishPromptTurn(turnId, "failed", { message: describeError(error) });
        return undefined;
      },
    );
    activePrompt.settled = settled;
    this.activePrompt = activePrompt;
    void settled.finally(() => {
      if (this.activePrompt?.turnId === turnId) this.activePrompt = null;
    });
  }

  async interrupt(): Promise<boolean> {
    if (this.deferredRetirement) return this.deferredRetirement;
    const active = this.activePrompt;
    const deferredTurnId = active?.deferred ? active.turnId : null;
    if (active && deferredTurnId) {
      const retirement = this.retireDeferredTurn(active, deferredTurnId).catch((error) => {
        if (this.deferredRetirement === retirement) this.deferredRetirement = null;
        throw error;
      });
      this.deferredRetirement = retirement;
      return retirement;
    }
    if (active) active.cancelling = true;
    try {
      await this.call(this.connection.cancel({ sessionId: this.nativeSessionId }));
    } finally {
      // An agent may wait for its outstanding permission replies before ending the prompt.
      if (active) {
        this.finishTurnPermissions(active.turnId);
      }
    }
    return false;
  }

  private finalizeDeferredTurn(deferredTurnId: string, emitRetired: boolean): void {
    if (this.deferredFinalized) return;
    this.deferredFinalized = true;
    this.finishPromptTurn(deferredTurnId, "canceled", undefined, {
      suppressTrailingToolEcho: true,
    });
    if (emitRetired) this.options.onRetired?.();
  }

  private async retireDeferredTurn(active: ActivePrompt, deferredTurnId: string): Promise<boolean> {
    active.cancelling = true;
    // Record open tools owned by Stop before writing session/cancel so any failure
    // update arriving during cancel preserves their canceled state.
    for (const id of this.liveOpenToolIds) this.canceledToolCallIds.add(id);
    let cancelTimedOut = false;
    if (!this.closing) {
      try {
        await withTimeout(
          this.call(this.connection.cancel({ sessionId: this.nativeSessionId })),
          1_000,
          `ACP session ${this.nativeSessionId} did not accept cancel`,
        );
      } catch {
        cancelTimedOut = true;
      } finally {
        // An agent may wait for its outstanding permission replies before ending the prompt.
        this.finishTurnPermissions(active.turnId);
      }
    }
    // ACP v1 has no response or end boundary for session/cancel once session/prompt
    // already returned. Close the process first while the turn still appears running,
    // then emit the canceled turn synchronously before request.completed and session.closed
    // so queued work and config changes immediately observe the retired session.
    try {
      await this.close({ force: cancelTimedOut, timeoutMs: 1_000 });
    } catch (error) {
      void this.whenConnectorClosed()?.then(
        () => this.finalizeDeferredTurn(deferredTurnId, true),
        () => undefined,
      );
      throw error;
    }
    this.finalizeDeferredTurn(deferredTurnId, false);
    return true;
  }

  listSessions(cwd?: string) {
    return this.call(this.connection.listSessions({ cwd }));
  }

  async drainNotifications(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await this.notificationLane;
  }

  respondToPermission(
    permissionId: string,
    response: Extract<ProviderInput, { type: "session.permission" }>["response"],
  ): void {
    const pending = this.permissions.get(permissionId);
    if (!pending) return;
    const active = this.activePrompt;
    if (active?.cancelling && pending.turnId === active.turnId) return;
    const selected = selectPermissionOption(pending.request.options, response);
    if (response.selectedActionId !== undefined && !selected) {
      throw new Error(
        `ACP permission action '${response.selectedActionId}' does not exist or does not match '${response.behavior}' behavior`,
      );
    }
    this.resolvePermission(permissionId, pending, {
      outcome: selected
        ? { outcome: "selected", optionId: selected.optionId }
        : { outcome: "cancelled" },
    });
  }

  private finishTurnPermissions(turnId: string): void {
    for (const [permissionId, pending] of this.permissions) {
      if (pending.turnId === turnId) {
        this.resolvePermission(permissionId, pending, { outcome: { outcome: "cancelled" } });
      }
    }
  }

  private resolvePermission(
    permissionId: string,
    pending: PendingPermission,
    response: RequestPermissionResponse,
  ): void {
    this.permissions.delete(permissionId);
    pending.resolve(response);
    this.emit({
      type: "session.permission_resolved",
      sessionId: this.options.boundarySessionId,
      permissionId,
    });
    if (this.activePrompt?.deferred) this.scheduleDeferredSettle();
  }

  async configure(
    changes: Extract<ProviderInput, { type: "session.configure" }>["changes"],
  ): Promise<void> {
    const autoAcceptMode = this.options.options.acpOptions?.autoAcceptMode;
    if (
      autoAcceptMode &&
      changes.mode !== undefined &&
      (changes.mode === autoAcceptMode.mode.id) !== this.autoAccept &&
      (this.activePrompt || this.permissions.size > 0)
    ) {
      throw new Error(
        `Finish or stop the current turn before switching to or from ${autoAcceptMode.mode.label}.`,
      );
    }
    const requested: AcpConfigChange[] = [];
    if (changes.model !== undefined) requested.push({ target: "model", value: changes.model });
    if (changes.mode !== undefined) requested.push({ target: "mode", value: changes.mode });
    if (changes.thinkingOption !== undefined) {
      requested.push({ target: "thinking", value: changes.thinkingOption });
    }
    for (const [id, value] of Object.entries(changes.settings ?? {})) {
      requested.push({ target: "setting", id, value });
    }
    const ordered = this.inAgentOrder(requested);
    const previousAutoAccept = this.autoAccept;
    const previousModes = this.modes ? structuredClone(this.modes) : null;
    const previousOptions = structuredClone(this.configOptions);
    this.configTransaction = true;
    this.stagedTransformerConfig = null;
    let committedConfig: ProviderConfigState | null = null;
    try {
      for (const change of ordered) await this.applyConfigChange(change);
      committedConfig =
        this.stagedTransformerConfig ?? toProviderConfigState(this.modes, this.configOptions);
    } catch (error) {
      try {
        await this.restoreConfig(previousModes, previousOptions);
      } catch (rollbackError) {
        const failure = new AggregateError(
          [error, rollbackError],
          `ACP configuration failed and rollback could not restore the previous state`,
        );
        this.emit({
          type: "session.runtime_failed",
          sessionId: this.options.boundarySessionId,
          error: { message: describeError(failure) },
        });
        await this.close();
        throw failure;
      }
      this.autoAccept = previousAutoAccept;
      this.modes = previousModes;
      this.configOptions = previousOptions;
      this.stagedTransformerConfig = null;
      throw error;
    } finally {
      this.configTransaction = false;
    }
    this.stagedTransformerConfig = null;
    this.emitConfigSnapshot(committedConfig);
  }

  async closeSession(): Promise<void> {
    if (this.nativeSessionId) {
      await withTimeout(
        this.call(this.connection.closeSession({ sessionId: this.nativeSessionId })),
        1_000,
        `ACP session ${this.nativeSessionId} did not close`,
      ).catch(() => undefined);
    }
    await this.close();
  }

  close(options?: { force?: boolean; timeoutMs?: number }): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    const promise = this.closeInternal(options).catch((error) => {
      if (this.closePromise === promise) this.closePromise = null;
      throw error;
    });
    this.closePromise = promise;
    return promise;
  }

  private async closeInternal(options?: { force?: boolean; timeoutMs?: number }): Promise<void> {
    this.settlePendingWork();
    await this.closeConnector(options);
    const child = this.child;
    if (!child || this.processFailed) return;
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    await terminateProcess(child, "SIGTERM");
    if (await settlesWithin(closed, 1_000)) return;
    await terminateProcess(child);
    if (!(await settlesWithin(closed, 1_000))) {
      throw new Error(`ACP provider ${this.options.options.id} did not terminate after SIGKILL`);
    }
  }

  private async applyInitialConfig(config: ProviderSessionConfig): Promise<void> {
    const requested: AcpConfigChange[] = [];
    if (config.model) requested.push({ target: "model", value: config.model });
    const autoAcceptMode = this.options.options.acpOptions?.autoAcceptMode;
    const mode = config.mode ?? (autoAcceptMode?.default ? autoAcceptMode.mode.id : undefined);
    if (mode) requested.push({ target: "mode", value: mode });
    if (config.thinkingOption) {
      requested.push({ target: "thinking", value: config.thinkingOption });
    }
    for (const [id, value] of Object.entries(config.settings)) {
      requested.push({ target: "setting", id, value });
    }
    for (const change of this.inAgentOrder(requested)) await this.applyConfigChange(change);
  }

  // One option can reset another: choosing an fx provider also selects that provider's saved
  // model, so a model applied first would be lost. Agents list the option that decides first.
  private inAgentOrder(changes: readonly AcpConfigChange[]): AcpConfigChange[] {
    const position = (change: AcpConfigChange): number => {
      const configId = this.configIdFor(change);
      const index = this.configOptions.findIndex((option) => option.id === configId);
      return index === -1 ? this.configOptions.length : index;
    };
    return changes.toSorted((left, right) => position(left) - position(right));
  }

  private configIdFor(change: AcpConfigChange): string | undefined {
    if (change.target === "setting") return change.id;
    if (change.target === "model") return modelOption(this.configOptions)?.id;
    if (change.target === "thinking") {
      return this.configOptions.find((option) => option.category === "thought_level")?.id;
    }
    return modeOption(this.configOptions)?.id;
  }

  private async applyConfigChange(change: AcpConfigChange): Promise<void> {
    const autoAcceptMode = this.options.options.acpOptions?.autoAcceptMode;
    if (
      change.target === "mode" &&
      autoAcceptMode &&
      (this.autoAccept || change.value === autoAcceptMode.mode.id)
    ) {
      const enableAutoAccept = change.value === autoAcceptMode.mode.id;
      const nativeMode = enableAutoAccept ? autoAcceptMode.nativeMode : change.value;
      this.autoAccept = false;
      if (nativeMode !== this.nativeModeId()) {
        await this.applyNativeConfigChange({ target: "mode", value: nativeMode });
      }
      if (nativeMode !== this.nativeModeId()) {
        throw new Error(`ACP agent did not switch to mode '${nativeMode}'`);
      }
      this.autoAccept = enableAutoAccept;
      return;
    }
    const context: AcpConfigureContext = {
      ...this.configContext(),
      catalog: () => toProviderCatalog(this.modes, this.configOptions),
      apply: (nativeChange) => this.applyNativeConfigChange(nativeChange),
    };
    for (const transformer of this.transformers) {
      if ((await transformer.configure?.(change, context)) === "handled") {
        return;
      }
    }
    await this.applyNativeConfigChange(change);
  }

  private async applyNativeConfigChange(change: AcpConfigChange): Promise<void> {
    if (change.target === "mode" && this.modes && !modeOption(this.configOptions)) {
      if (!change.value) {
        throw new Error("ACP session does not expose mode configuration");
      }
      await this.call(
        this.connection.setSessionMode({
          sessionId: this.nativeSessionId,
          modeId: change.value,
        }),
      );
      this.modes = { ...this.modes, currentModeId: change.value };
      return;
    }
    const configId = this.configIdFor(change);
    if (!configId) {
      throw new Error(`ACP session does not expose ${change.target} configuration`);
    }
    if (change.value === null) {
      throw new Error(`ACP configuration ${configId} cannot be cleared`);
    }
    const response = await this.call(
      this.connection.setSessionConfigOption({
        sessionId: this.nativeSessionId,
        configId,
        ...(typeof change.value === "boolean"
          ? { type: "boolean" as const, value: change.value }
          : { value: String(change.value) }),
      }),
    );
    this.configOptions = response.configOptions;
  }

  configContext() {
    return {
      sessionId: this.options.boundarySessionId,
      config: this.configAccess(),
      request: this.request,
    };
  }

  private readonly request: AcpRequest = async (method, params) =>
    jsonValue(
      await this.call(this.connection.extMethod(method, params as Record<string, unknown>)),
    );

  private configAccess(): AcpConfigAccess {
    return {
      read: async () => configValues(this.configOptions),
      set: async (id, value) => {
        if (typeof value !== "string" && typeof value !== "boolean") {
          throw new Error(`ACP configuration ${id} accepts only string or boolean values`);
        }
        const response = await this.call(
          this.connection.setSessionConfigOption({
            sessionId: this.nativeSessionId,
            configId: id,
            ...(typeof value === "boolean" ? { type: "boolean" as const, value } : { value }),
          }),
        );
        this.configOptions = response.configOptions;
      },
    };
  }

  private emitConfig(): void {
    if (this.configTransaction) return;
    this.emitConfigSnapshot(toProviderConfigState(this.modes, this.configOptions));
  }

  private nativeModeId(): string | undefined {
    return selectedValue(modeOption(this.configOptions)) ?? this.modes?.currentModeId;
  }

  private emitConfigSnapshot(config: ProviderConfigState): void {
    const autoAcceptMode = this.options.options.acpOptions?.autoAcceptMode;
    if (autoAcceptMode) {
      if (this.nativeModeId() !== autoAcceptMode.nativeMode) this.autoAccept = false;
      config = {
        ...config,
        mode: this.autoAccept ? autoAcceptMode.mode.id : config.mode,
        modes: [...config.modes, { ...autoAcceptMode.mode, isUnattended: true }],
      };
    }
    const context = { sessionId: this.options.boundarySessionId };
    for (const transformer of this.transformers) {
      config = transformer.config?.(config, context) ?? config;
    }
    this.emit({
      type: "session.config",
      sessionId: this.options.boundarySessionId,
      config,
    });
  }

  private async restoreConfig(
    modes: NewSessionResponse["modes"],
    options: readonly SessionConfigOption[],
  ): Promise<void> {
    if (
      !modeOption(options) &&
      modes?.currentModeId &&
      this.modes?.currentModeId !== modes.currentModeId
    ) {
      await this.call(
        this.connection.setSessionMode({
          sessionId: this.nativeSessionId,
          modeId: modes.currentModeId,
        }),
      );
    }
    const currentValues = configValues(this.configOptions);
    for (const option of options) {
      const value = option.currentValue;
      if (currentValues[option.id] === value) continue;
      await this.call(
        this.connection.setSessionConfigOption({
          sessionId: this.nativeSessionId,
          configId: option.id,
          ...(typeof value === "boolean" ? { type: "boolean" as const, value } : { value }),
        }),
      );
    }
  }

  private async requestPermission(
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    await this.notificationLane;
    if (this.closing || this.processFailed || this.activePrompt?.cancelling) {
      return { outcome: { outcome: "cancelled" } };
    }
    if (
      this.autoAccept &&
      request.sessionId === this.nativeSessionId &&
      this.nativeModeId() === this.options.options.acpOptions?.autoAcceptMode?.nativeMode
    ) {
      const allowOptions = request.options.filter((option) => option.kind.startsWith("allow"));
      const allowOnce = allowOptions.find((option) => option.kind === "allow_once");
      if (
        allowOnce &&
        new Set(allowOptions.map((option) => option.kind)).size === allowOptions.length
      ) {
        return { outcome: { outcome: "selected", optionId: allowOnce.optionId } };
      }
    }
    const permissionId = `permission:${request.toolCall.toolCallId}`;
    return new Promise((resolve) => {
      this.permissions.set(permissionId, { request, resolve, turnId: this.activePrompt?.turnId });
      if (this.activePrompt?.deferred) this.scheduleDeferredSettle();
      this.emit({
        type: "session.permission",
        sessionId: this.options.boundarySessionId,
        request: {
          id: permissionId,
          name: request.toolCall.name ?? request.toolCall.title ?? "Tool",
          kind: "tool",
          title: request.toolCall.title ?? undefined,
          input: jsonRecord(request.toolCall.rawInput),
          actions: request.options.map((option) => ({
            id: option.optionId,
            label: option.name,
            behavior: option.kind.startsWith("allow") ? "allow" : "deny",
          })),
        },
      });
    });
  }

  private observeWireMessage(message: unknown): void {
    if (typeof message !== "object" || message === null) return;
    const record = message as Record<string, unknown>;
    if (record.method === "session/update") {
      this.sessionUpdateWireSeqs.push(++this.incomingWireSeq);
      return;
    }
    if (
      !("method" in record) &&
      "id" in record &&
      typeof record.result === "object" &&
      record.result !== null &&
      typeof (record.result as Record<string, unknown>).stopReason === "string" &&
      this.activePrompt &&
      this.activePrompt.lastPromptResponseWireSeq === null
    ) {
      this.activePrompt.lastPromptResponseWireSeq = ++this.incomingWireSeq;
    }
  }

  private isPostWirePrompt(active: ActivePrompt, wireSeq: number): boolean {
    return active.lastPromptResponseWireSeq !== null && wireSeq > active.lastPromptResponseWireSeq;
  }

  private sessionUpdate(notification: SessionNotification, wireSeq: number): void {
    if (notification.sessionId !== this.nativeSessionId) return;
    if (this.replayWindow && isReplayHistoryUpdate(notification.update)) {
      this.lastLoadHistoryAt = performance.now();
    }
    if (this.replayWindow === "skip") {
      if (isSessionStateUpdate(notification.update)) {
        this.reduceStateUpdate(notification.update, wireSeq);
      }
      return;
    }
    if (
      this.replayWindow === "replay" &&
      notification.update.sessionUpdate === "user_message_chunk"
    ) {
      this.reduceUserMessageChunk(notification.update);
      return;
    }
    this.reduceUpdate(notification.update, wireSeq);
  }

  private reduceUpdate(update: SessionUpdate, wireSeq: number): void {
    if (
      update.sessionUpdate === "agent_message_chunk" ||
      update.sessionUpdate === "agent_thought_chunk" ||
      update.sessionUpdate === "user_message_chunk"
    ) {
      if (update.sessionUpdate === "user_message_chunk") {
        this.fallbackChunkIds.clear();
        return;
      }
      // A chunk of one kind ends every other kind's open item, whatever its
      // content or id: reasoning, then text, then reasoning again are three items.
      this.fallbackChunkIds.delete(
        update.sessionUpdate === "agent_message_chunk"
          ? "agent_thought_chunk"
          : "agent_message_chunk",
      );
      this.fallbackChunkIds.delete("user_message_chunk");
      if (update.content.type !== "text") return;
      const id = this.resolveChunkId(update.sessionUpdate, update.messageId);
      const text = `${this.messages.get(id) ?? ""}${update.content.text}`;
      this.messages.set(id, text);
      this.emit({
        type: "timeline.item",
        sessionId: this.options.boundarySessionId,
        item: {
          type: update.sessionUpdate === "agent_message_chunk" ? "assistant_message" : "reasoning",
          id,
          text,
          ...(update.sessionUpdate === "agent_message_chunk"
            ? { messageId: update.messageId ?? undefined }
            : {}),
        },
      });
      this.noteDeferredChunk(update.sessionUpdate, wireSeq);
      return;
    }
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      if (update.sessionUpdate === "tool_call") this.fallbackChunkIds.clear();
      this.reduceToolCall(update, wireSeq);
      return;
    }
    if (update.sessionUpdate === "plan") this.fallbackChunkIds.clear();
    this.reduceStateUpdate(update, wireSeq);
  }

  // Historical user messages arrive only as replayed chunks; a live prompt
  // already echoes its own user message when it is admitted.
  private reduceUserMessageChunk(
    update: Extract<SessionUpdate, { sessionUpdate: "user_message_chunk" }>,
  ): void {
    this.fallbackChunkIds.delete("agent_message_chunk");
    this.fallbackChunkIds.delete("agent_thought_chunk");
    if (update.content.type !== "text") return;
    const id = this.resolveChunkId("user_message_chunk", update.messageId);
    const text = `${this.messages.get(id) ?? ""}${update.content.text}`;
    this.messages.set(id, text);
    this.emit({
      type: "timeline.item",
      sessionId: this.options.boundarySessionId,
      item: {
        type: "user_message",
        id,
        text,
        ...(update.messageId ? { messageId: update.messageId } : {}),
      },
    });
  }

  private resolveChunkId(
    kind: "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk",
    messageId: string | null | undefined,
  ): string {
    if (messageId) {
      this.fallbackChunkIds.delete(kind);
      // Native IDs identify a message within its chunk kind. Timeline IDs must
      // also distinguish reasoning from replies and from generated fallback IDs.
      return JSON.stringify([kind, messageId]);
    }
    let id = this.fallbackChunkIds.get(kind);
    if (!id) {
      id = `${kind}:${++this.messageSequence}`;
      this.fallbackChunkIds.set(kind, id);
    }
    return id;
  }

  private reduceStateUpdate(update: SessionUpdate, wireSeq: number): void {
    if (update.sessionUpdate === "plan") {
      this.emit({
        type: "timeline.item",
        sessionId: this.options.boundarySessionId,
        item: {
          type: "todo",
          id: "acp-plan",
          items: update.entries.map((entry, index) => ({
            id: String(index),
            text: entry.content,
            completed: entry.status === "completed",
            status: entry.status,
          })),
        },
      });
      return;
    }
    if (update.sessionUpdate === "available_commands_update") {
      const context = { sessionId: this.options.boundarySessionId };
      const commands = update.availableCommands.map((command) => {
        let entry: ProviderCommand = {
          name: command.name,
          description: command.description,
          argumentHint: command.input?.hint,
        };
        for (const transformer of this.transformers) {
          entry = transformer.command?.(entry, context) ?? entry;
        }
        return entry;
      });
      this.emit({ type: "session.commands", sessionId: this.options.boundarySessionId, commands });
      this.receivedInitialCommands = true;
      this.commandWaiter?.();
      return;
    }
    if (update.sessionUpdate === "current_mode_update") {
      const option = modeOption(this.configOptions);
      if (option?.type === "select") {
        this.configOptions = this.configOptions.map((candidate) =>
          candidate === option ? { ...option, currentValue: update.currentModeId } : candidate,
        );
      }
      if (this.modes) this.modes = { ...this.modes, currentModeId: update.currentModeId };
      this.emitConfig();
      return;
    }
    if (update.sessionUpdate === "config_option_update") {
      this.configOptions = update.configOptions;
      this.emitConfig();
      return;
    }
    if (update.sessionUpdate === "usage_update") {
      this.lastUsage = {
        ...this.lastUsage,
        contextWindowUsedTokens: update.used,
        contextWindowMaxTokens: update.size,
        totalCostUsd: update.cost?.currency === "USD" ? update.cost.amount : undefined,
      };
      this.emit({
        type: "session.usage",
        sessionId: this.options.boundarySessionId,
        usage: this.lastUsage,
      });
      this.noteDeferredUsageUpdate(wireSeq);
      return;
    }
    if (update.sessionUpdate === "compaction_update") {
      if (update.status === "completed") this.pendingCompactions.delete(update.compactionId);
      else this.pendingCompactions.add(update.compactionId);
      this.emit({
        type: "timeline.item",
        sessionId: this.options.boundarySessionId,
        item: {
          type: "compaction",
          id: update.compactionId,
          status: update.status === "completed" ? "completed" : "loading",
        },
      });
      if (this.activePrompt?.deferred) this.scheduleDeferredSettle();
    }
  }

  private terminalizeTransientItems(
    state: "completed" | "failed" | "canceled",
    options?: { preserveQualifyingOpenTools?: boolean; suppressTrailingToolEcho?: boolean },
  ): void {
    const preserve = options?.preserveQualifyingOpenTools === true;
    for (const [id, tool] of this.toolCalls) {
      const snapshot = tool.presentation;
      if (snapshot.status !== "pending" && snapshot.status !== "in_progress") continue;
      if (preserve && this.liveOpenToolIds.has(id) && this.toolKeepsTurnOpen(snapshot)) continue;
      this.liveOpenToolIds.delete(id);
      if (options?.suppressTrailingToolEcho) this.canceledToolCallIds.add(id);
      const completed: AcpToolCallSnapshot = {
        ...snapshot,
        status: state === "completed" ? "completed" : "failed",
      };
      this.toolCalls.set(id, {
        source: { ...tool.source, status: completed.status },
        presentation: completed,
      });
      this.emit({
        type: "timeline.item",
        sessionId: this.options.boundarySessionId,
        item: terminalToolItem(toolTimelineItem(snapshot), state),
      });
    }
    for (const item of this.vendorToolCalls.values()) {
      this.emit({
        type: "timeline.item",
        sessionId: this.options.boundarySessionId,
        item: terminalToolItem(item, state),
      });
    }
    this.vendorToolCalls.clear();
    for (const id of this.pendingCompactions) {
      this.emit({
        type: "timeline.item",
        sessionId: this.options.boundarySessionId,
        item: { type: "compaction", id, status: "completed" },
      });
    }
    this.pendingCompactions.clear();
  }

  private reduceToolCall(
    update: Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>,
    wireSeq: number,
  ): void {
    if (
      update.sessionUpdate === "tool_call_update" &&
      this.canceledToolCallIds.has(update.toolCallId)
    ) {
      return;
    }
    if (update.sessionUpdate === "tool_call") {
      this.canceledToolCallIds.delete(update.toolCallId);
    }
    const tool = this.toolCalls.get(update.toolCallId);
    const current = tool?.presentation;
    const wasOpenQualifying =
      current !== undefined &&
      this.liveOpenToolIds.has(current.id) &&
      this.toolKeepsTurnOpen(current);
    const source = mergeToolCallSnapshot(update, tool?.source);
    let snapshot: AcpToolCallSnapshot = source;
    const context = {
      sessionId: this.options.boundarySessionId,
      mcpServerNames: this.mcpServerNames,
    };
    for (const transformer of this.transformers)
      snapshot = transformer.toolCall?.(snapshot, context) ?? snapshot;
    if (!snapshot.detail && source.diff && snapshot.kind === "edit") {
      snapshot = {
        ...snapshot,
        detail: {
          type: "edit",
          filePath: source.diff.path,
          oldString: source.diff.oldText ?? undefined,
          newString: source.diff.newText,
        },
      };
    }
    this.toolCalls.set(snapshot.id, { source, presentation: snapshot });
    const isOpen = snapshot.status === "pending" || snapshot.status === "in_progress";
    if (this.replayWindow === null) {
      if (isOpen) this.liveOpenToolIds.add(snapshot.id);
      else this.liveOpenToolIds.delete(snapshot.id);
    }
    this.emit({
      type: "timeline.item",
      sessionId: this.options.boundarySessionId,
      item: toolTimelineItem(snapshot),
    });
    const isOpenQualifying =
      this.liveOpenToolIds.has(snapshot.id) && this.toolKeepsTurnOpen(snapshot);
    this.noteDeferredToolTransition(wasOpenQualifying, isOpenQualifying, isOpen, snapshot, wireSeq);
  }

  private vendorNotification(method: string, params: unknown): void {
    const notification = { method, params: jsonValue(params) };
    const context = { sessionId: this.options.boundarySessionId };
    for (const transformer of this.transformers) {
      const transformed = transformer.notification?.(notification, context);
      if (!transformed) continue;
      const updates = Array.isArray(transformed) ? transformed : [transformed];
      for (const update of updates) this.emitVendorUpdate(update);
    }
  }

  private emitVendorUpdate(update: AcpVendorUpdate): void {
    if (update.type === "commands") {
      this.emit({
        type: "session.commands",
        sessionId: this.options.boundarySessionId,
        commands: [...update.commands],
      });
    } else if (update.type === "config") {
      if (this.configTransaction) this.stagedTransformerConfig = update.config;
      else this.emitConfigSnapshot(update.config);
    } else if (update.type === "timeline") {
      if (update.item.type === "tool_call") {
        if (update.item.status === "running") this.vendorToolCalls.set(update.item.id, update.item);
        else this.vendorToolCalls.delete(update.item.id);
      }
      this.emit({
        type: "timeline.item",
        sessionId: this.options.boundarySessionId,
        item: update.item,
      });
    } else {
      this.emit({
        type: "session.notice",
        sessionId: this.options.boundarySessionId,
        notice: update.notice,
      });
    }
  }

  private call<Value>(operation: Promise<Value>): Promise<Value> {
    if (this.connection.signal.aborted) {
      return Promise.reject(new Error("ACP transport is closed"));
    }
    return Promise.race([
      operation,
      this.connection.closed.then(() => {
        throw new Error("ACP transport closed unexpectedly");
      }),
    ]);
  }

  private enqueueNotification(operation: () => void): Promise<void> {
    const result = this.notificationLane.then(operation);
    this.notificationLane = result.catch(() => undefined);
    return result;
  }

  private handleUnexpectedTransportClose(): void {
    if (this.closing || this.processFailed) return;
    const message = "ACP transport closed unexpectedly";
    this.processFailed = true;
    this.processFailureMessage = message;
    this.settlePendingWork(message);
    if (!this.nativeSessionId) return;
    this.emit({
      type: "session.runtime_failed",
      sessionId: this.options.boundarySessionId,
      error: { message },
    });
  }

  private settlePendingWork(failureMessage?: string): void {
    for (const permission of this.permissions.values()) {
      permission.resolve({ outcome: { outcome: "cancelled" } });
    }
    this.permissions.clear();
    if (this.activePrompt?.deferred) {
      this.finishDeferredTurn(
        this.activePrompt,
        failureMessage ? { type: "fail", error: { message: failureMessage } } : { type: "cancel" },
      );
    }
    this.commandWaiter?.();
    this.commandWaiter = null;
  }

  private finishPromptTurn(
    turnId: string,
    state: "completed" | "failed" | "canceled",
    error?: { message: string },
    options?: { preserveQualifyingOpenTools?: boolean; suppressTrailingToolEcho?: boolean },
  ): void {
    this.fallbackChunkIds.clear();
    this.terminalizeTransientItems(state, options);
    this.finishTurnPermissions(turnId);
    if (state === "failed") {
      this.emit({
        type: "session.turn",
        sessionId: this.options.boundarySessionId,
        turnId,
        state,
        error: error ?? { message: "ACP turn failed" },
      });
      return;
    }
    this.emit({
      type: "session.turn",
      sessionId: this.options.boundarySessionId,
      turnId,
      state,
    });
  }

  private steerDeferredPrompt(input: Extract<ProviderInput, { type: "session.prompt" }>): void {
    const active = this.activePrompt;
    const deferred = active?.deferred;
    if (!active || !deferred || active.cancelling || this.closing || this.processFailed) {
      this.emit({
        type: "session.prompt_result",
        sessionId: this.options.boundarySessionId,
        clientMessageId: input.prompt.clientMessageId,
        result: {
          type: "failed",
          error: {
            message: "ACP session can only steer while waiting on deferred background tools",
          },
        },
      });
      return;
    }
    if (input.prompt.clearPendingPermissions) {
      this.finishTurnPermissions(active.turnId);
    }
    const prompt = toAcpPrompt(input.prompt);
    active.wirePromptsInFlight += 1;
    this.scheduleDeferredSettle();
    this.replayWindow = null;
    this.fallbackChunkIds.clear();
    this.emit({
      type: "timeline.item",
      sessionId: this.options.boundarySessionId,
      item: {
        type: "user_message",
        id: input.prompt.clientMessageId,
        text: prompt
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n"),
        clientMessageId: input.prompt.clientMessageId,
      },
    });
    this.emit({
      type: "session.prompt_result",
      sessionId: this.options.boundarySessionId,
      clientMessageId: input.prompt.clientMessageId,
      result: { type: "steer", turnId: active.turnId },
    });
    const runSteer = async (): Promise<void> => {
      try {
        if (
          this.closing ||
          this.processFailed ||
          active.cancelling ||
          active.deferred !== deferred
        ) {
          return;
        }
        this.fallbackChunkIds.clear();
        active.lastPromptResponseWireSeq = null;
        if (active.replyState === "settled_with_open_tools") active.replyState = "idle";
        const response = await this.call(
          this.connection.prompt({ sessionId: this.nativeSessionId, prompt }),
        );
        await this.drainNotifications();
        if (this.closing || this.deferredRetirement || active.deferred !== deferred) return;
        if (response.usage) {
          this.lastUsage = {
            ...this.lastUsage,
            inputTokens: response.usage.inputTokens,
            outputTokens: response.usage.outputTokens,
            cachedInputTokens: response.usage.cachedReadTokens ?? undefined,
          };
          this.emit({
            type: "session.usage",
            sessionId: this.options.boundarySessionId,
            turnId: active.turnId,
            usage: this.lastUsage,
          });
        }
        if (response.stopReason === "cancelled") {
          this.finishDeferredTurn(active, { type: "cancel" });
          return;
        }
        if (response.stopReason !== "end_turn" && active.wirePromptsInFlight === 1) {
          this.finishDeferredTurn(active, { type: "complete", terminalizeTools: true });
        }
      } catch (error) {
        await this.drainNotifications();
        if (this.closing || this.deferredRetirement || active.deferred !== deferred) return;
        if (this.processFailed) {
          this.finishDeferredTurn(active, {
            type: "fail",
            error: { message: describeError(error) },
          });
        } else {
          this.emit({
            type: "session.notice",
            sessionId: this.options.boundarySessionId,
            notice: {
              id: `acp:steer-error:${input.prompt.clientMessageId}`,
              severity: "error",
              title: "Follow-up prompt failed",
              description: describeError(error),
            },
          });
        }
      } finally {
        if (active.lastPromptResponseWireSeq === null) {
          active.lastPromptResponseWireSeq = this.incomingWireSeq;
        }
        active.wirePromptsInFlight -= 1;
        this.scheduleDeferredSettle();
      }
    };
    active.wirePromptLane = active.wirePromptLane.then(runSteer);
  }

  private async settleDeferredPrompt(active: ActivePrompt): Promise<void> {
    this.fallbackChunkIds.clear();
    const outcome = await new Promise<DeferredTurnOutcome>((resolve) => {
      active.deferred = { timer: null, resolve };
      this.scheduleDeferredSettle();
    });
    if (this.closing || this.deferredRetirement) return;
    if (outcome.type === "fail") {
      this.finishPromptTurn(active.turnId, "failed", outcome.error);
      return;
    }
    this.finishPromptTurn(
      active.turnId,
      outcome.type === "cancel" ? "canceled" : "completed",
      undefined,
      {
        preserveQualifyingOpenTools: outcome.type === "complete" && !outcome.terminalizeTools,
        suppressTrailingToolEcho: outcome.type === "cancel",
      },
    );
  }

  private toolKeepsTurnOpen(snapshot: AcpToolCallSnapshot): boolean {
    const defer = this.options.options.acpOptions?.deferTurnOnRunningTools;
    if (!defer) return false;
    return defer.keepsTurnOpen ? defer.keepsTurnOpen(snapshot) : true;
  }

  private hasQualifyingOpenTools(): boolean {
    for (const id of this.liveOpenToolIds) {
      const snapshot = this.toolCalls.get(id)?.presentation;
      if (snapshot && this.toolKeepsTurnOpen(snapshot)) return true;
    }
    return false;
  }

  private hasDeferredBlockers(): boolean {
    return (
      (this.activePrompt?.wirePromptsInFlight ?? 0) > 0 ||
      this.hasQualifyingOpenTools() ||
      this.permissions.size > 0 ||
      this.pendingCompactions.size > 0
    );
  }

  private shouldDeferTurn(active: ActivePrompt): boolean {
    if (!this.options.options.acpOptions?.deferTurnOnRunningTools) return false;
    if (active.cancelling || this.closing || this.processFailed) return false;
    return this.hasQualifyingOpenTools() || active.crossedEndTurn;
  }

  private finishDeferredTurn(active: ActivePrompt, outcome: DeferredTurnOutcome): void {
    const deferred = active.deferred;
    if (!deferred) return;
    if (deferred.timer) clearTimeout(deferred.timer);
    active.deferred = null;
    deferred.resolve(outcome);
  }

  private noteDeferredToolTransition(
    wasOpenQualifying: boolean,
    isOpenQualifying: boolean,
    isOpen: boolean,
    snapshot: AcpToolCallSnapshot,
    wireSeq: number,
  ): void {
    const active = this.activePrompt;
    if (!active || wasOpenQualifying === isOpenQualifying) return;
    if (!active.deferred && !this.isPostWirePrompt(active, wireSeq)) return;
    if (!active.deferred && wasOpenQualifying && !isOpen && this.toolKeepsTurnOpen(snapshot)) {
      active.crossedEndTurn = true;
    }
    if (isOpenQualifying) active.replyState = "idle";
    if (active.deferred) this.scheduleDeferredSettle();
  }

  private noteDeferredChunk(
    kind: "agent_message_chunk" | "agent_thought_chunk",
    wireSeq: number,
  ): void {
    const active = this.activePrompt;
    if (!active || !this.isPostWirePrompt(active, wireSeq)) return;
    if (kind === "agent_message_chunk") active.replyState = "open";
    else if (active.replyState !== "open") active.replyState = "idle";
    if (active.deferred) this.scheduleDeferredSettle();
  }

  private noteDeferredUsageUpdate(wireSeq: number): void {
    const active = this.activePrompt;
    if (!active || !this.isPostWirePrompt(active, wireSeq) || active.replyState !== "open") return;
    active.replyState = this.hasQualifyingOpenTools() ? "settled_with_open_tools" : "settled";
    if (active.deferred) this.scheduleDeferredSettle();
  }

  private scheduleDeferredSettle(): void {
    const active = this.activePrompt;
    const deferred = active?.deferred;
    const config = this.options.options.acpOptions?.deferTurnOnRunningTools;
    if (!active || !deferred || !config || active.cancelling) return;
    if (deferred.timer) {
      clearTimeout(deferred.timer);
      deferred.timer = null;
    }
    if (this.hasDeferredBlockers()) return;
    const settled =
      active.replyState === "settled" || active.replyState === "settled_with_open_tools";
    const delayMs = settled
      ? (config.settleDelayMs ?? DEFAULT_DEFERRED_SETTLE_DELAY_MS)
      : (config.quietLimitMs ?? DEFAULT_DEFERRED_QUIET_LIMIT_MS);
    deferred.timer = setTimeout(() => {
      deferred.timer = null;
      void this.trySettleDeferredTurn(active, deferred);
    }, delayMs);
  }

  private async trySettleDeferredTurn(
    active: ActivePrompt,
    deferred: DeferredTurnState,
  ): Promise<void> {
    await this.drainNotifications();
    if (
      this.closing ||
      this.processFailed ||
      active.cancelling ||
      active.deferred !== deferred ||
      deferred.timer !== null ||
      this.hasDeferredBlockers()
    ) {
      return;
    }
    this.finishDeferredTurn(active, { type: "complete", terminalizeTools: true });
  }

  private waitForInitialCommands(): Promise<void> {
    if (this.receivedInitialCommands) return Promise.resolve();
    const timeoutMs = this.options.options.acpOptions?.initialCommandsTimeoutMs ?? 1_000;
    const commands = new Promise<void>((resolve) => {
      this.commandWaiter = resolve;
    });
    return withTimeout(commands, timeoutMs, "ACP agent did not publish initial commands")
      .catch(() => undefined)
      .finally(() => {
        this.commandWaiter = null;
      });
  }

  private notePartialWireRead(): void {
    if (this.replayWindow) this.lastPartialWireAt = performance.now();
  }

  // An agent that streams history after its session/load response sends no end marker,
  // so the history ends once a quiet period passes without a history update.
  private async waitForLoadReplay(
    quietPeriod: number,
    isConnectionClosed: () => boolean,
  ): Promise<void> {
    const start = performance.now();
    while (!this.closing && !this.processFailed && !isConnectionClosed()) {
      const lastActivityAt = Math.max(start, this.lastLoadHistoryAt, this.lastPartialWireAt);
      const remaining = lastActivityAt + quietPeriod - performance.now();
      // A stalled event loop reaches the quiet period with history still unread in the pipe.
      // setImmediate lets the loop read pending input once before the silence is trusted.
      await new Promise<void>((resolve) => {
        if (remaining > 0) setTimeout(resolve, remaining);
        else setImmediate(resolve);
      });
      await this.notificationLane;
      if (
        remaining <= 0 &&
        Math.max(start, this.lastLoadHistoryAt, this.lastPartialWireAt) === lastActivityAt
      ) {
        return;
      }
    }
  }
}

function observePartialWireReads(
  input: ReadableStream<Uint8Array>,
  onPartialRead: () => void,
): ReadableStream<Uint8Array> {
  let incompleteLine = false;
  return input.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const wasIncomplete = incompleteLine;
        incompleteLine = hasTrailingIncompleteLine(chunk, incompleteLine);
        if (wasIncomplete || incompleteLine) onPartialRead();
        controller.enqueue(chunk);
      },
    }),
  );
}

function hasTrailingIncompleteLine(chunk: Uint8Array, incompleteLine: boolean): boolean {
  const newline = chunk.lastIndexOf(0x0a);
  const start = newline === -1 ? 0 : newline + 1;
  if (newline !== -1) incompleteLine = false;
  for (let index = start; index < chunk.length; index += 1) {
    const byte = chunk[index];
    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0d) return true;
  }
  return incompleteLine;
}

function isReplayHistoryUpdate(update: SessionUpdate): boolean {
  return (
    update.sessionUpdate === "user_message_chunk" ||
    update.sessionUpdate === "agent_message_chunk" ||
    update.sessionUpdate === "agent_thought_chunk" ||
    update.sessionUpdate === "tool_call" ||
    update.sessionUpdate === "tool_call_update" ||
    update.sessionUpdate === "plan" ||
    update.sessionUpdate === "compaction_update"
  );
}

function isSessionStateUpdate(update: SessionUpdate): boolean {
  return (
    update.sessionUpdate === "available_commands_update" ||
    update.sessionUpdate === "config_option_update" ||
    update.sessionUpdate === "current_mode_update" ||
    update.sessionUpdate === "usage_update"
  );
}

function routeIncomingMessages(
  stream: Stream,
  receiveVendor: (method: string, params: unknown) => void,
  observeWire: (message: unknown) => void,
): Stream {
  const clientMethods = new Set<string>(Object.values(CLIENT_METHODS));
  return {
    writable: stream.writable,
    readable: stream.readable.pipeThrough(
      new TransformStream({
        transform(message, controller) {
          if ("method" in message && !("id" in message) && !clientMethods.has(message.method)) {
            // The SDK dispatches extensions asynchronously and can resolve a later response first.
            // Run synchronous vendor transforms in wire order, inside the configuration transaction.
            try {
              receiveVendor(message.method, message.params);
            } catch (error) {
              console.error("Error handling ACP vendor notification", error);
            }
          } else {
            observeWire(message);
            controller.enqueue(message);
          }
        },
      }),
    ),
  };
}

function selectPermissionOption(
  options: RequestPermissionRequest["options"],
  response: ProviderPermissionResponse,
): RequestPermissionRequest["options"][number] | null {
  if (response.selectedActionId !== undefined) {
    return (
      options.find(
        (option) =>
          option.optionId === response.selectedActionId &&
          permissionOptionBehavior(option) === response.behavior,
      ) ?? null
    );
  }
  return options.find((option) => permissionOptionBehavior(option) === response.behavior) ?? null;
}

function permissionOptionBehavior(
  option: RequestPermissionRequest["options"][number],
): ProviderPermissionResponse["behavior"] {
  return option.kind.startsWith("allow") ? "allow" : "deny";
}

function ownConnectorStream(source: Stream): {
  stream: Stream;
  close(options?: { force?: boolean; timeoutMs?: number }): Promise<void>;
  whenClosed(): Promise<void> | null;
} {
  const reader = source.readable.getReader();
  const writer = source.writable.getWriter();
  let closing: Promise<void> | null = null;
  const stream: Stream = {
    readable: new ReadableStream({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        } catch (error) {
          controller.error(error);
        }
      },
      cancel: (reason) => reader.cancel(reason),
    }),
    writable: new WritableStream({
      write: (message) => writer.write(message),
      close: () => writer.close(),
      abort: (reason) => writer.abort(reason),
    }),
  };
  return {
    stream,
    whenClosed: () => closing,
    async close(options?: { force?: boolean; timeoutMs?: number }) {
      if (!closing) {
        const closeWrite = options?.force
          ? writer.abort(new Error("Paseo aborted the ACP connector"))
          : writer.close();
        closing = Promise.allSettled([
          reader.cancel(new Error("Paseo closed the ACP connector")),
          closeWrite,
        ]).then((results) => {
          if (options?.timeoutMs === undefined) return undefined;
          const rejected = results.find(
            (result): result is PromiseRejectedResult => result.status === "rejected",
          );
          if (rejected) throw rejected.reason;
          return undefined;
        });
      }
      if (options?.timeoutMs !== undefined) {
        await withTimeout(closing, options.timeoutMs, "ACP connector did not close");
      } else {
        await closing.catch(() => undefined);
      }
    },
  };
}

function mergeToolCallSnapshot(
  update: ToolCall | ToolCallUpdate,
  current: AcpToolCallSource | undefined,
): AcpToolCallSource {
  return {
    id: update.toolCallId,
    name: firstText(update.name, current?.name),
    title: firstText(update.title, current?.title, update.name) ?? "Tool call",
    kind: firstText(update.kind, current?.kind),
    status: firstDefined(update.status, current?.status, "pending") ?? "pending",
    input: jsonValue(firstDefined(update.rawInput, current?.input, null)),
    output: jsonValue(firstDefined(update.rawOutput, current?.output, null)),
    locations: update.locations?.map((location) => location.path) ?? current?.locations ?? [],
    diff:
      update.content === undefined
        ? current?.diff
        : update.content?.find((item) => item.type === "diff"),
  };
}

function firstDefined<Value>(...values: Array<Value | undefined>): Value | undefined {
  return values.find((value) => value !== undefined);
}

function firstText(...values: Array<string | null | undefined>): string | undefined {
  return values.find((value): value is string => typeof value === "string");
}

function toAcpMcpServers(config: ProviderSessionConfig) {
  return Object.entries(config.mcpServers).map(([name, server]) => {
    if (server.type === "stdio") {
      return {
        name,
        command: server.command,
        args: server.args ?? [],
        env: Object.entries(server.env ?? {}).map(([key, value]) => ({ name: key, value })),
      };
    }
    return {
      type: server.type,
      name,
      url: server.url,
      headers: Object.entries(server.headers ?? {}).map(([key, value]) => ({ name: key, value })),
    };
  });
}

function toAcpPrompt(
  prompt: Extract<ProviderInput, { type: "session.prompt" }>["prompt"],
): ContentBlock[] {
  if (prompt.input.type === "command") {
    const suffix = prompt.input.arguments ? ` ${prompt.input.arguments}` : "";
    return [{ type: "text", text: `/${prompt.input.name}${suffix}` }];
  }
  return prompt.input.content.map((content) => {
    if (content.type === "text" || content.type === "image") return content;
    return { type: "text", text: JSON.stringify(content) };
  });
}

function nativePersistence(sessionId: string): ProviderPersistence {
  return { version: 1, data: { sessionId } };
}

function readNativeSessionId(persistence: ProviderPersistence | undefined): string | null {
  if (
    !persistence ||
    typeof persistence.data !== "object" ||
    persistence.data === null ||
    Array.isArray(persistence.data)
  )
    return null;
  return typeof persistence.data.sessionId === "string" ? persistence.data.sessionId : null;
}

function toProviderConfigState(
  modes: NewSessionResponse["modes"],
  options: readonly SessionConfigOption[],
): ProviderConfigState {
  const model = modelOption(options);
  const thinking = options.find((option) => option.category === "thought_level");
  const modeConfig = modeOption(options);
  return {
    model: selectedValue(model),
    mode: selectedValue(modeConfig) ?? modes?.currentModeId,
    thinkingOption: selectedValue(thinking),
    models: selectOptions(model).map((option) => ({ id: option.value, label: option.label })),
    modes: modeConfig
      ? selectOptions(modeConfig).map((option) => ({
          id: option.value,
          label: option.label,
          description: option.description,
        }))
      : (modes?.availableModes.map((mode) => ({
          id: mode.id,
          label: mode.name,
          description: mode.description ?? undefined,
        })) ?? []),
    thinkingOptions: selectOptions(thinking).map((option) => ({
      id: option.value,
      label: option.label,
    })),
    settings: options
      .filter(
        (option) =>
          option !== model && option.category !== "thought_level" && option !== modeConfig,
      )
      .map(toProviderSetting),
  };
}

// ACP's category is a grouping hint, so one category can hold several controls. fx files its
// provider first, then the model, Fast, and Ultrafast under "model".
function modelOption(options: readonly SessionConfigOption[]): SessionConfigOption | undefined {
  const candidates = options.filter((option) => option.category === "model");
  return candidates.find((option) => option.id === "model") ?? candidates[0];
}

function modeOption(options: readonly SessionConfigOption[]): SessionConfigOption | undefined {
  return options.find((option) => option.category === "mode" && option.type === "select");
}

function toProviderCatalog(
  modes: NewSessionResponse["modes"],
  options: readonly SessionConfigOption[],
): ProviderCatalog {
  const state = toProviderConfigState(modes, options);
  return {
    models: state.models,
    modes: state.modes,
    thinkingOptions: state.thinkingOptions,
    defaultModel: state.model,
    defaultMode: state.mode,
    defaultThinkingOption: state.thinkingOption,
  };
}

function toProviderSetting(option: SessionConfigOption): ProviderSetting {
  if (option.type === "boolean") {
    return {
      type: "toggle",
      id: option.id,
      label: option.name,
      description: option.description ?? undefined,
      value: option.currentValue,
    };
  }
  return {
    type: "select",
    id: option.id,
    label: option.name,
    description: option.description ?? undefined,
    value: option.currentValue,
    options: selectOptions(option).map(({ label, value }) => ({ label, value })),
  };
}

function selectOptions(
  option: SessionConfigOption | undefined,
): Array<{ label: string; value: string; description?: string }> {
  if (!option || option.type === "boolean") return [];
  return option.options.flatMap((candidate) =>
    "group" in candidate
      ? candidate.options.map((nested) => ({
          label: nested.name,
          value: nested.value,
          description: nested.description ?? undefined,
        }))
      : [
          {
            label: candidate.name,
            value: candidate.value,
            description: candidate.description ?? undefined,
          },
        ],
  );
}

function selectedValue(option: SessionConfigOption | undefined): string | undefined {
  return option && option.type !== "boolean" ? option.currentValue : undefined;
}

function configValues(
  options: readonly SessionConfigOption[],
): Readonly<Record<string, ReturnType<typeof jsonValue>>> {
  return Object.fromEntries(options.map((option) => [option.id, option.currentValue]));
}

type ToolCallTimelineItem = Extract<ProviderTimelineItem, { type: "tool_call" }>;

function toolTimelineItem(snapshot: AcpToolCallSnapshot): ToolCallTimelineItem {
  const input = jsonRecord(snapshot.input);
  const isEdit = snapshot.kind === "edit" || snapshot.name?.toLowerCase().includes("edit") === true;
  const detail =
    snapshot.detail ??
    (isEdit
      ? {
          type: "edit" as const,
          filePath:
            typeof input.filePath === "string" ? input.filePath : (snapshot.locations[0] ?? ""),
          oldString: typeof input.oldString === "string" ? input.oldString : undefined,
          newString: typeof input.newString === "string" ? input.newString : undefined,
          unifiedDiff: typeof input.unifiedDiff === "string" ? input.unifiedDiff : undefined,
        }
      : { type: "unknown" as const, input: snapshot.input, output: snapshot.output });
  const status =
    snapshot.status === "in_progress" || snapshot.status === "pending"
      ? "running"
      : snapshot.status;
  const base = {
    type: "tool_call" as const,
    id: snapshot.id,
    callId: snapshot.id,
    name: snapshot.name ?? snapshot.title,
    detail,
  };
  if (status === "failed") {
    return { ...base, status, error: snapshot.output ?? { message: "Tool failed" } };
  }
  return { ...base, status, error: null };
}

// A row the turn left open ends with the turn. The wire contract requires a non-null error on a
// failed tool call, so a canceled turn cancels its rows instead of failing them.
function terminalToolItem(
  item: ToolCallTimelineItem,
  state: "completed" | "failed" | "canceled",
): ToolCallTimelineItem {
  if (state === "failed") {
    return { ...item, status: "failed", error: item.error ?? { message: "Turn failed" } };
  }
  return { ...item, status: state, error: null };
}

function jsonValue(value: unknown) {
  return z.json().parse(value);
}

function jsonRecord(value: unknown): Record<string, ReturnType<typeof jsonValue>> {
  const parsed = jsonValue(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  return parsed;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withTimeout<Value>(
  promise: Promise<Value>,
  timeoutMs: number,
  message: string,
): Promise<Value> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
        return undefined;
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
        return undefined;
      },
    );
  });
}

async function settlesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}
