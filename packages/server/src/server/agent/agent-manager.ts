import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  AGENT_LIFECYCLE_STATUSES,
  type AgentLifecycleStatus,
} from "../../shared/agent-lifecycle.js";
import type { Logger } from "pino";
import { getSelfIdentificationInstructions } from "./self-identification-instructions.js";

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
  AgentRuntimeInfo,
  ListPersistedAgentsOptions,
  PersistedAgentDescriptor,
} from "./agent-sdk-types.js";
import type { AgentStorage } from "./agent-storage.js";

export { AGENT_LIFECYCLE_STATUSES, type AgentLifecycleStatus };

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

export type AgentAttentionCallback = (params: {
  agentId: string;
  provider: AgentProvider;
  reason: "finished" | "error" | "permission";
}) => void;

export type AgentManagerOptions = {
  clients?: Partial<Record<AgentProvider, AgentClient>>;
  maxTimelineItems?: number;
  idFactory?: () => string;
  registry?: AgentStorage;
  onAgentAttention?: AgentAttentionCallback;
  logger: Logger;
  /** Path to the Self-ID MCP Unix socket for UI agent injection */
  selfIdMcpSocketPath?: string;
};

export type WaitForAgentOptions = {
  signal?: AbortSignal;
  waitForActive?: boolean;
};

export type WaitForAgentResult = {
  status: AgentLifecycleStatus;
  permission: AgentPermissionRequest | null;
  lastMessage: string | null;
};

type AttentionState =
  | { requiresAttention: false }
  | {
      requiresAttention: true;
      attentionReason: "finished" | "error" | "permission";
      attentionTimestamp: Date;
    };

