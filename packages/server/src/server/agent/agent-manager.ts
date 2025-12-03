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
import type { AgentRegistry } from "./agent-registry.js";

export const AGENT_LIFECYCLE_STATUSES = [
  "initializing",
  "idle",
  "running",
  "error",
  "closed",
] as const;

export type AgentLifecycleStatus =
  (typeof AGENT_LIFECYCLE_STATUSES)[number];

export type AgentManagerEvent =
  | { type: "agent_state"; agent: ManagedAgent }
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
  registry?: AgentRegistry;
};

export type WaitForAgentOptions = {
  signal?: AbortSignal;
};

export type WaitForAgentResult = {
  status: AgentLifecycleStatus;
  permission: AgentPermissionRequest | null;
  lastMessage: string | null;
};

type ManagedAgentBase = {
  id: string;
  provider: AgentProvider;
  cwd: string;
  capabilities: AgentCapabilityFlags;
  config: AgentSessionConfig;
  createdAt: Date;
  updatedAt: Date;
  availableModes: AgentMode[];
  currentModeId: string | null;
  pendingPermissions: Map<string, AgentPermissionRequest>;
  timeline: AgentTimelineItem[];
  persistence: AgentPersistenceHandle | null;
  historyPrimed: boolean;
  lastUserMessageAt: Date | null;
  sessionId: string | null;
  lastUsage?: AgentUsage;
  lastError?: string;
};

type ManagedAgentWithSession = ManagedAgentBase & {
  session: AgentSession;
};

type ManagedAgentInitializing = ManagedAgentWithSession & {
  lifecycle: "initializing";
  pendingRun: null;
};

type ManagedAgentIdle = ManagedAgentWithSession & {
  lifecycle: "idle";
  pendingRun: null;
};

type ManagedAgentRunning = ManagedAgentWithSession & {
  lifecycle: "running";
  pendingRun: AsyncGenerator<AgentStreamEvent>;
};

type ManagedAgentError = ManagedAgentWithSession & {
  lifecycle: "error";
  pendingRun: null;
  lastError: string;
};

type ManagedAgentClosed = ManagedAgentBase & {
  lifecycle: "closed";
  session: null;
  pendingRun: null;
};

export type ManagedAgent =
  | ManagedAgentInitializing
  | ManagedAgentIdle
  | ManagedAgentRunning
  | ManagedAgentError
  | ManagedAgentClosed;

