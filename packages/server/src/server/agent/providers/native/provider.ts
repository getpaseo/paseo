import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  PROVIDER_PROTOCOL_VERSION,
  ProviderEventSchema,
  ProviderInputSchema,
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderCapability,
  type ProviderConfigChanges,
  type ProviderConfigState,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderPersistence,
  type ProviderPrompt,
  type ProviderRegistration,
  type ProviderSessionConfig,
  type ProviderTimelineItem,
} from "@getpaseo/plugin/provider";
import type {
  AgentClient,
  AgentFeature,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentProviderNotice,
  AgentProvider,
  ProviderCatalog as AgentProviderCatalog,
  FetchCatalogOptions,
  AgentRuntimeInfo,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  AgentTimelineItem,
} from "../../agent-sdk-types.js";
import type { ToolPolicy } from "@getpaseo/protocol/agent-types";
import { ProviderOptionsValidationError } from "../../provider-options.js";

export interface NativeProviderRegistrationOptions {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  createClient(): AgentClient;
  prepareToolPolicy?(toolPolicy: ToolPolicy): ToolPolicy;
  transformConfig?(config: AgentSessionConfig): AgentSessionConfig;
  fetchCatalog?(client: AgentClient, options: FetchCatalogOptions): Promise<AgentProviderCatalog>;
}

export function wrapNativeSessionProvider(
  provider: AgentProvider,
  inner: AgentSession,
): AgentSession {
  return {
    provider,
    id: inner.id,
    capabilities: inner.capabilities,
    get features() {
      return inner.features;
    },
    run: (prompt, options) => inner.run(prompt, options),
    startTurn: (prompt, options) => inner.startTurn(prompt, options),
    subscribe: (callback) =>
      inner.subscribe((event) => callback({ ...event, provider } as AgentStreamEvent)),
    async *streamHistory() {
      for await (const event of inner.streamHistory()) {
        yield { ...event, provider } as AgentStreamEvent;
      }
    },
    getRuntimeInfo: async () =>
      ({ ...(await inner.getRuntimeInfo()), provider }) as AgentRuntimeInfo,
    getAvailableModes: () => inner.getAvailableModes(),
    getCurrentMode: () => inner.getCurrentMode(),
    setMode: (modeId) => inner.setMode(modeId),
    getPendingPermissions: () => inner.getPendingPermissions(),
    respondToPermission: (requestId, response) => inner.respondToPermission(requestId, response),
    describePersistence: () => {
      const handle = inner.describePersistence();
      return handle ? { ...handle, provider } : null;
    },
    interrupt: () => inner.interrupt(),
    close: () => inner.close(),
    listCommands: inner.listCommands?.bind(inner),
    setModel: inner.setModel?.bind(inner),
    setThinkingOption: inner.setThinkingOption?.bind(inner),
    setFeature: inner.setFeature?.bind(inner),
    revertConversation: inner.revertConversation?.bind(inner),
    revertFiles: inner.revertFiles?.bind(inner),
    revertBoth: inner.revertBoth?.bind(inner),
    tryHandleOutOfBand: inner.tryHandleOutOfBand?.bind(inner),
  };
}

export function relabelNativeClient(
  provider: AgentProvider,
  inner: AgentClient,
  mapModels: (models: AgentProviderCatalog["models"]) => AgentProviderCatalog["models"],
): AgentClient {
  const listImportableSessions = inner.listImportableSessions?.bind(inner);
  const importSession = inner.importSession?.bind(inner);
  const listFeatures = inner.listFeatures?.bind(inner);
  return {
    provider,
    capabilities: inner.capabilities,
    createSession: async (config, launchContext) => {
      try {
        return wrapNativeSessionProvider(
          provider,
          await inner.createSession({ ...config, provider: inner.provider }, launchContext),
        );
      } catch (error) {
        throw relabelProviderOptionsError(provider, error);
      }
    },
    resumeSession: async (handle, overrides, launchContext, options) => {
      try {
        return wrapNativeSessionProvider(
          provider,
          await inner.resumeSession(
            { ...handle, provider: inner.provider },
            overrides ? { ...overrides, provider: inner.provider } : undefined,
            launchContext,
            options,
          ),
        );
      } catch (error) {
        throw relabelProviderOptionsError(provider, error);
      }
    },
    fetchCatalog: async (options, context) => {
      const catalog = await inner.fetchCatalog(options, context);
      return { ...catalog, models: mapModels(catalog.models) };
    },
    resolveDefaultModeId: inner.resolveDefaultModeId
      ? async ({ config, env, signal }) =>
          await inner.resolveDefaultModeId?.({
            config: { ...config, provider: inner.provider },
            env,
            signal,
          })
      : undefined,
    resolveCreateConfig: inner.resolveCreateConfig?.bind(inner),
    resolveConfiguredModel: inner.resolveConfiguredModel?.bind(inner),
    isCreateConfigUnattended: inner.isCreateConfigUnattended?.bind(inner),
    listFeatures: listFeatures
      ? async (config) => await listFeatures({ ...config, provider: inner.provider })
      : undefined,
    listImportableSessions: listImportableSessions
      ? async (options) => await listImportableSessions(options)
      : undefined,
    importSession: importSession
      ? async (input, context) => {
          const imported = await importSession(input, {
            ...context,
            config: { ...context.config, provider: inner.provider },
            storedConfig: { ...context.storedConfig, provider: inner.provider },
          });
          return {
            ...imported,
            session: wrapNativeSessionProvider(provider, imported.session),
            config: { ...imported.config, provider },
            persistence: { ...imported.persistence, provider },
          };
        }
      : undefined,
    isAvailable: (signal) => inner.isAvailable(signal),
    getDiagnostic: inner.getDiagnostic?.bind(inner),
  };
}

