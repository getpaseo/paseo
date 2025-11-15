import { randomUUID } from "node:crypto";

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
} from "./agent-sdk-types.js";

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
  createdAt: Date;
  updatedAt: Date;
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

export type AgentManagerOptions = {
  clients?: Partial<Record<AgentProvider, AgentClient>>;
  maxTimelineItems?: number;
  idFactory?: () => string;
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
};

type SubscriptionRecord = {
  callback: AgentSubscriber;
  agentId: string | null;
};

const DEFAULT_MAX_TIMELINE_ITEMS = 2000;

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
    const client = this.requireClient(config.provider);
    const session = await client.createSession(config);
    return this.registerSession(session, config, agentId ?? this.idFactory());
  }

  async resumeAgent(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    agentId?: string
  ): Promise<AgentSnapshot> {
    const client = this.requireClient(handle.provider);
    const session = await client.resumeSession(handle, overrides);
    const metadata = (handle.metadata ?? {}) as Partial<AgentSessionConfig>;
    const mergedConfig = {
      ...metadata,
      ...overrides,
      provider: handle.provider,
    } as AgentSessionConfig;
    return this.registerSession(
      session,
      mergedConfig,
      agentId ?? this.idFactory()
    );
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

    const finalize = (error?: string) => {
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
    if (!agent.pendingRun || typeof agent.pendingRun.return !== "function") {
      return false;
    }
    try {
      await agent.pendingRun.return(undefined as unknown as AgentStreamEvent);
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
    };

    this.agents.set(agentId, managed);
    this.emitState(managed);

    await this.refreshSessionState(managed);
    managed.status = "idle";
    this.emitState(managed);
    void this.primeHistory(managed);
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
        this.handleStreamEvent(agent, event);
      }
    } catch {
      // ignore history failures
    }
  }

  private handleStreamEvent(
    agent: ManagedAgent,
    event: AgentStreamEvent
  ): void {
    agent.updatedAt = new Date();

    switch (event.type) {
      case "thread_started":
        agent.sessionId = event.sessionId;
        break;
      case "timeline":
        this.recordTimeline(agent, event.item);
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

    this.dispatchStream(agent.id, event);
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
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
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
