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
import { AGENT_PROVIDER_IDS } from "./provider-manifest.js";

export { AGENT_LIFECYCLE_STATUSES, type AgentLifecycleStatus };

export type AgentManagerEvent =
  | { type: "agent_state"; agent: ManagedAgent }
  | {
      type: "agent_stream";
      agentId: string;
      event: AgentStreamEvent;
      seq?: number;
      epoch?: string;
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
  maxTimelineItems?: number;
  idFactory?: () => string;
  registry?: AgentStorage;
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
  epoch: string;
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
  epoch: string;
  direction: AgentTimelineFetchDirection;
  reset: boolean;
  staleCursor: boolean;
  gap: boolean;
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
  timelineRows: AgentTimelineRow[];
  timelineEpoch: string;
  timelineNextSeq: number;
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

function attachPersistenceCwd(
  handle: AgentPersistenceHandle | null,
  cwd: string
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

const DEFAULT_MAX_TIMELINE_ITEMS = 2000;
const DEFAULT_TIMELINE_FETCH_LIMIT = 200;
const BUSY_STATUSES: AgentLifecycleStatus[] = [
  "initializing",
  "running",
];
const AgentIdSchema = z.string().uuid();

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

function validateAgentId(agentId: string, source: string): string {
  const result = AgentIdSchema.safeParse(agentId);
  if (!result.success) {
    throw new Error(`${source}: agentId must be a UUID`);
  }
  return result.data;
}

export class AgentManager {
  private readonly clients = new Map<AgentProvider, AgentClient>();
  private readonly agents = new Map<string, ActiveManagedAgent>();
  private readonly subscribers = new Set<SubscriptionRecord>();
  private readonly maxTimelineItems: number;
  private readonly idFactory: () => string;
  private readonly registry?: AgentStorage;
  private readonly previousStatuses = new Map<string, AgentLifecycleStatus>();
  private readonly backgroundTasks = new Set<Promise<void>>();
  private onAgentAttention?: AgentAttentionCallback;
  private logger: Logger;

  constructor(options: AgentManagerOptions) {
    this.maxTimelineItems =
      options?.maxTimelineItems ?? DEFAULT_MAX_TIMELINE_ITEMS;
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

  subscribe(callback: AgentSubscriber, options?: SubscribeOptions): () => void {
    const targetAgentId =
      options?.agentId == null
        ? null
        : validateAgentId(options.agentId, "subscribe");
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
        this.logger.warn(
          { err: error, provider },
          "Failed to check provider availability"
        );
        return {
          provider,
          available: false,
          error: message,
        } satisfies ProviderAvailability;
      }
    });

    return Promise.all(checks);
  }

  getAgent(id: string): ManagedAgent | null {
    const agent = this.agents.get(id);
    return agent ? { ...agent } : null;
  }

  getTimeline(id: string): AgentTimelineItem[] {
    const agent = this.requireAgent(id);
    return [...agent.timeline];
  }

  getTimelineRows(id: string): AgentTimelineRow[] {
    const agent = this.requireAgent(id);
    const { rows } = this.ensureTimelineState(agent);
    return rows.map((row) => ({ ...row }));
  }

  fetchTimeline(
    id: string,
    options?: AgentTimelineFetchOptions
  ): AgentTimelineFetchResult {
    const agent = this.requireAgent(id);
    const {
      rows,
      epoch,
      nextSeq,
      minSeq,
      maxSeq,
    } = this.ensureTimelineState(agent);
    const direction = options?.direction ?? "tail";
    const requestedLimit = options?.limit;
    const limit =
      requestedLimit === undefined
        ? DEFAULT_TIMELINE_FETCH_LIMIT
        : Math.max(0, Math.floor(requestedLimit));
    const cursor = options?.cursor;

    const window: AgentTimelineWindow = { minSeq, maxSeq, nextSeq };

    if (cursor && cursor.epoch !== epoch) {
      return {
        epoch,
        direction,
        reset: true,
        staleCursor: true,
        gap: false,
        window,
        hasOlder: false,
        hasNewer: false,
        rows: rows.map((row) => ({ ...row })),
      };
    }

    const selectAll = limit === 0;
    const cloneRows = (items: AgentTimelineRow[]) => items.map((row) => ({ ...row }));

    if (direction === "after" && cursor && rows.length > 0 && cursor.seq < minSeq - 1) {
      return {
        epoch,
        direction,
        reset: true,
        staleCursor: false,
        gap: true,
        window,
        hasOlder: false,
        hasNewer: false,
        rows: cloneRows(rows),
      };
    }

    if (rows.length === 0) {
      return {
        epoch,
        direction,
        reset: false,
        staleCursor: false,
        gap: false,
        window,
        hasOlder: false,
        hasNewer: false,
        rows: [],
      };
    }

    if (direction === "tail") {
      const selected =
        selectAll || limit >= rows.length ? rows : rows.slice(rows.length - limit);
      const hasOlder = selected.length > 0 && selected[0]!.seq > minSeq;
      return {
        epoch,
        direction,
        reset: false,
        staleCursor: false,
        gap: false,
        window,
        hasOlder,
        hasNewer: false,
        rows: cloneRows(selected),
      };
    }

    if (direction === "after") {
      const baseSeq = cursor?.seq ?? 0;
      const startIdx = rows.findIndex((row) => row.seq > baseSeq);
      if (startIdx < 0) {
        return {
          epoch,
          direction,
          reset: false,
          staleCursor: false,
          gap: false,
          window,
          hasOlder: baseSeq >= minSeq,
          hasNewer: false,
          rows: [],
        };
      }

      const selected =
        selectAll ? rows.slice(startIdx) : rows.slice(startIdx, startIdx + limit);
      const lastSelected = selected[selected.length - 1];
      return {
        epoch,
        direction,
        reset: false,
        staleCursor: false,
        gap: false,
        window,
        hasOlder: selected[0]!.seq > minSeq,
        hasNewer: Boolean(lastSelected && lastSelected.seq < maxSeq),
        rows: cloneRows(selected),
      };
    }

    // direction === "before"
    const beforeSeq = cursor?.seq ?? nextSeq;
    const endExclusive = rows.findIndex((row) => row.seq >= beforeSeq);
    const boundedRows =
      endExclusive < 0 ? rows : rows.slice(0, endExclusive);
    const selected =
      selectAll || limit >= boundedRows.length
        ? boundedRows
        : boundedRows.slice(boundedRows.length - limit);
    const hasOlder = selected.length > 0 && selected[0]!.seq > minSeq;
    const hasNewer = endExclusive >= 0;
    return {
      epoch,
      direction,
      reset: false,
      staleCursor: false,
      gap: false,
      window,
      hasOlder,
      hasNewer,
      rows: cloneRows(selected),
    };
  }

  async createAgent(
    config: AgentSessionConfig,
    agentId?: string,
    options?: { labels?: Record<string, string> }
  ): Promise<ManagedAgent> {
    // Generate agent ID early so we can use it in MCP config
    const resolvedAgentId = validateAgentId(
      agentId ?? this.idFactory(),
      "createAgent"
    );
    const normalizedConfig = await this.normalizeConfig(config, {
      labels: options?.labels,
      agentId: resolvedAgentId,
    });
    const client = this.requireClient(normalizedConfig.provider);
    const available = await client.isAvailable();
    if (!available) {
      throw new Error(`Provider '${normalizedConfig.provider}' is not available. Please ensure the CLI is installed.`);
    }
    const session = await client.createSession(normalizedConfig);
    return this.registerSession(
      session,
      normalizedConfig,
      resolvedAgentId,
      { labels: options?.labels }
    );
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
    }
  ): Promise<ManagedAgent> {
    const resolvedAgentId = validateAgentId(
      agentId ?? this.idFactory(),
      "resumeAgentFromPersistence"
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
    const client = this.requireClient(handle.provider);
    const session = await client.resumeSession(handle, resumeOverrides);
    return this.registerSession(
      session,
      normalizedConfig,
      resolvedAgentId,
      options
    );
  }

  // Hot-reload an active agent session with config overrides while preserving
  // in-memory timeline state.
  async reloadAgentSession(
    agentId: string,
    overrides?: Partial<AgentSessionConfig>
  ): Promise<ManagedAgent> {
    let existing = this.requireAgent(agentId);
    if (existing.lifecycle === "running" || existing.pendingRun) {
      await this.cancelAgentRun(agentId);
      existing = this.requireAgent(agentId);
    }
    const timelineState = this.ensureTimelineState(existing);
    const preservedTimeline = [...existing.timeline];
    const preservedTimelineRows = timelineState.rows.map((row) => ({ ...row }));
    const preservedTimelineEpoch = timelineState.epoch;
    const preservedTimelineNextSeq = timelineState.nextSeq;
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

    const session = handle
      ? await client.resumeSession(handle, normalizedConfig)
      : await client.createSession(normalizedConfig);

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

    // Preserve existing labels and timeline during reload.
    return this.registerSession(session, normalizedConfig, agentId, {
      labels: existing.labels,
      createdAt: existing.createdAt,
      updatedAt: existing.updatedAt,
      lastUserMessageAt: existing.lastUserMessageAt,
      timeline: preservedTimeline,
      timelineRows: preservedTimelineRows,
      timelineEpoch: preservedTimelineEpoch,
      timelineNextSeq: preservedTimelineNextSeq,
      historyPrimed: preservedHistoryPrimed,
      lastUsage: preservedLastUsage,
      lastError: preservedLastError,
      attention: preservedAttention,
    });
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
    this.emitState(agent);
  }

  async setAgentThinkingOption(
    agentId: string,
    thinkingOptionId: string | null
  ): Promise<void> {
    const agent = this.requireAgent(agentId);
    const normalizedThinkingOptionId =
      typeof thinkingOptionId === "string" && thinkingOptionId.trim().length > 0
        ? thinkingOptionId
        : null;

    if (agent.session.setThinkingOption) {
      await agent.session.setThinkingOption(normalizedThinkingOptionId);
    }

    agent.config.thinkingOptionId = normalizedThinkingOptionId ?? undefined;
    this.emitState(agent);
  }

  async setTitle(agentId: string, title: string): Promise<void> {
    const agent = this.requireAgent(agentId);
    await this.registry?.setTitle(agentId, title);
    this.emitState(agent);
  }

  async setLabels(
    agentId: string,
    labels: Record<string, string>
  ): Promise<void> {
    const agent = this.requireAgent(agentId);
    agent.labels = { ...agent.labels, ...labels };
    await this.persistSnapshot(agent);
    this.emitState(agent);
  }

  notifyAgentState(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent || agent.internal) {
      return;
    }
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
      } else if (event.type === "turn_completed") {
        usage = event.usage;
      } else if (event.type === "turn_failed") {
        throw new Error(event.error);
      } else if (event.type === "turn_canceled") {
        canceled = true;
      }
    }

    finalText = this.getLastAssistantMessageFromTimeline(timeline) ?? "";

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
    options?: { messageId?: string; emitState?: boolean }
  ): void {
    const agent = this.requireAgent(agentId);
    const item: AgentTimelineItem = {
      type: "user_message",
      text,
      messageId: options?.messageId,
    };
    const updatedAt = this.touchUpdatedAt(agent);
    agent.lastUserMessageAt = updatedAt;
    const row = this.recordTimeline(agent, item);
    this.dispatchStream(agentId, {
      type: "timeline",
      item,
      provider: agent.provider,
    }, {
      seq: row.seq,
      epoch: this.ensureTimelineState(agent).epoch,
    });
    if (options?.emitState !== false) {
      this.emitState(agent);
    }
  }

  async appendTimelineItem(agentId: string, item: AgentTimelineItem): Promise<void> {
    const agent = this.requireAgent(agentId);
    this.touchUpdatedAt(agent);
    const row = this.recordTimeline(agent, item);
    this.dispatchStream(agentId, {
      type: "timeline",
      item,
      provider: agent.provider,
    }, {
      seq: row.seq,
      epoch: this.ensureTimelineState(agent).epoch,
    });
    await this.persistSnapshot(agent);
  }

  async emitLiveTimelineItem(
    agentId: string,
    item: AgentTimelineItem
  ): Promise<void> {
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
    options?: AgentRunOptions
  ): AsyncGenerator<AgentStreamEvent> {
    const existingAgent = this.requireAgent(agentId);
    if (existingAgent.pendingRun) {
      throw new Error(`Agent ${agentId} already has an active run`);
    }

    const agent = existingAgent as ActiveManagedAgent;
    const iterator = agent.session.stream(prompt, options);
    agent.lastError = undefined;

    let finalized = false;
    const finalize = (error?: string) => {
      if (finalized) {
        return;
      }
      finalized = true;

      if (agent.pendingRun !== streamForwarder) {
        if (error) {
          agent.lastError = error;
        }
        return;
      }

      const mutableAgent = agent as ActiveManagedAgent;
      mutableAgent.pendingRun = null;
      mutableAgent.lifecycle = error ? "error" : "idle";
      mutableAgent.lastError = error;
      const persistenceHandle =
        mutableAgent.session.describePersistence() ??
        (mutableAgent.runtimeInfo?.sessionId
          ? { provider: mutableAgent.provider, sessionId: mutableAgent.runtimeInfo.sessionId }
          : null);
      if (persistenceHandle) {
        mutableAgent.persistence = attachPersistenceCwd(
          persistenceHandle,
          mutableAgent.cwd
        );
      }
      this.emitState(mutableAgent);
    };

    const self = this;

    const streamForwarder = (async function* streamForwarder() {
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

    agent.pendingRun = streamForwarder;
    agent.lifecycle = "running";
    // Bump updatedAt when lifecycle changes so downstream consumers can
    // deterministically order idle->running transitions.
    this.touchUpdatedAt(agent);
    self.emitState(agent);

    return streamForwarder;
  }

  async waitForAgentRunStart(agentId: string, options?: WaitForAgentStartOptions): Promise<void> {
    const snapshot = this.getAgent(agentId);
    if (!snapshot) {
      throw new Error(`Agent ${agentId} not found`);
    }

    if (snapshot.lifecycle === "running") {
      return;
    }

    if (!("pendingRun" in snapshot) || !snapshot.pendingRun) {
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
        abortHandler = () => finishErr(createAbortError(options.signal!, "wait_for_agent_start aborted"));
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }

      unsubscribe = this.subscribe(
        (event) => {
          if (event.type === "agent_state") {
            if (event.agent.id !== agentId) {
              return;
            }
            if (event.agent.lifecycle === "running") {
              finishOk();
              return;
            }
            if (event.agent.lifecycle === "error") {
              finishErr(new Error(event.agent.lastError ?? `Agent ${agentId} failed to start`));
              return;
            }
            if ("pendingRun" in event.agent && !event.agent.pendingRun) {
              finishErr(new Error(`Agent ${agentId} run finished before starting`));
              return;
            }
            return;
          }
        },
        { agentId, replayState: true }
      );
    });
  }

  async respondToPermission(
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse
  ): Promise<void> {
    const agent = this.requireAgent(agentId);
    await agent.session.respondToPermission(requestId, response);
    agent.pendingPermissions.delete(requestId);

    // Update currentModeId - the session may have changed mode internally
    // (e.g., plan approval changes mode from "plan" to "acceptEdits")
    try {
      agent.currentModeId = await agent.session.getCurrentMode();
    } catch {
      // Ignore errors from getCurrentMode - mode tracking is best effort
    }

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
    } catch (error) {
      this.logger.error(
        { err: error, agentId },
        "Failed to cancel run"
      );
      throw error;
    }

    // Clear any pending permissions that weren't cleaned up by handleStreamEvent.
    // Due to microtask ordering, .return() may force the generator to its finally
    // block before it consumes the turn_canceled event, skipping our cleanup code.
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

  private getLastAssistantMessage(agentId: string): string | null {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return null;
    }

    return this.getLastAssistantMessageFromTimeline(agent.timeline);
  }

  private getLastAssistantMessageFromTimeline(
    timeline: readonly AgentTimelineItem[]
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
    options?: WaitForAgentOptions
  ): Promise<WaitForAgentResult> {
    const snapshot = this.getAgent(agentId);
    if (!snapshot) {
      throw new Error(`Agent ${agentId} not found`);
    }

    const hasPendingRun =
      "pendingRun" in snapshot && Boolean(snapshot.pendingRun);

    const immediatePermission = this.peekPendingPermission(snapshot);
    if (immediatePermission) {
      return {
        status: snapshot.lifecycle,
        permission: immediatePermission,
        lastMessage: this.getLastAssistantMessage(agentId)
      };
    }

    const initialStatus = snapshot.lifecycle;
    const initialBusy = isAgentBusy(initialStatus) || hasPendingRun;
    const waitForActive = options?.waitForActive ?? false;
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
      timeline?: AgentTimelineItem[];
      timelineRows?: AgentTimelineRow[];
      timelineEpoch?: string;
      timelineNextSeq?: number;
      historyPrimed?: boolean;
      lastUsage?: AgentUsage;
      lastError?: string;
      attention?: AttentionState;
    }
  ): Promise<ManagedAgent> {
    const resolvedAgentId = validateAgentId(agentId, "registerSession");
    if (this.agents.has(resolvedAgentId)) {
      throw new Error(`Agent with id ${resolvedAgentId} already exists`);
    }

    const now = new Date();
    const initialTimeline = options?.timeline ? [...options.timeline] : [];
    const initialTimelineRows =
      options?.timelineRows?.length
        ? options.timelineRows.map((row) => ({ ...row }))
        : this.buildTimelineRowsFromItems(
            initialTimeline,
            options?.timelineNextSeq ?? 1,
            (options?.updatedAt ?? options?.createdAt ?? now).toISOString()
          );
    const derivedNextSeq =
      options?.timelineNextSeq ??
      (initialTimelineRows.length
        ? initialTimelineRows[initialTimelineRows.length - 1]!.seq + 1
        : 1);

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
      pendingRun: null,
      timeline: initialTimeline,
      timelineRows: initialTimelineRows,
      timelineEpoch: options?.timelineEpoch ?? randomUUID(),
      timelineNextSeq: derivedNextSeq,
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
      title: config.title ?? null,
    });
    this.emitState(managed);

    await this.refreshSessionState(managed);
    managed.lifecycle = "idle";
    await this.persistSnapshot(managed);
    this.emitState(managed);
    return { ...managed };
  }

  private buildTimelineRowsFromItems(
    items: readonly AgentTimelineItem[],
    startSeq: number,
    timestamp: string
  ): AgentTimelineRow[] {
    let nextSeq = startSeq;
    return items.map((item) => {
      const row: AgentTimelineRow = {
        seq: nextSeq,
        timestamp,
        item,
      };
      nextSeq += 1;
      return row;
    });
  }

  private ensureTimelineState(agent: ManagedAgent): {
    rows: AgentTimelineRow[];
    epoch: string;
    nextSeq: number;
    minSeq: number;
    maxSeq: number;
  } {
    const minSeq = agent.timelineRows.length ? agent.timelineRows[0]!.seq : 0;
    const maxSeq = agent.timelineRows.length
      ? agent.timelineRows[agent.timelineRows.length - 1]!.seq
      : 0;

    return {
      rows: agent.timelineRows,
      epoch: agent.timelineEpoch,
      nextSeq: agent.timelineNextSeq,
      minSeq,
      maxSeq,
    };
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
      if (!agent.persistence && newInfo.sessionId) {
        agent.persistence = attachPersistenceCwd(
          { provider: agent.provider, sessionId: newInfo.sessionId },
          agent.cwd
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
      this.touchUpdatedAt(agent);
    }

    let timelineRow: AgentTimelineRow | null = null;

    switch (event.type) {
      case "thread_started":
        // Update persistence with the new session ID from the provider.
        // persistence.sessionId is the single source of truth for session identity.
        {
          const previousSessionId = agent.persistence?.sessionId ?? null;
          const handle = agent.session.describePersistence();
          if (handle) {
            agent.persistence = attachPersistenceCwd(handle, agent.cwd);
            if (agent.persistence?.sessionId !== previousSessionId) {
              this.emitState(agent);
            }
          }
        }
        break;
      case "timeline":
        timelineRow = this.recordTimeline(agent, event.item);
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
        this.emitState(agent);
        break;
      case "turn_canceled":
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
        this.emitState(agent);
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
    if (!options?.fromHistory) {
      this.dispatchStream(agent.id, event, timelineRow
        ? {
            seq: timelineRow.seq,
            epoch: this.ensureTimelineState(agent).epoch,
          }
        : undefined);
    }
  }

  private recordTimeline(
    agent: ManagedAgent,
    item: AgentTimelineItem
  ): AgentTimelineRow {
    const timelineState = this.ensureTimelineState(agent);
    const row: AgentTimelineRow = {
      seq: timelineState.nextSeq,
      timestamp: new Date().toISOString(),
      item,
    };
    agent.timelineNextSeq = timelineState.nextSeq + 1;
    agent.timeline.push(item);
    timelineState.rows.push(row);
    if (agent.timeline.length > this.maxTimelineItems) {
      const removeCount = agent.timeline.length - this.maxTimelineItems;
      agent.timeline.splice(0, removeCount);
      timelineState.rows.splice(0, removeCount);
    }
    return row;
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
      this.enqueueBackgroundPersist(agent);
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
      this.enqueueBackgroundPersist(agent);
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
      this.enqueueBackgroundPersist(agent);
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
    reason: "finished" | "error" | "permission"
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
    metadata?: { seq?: number; epoch?: string }
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
    _options?: { labels?: Record<string, string>; agentId?: string }
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
        if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
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
      const normalizedId = trimmed.toLowerCase();
      normalized.model =
        trimmed.length > 0 && normalizedId !== "default" ? trimmed : undefined;
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
    const normalizedId = validateAgentId(id, "requireAgent");
    const agent = this.agents.get(normalizedId);
    if (!agent) {
      throw new Error(`Unknown agent '${normalizedId}'`);
    }
    return agent;
  }
}
