import { randomUUID } from "node:crypto";
import {
  PROVIDER_CAPABILITIES,
  PROVIDER_PROTOCOL_VERSION,
  ProviderEventSchema,
  ProviderInputSchema,
  requireProviderCapabilities,
  type ProviderCapability,
  type ProviderConfigChanges,
  type ProviderConfigState,
  type ProviderConnection,
  type ProviderError,
  type ProviderEvent,
  type ProviderInput,
  type ProviderPersistence,
  type ProviderPrompt,
  type ProviderRegistration,
  type ProviderSessionConfig,
} from "@getpaseo/plugin/provider";

interface Deferred<Value> {
  promise: Promise<Value>;
  resolve(value: Value): void;
  reject(error: Error): void;
}

interface PendingRequest {
  kind: ProviderInput["type"];
  sessionId?: string;
  resolve(event: ProviderEvent): void;
  reject(error: Error): void;
}

interface ReloadState {
  requestId: string;
  config: ProviderSessionConfig;
  buffered: ProviderEvent[];
  candidateStarted: boolean;
  deferred: Deferred<void>;
}

interface ReloadDescendantState {
  readonly providerSessionIds: Set<string>;
  readonly events: ProviderEvent[];
}

export interface OpenProviderSessionInput {
  sessionId: string;
  config: ProviderSessionConfig;
  persistence?: ProviderPersistence;
  history: "replay" | "skip";
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Value>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function providerError(error: ProviderError): Error {
  return Object.assign(new Error(error.message), {
    code: error.code,
    diagnostic: error.diagnostic,
  });
}

function requireCapability(capabilities: readonly string[], capability: ProviderCapability): void {
  if (!capabilities.includes(capability)) {
    throw new Error(`Provider does not support ${capability}`);
  }
}

export class ProviderRuntime {
  private connection: ProviderConnection | null = null;
  private connecting: Promise<ProviderConnection> | null = null;
  private closed = false;
  private generation = 0;
  private closePromise: Promise<void> | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly sessions = new Map<string, ProviderRuntimeSession>();
  private readonly providerSessions = new Map<string, ProviderRuntimeSession>();
  private readonly sessionListeners = new Set<
    (
      session: ProviderRuntimeSession,
      event: Extract<ProviderEvent, { type: "session.opened" }>,
    ) => void
  >();
  private readonly requests = new Map<string, PendingRequest>();
  private readonly sessionRequests = new Map<string, string>();
  private readonly reloadDescendants = new Map<string, ReloadDescendantState>();
  private readonly reloadDescendantsByRoot = new Map<
    ProviderRuntimeSession,
    ReloadDescendantState
  >();

  constructor(private readonly registration: ProviderRegistration) {}

  get id(): string {
    return this.registration.id;
  }

  async isAvailable(): Promise<boolean> {
    await this.getConnection();
    return true;
  }

  async catalog(
    cwd?: string,
    signal?: AbortSignal,
  ): Promise<Extract<ProviderEvent, { type: "catalog" }>["catalog"]> {
    const event = await this.complete({ type: "catalog", requestId: randomUUID(), cwd }, signal);
    if (event.type !== "catalog") throw new Error("Provider returned an invalid catalog response");
    return event.catalog;
  }

  async listSessions(
    input: {
      query?: string;
      cwd?: string;
      limit?: number;
    } = {},
  ): Promise<Extract<ProviderEvent, { type: "sessions" }>["sessions"]> {
    const connection = await this.getConnection();
    requireCapability(connection.capabilities, "session.list");
    const event = await this.complete({ type: "sessions", requestId: randomUUID(), ...input });
    if (event.type !== "sessions")
      throw new Error("Provider returned an invalid sessions response");
    return event.sessions;
  }

  async supports(capability: ProviderCapability): Promise<boolean> {
    return (await this.getConnection()).capabilities.includes(capability);
  }

  onSessionOpened(
    listener: (
      session: ProviderRuntimeSession,
      event: Extract<ProviderEvent, { type: "session.opened" }>,
    ) => void,
  ): () => void {
    this.sessionListeners.add(listener);
    return () => this.sessionListeners.delete(listener);
  }

