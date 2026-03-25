import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import {
  AGENT_LIFECYCLE_STATUSES,
  type AgentLifecycleStatus,
} from "../../shared/agent-lifecycle.js";
import type { Logger } from "pino";
import { z } from "zod";

import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentLaunchContext,
  AgentSlashCommand,
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
import type { StoredAgentRecord } from "./agent-storage.js";
import type { AgentSnapshotStore } from "./agent-snapshot-store.js";
import {
  InMemoryAgentTimelineStore,
  type SeedAgentTimelineOptions,
} from "./agent-timeline-store.js";
import { AGENT_PROVIDER_IDS } from "./provider-manifest.js";

export { AGENT_LIFECYCLE_STATUSES, type AgentLifecycleStatus };

export type AgentManagerEvent =
  | { type: "agent_state"; agent: ManagedAgent }
  | {
      type: "agent_stream";
      agentId: string;
      event: AgentStreamEvent;
      seq?: number;
    };

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

export type ProviderAvailability = {
  provider: AgentProvider;
  available: boolean;
  error: string | null;
};

export type AgentManagerOptions = {
  clients?: Partial<Record<AgentProvider, AgentClient>>;
  idFactory?: () => string;
  registry?: AgentSnapshotStore;
  onAgentAttention?: AgentAttentionCallback;
  logger: Logger;
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

export type WaitForAgentStartOptions = {
  signal?: AbortSignal;
};

export type AgentTimelineRow = {
  seq: number;
  timestamp: string;
  item: AgentTimelineItem;
};

export type AgentTimelineCursor = {
  seq: number;
};

export type AgentTimelineFetchDirection = "tail" | "before" | "after";

export type AgentTimelineFetchOptions = {
  direction?: AgentTimelineFetchDirection;
  cursor?: AgentTimelineCursor;
  /**
   * Number of canonical rows to return.
   * - undefined: manager default
   * - 0: all rows in the selected window
   */
  limit?: number;
};

export type AgentTimelineWindow = {
  minSeq: number;
  maxSeq: number;
  nextSeq: number;
};

export type AgentTimelineFetchResult = {
  direction: AgentTimelineFetchDirection;
  window: AgentTimelineWindow;
  hasOlder: boolean;
  hasNewer: boolean;
  rows: AgentTimelineRow[];
};

type AttentionState =
  | { requiresAttention: false }
  | {
      requiresAttention: true;
      attentionReason: "finished" | "error" | "permission";
      attentionTimestamp: Date;
    };

type ForegroundTurnWaiter = {
  turnId: string;
  callback: (event: AgentStreamEvent) => void;
  settled: boolean;
  settledPromise: Promise<void>;
  resolveSettled: () => void;
};

type PendingForegroundRun = {
  token: string;
  started: boolean;
  settled: boolean;
  settledPromise: Promise<void>;
  resolveSettled: () => void;
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
  pendingReplacement: boolean;
  provisionalAssistantText: string | null;
  persistence: AgentPersistenceHandle | null;
  historyPrimed: boolean;
  lastUserMessageAt: Date | null;
  lastUsage?: AgentUsage;
  lastError?: string;
  attention: AttentionState;
  foregroundTurnWaiters: Set<ForegroundTurnWaiter>;
  unsubscribeSession: (() => void) | null;
  /**
   * Internal agents are hidden from listings and don't trigger notifications.
   */
  internal?: boolean;
  /**
   * User-defined labels for categorizing agents (e.g., { surface: "workspace" }).
   */
  labels: Record<string, string>;
};

type ManagedAgentWithSession = ManagedAgentBase & {
  session: AgentSession;
};

type ManagedAgentInitializing = ManagedAgentWithSession & {
  lifecycle: "initializing";
  activeForegroundTurnId: null;
};

type ManagedAgentIdle = ManagedAgentWithSession & {
  lifecycle: "idle";
  activeForegroundTurnId: null;
};

type ManagedAgentRunning = ManagedAgentWithSession & {
  lifecycle: "running";
  activeForegroundTurnId: string | null;
};

type ManagedAgentError = ManagedAgentWithSession & {
  lifecycle: "error";
  activeForegroundTurnId: null;
  lastError: string;
};

type ManagedAgentClosed = ManagedAgentBase & {
  lifecycle: "closed";
  session: null;
  activeForegroundTurnId: null;
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

const SYSTEM_ERROR_PREFIX = "[System Error]";

function attachPersistenceCwd(
  handle: AgentPersistenceHandle | null,
  cwd: string,
): AgentPersistenceHandle | null {
  if (!handle) {
    return null;
  }
  return {
    ...handle,
    metadata: {
      ...(handle.metadata ?? {}),
      cwd,
    },
  };
}

type SubscriptionRecord = {
  callback: AgentSubscriber;
  agentId: string | null;
};

const BUSY_STATUSES: AgentLifecycleStatus[] = ["initializing", "running"];
const AgentIdSchema = z.string().uuid();

function isAgentBusy(status: AgentLifecycleStatus): boolean {
  return BUSY_STATUSES.includes(status);
}

function isTurnTerminalEvent(event: AgentStreamEvent): boolean {
  return (
    event.type === "turn_completed" ||
    event.type === "turn_failed" ||
    event.type === "turn_canceled"
  );
}

function createAbortError(signal: AbortSignal | undefined, fallbackMessage: string): Error {
  const reason = signal?.reason;
  const message =
    typeof reason === "string"
      ? reason
      : reason instanceof Error
        ? reason.message
        : fallbackMessage;
  return Object.assign(new Error(message), { name: "AbortError" });
}

function validateAgentId(agentId: string, source: string): string {
  const result = AgentIdSchema.safeParse(agentId);
  if (!result.success) {
    throw new Error(`${source}: agentId must be a UUID`);
  }
  return result.data;
}

function normalizeMessageId(messageId: string | undefined): string | undefined {
  if (typeof messageId !== "string") {
    return undefined;
  }
  const trimmed = messageId.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export class AgentManager {
  private readonly clients = new Map<AgentProvider, AgentClient>();
  private readonly agents = new Map<string, ActiveManagedAgent>();
  private readonly timelineStore = new InMemoryAgentTimelineStore();
  private readonly pendingForegroundRuns = new Map<string, PendingForegroundRun>();
  private readonly subscribers = new Set<SubscriptionRecord>();
  private readonly idFactory: () => string;
  private readonly registry?: AgentSnapshotStore;
  private readonly previousStatuses = new Map<string, AgentLifecycleStatus>();
  private readonly backgroundTasks = new Set<Promise<void>>();
  private onAgentAttention?: AgentAttentionCallback;
  private logger: Logger;

  constructor(options: AgentManagerOptions) {
    this.idFactory = options?.idFactory ?? (() => randomUUID());
    this.registry = options?.registry;
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

  private touchUpdatedAt(agent: ManagedAgent): Date {
    const nowMs = Date.now();
    const previousMs = agent.updatedAt.getTime();
    const nextMs = nowMs > previousMs ? nowMs : previousMs + 1;
    const next = new Date(nextMs);
    agent.updatedAt = next;
    return next;
  }

  hasInFlightRun(agentId: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return false;
    }

    return (
      agent.lifecycle === "running" ||
      Boolean(agent.activeForegroundTurnId) ||
      this.hasPendingForegroundRun(agentId)
    );
  }

  subscribe(callback: AgentSubscriber, options?: SubscribeOptions): () => void {
    const targetAgentId =
      options?.agentId == null ? null : validateAgentId(options.agentId, "subscribe");
    const record: SubscriptionRecord = {
      callback,
      agentId: targetAgentId,
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
    options?: PersistedAgentQueryOptions,
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
        this.logger.warn({ err: error, provider }, "Failed to list persisted agents for provider");
      }
    }

    const limit = options?.limit ?? 20;
    return descriptors
      .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime())
      .slice(0, limit);
  }

  async listProviderAvailability(): Promise<ProviderAvailability[]> {
    const checks = AGENT_PROVIDER_IDS.map(async (providerId) => {
      const provider = providerId as AgentProvider;
      const client = this.clients.get(provider);
      if (!client) {
        return {
          provider,
          available: false,
          error: `No client registered for provider '${provider}'`,
        } satisfies ProviderAvailability;
      }

      try {
        const available = await client.isAvailable();
        return {
          provider,
          available,
          error: null,
        } satisfies ProviderAvailability;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn({ err: error, provider }, "Failed to check provider availability");
        return {
          provider,
          available: false,
          error: message,
        } satisfies ProviderAvailability;
      }
    });

    return Promise.all(checks);
  }

  async listDraftCommands(config: AgentSessionConfig): Promise<AgentSlashCommand[]> {
    const normalizedConfig = await this.normalizeConfig(config);
    const client = this.requireClient(normalizedConfig.provider);
    const available = await client.isAvailable();
    if (!available) {
      throw new Error(
        `Provider '${normalizedConfig.provider}' is not available. Please ensure the CLI is installed.`,
      );
    }

    const session = await client.createSession(normalizedConfig);
    try {
      if (!session.listCommands) {
        throw new Error(
          `Provider '${normalizedConfig.provider}' does not support listing commands`,
        );
      }
      return await session.listCommands();
    } finally {
      try {
        await session.close();
      } catch (error) {
        this.logger.warn(
          { err: error, provider: normalizedConfig.provider },
          "Failed to close draft command listing session",
        );
      }
    }
  }

  getAgent(id: string): ManagedAgent | null {
    const agent = this.agents.get(id);
    return agent ? { ...agent } : null;
  }

  getTimeline(id: string): AgentTimelineItem[] {
    this.requireAgent(id);
    return this.timelineStore.getItems(id);
  }

  getTimelineRows(id: string): AgentTimelineRow[] {
    this.requireAgent(id);
    return this.timelineStore.getRows(id);
  }

  fetchTimeline(id: string, options?: AgentTimelineFetchOptions): AgentTimelineFetchResult {
    this.requireAgent(id);
    return this.timelineStore.fetch(id, options);
  }

  async createAgent(
    config: AgentSessionConfig,
    agentId?: string,
    options?: { labels?: Record<string, string> },
  ): Promise<ManagedAgent> {
    // Generate agent ID early so we can use it in MCP config
    const resolvedAgentId = validateAgentId(agentId ?? this.idFactory(), "createAgent");
    const normalizedConfig = await this.normalizeConfig(config);
    const launchContext = this.buildLaunchContext(resolvedAgentId);
    const client = this.requireClient(normalizedConfig.provider);
    const available = await client.isAvailable();
    if (!available) {
      throw new Error(
        `Provider '${normalizedConfig.provider}' is not available. Please ensure the CLI is installed.`,
      );
    }
    const session = await client.createSession(normalizedConfig, launchContext);
    return this.registerSession(session, normalizedConfig, resolvedAgentId, {
      labels: options?.labels,
    });
  }

  // Reconstruct an agent from provider persistence. Callers should explicitly
  // hydrate timeline history after resume.
  async resumeAgentFromPersistence(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    agentId?: string,
    options?: {
      createdAt?: Date;
      updatedAt?: Date;
      lastUserMessageAt?: Date | null;
      labels?: Record<string, string>;
    },
  ): Promise<ManagedAgent> {
    const resolvedAgentId = validateAgentId(
      agentId ?? this.idFactory(),
      "resumeAgentFromPersistence",
    );
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
    const launchContext = this.buildLaunchContext(resolvedAgentId);
    const client = this.requireClient(handle.provider);
    const session = await client.resumeSession(handle, resumeOverrides, launchContext);
    return this.registerSession(session, normalizedConfig, resolvedAgentId, options);
  }

  // Hot-reload an active agent session with config overrides while preserving
  // in-memory timeline state.
  async reloadAgentSession(
    agentId: string,
    overrides?: Partial<AgentSessionConfig>,
  ): Promise<ManagedAgent> {
    let existing = this.requireAgent(agentId);
    if (this.hasInFlightRun(agentId)) {
      await this.cancelAgentRun(agentId);
      existing = this.requireAgent(agentId);
    }
    const preservedProvisionalAssistantText = existing.provisionalAssistantText;
    const preservedHistoryPrimed = existing.historyPrimed;
    const preservedLastUsage = existing.lastUsage;
    const preservedLastError = existing.lastError;
    const preservedAttention = existing.attention;
    const handle = existing.persistence;
    const provider = handle?.provider ?? existing.provider;
    const client = this.requireClient(provider);
    const refreshConfig = {
      ...existing.config,
      ...overrides,
      provider,
    } as AgentSessionConfig;
    const normalizedConfig = await this.normalizeConfig(refreshConfig);
    const launchContext = this.buildLaunchContext(agentId);

    const session = handle
      ? await client.resumeSession(handle, normalizedConfig, launchContext)
      : await client.createSession(normalizedConfig, launchContext);

    // Remove the existing agent entry before swapping sessions
    this.agents.delete(agentId);
    if (existing.unsubscribeSession) {
      existing.unsubscribeSession();
      existing.unsubscribeSession = null;
    }
    for (const waiter of existing.foregroundTurnWaiters) {
      this.settleForegroundTurnWaiter(waiter);
    }
    existing.foregroundTurnWaiters.clear();
    this.settlePendingForegroundRun(agentId);
    try {
      await existing.session.close();
    } catch (error) {
      this.logger.warn({ err: error, agentId }, "Failed to close previous session during refresh");
    }

    // Preserve existing labels and timeline during reload.
    return this.registerSession(session, normalizedConfig, agentId, {
      labels: existing.labels,
      createdAt: existing.createdAt,
      updatedAt: existing.updatedAt,
      lastUserMessageAt: existing.lastUserMessageAt,
      provisionalAssistantText: preservedProvisionalAssistantText,
      historyPrimed: preservedHistoryPrimed,
      lastUsage: preservedLastUsage,
      lastError: preservedLastError,
      attention: preservedAttention,
    });
  }

  async closeAgent(agentId: string): Promise<void> {
    const agent = this.requireAgent(agentId);
    this.logger.trace(
      {
        agentId,
        lifecycle: agent.lifecycle,
        activeForegroundTurnId: agent.activeForegroundTurnId,
        pendingPermissions: agent.pendingPermissions.size,
      },
      "closeAgent: start",
    );
    this.agents.delete(agentId);
    // Clean up previousStatus to prevent memory leak
    this.previousStatuses.delete(agentId);
    if (agent.unsubscribeSession) {
      agent.unsubscribeSession();
      agent.unsubscribeSession = null;
    }
    for (const waiter of agent.foregroundTurnWaiters) {
      // Wake up the generator so it can exit the await loop
      waiter.callback({
        type: "turn_canceled",
        provider: agent.provider,
        reason: "agent closed",
        turnId: waiter.turnId,
      });
      this.settleForegroundTurnWaiter(waiter);
    }
    agent.foregroundTurnWaiters.clear();
    this.settlePendingForegroundRun(agentId);
    const session = agent.session;
    const closedAgent: ManagedAgent = {
      ...agent,
      lifecycle: "closed",
      session: null,
      activeForegroundTurnId: null,
    };
    await session.close();
    this.timelineStore.delete(agentId);
    this.emitState(closedAgent);
    this.logger.trace({ agentId }, "closeAgent: completed");
  }

  async setAgentMode(agentId: string, modeId: string): Promise<void> {
    const agent = this.requireAgent(agentId);
    await agent.session.setMode(modeId);
    agent.currentModeId = modeId;
    // Update runtimeInfo to reflect the new mode
    if (agent.runtimeInfo) {
      agent.runtimeInfo = { ...agent.runtimeInfo, modeId };
    }
    this.touchUpdatedAt(agent);
    this.emitState(agent);
  }

  async setAgentModel(agentId: string, modelId: string | null): Promise<void> {
    const agent = this.requireAgent(agentId);
    const normalizedModelId =
      typeof modelId === "string" && modelId.trim().length > 0 ? modelId : null;

    if (agent.session.setModel) {
      await agent.session.setModel(normalizedModelId);
    }

    agent.config.model = normalizedModelId ?? undefined;
    if (agent.runtimeInfo) {
      agent.runtimeInfo = { ...agent.runtimeInfo, model: normalizedModelId };
    }
    this.touchUpdatedAt(agent);
    this.emitState(agent);
  }

  async setAgentThinkingOption(agentId: string, thinkingOptionId: string | null): Promise<void> {
    const agent = this.requireAgent(agentId);
    const normalizedThinkingOptionId =
      typeof thinkingOptionId === "string" && thinkingOptionId.trim().length > 0
        ? thinkingOptionId
        : null;

    if (agent.session.setThinkingOption) {
      await agent.session.setThinkingOption(normalizedThinkingOptionId);
    }

    agent.config.thinkingOptionId = normalizedThinkingOptionId ?? undefined;
    if (agent.runtimeInfo) {
      agent.runtimeInfo = {
        ...agent.runtimeInfo,
        thinkingOptionId: normalizedThinkingOptionId,
      };
    }
    this.touchUpdatedAt(agent);
    this.emitState(agent);
  }

  async setTitle(agentId: string, title: string): Promise<void> {
    const agent = this.requireAgent(agentId);
    const normalizedTitle = title.trim();
    if (!normalizedTitle) {
      return;
    }
    this.touchUpdatedAt(agent);
    await this.persistSnapshot(agent, { title: normalizedTitle });
    this.emitState(agent, { persist: false });
  }

  async setLabels(agentId: string, labels: Record<string, string>): Promise<void> {
    const agent = this.requireAgent(agentId);
    agent.labels = { ...agent.labels, ...labels };
    this.touchUpdatedAt(agent);
    await this.persistSnapshot(agent);
    this.emitState(agent, { persist: false });
  }

  notifyAgentState(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent || agent.internal) {
      return;
    }
    this.touchUpdatedAt(agent);
    this.emitState(agent);
  }

  async clearAgentAttention(agentId: string): Promise<void> {
    const agent = this.requireAgent(agentId);
    if (agent.attention.requiresAttention) {
      agent.attention = { requiresAttention: false };
      await this.persistSnapshot(agent);
      this.emitState(agent, { persist: false });
    }
  }

  async archiveSnapshot(agentId: string, archivedAt: string): Promise<StoredAgentRecord> {
    const registry = this.requireRegistry();
    const liveAgent = this.getAgent(agentId);
    if (liveAgent) {
      await this.persistSnapshot(liveAgent, {
        internal: liveAgent.internal,
      });
    }

    const record = await registry.get(agentId);
    if (!record) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const normalizedStatus =
      record.lastStatus === "running" || record.lastStatus === "initializing"
        ? "idle"
        : record.lastStatus;

    const nextRecord: StoredAgentRecord = {
      ...record,
      archivedAt,
      lastStatus: normalizedStatus,
      requiresAttention: false,
      attentionReason: null,
      attentionTimestamp: null,
    };
    await registry.upsert(nextRecord);
    return nextRecord;
  }

  async unarchiveSnapshot(agentId: string): Promise<boolean> {
    const registry = this.requireRegistry();
    const record = await registry.get(agentId);
    if (!record || !record.archivedAt) {
      return false;
    }

    await registry.upsert({
      ...record,
      archivedAt: null,
    });

    if (this.getAgent(agentId)) {
      this.notifyAgentState(agentId);
    }
    return true;
  }

  async unarchiveSnapshotByHandle(handle: AgentPersistenceHandle): Promise<void> {
    const registry = this.requireRegistry();
    const records = await registry.list();
    const matched = records.find(
      (record) =>
        record.persistence?.provider === handle.provider &&
        record.persistence?.sessionId === handle.sessionId,
    );
    if (!matched) {
      return;
    }

    await this.unarchiveSnapshot(matched.id);
  }

  async updateAgentMetadata(
    agentId: string,
    updates: {
      title?: string;
      labels?: Record<string, string>;
    },
  ): Promise<void> {
    const liveAgent = this.getAgent(agentId);
    if (liveAgent) {
      if (updates.title) {
        await this.setTitle(agentId, updates.title);
      }
      if (updates.labels) {
        await this.setLabels(agentId, updates.labels);
      }
      return;
    }

    const registry = this.requireRegistry();
    const existing = await registry.get(agentId);
    if (!existing) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    await registry.upsert({
      ...existing,
      ...(updates.title ? { title: updates.title } : {}),
      ...(updates.labels ? { labels: { ...existing.labels, ...updates.labels } } : {}),
    });
  }

  async runAgent(
    agentId: string,
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): Promise<AgentRunResult> {
    const events = this.streamAgent(agentId, prompt, options);
    const timeline: AgentTimelineItem[] = [];
    let finalText = "";
    let usage: AgentUsage | undefined;
    let canceled = false;

    for await (const event of events) {
      if (event.type === "timeline") {
        timeline.push(event.item);
      } else if (event.type === "turn_completed") {
        usage = event.usage;
      } else if (event.type === "turn_failed") {
        throw new Error(this.formatTurnFailedMessage(event));
      } else if (event.type === "turn_canceled") {
        canceled = true;
      }
    }

    finalText = this.getLastAssistantMessageFromTimeline(timeline) ?? "";

    const agent = this.requireAgent(agentId);
    const sessionId = agent.persistence?.sessionId;
    if (!sessionId) {
      throw new Error(`Agent ${agentId} has no persistence.sessionId after run completed`);
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
    options?: { messageId?: string; emitState?: boolean },
  ): void {
    const agent = this.requireAgent(agentId);
    const normalizedMessageId = normalizeMessageId(options?.messageId);
    const item: AgentTimelineItem = {
      type: "user_message",
      text,
      messageId: normalizedMessageId,
    };
    const updatedAt = this.touchUpdatedAt(agent);
    agent.lastUserMessageAt = updatedAt;
    const row = this.recordTimeline(agentId, item);
    this.dispatchStream(
      agentId,
      {
        type: "timeline",
        item,
        provider: agent.provider,
      },
      {
        seq: row.seq,
      },
    );
    if (options?.emitState !== false) {
      this.emitState(agent);
    }
  }

  async appendTimelineItem(agentId: string, item: AgentTimelineItem): Promise<void> {
    const agent = this.requireAgent(agentId);
    this.touchUpdatedAt(agent);
    const row = this.recordTimeline(agentId, item);
    this.dispatchStream(
      agentId,
      {
        type: "timeline",
        item,
        provider: agent.provider,
      },
      {
        seq: row.seq,
      },
    );
    await this.persistSnapshot(agent);
  }

  async emitLiveTimelineItem(agentId: string, item: AgentTimelineItem): Promise<void> {
    const agent = this.requireAgent(agentId);
    this.touchUpdatedAt(agent);
    this.dispatchStream(agentId, {
      type: "timeline",
      item,
      provider: agent.provider,
    });
  }

  streamAgent(
    agentId: string,
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): AsyncGenerator<AgentStreamEvent> {
    const existingAgent = this.requireAgent(agentId);
    this.logger.trace(
      {
        agentId,
        lifecycle: existingAgent.lifecycle,
        activeForegroundTurnId: existingAgent.activeForegroundTurnId,
        hasPendingForegroundRun: this.hasPendingForegroundRun(agentId),
        promptType: typeof prompt === "string" ? "string" : "structured",
        hasRunOptions: Boolean(options),
      },
      "streamAgent: requested",
    );
    if (existingAgent.activeForegroundTurnId || this.hasPendingForegroundRun(agentId)) {
      this.logger.trace(
        {
          agentId,
          lifecycle: existingAgent.lifecycle,
          hasPendingForegroundRun: this.hasPendingForegroundRun(agentId),
        },
        "streamAgent: rejected because a foreground run is already in flight",
      );
      throw new Error(`Agent ${agentId} already has an active run`);
    }

    const agent = existingAgent as ActiveManagedAgent;
    agent.pendingReplacement = false;
    agent.lastError = undefined;

    const self = this;

    const streamForwarder = (async function* streamForwarder() {
      const pendingRun = self.createPendingForegroundRun();
      self.pendingForegroundRuns.set(agentId, pendingRun);

      let turnId: string;
      let waiter: ForegroundTurnWaiter | null = null;
      try {
        const result = await agent.session.startTurn(prompt, options);
        turnId = result.turnId;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : "Failed to start turn";
        self.handleStreamEvent(agent, {
          type: "turn_failed",
          provider: agent.provider,
          error: errorMsg,
        });
        self.finalizeForegroundTurn(agent);
        throw error;
      }

      pendingRun.started = true;
      agent.activeForegroundTurnId = turnId;
      agent.lifecycle = "running";
      self.touchUpdatedAt(agent);
      self.emitState(agent);
      self.logger.trace(
        {
          agentId,
          lifecycle: agent.lifecycle,
          activeForegroundTurnId: agent.activeForegroundTurnId,
        },
        "streamAgent: started",
      );

      // Create a pushable queue for this foreground turn
      const queue: AgentStreamEvent[] = [];
      let queueResolve: (() => void) | null = null;
      let done = false;
      let resolveSettled!: () => void;
      const settledPromise = new Promise<void>((resolve) => {
        resolveSettled = resolve;
      });

      waiter = {
        turnId,
        settled: false,
        settledPromise,
        resolveSettled,
        callback: (event: AgentStreamEvent) => {
          queue.push(event);
          if (queueResolve) {
            queueResolve();
            queueResolve = null;
          }
        },
      };
      agent.foregroundTurnWaiters.add(waiter);

      try {
        while (!done) {
          while (queue.length > 0) {
            const event = queue.shift()!;
            yield event;
            if (isTurnTerminalEvent(event)) {
              done = true;
              break;
            }
          }
          if (!done && queue.length === 0) {
            if (waiter.settled) {
              break;
            }
            await new Promise<void>((resolve) => {
              queueResolve = resolve;
            });
          }
        }
      } finally {
        if (waiter) {
          agent.foregroundTurnWaiters.delete(waiter);
          self.settleForegroundTurnWaiter(waiter);
        }
        self.settlePendingForegroundRun(agentId, pendingRun.token);
        if (!agent.activeForegroundTurnId) {
          await self.refreshRuntimeInfo(agent);
        }
      }
    })();

    return streamForwarder;
  }

  private finalizeForegroundTurn(agent: ActiveManagedAgent): void {
    const mutableAgent = agent as ActiveManagedAgent;
    mutableAgent.activeForegroundTurnId = null;
    const terminalError = mutableAgent.lastError;
    const shouldHoldBusyForReplacement = mutableAgent.pendingReplacement && !terminalError;
    mutableAgent.lifecycle = shouldHoldBusyForReplacement
      ? "running"
      : terminalError
        ? "error"
        : "idle";
    const persistenceHandle =
      mutableAgent.session.describePersistence() ??
      (mutableAgent.runtimeInfo?.sessionId
        ? { provider: mutableAgent.provider, sessionId: mutableAgent.runtimeInfo.sessionId }
        : null);
    if (persistenceHandle) {
      mutableAgent.persistence = attachPersistenceCwd(persistenceHandle, mutableAgent.cwd);
    }
    this.logger.trace(
      {
        agentId: agent.id,
        lifecycle: mutableAgent.lifecycle,
        terminalError,
        pendingReplacement: mutableAgent.pendingReplacement,
      },
      "finalizeForegroundTurn: applying terminal state",
    );
    if (!shouldHoldBusyForReplacement) {
      this.touchUpdatedAt(mutableAgent);
      this.emitState(mutableAgent);
    }
  }

  replaceAgentRun(
    agentId: string,
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): AsyncGenerator<AgentStreamEvent> {
    const snapshot = this.requireAgent(agentId);
    if (
      snapshot.lifecycle !== "running" &&
      !snapshot.activeForegroundTurnId &&
      !this.hasPendingForegroundRun(agentId)
    ) {
      return this.streamAgent(agentId, prompt, options);
    }

    const agent = snapshot as ActiveManagedAgent;
    agent.pendingReplacement = true;

    const self = this;
    return (async function* replaceRunForwarder() {
      try {
        await self.cancelAgentRun(agentId);
        const nextRun = self.streamAgent(agentId, prompt, options);
        for await (const event of nextRun) {
          yield event;
        }
      } catch (error) {
        const latest = self.agents.get(agentId);
        if (latest) {
          const latestActive = latest as ActiveManagedAgent;
          latestActive.pendingReplacement = false;
          if (!latestActive.activeForegroundTurnId && latestActive.lifecycle === "running") {
            (latestActive as ActiveManagedAgent).lifecycle = "idle";
            self.touchUpdatedAt(latestActive);
            self.emitState(latestActive);
          }
        }
        throw error;
      }
    })();
  }

  async waitForAgentRunStart(agentId: string, options?: WaitForAgentStartOptions): Promise<void> {
    const snapshot = this.getAgent(agentId);
    if (!snapshot) {
      throw new Error(`Agent ${agentId} not found`);
    }

    const pendingRun = this.getPendingForegroundRun(agentId);
    if (
      (snapshot.lifecycle === "running" || pendingRun?.started) &&
      !snapshot.pendingReplacement
    ) {
      return;
    }

    if (!snapshot.activeForegroundTurnId && !pendingRun && !snapshot.pendingReplacement) {
      throw new Error(`Agent ${agentId} has no pending run`);
    }

    if (options?.signal?.aborted) {
      throw createAbortError(options.signal, "wait_for_agent_start aborted");
    }

    await new Promise<void>((resolve, reject) => {
      if (options?.signal?.aborted) {
        reject(createAbortError(options.signal, "wait_for_agent_start aborted"));
        return;
      }

      let unsubscribe: (() => void) | null = null;
      let abortHandler: (() => void) | null = null;

      const cleanup = () => {
        if (unsubscribe) {
          try {
            unsubscribe();
          } catch {
            // ignore cleanup errors
          }
          unsubscribe = null;
        }
        if (abortHandler && options?.signal) {
          try {
            options.signal.removeEventListener("abort", abortHandler);
          } catch {
            // ignore cleanup errors
          }
          abortHandler = null;
        }
      };

      const finishOk = () => {
        cleanup();
        resolve();
      };

      const finishErr = (error: unknown) => {
        cleanup();
        reject(error);
      };

      if (options?.signal) {
        abortHandler = () =>
          finishErr(createAbortError(options.signal!, "wait_for_agent_start aborted"));
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }

      const checkCurrentState = () => {
        const current = this.getAgent(agentId);
        if (!current) {
          finishErr(new Error(`Agent ${agentId} not found`));
          return true;
        }

        const currentPendingRun = this.getPendingForegroundRun(agentId);
        if (
          (current.lifecycle === "running" || currentPendingRun?.started) &&
          !current.pendingReplacement
        ) {
          finishOk();
          return true;
        }

        if (current.lifecycle === "error" && !currentPendingRun?.started) {
          finishErr(new Error(current.lastError ?? `Agent ${agentId} failed to start`));
          return true;
        }

        if (
          !currentPendingRun &&
          !current.activeForegroundTurnId &&
          !current.pendingReplacement
        ) {
          finishErr(new Error(`Agent ${agentId} run finished before starting`));
          return true;
        }

        return false;
      };

      unsubscribe = this.subscribe(
        (event) => {
          if (event.type !== "agent_state" || event.agent.id !== agentId) {
            return;
          }
          checkCurrentState();
        },
        { agentId, replayState: false },
      );

      checkCurrentState();
    });
  }

  async respondToPermission(
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<void> {
    const agent = this.requireAgent(agentId);
    await agent.session.respondToPermission(requestId, response);
    agent.pendingPermissions.delete(requestId);

    // Update currentModeId - the session may have changed mode internally
    // (e.g., plan approval changes mode from "plan" to "acceptEdits")
    try {
      agent.currentModeId = await agent.session.getCurrentMode();
      if (agent.runtimeInfo) {
        agent.runtimeInfo = {
          ...agent.runtimeInfo,
          modeId: agent.currentModeId,
        };
      }
    } catch {
      // Ignore errors from getCurrentMode - mode tracking is best effort
    }

    this.emitState(agent);
  }

  async cancelAgentRun(agentId: string): Promise<boolean> {
    const agent = this.requireAgent(agentId);
    const pendingRun = this.getPendingForegroundRun(agentId);
    const foregroundTurnId = agent.activeForegroundTurnId;
    const hasForegroundTurn = Boolean(foregroundTurnId);
    const isAutonomousRunning =
      agent.lifecycle === "running" && !hasForegroundTurn && !pendingRun;

    if (!hasForegroundTurn && !isAutonomousRunning && !pendingRun) {
      return false;
    }

    try {
      await agent.session.interrupt();
    } catch (error) {
      this.logger.error({ err: error, agentId }, "Failed to interrupt session");
    }

    // The interrupt will produce a turn_canceled/turn_failed event via subscribe(),
    // which flows through the session event dispatcher and settles the foreground turn waiter.
    // Wait briefly for the event to propagate if there's an active foreground turn.
    if (foregroundTurnId) {
      const waiter = Array.from(agent.foregroundTurnWaiters).find(
        (candidate) => candidate.turnId === foregroundTurnId,
      );
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 2000));
      if (waiter) {
        await Promise.race([waiter.settledPromise, timeout]);
      } else if (agent.activeForegroundTurnId === foregroundTurnId) {
        await Promise.race([
          new Promise<void>((resolve) => {
            const unsubscribe = this.subscribe(
              (event) => {
                if (
                  event.type === "agent_state" &&
                  event.agent.id === agentId &&
                  !event.agent.activeForegroundTurnId
                ) {
                  unsubscribe();
                  resolve();
                }
              },
              { agentId, replayState: false },
            );
          }),
          timeout,
        ]);
      }
      // The waiter settling wakes up the streamForwarder generator, but its
      // finally block (which deletes the pendingForegroundRun) runs asynchronously.
      // Wait for the pending run to be fully cleaned up so the next streamAgent
      // call doesn't see a stale entry and reject with "already has an active run".
      if (pendingRun && !pendingRun.settled) {
        await Promise.race([pendingRun.settledPromise, timeout]);
      }
    } else if (pendingRun) {
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 2000));
      await Promise.race([pendingRun.settledPromise, timeout]);
    }

    // If the foreground turn is still stuck after the timeout, force-dispatch a
    // synthetic turn_canceled so the normal event pipeline cleans up
    // activeForegroundTurnId, settles waiters, and unblocks the streamForwarder.
    if (foregroundTurnId && agent.activeForegroundTurnId === foregroundTurnId) {
      this.logger.warn(
        { agentId, foregroundTurnId },
        "cancelAgentRun: foreground turn still active after timeout, force-canceling",
      );
      this.dispatchSessionEvent(agent, {
        type: "turn_canceled",
        provider: agent.provider,
        reason: "interrupted",
        turnId: foregroundTurnId,
      });
      // The synthetic event unblocks the streamForwarder generator, whose finally
      // block settles the pending foreground run asynchronously. Wait for it.
      const staleRun = this.getPendingForegroundRun(agentId);
      if (staleRun && !staleRun.settled) {
        await staleRun.settledPromise;
      }
    }

    // Clear any pending permissions that weren't cleaned up by handleStreamEvent.
    if (agent.pendingPermissions.size > 0) {
      for (const [requestId] of agent.pendingPermissions) {
        this.dispatchStream(agent.id, {
          type: "permission_resolved",
          provider: agent.provider,
          requestId,
          resolution: { behavior: "deny", message: "Interrupted" },
        });
      }
      agent.pendingPermissions.clear();
      this.touchUpdatedAt(agent);
      this.emitState(agent);
    }

    return true;
  }

  getPendingPermissions(agentId: string): AgentPermissionRequest[] {
    const agent = this.requireAgent(agentId);
    return Array.from(agent.pendingPermissions.values());
  }

  private peekPendingPermission(agent: ManagedAgent): AgentPermissionRequest | null {
    const iterator = agent.pendingPermissions.values().next();
    return iterator.done ? null : iterator.value;
  }

  async hydrateTimelineFromProvider(agentId: string): Promise<void> {
    const agent = this.requireAgent(agentId);
    await this.hydrateTimeline(agent);
  }

  getLastAssistantMessage(agentId: string): string | null {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return null;
    }

    return this.timelineStore.getLastAssistantMessage(agentId);
  }

  private getLastAssistantMessageFromTimeline(
    timeline: readonly AgentTimelineItem[],
  ): string | null {
    // Collect the last contiguous assistant messages (Claude streams chunks)
    const chunks: string[] = [];
    for (let i = timeline.length - 1; i >= 0; i--) {
      const item = timeline[i];
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
    options?: WaitForAgentOptions,
  ): Promise<WaitForAgentResult> {
    const snapshot = this.getAgent(agentId);
    if (!snapshot) {
      throw new Error(`Agent ${agentId} not found`);
    }

    const hasForegroundTurn =
      Boolean(snapshot.activeForegroundTurnId) || this.hasPendingForegroundRun(agentId);

    const immediatePermission = this.peekPendingPermission(snapshot);
    if (immediatePermission) {
      return {
        status: snapshot.lifecycle,
        permission: immediatePermission,
        lastMessage: this.getLastAssistantMessage(agentId),
      };
    }

    const initialStatus = snapshot.lifecycle;
    const initialBusy = isAgentBusy(initialStatus) || hasForegroundTurn;
    const waitForActive = options?.waitForActive ?? false;
    if (!waitForActive && !initialBusy) {
      return {
        status: initialStatus,
        permission: null,
        lastMessage: this.getLastAssistantMessage(agentId),
      };
    }
    if (waitForActive && !initialBusy && !hasForegroundTurn) {
      return {
        status: initialStatus,
        permission: null,
        lastMessage: this.getLastAssistantMessage(agentId),
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
      let hasStarted = initialBusy || hasForegroundTurn;
      let terminalStatusOverride: AgentLifecycleStatus | null = null;

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
          lastMessage: this.getLastAssistantMessage(agentId),
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
              if (terminalStatusOverride) {
                currentStatus = terminalStatusOverride;
              }
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
              hasStarted = true;
              terminalStatusOverride = "error";
              return;
            }
            if (event.event.type === "turn_completed") {
              hasStarted = true;
            }
            if (event.event.type === "turn_canceled") {
              hasStarted = true;
            }
          }
        },
        { agentId, replayState: true },
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
      timeline?: AgentTimelineItem[];
      timelineRows?: AgentTimelineRow[];
      timelineNextSeq?: number;
      provisionalAssistantText?: string | null;
      historyPrimed?: boolean;
      lastUsage?: AgentUsage;
      lastError?: string;
      attention?: AttentionState;
    },
  ): Promise<ManagedAgent> {
    const resolvedAgentId = validateAgentId(agentId, "registerSession");
    if (this.agents.has(resolvedAgentId)) {
      throw new Error(`Agent with id ${resolvedAgentId} already exists`);
    }
    const initialPersistedTitle = await this.resolveInitialPersistedTitle(resolvedAgentId, config);

    const now = new Date();
    const timelineSeed: SeedAgentTimelineOptions | null =
      options?.timeline?.length ||
      options?.timelineRows?.length ||
      options?.timelineNextSeq !== undefined
        ? {
            items: options?.timeline,
            rows: options?.timelineRows,
            nextSeq: options?.timelineNextSeq,
            timestamp: (options?.updatedAt ?? options?.createdAt ?? now).toISOString(),
          }
        : null;
    if (timelineSeed || !this.timelineStore.has(resolvedAgentId)) {
      this.timelineStore.initialize(resolvedAgentId, timelineSeed ?? { timestamp: now.toISOString() });
    }

    const managed = {
      id: resolvedAgentId,
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
      pendingReplacement: false,
      activeForegroundTurnId: null,
      foregroundTurnWaiters: new Set(),
      unsubscribeSession: null,
      provisionalAssistantText: options?.provisionalAssistantText ?? null,
      persistence: attachPersistenceCwd(session.describePersistence(), config.cwd),
      historyPrimed: options?.historyPrimed ?? false,
      lastUserMessageAt: options?.lastUserMessageAt ?? null,
      lastUsage: options?.lastUsage,
      lastError: options?.lastError,
      attention:
        options?.attention != null
          ? options.attention.requiresAttention
            ? {
                requiresAttention: true,
                attentionReason: options.attention.attentionReason,
                attentionTimestamp: new Date(options.attention.attentionTimestamp),
              }
            : { requiresAttention: false }
          : { requiresAttention: false },
      internal: config.internal ?? false,
      labels: options?.labels ?? {},
    } as ActiveManagedAgent;

    this.agents.set(resolvedAgentId, managed);
    // Initialize previousStatus to track transitions
    this.previousStatuses.set(resolvedAgentId, managed.lifecycle);
    await this.refreshRuntimeInfo(managed);
    await this.persistSnapshot(managed, {
      title: initialPersistedTitle,
    });
    this.emitState(managed, { persist: false });

    await this.refreshSessionState(managed);
    managed.lifecycle = "idle";
    await this.persistSnapshot(managed);
    this.emitState(managed, { persist: false });
    this.subscribeToSession(managed);
    return { ...managed };
  }

  private subscribeToSession(agent: ActiveManagedAgent): void {
    if (agent.unsubscribeSession) {
      return;
    }
    const agentId = agent.id;
    const unsubscribe = agent.session.subscribe((event: AgentStreamEvent) => {
      const current = this.agents.get(agentId);
      if (!current) {
        return;
      }
      this.dispatchSessionEvent(current, event);
    });
    agent.unsubscribeSession = unsubscribe;
  }

  private dispatchSessionEvent(agent: ActiveManagedAgent, event: AgentStreamEvent): void {
    const turnId = (event as { turnId?: string }).turnId;
    const matchingWaiters =
      turnId == null
        ? []
        : Array.from(agent.foregroundTurnWaiters).filter(
            (waiter) => waiter.turnId === turnId && !waiter.settled,
          );

    this.handleStreamEvent(agent, event);

    for (const waiter of matchingWaiters) {
      waiter.callback(event);
      if (isTurnTerminalEvent(event)) {
        this.settleForegroundTurnWaiter(waiter);
      }
    }
  }

  private settleForegroundTurnWaiter(waiter: ForegroundTurnWaiter): void {
    if (waiter.settled) {
      return;
    }
    waiter.settled = true;
    waiter.resolveSettled();
  }

  private createPendingForegroundRun(): PendingForegroundRun {
    let resolveSettled!: () => void;
    const settledPromise = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    return {
      token: randomUUID(),
      started: false,
      settled: false,
      settledPromise,
      resolveSettled,
    };
  }

  private getPendingForegroundRun(agentId: string): PendingForegroundRun | null {
    return this.pendingForegroundRuns.get(agentId) ?? null;
  }

  private hasPendingForegroundRun(agentId: string): boolean {
    return this.pendingForegroundRuns.has(agentId);
  }

  private settlePendingForegroundRun(agentId: string, token?: string): void {
    const pendingRun = this.pendingForegroundRuns.get(agentId);
    if (!pendingRun) {
      return;
    }
    if (token && pendingRun.token !== token) {
      return;
    }

    this.pendingForegroundRuns.delete(agentId);
    if (pendingRun.settled) {
      return;
    }
    pendingRun.settled = true;
    pendingRun.resolveSettled();
  }

  private async resolveInitialPersistedTitle(
    agentId: string,
    config: AgentSessionConfig,
  ): Promise<string | null> {
    const existing = await this.registry?.get(agentId);
    if (existing) {
      return existing.title ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(config, "title")) {
      return config.title ?? null;
    }
    return null;
  }

  private async persistSnapshot(
    agent: ManagedAgent,
    options?: { title?: string | null; internal?: boolean },
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

  private requireRegistry(): AgentSnapshotStore {
    if (!this.registry) {
      throw new Error("Agent storage unavailable");
    }
    return this.registry;
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
      agent.pendingPermissions = new Map(pending.map((request) => [request.id, request]));
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
        newInfo.thinkingOptionId !== agent.runtimeInfo?.thinkingOptionId ||
        newInfo.sessionId !== agent.runtimeInfo?.sessionId ||
        newInfo.modeId !== agent.runtimeInfo?.modeId;
      agent.runtimeInfo = newInfo;
      if (!agent.persistence && newInfo.sessionId) {
        agent.persistence = attachPersistenceCwd(
          { provider: agent.provider, sessionId: newInfo.sessionId },
          agent.cwd,
        );
      }
      // Emit state if runtimeInfo changed so clients get the updated model
      if (changed) {
        this.emitState(agent);
      }
    } catch {
      // Keep existing runtimeInfo if refresh fails.
    }
  }

  private async hydrateTimeline(agent: ActiveManagedAgent): Promise<void> {
    if (agent.historyPrimed) {
      return;
    }
    agent.historyPrimed = true;
    const canonicalUserMessagesById = this.timelineStore.getCanonicalUserMessagesById(agent.id);
    const pendingTurnItems: AgentTimelineItem[] = [];
    let bufferedAssistantText = "";
    const flushPendingTurn = () => {
      for (const item of pendingTurnItems) {
        this.recordTimeline(agent.id, item);
      }
      pendingTurnItems.length = 0;
      if (bufferedAssistantText) {
        this.recordTimeline(agent.id, {
          type: "assistant_message",
          text: bufferedAssistantText,
        });
        bufferedAssistantText = "";
      }
    };
    try {
      for await (const event of agent.session.streamHistory()) {
        if (event.type !== "timeline") {
          if (
            event.type === "turn_completed" ||
            event.type === "turn_failed" ||
            event.type === "turn_canceled"
          ) {
            flushPendingTurn();
          }
          continue;
        }

        if (event.item.type === "user_message") {
          flushPendingTurn();
          const eventMessageId = normalizeMessageId(event.item.messageId);
          if (eventMessageId) {
            const canonicalText = canonicalUserMessagesById.get(eventMessageId);
            if (canonicalText === event.item.text) {
              continue;
            }
          }
          this.recordTimeline(agent.id, event.item);
          continue;
        }

        if (event.item.type === "assistant_message") {
          bufferedAssistantText += event.item.text;
          continue;
        }

        if (event.item.type === "reasoning") {
          continue;
        }

        if (event.item.type === "tool_call" && event.item.status === "running") {
          continue;
        }

        pendingTurnItems.push(event.item);
      }
      flushPendingTurn();
    } catch {
      // ignore history failures
    }
  }

  private handleStreamEvent(
    agent: ActiveManagedAgent,
    event: AgentStreamEvent,
    options?: {
      fromHistory?: boolean;
      canonicalUserMessagesById?: ReadonlyMap<string, string>;
    },
  ): void {
    const eventTurnId = (event as { turnId?: string }).turnId;
    const isForegroundEvent = Boolean(
      eventTurnId && agent.activeForegroundTurnId === eventTurnId,
    );

    // Only update timestamp for live events, not history replay
    if (!options?.fromHistory) {
      this.touchUpdatedAt(agent);
    }

    let timelineRow: AgentTimelineRow | null = null;

    switch (event.type) {
      case "thread_started":
        {
          const previousSessionId = agent.persistence?.sessionId ?? null;
          const handle = agent.session.describePersistence();
          if (handle) {
            agent.persistence = attachPersistenceCwd(handle, agent.cwd);
            if (agent.persistence?.sessionId !== previousSessionId) {
              this.emitState(agent);
            }
          }
          void this.refreshRuntimeInfo(agent);
        }
        break;
      case "timeline":
        // Skip provider-replayed user_message items during history hydration.
        if (options?.fromHistory && event.item.type === "user_message") {
          const eventMessageId = normalizeMessageId(event.item.messageId);
          if (eventMessageId) {
            const canonicalText = options?.canonicalUserMessagesById?.get(eventMessageId);
            if (canonicalText === event.item.text) {
              break;
            }
          }
        }
        // Suppress user_message echoes for the active foreground turn —
        // these are already recorded by recordUserMessage().
        if (
          !options?.fromHistory &&
          event.item.type === "user_message" &&
          isForegroundEvent
        ) {
          const eventMessageId = normalizeMessageId(event.item.messageId);
          const eventText = event.item.text;
          if (eventMessageId) {
            if (
              this.timelineStore.hasCommittedUserMessage(agent.id, {
                messageId: eventMessageId,
                text: eventText,
              })
            ) {
              break;
            }
          }
        }
        if (event.item.type === "assistant_message") {
          agent.provisionalAssistantText = `${agent.provisionalAssistantText ?? ""}${event.item.text}`;
          break;
        }
        if (event.item.type === "reasoning") {
          break;
        }
        if (event.item.type === "tool_call" && event.item.status === "running") {
          break;
        }
        timelineRow = this.recordTimeline(agent.id, event.item);
        if (!options?.fromHistory && event.item.type === "user_message") {
          agent.lastUserMessageAt = new Date();
          this.emitState(agent);
        }
        break;
      case "turn_completed":
        this.logger.trace(
          {
            agentId: agent.id,
            lifecycle: agent.lifecycle,
            activeForegroundTurnId: agent.activeForegroundTurnId,
            eventTurnId,
          },
          "handleStreamEvent: turn_completed",
        );
        if (agent.provisionalAssistantText) {
          const item: AgentTimelineItem = {
            type: "assistant_message",
            text: agent.provisionalAssistantText,
          };
          timelineRow = this.recordTimeline(agent.id, item);
          if (!options?.fromHistory) {
            this.dispatchStream(
              agent.id,
              {
                type: "timeline",
                item,
                provider: event.provider,
              },
              {
                seq: timelineRow.seq,
              },
            );
          }
          agent.provisionalAssistantText = null;
        }
        agent.lastUsage = event.usage;
        agent.lastError = undefined;
        // For autonomous turns (not foreground), transition to idle
        // unless a replacement is pending (avoid idle flash during replace)
        if (!isForegroundEvent && agent.lifecycle !== "idle" && !agent.pendingReplacement) {
          (agent as ActiveManagedAgent).lifecycle = "idle";
          this.emitState(agent);
        }
        void this.refreshRuntimeInfo(agent);
        break;
      case "turn_failed":
        this.logger.trace(
          {
            agentId: agent.id,
            lifecycle: agent.lifecycle,
            activeForegroundTurnId: agent.activeForegroundTurnId,
            eventTurnId,
            error: event.error,
            code: event.code,
            diagnostic: event.diagnostic,
          },
          "handleStreamEvent: turn_failed",
        );
        agent.provisionalAssistantText = null;
        // For autonomous turns, set error state directly
        if (!isForegroundEvent) {
          agent.lifecycle = "error";
        }
        agent.lastError = event.error;
        this.appendSystemErrorTimelineMessage(
          agent,
          event.provider,
          this.formatTurnFailedMessage(event),
          options,
        );
        for (const [requestId] of agent.pendingPermissions) {
          agent.pendingPermissions.delete(requestId);
          if (!options?.fromHistory) {
            this.dispatchStream(agent.id, {
              type: "permission_resolved",
              provider: event.provider,
              requestId,
              resolution: { behavior: "deny", message: "Turn failed" },
            });
          }
        }
        if (!isForegroundEvent) {
          this.emitState(agent);
        }
        break;
      case "turn_canceled":
        this.logger.trace(
          {
            agentId: agent.id,
            lifecycle: agent.lifecycle,
            activeForegroundTurnId: agent.activeForegroundTurnId,
            eventTurnId,
          },
          "handleStreamEvent: turn_canceled",
        );
        agent.provisionalAssistantText = null;
        // For autonomous turns, transition to idle
        // unless a replacement is pending (avoid idle flash during replace)
        if (!isForegroundEvent && !agent.pendingReplacement) {
          (agent as ActiveManagedAgent).lifecycle = "idle";
        }
        agent.lastError = undefined;
        for (const [requestId] of agent.pendingPermissions) {
          agent.pendingPermissions.delete(requestId);
          if (!options?.fromHistory) {
            this.dispatchStream(agent.id, {
              type: "permission_resolved",
              provider: event.provider,
              requestId,
              resolution: { behavior: "deny", message: "Interrupted" },
            });
          }
        }
        if (!isForegroundEvent) {
          this.emitState(agent);
        }
        break;
      case "turn_started":
        this.logger.trace(
          {
            agentId: agent.id,
            lifecycle: agent.lifecycle,
            activeForegroundTurnId: agent.activeForegroundTurnId,
            eventTurnId,
          },
          "handleStreamEvent: turn_started",
        );
        agent.provisionalAssistantText = null;
        // For autonomous turn_started (no foreground match), set running
        if (!isForegroundEvent) {
          (agent as ActiveManagedAgent).lifecycle = "running";
          this.emitState(agent);
        }
        break;
      case "permission_requested":
        {
          const hadPendingPermissions = agent.pendingPermissions.size > 0;
          agent.pendingPermissions.set(event.request.id, event.request);
          if (!hadPendingPermissions && !agent.internal) {
            this.broadcastAgentAttention(agent, "permission");
          }
        }
        this.emitState(agent);
        break;
      case "permission_resolved":
        agent.pendingPermissions.delete(event.requestId);
        this.emitState(agent);
        break;
      default:
        break;
    }

    if (!options?.fromHistory && isForegroundEvent && isTurnTerminalEvent(event)) {
      this.finalizeForegroundTurn(agent);
    }

    // Skip dispatching individual stream events during history replay.
    if (!options?.fromHistory) {
      this.dispatchStream(
        agent.id,
        event,
        timelineRow
          ? {
              seq: timelineRow.seq,
            }
          : undefined,
      );
    }
  }

  private appendSystemErrorTimelineMessage(
    agent: ActiveManagedAgent,
    provider: AgentProvider,
    message: string,
    options?: {
      fromHistory?: boolean;
      canonicalUserMessagesById?: ReadonlyMap<string, string>;
    },
  ): void {
    if (options?.fromHistory) {
      return;
    }

    const normalized = message.trim();
    if (!normalized) {
      return;
    }

    const text = `${SYSTEM_ERROR_PREFIX} ${normalized}`;
    const lastItem = this.timelineStore.getLastItem(agent.id);
    if (lastItem?.type === "assistant_message" && lastItem.text === text) {
      return;
    }

    const item: AgentTimelineItem = { type: "assistant_message", text };
    const row = this.recordTimeline(agent.id, item);
    this.dispatchStream(
      agent.id,
      {
        type: "timeline",
        item,
        provider,
      },
      {
        seq: row.seq,
      },
    );
  }

  private formatTurnFailedMessage(
    event: Extract<AgentStreamEvent, { type: "turn_failed" }>,
  ): string {
    const base = event.error.trim();
    const parts = [base.length > 0 ? base : "Provider run failed"];
    const code = event.code?.trim();
    if (code) {
      parts.push(`code: ${code}`);
    }
    const diagnostic = event.diagnostic?.trim();
    if (diagnostic && diagnostic !== base) {
      parts.push(diagnostic);
    }
    return parts.join("\n\n");
  }

  private recordTimeline(agentId: string, item: AgentTimelineItem): AgentTimelineRow {
    return this.timelineStore.append(agentId, item);
  }

  private emitState(agent: ManagedAgent, options?: { persist?: boolean }): void {
    // Keep attention as an edge-triggered unread signal, not a level signal.
    this.checkAndSetAttention(agent);
    if (options?.persist !== false) {
      this.enqueueBackgroundPersist(agent);
    }

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
      return;
    }

    // Check if agent entered error state
    if (previousStatus !== "error" && currentStatus === "error") {
      agent.attention = {
        requiresAttention: true,
        attentionReason: "error",
        attentionTimestamp: new Date(),
      };
      this.broadcastAgentAttention(agent, "error");
      return;
    }
  }

  private enqueueBackgroundPersist(agent: ManagedAgent): void {
    const task = this.persistSnapshot(agent).catch((err) => {
      this.logger.error({ err, agentId: agent.id }, "Failed to persist agent snapshot");
    });
    this.trackBackgroundTask(task);
  }

  private trackBackgroundTask(task: Promise<void>): void {
    this.backgroundTasks.add(task);
    void task.finally(() => {
      this.backgroundTasks.delete(task);
    });
  }

  /**
   * Flush any background persistence work (best-effort).
   * Used by daemon shutdown paths to avoid unhandled rejections after cleanup.
   */
  async flush(): Promise<void> {
    // Drain tasks, including tasks spawned while awaiting.
    while (this.backgroundTasks.size > 0) {
      const pending = Array.from(this.backgroundTasks);
      await Promise.allSettled(pending);
    }
  }

  private broadcastAgentAttention(
    agent: ManagedAgent,
    reason: "finished" | "error" | "permission",
  ): void {
    this.onAgentAttention?.({
      agentId: agent.id,
      provider: agent.provider,
      reason,
    });
  }

  private dispatchStream(
    agentId: string,
    event: AgentStreamEvent,
    metadata?: { seq?: number },
  ): void {
    this.dispatch({ type: "agent_stream", agentId, event, ...metadata });
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
  ): Promise<AgentSessionConfig> {
    const normalized: AgentSessionConfig = { ...config };

    // Always resolve cwd to absolute path for consistent history file lookup
    if (normalized.cwd) {
      normalized.cwd = resolve(normalized.cwd);
      try {
        const cwdStats = await stat(normalized.cwd);
        if (!cwdStats.isDirectory()) {
          throw new Error(`Working directory is not a directory: ${normalized.cwd}`);
        }
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          (error as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          throw new Error(`Working directory does not exist: ${normalized.cwd}`);
        }
        if (error instanceof Error) {
          throw error;
        }
        throw new Error(`Failed to access working directory: ${normalized.cwd}`);
      }
    }

    if (typeof normalized.model === "string") {
      const trimmed = normalized.model.trim();
      normalized.model = trimmed.length > 0 ? trimmed : undefined;
    }

    return normalized;
  }

  private buildLaunchContext(agentId: string): AgentLaunchContext {
    return {
      env: {
        PASEO_AGENT_ID: agentId,
      },
    };
  }

  private requireClient(provider: AgentProvider): AgentClient {
    const client = this.clients.get(provider);
    if (!client) {
      throw new Error(`No client registered for provider '${provider}'`);
    }
    return client;
  }

  private requireAgent(id: string): ActiveManagedAgent {
    const normalizedId = validateAgentId(id, "requireAgent");
    const agent = this.agents.get(normalizedId);
    if (!agent) {
      throw new Error(`Unknown agent '${normalizedId}'`);
    }
    return agent;
  }

}