type ManagedAgentBase = {
  id: string;
  provider: AgentProvider;
  cwd: string;
  capabilities: AgentCapabilityFlags;
  config: AgentSessionConfig;
  runtimeInfo?: AgentRuntimeInfo;
  createdAt: Date;
  updatedAt: Date;
  availableModes: AgentMode[];
  currentModeId: string | null;
  pendingPermissions: Map<string, AgentPermissionRequest>;
  timeline: AgentTimelineItem[];
  persistence: AgentPersistenceHandle | null;
  historyPrimed: boolean;
  lastUserMessageAt: Date | null;
  lastUsage?: AgentUsage;
  lastError?: string;
  attention: AttentionState;
  /**
   * Internal agents are hidden from listings and don't trigger notifications.
   */
  internal?: boolean;
  /**
   * User-defined labels for categorizing agents (e.g., { ui: "true" }).
   */
  labels: Record<string, string>;
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
  private readonly registry?: AgentStorage;
  private readonly previousStatuses = new Map<string, AgentLifecycleStatus>();
  private readonly selfIdMcpSocketPath?: string;
  private onAgentAttention?: AgentAttentionCallback;
  private logger: Logger;

  constructor(options: AgentManagerOptions) {
    this.maxTimelineItems =
      options?.maxTimelineItems ?? DEFAULT_MAX_TIMELINE_ITEMS;
    this.idFactory = options?.idFactory ?? (() => randomUUID());
    this.registry = options?.registry;
    this.selfIdMcpSocketPath = options?.selfIdMcpSocketPath;
    this.onAgentAttention = options?.onAgentAttention;
    this.logger = options.logger.child({ module: "agent", component: "agent-manager" });
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

  setAgentAttentionCallback(callback: AgentAttentionCallback): void {
    this.onAgentAttention = callback;
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
        // For global subscribers, skip internal agents during replay
        for (const agent of this.agents.values()) {
          if (agent.internal) {
            continue;
          }
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
    return Array.from(this.agents.values())
      .filter((agent) => !agent.internal)
      .map((agent) => ({
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
        this.logger.warn(
          { err: error, provider },
          "Failed to list persisted agents for provider"
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
    agentId?: string,
    options?: { labels?: Record<string, string> }
  ): Promise<ManagedAgent> {
    // Generate agent ID early so we can use it in MCP config
    const resolvedAgentId = agentId ?? this.idFactory();
    const normalizedConfig = await this.normalizeConfig(config, {
      labels: options?.labels,
      agentId: resolvedAgentId,
    });
    const client = this.requireClient(normalizedConfig.provider);
    const session = await client.createSession(normalizedConfig);
    return this.registerSession(
      session,
      normalizedConfig,
      resolvedAgentId,
      { labels: options?.labels }
    );
  }

  async resumeAgent(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    agentId?: string,
    options?: {
      createdAt?: Date;
      updatedAt?: Date;
      lastUserMessageAt?: Date | null;
      labels?: Record<string, string>;
    }
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
      agentId ?? this.idFactory(),
      options
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
      this.logger.warn(
        { err: error, agentId },
        "Failed to close previous session during refresh"
      );
    }

    // Preserve existing labels during refresh
    return this.registerSession(session, overrides, agentId, { labels: existing.labels });
  }

  async closeAgent(agentId: string): Promise<void> {
    const agent = this.requireAgent(agentId);
    this.agents.delete(agentId);
    // Clean up previousStatus to prevent memory leak
    this.previousStatuses.delete(agentId);
    const session = agent.session;
    const closedAgent: ManagedAgent = {
      ...agent,
      lifecycle: "closed",
      session: null,
      pendingRun: null,
    };
    await session.close();
    this.emitState(closedAgent);
  }

  async setAgentMode(agentId: string, modeId: string): Promise<void> {
    const agent = this.requireAgent(agentId);
    await agent.session.setMode(modeId);
    agent.currentModeId = modeId;
    // Update runtimeInfo to reflect the new mode
    if (agent.runtimeInfo) {
      agent.runtimeInfo = { ...agent.runtimeInfo, modeId };
    }
    this.emitState(agent);
  }

  async setTitle(agentId: string, title: string): Promise<void> {
    const agent = this.requireAgent(agentId);
    await this.registry?.setTitle(agentId, title);
    this.emitState(agent);
  }

  async clearAgentAttention(agentId: string): Promise<void> {
    const agent = this.requireAgent(agentId);
    if (agent.attention.requiresAttention) {
      agent.attention = { requiresAttention: false };
      await this.persistSnapshot(agent);
      this.emitState(agent);
    }
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
    let canceled = false;

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
      } else if (event.type === "turn_canceled") {
        canceled = true;
      }
    }

    const agent = this.requireAgent(agentId);
    const sessionId = agent.persistence?.sessionId;
    if (!sessionId) {
      throw new Error(
        `Agent ${agentId} has no persistence.sessionId after run completed`
      );
    }
    return {
      sessionId,
      finalText,
      usage,
      timeline,
      canceled,
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

  async appendTimelineItem(agentId: string, item: AgentTimelineItem): Promise<void> {
    const agent = this.requireAgent(agentId);
    agent.updatedAt = new Date();
    this.recordTimeline(agent, item);
    this.dispatchStream(agentId, {
      type: "timeline",
      item,
      provider: agent.provider,
    });
    await this.persistSnapshot(agent);
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
      let finalizeError: string | undefined;
      try {
        for await (const event of iterator) {
          self.handleStreamEvent(agent, event);
          yield event;
        }
      } catch (error) {
        finalizeError =
          error instanceof Error ? error.message : "Agent stream failed";
        throw error;
      } finally {
        await self.refreshRuntimeInfo(agent);
        // Ensure we always clear the pending run and emit state when the stream is
        // cancelled early (e.g., via .return()) so the UI can exit the cancelling state.
        finalize(finalizeError);
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
      this.logger.error(
        { err: error, agentId },
        "Failed to interrupt session"
      );
    }

    try {
      // Await the generator's .return() to ensure the finally block runs
      // and pendingRun is properly cleared before we return.
      await pendingRun.return(undefined as unknown as AgentStreamEvent);
      return true;
    } catch (error) {
      this.logger.error(
        { err: error, agentId },
        "Failed to cancel run"
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

    const initialStatus = snapshot.lifecycle;
    const initialBusy = isAgentBusy(initialStatus);
    const waitForActive = options?.waitForActive ?? false;
    const hasPendingRun =
      "pendingRun" in snapshot && Boolean(snapshot.pendingRun);
    if (!waitForActive && !initialBusy) {
      return {
        status: initialStatus,
        permission: null,
        lastMessage: this.getLastAssistantMessage(agentId)
      };
    }
    if (waitForActive && !initialBusy && !hasPendingRun) {
      return {
        status: initialStatus,
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

      let currentStatus: AgentLifecycleStatus = initialStatus;
      let hasStarted = initialBusy || hasPendingRun;

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
          if (event.type === "agent_state") {
            currentStatus = event.agent.lifecycle;
            const pending = this.peekPendingPermission(event.agent);
            if (pending) {
              finish(pending);
              return;
            }
            if (isAgentBusy(event.agent.lifecycle)) {
              hasStarted = true;
              return;
            }
            if (!waitForActive || hasStarted) {
              finish(null);
            }
            return;
          }

          if (event.type === "agent_stream") {
            if (event.event.type === "permission_requested") {
              finish(event.event.request);
              return;
            }
            if (event.event.type === "turn_failed") {
              currentStatus = "error";
              hasStarted = true;
              finish(null);
              return;
            }
            if (event.event.type === "turn_completed") {
              currentStatus = "idle";
              hasStarted = true;
              finish(null);
            }
            if (event.event.type === "turn_canceled") {
              currentStatus = "idle";
              hasStarted = true;
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
    agentId: string,
    options?: {
      createdAt?: Date;
      updatedAt?: Date;
      lastUserMessageAt?: Date | null;
      labels?: Record<string, string>;
    }
  ): Promise<ManagedAgent> {
    if (this.agents.has(agentId)) {
      throw new Error(`Agent with id ${agentId} already exists`);
    }

    const now = new Date();
    const managed = {
      id: agentId,
      provider: config.provider,
      cwd: config.cwd,
      session,
      capabilities: session.capabilities,
      config,
      runtimeInfo: undefined,
      lifecycle: "initializing",
      createdAt: options?.createdAt ?? now,
      updatedAt: options?.updatedAt ?? now,
      availableModes: [],
      currentModeId: null,
      pendingPermissions: new Map(),
      pendingRun: null,
      timeline: [],
      persistence: session.describePersistence(),
      historyPrimed: false,
      lastUserMessageAt: options?.lastUserMessageAt ?? null,
      attention: { requiresAttention: false },
      internal: config.internal ?? false,
      labels: options?.labels ?? {},
    } as ActiveManagedAgent;

    this.agents.set(agentId, managed);
    // Initialize previousStatus to track transitions
    this.previousStatuses.set(agentId, managed.lifecycle);
    await this.refreshRuntimeInfo(managed);
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
    options?: { title?: string | null; internal?: boolean }
  ): Promise<void> {
    if (!this.registry) {
      return;
    }
    // Don't persist internal agents - they're ephemeral system tasks
    if (agent.internal) {
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

    await this.refreshRuntimeInfo(agent);
  }

  private async refreshRuntimeInfo(agent: ActiveManagedAgent): Promise<void> {
    try {
      const newInfo = await agent.session.getRuntimeInfo();
      const changed =
        newInfo.model !== agent.runtimeInfo?.model ||
        newInfo.sessionId !== agent.runtimeInfo?.sessionId ||
        newInfo.modeId !== agent.runtimeInfo?.modeId;
      agent.runtimeInfo = newInfo;
      // Emit state if runtimeInfo changed so clients get the updated model
      if (changed) {
        this.emitState(agent);
      }
    } catch {
      // Keep existing runtimeInfo if refresh fails.
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
    // Only update timestamp for live events, not history replay
    if (!options?.fromHistory) {
      agent.updatedAt = new Date();
    }

    switch (event.type) {
      case "thread_started":
        // Update persistence with the new session ID from the provider.
        // persistence.sessionId is the single source of truth for session identity.
        agent.persistence = agent.session.describePersistence();
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
        void this.refreshRuntimeInfo(agent);
        break;
      case "turn_failed":
        agent.lastError = event.error;
        break;
      case "turn_canceled":
        // Cancellation is not an error, just clear any previous error
        agent.lastError = undefined;
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
    // Check if attention should be set based on status change
    this.checkAndSetAttention(agent);

    this.dispatch({
      type: "agent_state",
      agent: { ...agent },
    });
  }

  private checkAndSetAttention(agent: ManagedAgent): void {
    const previousStatus = this.previousStatuses.get(agent.id);
    const currentStatus = agent.lifecycle;

    // Track the new status
    this.previousStatuses.set(agent.id, currentStatus);

    // Skip attention tracking for internal agents
    if (agent.internal) {
      return;
    }

    // Skip if already requires attention
    if (agent.attention.requiresAttention) {
      return;
    }

    // Check if agent transitioned from running to idle (finished)
    if (previousStatus === "running" && currentStatus === "idle") {
      agent.attention = {
        requiresAttention: true,
        attentionReason: "finished",
        attentionTimestamp: new Date(),
      };
      this.broadcastAgentAttention(agent, "finished");
      void this.persistSnapshot(agent);
      return;
    }

    // Check if agent entered error state
    if (currentStatus === "error") {
      agent.attention = {
        requiresAttention: true,
        attentionReason: "error",
        attentionTimestamp: new Date(),
      };
      this.broadcastAgentAttention(agent, "error");
      void this.persistSnapshot(agent);
      return;
    }

    // Check if agent has pending permissions
    if (agent.pendingPermissions.size > 0) {
      agent.attention = {
        requiresAttention: true,
        attentionReason: "permission",
        attentionTimestamp: new Date(),
      };
      this.broadcastAgentAttention(agent, "permission");
      void this.persistSnapshot(agent);
      return;
    }
  }

  private broadcastAgentAttention(
    agent: ManagedAgent,
    reason: "finished" | "error" | "permission"
  ): void {
    this.onAgentAttention?.({
      agentId: agent.id,
      provider: agent.provider,
      reason,
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
      // Skip internal agents for global subscribers (those without a specific agentId)
      if (!subscriber.agentId) {
        if (event.type === "agent_state" && event.agent.internal) {
          continue;
        }
        if (event.type === "agent_stream") {
          const agent = this.agents.get(event.agentId);
          if (agent?.internal) {
            continue;
          }
        }
      }
      subscriber.callback(event);
    }
  }


  private async normalizeConfig(
    config: AgentSessionConfig,
    options?: { labels?: Record<string, string>; agentId?: string }
  ): Promise<AgentSessionConfig> {
    const normalized: AgentSessionConfig = { ...config };

    // Always resolve cwd to absolute path for consistent history file lookup
    if (normalized.cwd) {
      normalized.cwd = resolve(normalized.cwd);
    }

    if (typeof normalized.model === "string") {
      const trimmed = normalized.model.trim();
      normalized.model = trimmed.length > 0 ? trimmed : undefined;
    }

    // Inject paseoPromptInstructions and MCP config for UI agents (with ui=true label)
    const isUiAgent = options?.labels?.ui === "true";
    if (isUiAgent) {
      normalized.paseoPromptInstructions = getSelfIdentificationInstructions({
        cwd: normalized.cwd,
      });

      // Inject Self-ID MCP server config (stdio bridge to self-id-mcp.sock)
      if (this.selfIdMcpSocketPath && options?.agentId) {
        const existingMcpServers = normalized.mcpServers ?? {};
        normalized.mcpServers = {
          ...existingMcpServers,
          "paseo-self-id": {
            type: "stdio",
            command: "paseo",
            args: [
              "self-id-bridge",
              "--socket", this.selfIdMcpSocketPath,
              "--agent-id", options.agentId,
            ],
          },
        };
      }
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
