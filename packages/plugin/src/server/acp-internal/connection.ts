import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
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
  type ToolCallUpdate,
  type Stream,
} from "@agentclientprotocol/sdk";
import { z } from "zod";
import type {
  AcpConfigAccess,
  AcpConfigChange,
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
  type ProviderConfigState,
  type ProviderConnectRequest,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderPermissionResponse,
  type ProviderPersistence,
  type ProviderSessionConfig,
  type ProviderSetting,
  type ProviderTimelineItem,
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
    case "session.prompt":
      await requireSession(state, input.sessionId).runtime.prompt(input);
      return;
    case "session.interrupt":
      await requireSession(state, input.sessionId).runtime.interrupt();
      state.emit({ type: "request.completed", requestId: input.requestId });
      return;
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
    boundarySessionId: "catalog",
    env: {},
    emit: state.emit,
  });
  try {
    let catalog = await runtime.discover(input.cwd);
    const config = runtime.configAccess();
    for (const transformer of state.options.transformers ?? []) {
      if (transformer.discover) {
        catalog = await transformer.discover(catalog, { sessionId: "catalog", config });
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

async function openSession(
  input: Extract<ProviderInput, { type: "session.open" }>,
  state: AcpConnectionState,
): Promise<void> {
  if (state.sessions.has(input.sessionId))
    throw new Error(`Session already exists: ${input.sessionId}`);
  const runtime = await AcpRuntime.start({
    options: state.options,
    boundarySessionId: input.sessionId,
    env: input.config.env,
    emit: state.emit,
  });
  try {
    const capabilities = await runtime.open(input, state.capabilities);
    if (state.isClosed()) {
      await runtime.closeSession();
      return;
    }
    state.sessions.set(input.sessionId, {
      runtime,
      capabilities,
      mutationLane: Promise.resolve(),
    });
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
  options: RunAcpProviderOptions;
  boundarySessionId: string;
  env: Readonly<Record<string, string>>;
  emit(event: ProviderEvent): void;
}

class AcpRuntime {
  readonly connection: ClientSideConnection;
  agentCapabilities: AgentCapabilities = {};
  nativeSessionId = "";
  private readonly child: ChildProcessWithoutNullStreams | null;
  private emit: (event: ProviderEvent) => void;
  private readonly messages = new Map<string, string>();
  private readonly toolCalls = new Map<string, AcpToolCallSnapshot>();
  private readonly pendingCompactions = new Set<string>();
  private readonly permissions = new Map<
    string,
    { request: RequestPermissionRequest; resolve(response: RequestPermissionResponse): void }
  >();
  private readonly transformers: readonly AcpTransformer[];
  private configOptions: SessionConfigOption[] = [];
  private modes: NewSessionResponse["modes"] = null;
  private commandWaiter: (() => void) | null = null;
  private messageSequence = 0;
  private closing = false;
  private processFailed = false;
  private configTransaction = false;
  private stagedTransformerConfig: ProviderConfigState | null = null;
  private readonly closeConnector: () => Promise<void>;
  private notificationLane: Promise<void> = Promise.resolve();
  private promptLane: Promise<void> = Promise.resolve();
  private activePrompt: { turnId: string; settled: Promise<void> } | null = null;

  static async start(options: StartRuntimeOptions): Promise<AcpRuntime> {
    let child: ChildProcessWithoutNullStreams | null = null;
    let spawnFailure: Promise<never> | null = null;
    let stream: Stream;
    let closeConnector = async () => {};
    if (options.options.command) {
      const [executable, ...args] = options.options.command;
      child = spawn(executable, args, {
        env: { ...process.env, ...options.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      spawnFailure = new Promise<never>((_resolve, reject) => child!.once("error", reject));
      child.stderr.on("data", () => undefined);
      const output = Writable.toWeb(child.stdin) as unknown as Parameters<typeof ndJsonStream>[0];
      const input = Readable.toWeb(child.stdout) as unknown as Parameters<typeof ndJsonStream>[1];
      stream = ndJsonStream(output, input);
    } else {
      const owned = ownConnectorStream(await options.options.connector());
      stream = owned.stream;
      closeConnector = owned.close;
    }
    const runtime = new AcpRuntime(stream, child, closeConnector, options);
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
    closeConnector: () => Promise<void>,
    private readonly options: StartRuntimeOptions,
  ) {
    this.child = child;
    this.closeConnector = closeConnector;
    this.emit = options.emit;
    this.transformers = options.options.transformers ?? [];
    const client: Client = {
      requestPermission: (request) => this.requestPermission(request),
      sessionUpdate: (notification) =>
        this.enqueueNotification(() => this.sessionUpdate(notification)),
      extNotification: (method, params) =>
        this.enqueueNotification(() => this.vendorNotification(method, params)),
    };
    this.connection = new ClientSideConnection(() => client, stream);
    if (!child) void this.connection.closed.then(() => this.handleUnexpectedTransportClose());
    child?.on("error", (error) => {
      this.processFailed = true;
      this.settlePendingWork();
      if (this.closing || !this.nativeSessionId) return;
      this.emit({
        type: "session.runtime_failed",
        sessionId: this.options.boundarySessionId,
        error: { message: describeError(error) },
      });
    });
    child?.once("close", (code, signal) => {
      if (this.closing || this.processFailed || !this.nativeSessionId) return;
      this.processFailed = true;
      this.settlePendingWork();
      this.emit({
        type: "session.runtime_failed",
        sessionId: this.options.boundarySessionId,
        error: { message: `ACP process exited (${signal ?? code ?? "unknown"})` },
      });
    });
  }

  async open(
    input: Extract<ProviderInput, { type: "session.open" }>,
    connectionCapabilities: readonly ProviderCapability[],
  ): Promise<readonly ProviderCapability[]> {
    const mcpServers = toAcpMcpServers(input.config);
    const nativeSessionId = readNativeSessionId(input.persistence);
    const metadata = {
      _paseo: {
        systemPrompt: input.config.systemPrompt,
        providerOptions: input.config.providerOptions,
        toolPolicy: input.config.toolPolicy,
        persist: input.config.persist,
      },
    };
    let response: Pick<NewSessionResponse, "modes" | "configOptions">;
    if (nativeSessionId) {
      response = await this.call(
        this.connection.loadSession({
          sessionId: nativeSessionId,
          cwd: input.config.cwd,
          mcpServers,
          _meta: metadata,
        }),
      );
      this.nativeSessionId = nativeSessionId;
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
    this.modes = response.modes;
    this.configOptions = response.configOptions ?? [];
    await this.applyInitialConfig(input.config);
    const sessionCapabilities = connectionCapabilities.filter(
      (capability) =>
        capability !== "session.configure" ||
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
    if (this.options.options.acpOptions?.waitForInitialCommands) {
      await this.waitForInitialCommands();
    }
    this.emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
    return sessionCapabilities;
  }

  async discover(cwd = process.cwd()): Promise<ProviderCatalog> {
    const response = await this.call(this.connection.newSession({ cwd, mcpServers: [] }));
    this.nativeSessionId = response.sessionId;
    this.modes = response.modes;
    this.configOptions = response.configOptions ?? [];
    return toProviderCatalog(response.modes, response.configOptions ?? []);
  }

  prompt(input: Extract<ProviderInput, { type: "session.prompt" }>): Promise<void> {
    const admission = this.promptLane.then(() => this.admitPrompt(input));
    this.promptLane = admission.catch(() => undefined);
    return admission;
  }

  private async admitPrompt(
    input: Extract<ProviderInput, { type: "session.prompt" }>,
  ): Promise<void> {
    const active = this.activePrompt;
    if (active) {
      await this.interrupt();
      await active.settled;
    }
    const prompt = toAcpPrompt(input.prompt);
    const turnId = `acp:${input.prompt.clientMessageId}`;
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
    const settled = this.call(
      this.connection.prompt({ sessionId: this.nativeSessionId, prompt }),
    ).then(
      (response): void => {
        const state = response.stopReason === "cancelled" ? "canceled" : "completed";
        this.terminalizeTransientItems(state);
        this.emit({
          type: "session.turn",
          sessionId: this.options.boundarySessionId,
          turnId,
          state,
        });
        return undefined;
      },
      (error): void => {
        this.terminalizeTransientItems("failed");
        this.emit({
          type: "session.turn",
          sessionId: this.options.boundarySessionId,
          turnId,
          state: "failed",
          error: { message: describeError(error) },
        });
        return undefined;
      },
    );
    this.activePrompt = { turnId, settled };
    void settled.finally(() => {
      if (this.activePrompt?.turnId === turnId) this.activePrompt = null;
    });
  }

  interrupt(): Promise<void> {
    return this.call(this.connection.cancel({ sessionId: this.nativeSessionId }));
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
    if (!pending) throw new Error(`Unknown ACP permission: ${permissionId}`);
    const selected = selectPermissionOption(pending.request.options, response);
    if (response.selectedActionId !== undefined && !selected) {
      throw new Error(
        `ACP permission action '${response.selectedActionId}' does not exist or does not match '${response.behavior}' behavior`,
      );
    }
    this.permissions.delete(permissionId);
    pending.resolve({
      outcome: selected
        ? { outcome: "selected", optionId: selected.optionId }
        : { outcome: "cancelled" },
    });
    this.emit({
      type: "session.permission_resolved",
      sessionId: this.options.boundarySessionId,
      permissionId,
    });
  }

  async configure(
    changes: Extract<ProviderInput, { type: "session.configure" }>["changes"],
  ): Promise<void> {
    const ordered: AcpConfigChange[] = [];
    if (changes.model !== undefined) ordered.push({ target: "model", value: changes.model });
    if (changes.mode !== undefined) ordered.push({ target: "mode", value: changes.mode });
    if (changes.thinkingOption !== undefined) {
      ordered.push({ target: "thinking", value: changes.thinkingOption });
    }
    for (const [id, value] of Object.entries(changes.settings ?? {})) {
      ordered.push({ target: "setting", id, value });
    }
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

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.settlePendingWork();
    await this.closeConnector();
    const child = this.child;
    if (!child || this.processFailed) return;
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.kill("SIGTERM");
    if (await settlesWithin(closed, 1_000)) return;
    child.kill("SIGKILL");
    if (!(await settlesWithin(closed, 1_000))) {
      throw new Error(`ACP provider ${this.options.options.id} did not terminate after SIGKILL`);
    }
  }

  private async applyInitialConfig(config: ProviderSessionConfig): Promise<void> {
    if (config.model) await this.applyConfigChange({ target: "model", value: config.model });
    if (config.mode) await this.applyConfigChange({ target: "mode", value: config.mode });
    if (config.thinkingOption) {
      await this.applyConfigChange({ target: "thinking", value: config.thinkingOption });
    }
    for (const [id, value] of Object.entries(config.settings)) {
      await this.applyConfigChange({ target: "setting", id, value });
    }
  }

  private async applyConfigChange(change: AcpConfigChange): Promise<void> {
    const access = this.configAccess();
    for (const transformer of this.transformers) {
      if (
        (await transformer.configure?.(change, {
          sessionId: this.options.boundarySessionId,
          config: access,
        })) === "handled"
      ) {
        return;
      }
    }
    if (change.target === "mode") {
      if (!change.value || !this.modes) {
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
    let category: "model" | "thought_level" | null = null;
    if (change.target === "model") category = "model";
    if (change.target === "thinking") category = "thought_level";
    const configId =
      change.target === "setting"
        ? change.id
        : this.configOptions.find((option) => option.category === category)?.id;
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

  configAccess(): AcpConfigAccess {
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

  private emitConfigSnapshot(config: ProviderConfigState): void {
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
    if (modes?.currentModeId && this.modes?.currentModeId !== modes.currentModeId) {
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

  private requestPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const permissionId = `permission:${request.toolCall.toolCallId}`;
    return new Promise((resolve) => {
      this.permissions.set(permissionId, { request, resolve });
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

  private sessionUpdate(notification: SessionNotification): void {
    if (notification.sessionId !== this.nativeSessionId) return;
    this.reduceUpdate(notification.update);
  }

  private reduceUpdate(update: SessionUpdate): void {
    if (
      update.sessionUpdate === "agent_message_chunk" ||
      update.sessionUpdate === "agent_thought_chunk" ||
      update.sessionUpdate === "user_message_chunk"
    ) {
      if (update.sessionUpdate === "user_message_chunk") return;
      if (update.content.type !== "text") return;
      const fallbackId = `${update.sessionUpdate}:${++this.messageSequence}`;
      const id = update.messageId ?? fallbackId;
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
      return;
    }
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      this.reduceToolCall(update);
      return;
    }
    this.reduceStateUpdate(update);
  }

  private reduceStateUpdate(update: SessionUpdate): void {
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
      const commands = update.availableCommands.map((command) => ({
        name: command.name,
        description: command.description,
        argumentHint: command.input?.hint,
      }));
      this.emit({ type: "session.commands", sessionId: this.options.boundarySessionId, commands });
      this.commandWaiter?.();
      this.commandWaiter = null;
      return;
    }
    if (update.sessionUpdate === "current_mode_update") {
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
      this.emit({
        type: "session.usage",
        sessionId: this.options.boundarySessionId,
        usage: {
          contextWindowUsedTokens: update.used,
          contextWindowMaxTokens: update.size,
          totalCostUsd: update.cost?.currency === "USD" ? update.cost.amount : undefined,
        },
      });
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
    }
  }

  private terminalizeTransientItems(state: "completed" | "failed" | "canceled"): void {
    for (const [id, snapshot] of this.toolCalls) {
      if (snapshot.status !== "pending" && snapshot.status !== "in_progress") continue;
      const completed: AcpToolCallSnapshot = {
        ...snapshot,
        status: state === "completed" ? "completed" : "failed",
      };
      this.toolCalls.set(id, completed);
      this.emit({
        type: "timeline.item",
        sessionId: this.options.boundarySessionId,
        item: toolTimelineItem(completed),
      });
    }
    for (const id of this.pendingCompactions) {
      this.emit({
        type: "timeline.item",
        sessionId: this.options.boundarySessionId,
        item: { type: "compaction", id, status: "completed" },
      });
    }
    this.pendingCompactions.clear();
  }

  private reduceToolCall(update: ToolCall | ToolCallUpdate): void {
    const current = this.toolCalls.get(update.toolCallId);
    let snapshot = mergeToolCallSnapshot(update, current);
    const context = { sessionId: this.options.boundarySessionId };
    for (const transformer of this.transformers)
      snapshot = transformer.toolCall?.(snapshot, context) ?? snapshot;
    this.toolCalls.set(snapshot.id, snapshot);
    this.emit({
      type: "timeline.item",
      sessionId: this.options.boundarySessionId,
      item: toolTimelineItem(snapshot),
    });
  }

  private vendorNotification(method: string, params: Record<string, unknown>): void {
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
    this.processFailed = true;
    this.settlePendingWork();
    if (!this.nativeSessionId) return;
    this.emit({
      type: "session.runtime_failed",
      sessionId: this.options.boundarySessionId,
      error: { message: "ACP transport closed unexpectedly" },
    });
  }

  private settlePendingWork(): void {
    for (const permission of this.permissions.values()) {
      permission.resolve({ outcome: { outcome: "cancelled" } });
    }
    this.permissions.clear();
    this.commandWaiter?.();
    this.commandWaiter = null;
  }

  private waitForInitialCommands(): Promise<void> {
    const timeoutMs = this.options.options.acpOptions?.initialCommandsTimeoutMs ?? 1_000;
    const commands = new Promise<void>((resolve) => {
      this.commandWaiter = resolve;
    });
    const timeout = new Promise<void>((resolve) => {
      setTimeout(resolve, timeoutMs);
    });
    return Promise.race([commands, timeout]).finally(() => {
      this.commandWaiter = null;
    });
  }
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
  close(): Promise<void>;
} {
  const reader = source.readable.getReader();
  const writer = source.writable.getWriter();
  let closed = false;
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
    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled([
        reader.cancel(new Error("Paseo closed the ACP connector")),
        writer.close(),
      ]);
    },
  };
}

function mergeToolCallSnapshot(
  update: ToolCall | ToolCallUpdate,
  current: AcpToolCallSnapshot | undefined,
): AcpToolCallSnapshot {
  return {
    id: update.toolCallId,
    name: firstText(update.name, current?.name),
    title: firstText(update.title, current?.title, update.name) ?? "Tool call",
    kind: firstText(update.kind, current?.kind),
    status: firstDefined(update.status, current?.status, "pending") ?? "pending",
    input: jsonValue(firstDefined(update.rawInput, current?.input, null)),
    output: jsonValue(firstDefined(update.rawOutput, current?.output, null)),
    locations: update.locations?.map((location) => location.path) ?? current?.locations ?? [],
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
  const model = options.find((option) => option.category === "model");
  const thinking = options.find((option) => option.category === "thought_level");
  return {
    model: selectedValue(model),
    mode: modes?.currentModeId,
    thinkingOption: selectedValue(thinking),
    models: selectOptions(model).map((option) => ({ id: option.value, label: option.label })),
    modes:
      modes?.availableModes.map((mode) => ({
        id: mode.id,
        label: mode.name,
        description: mode.description ?? undefined,
      })) ?? [],
    thinkingOptions: selectOptions(thinking).map((option) => ({
      id: option.value,
      label: option.label,
    })),
    settings: options
      .filter((option) => option.category !== "model" && option.category !== "thought_level")
      .map(toProviderSetting),
  };
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
    options: selectOptions(option),
  };
}

function selectOptions(
  option: SessionConfigOption | undefined,
): Array<{ label: string; value: string }> {
  if (!option || option.type === "boolean") return [];
  return option.options.flatMap((candidate) =>
    "group" in candidate
      ? candidate.options.map((nested) => ({ label: nested.name, value: nested.value }))
      : [{ label: candidate.name, value: candidate.value }],
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

function toolTimelineItem(snapshot: AcpToolCallSnapshot): ProviderTimelineItem {
  const input = jsonRecord(snapshot.input);
  const isEdit = snapshot.kind === "edit" || snapshot.name?.toLowerCase().includes("edit") === true;
  const detail = isEdit
    ? {
        type: "edit" as const,
        filePath:
          typeof input.filePath === "string" ? input.filePath : (snapshot.locations[0] ?? ""),
        oldString: typeof input.oldString === "string" ? input.oldString : undefined,
        newString: typeof input.newString === "string" ? input.newString : undefined,
        unifiedDiff: typeof input.unifiedDiff === "string" ? input.unifiedDiff : undefined,
      }
    : { type: "unknown" as const, input: snapshot.input, output: snapshot.output };
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
  if (status === "failed") return { ...base, status, error: snapshot.output };
  return { ...base, status, error: null };
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
