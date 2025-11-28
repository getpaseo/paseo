import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentMode,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentProvider,
  AgentRunOptions,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  AgentTimelineItem,
  AgentUsage,
  ListPersistedAgentsOptions,
  PersistedAgentDescriptor,
} from "./agent-sdk-types.js";
import { resolveAgentModel } from "./model-resolver.js";

export type AgentLifecycleStatus =
  | "initializing"
  | "idle"
  | "running"
  | "error"
  | "closed";

export type AgentSnapshot = {
  id: string;
  provider: AgentProvider;
  cwd: string;
  model: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastUserMessageAt: Date | null;
  status: AgentLifecycleStatus;
  sessionId: string | null;
  capabilities: AgentCapabilityFlags;
  currentModeId: string | null;
  availableModes: AgentMode[];
  pendingPermissions: AgentPermissionRequest[];
  persistence: AgentPersistenceHandle | null;
  lastUsage?: AgentUsage;
  lastError?: string;
};

export type AgentManagerEvent =
  | { type: "agent_state"; agent: AgentSnapshot }
  | { type: "agent_stream"; agentId: string; event: AgentStreamEvent };

export type AgentSubscriber = (event: AgentManagerEvent) => void;

export type SubscribeOptions = {
  agentId?: string;
  replayState?: boolean;
};

export type PersistedAgentQueryOptions = ListPersistedAgentsOptions & {
  provider?: AgentProvider;
};

export type AgentManagerOptions = {
  clients?: Partial<Record<AgentProvider, AgentClient>>;
  maxTimelineItems?: number;
  idFactory?: () => string;
};

export type WaitForAgentOptions = {
  signal?: AbortSignal;
};

export type WaitForAgentResult = {
  status: AgentLifecycleStatus;
  permission: AgentPermissionRequest | null;
};

type ManagedAgent = {
  id: string;
  provider: AgentProvider;
  cwd: string;
  session: AgentSession;
  sessionId: string | null;
  capabilities: AgentCapabilityFlags;
  config: AgentSessionConfig;
  status: AgentLifecycleStatus;
  createdAt: Date;
  updatedAt: Date;
  availableModes: AgentMode[];
  currentModeId: string | null;
  pendingPermissions: Map<string, AgentPermissionRequest>;
  pendingRun: AsyncGenerator<AgentStreamEvent> | null;
  timeline: AgentTimelineItem[];
  persistence: AgentPersistenceHandle | null;
  lastUsage?: AgentUsage;
  lastError?: string;
  historyPrimed: boolean;
  lastUserMessageAt: Date | null;
};

type SubscriptionRecord = {
  callback: AgentSubscriber;
  agentId: string | null;
};

const DEFAULT_MAX_TIMELINE_ITEMS = 2000;
const BUSY_STATUSES: AgentLifecycleStatus[] = [
  "initializing",
  "running",
];

function isAgentBusy(status: AgentLifecycleStatus): boolean {
  return BUSY_STATUSES.includes(status);
}

function createAbortError(
  signal: AbortSignal | undefined,
  fallbackMessage: string
): Error {
  const reason = signal?.reason;
  const message =
    typeof reason === "string"
      ? reason
      : reason instanceof Error
        ? reason.message
        : fallbackMessage;
  return Object.assign(new Error(message), { name: "AbortError" });
}

export class AgentManager {
  private readonly clients = new Map<AgentProvider, AgentClient>();
  private readonly agents = new Map<string, ManagedAgent>();
  private readonly subscribers = new Set<SubscriptionRecord>();
  private readonly maxTimelineItems: number;
  private readonly idFactory: () => string;

  constructor(options?: AgentManagerOptions) {
    this.maxTimelineItems =
      options?.maxTimelineItems ?? DEFAULT_MAX_TIMELINE_ITEMS;
    this.idFactory = options?.idFactory ?? (() => randomUUID());
    if (options?.clients) {
      for (const [provider, client] of Object.entries(options.clients)) {
        if (client) {
          this.registerClient(provider as AgentProvider, client);
        }
      }
    }
  }

  registerClient(provider: AgentProvider, client: AgentClient): void {
    this.clients.set(provider, client);
  }

