import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import {
  AGENT_LIFECYCLE_STATUSES,
  type AgentLifecycleStatus,
} from "../../shared/agent-lifecycle.js";
import type { Logger } from "pino";
import { z } from "zod";
import type { TerminalManager } from "../../terminal/terminal-manager.js";

import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentFeature,
  AgentLaunchContext,
  AgentSlashCommand,
  AgentMode,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPermissionResult,
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
import type { StoredAgentRecord, AgentStorage } from "./agent-storage.js";
import {
  InMemoryAgentTimelineStore,
  type SeedAgentTimelineOptions,
} from "./agent-timeline-store.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
  AgentTimelineStore,
} from "./agent-timeline-store-types.js";
import {
  AGENT_STREAM_COALESCE_DEFAULT_WINDOW_MS,
  AgentStreamCoalescer,
} from "./agent-stream-coalescer.js";
import { ForegroundRunState, type ForegroundTurnWaiter } from "./foreground-run-state.js";
import { getAgentProviderDefinition } from "./provider-manifest.js";

const RELOAD_SESSION_CLOSE_TIMEOUT_MS = 3_000;
const INTERRUPT_SESSION_TIMEOUT_MS = 2_000;

type TimeoutResult = "completed" | "timed_out";

interface TimeoutOptions {
  operation: Promise<void>;
  timeoutMs: number;
  onLateError?: (error: unknown) => void;
}

function formatProviderList(providers: readonly string[]): string {
  return providers.length > 0 ? providers.join(", ") : "none";
}

export { AGENT_LIFECYCLE_STATUSES, type AgentLifecycleStatus };
export type {
  AgentTimelineCursor,
  AgentTimelineFetchDirection,
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
  AgentTimelineWindow,
} from "./agent-timeline-store-types.js";

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

export interface SubscribeOptions {
  agentId?: string;
  replayState?: boolean;
}

export type PersistedAgentQueryOptions = ListPersistedAgentsOptions & {
  provider?: AgentProvider;
};

export type AgentAttentionCallback = (params: {
  agentId: string;
  provider: AgentProvider;
  reason: "finished" | "error" | "permission";
}) => void;

export interface ProviderAvailability {
  provider: AgentProvider;
  available: boolean;
  error: string | null;
}

interface AgentManagerRescueTimeouts {
  reloadSessionCloseMs?: number;
  interruptSessionMs?: number;
}

interface ProviderEnabledFlag {
  enabled: boolean;
}
type ProviderEnabledMap = Partial<Record<AgentProvider, ProviderEnabledFlag>>;
type ProviderClientMap = Partial<Record<AgentProvider, AgentClient>>;

export interface AgentManagerOptions {
  clients?: ProviderClientMap;
  providerDefinitions?: ProviderEnabledMap;
  idFactory?: () => string;
  registry?: AgentStorage;
  onAgentAttention?: AgentAttentionCallback;
  durableTimelineStore?: AgentTimelineStore;
  terminalManager?: TerminalManager | null;
  mcpBaseUrl?: string;
  agentStreamCoalesceWindowMs?: number;
  rescueTimeouts?: AgentManagerRescueTimeouts;
  logger: Logger;
}

export interface WaitForAgentOptions {
  signal?: AbortSignal;
  waitForActive?: boolean;
}

export interface WaitForAgentResult {
  status: AgentLifecycleStatus;
  permission: AgentPermissionRequest | null;
  lastMessage: string | null;
}

export interface WaitForAgentStartOptions {
  signal?: AbortSignal;
}

type AttentionState =
  | { requiresAttention: false }
  | {
      requiresAttention: true;
      attentionReason: "finished" | "error" | "permission";
      attentionTimestamp: Date;
    };

function resolveInitialAttention(input: AttentionState | undefined): AttentionState {
  if (input == null || !input.requiresAttention) {
    return { requiresAttention: false };
  }
  return {
    requiresAttention: true,
    attentionReason: input.attentionReason,
    attentionTimestamp: new Date(input.attentionTimestamp),
  };
}

interface StreamEventFlags {
  shouldDispatchEvent: boolean;
  shouldNotifyWaiters: boolean;
}

interface HandleStreamEventOptions {
  fromHistory?: boolean;
  canonicalUserMessagesById?: ReadonlyMap<string, string>;
}

interface ManagedAgentBase {
  id: string;
  provider: AgentProvider;
  cwd: string;
  capabilities: AgentCapabilityFlags;
  config: AgentSessionConfig;
  runtimeInfo?: AgentRuntimeInfo;
  createdAt: Date;
  updatedAt: Date;
  availableModes: AgentMode[];
  features?: AgentFeature[];
  currentModeId: string | null;
  pendingPermissions: Map<string, AgentPermissionRequest>;
  bufferedPermissionResolutions: Map<
    string,
    Extract<AgentStreamEvent, { type: "permission_resolved" }>
  >;
  inFlightPermissionResponses: Set<string>;
  pendingReplacement: boolean;
  persistence: AgentPersistenceHandle | null;
  historyPrimed: boolean;
  lastUserMessageAt: Date | null;
  lastUsage?: AgentUsage;
  lastError?: string;
  attention: AttentionState;
  foregroundTurnWaiters: Set<ForegroundTurnWaiter>;
  finalizedForegroundTurnIds: Set<string>;
  unsubscribeSession: (() => void) | null;
  /**
   * Internal agents are hidden from listings and don't trigger notifications.
   */
  internal?: boolean;
  /**
   * User-defined labels for categorizing agents (e.g., { surface: "workspace" }).
   */
  labels: Record<string, string>;
}

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

export interface AgentMetricsSnapshot {
  total: number;
  byLifecycle: Record<string, number>;
  withActiveForegroundTurn: number;
  timelineStats: {
    totalItems: number;
    maxItemsPerAgent: number;
  };
}

type ActiveManagedAgent =
  | ManagedAgentInitializing
  | ManagedAgentIdle
  | ManagedAgentRunning
  | ManagedAgentError;

type LiveManagedAgent = ActiveManagedAgent;

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
      ...handle.metadata,
      cwd,
    },
  };
}

interface SubscriptionRecord {
  callback: AgentSubscriber;
  agentId: string | null;
}

const BUSY_STATUSES: Set<AgentLifecycleStatus> = new Set(["initializing", "running"]);
const AgentIdSchema = z.string().uuid();

function isAgentBusy(status: AgentLifecycleStatus): boolean {
  return BUSY_STATUSES.has(status);
}

function isTurnTerminalEvent(event: AgentStreamEvent): boolean {
  return (
    event.type === "turn_completed" ||
    event.type === "turn_failed" ||
    event.type === "turn_canceled"
  );
}

function abortMessage(reason: unknown, fallbackMessage: string): string {
  if (typeof reason === "string") return reason;
  if (reason instanceof Error) return reason.message;
  return fallbackMessage;
}