function relabelProviderOptionsError(provider: string, error: unknown): unknown {
  return error instanceof ProviderOptionsValidationError
    ? new ProviderOptionsValidationError(provider, error.issues)
    : error;
}

const BASE_CAPABILITIES: readonly ProviderCapability[] = [
  "prompt.message",
  "prompt.command",
  "session.reload",
  "permission",
  "timeline.plugin",
];

export function registerNativeProvider(
  options: NativeProviderRegistrationOptions,
): ProviderRegistration {
  return {
    id: options.id,
    label: options.label,
    description: options.description,
    icon: options.icon,
    async connect(request) {
      if (!request.versions.includes(PROVIDER_PROTOCOL_VERSION)) {
        throw new Error(`Native provider requires protocol ${PROVIDER_PROTOCOL_VERSION}`);
      }
      const client = options.createClient();
      if (!(await client.isAvailable())) {
        await client.shutdown?.();
        throw new Error(`Provider '${options.id}' is not available`);
      }
      return NativeProviderConnection.create(
        client,
        request.capabilities,
        options.prepareToolPolicy,
        options.transformConfig,
        options.fetchCatalog,
      );
    },
  };
}

class NativeProviderConnection implements ProviderConnection {
  readonly version = PROVIDER_PROTOCOL_VERSION;
  readonly capabilities: readonly string[];
  private readonly listeners = new Set<(event: ProviderEvent) => void>();
  private readonly sessions = new Map<string, NativeBoundarySession>();
  private readonly inFlight = new Set<Promise<void>>();
  private closed = false;
  private closePromise: Promise<void> | null = null;

  static create(
    client: AgentClient,
    offered: readonly string[],
    prepareToolPolicy: NativeProviderRegistrationOptions["prepareToolPolicy"],
    transformConfig: (config: AgentSessionConfig) => AgentSessionConfig = (config) => config,
    fetchCatalog?: NativeProviderRegistrationOptions["fetchCatalog"],
  ): NativeProviderConnection {
    const supported = nativeConnectionCapabilities(client, prepareToolPolicy !== undefined);
    return new NativeProviderConnection(
      client,
      negotiateProviderCapabilities(offered, supported),
      (config) =>
        transformConfig({
          ...config,
          toolPolicy:
            config.toolPolicy && prepareToolPolicy
              ? prepareToolPolicy(config.toolPolicy)
              : config.toolPolicy,
        }),
      fetchCatalog,
    );
  }

  private constructor(
    private readonly client: AgentClient,
    capabilities: readonly string[],
    private readonly transformConfig: (config: AgentSessionConfig) => AgentSessionConfig,
    private readonly fetchCatalog: NativeProviderRegistrationOptions["fetchCatalog"],
  ) {
    this.capabilities = capabilities;
  }

  async send(input: ProviderInput): Promise<void> {
    input = ProviderInputSchema.parse(input);
    if (this.closed) throw new Error("Provider connection is closed");
    this.validateAdmission(input);
    const operation = Promise.resolve().then(async () => {
      if (this.closed) return undefined;
      await (input.type === "session.prompt"
        ? this.sessions.get(input.sessionId)!.admitPrompt(input.prompt)
        : this.perform(input));
      return undefined;
    });
    const settled = operation.catch((error) => this.fail(input, error));
    this.inFlight.add(settled);
    void settled.finally(() => this.inFlight.delete(settled));
  }