type ActiveManagedAgent =
  | ManagedAgentInitializing
  | ManagedAgentIdle
  | ManagedAgentRunning
  | ManagedAgentError;

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
  private readonly agents = new Map<string, ActiveManagedAgent>();
  private readonly subscribers = new Set<SubscriptionRecord>();
  private readonly maxTimelineItems: number;
  private readonly idFactory: () => string;
  private readonly registry?: AgentRegistry;

  constructor(options?: AgentManagerOptions) {
    this.maxTimelineItems =
      options?.maxTimelineItems ?? DEFAULT_MAX_TIMELINE_ITEMS;
    this.idFactory = options?.idFactory ?? (() => randomUUID());
    this.registry = options?.registry;
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
          callback({
            type: "agent_state",
            agent: { ...agent },
          });
        }
      } else {
        for (const agent of this.agents.values()) {
          callback({
            type: "agent_state",
            agent: { ...agent },
          });
        }
      }
    }

    return () => {
      this.subscribers.delete(record);
    };
  }

  listAgents(): ManagedAgent[] {
    return Array.from(this.agents.values()).map((agent) => ({
      ...agent,
    }));
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

  getAgent(id: string): ManagedAgent | null {
    const agent = this.agents.get(id);
    return agent ? { ...agent } : null;
  }

  getTimeline(id: string): AgentTimelineItem[] {
    const agent = this.requireAgent(id);
    return [...agent.timeline];
  }

  async createAgent(
    config: AgentSessionConfig,
    agentId?: string
  ): Promise<ManagedAgent> {
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
  ): Promise<ManagedAgent> {
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

  async refreshAgentFromPersistence(agentId: string): Promise<ManagedAgent> {
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
    const session = agent.session;
    const closedAgent: ManagedAgent = {
      ...agent,
      lifecycle: "closed",
      session: null,
      pendingRun: null,
      sessionId: agent.sessionId,
    };
    await session.close();
    this.emitState(closedAgent);
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
    const existingAgent = this.requireAgent(agentId);
    if (existingAgent.pendingRun) {
      throw new Error(`Agent ${agentId} already has an active run`);
    }

    const agent = existingAgent as ActiveManagedAgent;
    const iterator = agent.session.stream(prompt, options);
    agent.lifecycle = "running";
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

      const mutableAgent = agent as ActiveManagedAgent;
      mutableAgent.pendingRun = null;
      mutableAgent.lifecycle = error ? "error" : "idle";
      mutableAgent.lastError = error;
      mutableAgent.persistence = mutableAgent.session.describePersistence();
      this.emitState(mutableAgent);
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

  private peekPendingPermission(agent: ManagedAgent): AgentPermissionRequest | null {
    const iterator = agent.pendingPermissions.values().next();
    return iterator.done ? null : iterator.value;
  }

  async primeAgentHistory(agentId: string): Promise<void> {
    const agent = this.requireAgent(agentId);
    await this.primeHistory(agent);
  }

  private getLastAssistantMessage(agentId: string): string | null {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return null;
    }

    // Collect the last contiguous assistant messages (Claude streams chunks)
    const chunks: string[] = [];
    for (let i = agent.timeline.length - 1; i >= 0; i--) {
      const item = agent.timeline[i];
      if (item.type !== "assistant_message") {
        if (chunks.length) {
          break;
        }
        continue;
      }
      chunks.push(item.text);
    }

    if (!chunks.length) {
      return null;
    }

    return chunks.reverse().join("");
  }

  async waitForAgentEvent(
    agentId: string,
    options?: WaitForAgentOptions
  ): Promise<WaitForAgentResult> {
    const snapshot = this.getAgent(agentId);
    if (!snapshot) {
      throw new Error(`Agent ${agentId} not found`);
    }


    const immediatePermission = this.peekPendingPermission(snapshot);
    if (immediatePermission) {
      return {
        status: snapshot.lifecycle,
        permission: immediatePermission,
        lastMessage: this.getLastAssistantMessage(agentId)
      };
    }

    if (!isAgentBusy(snapshot.lifecycle)) {
      return {
        status: snapshot.lifecycle,
        permission: null,
        lastMessage: this.getLastAssistantMessage(agentId)
      };
    }

    if (options?.signal?.aborted) {
      throw createAbortError(options.signal, "wait_for_agent aborted");
    }


    return await new Promise<WaitForAgentResult>((resolve, reject) => {
      // Bug #1 Fix: Check abort signal AGAIN inside Promise constructor
      // to avoid race condition between pre-Promise check and abort listener registration
      if (options?.signal?.aborted) {
        reject(createAbortError(options.signal, "wait_for_agent aborted"));
        return;
      }

      let currentStatus: AgentLifecycleStatus = snapshot.lifecycle;

      // Bug #3 Fix: Declare unsubscribe and abortHandler upfront so cleanup can reference them
      let unsubscribe: (() => void) | null = null;
      let abortHandler: (() => void) | null = null;

      const cleanup = () => {
        // Clean up subscription
        if (unsubscribe) {
          try {
            unsubscribe();
          } catch {
            // ignore cleanup errors
          }
          unsubscribe = null;
        }

        // Clean up abort listener
        if (abortHandler && options?.signal) {
          try {
            options.signal.removeEventListener("abort", abortHandler);
          } catch {
            // ignore cleanup errors
          }
          abortHandler = null;
        }
      };

      const finish = (permission: AgentPermissionRequest | null) => {
        cleanup();
        resolve({
          status: currentStatus,
          permission,
          lastMessage: this.getLastAssistantMessage(agentId)
        });
      };

      // Bug #3 Fix: Set up abort handler BEFORE subscription
      // to ensure cleanup handlers exist before callback can fire
      if (options?.signal) {
        abortHandler = () => {
          cleanup();
          reject(createAbortError(options.signal, "wait_for_agent aborted"));
        };
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }

      // Bug #3 Fix: Now subscribe with cleanup handlers already in place
      // This prevents race condition if callback fires synchronously with replayState: true
      unsubscribe = this.subscribe(
        (event) => {
          // Bug #2 Fix: Only handle agent_state events, remove redundant agent_stream handling
          if (event.type === "agent_state") {
            currentStatus = event.agent.lifecycle;
            const pending = this.peekPendingPermission(event.agent);
            if (pending) {
              finish(pending);
              return;
            }
            if (!isAgentBusy(event.agent.lifecycle)) {
              finish(null);
            }
          }
        },
        { agentId, replayState: true }
      );
    });
  }

  private async registerSession(
    session: AgentSession,
    config: AgentSessionConfig,
    agentId: string
  ): Promise<ManagedAgent> {
    if (this.agents.has(agentId)) {
      throw new Error(`Agent with id ${agentId} already exists`);
    }

    const managed = {
      id: agentId,
      provider: config.provider,
      cwd: config.cwd,
      session,
      sessionId: session.id,
      capabilities: session.capabilities,
      config,
      lifecycle: "initializing",
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
    } as ActiveManagedAgent;

    this.agents.set(agentId, managed);
    await this.persistSnapshot(managed, {
      title: config.title ?? null,
    });
    this.emitState(managed);

    await this.refreshSessionState(managed);
    managed.lifecycle = "idle";
    await this.persistSnapshot(managed);
    this.emitState(managed);
    return { ...managed };
  }

  private async persistSnapshot(
    agent: ManagedAgent,
    options?: { title?: string | null }
  ): Promise<void> {
    if (!this.registry) {
      return;
    }
    await this.registry.applySnapshot(agent, options);
  }

  private async refreshSessionState(agent: ActiveManagedAgent): Promise<void> {
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

  private async primeHistory(agent: ActiveManagedAgent): Promise<void> {
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
    agent: ActiveManagedAgent,
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
    this.dispatch({
      type: "agent_state",
      agent: { ...agent },
    });
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

  private requireAgent(id: string): ActiveManagedAgent {
    const agent = this.agents.get(id);
    if (!agent) {
      throw new Error(`Unknown agent '${id}'`);
    }
    return agent;
  }
}
