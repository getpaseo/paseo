import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { JsonValue, ProviderOptions } from "@getpaseo/protocol/agent-types";
import { z } from "zod";
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
  type ProviderContent,
  type ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";
import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentCreateSessionOptions,
  AgentFeature,
  AgentLaunchContext,
  AgentMode,
  AgentModelDefinition,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentRunOptions,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentSlashCommand,
  AgentStreamEvent,
  AgentTimelineItem,
  FetchCatalogOptions,
  ImportableProviderSession,
  ImportedProviderSession,
  ImportProviderSessionContext,
  ImportProviderSessionInput,
  ListImportableSessionsOptions,
  ProviderCatalog,
  ProviderRefreshContext,
  SteerActiveTurnOptions,
  SteerResult,
} from "./agent-sdk-types.js";
import {
  isDefaultAgentCreateConfigUnattended,
  resolveDefaultAgentCreateConfig,
} from "./create-agent-mode.js";
import type { ProviderDefinition } from "./provider-registry.js";
import { runProviderTurn } from "./providers/provider-runner.js";

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

interface PendingOpenDescendantState {
  readonly providerSessionIds: Set<string>;
  readonly events: ProviderEvent[];
}

interface OpenProviderSessionInput {
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

class ProviderRuntime {
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
  private readonly pendingOpenDescendants = new Map<string, PendingOpenDescendantState>();
  private readonly pendingOpenDescendantsByRoot = new Map<
    ProviderRuntimeSession,
    PendingOpenDescendantState
  >();

  constructor(private readonly registration: ProviderRegistration) {}

  get negotiatedCapabilities(): readonly string[] {
    return this.connection?.capabilities ?? [];
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
    if (!connection.capabilities.includes("session.list")) return [];
    const event = await this.complete({ type: "sessions", requestId: randomUUID(), ...input });
    if (event.type !== "sessions")
      throw new Error("Provider returned an invalid sessions response");
    return event.sessions;
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
      this.discardPendingOpenDescendants(session);
      this.sessions.delete(input.sessionId);
      this.providerSessions.delete(input.sessionId);
      throw error;
    }
  }

  async archive(persistence: ProviderPersistence): Promise<void> {
    const connection = await this.getConnection();
    if (!connection.capabilities.includes("session.archive")) return;
    await this.complete({ type: "session.archive", requestId: randomUUID(), persistence });
  }