  subscribe(callback: AgentSubscriber, options?: SubscribeOptions): () => void {
    const record: SubscriptionRecord = {
      callback,
      agentId: options?.agentId ?? null,
    };
    this.subscribers.add(record);

    if (options?.replayState !== false) {
      if (record.agentId) {
        const agent = this.agents.get(record.agentId);
        if (agent) {
          callback({ type: "agent_state", agent: this.toSnapshot(agent) });
        }
      } else {
        for (const agent of this.agents.values()) {
          callback({ type: "agent_state", agent: this.toSnapshot(agent) });
        }
      }
    }

    return () => {
      this.subscribers.delete(record);
    };
  }

  listAgents(): AgentSnapshot[] {
    return Array.from(this.agents.values()).map((agent) =>
      this.toSnapshot(agent)
    );
  }

  async listPersistedAgents(
    options?: PersistedAgentQueryOptions
  ): Promise<PersistedAgentDescriptor[]> {
    if (options?.provider) {
      const client = this.requireClient(options.provider);
      if (!client.listPersistedAgents) {
        return [];
      }
      return client.listPersistedAgents({ limit: options.limit });
    }

    const descriptors: PersistedAgentDescriptor[] = [];
    for (const [provider, client] of this.clients.entries()) {
      if (!client.listPersistedAgents) {
        continue;
      }
      try {
        const entries = await client.listPersistedAgents({
          limit: options?.limit,
        });
        descriptors.push(...entries);
      } catch (error) {
        console.warn(
          `[AgentManager] Failed to list persisted agents for provider '${provider}':`,
          error
        );
      }
    }

    const limit = options?.limit ?? 20;
    return descriptors
      .sort(
        (a, b) =>
          b.lastActivityAt.getTime() - a.lastActivityAt.getTime()
      )
      .slice(0, limit);
  }

  getAgent(id: string): AgentSnapshot | null {
    const agent = this.agents.get(id);
    return agent ? this.toSnapshot(agent) : null;
  }

  getTimeline(id: string): AgentTimelineItem[] {
    const agent = this.requireAgent(id);
    return [...agent.timeline];
  }

  async createAgent(
    config: AgentSessionConfig,
    agentId?: string
  ): Promise<AgentSnapshot> {
    const normalizedConfig = await this.normalizeConfig(config);
    const client = this.requireClient(normalizedConfig.provider);
    const session = await client.createSession(normalizedConfig);
    return this.registerSession(
      session,
      normalizedConfig,
      agentId ?? this.idFactory()
    );
  }

  async resumeAgent(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    agentId?: string
  ): Promise<AgentSnapshot> {
    const metadata = (handle.metadata ?? {}) as Partial<AgentSessionConfig>;
    const mergedConfig = {
      ...metadata,
      ...overrides,
      provider: handle.provider,
    } as AgentSessionConfig;
    const normalizedConfig = await this.normalizeConfig(mergedConfig);
    const resumeOverrides =
      normalizedConfig.model !== mergedConfig.model
        ? { ...overrides, model: normalizedConfig.model }
        : overrides;
    const client = this.requireClient(handle.provider);
    const session = await client.resumeSession(handle, resumeOverrides);
    return this.registerSession(
      session,
      normalizedConfig,
      agentId ?? this.idFactory()
    );
  }

  async refreshAgentFromPersistence(agentId: string): Promise<AgentSnapshot> {
    const existing = this.requireAgent(agentId);
    const handle = existing.persistence;
    if (!handle) {
      throw new Error(
        `Agent ${agentId} cannot be refreshed because it has no persistence handle`
      );
    }

    const client = this.requireClient(handle.provider);
    const overrides = {
      ...existing.config,
      provider: handle.provider,
    };

    const session = await client.resumeSession(handle, overrides);

    // Remove the existing agent entry before swapping sessions
    this.agents.delete(agentId);
    try {
      await existing.session.close();
    } catch (error) {
      console.warn(
        `[AgentManager] Failed to close previous session for agent ${agentId} during refresh:`,
        error
      );
    }

    return this.registerSession(session, overrides, agentId);
  }