  onEvent(listener: (event: ProviderEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      await Promise.all(this.inFlight);
      const sessions = [...this.sessions.values()];
      this.sessions.clear();
      await Promise.all(sessions.map((session) => session.dispose()));
      await this.client.shutdown?.();
      this.listeners.clear();
    })();
    return this.closePromise;
  }

  isClosed(): boolean {
    return this.closed;
  }

  emit(event: unknown): void {
    if (this.closed) return;
    const parsed = ProviderEventSchema.parse(event);
    for (const listener of this.listeners) listener(parsed);
  }

  failSession(sessionId: string, error: Error): void {
    this.sessions.delete(sessionId);
    this.emit({
      type: "session.runtime_failed",
      sessionId,
      error: { message: error.message },
    });
  }

  private validateAdmission(input: ProviderInput): void {
    if (input.type === "session.open") {
      if (this.sessions.has(input.sessionId))
        throw new Error(`Session already exists: ${input.sessionId}`);
      requireProviderCapabilities(this.capabilities, input);
      return;
    }
    if (!("sessionId" in input)) {
      requireProviderCapabilities(this.capabilities, input);
      return;
    }
    const session = this.sessions.get(input.sessionId);
    if (!session) throw new Error(`Unknown session: ${input.sessionId}`);
    session.validateAdmission(input);
  }

  private async perform(input: ProviderInput): Promise<void> {
    switch (input.type) {
      case "catalog":
        await this.catalog(input);
        return;
      case "sessions":
        await this.listSessions(input);
        return;
      case "session.open":
        await this.open(input);
        return;
      case "session.reload": {
        const session = this.sessions.get(input.sessionId)!;
        await session.mutate(() => session.reload(input.requestId, input.config));
        return;
      }
      case "session.interrupt":
        await this.sessions.get(input.sessionId)!.interrupt();
        this.emit({ type: "request.completed", requestId: input.requestId });
        return;
      case "session.permission":
        await this.sessions
          .get(input.sessionId)!
          .respondToPermission(input.permissionId, input.response);
        return;
      case "session.configure": {
        const session = this.sessions.get(input.sessionId)!;
        await session.mutate(() => session.configure(input.requestId, input.changes));
        return;
      }
      case "session.revert":
        await this.sessions.get(input.sessionId)!.revert(input);
        return;
      case "session.archive":
        await this.client.archiveNativeSession?.(
          toNativeHandle(this.client.provider, input.persistence),
        );
        this.emit({ type: "request.completed", requestId: input.requestId });
        return;
      case "session.unarchive":
        await this.client.unarchiveNativeSession?.(
          toNativeHandle(this.client.provider, input.persistence),
        );
        this.emit({ type: "request.completed", requestId: input.requestId });
        return;
      case "session.close": {
        const session = this.sessions.get(input.sessionId)!;
        this.sessions.delete(input.sessionId);
        await session.dispose();
        this.emit({ type: "session.closed", sessionId: input.sessionId });
        this.emit({ type: "request.completed", requestId: input.requestId });
        return;
      }
      case "session.prompt":
        return;
    }
  }

  private async catalog(input: Extract<ProviderInput, { type: "catalog" }>): Promise<void> {
    const options: FetchCatalogOptions = input.cwd
      ? { scope: "workspace", cwd: input.cwd, force: false }
      : { scope: "global", force: false };
    const catalog = this.fetchCatalog
      ? await this.fetchCatalog(this.client, options)
      : await this.client.fetchCatalog(options);
    this.emit({
      type: "catalog",
      requestId: input.requestId,
      catalog: {
        models: catalog.models.map(({ provider: _provider, ...model }) => model),
        modes: catalog.modes,
        defaultMode: catalog.defaultModeId ?? undefined,
      },
    });
  }

  private async listSessions(input: Extract<ProviderInput, { type: "sessions" }>): Promise<void> {
    const sessions = await this.client.listImportableSessions?.({
      cwd: input.cwd,
      limit: input.limit,
    });
    this.emit({
      type: "sessions",
      requestId: input.requestId,
      sessions: (sessions ?? []).map((session) => ({
        persistence: {
          version: 1,
          data: {
            kind: "import",
            providerHandleId: session.providerHandleId,
            cwd: session.cwd,
          },
        },
        cwd: session.cwd,
        title: session.title ?? undefined,
        description: session.firstPromptPreview ?? undefined,
        updatedAt: session.lastActivityAt.toISOString(),
      })),
    });
  }

  private async open(input: Extract<ProviderInput, { type: "session.open" }>): Promise<void> {
    const opened = await openNativeSession(this.client, input, this.transformConfig);
    if (this.closed) {
      await opened.session.close().catch(() => undefined);
      return;
    }
    try {
      requireNativeSessionConfigSupport(opened.session, input.config);
    } catch (error) {
      await opened.session.close().catch(() => undefined);
      throw error;
    }
    const boundary = new NativeBoundarySession(
      this,
      this.client,
      input.sessionId,
      opened.session,
      input.config,
      this.transformConfig,
    );
    this.sessions.set(input.sessionId, boundary);
    try {
      await boundary.publishOpen(input.requestId, opened.history);
    } catch (error) {
      if (this.sessions.get(input.sessionId) === boundary) {
        this.sessions.delete(input.sessionId);
      }
      await boundary.dispose().catch(() => undefined);
      throw error;
    }
  }

  private fail(input: ProviderInput, error: unknown): void {
    const providerFailure = { message: error instanceof Error ? error.message : String(error) };
    if (input.type === "session.prompt") {
      this.emit({
        type: "session.prompt_result",
        sessionId: input.sessionId,
        clientMessageId: input.prompt.clientMessageId,
        result: { type: "failed", error: providerFailure },
      });
      return;
    }
    if ("requestId" in input) {
      this.emit({ type: "request.failed", requestId: input.requestId, error: providerFailure });
      return;
    }
    if ("sessionId" in input) {
      this.emit({
        type: "session.runtime_failed",
        sessionId: input.sessionId,
        error: providerFailure,
      });
    }
  }
}

class NativeBoundarySession {
  session: AgentSession;
  private unsubscribe: (() => void) | null = null;
  private acceptingEvents = true;
  private activeTurnId: string | null = null;
  private readonly interruptedTurnIds = new Set<string>();
  private timelineSequence = 0;
  private readonly timelineSnapshots = new Map<string, ProviderTimelineItem>();
  private readonly activeTextItems = new Map<
    string,
    { type: "assistant_message" | "reasoning"; turnId?: string; id: string }
  >();
  private readonly childSessions = new Set<string>();
  private config: ProviderSessionConfig;
  private configTransaction = false;
  private mutationLane: Promise<void> = Promise.resolve();
  private publishedConfig: ProviderConfigState = {
    models: [],
    modes: [],
    thinkingOptions: [],
    settings: [],
  };

  constructor(
    private readonly owner: NativeProviderConnection,
    private readonly client: AgentClient,
    readonly id: string,
    session: AgentSession,
    config: ProviderSessionConfig,
    private readonly transformConfig: (config: AgentSessionConfig) => AgentSessionConfig,
  ) {
    this.session = session;
    this.config = config;
    this.subscribe(session);
  }

  validateAdmission(input: ProviderInput & { sessionId: string }): void {
    const capabilities = nativeSessionCapabilities(this.owner.capabilities, this.session);
    requireProviderCapabilities(capabilities, input);
    if (input.type === "session.configure") {
      if (input.changes.model !== undefined && !this.session.setModel) {
        throw new Error("Provider session cannot configure model");
      }
      if (input.changes.mode !== undefined) {
        if (input.changes.mode === null) throw new Error("Provider session cannot clear mode");
        if (!this.session.setMode) throw new Error("Provider session cannot configure mode");
      }
      if (input.changes.thinkingOption !== undefined && !this.session.setThinkingOption) {
        throw new Error("Provider session cannot configure thinking option");
      }
      if (Object.keys(input.changes.settings ?? {}).length > 0 && !this.session.setFeature) {
        throw new Error("Provider session cannot configure settings");
      }
    }
    if (input.type === "session.revert") {
      if (!supportsNativeRevertScope(this.session, input.scope)) {
        throw new Error(`Provider session cannot revert ${input.scope}`);
      }
    }
  }