  async openSession(input: OpenProviderSessionInput): Promise<ProviderRuntimeSession> {
    if (this.sessions.has(input.sessionId)) {
      throw new Error(`Provider session already exists: ${input.sessionId}`);
    }
    const connection = await this.getConnection();
    requireProviderCapabilities(connection.capabilities, {
      type: "session.open",
      requestId: "capability-check",
      ...input,
    });
    const session = new ProviderRuntimeSession(
      this,
      connection,
      input.sessionId,
      input.sessionId,
      "core",
      input.config,
    );
    this.sessions.set(input.sessionId, session);
    this.providerSessions.set(input.sessionId, session);
    const requestId = randomUUID();
    const ready = session.beginOpen(requestId);
    this.sessionRequests.set(requestId, input.sessionId);
    try {
      await connection.send({
        type: "session.open",
        requestId,
        sessionId: input.sessionId,
        config: input.config,
        persistence: input.persistence,
        history: input.history,
      });
      await ready;
      return session;
    } catch (error) {
      this.sessionRequests.delete(requestId);
      this.discardQuarantinedDescendants(session);
      this.sessions.delete(input.sessionId);
      this.providerSessions.delete(input.sessionId);
      throw error;
    }
  }

  async archive(persistence: ProviderPersistence): Promise<void> {
    const connection = await this.getConnection();
    requireCapability(connection.capabilities, "session.archive");
    await this.complete({ type: "session.archive", requestId: randomUUID(), persistence });
  }

  async unarchive(persistence: ProviderPersistence): Promise<void> {
    const connection = await this.getConnection();
    requireCapability(connection.capabilities, "session.unarchive");
    await this.complete({ type: "session.unarchive", requestId: randomUUID(), persistence });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.generation += 1;
    const connection = this.connection;
    const connecting = connection ? null : this.connecting;
    this.connection = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const session of this.sessions.values()) session.connectionClosed();
    this.sessions.clear();
    this.providerSessions.clear();
    this.reloadDescendants.clear();
    this.reloadDescendantsByRoot.clear();
    this.sessionListeners.clear();
    for (const request of this.requests.values()) request.reject(new Error("Provider closed"));
    this.requests.clear();
    this.closePromise = Promise.all([
      connection?.close(),
      connecting?.then(
        () => undefined,
        () => undefined,
      ),
    ]).then(() => undefined);
    return this.closePromise;
  }