  async closeAgent(agentId: string): Promise<void> {
    const agent = this.requireAgent(agentId);
    this.agents.delete(agentId);
    agent.status = "closed";
    await agent.session.close();
    this.emitState(agent);
  }

  async setAgentMode(agentId: string, modeId: string): Promise<void> {
    const agent = this.requireAgent(agentId);
    await agent.session.setMode(modeId);
    agent.currentModeId = modeId;
    this.emitState(agent);
  }

  async runAgent(
    agentId: string,
    prompt: AgentPromptInput,
    options?: AgentRunOptions
  ): Promise<AgentRunResult> {
    const events = this.streamAgent(agentId, prompt, options);
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

    const agent = this.requireAgent(agentId);
    return {
      sessionId: agent.sessionId ?? agent.id,
      finalText,
      usage,
      timeline,
    };
  }

  recordUserMessage(
    agentId: string,
    text: string,
    options?: { messageId?: string }
  ): void {
    const agent = this.requireAgent(agentId);
    const item: AgentTimelineItem = {
      type: "user_message",
      text,
      messageId: options?.messageId,
    };
    agent.updatedAt = new Date();
    agent.lastUserMessageAt = agent.updatedAt;
    this.recordTimeline(agent, item);
    this.dispatchStream(agentId, {
      type: "timeline",
      item,
      provider: agent.provider,
    });
    this.emitState(agent);
  }

  streamAgent(
    agentId: string,
    prompt: AgentPromptInput,
    options?: AgentRunOptions
  ): AsyncGenerator<AgentStreamEvent> {
    const agent = this.requireAgent(agentId);
    if (agent.status === "closed") {
      throw new Error(`Agent ${agentId} is closed`);
    }
    if (agent.pendingRun) {
      throw new Error(`Agent ${agentId} already has an active run`);
    }

    const iterator = agent.session.stream(prompt, options);
    agent.status = "running";
    agent.pendingRun = iterator;
    agent.lastError = undefined;
    this.emitState(agent);

    let finalized = false;
    const finalize = (error?: string) => {
      if (finalized) {
        return;
      }
      finalized = true;

      if (agent.pendingRun !== iterator) {
        if (error) {
          agent.lastError = error;
        }
        return;
      }

      agent.pendingRun = null;
      agent.status = error ? "error" : "idle";
      agent.lastError = error;
      agent.persistence = agent.session.describePersistence();
      this.emitState(agent);
    };

    const self = this;

    return (async function* streamForwarder() {
      try {
        for await (const event of iterator) {
          self.handleStreamEvent(agent, event);
          yield event;
        }
        finalize();
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Agent stream failed";
        finalize(message);
        throw error;
      } finally {
        // Ensure we always clear the pending run and emit state when the stream is
        // cancelled early (e.g., via .return()) so the UI can exit the cancelling state.
        finalize();
      }
    })();
  }

  async respondToPermission(
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse
  ): Promise<void> {
    const agent = this.requireAgent(agentId);
    await agent.session.respondToPermission(requestId, response);
    agent.pendingPermissions.delete(requestId);
    this.emitState(agent);
  }

  async cancelAgentRun(agentId: string): Promise<boolean> {
    const agent = this.requireAgent(agentId);
    const pendingRun = agent.pendingRun;
    if (!pendingRun || typeof pendingRun.return !== "function") {
      return false;
    }

    try {
      await agent.session.interrupt();
    } catch (error) {
      console.error(
        `[AgentManager] Failed to interrupt session for agent ${agentId}:`,
        error
      );
    }

    try {
      const cancellation = pendingRun.return(
        undefined as unknown as AgentStreamEvent
      );
      void cancellation.catch((error) => {
        console.error(
          `[AgentManager] Failed to cancel run for agent ${agentId}:`,
          error
        );
      });
      return true;
    } catch (error) {
      console.error(
        `[AgentManager] Failed to cancel run for agent ${agentId}:`,
        error
      );
      throw error;
    }
  }

  getPendingPermissions(agentId: string): AgentPermissionRequest[] {
    const agent = this.requireAgent(agentId);
    return Array.from(agent.pendingPermissions.values());
  }

  async primeAgentHistory(agentId: string): Promise<void> {
    const agent = this.requireAgent(agentId);
    await this.primeHistory(agent);
  }