  mutate(operation: () => Promise<void>): Promise<void> {
    const result = this.mutationLane.then(operation);
    this.mutationLane = result.catch(() => undefined);
    return result;
  }

  async publishOpen(requestId: string, history: readonly AgentStreamEvent[]): Promise<void> {
    this.owner.emit({
      type: "session.opened",
      requestId,
      sessionId: this.id,
      capabilities: nativeSessionCapabilities(this.owner.capabilities, this.session),
      restoration: "core",
      persistence: persistenceOf(this.session),
      cwd: this.config.cwd,
      title: this.config.title ?? undefined,
    });
    for (const event of history) this.forward(event);
    await this.publishConfig();
    const commands = await this.session.listCommands?.();
    if (commands) {
      this.owner.emit({ type: "session.commands", sessionId: this.id, commands });
    }
    this.owner.emit({ type: "session.ready", requestId, sessionId: this.id });
  }

  async admitPrompt(prompt: ProviderPrompt): Promise<void> {
    const legacyPrompt = toLegacyPrompt(prompt);
    if (prompt.delivery === "steer") {
      const expectedTurnId = this.activeTurnId;
      if (!expectedTurnId || !this.session.steerActiveTurn) {
        throw new Error("Steering is not available for this session");
      }
      const result = await this.session.steerActiveTurn(legacyPrompt, {
        expectedTurnId,
        clientMessageId: prompt.clientMessageId,
        outputSchema: prompt.outputSchema,
        maxThinkingTokens: prompt.maxThinkingTokens,
        clearPendingPermissions: prompt.clearPendingPermissions,
      });
      this.owner.emit({
        type: "session.prompt_result",
        sessionId: this.id,
        clientMessageId: prompt.clientMessageId,
        result:
          result.status === "accepted"
            ? { type: "steer", turnId: expectedTurnId }
            : { type: "failed", error: { message: "Steering is not available" } },
      });
      return;
    }
    const outOfBand = this.session.tryHandleOutOfBand?.(legacyPrompt);
    if (outOfBand) {
      queueMicrotask(() => {
        void outOfBand.run({ emit: (event) => this.forward(event) }).then(
          () => {
            this.owner.emit({
              type: "session.prompt_result",
              sessionId: this.id,
              clientMessageId: prompt.clientMessageId,
              result: { type: "completed" },
            });
            return undefined;
          },
          (error) => {
            this.owner.emit({
              type: "session.prompt_result",
              sessionId: this.id,
              clientMessageId: prompt.clientMessageId,
              result: { type: "failed", error: { message: describeError(error) } },
            });
            return undefined;
          },
        );
      });
      return;
    }
    if (this.activeTurnId) await this.interrupt();
    const result = await this.session.startTurn(legacyPrompt, {
      clientMessageId: prompt.clientMessageId,
      outputSchema: prompt.outputSchema,
      maxThinkingTokens: prompt.maxThinkingTokens,
    });
    this.activeTurnId = result.turnId;
    this.owner.emit({
      type: "session.prompt_result",
      sessionId: this.id,
      clientMessageId: prompt.clientMessageId,
      result: { type: "turn", turnId: result.turnId },
    });
  }

  async reload(requestId: string, config: ProviderSessionConfig): Promise<void> {
    const persistence = this.session.describePersistence();
    const candidate = persistence
      ? await this.client.resumeSession(
          persistence,
          this.transformConfig(toLegacyConfig(this.client.provider, config)),
          {
            env: { ...config.env },
            agentId: this.id,
          },
        )
      : await this.client.createSession(
          this.transformConfig(toLegacyConfig(this.client.provider, config)),
          { env: { ...config.env }, agentId: this.id },
          { persistSession: config.persist },
        );
    if (this.owner.isClosed()) {
      await candidate.close().catch(() => undefined);
      return;
    }
    const buffered: AgentStreamEvent[] = [];
    let committed = false;
    const unsubscribeCandidate = candidate.subscribe((event) => {
      if (committed) this.forward(event);
      else buffered.push(event);
    });
    try {
      requireNativeSessionConfigSupport(candidate, config);
      const candidateConfig = await this.readConfigFor(candidate, config);
      const candidateCommands = await candidate.listCommands?.();
      if (this.owner.isClosed()) {
        unsubscribeCandidate();
        await candidate.close().catch(() => undefined);
        return;
      }
      this.acceptingEvents = false;
      this.unsubscribe?.();
      const previous = this.session;
      this.session = candidate;
      this.config = config;
      this.acceptingEvents = true;
      this.unsubscribe = unsubscribeCandidate;
      this.timelineSnapshots.clear();
      this.activeTextItems.clear();
      for (const childSessionId of this.retireChildren()) {
        this.owner.emit({ type: "session.closed", sessionId: childSessionId });
      }
      this.owner.emit({
        type: "session.opened",
        requestId,
        sessionId: this.id,
        capabilities: nativeSessionCapabilities(this.owner.capabilities, candidate),
        restoration: "core",
        persistence: persistenceOf(candidate),
        cwd: config.cwd,
        title: config.title ?? undefined,
      });
      for (const event of buffered) this.forward(event);
      committed = true;
      this.publishedConfig = candidateConfig;
      this.owner.emit({ type: "session.config", sessionId: this.id, config: candidateConfig });
      if (candidateCommands) {
        this.owner.emit({
          type: "session.commands",
          sessionId: this.id,
          commands: candidateCommands,
        });
      }
      this.owner.emit({ type: "session.ready", requestId, sessionId: this.id });
      await previous.close().catch(() => undefined);
    } catch (error) {
      unsubscribeCandidate();
      await candidate.close().catch(() => undefined);
      throw error;
    }
  }