  async unarchive(persistence: ProviderPersistence): Promise<void> {
    const connection = await this.getConnection();
    if (!connection.capabilities.includes("session.unarchive")) return;
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
    this.pendingOpenDescendants.clear();
    this.pendingOpenDescendantsByRoot.clear();
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
    if (this.holdPendingOpenDescendant(event)) return;
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
    );
    this.sessions.set(sessionId, session);
    this.providerSessions.set(event.sessionId, session);
    const mappedEvent = { ...event, sessionId, parentSessionId: parent.id };
    session.accept(mappedEvent);
    for (const listener of this.sessionListeners) listener(session, mappedEvent);
    return true;
  }

  private holdPendingOpenDescendant(event: ProviderEvent): boolean {
    if (!("sessionId" in event)) return false;
    let state = this.pendingOpenDescendants.get(event.sessionId);
    if (event.type === "session.opened" && event.parentSessionId) {
      const parent = this.providerSessions.get(event.parentSessionId);
      state =
        this.pendingOpenDescendants.get(event.parentSessionId) ??
        (parent?.hasPendingOpen() ? this.pendingOpenDescendantStateFor(parent) : undefined);
      if (state) {
        state.providerSessionIds.add(event.sessionId);
        this.pendingOpenDescendants.set(event.sessionId, state);
      }
    }
    if (!state) return false;
    state.events.push(event);
    return true;
  }

  private pendingOpenDescendantStateFor(root: ProviderRuntimeSession): PendingOpenDescendantState {
    const existing = this.pendingOpenDescendantsByRoot.get(root);
    if (existing) return existing;
    const state: PendingOpenDescendantState = { providerSessionIds: new Set(), events: [] };
    this.pendingOpenDescendantsByRoot.set(root, state);
    return state;
  }

  releasePendingOpenDescendants(root: ProviderRuntimeSession): void {
    const state = this.takePendingOpenDescendants(root);
    if (!state) return;
    for (const event of state.events) this.accept(event);
  }

  discardPendingOpenDescendants(root: ProviderRuntimeSession): void {
    this.takePendingOpenDescendants(root);
  }

  private takePendingOpenDescendants(
    root: ProviderRuntimeSession,
  ): PendingOpenDescendantState | undefined {
    const state = this.pendingOpenDescendantsByRoot.get(root);
    if (!state) return undefined;
    this.pendingOpenDescendantsByRoot.delete(root);
    for (const providerSessionId of state.providerSessionIds) {
      if (this.pendingOpenDescendants.get(providerSessionId) === state) {
        this.pendingOpenDescendants.delete(providerSessionId);
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

class ProviderRuntimeSession {
  readonly history: ProviderEvent[] = [];
  private readonly listeners = new Set<(event: ProviderEvent) => void>();
  private capabilities: readonly string[] = [];
  private openRequest: { requestId: string; deferred: Deferred<void> } | null = null;
  private readonly prompts = new Map<
    string,
    Deferred<Extract<ProviderEvent, { type: "session.prompt_result" }>>
  >();
  private terminal = false;
  config: ProviderConfigState = { models: [], modes: [], thinkingOptions: [], settings: [] };
  commands: Array<{ name: string; description: string; argumentHint?: string }> = [];
  persistence: ProviderPersistence | null = null;

  constructor(
    private readonly runtime: ProviderRuntime,
    private readonly connection: ProviderConnection,
    readonly id: string,
    private readonly providerSessionId: string,
    readonly restoration: "core" | "parent",
  ) {}

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
      this.runtime.discardPendingOpenDescendants(this);
    }
  }

  accept(event: ProviderEvent): void {
    if (event.type === "session.opened") {
      event = { ...event, capabilities: this.normalizeSessionCapabilities(event.capabilities) };
    }
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
      this.runtime.releasePendingOpenDescendants(this);
      openRequest.deferred.resolve();
      return;
    }
    if (event.type === "session.prompt_result") {
      this.prompts.get(event.clientMessageId)?.resolve(event);
      return;
    }
    if (event.type === "session.runtime_failed" || event.type === "session.closed") {
      if (this.terminal) return;
      this.terminal = true;
      this.publish(event);
      this.rejectPending(new Error(event.error?.message ?? `Provider session ${this.id} closed`));
      return;
    }
    this.publish(event);
  }

  hasPendingOpen(): boolean {
    return this.openRequest !== null;
  }

  connectionClosed(error = new Error("Provider connection closed")): void {
    if (!this.terminal) {
      this.terminal = true;
      this.publish({
        type: "session.runtime_failed",
        sessionId: this.id,
        error: { message: error.message },
      });
    }
    this.rejectPending(error);
  }

  private rejectPending(error: Error): void {
    const openRequest = this.openRequest;
    this.openRequest = null;
    openRequest?.deferred.reject(error);
    this.runtime.discardPendingOpenDescendants(this);
    for (const prompt of this.prompts.values()) prompt.reject(error);
    this.prompts.clear();
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

interface AdaptedPluginProvider {
  registration: ProviderRegistration;
  client: PluginAgentClient;
  definition: ProviderDefinition;
}

/** Owns the complete plugin-provider adaptation behind the existing core provider boundary. */
export class PluginAgentClientRegistry {
  private readonly providers = new Map<string, AdaptedPluginProvider>();

  constructor(private readonly logger: Logger) {}

  replace(registrations: readonly ProviderRegistration[]): void {
    const incoming = new Map<string, ProviderRegistration>();
    for (const registration of registrations) {
      if (incoming.has(registration.id)) {
        throw new Error(`Duplicate plugin provider ID: ${registration.id}`);
      }
      incoming.set(registration.id, registration);
    }

    for (const [id, adapted] of this.providers) {
      if (incoming.get(id) === adapted.registration) continue;
      this.providers.delete(id);
      void adapted.client.shutdown().catch((error) => {
        this.logger.warn({ err: error, provider: id }, "Failed to stop plugin provider");
      });
    }

    for (const [id, registration] of incoming) {
      if (this.providers.has(id)) continue;
      const client = new PluginAgentClient(registration);
      this.providers.set(id, {
        registration,
        client,
        definition: createPluginProviderDefinition(registration, client),
      });
    }
  }

  definitions(): Record<string, ProviderDefinition> {
    return Object.fromEntries(
      [...this.providers].map(([id, provider]) => [id, provider.definition]),
    );
  }

  clients(): Record<string, AgentClient> {
    return Object.fromEntries([...this.providers].map(([id, provider]) => [id, provider.client]));
  }

  has(provider: string): boolean {
    return this.providers.has(provider);
  }

  async shutdown(): Promise<void> {
    const providers = [...this.providers.values()];
    this.providers.clear();
    await Promise.all(providers.map(({ client }) => client.shutdown()));
  }
}

const PluginProviderOptionsSchema: z.ZodType<ProviderOptions> = z.record(z.string(), z.json());

function createPluginProviderDefinition(
  registration: ProviderRegistration,
  client: PluginAgentClient,
): ProviderDefinition {
  return {
    id: registration.id,
    configuration: null,
    label: registration.label,
    description: registration.description ?? `Plugin provider ${registration.label}`,
    iconSvg: registration.icon,
    defaultModeId: null,
    modes: [],
    enabled: true,
    derivedFromProviderId: null,
    optionsSchema: PluginProviderOptionsSchema,
    supportsExactMcpPreapproval: true,
    validateOptions: (options) =>
      options === undefined ? undefined : PluginProviderOptionsSchema.parse(options),
    applyOptions: (config, options) => ({ ...config, providerOptions: options }),
    applyToolPolicy: (config, toolPolicy) => ({ ...config, toolPolicy }),
    createClient: () => client,
    resolveCreateConfig: resolveDefaultAgentCreateConfig,
    isCreateConfigUnattended: isDefaultAgentCreateConfigUnattended,
    fetchCatalog: (options, _client, context) => client.fetchCatalog(options, context),
  };
}

interface PendingChild {
  session: ProviderRuntimeSession;
  opened: Extract<ProviderEvent, { type: "session.opened" }>;
}

class PluginAgentClient implements AgentClient {
  readonly provider: string;
  private readonly runtime: ProviderRuntime;
  private readonly rootsBySession = new Map<string, PluginAgentSession>();
  private readonly pendingChildren: PendingChild[] = [];

  readonly getCatalogCacheKey?: AgentClient["getCatalogCacheKey"];

  constructor(registration: ProviderRegistration) {
    this.getCatalogCacheKey = registration.getCatalogCacheKey?.bind(registration);
    this.provider = registration.id;
    this.runtime = new ProviderRuntime(registration);
    this.runtime.onSessionOpened((session, opened) => this.acceptChild(session, opened));
  }

  get capabilities(): AgentCapabilityFlags {
    return agentCapabilities(this.runtime.negotiatedCapabilities);
  }

  async createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
    options?: AgentCreateSessionOptions,
  ): Promise<AgentSession> {
    return await this.openSession({
      config,
      launchContext,
      history: "skip",
      persist: options?.persistSession !== false,
    });
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    if (!overrides?.cwd) {
      throw new Error(`Plugin provider '${this.provider}' requires cwd to resume a session`);
    }
    return await this.openSession({
      config: { ...overrides, provider: this.provider, cwd: overrides.cwd },
      launchContext,
      persistence: decodePersistence(handle),
      history: "replay",
      persist: true,
    });
  }

  async fetchCatalog(
    options: FetchCatalogOptions,
    context?: ProviderRefreshContext,
  ): Promise<ProviderCatalog> {
    const catalog = await this.runtime.catalog(
      options.scope === "workspace" ? options.cwd : undefined,
      context?.signal,
    );
    return {
      models: catalog.models.map((model) =>
        mapModel(
          this.provider,
          model,
          catalog.defaultModel,
          catalog.thinkingOptions,
          catalog.defaultThinkingOption,
        ),
      ),
      modes: catalog.modes.map((mode) => ({ ...mode })),
      defaultModeId: catalog.defaultMode,
    };
  }

  async isAvailable(signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    return await this.runtime.isAvailable();
  }

  async listImportableSessions(
    options: ListImportableSessionsOptions = {},
  ): Promise<ImportableProviderSession[]> {
    const sessions = await this.runtime.listSessions({
      query: options.query,
      cwd: options.cwd,
      limit: options.limit,
    });
    return sessions.map((session) => ({
      providerHandleId: encodePersistence(session.persistence),
      cwd: session.cwd,
      title: session.title ?? null,
      firstPromptPreview: null,
      lastPromptPreview: session.description ?? null,
      lastActivityAt: parseProviderDate(session.updatedAt),
    }));
  }

  async importSession(
    input: ImportProviderSessionInput,
    context: ImportProviderSessionContext,
  ): Promise<ImportedProviderSession> {
    const session = await this.openSession({
      config: { ...context.config, provider: this.provider, cwd: input.cwd },
      launchContext: context.launchContext,
      persistence: decodePersistenceId(input.providerHandleId),
      history: "replay",
      persist: true,
    });
    const persistence = session.describePersistence();
    if (!persistence) throw new Error(`Plugin provider '${this.provider}' did not persist import`);
    return {
      session,
      config: { ...context.config, provider: this.provider, cwd: input.cwd },
      persistence,
      timeline: session.timelineHistory(),
      providerSubagentEvents: session.subagentHistory(),
    };
  }

  async archiveNativeSession(handle: AgentPersistenceHandle): Promise<void> {
    await this.runtime.archive(decodePersistence(handle));
  }

  async unarchiveNativeSession(handle: AgentPersistenceHandle): Promise<void> {
    await this.runtime.unarchive(decodePersistence(handle));
  }

  async shutdown(): Promise<void> {
    await this.runtime.close();
  }

  private async openSession(input: {
    config: AgentSessionConfig;
    launchContext?: AgentLaunchContext;
    persistence?: ProviderPersistence;
    history: "replay" | "skip";
    persist: boolean;
  }): Promise<PluginAgentSession> {
    const sessionId = randomUUID();
    const bridge = await this.runtime.openSession({
      sessionId,
      config: mapSessionConfig(input.config, input.launchContext, input.persist),
      persistence: input.persistence,
      history: input.history,
    });
    const session = new PluginAgentSession(this.provider, bridge, () => {
      this.rootsBySession.delete(bridge.id);
    });
    this.rootsBySession.set(bridge.id, session);
    this.attachPendingChildren();
    return session;
  }

  private acceptChild(
    session: ProviderRuntimeSession,
    opened: Extract<ProviderEvent, { type: "session.opened" }>,
  ): void {
    const root = opened.parentSessionId
      ? this.rootsBySession.get(opened.parentSessionId)
      : undefined;
    if (!root) {
      this.pendingChildren.push({ session, opened });
      return;
    }
    root.attachChild(session, opened);
    this.rootsBySession.set(session.id, root);
    this.attachPendingChildren();
  }

  private attachPendingChildren(): void {
    let attached = true;
    while (attached) {
      attached = false;
      for (let index = this.pendingChildren.length - 1; index >= 0; index -= 1) {
        const pending = this.pendingChildren[index];
        const root = pending.opened.parentSessionId
          ? this.rootsBySession.get(pending.opened.parentSessionId)
          : undefined;
        if (!root) continue;
        this.pendingChildren.splice(index, 1);
        root.attachChild(pending.session, pending.opened);
        this.rootsBySession.set(pending.session.id, root);
        attached = true;
      }
    }
  }
}

class PluginAgentSession implements AgentSession {
  private readonly listeners = new Set<(event: AgentStreamEvent) => void>();
  private readonly history: AgentStreamEvent[] = [];
  private readonly pendingPermissions = new Map<string, AgentPermissionRequest>();
  private readonly permissionResponses = new Map<string, AgentPermissionResponse>();
  private readonly revertTokens = new Map<string, ProviderTimelineItem["revertToken"]>();
  private readonly timelineSnapshots = new Map<string, ProviderTimelineItem>();
  private readonly childUnsubscribes = new Map<string, () => void>();
  private readonly childSnapshots = new Map<string, Map<string, ProviderTimelineItem>>();
  private unsubscribe: (() => void) | null = null;
  private currentTurnId: string | null = null;
  private closed = false;

  constructor(
    readonly provider: string,
    private readonly bridge: ProviderRuntimeSession,
    private readonly onClose: () => void,
  ) {
    for (const event of bridge.history) this.accept(event, false);
    this.unsubscribe = bridge.onEvent((event) => this.accept(event, true));
  }

  get id(): string {
    return this.describePersistence()?.sessionId ?? this.bridge.id;
  }

  get capabilities(): AgentCapabilityFlags {
    return agentCapabilities(this.bridge.negotiatedCapabilities);
  }

  get features(): AgentFeature[] {
    return this.bridge.config.settings.map((setting) =>
      setting.type === "toggle"
        ? { ...setting }
        : {
            ...setting,
            options: setting.options.map((option) => ({ ...option, id: option.value })),
          },
    );
  }

  async run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    return await runProviderTurn({
      prompt,
      runOptions: options,
      startTurn: (nextPrompt, nextOptions) => this.startTurn(nextPrompt, nextOptions),
      subscribe: (callback) => this.subscribe(callback),
      getSessionId: () => this.id,
    });
  }

  async startTurn(
    prompt: AgentPromptInput,
    options: AgentRunOptions = {},
  ): Promise<{ turnId: string }> {
    const clientMessageId = options.clientMessageId ?? randomUUID();
    const result = await this.bridge.prompt({
      clientMessageId,
      delivery: "auto",
      input: mapPromptInput(prompt, this.bridge.commands),
      ...(options.outputSchema === undefined
        ? {}
        : { outputSchema: toJsonValue(options.outputSchema, "output schema") }),
    });
    if (result.type === "failed") throw providerError(result.error);
    if (result.type === "turn" || result.type === "steer") return { turnId: result.turnId };

    const turnId = `command-${clientMessageId}`;
    this.publish({ type: "turn_started", provider: this.provider, turnId });
    this.publish({ type: "turn_completed", provider: this.provider, turnId });
    return { turnId };
  }

  async steerActiveTurn(
    prompt: AgentPromptInput,
    options: SteerActiveTurnOptions,
  ): Promise<SteerResult> {
    const result = await this.bridge.prompt({
      clientMessageId: options.clientMessageId ?? randomUUID(),
      delivery: "steer",
      input: { type: "message", content: mapPromptContent(prompt) },
      ...(options.outputSchema === undefined
        ? {}
        : { outputSchema: toJsonValue(options.outputSchema, "output schema") }),
      clearPendingPermissions: options.clearPendingPermissions,
    });
    return result.type === "steer" && result.turnId === options.expectedTurnId
      ? { status: "accepted" }
      : { status: "unavailable" };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    for (const event of this.history) yield event;
  }

  async getRuntimeInfo() {
    return {
      provider: this.provider,
      sessionId: this.id,
      model: this.bridge.config.model ?? null,
      modeId: this.bridge.config.mode ?? null,
      thinkingOptionId: this.bridge.config.thinkingOption ?? null,
    };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return this.bridge.config.modes.map((mode) => ({ ...mode }));
  }

  async getCurrentMode(): Promise<string | null> {
    return this.bridge.config.mode ?? null;
  }

  async setMode(modeId: string): Promise<void> {
    await this.bridge.configure({ mode: modeId });
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return [...this.pendingPermissions.values()];
  }

  async respondToPermission(requestId: string, response: AgentPermissionResponse): Promise<void> {
    this.permissionResponses.set(requestId, response);
    try {
      await this.bridge.respondToPermission(
        requestId,
        toJsonValue(response, "permission response") as Extract<
          ProviderInput,
          { type: "session.permission" }
        >["response"],
      );
    } catch (error) {
      this.permissionResponses.delete(requestId);
      throw error;
    }
  }

  describePersistence(): AgentPersistenceHandle | null {
    return this.bridge.persistence
      ? persistenceHandle(this.provider, this.bridge.persistence)
      : null;
  }

  async interrupt(): Promise<void> {
    await this.bridge.interrupt();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const unsubscribe of this.childUnsubscribes.values()) unsubscribe();
    this.childUnsubscribes.clear();
    this.listeners.clear();
    this.onClose();
    await this.bridge.close();
  }

  async listCommands(): Promise<AgentSlashCommand[]> {
    return this.bridge.commands.map((command) => ({
      ...command,
      argumentHint: command.argumentHint ?? "",
      kind: "command",
    }));
  }

  async setModel(modelId: string | null): Promise<void> {
    await this.bridge.configure({ model: modelId });
  }

  async setThinkingOption(thinkingOptionId: string | null): Promise<void> {
    await this.bridge.configure({ thinkingOption: thinkingOptionId });
  }

  async setFeature(featureId: string, value: unknown): Promise<void> {
    await this.bridge.configure({
      settings: { [featureId]: toJsonValue(value, `setting '${featureId}'`) },
    });
  }

  async revertConversation(input: { messageId: string }): Promise<void> {
    await this.revert(input.messageId, "conversation");
  }

  async revertFiles(input: { messageId: string }): Promise<void> {
    await this.revert(input.messageId, "files");
  }

  async revertBoth(input: { messageId: string }): Promise<void> {
    await this.revert(input.messageId, "both");
  }

  timelineHistory(): ImportedProviderSession["timeline"] {
    return this.history.flatMap((event) =>
      event.type === "timeline" ? [{ item: event.item, timestamp: event.timestamp }] : [],
    );
  }

  subagentHistory(): NonNullable<ImportedProviderSession["providerSubagentEvents"]> {
    return this.history.filter(
      (event): event is Extract<AgentStreamEvent, { type: "provider_subagent" }> =>
        event.type === "provider_subagent",
    );
  }

  attachChild(
    child: ProviderRuntimeSession,
    opened: Extract<ProviderEvent, { type: "session.opened" }>,
  ): void {
    const childId = child.providerId;
    this.publish({
      type: "provider_subagent",
      provider: this.provider,
      event: {
        type: "upsert",
        id: childId,
        title: opened.title ?? null,
        description: opened.description ?? null,
        status: "running",
        cwd: opened.cwd,
      },
    });
    const snapshots = new Map<string, ProviderTimelineItem>();
    this.childSnapshots.set(childId, snapshots);
    for (const event of child.history) this.acceptChildEvent(childId, event, snapshots);
    this.childUnsubscribes.set(
      child.id,
      child.onEvent((event) => this.acceptChildEvent(childId, event, snapshots)),
    );
  }

  private accept(event: ProviderEvent, live: boolean): void {
    const translated = this.translate(event);
    for (const next of translated) {
      this.history.push(next);
      if (live) this.emit(next);
    }
  }

  private translate(event: ProviderEvent): AgentStreamEvent[] {
    switch (event.type) {
      case "session.turn":
        return [this.translateTurn(event)];
      case "session.usage":
        return [
          {
            type: "usage_updated",
            provider: this.provider,
            usage: { ...event.usage },
            turnId: event.turnId,
          },
        ];
      case "timeline.item":
        return this.translateTimeline(event);
      case "session.permission":
        return [this.translatePermission(event)];
      case "session.permission_resolved":
        return [this.translatePermissionResolution(event)];
      case "session.config":
        return this.translateConfig(event);
      case "session.notice":
        return this.translateNotice(event);
      case "session.runtime_failed":
        return [this.translateFailure(event.error)];
      case "session.closed":
        return event.error ? [this.translateFailure(event.error)] : [];
      default:
        return [];
    }
  }

  private translateTurn(event: Extract<ProviderEvent, { type: "session.turn" }>): AgentStreamEvent {
    if (event.state === "started") {
      this.currentTurnId = event.turnId;
      return { type: "turn_started", provider: this.provider, turnId: event.turnId };
    }
    if (this.currentTurnId === event.turnId) this.currentTurnId = null;
    if (event.state === "completed") {
      return { type: "turn_completed", provider: this.provider, turnId: event.turnId };
    }
    if (event.state === "canceled") {
      return {
        type: "turn_canceled",
        provider: this.provider,
        turnId: event.turnId,
        reason: event.error?.message ?? "Canceled by provider",
      };
    }
    return {
      type: "turn_failed",
      provider: this.provider,
      turnId: event.turnId,
      error: event.error?.message ?? "Provider turn failed",
      code: event.error?.code,
      diagnostic: event.error?.diagnostic,
    };
  }

  private translateTimeline(
    event: Extract<ProviderEvent, { type: "timeline.item" }>,
  ): AgentStreamEvent[] {
    const item = mapTimelineItem(event.item, this.timelineSnapshots, this.revertTokens);
    return item
      ? [
          {
            type: "timeline",
            provider: this.provider,
            item,
            turnId: this.currentTurnId ?? undefined,
            timestamp: event.timestamp,
          },
        ]
      : [];
  }

  private translatePermission(
    event: Extract<ProviderEvent, { type: "session.permission" }>,
  ): AgentStreamEvent {
    const request: AgentPermissionRequest = { ...event.request, provider: this.provider };
    this.pendingPermissions.set(request.id, request);
    return {
      type: "permission_requested",
      provider: this.provider,
      request,
      turnId: this.currentTurnId ?? undefined,
    };
  }

  private translatePermissionResolution(
    event: Extract<ProviderEvent, { type: "session.permission_resolved" }>,
  ): AgentStreamEvent {
    this.pendingPermissions.delete(event.permissionId);
    const resolution = this.permissionResponses.get(event.permissionId) ?? {
      behavior: "deny" as const,
      message: "Resolved by provider",
    };
    this.permissionResponses.delete(event.permissionId);
    return {
      type: "permission_resolved",
      provider: this.provider,
      requestId: event.permissionId,
      resolution,
      turnId: this.currentTurnId ?? undefined,
    };
  }

  private translateConfig(
    event: Extract<ProviderEvent, { type: "session.config" }>,
  ): AgentStreamEvent[] {
    return [
      {
        type: "mode_changed",
        provider: this.provider,
        currentModeId: event.config.mode ?? null,
        availableModes: event.config.modes.map((mode) => ({ ...mode })),
      },
      {
        type: "model_changed",
        provider: this.provider,
        runtimeInfo: {
          provider: this.provider,
          sessionId: this.id,
          model: event.config.model ?? null,
          modeId: event.config.mode ?? null,
          thinkingOptionId: event.config.thinkingOption ?? null,
        },
      },
      {
        type: "thinking_option_changed",
        provider: this.provider,
        thinkingOptionId: event.config.thinkingOption ?? null,
      },
    ];
  }

  private translateNotice(
    event: Extract<ProviderEvent, { type: "session.notice" }>,
  ): AgentStreamEvent[] {
    if (event.notice.dismissed) return [];
    return [
      {
        type: "timeline",
        provider: this.provider,
        item: {
          type: "notification",
          level: event.notice.severity,
          message: [event.notice.title, event.notice.description].filter(Boolean).join("\n"),
        },
        turnId: this.currentTurnId ?? undefined,
      },
    ];
  }

  private translateFailure(error: ProviderError): AgentStreamEvent {
    return {
      type: "turn_failed",
      provider: this.provider,
      turnId: this.currentTurnId ?? undefined,
      error: error.message,
      code: error.code,
      diagnostic: error.diagnostic,
    };
  }

  private acceptChildEvent(
    childId: string,
    event: ProviderEvent,
    snapshots: Map<string, ProviderTimelineItem>,
  ): void {
    if (event.type === "timeline.item") {
      const item = mapTimelineItem(event.item, snapshots);
      if (item) {
        this.publish({
          type: "provider_subagent",
          provider: this.provider,
          event: { type: "timeline", id: childId, item, timestamp: event.timestamp },
        });
      }
      return;
    }
    if (event.type === "session.turn" && event.state !== "started") {
      this.publish({
        type: "provider_subagent",
        provider: this.provider,
        event: { type: "upsert", id: childId, status: event.state },
      });
      return;
    }
    if (event.type === "session.runtime_failed" || event.type === "session.closed") {
      this.publish({
        type: "provider_subagent",
        provider: this.provider,
        event: {
          type: "upsert",
          id: childId,
          status: event.type === "session.runtime_failed" || event.error ? "failed" : "completed",
        },
      });
    }
  }

  private async revert(messageId: string, scope: "conversation" | "files" | "both") {
    const token = this.revertTokens.get(messageId);
    if (token === undefined) throw new Error(`No provider revert token for message ${messageId}`);
    await this.bridge.revert({
      type: "session.revert",
      requestId: randomUUID(),
      sessionId: this.bridge.providerId,
      token,
      scope,
    });
  }

  private publish(event: AgentStreamEvent): void {
    this.history.push(event);
    this.emit(event);
  }

  private emit(event: AgentStreamEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function agentCapabilities(capabilities: readonly string[]): AgentCapabilityFlags {
  const supports = (capability: ProviderCapability) => capabilities.includes(capability);
  return {
    supportsStreaming: true,
    supportsSessionPersistence: supports("session.persistence"),
    supportsSessionListing: supports("session.list"),
    supportsDynamicModes: supports("session.configure"),
    supportsMcpServers: true,
    supportsNativePaseoTools: false,
    supportsReasoningStream: true,
    supportsToolInvocations: true,
    supportsRewindConversation: supports("session.revert.conversation"),
    supportsRewindFiles: supports("session.revert.files"),
    supportsRewindBoth: supports("session.revert.both"),
  };
}

function mapModel(
  provider: string,
  model: Extract<ProviderEvent, { type: "catalog" }>["catalog"]["models"][number],
  defaultModel: string | undefined,
  catalogThinkingOptions: Extract<ProviderEvent, { type: "catalog" }>["catalog"]["thinkingOptions"],
  catalogDefaultThinkingOption: string | undefined,
): AgentModelDefinition {
  const thinkingOptions = model.thinkingOptions ?? catalogThinkingOptions;
  return {
    ...model,
    provider,
    isDefault: model.isDefault ?? model.id === defaultModel,
    metadata: model.metadata ? { ...model.metadata } : undefined,
    thinkingOptions: thinkingOptions?.map((option) => Object.assign({}, option)),
    defaultThinkingOptionId: model.defaultThinkingOptionId ?? catalogDefaultThinkingOption,
  };
}

function mapSessionConfig(
  config: AgentSessionConfig,
  launchContext: AgentLaunchContext | undefined,
  persist: boolean,
): ProviderSessionConfig {
  return {
    cwd: config.cwd,
    env: { ...launchContext?.env },
    systemPrompt: combineSystemPrompts(config.systemPrompt, config.daemonAppendSystemPrompt),
    mcpServers: { ...config.mcpServers },
    toolPolicy: config.toolPolicy
      ? { preapproved: config.toolPolicy.preapproved.map((grant) => ({ ...grant })) }
      : undefined,
    model: config.model,
    mode: config.modeId,
    thinkingOption: config.thinkingOptionId,
    settings: toJsonObject(config.featureValues ?? {}, "provider settings"),
    providerOptions: config.providerOptions
      ? toJsonObject(config.providerOptions, "provider options")
      : undefined,
    title: config.title ?? undefined,
    persist,
  };
}

function combineSystemPrompts(
  systemPrompt: string | undefined,
  daemonPrompt: string | undefined,
): string | undefined {
  const parts = [systemPrompt, daemonPrompt].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function mapPromptInput(
  prompt: AgentPromptInput,
  commands: readonly { name: string }[],
): ProviderPrompt["input"] {
  if (typeof prompt === "string" && prompt.startsWith("/")) {
    const separator = prompt.indexOf(" ");
    const name = prompt.slice(1, separator === -1 ? undefined : separator);
    if (commands.some((command) => command.name === name)) {
      return {
        type: "command",
        name,
        arguments: separator === -1 ? "" : prompt.slice(separator + 1),
      };
    }
  }
  return { type: "message", content: mapPromptContent(prompt) };
}

function mapPromptContent(prompt: AgentPromptInput): ProviderContent[] {
  const content = typeof prompt === "string" ? [{ type: "text" as const, text: prompt }] : prompt;
  return toJsonValue(content, "prompt content") as ProviderContent[];
}

function mapTimelineItem(
  item: ProviderTimelineItem,
  snapshots: Map<string, ProviderTimelineItem>,
  revertTokens?: Map<string, ProviderTimelineItem["revertToken"]>,
): AgentTimelineItem | null {
  const previous = snapshots.get(item.id);
  snapshots.set(item.id, item);
  const { id, revertToken, ...withoutIdentity } = item;
  if (revertToken !== undefined && revertTokens) {
    revertTokens.set(id, revertToken);
    if (item.type === "user_message" || item.type === "assistant_message") {
      revertTokens.set(item.messageId ?? id, revertToken);
    }
  }

  if (item.type === "assistant_message" || item.type === "reasoning") {
    const previousText = previous?.type === item.type ? previous.text : "";
    const text = item.text.startsWith(previousText)
      ? item.text.slice(previousText.length)
      : item.text;
    if (text.length === 0) return null;
    return item.type === "assistant_message"
      ? { type: "assistant_message", text, messageId: item.messageId ?? id }
      : { type: "reasoning", text };
  }
  if (item.type === "user_message") {
    if (previous?.type === "user_message" && previous.text === item.text) return null;
    return {
      type: "user_message",
      text: item.text,
      messageId: item.messageId ?? id,
      clientMessageId: item.clientMessageId,
    };
  }
  if (item.type === "plugin") {
    return {
      type: "plugin",
      id,
      pluginId: item.pluginId,
      kind: item.kind,
      version: item.version,
      data: item.data,
    };
  }
  return withoutIdentity as AgentTimelineItem;
}

function persistenceHandle(
  provider: string,
  persistence: ProviderPersistence,
): AgentPersistenceHandle {
  return {
    provider,
    sessionId: encodePersistence(persistence),
    metadata: { pluginProviderPersistence: persistence },
  };
}

function encodePersistence(persistence: ProviderPersistence): string {
  return `plugin:${JSON.stringify(persistence)}`;
}

function decodePersistence(handle: AgentPersistenceHandle): ProviderPersistence {
  const fromMetadata = handle.metadata?.pluginProviderPersistence;
  if (fromMetadata !== undefined) {
    return ProviderPersistenceSchema.parse(fromMetadata);
  }
  return decodePersistenceId(handle.sessionId);
}

const ProviderPersistenceSchema: z.ZodType<ProviderPersistence> = z
  .object({ version: z.number().int().nonnegative(), data: z.json() })
  .strict();

function decodePersistenceId(id: string): ProviderPersistence {
  if (!id.startsWith("plugin:")) throw new Error("Invalid plugin provider persistence handle");
  return ProviderPersistenceSchema.parse(JSON.parse(id.slice("plugin:".length)));
}

function parseProviderDate(value: string | undefined): Date {
  const timestamp = value ? Date.parse(value) : Number.NaN;
  return new Date(Number.isFinite(timestamp) ? timestamp : 0);
}

function toJsonObject(value: unknown, label: string): Record<string, JsonValue> {
  const encoded = toJsonValue(value, label);
  if (typeof encoded !== "object" || encoded === null || Array.isArray(encoded)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return encoded as Record<string, JsonValue>;
}

function toJsonValue(value: unknown, label: string): JsonValue {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error(`${label} must be JSON-serializable`);
  return JSON.parse(encoded) as JsonValue;
}