  async waitForAgentEvent(
    agentId: string,
    options?: WaitForAgentOptions
  ): Promise<WaitForAgentResult> {
    const snapshot = this.getAgent(agentId);
    if (!snapshot) {
      throw new Error(`Agent ${agentId} not found`);
    }

    const immediatePermission = snapshot.pendingPermissions[0] ?? null;
    if (immediatePermission) {
      return { status: snapshot.status, permission: immediatePermission };
    }

    if (!isAgentBusy(snapshot.status)) {
      return { status: snapshot.status, permission: null };
    }

    if (options?.signal?.aborted) {
      throw createAbortError(options.signal, "wait_for_agent aborted");
    }

    return await new Promise<WaitForAgentResult>((resolve, reject) => {
      let currentStatus: AgentLifecycleStatus = snapshot.status;
      const cleanupFns: Array<() => void> = [];

      const cleanup = () => {
        while (cleanupFns.length) {
          const fn = cleanupFns.pop();
          try {
            fn?.();
          } catch {
            // ignore cleanup errors
          }
        }
      };

      const finish = (permission: AgentPermissionRequest | null) => {
        cleanup();
        resolve({ status: currentStatus, permission });
      };

      const unsubscribe = this.subscribe(
        (event) => {
          if (event.type === "agent_state") {
            currentStatus = event.agent.status;
            const pending = event.agent.pendingPermissions[0] ?? null;
            if (pending) {
              finish(pending);
              return;
            }
            if (!isAgentBusy(event.agent.status)) {
              finish(null);
            }
            return;
          }

          if (event.type !== "agent_stream") {
            return;
          }

          switch (event.event.type) {
            case "permission_requested": {
              currentStatus = "running";
              finish(event.event.request);
              break;
            }
            case "turn_completed": {
              currentStatus = "idle";
              finish(null);
              break;
            }
            case "turn_failed": {
              currentStatus = "error";
              finish(null);
              break;
            }
            default:
              break;
          }
        },
        { agentId, replayState: true }
      );
      cleanupFns.push(unsubscribe);

      if (options?.signal) {
        const abortHandler = () => {
          cleanup();
          reject(createAbortError(options.signal, "wait_for_agent aborted"));
        };

        options.signal.addEventListener("abort", abortHandler, { once: true });
        cleanupFns.push(() =>
          options.signal?.removeEventListener("abort", abortHandler)
        );
      }
    });
  }

  private async registerSession(
    session: AgentSession,
    config: AgentSessionConfig,
    agentId: string
  ): Promise<AgentSnapshot> {
    if (this.agents.has(agentId)) {
      throw new Error(`Agent with id ${agentId} already exists`);
    }

    const managed: ManagedAgent = {
      id: agentId,
      provider: config.provider,
      cwd: config.cwd,
      session,
      sessionId: session.id,
      capabilities: session.capabilities,
      config,
      status: "initializing",
      createdAt: new Date(),
      updatedAt: new Date(),
      availableModes: [],
      currentModeId: null,
      pendingPermissions: new Map(),
      pendingRun: null,
      timeline: [],
      persistence: session.describePersistence(),
      historyPrimed: false,
      lastUserMessageAt: null,
    };

    this.agents.set(agentId, managed);
    this.emitState(managed);

    await this.refreshSessionState(managed);
    managed.status = "idle";
    this.emitState(managed);
    return this.toSnapshot(managed);
  }

  private async refreshSessionState(agent: ManagedAgent): Promise<void> {
    try {
      const modes = await agent.session.getAvailableModes();
      agent.availableModes = modes;
    } catch {
      agent.availableModes = [];
    }

    try {
      agent.currentModeId = await agent.session.getCurrentMode();
    } catch {
      agent.currentModeId = null;
    }

    try {
      const pending = agent.session.getPendingPermissions();
      agent.pendingPermissions = new Map(
        pending.map((request) => [request.id, request])
      );
    } catch {
      agent.pendingPermissions.clear();
    }
  }

  private async primeHistory(agent: ManagedAgent): Promise<void> {
    if (agent.historyPrimed) {
      return;
    }
    agent.historyPrimed = true;
    try {
      for await (const event of agent.session.streamHistory()) {
        this.handleStreamEvent(agent, event, { fromHistory: true });
      }
    } catch {
      // ignore history failures
    }
  }