  async configure(requestId: string, changes: ProviderConfigChanges): Promise<void> {
    const previousConfig = this.config;
    const nextConfig = applyProviderConfigChanges(previousConfig, changes);
    const previous = await this.readConfigFor(this.session, previousConfig);
    this.configTransaction = true;
    try {
      const notices: AgentProviderNotice[] = [];
      if (changes.model !== undefined) await this.session.setModel?.(changes.model);
      if (changes.mode !== undefined && changes.mode !== null) {
        const notice = await this.session.setMode(changes.mode);
        if (notice) notices.push(notice);
      }
      if (changes.thinkingOption !== undefined) {
        const notice = await this.session.setThinkingOption?.(changes.thinkingOption);
        if (notice) notices.push(notice);
      }
      for (const [id, value] of Object.entries(changes.settings ?? {})) {
        await this.session.setFeature?.(id, value);
      }
      const committed = await this.readConfigFor(this.session, nextConfig);
      this.config = nextConfig;
      this.configTransaction = false;
      this.publishConfigSnapshot(committed);
      for (const notice of notices) this.publishNotice(notice);
      this.owner.emit({ type: "request.completed", requestId });
    } catch (error) {
      try {
        await this.restoreConfig(previous);
        this.config = previousConfig;
        this.publishedConfig = previous;
      } catch (rollbackError) {
        const failure = new AggregateError(
          [error, rollbackError],
          "Provider configuration failed and rollback could not restore the previous state",
        );
        this.owner.failSession(this.id, failure);
        await this.dispose().catch(() => undefined);
        throw failure;
      }
      throw error;
    } finally {
      this.configTransaction = false;
    }
  }

  async respondToPermission(
    permissionId: string,
    response: Extract<ProviderInput, { type: "session.permission" }>["response"],
  ): Promise<void> {
    const result = await this.session.respondToPermission(
      permissionId,
      response as AgentPermissionResponse,
    );
    if (result?.followUpPrompt) {
      await this.session.startTurn(result.followUpPrompt);
    }
    await this.publishConfig();
  }

  async interrupt(): Promise<void> {
    const interruptedTurnId = this.activeTurnId;
    await this.session.interrupt();
    if (interruptedTurnId) this.interruptedTurnIds.add(interruptedTurnId);
    if (this.activeTurnId === interruptedTurnId) this.activeTurnId = null;
  }

  async revert(input: Extract<ProviderInput, { type: "session.revert" }>): Promise<void> {
    if (typeof input.token !== "string") {
      throw new Error("Native provider revert token must be a message ID");
    }
    const messageId = input.token;
    if (input.scope === "conversation") await this.session.revertConversation!({ messageId });
    else if (input.scope === "files") await this.session.revertFiles!({ messageId });
    else await this.session.revertBoth!({ messageId });
    this.owner.emit({ type: "request.completed", requestId: input.requestId });
  }

  async dispose(): Promise<void> {
    this.acceptingEvents = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.session.close();
  }

  private subscribe(session: AgentSession): void {
    this.unsubscribe = session.subscribe((event) => {
      if (this.session === session) this.forward(event);
    });
  }

  private forward(event: AgentStreamEvent): void {
    if (!this.acceptingEvents) return;
    if (!this.trackTurn(event)) return;
    if (event.type === "turn_completed" && !this.configTransaction) {
      queueMicrotask(() => {
        void this.publishConfig().catch(() => undefined);
      });
    }
    if (event.type === "mode_changed") {
      this.publishConfigState({
        mode: event.currentModeId ?? undefined,
        modes: event.availableModes,
      });
      return;
    }
    if (event.type === "model_changed") {
      this.publishConfigState({
        model: event.runtimeInfo.model ?? undefined,
        mode: event.runtimeInfo.modeId ?? this.publishedConfig.mode,
        thinkingOption: event.runtimeInfo.thinkingOptionId ?? this.publishedConfig.thinkingOption,
      });
      return;
    }
    if (event.type === "thinking_option_changed") {
      this.publishConfigState({ thinkingOption: event.thinkingOptionId ?? undefined });
      return;
    }
    const mapped = mapNativeEvent(this, event);
    for (const providerEvent of mapped) this.owner.emit(providerEvent);
  }

  private trackTurn(event: AgentStreamEvent): boolean {
    if (this.isInterruptedTurnStart(event)) return false;
    if (event.type === "turn_started" && event.turnId) {
      this.activeTurnId = event.turnId;
    }
    if (
      (event.type === "turn_completed" ||
        event.type === "turn_failed" ||
        event.type === "turn_canceled") &&
      (!event.turnId || event.turnId === this.activeTurnId)
    ) {
      this.activeTurnId = null;
    }
    return true;
  }

  private isInterruptedTurnStart(event: AgentStreamEvent): boolean {
    return (
      event.type === "turn_started" &&
      event.turnId !== undefined &&
      this.interruptedTurnIds.has(event.turnId)
    );
  }

  private async publishConfig(): Promise<void> {
    if (this.configTransaction) return;
    const config = await this.readConfig();
    if (this.configTransaction) return;
    this.publishConfigSnapshot(config);
  }