function createAbortError(signal: AbortSignal | undefined, fallbackMessage: string): Error {
  const message = abortMessage(signal?.reason, fallbackMessage);
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

function isDuplicateLegacyUserMessage(
  item: AgentTimelineItem,
  canonicalUserMessagesById: Map<string, string>,
): boolean {
  if (item.type !== "user_message") {
    return false;
  }
  const eventMessageId = normalizeMessageId(item.messageId);
  if (!eventMessageId) {
    return false;
  }
  return canonicalUserMessagesById.get(eventMessageId) === item.text;
}

function buildExplicitTimelineSeedForRegister(
  now: Date,
  options:
    | {
        timeline?: AgentTimelineItem[];
        timelineRows?: AgentTimelineRow[];
        timelineNextSeq?: number;
        createdAt?: Date;
        updatedAt?: Date;
      }
    | undefined,
): SeedAgentTimelineOptions | null {
  const hasTimeline = Boolean(options?.timeline?.length);
  const hasTimelineRows = Boolean(options?.timelineRows?.length);
  const hasTimelineNextSeq = options?.timelineNextSeq !== undefined;
  if (!hasTimeline && !hasTimelineRows && !hasTimelineNextSeq) {
    return null;
  }
  return {
    items: options?.timeline,
    rows: options?.timelineRows,
    nextSeq: options?.timelineNextSeq,
    timestamp: (options?.updatedAt ?? options?.createdAt ?? now).toISOString(),
  };
}

export class AgentManager {
  private readonly clients = new Map<AgentProvider, AgentClient>();
  private readonly providerEnabled = new Map<AgentProvider, boolean>();
  private readonly agents = new Map<string, LiveManagedAgent>();
  private readonly timelineStore = new InMemoryAgentTimelineStore();
  private readonly agentsAwaitingInitialSnapshotPersist = new Set<string>();
  private readonly sessionEventTails = new Map<string, Promise<void>>();
  private readonly foregroundRuns = new ForegroundRunState();
  private readonly subscribers = new Set<SubscriptionRecord>();
  private readonly idFactory: () => string;
  private readonly registry?: AgentStorage;
  private readonly durableTimelineStore?: AgentTimelineStore;
  private readonly previousStatuses = new Map<string, AgentLifecycleStatus>();
  private readonly backgroundTasks = new Set<Promise<void>>();
  private readonly agentStreamCoalescer: AgentStreamCoalescer;
  private mcpBaseUrl: string | null;
  private onAgentAttention?: AgentAttentionCallback;
  private logger: Logger;
  private readonly rescueTimeouts: Required<AgentManagerRescueTimeouts>;

  constructor(options: AgentManagerOptions) {
    this.idFactory = options?.idFactory ?? (() => randomUUID());
    this.registry = options?.registry;
    this.durableTimelineStore = options?.durableTimelineStore;
    this.onAgentAttention = options?.onAgentAttention;
    this.mcpBaseUrl = options?.mcpBaseUrl ?? null;
    this.logger = options.logger.child({ module: "agent", component: "agent-manager" });
    this.rescueTimeouts = {
      reloadSessionCloseMs:
        options.rescueTimeouts?.reloadSessionCloseMs ?? RELOAD_SESSION_CLOSE_TIMEOUT_MS,
      interruptSessionMs:
        options.rescueTimeouts?.interruptSessionMs ?? INTERRUPT_SESSION_TIMEOUT_MS,
    };
    this.agentStreamCoalescer = new AgentStreamCoalescer({
      windowMs: options.agentStreamCoalesceWindowMs ?? AGENT_STREAM_COALESCE_DEFAULT_WINDOW_MS,
      timers: { setTimeout, clearTimeout },
      onFlush: ({ agentId, item, provider, turnId }) => {
        const event = this.recordAndDispatchTimelineItem(agentId, item, provider, turnId);
        this.notifyForegroundTurnWaiters(agentId, event);
      },
    });
    this.updateProviderRegistry({
      providerDefinitions: options.providerDefinitions ?? {},
      clients: options.clients ?? {},
    });
  }

  registerClient(provider: AgentProvider, client: AgentClient): void {
    this.clients.set(provider, client);
  }

  updateProviderRegistry(input: {
    providerDefinitions: ProviderEnabledMap;
    clients: ProviderClientMap;
  }): void {
    for (const [provider, definition] of Object.entries(input.providerDefinitions)) {
      if (definition) {
        this.providerEnabled.set(provider, definition.enabled);
      }
    }
    for (const [provider, client] of Object.entries(input.clients)) {
      if (client) {
        this.clients.set(provider, client);
      }
    }
  }

  getRegisteredProviderIds(): AgentProvider[] {
    return Array.from(this.clients.keys());
  }

  setAgentAttentionCallback(callback: AgentAttentionCallback): void {
    this.onAgentAttention = callback;
  }

  setMcpBaseUrl(url: string | null): void {
    this.mcpBaseUrl = url;
  }

  public getMetricsSnapshot(): AgentMetricsSnapshot {
    const byLifecycle: Record<string, number> = {};
    let withActiveForegroundTurn = 0;
    let totalItems = 0;
    let maxItemsPerAgent = 0;

    for (const agent of this.agents.values()) {
      byLifecycle[agent.lifecycle] = (byLifecycle[agent.lifecycle] ?? 0) + 1;

      if (agent.activeForegroundTurnId !== null) {
        withActiveForegroundTurn++;
      }

      if (!this.timelineStore.has(agent.id)) {
        continue;
      }

      const len = this.timelineStore.getItems(agent.id).length;
      totalItems += len;
      if (len > maxItemsPerAgent) {
        maxItemsPerAgent = len;
      }
    }

    return {
      total: this.agents.size,
      byLifecycle,
      withActiveForegroundTurn,
      timelineStats: {
        totalItems,
        maxItemsPerAgent,
      },
    };
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
      this.foregroundRuns.hasPendingRun(agentId)
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
      .map((agent) => Object.assign({}, agent));
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

    const providerEntries = Array.from(this.clients.entries()).filter(
      ([, client]) => !!client.listPersistedAgents,
    );
    const descriptorLists = await Promise.all(
      providerEntries.map(async ([provider, client]) => {
        try {
          return await client.listPersistedAgents!({ limit: options?.limit });
        } catch (error) {
          this.logger.warn(
            { err: error, provider },
            "Failed to list persisted agents for provider",
          );
          return [];
        }
      }),
    );
    const descriptors: PersistedAgentDescriptor[] = descriptorLists.flat();

    const limit = options?.limit ?? 20;
    return descriptors
      .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime())
      .slice(0, limit);
  }

  async findPersistedAgent(
    provider: AgentProvider,
    sessionId: string,
  ): Promise<PersistedAgentDescriptor | null> {
    const client = this.requireClient(provider);
    if (!client.listPersistedAgents) {
      return null;
    }

    const descriptors = await client.listPersistedAgents({ limit: 200 });
    return (
      descriptors.find((descriptor) => {
        return (
          descriptor.sessionId === sessionId || descriptor.persistence.nativeHandle === sessionId
        );
      }) ?? null
    );
  }

  async listProviderAvailability(): Promise<ProviderAvailability[]> {
    const checks = Array.from(this.clients.keys()).map(async (provider) => {
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

  async listDraftFeatures(config: AgentSessionConfig): Promise<AgentFeature[]> {
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
      return session.features ?? [];
    } finally {
      try {
        await session.close();
      } catch (error) {
        this.logger.warn(
          { err: error, provider: normalizedConfig.provider },
          "Failed to close draft feature listing session",
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

  async getTimelineRows(id: string): Promise<AgentTimelineRow[]> {
    this.requireAgent(id);
    if (this.durableTimelineStore) {
      return await this.durableTimelineStore.getCommittedRows(id);
    }
    return this.timelineStore.getRows(id);
  }

  fetchTimeline(id: string, options?: AgentTimelineFetchOptions): AgentTimelineFetchResult {
    this.requireAgent(id);
    return this.timelineStore.fetch(id, options);
  }

  async createAgent(
    config: AgentSessionConfig,
    agentId?: string,
    options?: {
      labels?: Record<string, string>;
      workspaceId?: string;
      initialPrompt?: string;
    },
  ): Promise<ManagedAgent> {
    const resolvedAgentId = validateAgentId(agentId ?? this.idFactory(), "createAgent");
    const injectedConfig =
      this.mcpBaseUrl == null
        ? config
        : {
            ...config,
            mcpServers: {
              paseo: {
                type: "http" as const,
                url: `${this.mcpBaseUrl}?callerAgentId=${resolvedAgentId}`,
              },
              ...config.mcpServers,
            },
          };
    this.requireEnabledProvider(injectedConfig.provider);
    const normalizedConfig = await this.normalizeConfig(injectedConfig);
    const launchContext = this.buildLaunchContext(resolvedAgentId);
    const client = await this.requireAvailableClient({
      provider: normalizedConfig.provider,
    });
    const session = await client.createSession(normalizedConfig, launchContext);
    return this.registerSession(session, normalizedConfig, resolvedAgentId, {
      labels: options?.labels,
      workspaceId: options?.workspaceId,
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
    const available = await client.isAvailable();
    if (!available) {
      throw new Error(
        `Provider '${handle.provider}' is not available. Please ensure the CLI is installed.`,
      );
    }
    const session = await client.resumeSession(handle, resumeOverrides, launchContext);
    return this.registerSession(session, normalizedConfig, resolvedAgentId, options);
  }

  // Hot-reload an active agent session with config overrides while preserving
  // in-memory timeline state.
  async reloadAgentSession(
    agentId: string,
    overrides?: Partial<AgentSessionConfig>,
  ): Promise<ManagedAgent> {
    let existing = this.requireSessionAgent(agentId);
    if (this.hasInFlightRun(agentId)) {
      await this.cancelAgentRun(agentId);
      existing = this.requireSessionAgent(agentId);
    }
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

    this.agentStreamCoalescer.flushAndDiscard(agentId);
    // Remove the existing agent entry before swapping sessions
    this.agents.delete(agentId);
    if (existing.unsubscribeSession) {
      existing.unsubscribeSession();
      existing.unsubscribeSession = null;
    }
    this.foregroundRuns.clearAgent(agentId, existing);
    await this.closeReloadedSession(existing.session, agentId);

    // Preserve existing labels and timeline during reload.
    return this.registerSession(session, normalizedConfig, agentId, {
      labels: existing.labels,
      createdAt: existing.createdAt,
      updatedAt: existing.updatedAt,
      lastUserMessageAt: existing.lastUserMessageAt,
      historyPrimed: preservedHistoryPrimed,
      lastUsage: preservedLastUsage,
      lastError: preservedLastError,
      attention: preservedAttention,
    });
  }

  private async closeReloadedSession(session: AgentSession, agentId: string): Promise<void> {
    try {
      const result = await this.waitWithTimeout({
        operation: session.close(),
        timeoutMs: this.rescueTimeouts.reloadSessionCloseMs,
        onLateError: (error) => {
          this.logger.warn(
            { err: error, agentId },
            "Previous session close failed after refresh timeout",
          );
        },
      });

      if (result === "timed_out") {
        this.logger.warn(
          { agentId, timeoutMs: this.rescueTimeouts.reloadSessionCloseMs },
          "Timed out closing previous session during refresh",
        );
      }
    } catch (error) {
      this.logger.warn({ err: error, agentId }, "Failed to close previous session during refresh");
    }
  }

  private async waitWithTimeout(options: TimeoutOptions): Promise<TimeoutResult> {
    let didTimeOut = false;
    let timer: NodeJS.Timeout | null = null;
    const operation = options.operation
      .then((): TimeoutResult => "completed")
      .catch((error) => {
        if (didTimeOut) {
          options.onLateError?.(error);
          return "timed_out" as const;
        }
        throw error;
      });

    try {
      return await Promise.race([
        operation,
        new Promise<TimeoutResult>((resolvePromise) => {
          timer = setTimeout(() => {
            didTimeOut = true;
            resolvePromise("timed_out");
          }, options.timeoutMs);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
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
    const closedAgent = this.prepareAgentForClosure(agent, "agent closed");
    await agent.session.close();
    this.timelineStore.delete(agentId);
    await this.persistSnapshot(closedAgent);
    this.emitClosedAgent(closedAgent, { persist: false });
    this.logger.trace({ agentId }, "closeAgent: completed");
  }

  async archiveAgent(agentId: string): Promise<{ archivedAt: string }> {
    const agent = this.requireAgent(agentId);
    if (!this.registry) {
      throw new Error("Agent storage is not configured");
    }

    await this.registry.applySnapshot(agent, {
      internal: agent.internal,
    });
    const stored = await this.registry.get(agentId);
    if (!stored) {
      throw new Error(`Agent ${agentId} not found in storage after snapshot`);
    }

    const archivedAt = new Date().toISOString();
    const normalizedStatus =
      stored.lastStatus === "running" || stored.lastStatus === "initializing"
        ? "idle"
        : stored.lastStatus;

    await this.registry.upsert({
      ...stored,
      archivedAt,
      updatedAt: archivedAt,
      lastStatus: normalizedStatus,
      requiresAttention: false,
      attentionReason: null,
      attentionTimestamp: null,
    });
    this.notifyAgentState(agentId);
    await this.closeAgent(agentId);

    return { archivedAt };
  }

  async setAgentMode(agentId: string, modeId: string): Promise<void> {
    const agent = this.requireSessionAgent(agentId);
    await agent.session.setMode(modeId);
    agent.config.modeId = modeId;
    agent.currentModeId = modeId;
    // Update runtimeInfo to reflect the new mode
    if (agent.runtimeInfo) {
      agent.runtimeInfo = { ...agent.runtimeInfo, modeId };
    }
    this.touchUpdatedAt(agent);
    this.emitState(agent);
  }

  async setAgentModel(agentId: string, modelId: string | null): Promise<void> {
    const agent = this.requireSessionAgent(agentId);
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
    const agent = this.requireSessionAgent(agentId);
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

  async setAgentFeature(agentId: string, featureId: string, value: unknown): Promise<void> {
    const agent = this.requireAgent(agentId);

    if (!agent.session.setFeature) {
      throw new Error("Agent session does not support setting features");
    }

    await agent.session.setFeature(featureId, value);
    agent.config.featureValues = { ...agent.config.featureValues, [featureId]: value };
    this.touchUpdatedAt(agent);
    this.emitState(agent);
  }

  async setTitle(agentId: string, title: string): Promise<void> {
    const agent = this.requireAgent(agentId);
    const normalizedTitle = title.trim();
    if (!normalizedTitle) {
      return;
    }
    if (
      this.agentsAwaitingInitialSnapshotPersist.has(agent.id) &&
      this.registry &&
      (await this.registry.get(agent.id)) === null
    ) {
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
        epoch: this.timelineStore.getEpoch(agentId),
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
        epoch: this.timelineStore.getEpoch(agentId),
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
    const existingAgent = this.requireSessionAgent(agentId);
    this.logger.trace(
      {
        agentId,
        lifecycle: existingAgent.lifecycle,
        activeForegroundTurnId: existingAgent.activeForegroundTurnId,
        hasPendingForegroundRun: this.foregroundRuns.hasPendingRun(agentId),
        promptType: typeof prompt === "string" ? "string" : "structured",
        hasRunOptions: Boolean(options),
      },
      "streamAgent: requested",
    );
    if (existingAgent.activeForegroundTurnId || this.foregroundRuns.hasPendingRun(agentId)) {
      this.logger.trace(
        {
          agentId,
          lifecycle: existingAgent.lifecycle,
          hasPendingForegroundRun: this.foregroundRuns.hasPendingRun(agentId),
        },
        "streamAgent: rejected because a foreground run is already in flight",
      );
      throw new Error(`Agent ${agentId} already has an active run`);
    }

    const agent = existingAgent as ActiveManagedAgent;
    agent.pendingReplacement = false;
    agent.lastError = undefined;

    const pendingRun = this.foregroundRuns.createPendingRun(agentId);

    const streamForwarder = async function* streamForwarder(this: AgentManager) {
      let turnId: string;
      let turnStream: ReturnType<ForegroundRunState["createTurnStream"]> | null = null;
      try {
        const result = await agent.session.startTurn(prompt, options);
        turnId = result.turnId;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : "Failed to start turn";
        await this.handleStreamEvent(agent, {
          type: "turn_failed",
          provider: agent.provider,
          error: errorMsg,
        });
        this.finalizeForegroundTurn(agent);
        this.foregroundRuns.settlePendingRun(agentId, pendingRun.token);
        throw error;
      }

      pendingRun.started = true;
      agent.activeForegroundTurnId = turnId;
      agent.lifecycle = "running";
      this.touchUpdatedAt(agent);
      this.emitState(agent);
      this.logger.trace(
        {
          agentId,
          lifecycle: agent.lifecycle,
          activeForegroundTurnId: agent.activeForegroundTurnId,
        },
        "streamAgent: started",
      );

      turnStream = this.foregroundRuns.createTurnStream(turnId);
      this.foregroundRuns.addWaiter(agent, turnStream.waiter);

      try {
        for await (const event of turnStream.events(isTurnTerminalEvent)) {
          yield event;
        }
      } finally {
        if (turnStream) {
          this.foregroundRuns.deleteWaiter(agent, turnStream.waiter);
        }
        this.foregroundRuns.settlePendingRun(agentId, pendingRun.token);
        if (!agent.activeForegroundTurnId) {
          await this.refreshRuntimeInfo(agent);
        }
      }
    }.call(this);

    return streamForwarder;
  }

  private finalizeForegroundTurn(agent: ActiveManagedAgent, turnId?: string): void {
    const mutableAgent = agent as ActiveManagedAgent;
    if (turnId) {
      this.foregroundRuns.rememberFinalizedTurn(mutableAgent, turnId);
    }
    mutableAgent.activeForegroundTurnId = null;
    const terminalError = mutableAgent.lastError;
    const shouldHoldBusyForReplacement = mutableAgent.pendingReplacement && !terminalError;
    let nextLifecycle: "running" | "error" | "idle";
    if (shouldHoldBusyForReplacement) {
      nextLifecycle = "running";
    } else if (terminalError) {
      nextLifecycle = "error";
    } else {
      nextLifecycle = "idle";
    }
    mutableAgent.lifecycle = nextLifecycle;
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
      !this.foregroundRuns.hasPendingRun(agentId)
    ) {
      return this.streamAgent(agentId, prompt, options);
    }

    const agent = this.requireSessionAgent(agentId);
    agent.pendingReplacement = true;
    agent.lifecycle = "running";
    this.touchUpdatedAt(agent);
    this.emitState(agent);

    return async function* replaceRunForwarder(this: AgentManager) {
      try {
        await this.cancelAgentRun(agentId);
        const nextRun = this.streamAgent(agentId, prompt, options);
        for await (const event of nextRun) {
          yield event;
        }
      } catch (error) {
        const latest = this.agents.get(agentId);
        if (latest) {
          const latestActive = latest as ActiveManagedAgent;
          latestActive.pendingReplacement = false;
          if (!latestActive.activeForegroundTurnId && latestActive.lifecycle === "running") {
            (latestActive as ActiveManagedAgent).lifecycle = "idle";
            this.touchUpdatedAt(latestActive);
            this.emitState(latestActive);
          }
        }
        throw error;
      }
    }.call(this);
  }

  async waitForAgentRunStart(agentId: string, options?: WaitForAgentStartOptions): Promise<void> {
    const snapshot = this.getAgent(agentId);
    if (!snapshot) {
      throw new Error(`Agent ${agentId} not found`);
    }

    const pendingRun = this.foregroundRuns.getPendingRun(agentId);
    if ((snapshot.lifecycle === "running" || pendingRun?.started) && !snapshot.pendingReplacement) {
      return;
    }

    if (!snapshot.activeForegroundTurnId && !pendingRun && !snapshot.pendingReplacement) {
      throw new Error(`Agent ${agentId} has no pending run`);
    }

    if (options?.signal?.aborted) {
      throw createAbortError(options.signal, "wait_for_agent_start aborted");
    }

    await new Promise<void>((resolvePromise, reject) => {
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
        resolvePromise();
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

        const currentPendingRun = this.foregroundRuns.getPendingRun(agentId);
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

        if (!currentPendingRun && !current.activeForegroundTurnId && !current.pendingReplacement) {
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
  ): Promise<AgentPermissionResult | void> {
    const agent = this.requireAgent(agentId);
    agent.inFlightPermissionResponses.add(requestId);

    try {
      const result = await agent.session.respondToPermission(requestId, response);
      agent.pendingPermissions.delete(requestId);

      try {
        await this.refreshSessionState(agent);
      } catch {
        // Ignore refresh errors - state sync after permission approval is best effort.
      }

      this.touchUpdatedAt(agent);
      await this.persistSnapshot(agent);
      this.emitState(agent);

      const bufferedResolution = agent.bufferedPermissionResolutions.get(requestId);
      if (bufferedResolution) {
        agent.bufferedPermissionResolutions.delete(requestId);
        this.dispatchStream(agent.id, bufferedResolution);
      }

      return result;
    } finally {
      agent.inFlightPermissionResponses.delete(requestId);
      agent.bufferedPermissionResolutions.delete(requestId);
    }
  }

  async cancelAgentRun(agentId: string): Promise<boolean> {
    const agent = this.requireSessionAgent(agentId);
    const pendingRun = this.foregroundRuns.getPendingRun(agentId);
    const foregroundTurnId = agent.activeForegroundTurnId;
    const hasForegroundTurn = Boolean(foregroundTurnId);
    const isAutonomousRunning = agent.lifecycle === "running" && !hasForegroundTurn && !pendingRun;

    if (!hasForegroundTurn && !isAutonomousRunning && !pendingRun) {
      return false;
    }

    await this.interruptSession(agent.session, agentId);

    // The interrupt will produce a turn_canceled/turn_failed event via subscribe(),
    // which flows through the session event dispatcher and settles the foreground turn waiter.
    // Wait briefly for the event to propagate if there's an active foreground turn.
    if (foregroundTurnId) {
      const waiter = Array.from(agent.foregroundTurnWaiters).find(
        (candidate) => candidate.turnId === foregroundTurnId,
      );
      const timeout = new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 2000));
      if (waiter) {
        await Promise.race([waiter.settledPromise, timeout]);
      } else if (agent.activeForegroundTurnId === foregroundTurnId) {
        await Promise.race([
          new Promise<void>((resolvePromise) => {
            const unsubscribe = this.subscribe(
              (event) => {
                if (
                  event.type === "agent_state" &&
                  event.agent.id === agentId &&
                  !event.agent.activeForegroundTurnId
                ) {
                  unsubscribe();
                  resolvePromise();
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
      const timeout = new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 2000));
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
      const staleRun = this.foregroundRuns.getPendingRun(agentId);
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

  private async interruptSession(session: AgentSession, agentId: string): Promise<void> {
    try {
      const result = await this.waitWithTimeout({
        operation: session.interrupt(),
        timeoutMs: this.rescueTimeouts.interruptSessionMs,
        onLateError: (error) => {
          this.logger.warn(
            { err: error, agentId },
            "Session interrupt failed after timeout during cancel",
          );
        },
      });

      if (result === "timed_out") {
        this.logger.warn(
          { agentId, timeoutMs: this.rescueTimeouts.interruptSessionMs },
          "Timed out interrupting session during cancel",
        );
      }
    } catch (error) {
      this.logger.error({ err: error, agentId }, "Failed to interrupt session");
    }
  }

  getPendingPermissions(agentId: string): AgentPermissionRequest[] {
    const agent = this.requireSessionAgent(agentId);
    return Array.from(agent.pendingPermissions.values());
  }

  private peekPendingPermission(agent: ManagedAgent): AgentPermissionRequest | null {
    const iterator = agent.pendingPermissions.values().next();
    return iterator.done ? null : iterator.value;
  }

  /**
   * Hydrates the timeline from provider history if the agent's durable
   * timeline is empty (e.g., imported agents that have provider history
   * on disk but no persisted timeline rows). No-ops if already hydrated.
   */
  async hydrateTimelineFromProvider(agentId: string): Promise<void> {
    const agent = this.requireSessionAgent(agentId);
    await this.hydrateTimelineFromLegacyProviderHistory(agent);
  }

  async deleteCommittedTimeline(agentId: string): Promise<void> {
    if (!this.durableTimelineStore) {
      return;
    }
    await this.durableTimelineStore.deleteAgent(agentId);
  }

  async getLastAssistantMessage(agentId: string): Promise<string | null> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return null;
    }

    return await this.getLastAssistantMessageFromStores(agentId);
  }

  private getLastAssistantMessageFromTimeline(
    timeline: readonly AgentTimelineItem[],
  ): string | null {
    return this.getLastAssistantMessageSegmentFromTimeline(timeline)?.text ?? null;
  }

  private getLastAssistantMessageSegmentFromTimeline(
    timeline: readonly AgentTimelineItem[],
  ): { text: string; startsAtBeginning: boolean } | null {
    // Collect the last contiguous assistant messages (Claude streams chunks)
    const chunks: string[] = [];
    let startsAtBeginning = false;
    for (let i = timeline.length - 1; i >= 0; i--) {
      const item = timeline[i];
      if (item.type !== "assistant_message") {
        if (chunks.length) {
          break;
        }
        continue;
      }
      chunks.push(item.text);
      startsAtBeginning = i === 0;
    }

    if (!chunks.length) {
      return null;
    }

    return {
      text: chunks.toReversed().join(""),
      startsAtBeginning,
    };
  }

  private async getLastAssistantMessageFromStores(agentId: string): Promise<string | null> {
    const liveTimeline = this.timelineStore.getItems(agentId);
    const liveSegment = this.getLastAssistantMessageSegmentFromTimeline(liveTimeline);
    if (!this.durableTimelineStore) {
      return liveSegment?.text ?? null;
    }

    if (!liveSegment) {
      return await this.durableTimelineStore.getLastAssistantMessage(agentId);
    }

    if (!liveSegment.startsAtBeginning) {
      return liveSegment.text;
    }

    const lastDurableItem = await this.durableTimelineStore.getLastItem(agentId);
    if (lastDurableItem?.type !== "assistant_message") {
      return liveSegment.text;
    }

    const durableMessage = await this.durableTimelineStore.getLastAssistantMessage(agentId);
    return durableMessage ? `${durableMessage}${liveSegment.text}` : liveSegment.text;
  }

  private async getLastItemFromStores(agentId: string): Promise<AgentTimelineItem | null> {
    const lastLiveItem = this.timelineStore.getLastItem(agentId);
    if (lastLiveItem) {
      return lastLiveItem;
    }
    if (!this.durableTimelineStore) {
      return null;
    }
    return await this.durableTimelineStore.getLastItem(agentId);
  }

  private async hasCommittedUserMessageFromStores(
    agentId: string,
    options: { messageId: string; text: string },
  ): Promise<boolean> {
    if (this.timelineStore.hasCommittedUserMessage(agentId, options)) {
      return true;
    }
    if (!this.durableTimelineStore) {
      return false;
    }
    return await this.durableTimelineStore.hasCommittedUserMessage(agentId, options);
  }

  async waitForAgentEvent(
    agentId: string,
    options?: WaitForAgentOptions,
  ): Promise<WaitForAgentResult> {
    const snapshot = this.getAgent(agentId);
    if (!snapshot) {
      throw new Error(`Agent ${agentId} not found`);
    }

    const pendingForegroundRun = this.foregroundRuns.getPendingRun(agentId);
    const hasForegroundTurn =
      Boolean(snapshot.activeForegroundTurnId) || Boolean(pendingForegroundRun);

    const immediatePermission = this.peekPendingPermission(snapshot);
    if (immediatePermission) {
      return {
        status: snapshot.lifecycle,
        permission: immediatePermission,
        lastMessage: await this.getLastAssistantMessage(agentId),
      };
    }

    const initialStatus = snapshot.lifecycle;
    const initialBusy = isAgentBusy(initialStatus) || hasForegroundTurn;
    const waitForActive = options?.waitForActive ?? false;
    if (!waitForActive && !initialBusy) {
      return {
        status: initialStatus,
        permission: null,
        lastMessage: await this.getLastAssistantMessage(agentId),
      };
    }
    if (waitForActive && !initialBusy && !hasForegroundTurn) {
      return {
        status: initialStatus,
        permission: null,
        lastMessage: await this.getLastAssistantMessage(agentId),
      };
    }

    if (options?.signal?.aborted) {
      throw createAbortError(options.signal, "wait_for_agent aborted");
    }

    return await new Promise<WaitForAgentResult>((resolvePromise, reject) => {
      // Bug #1 Fix: Check abort signal AGAIN inside Promise constructor
      // to avoid race condition between pre-Promise check and abort listener registration
      if (options?.signal?.aborted) {
        reject(createAbortError(options.signal, "wait_for_agent aborted"));
        return;
      }

      let currentStatus: AgentLifecycleStatus = initialStatus;
      let hasStarted =
        isAgentBusy(initialStatus) ||
        Boolean(snapshot.activeForegroundTurnId) ||
        Boolean(pendingForegroundRun?.started);
      let terminalStatusOverride: AgentLifecycleStatus | null = null;
      let finished = false;

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
        if (finished) {
          return;
        }
        finished = true;
        cleanup();
        void this.getLastAssistantMessage(agentId)
          .then((lastMessage) => {
            resolvePromise({
              status: currentStatus,
              permission,
              lastMessage,
            });
            return;
          })
          .catch(reject);
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
      workspaceId?: string;
      createdAt?: Date;
      updatedAt?: Date;
      lastUserMessageAt?: Date | null;
      labels?: Record<string, string>;
      timeline?: AgentTimelineItem[];
      timelineRows?: AgentTimelineRow[];
      timelineNextSeq?: number;
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
    const { durableTimelineHasRows } = await this.initializeAgentTimelineForRegister({
      agentId: resolvedAgentId,
      now,
      options,
    });

    const managed = this.buildManagedAgentForRegister({
      resolvedAgentId,
      session,
      config,
      now,
      durableTimelineHasRows,
      options,
    });

    this.agents.set(resolvedAgentId, managed);
    // Initialize previousStatus to track transitions
    this.previousStatuses.set(resolvedAgentId, managed.lifecycle);
    await this.refreshRuntimeInfo(managed);
    await this.persistSnapshot(managed, {
      workspaceId: options?.workspaceId,
      title: initialPersistedTitle,
    });
    this.emitState(managed, { persist: false });

    await this.refreshSessionState(managed);
    managed.lifecycle = "idle";
    await this.persistSnapshot(managed, { workspaceId: options?.workspaceId });
    this.emitState(managed, { persist: false });
    this.subscribeToSession(managed);
    return { ...managed };
  }

  private async initializeAgentTimelineForRegister(params: {
    agentId: string;
    now: Date;
    options:
      | {
          timeline?: AgentTimelineItem[];
          timelineRows?: AgentTimelineRow[];
          timelineNextSeq?: number;
          createdAt?: Date;
          updatedAt?: Date;
        }
      | undefined;
  }): Promise<{ durableTimelineHasRows: boolean }> {
    const { agentId, now, options } = params;
    const explicitTimelineSeed = buildExplicitTimelineSeedForRegister(now, options);
    const shouldSeedFromDurable =
      !explicitTimelineSeed &&
      !this.timelineStore.has(agentId) &&
      this.durableTimelineStore !== undefined;
    const durableTimelineSeed = shouldSeedFromDurable
      ? await this.loadCommittedTimelineSeed(agentId, now)
      : null;
    const durableTimelineHasRows =
      durableTimelineSeed != null && (durableTimelineSeed.nextSeq ?? 1) > 1;
    const timelineSeed = explicitTimelineSeed ?? durableTimelineSeed;
    if (timelineSeed || !this.timelineStore.has(agentId)) {
      this.timelineStore.initialize(agentId, timelineSeed ?? { timestamp: now.toISOString() });
    }
    if (options?.timelineRows?.length) {
      this.enqueueDurableTimelineBulkInsert(agentId, options.timelineRows);
    }
    return { durableTimelineHasRows };
  }

  private buildManagedAgentForRegister(params: {
    resolvedAgentId: string;
    session: AgentSession;
    config: AgentSessionConfig;
    now: Date;
    durableTimelineHasRows: boolean;
    options:
      | {
          createdAt?: Date;
          updatedAt?: Date;
          lastUserMessageAt?: Date | null;
          labels?: Record<string, string>;
          historyPrimed?: boolean;
          lastUsage?: AgentUsage;
          lastError?: string;
          attention?: AttentionState;
        }
      | undefined;
  }): ActiveManagedAgent {
    const { resolvedAgentId, session, config, now, durableTimelineHasRows, options } = params;
    return {
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
      pendingPermissions: new Map<string, AgentPermissionRequest>(),
      bufferedPermissionResolutions: new Map(),
      inFlightPermissionResponses: new Set(),
      pendingReplacement: false,
      activeForegroundTurnId: null,
      foregroundTurnWaiters: new Set<ForegroundTurnWaiter>(),
      finalizedForegroundTurnIds: new Set<string>(),
      unsubscribeSession: null,
      persistence: attachPersistenceCwd(session.describePersistence(), config.cwd),
      historyPrimed: options?.historyPrimed ?? durableTimelineHasRows,
      lastUserMessageAt: options?.lastUserMessageAt ?? null,
      lastUsage: options?.lastUsage,
      lastError: options?.lastError,
      attention: resolveInitialAttention(options?.attention),
      internal: config.internal ?? false,
      labels: options?.labels ?? {},
    } as ActiveManagedAgent;
  }

  private async loadCommittedTimelineSeed(
    agentId: string,
    now: Date,
  ): Promise<SeedAgentTimelineOptions> {
    if (!this.durableTimelineStore) {
      return { timestamp: now.toISOString() };
    }

    return {
      nextSeq: (await this.durableTimelineStore.getLatestCommittedSeq(agentId)) + 1,
      timestamp: now.toISOString(),
    };
  }

  private prepareAgentForClosure(
    agent: LiveManagedAgent,
    cancelReason: string,
  ): ManagedAgentClosed {
    this.agentStreamCoalescer.flushAndDiscard(agent.id);
    this.agents.delete(agent.id);
    this.previousStatuses.delete(agent.id);
    if (agent.unsubscribeSession) {
      agent.unsubscribeSession();
      agent.unsubscribeSession = null;
    }
    this.foregroundRuns.cancelWaiters(agent, (turnId) => ({
      type: "turn_canceled",
      provider: agent.provider,
      reason: cancelReason,
      turnId,
    }));
    this.foregroundRuns.settlePendingRun(agent.id);
    return {
      ...agent,
      lifecycle: "closed",
      session: null,
      activeForegroundTurnId: null,
    };
  }

  private emitClosedAgent(agent: ManagedAgentClosed, options?: { persist?: boolean }): void {
    this.emitState(agent, options);
  }
  private subscribeToSession(agent: ActiveManagedAgent): void {
    if (agent.unsubscribeSession) {
      return;
    }
    const agentId = agent.id;
    const unsubscribe = agent.session.subscribe((event: AgentStreamEvent) => {
      this.enqueueSessionEvent(agentId, event);
    });
    agent.unsubscribeSession = unsubscribe;
  }

  private enqueueSessionEvent(agentId: string, event: AgentStreamEvent): void {
    const previous = this.sessionEventTails.get(agentId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const current = this.agents.get(agentId);
        if (!current) {
          return;
        }
        if (current.session == null) {
          return;
        }
        await this.dispatchSessionEvent(current, event);
        return;
      })
      .catch((err) => {
        this.logger.error(
          { err, agentId, eventType: event.type },
          "Failed to process session event",
        );
      });

    this.sessionEventTails.set(agentId, next);
    this.trackBackgroundTask(next);
    void next.finally(() => {
      if (this.sessionEventTails.get(agentId) === next) {
        this.sessionEventTails.delete(agentId);
      }
    });
  }

  private async dispatchSessionEvent(
    agent: ActiveManagedAgent,
    event: AgentStreamEvent,
  ): Promise<void> {
    const turnId = (event as { turnId?: string }).turnId;
    const matchingWaiters = this.foregroundRuns.getMatchingWaiters(agent, turnId);

    const shouldNotifyWaiters = await this.handleStreamEvent(agent, event);

    if (!shouldNotifyWaiters) {
      return;
    }

    this.foregroundRuns.notifyWaiters(matchingWaiters, event, {
      terminal: isTurnTerminalEvent(event),
    });
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
    options?: { workspaceId?: string; title?: string | null; internal?: boolean },
  ): Promise<void> {
    if (!this.registry) {
      return;
    }
    // Don't persist internal agents - they're ephemeral system tasks
    if (agent.internal) {
      return;
    }
    if (options?.workspaceId !== undefined) {
      await this.registry.applySnapshot(agent, options.workspaceId, options);
      return;
    }
    await this.registry.applySnapshot(agent, options);
  }

  private requireRegistry(): AgentStorage {
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

    this.syncFeaturesFromSession(agent);
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

  private async hydrateTimelineFromLegacyProviderHistory(agent: ActiveManagedAgent): Promise<void> {
    if (agent.historyPrimed) {
      return;
    }
    agent.historyPrimed = true;
    const canonicalUserMessagesById = this.timelineStore.getCanonicalUserMessagesById(agent.id);
    try {
      for await (const event of agent.session.streamHistory()) {
        if (event.type !== "timeline") {
          continue;
        }
        if (isDuplicateLegacyUserMessage(event.item, canonicalUserMessagesById)) {
          continue;
        }
        this.recordTimeline(agent.id, event.item);
      }
    } catch {
      // ignore history failures
    }
  }

  private notifyForegroundTurnWaiters(agentId: string, event: AgentStreamEvent): void {
    const turnId = (event as { turnId?: string }).turnId;
    if (turnId == null) {
      return;
    }

    const agent = this.agents.get(agentId);
    if (!agent) {
      return;
    }

    this.foregroundRuns.notifyAgentWaiters(agent, event);
  }

  private async handleStreamEvent(
    agent: ActiveManagedAgent,
    event: AgentStreamEvent,
    options?: HandleStreamEventOptions,
  ): Promise<boolean> {
    const eventTurnId = (event as { turnId?: string }).turnId;
    const isForegroundEvent = Boolean(eventTurnId && agent.activeForegroundTurnId === eventTurnId);
    if (
      eventTurnId &&
      isTurnTerminalEvent(event) &&
      this.foregroundRuns.hasFinalizedTurn(agent, eventTurnId)
    ) {
      return false;
    }

    // Only update timestamp for live events, not history replay
    if (!options?.fromHistory) {
      this.touchUpdatedAt(agent);
      if (this.agentStreamCoalescer.handle(agent.id, event)) {
        return false;
      }
      this.agentStreamCoalescer.flushFor(agent.id);
    }

    const flags: StreamEventFlags = { shouldDispatchEvent: true, shouldNotifyWaiters: true };

    const dispatchPromise = this.dispatchStreamEventByType({
      agent,
      event,
      options,
      isForegroundEvent,
      eventTurnId,
      flags,
    });
    if (dispatchPromise) {
      await dispatchPromise;
    }

    if (!options?.fromHistory && isForegroundEvent && isTurnTerminalEvent(event)) {
      this.finalizeForegroundTurn(agent, eventTurnId);
    }

    if (!options?.fromHistory && flags.shouldDispatchEvent) {
      this.dispatchStream(agent.id, event);
    }

    return flags.shouldNotifyWaiters;
  }

  private dispatchStreamEventByType(params: {
    agent: ActiveManagedAgent;
    event: AgentStreamEvent;
    options: HandleStreamEventOptions | undefined;
    isForegroundEvent: boolean;
    eventTurnId: string | undefined;
    flags: StreamEventFlags;
  }): Promise<void> | undefined {
    const { agent, event, options, isForegroundEvent, eventTurnId, flags } = params;
    switch (event.type) {
      case "thread_started":
        this.onStreamThreadStarted(agent);
        return undefined;
      case "usage_updated":
        agent.lastUsage = event.usage;
        this.emitState(agent);
        return undefined;
      case "mode_changed":
        agent.currentModeId = event.currentModeId;
        agent.availableModes = event.availableModes;
        if (agent.runtimeInfo) {
          agent.runtimeInfo = { ...agent.runtimeInfo, modeId: event.currentModeId };
        }
        flags.shouldDispatchEvent = false;
        this.emitState(agent);
        return undefined;
      case "model_changed":
        agent.runtimeInfo = event.runtimeInfo;
        if (!agent.persistence && event.runtimeInfo.sessionId) {
          agent.persistence = attachPersistenceCwd(
            { provider: agent.provider, sessionId: event.runtimeInfo.sessionId },
            agent.cwd,
          );
        }
        agent.currentModeId = event.runtimeInfo.modeId ?? agent.currentModeId;
        flags.shouldDispatchEvent = false;
        this.emitState(agent);
        return undefined;
      case "thinking_option_changed":
        if (agent.runtimeInfo) {
          agent.runtimeInfo = {
            ...agent.runtimeInfo,
            thinkingOptionId: event.thinkingOptionId,
          };
        }
        flags.shouldDispatchEvent = false;
        this.emitState(agent);
        return undefined;
      case "timeline":
        return this.onStreamTimelineEvent({ agent, event, options, isForegroundEvent, flags });
      case "turn_completed":
        this.onStreamTurnCompleted({ agent, event, eventTurnId, isForegroundEvent });
        return undefined;
      case "turn_failed":
        return this.onStreamTurnFailed({
          agent,
          event,
          eventTurnId,
          isForegroundEvent,
          options,
        });
      case "turn_canceled":
        this.onStreamTurnCanceled({ agent, event, eventTurnId, isForegroundEvent, options });
        return undefined;
      case "turn_started":
        this.onStreamTurnStarted({ agent, eventTurnId, isForegroundEvent });
        return undefined;
      case "permission_requested":
        this.onStreamPermissionRequested(agent, event);
        return undefined;
      case "permission_resolved":
        this.onStreamPermissionResolved({ agent, event, options, flags });
        return undefined;
      default:
        return undefined;
    }
  }

  private onStreamThreadStarted(agent: ActiveManagedAgent): void {
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

  private async onStreamTimelineEvent(params: {
    agent: ActiveManagedAgent;
    event: Extract<AgentStreamEvent, { type: "timeline" }>;
    options:
      | {
          fromHistory?: boolean;
          canonicalUserMessagesById?: ReadonlyMap<string, string>;
        }
      | undefined;
    isForegroundEvent: boolean;
    flags: StreamEventFlags;
  }): Promise<void> {
    const { agent, event, options, isForegroundEvent, flags } = params;
    // Skip provider-replayed user_message items during history hydration.
    if (options?.fromHistory && event.item.type === "user_message") {
      const eventMessageId = normalizeMessageId(event.item.messageId);
      if (eventMessageId) {
        const canonicalText = options?.canonicalUserMessagesById?.get(eventMessageId);
        if (canonicalText === event.item.text) {
          flags.shouldDispatchEvent = false;
          flags.shouldNotifyWaiters = false;
          return;
        }
      }
    }

    // Suppress user_message echoes for the active foreground turn.
    if (!options?.fromHistory && event.item.type === "user_message" && isForegroundEvent) {
      const eventMessageId = normalizeMessageId(event.item.messageId);
      if (
        eventMessageId &&
        (await this.hasCommittedUserMessageFromStores(agent.id, {
          messageId: eventMessageId,
          text: event.item.text,
        }))
      ) {
        return;
      }
    }

    if (options?.fromHistory) {
      this.recordTimeline(agent.id, event.item);
      flags.shouldDispatchEvent = false;
      flags.shouldNotifyWaiters = false;
      return;
    }

    this.recordAndDispatchTimelineItem(agent.id, event.item, event.provider, event.turnId);
    if (event.item.type === "user_message") {
      agent.lastUserMessageAt = new Date();
      this.emitState(agent);
    }
    flags.shouldDispatchEvent = false;
    flags.shouldNotifyWaiters = true;
  }

  private onStreamTurnCompleted(params: {
    agent: ActiveManagedAgent;
    event: Extract<AgentStreamEvent, { type: "turn_completed" }>;
    eventTurnId: string | undefined;
    isForegroundEvent: boolean;
  }): void {
    const { agent, event, eventTurnId, isForegroundEvent } = params;
    this.logger.trace(
      {
        agentId: agent.id,
        lifecycle: agent.lifecycle,
        activeForegroundTurnId: agent.activeForegroundTurnId,
        eventTurnId,
      },
      "handleStreamEvent: turn_completed",
    );
    agent.lastUsage = event.usage;
    agent.lastError = undefined;
    if (!isForegroundEvent && agent.lifecycle !== "idle" && !agent.pendingReplacement) {
      (agent as ActiveManagedAgent).lifecycle = "idle";
      this.emitState(agent);
    }
    void this.refreshRuntimeInfo(agent);
  }

  private async onStreamTurnFailed(params: {
    agent: ActiveManagedAgent;
    event: Extract<AgentStreamEvent, { type: "turn_failed" }>;
    eventTurnId: string | undefined;
    isForegroundEvent: boolean;
    options:
      | {
          fromHistory?: boolean;
          canonicalUserMessagesById?: ReadonlyMap<string, string>;
        }
      | undefined;
  }): Promise<void> {
    const { agent, event, eventTurnId, isForegroundEvent, options } = params;
    this.logger.warn(
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
    if (!isForegroundEvent) {
      agent.lifecycle = "error";
    }
    agent.lastError = event.error;
    await this.appendSystemErrorTimelineMessage(
      agent,
      event.provider,
      this.formatTurnFailedMessage(event),
      options,
    );
    this.resolvePendingPermissionsForAgent(agent, event.provider, options, "Turn failed");
    if (!isForegroundEvent) {
      this.emitState(agent);
    }
  }

  private onStreamTurnCanceled(params: {
    agent: ActiveManagedAgent;
    event: Extract<AgentStreamEvent, { type: "turn_canceled" }>;
    eventTurnId: string | undefined;
    isForegroundEvent: boolean;
    options:
      | {
          fromHistory?: boolean;
        }
      | undefined;
  }): void {
    const { agent, event, eventTurnId, isForegroundEvent, options } = params;
    this.logger.trace(
      {
        agentId: agent.id,
        lifecycle: agent.lifecycle,
        activeForegroundTurnId: agent.activeForegroundTurnId,
        eventTurnId,
      },
      "handleStreamEvent: turn_canceled",
    );
    if (!isForegroundEvent && !agent.pendingReplacement) {
      (agent as ActiveManagedAgent).lifecycle = "idle";
    }
    agent.lastError = undefined;
    this.resolvePendingPermissionsForAgent(agent, event.provider, options, "Interrupted");
    if (!isForegroundEvent) {
      this.emitState(agent);
    }
  }

  private onStreamTurnStarted(params: {
    agent: ActiveManagedAgent;
    eventTurnId: string | undefined;
    isForegroundEvent: boolean;
  }): void {
    const { agent, eventTurnId, isForegroundEvent } = params;
    this.logger.trace(
      {
        agentId: agent.id,
        lifecycle: agent.lifecycle,
        activeForegroundTurnId: agent.activeForegroundTurnId,
        eventTurnId,
      },
      "handleStreamEvent: turn_started",
    );
    if (!isForegroundEvent) {
      (agent as ActiveManagedAgent).lifecycle = "running";
      this.emitState(agent);
    }
  }

  private onStreamPermissionRequested(
    agent: ActiveManagedAgent,
    event: Extract<AgentStreamEvent, { type: "permission_requested" }>,
  ): void {
    const hadPendingPermissions = agent.pendingPermissions.size > 0;
    agent.pendingPermissions.set(event.request.id, event.request);
    if (!hadPendingPermissions && !agent.internal) {
      this.broadcastAgentAttention(agent, "permission");
    }
    this.emitState(agent);
  }

  private onStreamPermissionResolved(params: {
    agent: ActiveManagedAgent;
    event: Extract<AgentStreamEvent, { type: "permission_resolved" }>;
    options: { fromHistory?: boolean } | undefined;
    flags: StreamEventFlags;
  }): void {
    const { agent, event, options, flags } = params;
    agent.pendingPermissions.delete(event.requestId);
    if (!options?.fromHistory && agent.inFlightPermissionResponses.has(event.requestId)) {
      agent.bufferedPermissionResolutions.set(event.requestId, event);
      flags.shouldDispatchEvent = false;
      return;
    }
    this.emitState(agent);
  }

  private resolvePendingPermissionsForAgent(
    agent: ActiveManagedAgent,
    provider: AgentProvider,
    options: { fromHistory?: boolean } | undefined,
    message: string,
  ): void {
    for (const [requestId] of agent.pendingPermissions) {
      agent.pendingPermissions.delete(requestId);
      if (!options?.fromHistory) {
        this.dispatchStream(agent.id, {
          type: "permission_resolved",
          provider,
          requestId,
          resolution: { behavior: "deny", message },
        });
      }
    }
  }

  private recordAndDispatchTimelineItem(
    agentId: string,
    item: AgentTimelineItem,
    provider: AgentProvider,
    turnId?: string,
  ): AgentStreamEvent {
    const row = this.recordTimeline(agentId, item);
    const event: AgentStreamEvent = {
      type: "timeline",
      item,
      provider,
      ...(turnId !== undefined ? { turnId } : {}),
    };
    this.dispatchStream(agentId, event, {
      seq: row.seq,
      epoch: this.timelineStore.getEpoch(agentId),
    });
    return event;
  }

  private async appendSystemErrorTimelineMessage(
    agent: ActiveManagedAgent,
    provider: AgentProvider,
    message: string,
    options?: {
      fromHistory?: boolean;
      canonicalUserMessagesById?: ReadonlyMap<string, string>;
    },
  ): Promise<void> {
    if (options?.fromHistory) {
      return;
    }

    const normalized = message.trim();
    if (!normalized) {
      return;
    }

    const text = `${SYSTEM_ERROR_PREFIX} ${normalized}`;
    const lastItem = await this.getLastItemFromStores(agent.id);
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
        epoch: this.timelineStore.getEpoch(agent.id),
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
    const row = this.timelineStore.append(agentId, item);
    this.enqueueDurableTimelineAppend(agentId, row);
    return row;
  }

  private emitState(agent: ManagedAgent, options?: { persist?: boolean }): void {
    // Keep attention as an edge-triggered unread signal, not a level signal.
    this.checkAndSetAttention(agent);
    if (options?.persist !== false) {
      this.enqueueBackgroundPersist(agent);
    }

    this.syncFeaturesFromSession(agent);

    this.dispatch({
      type: "agent_state",
      agent: { ...agent },
    });
  }

  private syncFeaturesFromSession(agent: ManagedAgent): void {
    if ("session" in agent && agent.session?.features) {
      agent.features = agent.session.features;
    }
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

  private enqueueDurableTimelineAppend(agentId: string, row: AgentTimelineRow): void {
    if (!this.durableTimelineStore) {
      return;
    }
    const task = this.durableTimelineStore
      .bulkInsert(agentId, [row])
      .then(() => undefined)
      .catch((err) => {
        this.logger.error(
          { err, agentId, seq: row.seq, itemType: row.item.type },
          "Failed to append timeline row to durable store",
        );
      });
    this.trackBackgroundTask(task);
  }

  private enqueueDurableTimelineBulkInsert(
    agentId: string,
    rows: readonly AgentTimelineRow[],
  ): void {
    if (!this.durableTimelineStore || rows.length === 0) {
      return;
    }
    const task = this.durableTimelineStore.bulkInsert(agentId, rows).catch((err) => {
      this.logger.error(
        { err, agentId, rowCount: rows.length },
        "Failed to seed durable timeline store",
      );
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
    this.agentStreamCoalescer.flushAll();
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
    metadata?: { seq?: number; epoch?: string },
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

  private async normalizeConfig(config: AgentSessionConfig): Promise<AgentSessionConfig> {
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
          throw new Error(`Working directory does not exist: ${normalized.cwd}`, { cause: error });
        }
        if (error instanceof Error) {
          throw error;
        }
        throw new Error(`Failed to access working directory: ${normalized.cwd}`, { cause: error });
      }
    }

    if (typeof normalized.model === "string") {
      const trimmed = normalized.model.trim();
      normalized.model = trimmed.length > 0 && trimmed !== "default" ? trimmed : undefined;
    }

    if (!normalized.model) {
      const client = this.clients.get(normalized.provider);
      if (client) {
        try {
          const models = await client.listModels({ cwd: normalized.cwd, force: false });
          const defaultModel = models.find((model) => model.isDefault) ?? models[0];
          if (defaultModel) {
            normalized.model = defaultModel.id;
          }
        } catch {
          // Provider may not support model listing — leave model undefined
        }
      }
    }

    if (!normalized.modeId) {
      try {
        normalized.modeId =
          getAgentProviderDefinition(normalized.provider).defaultModeId ?? undefined;
      } catch {
        // Unknown provider
      }
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

  private async requireAvailableClient(options: { provider: AgentProvider }): Promise<AgentClient> {
    const client = this.clients.get(options.provider);
    if (!client) {
      const configuredProviders = this.getConfiguredProviderIds();
      throw new Error(
        `Unknown provider '${options.provider}'. Configured providers: ${formatProviderList(
          configuredProviders,
        )}.`,
      );
    }

    let unavailableReason: string | null = null;
    try {
      const available = await client.isAvailable();
      if (available) {
        return client;
      }
    } catch (error) {
      unavailableReason = error instanceof Error ? error.message : String(error);
    }

    const availableProviders = (await this.listProviderAvailability())
      .filter((entry) => entry.available)
      .map((entry) => entry.provider);
    const providerList = formatProviderList(availableProviders);
    const reason = unavailableReason ? ` Reason: ${unavailableReason}.` : "";
    throw new Error(
      `Provider '${options.provider}' is not available.${reason} Available providers: ${providerList}. Use one of those providers, or install/configure '${options.provider}'.`,
    );
  }

  private requireEnabledProvider(provider: AgentProvider): void {
    if (this.providerEnabled.get(provider) === false) {
      throw new Error(`Provider '${provider}' is disabled`);
    }
  }

  private getConfiguredProviderIds(): AgentProvider[] {
    return Array.from(new Set([...this.providerEnabled.keys(), ...this.clients.keys()]));
  }

  private requireClient(provider: AgentProvider): AgentClient {
    const client = this.clients.get(provider);
    if (!client) {
      throw new Error(`No client registered for provider '${provider}'`);
    }
    return client;
  }

  private requireAgent(id: string): LiveManagedAgent {
    const normalizedId = validateAgentId(id, "requireAgent");
    const agent = this.agents.get(normalizedId);
    if (!agent) {
      throw new Error(`Unknown agent '${normalizedId}'`);
    }
    return agent;
  }

  private requireSessionAgent(id: string): ActiveManagedAgent {
    const agent = this.requireAgent(id);
    if (agent.session === null) {
      throw new Error(`Agent '${agent.id}' has no managed session`);
    }
    return agent;
  }
}