  private handleStreamEvent(
    agent: ManagedAgent,
    event: AgentStreamEvent,
    options?: { fromHistory?: boolean }
  ): void {
    agent.updatedAt = new Date();

    switch (event.type) {
      case "thread_started":
        agent.sessionId = event.sessionId;
        break;
      case "timeline":
        this.recordTimeline(agent, event.item);
        if (
          !options?.fromHistory &&
          event.item.type === "user_message"
        ) {
          agent.lastUserMessageAt = new Date();
          this.emitState(agent);
        }
        break;
      case "turn_completed":
        agent.lastUsage = event.usage;
        agent.lastError = undefined;
        break;
      case "turn_failed":
        agent.lastError = event.error;
        break;
      case "permission_requested":
        agent.pendingPermissions.set(event.request.id, event.request);
        this.emitState(agent);
        break;
      case "permission_resolved":
        agent.pendingPermissions.delete(event.requestId);
        this.emitState(agent);
        break;
      default:
        break;
    }

    // Skip dispatching individual stream events during history replay.
    // The caller will send a batched agent_stream_snapshot after priming.
    if (!options?.fromHistory) {
      this.dispatchStream(agent.id, event);
    }
  }

  private recordTimeline(agent: ManagedAgent, item: AgentTimelineItem): void {
    agent.timeline.push(item);
    if (agent.timeline.length > this.maxTimelineItems) {
      agent.timeline.splice(0, agent.timeline.length - this.maxTimelineItems);
    }
  }

  private emitState(agent: ManagedAgent): void {
    this.dispatch({ type: "agent_state", agent: this.toSnapshot(agent) });
  }

  private dispatchStream(agentId: string, event: AgentStreamEvent): void {
    this.dispatch({ type: "agent_stream", agentId, event });
  }

  private dispatch(event: AgentManagerEvent): void {
    for (const subscriber of this.subscribers) {
      if (
        subscriber.agentId &&
        event.type === "agent_stream" &&
        subscriber.agentId !== event.agentId
      ) {
        continue;
      }
      if (
        subscriber.agentId &&
        event.type === "agent_state" &&
        subscriber.agentId !== event.agent.id
      ) {
        continue;
      }
      subscriber.callback(event);
    }
  }

  private toSnapshot(agent: ManagedAgent): AgentSnapshot {
    return {
      id: agent.id,
      provider: agent.provider,
      cwd: agent.cwd,
      model: agent.config.model ?? null,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
      lastUserMessageAt: agent.lastUserMessageAt,
      status: agent.status,
      sessionId: agent.sessionId,
      capabilities: agent.capabilities,
      currentModeId: agent.currentModeId,
      availableModes: agent.availableModes,
      pendingPermissions: Array.from(agent.pendingPermissions.values()),
      persistence: agent.persistence,
      lastUsage: agent.lastUsage,
      lastError: agent.lastError,
    };
  }

  private async normalizeConfig(
    config: AgentSessionConfig
  ): Promise<AgentSessionConfig> {
    const normalized: AgentSessionConfig = { ...config };

    // Always resolve cwd to absolute path for consistent history file lookup
    if (normalized.cwd) {
      normalized.cwd = resolve(normalized.cwd);
    }

    const resolvedModel = await resolveAgentModel({
      provider: normalized.provider,
      requestedModel: normalized.model,
      cwd: normalized.cwd,
    });

    if (resolvedModel) {
      normalized.model = resolvedModel;
    } else if (typeof normalized.model === "string") {
      const trimmed = normalized.model.trim();
      normalized.model = trimmed.length > 0 ? trimmed : undefined;
    }

    return normalized;
  }

  private requireClient(provider: AgentProvider): AgentClient {
    const client = this.clients.get(provider);
    if (!client) {
      throw new Error(`No client registered for provider '${provider}'`);
    }
    return client;
  }

  private requireAgent(id: string): ManagedAgent {
    const agent = this.agents.get(id);
    if (!agent) {
      throw new Error(`Unknown agent '${id}'`);
    }
    return agent;
  }
}