  private publishConfigSnapshot(config: ProviderConfigState): void {
    this.publishedConfig = config;
    this.owner.emit({ type: "session.config", sessionId: this.id, config: this.publishedConfig });
  }

  private publishConfigState(changes: Partial<ProviderConfigState>): void {
    if (this.configTransaction) return;
    this.publishedConfig = { ...this.publishedConfig, ...changes };
    this.owner.emit({ type: "session.config", sessionId: this.id, config: this.publishedConfig });
  }

  private async readConfig(): Promise<ProviderConfigState> {
    return this.readConfigFor(this.session, this.config);
  }

  private async readConfigFor(
    session: AgentSession,
    config: ProviderSessionConfig,
  ): Promise<ProviderConfigState> {
    const features = this.client.listFeatures
      ? await this.client.listFeatures(
          this.transformConfig(toLegacyConfig(this.client.provider, config)),
        )
      : session.features;
    return readNativeConfig(session, features, config);
  }

  private async restoreConfig(config: ProviderConfigState): Promise<void> {
    await this.session.setModel?.(config.model ?? null);
    await setNativeMode(this.session, config.mode ?? null);
    await this.session.setThinkingOption?.(config.thinkingOption ?? null);
    for (const setting of config.settings) {
      await this.session.setFeature?.(setting.id, setting.value);
    }
  }

  private publishNotice(notice: AgentProviderNotice): void {
    this.owner.emit({
      type: "session.notice",
      sessionId: this.id,
      notice: {
        id: randomUUID(),
        severity: notice.type,
        title: notice.message,
      },
    });
  }

  nextTimelineId(item: AgentTimelineItem, turnId?: string): string {
    if (item.type === "plugin") return item.id;
    if (item.type === "tool_call") return item.callId;
    if (item.type === "user_message")
      return item.messageId ?? item.clientMessageId ?? this.sequenceId(item.type);
    if (item.type === "assistant_message") return item.messageId ?? this.sequenceId(item.type);
    if (item.type === "reasoning" || item.type === "todo" || item.type === "compaction") {
      return `${item.type}:${turnId ?? "session"}`;
    }
    return this.sequenceId(item.type);
  }

  timelineSnapshot(
    sessionId: string,
    item: AgentTimelineItem,
    turnId?: string,
  ): ProviderTimelineItem {
    const id = this.timelineId(sessionId, item, turnId);
    const key = `${sessionId}\0${id}`;
    const previous = this.timelineSnapshots.get(key);
    const snapshot = {
      ...item,
      id,
      ...((item.type === "user_message" || item.type === "assistant_message") && item.messageId
        ? { revertToken: item.messageId }
        : {}),
      ...((item.type === "assistant_message" || item.type === "reasoning") &&
      previous?.type === item.type
        ? { text: previous.text + item.text }
        : {}),
    } as ProviderTimelineItem;
    this.timelineSnapshots.set(key, snapshot);
    return snapshot;
  }

  private timelineId(sessionId: string, item: AgentTimelineItem, turnId?: string): string {
    if (item.type !== "assistant_message" && item.type !== "reasoning") {
      this.activeTextItems.delete(sessionId);
      return this.nextTimelineId(item, turnId);
    }
    if (item.type === "assistant_message" && item.messageId) return item.messageId;
    const active = this.activeTextItems.get(sessionId);
    if (active?.type === item.type && active.turnId === turnId) return active.id;
    const id = this.nextTimelineId(item, turnId);
    this.activeTextItems.set(sessionId, { type: item.type, turnId, id });
    return id;
  }

  private sequenceId(type: string): string {
    this.timelineSequence += 1;
    return `${type}:${this.timelineSequence}`;
  }

  markChildOpened(sessionId: string): boolean {
    if (this.childSessions.has(sessionId)) return false;
    this.childSessions.add(sessionId);
    return true;
  }

  markChildClosed(sessionId: string): void {
    this.childSessions.delete(sessionId);
  }

  private retireChildren(): string[] {
    const sessionIds = [...this.childSessions];
    this.childSessions.clear();
    return sessionIds;
  }
}

async function readNativeConfig(
  session: AgentSession,
  features: readonly AgentFeature[] = session.features ?? [],
  config?: ProviderSessionConfig,
): Promise<ProviderConfigState> {
  const [runtime, modes, mode] = await Promise.all([
    session.getRuntimeInfo(),
    session.getAvailableModes(),
    session.getCurrentMode(),
  ]);
  return {
    model: "model" in runtime ? (runtime.model ?? undefined) : config?.model,
    mode: mode ?? undefined,
    thinkingOption:
      "thinkingOptionId" in runtime
        ? (runtime.thinkingOptionId ?? undefined)
        : config?.thinkingOption,
    models: [],
    modes,
    thinkingOptions: [],
    settings: (features ?? []).map(toProviderSetting),
  };
}

function setNativeMode(
  session: AgentSession,
  mode: string | null,
): Promise<void | AgentProviderNotice> {
  return session.setMode(mode as string);
}