  async complete(
    input: ProviderInput & { requestId: string },
    signal?: AbortSignal,
  ): Promise<ProviderEvent> {
    signal?.throwIfAborted();
    const connection = await this.getConnection();
    signal?.throwIfAborted();
    const pending = deferred<ProviderEvent>();
    this.requests.set(input.requestId, {
      kind: input.type,
      sessionId:
        "sessionId" in input
          ? (this.providerSessions.get(input.sessionId)?.id ?? input.sessionId)
          : undefined,
      resolve: pending.resolve,
      reject: pending.reject,
    });
    const abort = () => {
      if (!this.requests.delete(input.requestId)) return;
      pending.reject(
        signal?.reason instanceof Error ? signal.reason : new Error("Provider request aborted"),
      );
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await connection.send(input);
      return await pending.promise;
    } catch (error) {
      this.requests.delete(input.requestId);
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  removeSession(sessionId: string, providerSessionId: string): void {
    this.sessions.delete(sessionId);
    this.providerSessions.delete(providerSessionId);
  }

  trackSessionRequest(requestId: string, sessionId: string): void {
    this.sessionRequests.set(requestId, sessionId);
  }

  finishSessionRequest(requestId: string): void {
    this.sessionRequests.delete(requestId);
  }

  private getConnection(): Promise<ProviderConnection> {
    if (this.closed) return Promise.reject(new Error("Provider runtime is closed"));
    if (this.connection) return Promise.resolve(this.connection);
    if (this.connecting) return this.connecting;
    const generation = this.generation;
    const connecting = this.establishConnection(generation);
    this.connecting = connecting;
    connecting.then(
      () => {
        if (this.connecting === connecting) this.connecting = null;
        return undefined;
      },
      () => {
        if (this.connecting === connecting) this.connecting = null;
        return undefined;
      },
    );
    return connecting;
  }

  private async establishConnection(generation: number): Promise<ProviderConnection> {
    const rawConnection = await this.registration.connect({
      versions: [PROVIDER_PROTOCOL_VERSION],
      capabilities: PROVIDER_CAPABILITIES,
    });
    if (this.closed || generation !== this.generation) {
      await rawConnection.close().catch(() => undefined);
      throw new Error("Provider runtime is closed");
    }
    try {
      this.validateConnection(rawConnection);
    } catch (error) {
      await rawConnection.close().catch(() => undefined);
      throw error;
    }
    const connection = normalizeConnection(rawConnection);
    const unsubscribe = connection.onEvent((event) => this.accept(event));
    if (this.closed || generation !== this.generation) {
      unsubscribe();
      await connection.close().catch(() => undefined);
      throw new Error("Provider runtime is closed");
    }
    this.unsubscribe = unsubscribe;
    this.connection = connection;
    return connection;
  }

  private validateConnection(connection: ProviderConnection): void {
    if (connection.version !== PROVIDER_PROTOCOL_VERSION) {
      throw new Error(`Provider selected unsupported version ${connection.version}`);
    }
  }

  private accept(event: ProviderEvent): void {
    if (event.type === "request.failed") {
      this.failRequest(event);
      return;
    }
    if (
      event.type === "request.completed" ||
      event.type === "catalog" ||
      event.type === "sessions"
    ) {
      this.finishRequest(event);
      return;
    }
    this.finishSessionReadyRequest(event);
    if (this.quarantineDescendant(event)) return;
    if (this.acceptProviderChild(event)) return;
    if ("sessionId" in event) {
      const session = this.providerSessions.get(event.sessionId);
      if (!session) return;
      event = {
        ...event,
        sessionId: session.id,
        ...(event.type === "session.opened" && event.parentSessionId
          ? { parentSessionId: this.providerSessions.get(event.parentSessionId)?.id }
          : {}),
      } as ProviderEvent;
    }
    if (event.type === "session.runtime_failed") {
      this.failSessionRequests(event.sessionId, providerError(event.error));
    } else if (event.type === "session.closed") {
      this.settleClosedSessionRequests(
        event.sessionId,
        new Error(event.error?.message ?? `Provider session ${event.sessionId} closed`),
        event,
      );
    }
    if ("sessionId" in event) {
      const session = this.sessions.get(event.sessionId);
      session?.accept(event);
      if (event.type === "session.closed" && session) {
        this.removeSession(session.id, session.providerId);
      }
    }
  }

  private finishSessionReadyRequest(event: ProviderEvent): void {
    if (event.type !== "session.ready" || !event.requestId) return;
    this.sessionRequests.delete(event.requestId);
    const request = this.requests.get(event.requestId);
    if (!request) return;
    this.requests.delete(event.requestId);
    request.resolve(event);
  }

  private acceptProviderChild(event: ProviderEvent): boolean {
    if (event.type !== "session.opened" || this.providerSessions.has(event.sessionId)) return false;
    const parent = event.parentSessionId
      ? this.providerSessions.get(event.parentSessionId)
      : undefined;
    if (!parent) return true;
    const sessionId = randomUUID();
    const session = new ProviderRuntimeSession(
      this,
      this.connection!,
      sessionId,
      event.sessionId,
      event.restoration,
      {
        cwd: event.cwd,
        env: {},
        mcpServers: {},
        settings: {},
        title: event.title,
        persist: false,
      },
    );
    this.sessions.set(sessionId, session);
    this.providerSessions.set(event.sessionId, session);
    const mappedEvent = { ...event, sessionId, parentSessionId: parent.id };
    session.accept(mappedEvent);
    for (const listener of this.sessionListeners) listener(session, mappedEvent);
    return true;
  }

  private quarantineDescendant(event: ProviderEvent): boolean {
    if (!("sessionId" in event)) return false;
    let state = this.reloadDescendants.get(event.sessionId);
    if (event.type === "session.opened" && event.parentSessionId) {
      const parent = this.providerSessions.get(event.parentSessionId);
      state =
        this.reloadDescendants.get(event.parentSessionId) ??
        (parent?.hasPendingGeneration() ? this.reloadStateFor(parent) : undefined);
      if (state) {
        state.providerSessionIds.add(event.sessionId);
        this.reloadDescendants.set(event.sessionId, state);
      }
    }
    if (!state) return false;
    state.events.push(event);
    return true;
  }

  private reloadStateFor(root: ProviderRuntimeSession): ReloadDescendantState {
    const existing = this.reloadDescendantsByRoot.get(root);
    if (existing) return existing;
    const state: ReloadDescendantState = { providerSessionIds: new Set(), events: [] };
    this.reloadDescendantsByRoot.set(root, state);
    return state;
  }

  commitQuarantinedDescendants(root: ProviderRuntimeSession): void {
    const state = this.takeReloadDescendants(root);
    if (!state) return;
    for (const event of state.events) this.accept(event);
  }

  discardQuarantinedDescendants(root: ProviderRuntimeSession): void {
    this.takeReloadDescendants(root);
  }

  private takeReloadDescendants(root: ProviderRuntimeSession): ReloadDescendantState | undefined {
    const state = this.reloadDescendantsByRoot.get(root);
    if (!state) return undefined;
    this.reloadDescendantsByRoot.delete(root);
    for (const providerSessionId of state.providerSessionIds) {
      if (this.reloadDescendants.get(providerSessionId) === state) {
        this.reloadDescendants.delete(providerSessionId);
      }
    }
    return state;
  }

  private failSessionRequests(sessionId: string, error: Error): void {
    for (const [requestId, request] of this.requests) {
      if (request.sessionId !== sessionId) continue;
      this.requests.delete(requestId);
      request.reject(error);
    }
    for (const [requestId, pendingSessionId] of this.sessionRequests) {
      if (pendingSessionId === sessionId) this.sessionRequests.delete(requestId);
    }
  }

  private settleClosedSessionRequests(
    sessionId: string,
    error: Error,
    event: Extract<ProviderEvent, { type: "session.closed" }>,
  ): void {
    for (const [requestId, request] of this.requests) {
      if (request.sessionId !== sessionId) continue;
      this.requests.delete(requestId);
      if (request.kind === "session.close") request.resolve(event);
      else request.reject(error);
    }
  }

  private failRequest(event: Extract<ProviderEvent, { type: "request.failed" }>): void {
    const request = this.requests.get(event.requestId);
    if (request) {
      this.requests.delete(event.requestId);
      request.reject(providerError(event.error));
    }
    if (request?.sessionId) this.sessions.get(request.sessionId)?.requestFailed(event);
    const sessionId = this.sessionRequests.get(event.requestId);
    if (!sessionId) return;
    this.sessionRequests.delete(event.requestId);
    this.sessions.get(sessionId)?.requestFailed(event);
  }

  private finishRequest(
    event: Extract<ProviderEvent, { type: "request.completed" | "catalog" | "sessions" }>,
  ): void {
    const request = this.requests.get(event.requestId);
    if (!request) return;
    this.requests.delete(event.requestId);
    request.resolve(event);
  }
}

export class ProviderRuntimeSession {
  readonly history: ProviderEvent[] = [];
  private readonly listeners = new Set<(event: ProviderEvent) => void>();
  private capabilities: readonly string[] = [];
  private openRequest: { requestId: string; deferred: Deferred<void> } | null = null;
  private reloadState: ReloadState | null = null;
  private readonly prompts = new Map<
    string,
    Deferred<Extract<ProviderEvent, { type: "session.prompt_result" }>>
  >();
  config: ProviderConfigState = { models: [], modes: [], thinkingOptions: [], settings: [] };
  commands: Array<{ name: string; description: string; argumentHint?: string }> = [];
  persistence: ProviderPersistence | null = null;

  constructor(
    private readonly runtime: ProviderRuntime,
    private readonly connection: ProviderConnection,
    readonly id: string,
    private readonly providerSessionId: string,
    readonly restoration: "core" | "parent",
    private currentSessionConfig: ProviderSessionConfig,
  ) {}

  get sessionConfig(): ProviderSessionConfig {
    return this.currentSessionConfig;
  }

  get providerId(): string {
    return this.providerSessionId;
  }

  get negotiatedCapabilities(): readonly string[] {
    return this.capabilities;
  }

  onEvent(listener: (event: ProviderEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(
    prompt: ProviderPrompt,
  ): Promise<Extract<ProviderEvent, { type: "session.prompt_result" }>["result"]> {
    requireProviderCapabilities(this.capabilities, {
      type: "session.prompt",
      sessionId: this.providerSessionId,
      prompt,
    });
    const pending = deferred<Extract<ProviderEvent, { type: "session.prompt_result" }>>();
    this.prompts.set(prompt.clientMessageId, pending);
    try {
      await this.connection.send({
        type: "session.prompt",
        sessionId: this.providerSessionId,
        prompt,
      });
      return (await pending.promise).result;
    } finally {
      this.prompts.delete(prompt.clientMessageId);
    }
  }

  async reload(config: ProviderSessionConfig): Promise<void> {
    if (this.reloadState) throw new Error(`Provider session ${this.id} is already reloading`);
    const requestId = randomUUID();
    const input: Extract<ProviderInput, { type: "session.reload" }> = {
      type: "session.reload",
      requestId,
      sessionId: this.providerSessionId,
      config,
    };
    requireProviderCapabilities(this.capabilities, input);
    const pending = deferred<void>();
    this.reloadState = {
      requestId,
      config,
      buffered: [],
      candidateStarted: false,
      deferred: pending,
    };
    this.runtime.trackSessionRequest(requestId, this.id);
    try {
      await this.connection.send(input);
      await pending.promise;
    } catch (error) {
      if (this.reloadState?.requestId === requestId) this.reloadState = null;
      this.runtime.discardQuarantinedDescendants(this);
      this.runtime.finishSessionRequest(requestId);
      throw error;
    }
  }

  async configure(changes: ProviderConfigChanges): Promise<void> {
    const input: Extract<ProviderInput, { type: "session.configure" }> = {
      type: "session.configure",
      requestId: randomUUID(),
      sessionId: this.providerSessionId,
      changes,
    };
    requireProviderCapabilities(this.capabilities, input);
    await this.runtime.complete(input);
  }

  async respondToPermission(
    permissionId: string,
    response: Extract<ProviderInput, { type: "session.permission" }>["response"],
  ): Promise<void> {
    const input: Extract<ProviderInput, { type: "session.permission" }> = {
      type: "session.permission",
      sessionId: this.providerSessionId,
      permissionId,
      response,
    };
    requireProviderCapabilities(this.capabilities, input);
    await this.connection.send(input);
  }

  async revert(token: ProviderInput & { type: "session.revert" }): Promise<void> {
    const input = { ...token, sessionId: this.providerSessionId };
    requireProviderCapabilities(this.capabilities, input);
    await this.runtime.complete(input);
  }

  async interrupt(): Promise<void> {
    await this.runtime.complete({
      type: "session.interrupt",
      requestId: randomUUID(),
      sessionId: this.providerSessionId,
    });
  }

  async close(): Promise<void> {
    if (this.restoration === "parent") {
      this.runtime.removeSession(this.id, this.providerSessionId);
      return;
    }
    try {
      await this.runtime.complete({
        type: "session.close",
        requestId: randomUUID(),
        sessionId: this.providerSessionId,
      });
    } finally {
      this.runtime.removeSession(this.id, this.providerSessionId);
    }
  }

  beginOpen(requestId: string): Promise<void> {
    const pending = deferred<void>();
    this.openRequest = { requestId, deferred: pending };
    return pending.promise;
  }

  requestFailed(event: Extract<ProviderEvent, { type: "request.failed" }>): void {
    if (this.openRequest?.requestId === event.requestId) {
      this.openRequest.deferred.reject(providerError(event.error));
      this.openRequest = null;
      this.runtime.discardQuarantinedDescendants(this);
    }
    if (this.reloadState?.requestId === event.requestId) {
      this.reloadState.deferred.reject(providerError(event.error));
      this.reloadState = null;
      this.runtime.discardQuarantinedDescendants(this);
    }
  }

  accept(event: ProviderEvent): void {
    if (event.type === "session.opened") {
      event = { ...event, capabilities: this.normalizeSessionCapabilities(event.capabilities) };
    }
    if (this.acceptReloadEvent(event)) return;
    if (event.type === "session.opened") {
      this.capabilities = [...event.capabilities];
      this.persistence = this.restoration === "core" ? (event.persistence ?? null) : null;
      return;
    }
    const openRequest = this.openRequest;
    if (
      event.type === "session.ready" &&
      openRequest &&
      openRequest.requestId === event.requestId
    ) {
      this.openRequest = null;
      this.runtime.commitQuarantinedDescendants(this);
      openRequest.deferred.resolve();
      return;
    }
    if (event.type === "session.prompt_result") {
      this.prompts.get(event.clientMessageId)?.resolve(event);
      return;
    }
    if (event.type === "session.runtime_failed" || event.type === "session.closed") {
      this.publish(event);
      this.connectionClosed(
        new Error(event.error?.message ?? `Provider session ${this.id} closed`),
      );
      return;
    }
    this.publish(event);
  }

  private acceptReloadEvent(event: ProviderEvent): boolean {
    const reload = this.reloadState;
    if (!reload) return false;
    if (event.type === "session.opened" && event.requestId === reload.requestId) {
      reload.candidateStarted = true;
      reload.buffered.push(event);
      return true;
    }
    if (event.type === "session.ready" && event.requestId === reload.requestId) {
      this.commitReload(reload);
      return true;
    }
    if (!reload.candidateStarted) return false;
    if (event.type === "session.runtime_failed" || event.type === "session.closed") {
      this.reloadState = null;
      this.runtime.discardQuarantinedDescendants(this);
      reload.deferred.reject(
        new Error(
          event.type === "session.runtime_failed"
            ? event.error.message
            : (event.error?.message ?? "Provider reload candidate closed"),
        ),
      );
      return true;
    }
    reload.buffered.push(event);
    return true;
  }

  private commitReload(reload: ReloadState): void {
    this.reloadState = null;
    if (!reload.candidateStarted) {
      this.runtime.discardQuarantinedDescendants(this);
      reload.deferred.reject(
        new Error(`Provider reload ${reload.requestId} became ready before opening a candidate`),
      );
      return;
    }
    const opened = reload.buffered.find(
      (candidate): candidate is Extract<ProviderEvent, { type: "session.opened" }> =>
        candidate.type === "session.opened",
    );
    if (opened) {
      this.capabilities = [...opened.capabilities];
      this.persistence = opened.persistence ?? null;
    }
    this.currentSessionConfig = reload.config;
    this.history.length = 0;
    for (const buffered of reload.buffered) {
      if (buffered.type !== "session.opened" && buffered.type !== "session.ready") {
        this.publish(buffered);
      }
    }
    this.runtime.commitQuarantinedDescendants(this);
    reload.deferred.resolve();
  }

  hasPendingGeneration(): boolean {
    return this.openRequest !== null || this.reloadState !== null;
  }

  connectionClosed(error = new Error("Provider connection closed")): void {
    this.openRequest?.deferred.reject(error);
    this.reloadState?.deferred.reject(error);
    this.runtime.discardQuarantinedDescendants(this);
    for (const prompt of this.prompts.values()) prompt.reject(error);
  }

  private normalizeSessionCapabilities(capabilities: readonly string[]): ProviderCapability[] {
    const known = PROVIDER_CAPABILITIES.filter((capability) => capabilities.includes(capability));
    for (const capability of known) {
      if (!this.connection.capabilities.includes(capability)) {
        throw new Error(`Provider session selected unoffered capability ${capability}`);
      }
    }
    return known;
  }

  private publish(event: ProviderEvent): void {
    if (event.type === "session.config") this.config = event.config;
    if (event.type === "session.commands") this.commands = [...event.commands];
    if (event.type === "session.persistence" && this.restoration === "core") {
      this.persistence = event.persistence;
    }
    this.history.push(event);
    for (const listener of this.listeners) listener(event);
  }
}

function normalizeConnection(connection: ProviderConnection): ProviderConnection {
  const capabilities = PROVIDER_CAPABILITIES.filter((capability) =>
    connection.capabilities.includes(capability),
  );
  return {
    version: connection.version,
    capabilities,
    send: (input) => connection.send(ProviderInputSchema.parse(input)),
    onEvent: (listener) =>
      connection.onEvent((event) => listener(ProviderEventSchema.parse(event))),
    close: () => connection.close(),
  };
}