async function openNativeSession(
  client: AgentClient,
  input: Extract<ProviderInput, { type: "session.open" }>,
  transformConfig: (config: AgentSessionConfig) => AgentSessionConfig,
): Promise<{ session: AgentSession; history: AgentStreamEvent[] }> {
  const sessionConfig = transformConfig(toLegacyConfig(client.provider, input.config));
  const persistence = input.persistence ? decodePersistence(input.persistence) : null;
  if (persistence?.kind === "import" && client.importSession) {
    const imported = await client.importSession(
      { providerHandleId: persistence.providerHandleId, cwd: persistence.cwd },
      {
        config: sessionConfig,
        storedConfig: sessionConfig,
        launchContext: { env: { ...input.config.env }, agentId: input.sessionId },
      },
    );
    return {
      session: imported.session,
      history: [
        ...imported.timeline.map(
          ({ item, timestamp }): AgentStreamEvent => ({
            type: "timeline",
            provider: client.provider,
            item,
            timestamp,
          }),
        ),
        ...(imported.providerSubagentEvents ?? []),
      ],
    };
  }
  const session =
    persistence?.kind === "native"
      ? await client.resumeSession(persistence.handle, sessionConfig, {
          env: { ...input.config.env },
          agentId: input.sessionId,
        })
      : await client.createSession(
          sessionConfig,
          { env: { ...input.config.env }, agentId: input.sessionId },
          { persistSession: input.config.persist },
        );
  return {
    session,
    history: input.history === "replay" ? await collectHistory(session) : [],
  };
}

async function collectHistory(session: AgentSession): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  for await (const event of session.streamHistory()) events.push(event);
  return events;
}

function nativeConnectionCapabilities(
  client: AgentClient,
  supportsToolPolicy: boolean,
): readonly ProviderCapability[] {
  const capabilities: ProviderCapability[] = [...BASE_CAPABILITIES];
  if (client.capabilities.supportsImages) capabilities.push("prompt.image");
  if (client.capabilities.supportsOutputSchema) capabilities.push("prompt.output_schema");
  if (client.capabilities.supportsMaxThinkingTokens) {
    capabilities.push("prompt.max_thinking_tokens");
  }
  if (client.capabilities.supportsSessionListing) capabilities.push("session.list");
  if (client.capabilities.supportsSessionPersistence) capabilities.push("session.persistence");
  if (client.capabilities.supportsDynamicModes || client.capabilities.supportsSessionConfigure) {
    capabilities.push("session.configure");
  }
  if (client.capabilities.supportsRewindConversation)
    capabilities.push("session.revert.conversation");
  if (client.capabilities.supportsRewindFiles) capabilities.push("session.revert.files");
  if (client.capabilities.supportsRewindBoth) capabilities.push("session.revert.both");
  if (client.archiveNativeSession) capabilities.push("session.archive");
  if (client.unarchiveNativeSession) capabilities.push("session.unarchive");
  if (supportsToolPolicy) capabilities.push("permission.tool_policy");
  capabilities.push("prompt.steer");
  if (client.capabilities.supportsSubsessions) capabilities.push("session.subsession");
  return capabilities;
}

function nativeSessionCapabilities(
  connectionCapabilities: readonly string[],
  session: AgentSession,
): readonly string[] {
  return connectionCapabilities.filter((capability) => {
    if (capability === "prompt.steer") return session.steerActiveTurn !== undefined;
    if (capability === "session.configure") {
      return (
        session.setModel !== undefined ||
        session.setMode !== undefined ||
        session.setThinkingOption !== undefined ||
        session.setFeature !== undefined
      );
    }
    if (capability === "session.revert.conversation") {
      return session.revertConversation !== undefined;
    }
    if (capability === "session.revert.files") return session.revertFiles !== undefined;
    if (capability === "session.revert.both") return session.revertBoth !== undefined;
    return true;
  });
}

function applyProviderConfigChanges(
  current: ProviderSessionConfig,
  changes: ProviderConfigChanges,
): ProviderSessionConfig {
  const next: ProviderSessionConfig = {
    ...current,
    settings: changes.settings
      ? { ...current.settings, ...changes.settings }
      : { ...current.settings },
  };
  for (const [key, value] of [
    ["model", changes.model],
    ["mode", changes.mode],
    ["thinkingOption", changes.thinkingOption],
  ] as const) {
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

function supportsNativeRevertScope(
  session: AgentSession,
  scope: Extract<ProviderInput, { type: "session.revert" }>["scope"],
): boolean {
  if (scope === "conversation") return session.revertConversation !== undefined;
  if (scope === "files") return session.revertFiles !== undefined;
  return session.revertBoth !== undefined;
}

function toLegacyPrompt(prompt: ProviderPrompt) {
  if (prompt.input.type === "command") {
    return `/${prompt.input.name}${prompt.input.arguments ? ` ${prompt.input.arguments}` : ""}`;
  }
  const { content } = prompt.input;
  return content.length === 1 && content[0]?.type === "text"
    ? content[0].text
    : (content as AgentPromptInput);
}

function requireNativeSessionConfigSupport(
  session: AgentSession,
  config: ProviderSessionConfig,
): void {
  const unsupportedMcpServers = Object.keys(config.mcpServers).filter(
    (name) =>
      !session.capabilities.supportsMcpServers &&
      !(name === "paseo" && session.capabilities.supportsNativePaseoTools),
  );
  if (unsupportedMcpServers.length > 0) {
    throw new Error(`Provider '${session.provider}' does not support MCP servers`);
  }
}

function toLegacyConfig(provider: string, config: ProviderSessionConfig): AgentSessionConfig {
  return {
    provider,
    cwd: config.cwd,
    ...(config.model !== undefined ? { model: config.model } : {}),
    ...(config.mode !== undefined ? { modeId: config.mode } : {}),
    ...(config.thinkingOption !== undefined ? { thinkingOptionId: config.thinkingOption } : {}),
    ...(Object.keys(config.settings).length > 0 ? { featureValues: { ...config.settings } } : {}),
    ...(config.providerOptions !== undefined ? { providerOptions: config.providerOptions } : {}),
    ...(config.systemPrompt !== undefined ? { systemPrompt: config.systemPrompt } : {}),
    ...(Object.keys(config.mcpServers).length > 0 ? { mcpServers: { ...config.mcpServers } } : {}),
    ...(config.toolPolicy !== undefined ? { toolPolicy: config.toolPolicy } : {}),
    ...(config.title !== undefined ? { title: config.title } : {}),
  };
}

function persistenceOf(session: AgentSession): ProviderPersistence | undefined {
  const handle = session.describePersistence();
  return handle
    ? {
        version: 1,
        data: z.json().parse(JSON.parse(JSON.stringify({ kind: "native", handle }))),
      }
    : undefined;
}

function decodePersistence(
  persistence: ProviderPersistence,
):
  | { kind: "native"; handle: AgentPersistenceHandle }
  | { kind: "import"; providerHandleId: string; cwd: string }
  | null {
  const data = persistence.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  if (data.kind === "native" && typeof data.handle === "object" && data.handle !== null) {
    return { kind: "native", handle: data.handle as unknown as AgentPersistenceHandle };
  }
  if (
    data.kind === "import" &&
    typeof data.providerHandleId === "string" &&
    typeof data.cwd === "string"
  ) {
    return { kind: "import", providerHandleId: data.providerHandleId, cwd: data.cwd };
  }
  return null;
}

function toNativeHandle(
  provider: string,
  persistence: ProviderPersistence,
): AgentPersistenceHandle {
  const decoded = decodePersistence(persistence);
  if (decoded?.kind !== "native") throw new Error("Provider persistence is not a native handle");
  return { ...decoded.handle, provider };
}

function toProviderSetting(feature: AgentFeature) {
  if (feature.type === "toggle") {
    return {
      type: "toggle" as const,
      id: feature.id,
      label: feature.label,
      description: feature.description,
      value: feature.value,
    };
  }
  return {
    type: "select" as const,
    id: feature.id,
    label: feature.label,
    description: feature.description,
    value: feature.value,
    options: feature.options.map((option) => ({ label: option.label, value: option.id })),
  };
}

function mapNativeEvent(session: NativeBoundarySession, event: AgentStreamEvent): ProviderEvent[] {
  if (event.type === "thread_started") {
    const persistence = persistenceOf(session.session);
    return persistence ? [{ type: "session.persistence", sessionId: session.id, persistence }] : [];
  }
  if (event.type === "turn_started") {
    return [
      {
        type: "session.turn",
        sessionId: session.id,
        turnId: event.turnId ?? randomUUID(),
        state: "started",
      },
    ];
  }
  if (event.type === "turn_completed") {
    return [
      ...(event.usage
        ? [
            {
              type: "session.usage" as const,
              sessionId: session.id,
              turnId: event.turnId,
              usage: event.usage,
            },
          ]
        : []),
      {
        type: "session.turn",
        sessionId: session.id,
        turnId: event.turnId ?? randomUUID(),
        state: "completed",
      },
    ];
  }
  if (event.type === "turn_failed" || event.type === "turn_canceled") {
    return [
      {
        type: "session.turn",
        sessionId: session.id,
        turnId: event.turnId ?? randomUUID(),
        state: event.type === "turn_failed" ? "failed" : "canceled",
        error:
          event.type === "turn_failed"
            ? { message: event.error, code: event.code, diagnostic: event.diagnostic }
            : { message: event.reason },
      },
    ];
  }
  if (event.type === "usage_updated") {
    return [
      { type: "session.usage", sessionId: session.id, turnId: event.turnId, usage: event.usage },
    ];
  }
  if (event.type === "timeline") {
    return [
      {
        type: "timeline.item",
        sessionId: session.id,
        item: session.timelineSnapshot(session.id, event.item, event.turnId),
        timestamp: event.timestamp,
      },
    ];
  }
  if (event.type === "permission_requested") {
    const { provider: _provider, ...request } = event.request;
    return [
      ProviderEventSchema.parse({ type: "session.permission", sessionId: session.id, request }),
    ];
  }
  if (event.type === "permission_resolved") {
    return [
      { type: "session.permission_resolved", sessionId: session.id, permissionId: event.requestId },
    ];
  }
  if (event.type === "provider_subagent") return mapNativeChildEvent(session, event.event);
  return [];
}

function mapNativeChildEvent(
  parent: NativeBoundarySession,
  event: Extract<AgentStreamEvent, { type: "provider_subagent" }>["event"],
): ProviderEvent[] {
  if (event.type === "timeline") {
    const opened = parent.markChildOpened(event.id) ? [childOpenedEvent(parent, event.id, {})] : [];
    return [
      ...opened,
      {
        type: "timeline.item",
        sessionId: event.id,
        item: parent.timelineSnapshot(event.id, event.item),
        timestamp: event.timestamp,
      },
    ];
  }
  if (event.type === "remove") {
    parent.markChildClosed(event.id);
    return [{ type: "session.closed", sessionId: event.id }];
  }
  const firstOpen = parent.markChildOpened(event.id);
  const opened = firstOpen ? [childOpenedEvent(parent, event.id, event)] : [];
  if (!event.status || event.status === "running") {
    return firstOpen
      ? [
          ...opened,
          { type: "session.turn", sessionId: event.id, turnId: event.id, state: "started" },
        ]
      : opened;
  }
  return [
    ...opened,
    {
      type: "session.turn",
      sessionId: event.id,
      turnId: event.id,
      state: event.status,
    },
  ];
}

function childOpenedEvent(
  parent: NativeBoundarySession,
  sessionId: string,
  event: { title?: string | null; description?: string | null; cwd?: string | null },
): Extract<ProviderEvent, { type: "session.opened" }> {
  return {
    type: "session.opened",
    sessionId,
    parentSessionId: parent.id,
    capabilities: [],
    restoration: "parent",
    title: event.title ?? undefined,
    description: event.description ?? undefined,
    cwd: event.cwd ?? "",
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
