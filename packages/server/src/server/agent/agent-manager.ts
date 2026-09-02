import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import {
  AGENT_LIFECYCLE_STATUSES,
  type AgentLifecycleStatus,
} from "@getpaseo/protocol/agent-lifecycle";
import {
  getParentAgentIdFromLabels,
  hasOpenAgentTab,
  isDelegatedAgent,
  isOpenAgentTabLabel,
  PARENT_AGENT_ID_LABEL,
} from "@getpaseo/protocol/agent-labels";
import type { Logger } from "pino";
import type { ProviderOptions, ToolPolicy } from "@getpaseo/protocol/agent-types";
import { z } from "zod";
import type { TerminalManager } from "../../terminal/terminal-manager.js";

import {
  getAgentStreamEventTurnId,
  type AgentCapabilityFlags,
  type AgentClient,
  type AgentCreateSessionOptions,
  type AgentResumeSessionOptions,
  type AgentFeature,
  type AgentLaunchContext,
  type AgentSlashCommand,
  type AgentMode,
  type AgentPermissionRequest,
  type AgentPermissionResponse,
  type AgentPermissionResult,
  type AgentPersistenceHandle,
  type AgentProviderNotice,
  type AgentPromptInput,
  type AgentProvider,
  type AgentRunOptions,
  type AgentSteerOptions,
  type AgentRunResult,
  type AgentSession,
  type AgentSessionConfig,
  type SteerResult,
  type AgentStreamEvent,
  type AgentTimelineItem,
  type AgentUsage,
  type AgentRuntimeInfo,
  type ImportedTimelineEntry,
  type ImportableProviderSession,
  type ListImportableSessionsOptions,
} from "./agent-sdk-types.js";
import { buildArchivedAgentRecord, type ArchivedStoredAgentRecord } from "./agent-archive.js";
import type { StoredAgentRecord, AgentStorage } from "./agent-storage.js";
import type { AgentOwner } from "./agent-owner.js";
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
  type AgentStreamCoalescerFlush,
} from "./agent-stream-coalescer.js";
import { limitAgentTimelineItemContent } from "./agent-timeline-content.js";
import {
  AgentRunState,
  type ForegroundTurnWaiter,
  type PendingAgentSessionEvent,
  type PendingForegroundRun,
} from "./agent-run-state.js";
import { invokeRewindCapability, type RewindMode } from "./rewind/rewind.js";
import { isSystemInjectedEnvelope } from "./agent-prompt.js";
import { stripInternalPaseoMcpServer, withRuntimePaseoMcpServer } from "./runtime-mcp-config.js";
import { resolveCreateAgentTitles } from "./create-agent-title.js";
import type { PaseoToolCatalogFactory } from "./tools/types.js";
import {
  ProviderSubagentStore,
  type ProviderSubagentDescriptor,
  type ProviderSubagentStoreEvent,
} from "./provider-subagents/store.js";
import { TurnStartCanceledError } from "./turn-cancellation-gate.js";

const RELOAD_SESSION_CLOSE_TIMEOUT_MS = 3_000;
const INTERRUPT_SESSION_TIMEOUT_MS = 2_000;
const DURABLE_TIMELINE_MUTATION_TIMEOUT_MS = 3_000;
const STORED_AGENT_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: false,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: true,
  supportsRewindConversation: false,
  supportsRewindFiles: false,
  supportsRewindBoth: false,
};

type TimeoutResult = "completed" | "timed_out";

function submittedPromptText(prompt: AgentPromptInput): string {
  if (typeof prompt === "string") {
    return prompt;
  }
  return prompt
    .flatMap((block) => (block.type === "text" && !("mimeType" in block) ? [block.text] : []))
    .join("\n")
    .trim();
}

export class AgentManagerShuttingDownError extends Error {
  constructor() {
    super("Agent manager is shutting down");
    this.name = "AgentManagerShuttingDownError";
  }
}

export class AgentRunCancellationError extends Error {
  constructor(agentId: string, action: "reload" | "replace" | "rewind" | "stop") {
    super(
      `Cannot ${action} agent ${agentId} because its active run cancellation was not acknowledged`,
    );
    this.name = "AgentRunCancellationError";
  }
}

export type DurableTimelineMutationErrorCode =
  | "DURABLE_TIMELINE_MUTATION_FAILED"
  | "DURABLE_TIMELINE_MUTATION_TIMEOUT";

export class DurableTimelineMutationError extends Error {
  readonly code: DurableTimelineMutationErrorCode;
  readonly agentId: string;
  readonly operation: string;

  constructor(params: {
    code: DurableTimelineMutationErrorCode;
    agentId: string;
    operation: string;
    timeoutMs?: number;
    cause?: unknown;
  }) {
    const message =
      params.code === "DURABLE_TIMELINE_MUTATION_TIMEOUT"
        ? `Durable timeline ${params.operation} for agent ${params.agentId} timed out after ${params.timeoutMs}ms`
        : `Durable timeline ${params.operation} for agent ${params.agentId} failed`;
    super(message, params.cause === undefined ? undefined : { cause: params.cause });
    this.name = "DurableTimelineMutationError";
    this.code = params.code;
    this.agentId = params.agentId;
    this.operation = params.operation;
  }
}

export type AgentRunCancellationResult =
  | { status: "not_running" }
  | { status: "settled" }
  | { status: "stale_turn" }
  | { status: "refused" };

interface PreparedSessionConfig {
  storedConfig: AgentSessionConfig;
  launchConfig: AgentSessionConfig;
}

interface NormalizeConfigOptions {
  resolveDefaultModel?: boolean;
  env?: Record<string, string>;
}

interface TimeoutOptions {
  operation: Promise<void>;
  timeoutMs: number;
  onLateError?: (error: unknown) => void;
}

function formatProviderList(providers: readonly string[]): string {
  return providers.length > 0 ? providers.join(", ") : "none";
}

function buildStoredAgentConfig(record: StoredAgentRecord): AgentSessionConfig {
  const config: AgentSessionConfig = {
    provider: record.provider,
    cwd: record.cwd,
  };
  if (!record.config) {
    return config;
  }
  if (record.config.modeId != null) config.modeId = record.config.modeId;
  if (record.config.model != null) config.model = record.config.model;
  if (record.config.thinkingOptionId != null) {
    config.thinkingOptionId = record.config.thinkingOptionId;
  }
  if (record.config.featureValues != null) {
    config.featureValues = record.config.featureValues;
  }
  if (record.config.providerOptions != null) {
    config.providerOptions = record.config.providerOptions;
  }
  if (record.config.toolPolicy != null) config.toolPolicy = record.config.toolPolicy;
  if (record.config.systemPrompt != null) {
    config.systemPrompt = record.config.systemPrompt;
  }
  if (record.config.mcpServers != null) config.mcpServers = record.config.mcpServers;
  return stripInternalPaseoMcpServer(config);
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
  | { type: "provider_subagent"; event: ProviderSubagentStoreEvent }
  | { type: "timeline_replacement"; agentId: string; epoch: string }
  | {
      type: "agent_stream";
      agentId: string;
      event: AgentStreamEvent;
      seq?: number;
      epoch?: string;
      timestamp?: string;
    };

export type AgentSubscriber = (event: AgentManagerEvent) => void;

export interface SubscribeOptions {
  agentId?: string;
  replayState?: boolean;
}

interface HydrateTimelineOptions {
  force?: boolean;
  broadcast?: boolean | (() => boolean);
  broadcastTimeline?: boolean;
  turnToken?: string;
}

export type ImportablePersistedAgentQueryOptions = ListImportableSessionsOptions & {
  /**
   * When set, only providers in this set are scanned, in addition to the
   * built-in importable allowlist + enabled + non-derived rules.
   */
  providerFilter?: Set<string>;
};

export interface ManagedImportableProviderSession extends ImportableProviderSession {
  provider: AgentProvider;
}

export type AgentAttentionCallback = (params: {
  agentId: string;
  provider: AgentProvider;
  reason: "finished" | "error" | "permission";
}) => void;

export type AgentArchivedCallback = (agentId: string) => Promise<void> | void;

export interface ProviderAvailability {
  provider: AgentProvider;
  available: boolean;
  error: string | null;
}

interface AgentManagerRescueTimeouts {
  reloadSessionCloseMs?: number;
  interruptSessionMs?: number;
  durableTimelineMutationMs?: number;
}

function resolveRescueTimeouts(
  options: AgentManagerRescueTimeouts | undefined,
): Required<AgentManagerRescueTimeouts> {
  return {
    reloadSessionCloseMs: options?.reloadSessionCloseMs ?? RELOAD_SESSION_CLOSE_TIMEOUT_MS,
    interruptSessionMs: options?.interruptSessionMs ?? INTERRUPT_SESSION_TIMEOUT_MS,
    durableTimelineMutationMs:
      options?.durableTimelineMutationMs ?? DURABLE_TIMELINE_MUTATION_TIMEOUT_MS,
  };
}

interface ProviderEnabledFlag {
  enabled: boolean;
  derivedFromProviderId?: string | null;
  validateOptions?: (options: ProviderOptions | undefined) => ProviderOptions | undefined;
  applyOptions?: (
    config: AgentSessionConfig,
    options: ProviderOptions | undefined,
  ) => AgentSessionConfig;
  applyToolPolicy?: (
    config: AgentSessionConfig,
    toolPolicy: ToolPolicy | undefined,
  ) => AgentSessionConfig;
}
type ProviderEnabledMap = Partial<Record<AgentProvider, ProviderEnabledFlag>>;
type ProviderClientMap = Partial<Record<AgentProvider, AgentClient>>;

export interface CreateAgentOptions {
  labels?: Record<string, string>;
  initialPrompt?: string;
  env?: Record<string, string>;
  persistSession?: boolean;
  initialTitle?: string | null;
  // undefined is an explicit decision: the agent never appears in the sidebar.
  workspaceId: string | undefined;
  owner?: AgentOwner;
}

export interface AgentManagerOptions {
  clients?: ProviderClientMap;
  providerDefinitions?: ProviderEnabledMap;
  idFactory?: () => string;
  registry?: AgentStorage;
  onAgentAttention?: AgentAttentionCallback;
  onWorkspaceStateMayHaveChanged?: (params: { cwd: string }) => void;
  durableTimelineStore?: AgentTimelineStore;
  terminalManager?: TerminalManager | null;
  mcpBaseUrl?: string;
  mcpAuthToken?: string;
  paseoToolsEnabled?: boolean;
  paseoToolCatalogFactory?: PaseoToolCatalogFactory;
  appendSystemPrompt?: string;
  agentStreamCoalesceWindowMs?: number;
  rescueTimeouts?: AgentManagerRescueTimeouts;
  beforeSteerUnavailableFallback?: (input: {
    agentId: string;
    expectedTurnId: string;
  }) => Promise<void>;
  logger: Logger;
}

export type ActiveTurnSteerDispatchResult =
  | { status: "inactive" | "steered" }
  | { status: "replaced"; iterator: AsyncGenerator<AgentStreamEvent> };

function stripSteerOptions(options?: AgentSteerOptions): AgentRunOptions | undefined {
  if (!options) return undefined;
  const { clearPendingPermissions: _, ...runOptions } = options;
  return runOptions;
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

type ActiveTurnTerminalDisposition = "closed_current" | "stale" | "untracked";

interface HandleStreamEventOptions {
  fromHistory?: boolean;
  sessionGeneration?: symbol;
  turnToken?: string;
}

interface ManagedAgentBase {
  id: string;
  provider: AgentProvider;
  cwd: string;
  /**
   * Workspace this agent belongs to, stamped at creation. Independent of cwd:
   * cwd answers "where does it run", workspaceId answers "which workspace owns it".
   * Null/undefined for legacy agents created before ownership stamping.
   */
  workspaceId?: string;
  owner?: AgentOwner;
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
  activeTurnId: string | null;
  activeTurnStartedAt: Date | null;
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
  subscriptionCount: number;
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
type AgentLabelPatch = Record<string, string | null>;

function attachManagedTurnIdentity(
  agent: ActiveManagedAgent,
  event: AgentStreamEvent,
  fromHistory: boolean,
): { event: AgentStreamEvent; turnId: string | undefined } {
  const existingTurnId = getAgentStreamEventTurnId(event);
  if (fromHistory || existingTurnId !== undefined) {
    return { event, turnId: existingTurnId };
  }
  switch (event.type) {
    case "turn_started": {
      const turnId =
        agent.activeForegroundTurnId ?? agent.activeTurnId ?? `autonomous-${randomUUID()}`;
      return { event: { ...event, turnId }, turnId };
    }
    case "turn_completed":
    case "turn_failed":
    case "turn_canceled": {
      const turnId = agent.activeForegroundTurnId ?? agent.activeTurnId ?? undefined;
      return turnId ? { event: { ...event, turnId }, turnId } : { event, turnId };
    }
    case "timeline": {
      // Live provider items belong to the foreground turn that owns their dispatch.
      // Provider history deliberately keeps absent IDs because it has no daemon turn identity.
      const turnId = agent.activeForegroundTurnId ?? agent.activeTurnId ?? undefined;
      return turnId ? { event: { ...event, turnId }, turnId } : { event, turnId };
    }
    default:
      return { event, turnId: undefined };
  }
}

function limitAgentStreamEventContent(event: AgentStreamEvent): AgentStreamEvent {
  return event.type === "timeline"
    ? { ...event, item: limitAgentTimelineItemContent(event.item) }
    : event;
}

interface WriteLabelsResult {
  record: StoredAgentRecord | null;
  live: boolean;
}

interface AgentMetadataPatch {
  title?: string;
  labels?: AgentLabelPatch;
}

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

interface SteerEventBarrier {
  events: PendingAgentSessionEvent[];
}

interface SubmittedPromptRecord {
  row: AgentTimelineRow;
  inserted: boolean;
}

interface DurableTimelineMutationOptions {
  operation?: string;
  pendingRun?: PendingForegroundRun;
  onTimeout?: () => void;
}

const BUSY_STATUSES: Set<AgentLifecycleStatus> = new Set(["initializing", "running"]);
const AgentIdSchema = z.guid();

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

function applyLabelPatch(
  labels: Record<string, string>,
  patch: AgentLabelPatch,
): Record<string, string> {
  const nextLabels = { ...labels };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete nextLabels[key];
    } else {
      nextLabels[key] = value;
    }
  }
  return nextLabels;
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

function buildImportedTimelineRows(entries: readonly ImportedTimelineEntry[]): AgentTimelineRow[] {
  const rows: AgentTimelineRow[] = [];
  for (const entry of entries) {
    if (entry.item.type === "user_message" && isSystemInjectedEnvelope(entry.item.text)) {
      continue;
    }
    rows.push({
      seq: rows.length + 1,
      timestamp: entry.timestamp ?? new Date().toISOString(),
      item: limitAgentTimelineItemContent(entry.item),
    });
  }
  return rows;
}

function resolveImportedAgentTitle(
  config: AgentSessionConfig,
  timelineRows: readonly AgentTimelineRow[],
): string | null {
  const initialPrompt = getFirstUserMessageTextFromRows(timelineRows);
  if (!initialPrompt) {
    return null;
  }
  const { explicitTitle, provisionalTitle } = resolveCreateAgentTitles({
    configTitle: config.title,
    initialPrompt,
  });
  return explicitTitle ?? provisionalTitle ?? null;
}

function getFirstUserMessageTextFromRows(rows: readonly AgentTimelineRow[]): string | null {
  for (const row of rows) {
    const item = row.item;
    if (item.type !== "user_message") {
      continue;
    }
    const text = item.text.trim();
    if (text) {
      return text;
    }
  }
  return null;
}

function shouldDetachFromArchivedParent(
  parent: StoredAgentRecord,
  child: StoredAgentRecord,
): boolean {
  const isCrossWorkspace =
    parent.workspaceId !== undefined &&
    child.workspaceId !== undefined &&
    parent.workspaceId !== child.workspaceId;
  return isCrossWorkspace || hasOpenAgentTab(child.labels);
}

function detachedAgentLabelPatch(labels: Record<string, string>): AgentLabelPatch {
  const patch: AgentLabelPatch = { [PARENT_AGENT_ID_LABEL]: null };
  for (const label of Object.keys(labels)) {
    if (isOpenAgentTabLabel(label)) {
      patch[label] = null;
    }
  }
  return patch;
}

export class AgentManager {
  private readonly clients = new Map<AgentProvider, AgentClient>();
  private readonly providerEnabled = new Map<AgentProvider, boolean>();
  private readonly providerDefinitions = new Map<AgentProvider, ProviderEnabledFlag>();
  private readonly agents = new Map<string, LiveManagedAgent>();
  private readonly timelineStore = new InMemoryAgentTimelineStore();
  private readonly providerSubagents = new ProviderSubagentStore();
  private readonly agentsAwaitingInitialSnapshotPersist = new Set<string>();
  private readonly sessionEventTails = new Map<string, Promise<void>>();
  private readonly sessionGenerationTokens = new Map<string, symbol>();
  /** Latest manager-owned turn token. It survives terminal settlement so detached refreshes can
   * still prove that no newer same-session turn has started. */
  private readonly latestTurnTokens = new Map<string, string>();
  private readonly turnTokensById = new Map<string, Map<string, string>>();
  private readonly steerEventBarriers = new Map<string, SteerEventBarrier>();
  private readonly foregroundMutationTails = new Map<string, Promise<void>>();
  private readonly runs = new AgentRunState();
  private readonly subscribers = new Set<SubscriptionRecord>();
  private readonly idFactory: () => string;
  private readonly registry?: AgentStorage;
  private readonly durableTimelineStore?: AgentTimelineStore;
  private readonly durableTimelineMutationTails = new Map<string, Promise<void>>();
  private readonly coalescedTimelineTails = new Map<string, Promise<void>>();
  private readonly previousStatuses = new Map<string, AgentLifecycleStatus>();
  private readonly backgroundTasks = new Set<Promise<void>>();
  private readonly agentRegistrationTasks = new Set<Promise<void>>();
  private readonly inFlightAgentCloses = new Map<string, Promise<void>>();
  private readonly quarantinedAgentIds = new Set<string>();
  private readonly lifecycleMutationTails = new Map<string, Promise<void>>();
  private readonly agentStreamCoalescer: AgentStreamCoalescer;
  private mcpBaseUrl: string | null;
  private readonly mcpAuthToken: string | null;
  private paseoToolsEnabled = true;
  private paseoToolCatalogFactory: PaseoToolCatalogFactory | null = null;
  private appendSystemPrompt: string;
  private onAgentAttention?: AgentAttentionCallback;
  private onAgentArchived?: AgentArchivedCallback;
  private onWorkspaceStateMayHaveChanged?: (params: { cwd: string }) => void;
  private logger: Logger;
  private readonly rescueTimeouts: Required<AgentManagerRescueTimeouts>;
  private readonly beforeSteerUnavailableFallback?: AgentManagerOptions["beforeSteerUnavailableFallback"];
  private acceptingAgentRegistrations = true;

  constructor(options: AgentManagerOptions) {
    this.idFactory = options?.idFactory ?? (() => randomUUID());
    this.registry = options?.registry;
    this.durableTimelineStore = options?.durableTimelineStore;
    this.onAgentAttention = options?.onAgentAttention;
    this.onWorkspaceStateMayHaveChanged = options?.onWorkspaceStateMayHaveChanged;
    this.mcpBaseUrl = options?.mcpBaseUrl ?? null;
    this.mcpAuthToken = options?.mcpAuthToken ?? null;
    this.configurePaseoTools(options);
    this.appendSystemPrompt = options.appendSystemPrompt ?? "";
    this.logger = options.logger.child({ module: "agent", component: "agent-manager" });
    this.rescueTimeouts = resolveRescueTimeouts(options.rescueTimeouts);
    this.beforeSteerUnavailableFallback = options.beforeSteerUnavailableFallback;
    this.agentStreamCoalescer = new AgentStreamCoalescer({
      windowMs: options.agentStreamCoalesceWindowMs ?? AGENT_STREAM_COALESCE_DEFAULT_WINDOW_MS,
      timers: { setTimeout, clearTimeout },
      onFlush: ({ agentId, item, provider, turnId, turnToken, generation }) => {
        if (generation !== undefined && !this.isSessionGenerationCurrentById(agentId, generation)) {
          return;
        }
        if (turnToken !== undefined && !this.isLatestTurnTokenCurrent(agentId, turnToken)) {
          return;
        }
        this.enqueueCoalescedTimelineCommit({
          agentId,
          item,
          provider,
          ...(turnId !== undefined ? { turnId } : {}),
          ...(turnToken !== undefined ? { turnToken } : {}),
          ...(generation !== undefined ? { generation } : {}),
        });
      },
    });
    this.updateProviderRegistry({
      providerDefinitions: options.providerDefinitions ?? {},
      clients: options.clients ?? {},
    });
  }

  private configurePaseoTools(options: AgentManagerOptions): void {
    this.paseoToolsEnabled = options.paseoToolsEnabled ?? true;
    this.paseoToolCatalogFactory = options.paseoToolCatalogFactory ?? null;
  }

  registerClient(provider: AgentProvider, client: AgentClient): void {
    this.clients.set(provider, client);
  }

  updateProviderRegistry(input: {
    providerDefinitions: ProviderEnabledMap;
    clients: ProviderClientMap;
  }): void {
    this.providerEnabled.clear();
    this.providerDefinitions.clear();
    for (const [provider, definition] of Object.entries(input.providerDefinitions)) {
      if (definition) {
        this.providerEnabled.set(provider, definition.enabled);
        this.providerDefinitions.set(provider, definition);
      }
    }

    this.clients.clear();
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

  setAgentArchivedCallback(callback: AgentArchivedCallback): void {
    this.onAgentArchived = callback;
  }

  setMcpBaseUrl(url: string | null): void {
    this.mcpBaseUrl = url;
  }

  prepareForShutdown(): void {
    this.acceptingAgentRegistrations = false;
  }

  setPaseoToolsEnabled(enabled: boolean): void {
    this.paseoToolsEnabled = enabled;
  }

  setPaseoToolCatalogFactory(factory: PaseoToolCatalogFactory | null): void {
    this.paseoToolCatalogFactory = factory;
  }

  /**
   * Capability token the daemon's own MCP clients must present to the Agent MCP
   * endpoint when a daemon password is configured. Read by the per-client
   * session to authenticate its own MCP connection. Stays in the daemon — never
   * sent to remote clients.
   */
  getMcpAuthToken(): string | null {
    return this.mcpAuthToken;
  }

  setAppendSystemPrompt(prompt: string | null | undefined): void {
    this.appendSystemPrompt = prompt ?? "";
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
      subscriptionCount: this.subscribers.size,
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

  private nextStoredUpdatedAt(record: StoredAgentRecord): string {
    const previousMs = Date.parse(record.updatedAt);
    const nowMs = Date.now();
    const nextMs = nowMs > previousMs ? nowMs : previousMs + 1;
    return new Date(nextMs).toISOString();
  }

  hasInFlightRun(agentId: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return false;
    }

    return (
      agent.lifecycle === "running" ||
      Boolean(agent.activeForegroundTurnId) ||
      this.runs.hasRun(agentId)
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

  subscriptionCount(): number {
    return this.subscribers.size;
  }

  listAgents(): ManagedAgent[] {
    return Array.from(this.agents.values())
      .filter((agent) => !agent.internal)
      .map((agent) => Object.assign({}, agent));
  }

  async listImportableSessions(
    options?: ImportablePersistedAgentQueryOptions,
  ): Promise<ManagedImportableProviderSession[]> {
    const providerEntries = Array.from(this.clients.entries()).filter(
      ([provider, client]) =>
        client.capabilities.supportsSessionListing &&
        !!client.listImportableSessions &&
        this.isProviderImportable(provider, options?.providerFilter),
    );
    const sessionLists = await Promise.all(
      providerEntries.map(async ([provider, client]) => {
        try {
          return (
            await client.listImportableSessions!({
              limit: options?.limit,
              cwd: options?.cwd,
            })
          ).map((session) => Object.assign(session, { provider }));
        } catch (error) {
          this.logger.warn(
            { err: error, provider },
            "Failed to list importable sessions for provider",
          );
          return [];
        }
      }),
    );
    const sessions: ManagedImportableProviderSession[] = sessionLists.flat();

    const limit = options?.limit ?? 20;
    return sessions
      .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime())
      .slice(0, limit);
  }

  private isProviderImportable(
    provider: AgentProvider,
    providerFilter: Set<string> | undefined,
  ): boolean {
    if (this.providerEnabled.get(provider) === false) {
      return false;
    }
    if (providerFilter && !providerFilter.has(provider)) {
      return false;
    }
    return true;
  }

  async listProviderAvailability(): Promise<ProviderAvailability[]> {
    return Promise.all(
      Array.from(this.clients.keys()).map((provider) => this.getProviderAvailability(provider)),
    );
  }

  async getProviderAvailability(provider: AgentProvider): Promise<ProviderAvailability> {
    const client = this.clients.get(provider);
    if (!client) {
      return {
        provider,
        available: false,
        error: `No client registered for provider '${provider}'`,
      };
    }

    try {
      const available = await client.isAvailable();
      return {
        provider,
        available,
        error: null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({ err: error, provider }, "Failed to check provider availability");
      return {
        provider,
        available: false,
        error: message,
      };
    }
  }

  async listDraftCommands(config: AgentSessionConfig): Promise<AgentSlashCommand[]> {
    const normalizedConfig = await this.normalizeConfig(config, { resolveDefaultModel: false });
    const client = this.requireClient(normalizedConfig.provider);
    if (!normalizedConfig.model) {
      return [];
    }
    const available = await client.isAvailable();
    if (!available) {
      throw new Error(
        `Provider '${normalizedConfig.provider}' is not available. Please ensure the CLI is installed.`,
      );
    }

    if (client.listCommands) {
      return await client.listCommands(normalizedConfig);
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
    const normalizedConfig = await this.normalizeConfig(config, { resolveDefaultModel: false });
    const client = this.requireClient(normalizedConfig.provider);
    if (!normalizedConfig.model && !client.listFeatures) {
      return [];
    }
    const available = await client.isAvailable();
    if (!available) {
      throw new Error(
        `Provider '${normalizedConfig.provider}' is not available. Please ensure the CLI is installed.`,
      );
    }

    if (client.listFeatures) {
      return await client.listFeatures(normalizedConfig);
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

  async waitForAgentClose(agentId: string): Promise<void> {
    await this.inFlightAgentCloses?.get(agentId)?.catch(() => undefined);
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

  listProviderSubagents(parentAgentId: string): ProviderSubagentDescriptor[] {
    this.requirePublicAgent(parentAgentId);
    return this.providerSubagents.list(parentAgentId);
  }

  listProviderSubagentActivity(): ProviderSubagentDescriptor[] {
    const publicParentIds = new Set(
      Array.from(this.agents.values())
        .filter((agent) => !agent.internal)
        .map((agent) => agent.id),
    );
    return this.providerSubagents
      .listAll()
      .filter((subagent) => publicParentIds.has(subagent.parentAgentId));
  }

  getProviderSubagent(
    parentAgentId: string,
    subagentId: string,
  ): ProviderSubagentDescriptor | null {
    this.requirePublicAgent(parentAgentId);
    return this.providerSubagents.get(parentAgentId, subagentId);
  }

  fetchProviderSubagentTimeline(
    parentAgentId: string,
    subagentId: string,
    options?: AgentTimelineFetchOptions,
  ): AgentTimelineFetchResult {
    this.requirePublicAgent(parentAgentId);
    return this.providerSubagents.fetchTimeline(parentAgentId, subagentId, options);
  }

  createAgent(
    config: AgentSessionConfig,
    agentId: string | undefined,
    options: CreateAgentOptions,
  ): Promise<ManagedAgent> {
    return this.trackAgentRegistrationOperation(this.createAgentInternal(config, agentId, options));
  }

  private async createAgentInternal(
    config: AgentSessionConfig,
    agentId: string | undefined,
    options: CreateAgentOptions,
  ): Promise<ManagedAgent> {
    this.assertAcceptingAgentRegistrations();
    const resolvedAgentId = validateAgentId(agentId ?? this.idFactory(), "createAgent");
    await this.deleteAgentState(resolvedAgentId);
    const { storedConfig, launchConfig } = await this.prepareSessionConfig(
      config,
      resolvedAgentId,
      options?.env,
    );
    this.requireEnabledProvider(storedConfig.provider);
    const client = await this.requireAvailableClient({
      provider: storedConfig.provider,
    });
    const launchContext = await this.buildLaunchContext(
      resolvedAgentId,
      client,
      storedConfig.cwd,
      options?.env,
    );
    const providerLaunchConfig = this.resolveProviderLaunchConfig(launchConfig, launchContext);
    const createOptions = this.buildCreateSessionOptions(options);
    const session = await client.createSession(providerLaunchConfig, launchContext, createOptions);
    await this.requireExternalMcpSupport(session, storedConfig);
    return this.registerSession(session, storedConfig, resolvedAgentId, {
      labels: options.labels,
      initialTitle: options.initialTitle,
      workspaceId: options.workspaceId,
      owner: options.owner,
      historyPrimed: true,
    });
  }

  private buildCreateSessionOptions(options?: {
    persistSession?: boolean;
  }): AgentCreateSessionOptions | undefined {
    return options?.persistSession === undefined
      ? undefined
      : { persistSession: options.persistSession };
  }

  // Reconstruct an agent from provider persistence. Callers should explicitly
  // hydrate timeline history after resume.
  resumeAgentFromPersistence(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    agentId?: string,
    options?: {
      createdAt?: Date;
      updatedAt?: Date;
      lastUserMessageAt?: Date | null;
      labels?: Record<string, string>;
      workspaceId?: string;
      owner?: AgentOwner;
    },
    resumeOptions?: AgentResumeSessionOptions,
  ): Promise<ManagedAgent> {
    return this.trackAgentRegistrationOperation(
      this.resumeAgentFromPersistenceInternal(handle, overrides, agentId, options, resumeOptions),
    );
  }

  private async resumeAgentFromPersistenceInternal(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    agentId?: string,
    options?: {
      createdAt?: Date;
      updatedAt?: Date;
      lastUserMessageAt?: Date | null;
      labels?: Record<string, string>;
      workspaceId?: string;
      owner?: AgentOwner;
    },
    resumeOptions?: AgentResumeSessionOptions,
  ): Promise<ManagedAgent> {
    this.assertAcceptingAgentRegistrations();
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
    const { storedConfig, launchConfig } = await this.prepareSessionConfig(
      mergedConfig,
      resolvedAgentId,
    );

    const client = this.requireClient(handle.provider);
    const available = await client.isAvailable();
    if (!available) {
      throw new Error(
        `Provider '${handle.provider}' is not available. Please ensure the CLI is installed.`,
      );
    }
    const launchContext = await this.buildLaunchContext(resolvedAgentId, client, storedConfig.cwd);
    const providerLaunchConfig = this.resolveProviderLaunchConfig(launchConfig, launchContext);
    const session = await client.resumeSession(
      handle,
      providerLaunchConfig,
      launchContext,
      resumeOptions,
    );
    await this.requireExternalMcpSupport(session, storedConfig);
    return this.registerSession(session, storedConfig, resolvedAgentId, {
      ...options,
      persistence: handle,
    });
  }

  importProviderSession(input: {
    provider: AgentProvider;
    providerHandleId: string;
    cwd: string;
    workspaceId: string;
    labels?: Record<string, string>;
  }): Promise<ManagedAgent> {
    return this.trackAgentRegistrationOperation(this.importProviderSessionInternal(input));
  }

  private async importProviderSessionInternal(input: {
    provider: AgentProvider;
    providerHandleId: string;
    cwd: string;
    workspaceId: string;
    labels?: Record<string, string>;
  }): Promise<ManagedAgent> {
    this.assertAcceptingAgentRegistrations();
    const resolvedAgentId = validateAgentId(this.idFactory(), "importProviderSession");
    this.requireEnabledProvider(input.provider);

    const client = await this.requireAvailableClient({ provider: input.provider });
    if (!client.importSession) {
      throw new Error(`Provider '${input.provider}' does not support importing sessions`);
    }

    const { storedConfig, launchConfig } = await this.prepareSessionConfig(
      {
        provider: input.provider,
        cwd: input.cwd,
      },
      resolvedAgentId,
    );
    const launchContext = await this.buildLaunchContext(resolvedAgentId, client, storedConfig.cwd);
    const providerLaunchConfig = this.resolveProviderLaunchConfig(launchConfig, launchContext);
    const imported = await client.importSession(
      {
        providerHandleId: input.providerHandleId,
        cwd: input.cwd,
      },
      { config: providerLaunchConfig, storedConfig, launchContext },
    );
    let handedToRegistration = false;
    try {
      const importedConfig = await this.normalizeConfig(
        stripInternalPaseoMcpServer(imported.config),
      );
      const timelineRows = buildImportedTimelineRows(imported.timeline);
      const initialTitle = resolveImportedAgentTitle(importedConfig, timelineRows);

      handedToRegistration = true;
      const agent = await this.registerSession(imported.session, importedConfig, resolvedAgentId, {
        labels: input.labels,
        workspaceId: input.workspaceId,
        timelineRows,
        timelineNextSeq: timelineRows.length + 1,
        persistence: imported.persistence,
        historyPrimed: true,
        initialTitle,
        publishWhenReady: true,
      });
      for (const event of imported.providerSubagentEvents ?? []) {
        const update = this.providerSubagents.apply(agent.id, event.provider, event.event);
        this.dispatch({ type: "provider_subagent", event: update });
      }
      return agent;
    } finally {
      if (!handedToRegistration) {
        await this.closeUnregisteredSession(imported.session);
      }
    }
  }

  // Hot-reload an active agent session with config overrides. By default the
  // in-memory timeline is preserved (used for voice-mode toggles and similar
  // config swaps). When `rehydrateFromDisk` is set, the timeline is wiped so a
  // new epoch is minted and provider history is re-streamed — this is what the
  // user-facing "Reload agent" action wants when the on-disk session was
  // mutated outside Paseo.
  reloadAgentSession(
    agentId: string,
    overrides?: Partial<AgentSessionConfig>,
    options?: { rehydrateFromDisk?: boolean },
  ): Promise<ManagedAgent> {
    return this.trackAgentRegistrationOperation(
      this.reloadAgentSessionInternal(agentId, overrides, options),
    );
  }

  private async reloadAgentSessionInternal(
    agentId: string,
    overrides?: Partial<AgentSessionConfig>,
    options?: { rehydrateFromDisk?: boolean },
  ): Promise<ManagedAgent> {
    this.assertAcceptingAgentRegistrations();
    let existing = this.requireSessionAgent(agentId);
    if (this.hasInFlightRun(agentId) && !this.quarantinedAgentIds.has(agentId)) {
      await this.cancelAgentRunBefore(agentId, "reload");
      existing = this.requireSessionAgent(agentId);
    }
    const wasQuarantined = this.quarantinedAgentIds.has(agentId);
    // Stop the old generation before reading anything to preserve. Detached provider work can
    // still be awaiting native I/O; it must not get a chance to write into the replacement.
    this.fenceSessionGeneration(existing, { settlePendingStart: true });
    await this.drainSessionEvents(agentId);
    await this.drainCoalescedTimeline(agentId);
    await this.drainDurableTimelineMutations(agentId);
    const rehydrateFromDisk = options?.rehydrateFromDisk ?? false;
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
    const { storedConfig, launchConfig } = await this.prepareSessionConfig(refreshConfig, agentId);
    const launchContext = await this.buildLaunchContext(agentId, client, storedConfig.cwd);
    const providerLaunchConfig = this.resolveProviderLaunchConfig(launchConfig, launchContext);

    let existingSessionClosed = false;
    if (wasQuarantined) {
      this.cancelRunningProviderSubagents(agentId);
      if (existing.unsubscribeSession) {
        existing.unsubscribeSession();
        existing.unsubscribeSession = null;
      }
      existingSessionClosed = await this.closeReloadedSession(existing.session, agentId);
    }

    // A quarantined provider session may still own the canceled turn even after close timed out.
    // Never resume its native handle: a fresh provider session is the only safe replacement.
    let session: AgentSession;
    if (wasQuarantined || !handle) {
      session = await client.createSession(providerLaunchConfig, launchContext);
    } else {
      session = await client.resumeSession(handle, providerLaunchConfig, launchContext);
    }
    await this.requireExternalMcpSupport(session, storedConfig);

    let handedToRegistration = false;
    try {
      this.assertAcceptingAgentRegistrations();

      this.cancelRunningProviderSubagents(agentId);
      await this.drainSessionEvents(agentId);
      const closedExisting = this.prepareAgentForClosure(existing, "agent reloaded");
      try {
        await this.persistSnapshot(closedExisting);
      } finally {
        if (!existingSessionClosed) {
          await this.closeReloadedSession(existing.session, agentId);
        }
      }

      if (rehydrateFromDisk) {
        // Wipe the in-memory timeline so registerSession mints a new epoch and
        // hydrateTimelineFromProvider re-streams the freshly read provider history.
        this.timelineStore.delete(agentId);
        for (const event of this.providerSubagents.deleteParent(agentId)) {
          this.dispatch({ type: "provider_subagent", event });
        }
      }

      // Preserve existing labels and timeline during reload.
      handedToRegistration = true;
      return this.registerSession(session, storedConfig, agentId, {
        labels: existing.labels,
        workspaceId: existing.workspaceId,
        owner: existing.owner,
        createdAt: existing.createdAt,
        updatedAt: existing.updatedAt,
        lastUserMessageAt: existing.lastUserMessageAt,
        historyPrimed: rehydrateFromDisk ? false : preservedHistoryPrimed,
        lastUsage: preservedLastUsage,
        lastError: preservedLastError,
        attention: preservedAttention,
      });
    } finally {
      if (!handedToRegistration) {
        await this.closeUnregisteredSession(session);
      }
    }
  }

  private async closeReloadedSession(session: AgentSession, agentId: string): Promise<boolean> {
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
        return false;
      }
      return true;
    } catch (error) {
      this.logger.warn({ err: error, agentId }, "Failed to close previous session during refresh");
      return false;
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

  closeAgent(agentId: string): Promise<void> {
    const existing = this.inFlightAgentCloses.get(agentId);
    if (existing) {
      return existing;
    }

    const close = this.closeAgentRuntime(agentId);
    this.inFlightAgentCloses.set(agentId, close);
    const clearClose = () => {
      if (this.inFlightAgentCloses.get(agentId) === close) {
        this.inFlightAgentCloses.delete(agentId);
      }
    };
    void close.then(clearClose, clearClose);
    return close;
  }

  private async closeAgentRuntime(agentId: string): Promise<void> {
    const agent = this.requireAgent(agentId);
    this.logger.trace(
      {
        agentId,
        provider: agent.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId: agent.activeForegroundTurnId ?? undefined,
        lifecycle: agent.lifecycle,
        activeForegroundTurnId: agent.activeForegroundTurnId,
        pendingPermissions: agent.pendingPermissions.size,
      },
      "agent.manager.close.start",
    );
    const closedAgent = this.prepareAgentForClosure(agent, "agent closed");
    // Fence the generation before draining any asynchronous queue. Retired callbacks may finish
    // their durable I/O, but they can no longer publish or mutate the retired in-memory session.
    this.cancelRunningProviderSubagents(agentId);
    await this.drainSessionEvents(agentId);
    await this.drainCoalescedTimeline(agentId);
    await this.drainDurableTimelineMutations(agentId);
    let closeError: unknown;
    try {
      const result = await this.waitWithTimeout({
        operation: agent.session.close(),
        timeoutMs: this.rescueTimeouts.reloadSessionCloseMs,
        onLateError: (error) => {
          this.logger.warn(
            { err: error, agentId },
            "Closed agent session failed after close timeout",
          );
        },
      });
      if (result === "timed_out") {
        this.logger.warn(
          { agentId, timeoutMs: this.rescueTimeouts.reloadSessionCloseMs },
          "Timed out closing agent session",
        );
      }
    } catch (error) {
      closeError = error;
    }

    let persistError: unknown;
    try {
      const result = await this.waitWithTimeout({
        operation: this.persistSnapshot(closedAgent),
        timeoutMs: this.rescueTimeouts.durableTimelineMutationMs,
        onLateError: (error) => {
          this.logger.warn(
            { err: error, agentId },
            "Closed agent snapshot failed after close timeout",
          );
        },
      });
      if (result === "timed_out") {
        this.logger.warn(
          { agentId, timeoutMs: this.rescueTimeouts.durableTimelineMutationMs },
          "Timed out persisting closed agent snapshot",
        );
      }
    } catch (error) {
      persistError = error;
    }
    this.emitClosedAgent(closedAgent, { persist: false });
    this.logger.trace(
      {
        agentId,
        provider: closedAgent.provider,
        sessionId: closedAgent.persistence?.sessionId ?? undefined,
      },
      "agent.manager.close.complete",
    );

    if (closeError !== undefined) {
      throw closeError;
    }
    if (persistError !== undefined) {
      throw persistError;
    }
  }

  private cancelRunningProviderSubagents(parentAgentId: string): void {
    for (const subagent of this.providerSubagents.list(parentAgentId)) {
      if (subagent.status !== "running") {
        continue;
      }
      const event = this.providerSubagents.apply(parentAgentId, subagent.provider, {
        type: "upsert",
        id: subagent.id,
        status: "canceled",
      });
      this.dispatch({ type: "provider_subagent", event });
    }
  }

  async archiveAgent(agentId: string): Promise<{ archivedAt: string }> {
    return this.runLifecycleMutation(agentId, () => this.archiveAgentUnlocked(agentId));
  }

  private async archiveAgentUnlocked(agentId: string): Promise<{ archivedAt: string }> {
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

    const { archivedAt } = await this.markRecordArchived(stored);
    agent.updatedAt = new Date(archivedAt);
    await this.closeAgent(agentId);
    this.discardRetainedAgentState(agentId);

    await this.cascadeArchiveChildren(agentId);

    return { archivedAt };
  }

  // Children created via the MCP `create_agent` tool carry the parent-agent-id
  // label pointing back at the caller. Archiving the parent cascades to those
  // children so subagent fleets don't outlive their orchestrator. Detached
  // handoff agents omit this label, so they stand outside the cascade.
  private async cascadeArchiveChildren(parentAgentId: string): Promise<void> {
    const registry = this.registry;
    if (!registry) {
      return;
    }
    const records = await registry.list();
    const parent = records.find((record) => record.id === parentAgentId);
    if (!parent) {
      throw new Error(`Archived parent ${parentAgentId} not found in storage`);
    }
    for (const record of records) {
      if (record.archivedAt) {
        continue;
      }
      if (record.labels?.[PARENT_AGENT_ID_LABEL] !== parentAgentId) {
        continue;
      }
      const child = await registry.get(record.id);
      if (!child || child.archivedAt || child.labels?.[PARENT_AGENT_ID_LABEL] !== parentAgentId) {
        continue;
      }
      await this.runLifecycleMutation(child.id, async () => {
        const currentChild = await registry.get(child.id);
        if (
          !currentChild ||
          currentChild.archivedAt ||
          currentChild.labels?.[PARENT_AGENT_ID_LABEL] !== parentAgentId
        ) {
          return;
        }
        if (shouldDetachFromArchivedParent(parent, currentChild)) {
          await this.detachAgentUnlocked(currentChild.id);
        } else if (this.agents.has(currentChild.id)) {
          await this.archiveAgentUnlocked(currentChild.id);
        } else {
          await this.archiveSnapshot(currentChild.id, new Date().toISOString());
        }
      });
    }
  }

  private async markRecordArchived(record: StoredAgentRecord): Promise<ArchivedStoredAgentRecord> {
    const registry = this.requireRegistry();
    const archivedAt = new Date().toISOString();
    const archivedRecord = buildArchivedAgentRecord(record, { archivedAt, updatedAt: archivedAt });

    await registry.upsert(archivedRecord);

    await this.syncNativeArchiveState(record.provider, record.persistence, "archive");

    if (this.agents.has(record.id)) {
      this.notifyAgentState(record.id);
    } else if (!archivedRecord.internal) {
      this.dispatchArchivedStoredAgent(archivedRecord);
    }

    await this.fireAgentArchived(record.id);

    return archivedRecord;
  }

  private async fireAgentArchived(agentId: string): Promise<void> {
    const callback = this.onAgentArchived;
    if (!callback) {
      return;
    }
    try {
      await callback(agentId);
    } catch (error) {
      this.logger.warn({ err: error, agentId }, "onAgentArchived callback failed");
    }
  }

  private dispatchArchivedStoredAgent(record: StoredAgentRecord): void {
    const updatedAt = new Date(record.updatedAt);
    this.dispatch({
      type: "agent_state",
      agent: {
        id: record.id,
        provider: record.provider,
        cwd: record.cwd,
        workspaceId: record.workspaceId,
        owner: record.owner,
        session: null,
        capabilities: STORED_AGENT_CAPABILITIES,
        config: buildStoredAgentConfig(record),
        runtimeInfo: undefined,
        lifecycle: "closed",
        createdAt: new Date(record.createdAt),
        updatedAt,
        availableModes: [],
        features: record.features,
        currentModeId: record.lastModeId ?? null,
        pendingPermissions: new Map(),
        bufferedPermissionResolutions: new Map(),
        inFlightPermissionResponses: new Set(),
        pendingReplacement: false,
        activeForegroundTurnId: null,
        activeTurnId: null,
        activeTurnStartedAt: null,
        foregroundTurnWaiters: new Set(),
        finalizedForegroundTurnIds: new Set(),
        unsubscribeSession: null,
        persistence: record.persistence ?? null,
        historyPrimed: true,
        lastUserMessageAt: record.lastUserMessageAt ? new Date(record.lastUserMessageAt) : null,
        lastUsage: undefined,
        lastError: record.lastError ?? undefined,
        attention: { requiresAttention: false },
        internal: record.internal,
        labels: record.labels,
      },
    });
  }

  async setAgentMode(agentId: string, modeId: string): Promise<AgentProviderNotice | null> {
    const agent = this.requireSessionAgent(agentId);
    const notice = (await agent.session.setMode(modeId)) ?? null;
    await this.drainSessionEvents(agentId);
    const currentMode = (await agent.session.getCurrentMode()) ?? modeId;
    agent.config.modeId = currentMode ?? undefined;
    agent.currentModeId = currentMode;
    // Update runtimeInfo to reflect the new mode
    if (agent.runtimeInfo) {
      agent.runtimeInfo = { ...agent.runtimeInfo, modeId: currentMode };
    }
    this.touchUpdatedAt(agent);
    this.emitState(agent);
    return notice;
  }

  async setAgentModel(agentId: string, modelId: string | null): Promise<void> {
    const agent = this.requireSessionAgent(agentId);
    const normalizedModelId =
      typeof modelId === "string" && modelId.trim().length > 0 ? modelId : null;

    if (agent.session.setModel) {
      await agent.session.setModel(normalizedModelId);
    }
    await this.drainSessionEvents(agentId);

    agent.config.model = normalizedModelId ?? undefined;
    if (agent.runtimeInfo) {
      agent.runtimeInfo = { ...agent.runtimeInfo, model: normalizedModelId };
    }
    this.touchUpdatedAt(agent);
    this.emitState(agent);
  }

  async setAgentThinkingOption(
    agentId: string,
    thinkingOptionId: string | null,
  ): Promise<AgentProviderNotice | null> {
    const agent = this.requireSessionAgent(agentId);
    const normalizedThinkingOptionId =
      typeof thinkingOptionId === "string" && thinkingOptionId.trim().length > 0
        ? thinkingOptionId
        : null;

    let notice: AgentProviderNotice | null = null;
    if (agent.session.setThinkingOption) {
      notice = (await agent.session.setThinkingOption(normalizedThinkingOptionId)) ?? null;
    }
    await this.drainSessionEvents(agentId);

    agent.config.thinkingOptionId = normalizedThinkingOptionId ?? undefined;
    if (agent.runtimeInfo) {
      agent.runtimeInfo = {
        ...agent.runtimeInfo,
        thinkingOptionId: normalizedThinkingOptionId,
      };
    }
    this.touchUpdatedAt(agent);
    this.emitState(agent);
    return notice;
  }

  async setAgentFeature(agentId: string, featureId: string, value: unknown): Promise<void> {
    const agent = this.requireAgent(agentId);

    if (!agent.session.setFeature) {
      throw new Error("Agent session does not support setting features");
    }

    await agent.session.setFeature(featureId, value);
    await this.drainSessionEvents(agentId);
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
    await this.runLifecycleMutation(agentId, async () => {
      const agent = this.requireAgent(agentId);
      await this.writeLabels(agent.id, labels);
    });
  }

  private async writeLabels(agentId: string, patch: AgentLabelPatch): Promise<WriteLabelsResult> {
    const liveAgent = this.agents.get(agentId);
    if (liveAgent) {
      liveAgent.labels = applyLabelPatch(liveAgent.labels, patch);
      this.touchUpdatedAt(liveAgent);
      await this.persistSnapshot(liveAgent);
      this.emitState(liveAgent, { persist: false });
      const record = this.registry ? await this.registry.get(agentId) : null;
      return { record, live: true };
    }

    const nextRecord = await this.writeStoredMetadata(agentId, { labels: patch });
    return { record: nextRecord, live: false };
  }

  private async writeStoredMetadata(
    agentId: string,
    patch: AgentMetadataPatch,
  ): Promise<StoredAgentRecord> {
    const registry = this.requireRegistry();
    const record = await registry.get(agentId);
    if (!record) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const nextRecord = {
      ...record,
      ...(patch.title ? { title: patch.title } : {}),
      ...(patch.labels ? { labels: applyLabelPatch(record.labels, patch.labels) } : {}),
      updatedAt: this.nextStoredUpdatedAt(record),
    };
    await registry.upsert(nextRecord);
    return nextRecord;
  }

  async detachAgent(agentId: string): Promise<{
    record: StoredAgentRecord;
    live: boolean;
    previousParentAgentId: string | null;
  }> {
    return this.runLifecycleMutation(agentId, () => this.detachAgentUnlocked(agentId));
  }

  private async detachAgentUnlocked(agentId: string): Promise<{
    record: StoredAgentRecord;
    live: boolean;
    previousParentAgentId: string | null;
  }> {
    const registry = this.requireRegistry();
    const liveAgent = this.agents.get(agentId);
    if (liveAgent) {
      const previousParentAgentId = getParentAgentIdFromLabels(liveAgent.labels);
      if (!previousParentAgentId) {
        await this.persistSnapshot(liveAgent);
        const record = await registry.get(agentId);
        if (!record) {
          throw new Error(`Agent not found in storage after detach: ${agentId}`);
        }
        return { record, live: true, previousParentAgentId: null };
      }

      const { record } = await this.writeLabels(agentId, detachedAgentLabelPatch(liveAgent.labels));
      if (!record) {
        throw new Error(`Agent not found in storage after detach: ${agentId}`);
      }
      return { record, live: true, previousParentAgentId };
    }

    const record = await registry.get(agentId);
    if (!record) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    const previousParentAgentId = getParentAgentIdFromLabels(record.labels);
    if (!previousParentAgentId) {
      return { record, live: false, previousParentAgentId: null };
    }

    const result = await this.writeLabels(agentId, detachedAgentLabelPatch(record.labels));
    if (!result.record) {
      throw new Error(`Agent not found in storage after detach: ${agentId}`);
    }
    return { record: result.record, live: false, previousParentAgentId };
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

    const nextRecord = buildArchivedAgentRecord(record, { archivedAt });
    await registry.upsert(nextRecord);

    await this.syncNativeArchiveState(record.provider, record.persistence, "archive");

    if (this.agents.has(agentId)) {
      this.notifyAgentState(agentId);
    } else {
      this.discardRetainedAgentState(agentId);
      if (!nextRecord.internal) {
        this.dispatchArchivedStoredAgent(nextRecord);
      }
    }

    await this.fireAgentArchived(agentId);
    await this.cascadeArchiveChildren(agentId);

    return nextRecord;
  }

  async unarchiveSnapshot(
    agentId: string,
    updates?: { workspaceId?: string; labels?: AgentLabelPatch },
  ): Promise<boolean> {
    const registry = this.requireRegistry();
    const record = await registry.get(agentId);
    if (!record || !record.archivedAt) {
      return false;
    }

    await this.syncNativeArchiveState(record.provider, record.persistence, "restore");

    await registry.upsert({
      ...record,
      ...(updates?.workspaceId ? { workspaceId: updates.workspaceId } : {}),
      ...(updates?.labels ? { labels: applyLabelPatch(record.labels, updates.labels) } : {}),
      archivedAt: null,
      updatedAt: new Date().toISOString(),
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
    await this.runLifecycleMutation(agentId, () =>
      this.updateAgentMetadataUnlocked(agentId, updates),
    );
  }

  private async updateAgentMetadataUnlocked(
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
        await this.writeLabels(agentId, updates.labels);
      }
      return;
    }

    await this.writeStoredMetadata(agentId, updates);
  }

  private async runLifecycleMutation<T>(agentId: string, mutation: () => Promise<T>): Promise<T> {
    // Parent cascade classifies a child inside the same lane used by open-tab
    // label writes, so a received ownership update cannot be overtaken.
    const previous = this.lifecycleMutationTails.get(agentId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(mutation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.lifecycleMutationTails.set(agentId, tail);
    void tail.finally(() => {
      if (this.lifecycleMutationTails.get(agentId) === tail) {
        this.lifecycleMutationTails.delete(agentId);
      }
    });
    return result;
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

  /**
   * Try to run a prompt out-of-band — i.e. without allocating a foreground turn
   * and without canceling any active turn. Returns true when the session
   * accepted the prompt as a side-effect command (e.g. /goal pause). Events
   * emitted by the handler flow through dispatchStream so they persist and
   * broadcast like normal timeline events.
   */
  async tryRunOutOfBand(
    agentId: string,
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): Promise<boolean> {
    const agent = this.requireSessionAgent(agentId);
    const generation = this.requireSessionGeneration(agentId);
    const handler = agent.session.tryHandleOutOfBand?.(prompt);
    if (!handler) {
      return false;
    }
    if (options?.clientMessageId) {
      try {
        const recorded = await this.recordSubmittedPrompt(agent, prompt, options.clientMessageId, {
          sessionGeneration: generation,
        });
        if (!recorded || !this.isSessionGenerationCurrent(agent, generation)) {
          return true;
        }
      } catch (error) {
        this.logger.error(
          { err: error, agentId, clientMessageId: options.clientMessageId },
          "Failed to record out-of-band submitted prompt",
        );
      }
    }
    if (!this.isSessionGenerationCurrent(agent, generation)) {
      return true;
    }
    if (options?.clientMessageId) {
      this.emitState(agent, { generation });
    }
    const dispatch = (event: AgentStreamEvent): void => {
      if (!this.isSessionGenerationCurrent(agent, generation)) {
        return;
      }
      // Persist timeline items so they show up in fetchAgentTimeline; broadcast
      // for live subscribers. Other event types are broadcast only.
      if (event.type === "timeline") {
        this.touchUpdatedAt(agent);
        void this.recordAndDispatchTimelineItem(agent.id, event.item, event.provider, undefined, {
          sessionGeneration: generation,
        }).catch((error) => {
          this.logger.error(
            { err: error, agentId: agent.id, itemType: event.item.type },
            "Failed to commit out-of-band timeline item",
          );
        });
        return;
      }
      this.dispatchStream(agent.id, event, { timestamp: new Date().toISOString() }, generation);
    };
    void (async () => {
      try {
        await handler.run({ emit: dispatch });
      } catch (error) {
        const text = error instanceof Error ? error.message : "Out-of-band command failed";
        dispatch({
          type: "timeline",
          provider: agent.provider,
          item: { type: "assistant_message", text: `[Error] ${text}` },
        });
      }
    })().catch((error) => {
      this.logger.error({ err: error, agentId }, "Out-of-band command task failed");
    });
    return true;
  }

  async appendTimelineItem(agentId: string, item: AgentTimelineItem): Promise<void> {
    const agent = this.requireAgent(agentId);
    const generation = this.sessionGenerationTokens.get(agentId);
    item = limitAgentTimelineItemContent(item);
    const row = await this.recordTimeline(agentId, item, undefined, generation);
    if (generation !== undefined && !this.isSessionGenerationCurrent(agent, generation)) {
      return;
    }
    this.touchUpdatedAt(agent);
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
        timestamp: row.timestamp,
      },
      generation,
    );
    await this.persistSnapshot(agent, { generation });
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

  private async startPendingForegroundTurn(params: {
    agent: ActiveManagedAgent;
    agentId: string;
    pendingRun: PendingForegroundRun;
    prompt: AgentPromptInput;
    options?: AgentRunOptions;
  }): Promise<string> {
    const { agent, agentId, pendingRun, prompt, options } = params;
    try {
      pendingRun.providerStartStarted = true;
      const result = await agent.session.startTurn(prompt, options);
      this.assertPendingForegroundRunCurrent(agent, pendingRun);
      return result.turnId;
    } catch (error) {
      if (!this.isPendingForegroundRunCurrent(agent, pendingRun)) {
        if (pendingRun.settled || error instanceof TurnStartCanceledError) {
          throw error instanceof TurnStartCanceledError ? error : new TurnStartCanceledError();
        }
        throw error;
      }
      if (error instanceof TurnStartCanceledError) {
        this.runs.settleForegroundRun(agentId, pendingRun.token);
        throw error;
      }
      agent.pendingReplacement = false;
      const errorMsg = error instanceof Error ? error.message : "Failed to start turn";
      pendingRun.start = { status: "failed", error: errorMsg };
      await this.handleStreamEvent(
        agent,
        {
          type: "turn_failed",
          provider: agent.provider,
          error: errorMsg,
        },
        { sessionGeneration: pendingRun.generation },
      );
      this.finalizeForegroundTurn(agent);
      this.runs.settleForegroundRun(agentId, pendingRun.token);
      throw error;
    }
  }

  private isPendingForegroundRunCurrent(
    agent: ActiveManagedAgent,
    pendingRun: PendingForegroundRun,
  ): boolean {
    return (
      !pendingRun.settled &&
      this.runs.getRun(agent.id) === pendingRun &&
      this.isSessionGenerationCurrent(agent, pendingRun.generation)
    );
  }

  private isPendingForegroundRunCurrentById(
    agentId: string,
    pendingRun: PendingForegroundRun,
  ): boolean {
    const agent = this.agents.get(agentId);
    return agent !== undefined && this.isPendingForegroundRunCurrent(agent, pendingRun);
  }

  private assertPendingForegroundRunCurrent(
    agent: ActiveManagedAgent,
    pendingRun: PendingForegroundRun,
  ): void {
    if (!this.isPendingForegroundRunCurrent(agent, pendingRun)) {
      throw new TurnStartCanceledError();
    }
  }

  streamAgent(
    agentId: string,
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): AsyncGenerator<AgentStreamEvent> {
    const existingAgent = this.requireSessionAgent(agentId);
    if (this.quarantinedAgentIds.has(agentId)) {
      throw new Error(`Agent ${agentId} session is quarantined and must be recreated`);
    }
    this.logger.trace(
      {
        agentId,
        provider: existingAgent.provider,
        sessionId: existingAgent.persistence?.sessionId ?? undefined,
        turnId: existingAgent.activeForegroundTurnId ?? undefined,
        lifecycle: existingAgent.lifecycle,
        activeForegroundTurnId: existingAgent.activeForegroundTurnId,
        hasTrackedRun: this.runs.hasRun(agentId),
        promptType: typeof prompt === "string" ? "string" : "structured",
        hasRunOptions: Boolean(options),
      },
      "agent.manager.stream.request",
    );
    if (existingAgent.activeForegroundTurnId || this.runs.hasRun(agentId)) {
      this.logger.trace(
        {
          agentId,
          provider: existingAgent.provider,
          sessionId: existingAgent.persistence?.sessionId ?? undefined,
          turnId: existingAgent.activeForegroundTurnId ?? undefined,
          lifecycle: existingAgent.lifecycle,
          hasTrackedRun: this.runs.hasRun(agentId),
        },
        "agent.manager.stream.reject",
      );
      throw new Error(`Agent ${agentId} already has an active run`);
    }

    const agent = existingAgent;
    const isReplacement = agent.pendingReplacement;
    const generation = this.sessionGenerationTokens.get(agentId);
    if (!generation) {
      throw new TurnStartCanceledError();
    }
    agent.lastError = undefined;

    // Lock ordering: reserve generation/run/token synchronously, then release the per-agent
    // admission lane. Durable timeline and session-event queues are independent async tails; no
    // lifecycle or admission gate may be held while either tail awaits persistence.
    const pendingRun = this.runs.createPendingRun(agentId, generation);
    this.latestTurnTokens.set(agentId, pendingRun.token);

    // oxlint-disable-next-line complexity
    const streamForwarder = async function* streamForwarder(this: AgentManager) {
      let turnId: string;
      let turnStream: ReturnType<AgentRunState["createTurnStream"]> | null = null;
      let submittedPrompt: SubmittedPromptRecord | null = null;
      let providerStartCompleted = false;
      try {
        // Admission is the only durable operation before provider dispatch. It runs outside the
        // synchronous reservation lane so cancellation can fence this reservation immediately.
        if (options?.clientMessageId) {
          submittedPrompt = await this.recordSubmittedPrompt(
            agent,
            prompt,
            options.clientMessageId,
            {
              dispatch: false,
              messageId: options.clientMessageId,
              sessionGeneration: pendingRun.generation,
              turnToken: pendingRun.token,
              pendingRun,
            },
          );
          this.assertPendingForegroundRunCurrent(agent, pendingRun);
        }

        turnId = await this.startPendingForegroundTurn({
          agent,
          agentId,
          pendingRun,
          prompt,
          options,
        });
        providerStartCompleted = true;

        const stagedSubmittedPromptEcho = options?.clientMessageId
          ? pendingRun.stagedEvents.find(
              ({ event }) =>
                event.type === "timeline" &&
                event.item.type === "user_message" &&
                event.item.clientMessageId === options.clientMessageId,
            )
          : undefined;
        if (submittedPrompt) {
          submittedPrompt = await this.attachSubmittedPromptTurn(
            agent,
            submittedPrompt,
            turnId,
            stagedSubmittedPromptEcho?.event.type === "timeline" &&
              stagedSubmittedPromptEcho.event.item.type === "user_message"
              ? stagedSubmittedPromptEcho.event.item.messageId
              : undefined,
            pendingRun,
          );
        }

        // The durable append may yield to cancellation, reload, or replacement. No manager-owned
        // state or wire event may escape this immutable run/generation/token admission fence.
        this.assertPendingForegroundRunCurrent(agent, pendingRun);
        this.registerTurnToken(agentId, turnId, pendingRun.token);

        if (isReplacement) {
          agent.pendingReplacement = false;
        }
        const turnStartedAt = new Date();
        pendingRun.start = { status: "started", turnId };
        agent.activeForegroundTurnId = turnId;
        this.openActiveTurn(agent, turnId, turnStartedAt);
        agent.lifecycle = "running";
        this.touchUpdatedAt(agent);
        // AgentManager owns the accepted-turn boundary. Publish liveness before the canonical
        // prompt so clients can retire optimistic activity without painting an idle frame.
        // The provider's duplicate start for this turn is suppressed at the ingestion boundary.
        this.dispatchStream(
          agent.id,
          { type: "turn_started", provider: agent.provider, turnId },
          { timestamp: turnStartedAt.toISOString() },
          pendingRun.generation,
        );
        if (submittedPrompt?.inserted) {
          this.dispatchCommittedTimelineRow(
            agent.id,
            submittedPrompt.row,
            agent.provider,
            pendingRun.generation,
            pendingRun.token,
          );
        }
        for (const stagedEvent of pendingRun.stagedEvents.splice(0)) {
          const event = stagedEvent.event;
          const isAcceptedTurnStart =
            event.type === "turn_started" && getAgentStreamEventTurnId(event) === turnId;
          if (isAcceptedTurnStart || stagedEvent === stagedSubmittedPromptEcho) {
            continue;
          }
          this.enqueueSessionEvent(agent.id, event, stagedEvent.generation, stagedEvent.turnToken);
        }
        this.emitState(agent, {
          generation: pendingRun.generation,
          turnToken: pendingRun.token,
        });
      } catch (error) {
        if (this.runs.getRun(agentId) === pendingRun && !pendingRun.settled) {
          if (providerStartCompleted) {
            await this.quarantineAgentSession(agent, error);
          }
          pendingRun.start = {
            status: "failed",
            error: error instanceof Error ? error.message : "Failed to admit turn",
          };
          pendingRun.stagedEvents.length = 0;
          this.runs.settleForegroundRun(agentId, pendingRun.token);
        }
        throw error;
      }
      this.logger.trace(
        {
          agentId,
          provider: agent.provider,
          sessionId: agent.persistence?.sessionId ?? undefined,
          turnId,
          lifecycle: agent.lifecycle,
          activeForegroundTurnId: agent.activeForegroundTurnId,
        },
        "agent.manager.stream.start",
      );

      turnStream = this.runs.createTurnStream(turnId);
      this.runs.addWaiter(agent, turnStream.waiter);

      try {
        const acceptedTurnStartedEvent: AgentStreamEvent = {
          type: "turn_started",
          provider: agent.provider,
          turnId,
        };
        yield acceptedTurnStartedEvent;
        for await (const event of turnStream.events(isTurnTerminalEvent)) {
          yield event;
        }
      } finally {
        if (turnStream) {
          this.runs.deleteWaiter(agent, turnStream.waiter);
        }
        this.runs.settleForegroundRun(agentId, pendingRun.token);
        if (!agent.activeForegroundTurnId) {
          await this.refreshRuntimeInfo(agent, {
            generation: pendingRun.generation,
            turnToken: pendingRun.token,
          });
        }
      }
    }.call(this);

    return streamForwarder;
  }

  private finalizeForegroundTurn(
    agent: ActiveManagedAgent,
    turnId?: string,
    turnToken?: string,
  ): void {
    const mutableAgent = agent;
    if (turnId) {
      this.runs.rememberFinalizedTurn(mutableAgent, turnId);
    }
    mutableAgent.activeForegroundTurnId = null;
    this.applyActiveTurnTerminal(mutableAgent, turnId);
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
        provider: agent.provider,
        sessionId: mutableAgent.persistence?.sessionId ?? undefined,
        turnId,
        lifecycle: mutableAgent.lifecycle,
        terminalError,
        pendingReplacement: mutableAgent.pendingReplacement,
      },
      "agent.manager.finalize",
    );
    if (!shouldHoldBusyForReplacement) {
      this.touchUpdatedAt(mutableAgent);
      this.emitState(mutableAgent, { turnToken });
    }
  }

  private openActiveTurn(agent: ActiveManagedAgent, turnId: string, startedAt: Date): void {
    agent.activeTurnId = turnId;
    agent.activeTurnStartedAt = startedAt;
  }

  private applyActiveTurnTerminal(
    agent: ActiveManagedAgent,
    turnId?: string,
    fromHistory = false,
  ): ActiveTurnTerminalDisposition {
    if (fromHistory) return "stale";
    if (!agent.activeTurnId) return "untracked";
    if (turnId && agent.activeTurnId !== turnId) return "stale";
    agent.activeTurnId = null;
    agent.activeTurnStartedAt = null;
    return "closed_current";
  }

  async replaceAgentRun(
    agentId: string,
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): Promise<AsyncGenerator<AgentStreamEvent>> {
    const snapshot = this.requireAgent(agentId);
    if (
      snapshot.lifecycle !== "running" &&
      !snapshot.activeForegroundTurnId &&
      !this.runs.hasRun(agentId)
    ) {
      return this.streamAgent(agentId, prompt, options);
    }

    const agent = this.requireSessionAgent(agentId);
    agent.pendingReplacement = true;
    agent.lifecycle = "running";
    this.touchUpdatedAt(agent);
    this.emitState(agent);

    try {
      await this.cancelAgentRunBefore(agentId, "replace");
      if (this.quarantinedAgentIds.has(agentId)) {
        await this.reloadAgentSession(agentId);
      }
      return this.streamAgent(agentId, prompt, options);
    } catch (error) {
      const latest = this.agents.get(agentId);
      if (latest) {
        latest.pendingReplacement = false;
      }
      throw error;
    }
  }

  async steerAgentRun(
    agentId: string,
    prompt: AgentPromptInput,
    options?: AgentSteerOptions,
  ): Promise<SteerResult> {
    const agent = this.requireSessionAgent(agentId);
    const expectedTurnId = agent.activeForegroundTurnId ?? agent.activeTurnId;
    if (!expectedTurnId || !agent.session.steerActiveTurn) {
      return { status: "unavailable" };
    }
    const result = await this.runSteerAdmission(agent, expectedTurnId, async () => {
      const admission = await agent.session.steerActiveTurn!(prompt, {
        ...options,
        expectedTurnId,
      });
      if (admission.status === "accepted") {
        await this.recordAcceptedSteer(agent, prompt, options?.clientMessageId, expectedTurnId);
      }
      return admission;
    });
    // An unavailable answer is only safe to fall back from while this admission
    // still owns the active turn. Never let an A admission replace a later B.
    if (result.status === "unavailable" && agent.activeTurnId !== expectedTurnId) {
      throw new Error("Active turn changed before steering could be delivered");
    }
    return result;
  }

  async steerOrReplaceActiveTurn(
    agentId: string,
    prompt: AgentPromptInput,
    options?: AgentSteerOptions,
  ): Promise<ActiveTurnSteerDispatchResult> {
    const agent = this.requireSessionAgent(agentId);
    const expectedTurnId = agent.activeForegroundTurnId ?? agent.activeTurnId;
    if (!expectedTurnId) {
      return { status: "inactive" };
    }

    const result = agent.session.steerActiveTurn
      ? await this.runSteerAdmission(agent, expectedTurnId, async () => {
          const admission = await agent.session.steerActiveTurn!(prompt, {
            ...options,
            expectedTurnId,
          });
          if (admission.status === "accepted") {
            await this.recordAcceptedSteer(agent, prompt, options?.clientMessageId, expectedTurnId);
          }
          return admission;
        })
      : { status: "unavailable" as const };
    if (result.status === "accepted") {
      return { status: "steered" };
    }

    // Providers without autonomous steering keep their existing dispatch behavior. The shared
    // admission may recognize the turn, but only an accepted steer can own it without replacement.
    if (agent.activeForegroundTurnId === null && agent.activeTurnId === expectedTurnId) {
      return { status: "inactive" };
    }

    await this.beforeSteerUnavailableFallback?.({ agentId, expectedTurnId });
    this.assertSteerAdmissionOwnsTurn(agent, expectedTurnId);
    return {
      status: "replaced",
      iterator: await this.replaceAdmittedForegroundTurn(
        agent,
        expectedTurnId,
        prompt,
        stripSteerOptions(options),
      ),
    };
  }

  private assertSteerAdmissionOwnsTurn(agent: ActiveManagedAgent, expectedTurnId: string): void {
    if (agent.activeTurnId !== expectedTurnId) {
      throw new Error("Active turn changed before steering could be delivered");
    }
  }

  private async runSteerAdmission<T>(
    agent: ActiveManagedAgent,
    expectedTurnId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.runForegroundMutation(agent.id, async () => {
      await this.drainSessionEvents(agent.id);
      this.agentStreamCoalescer.flushFor(agent.id);
      await this.drainCoalescedTimeline(agent.id);
      this.assertSteerAdmissionOwnsTurn(agent, expectedTurnId);
      const barrier: SteerEventBarrier = { events: [] };
      this.steerEventBarriers.set(agent.id, barrier);
      try {
        return await operation();
      } finally {
        if (this.steerEventBarriers.get(agent.id) === barrier) {
          this.steerEventBarriers.delete(agent.id);
        }
        for (const queuedEvent of barrier.events) {
          this.enqueueSessionEvent(
            agent.id,
            queuedEvent.event,
            queuedEvent.generation,
            queuedEvent.turnToken,
          );
        }
        await this.drainSessionEvents(agent.id);
      }
    });
  }

  private async runForegroundMutation<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.foregroundMutationTails.get(agentId) ?? Promise.resolve();
    if (!this.foregroundMutationTails.has(agentId)) {
      // Hold the lane before invoking the first operation so a synchronous subscriber cannot
      // start a competing mutation while this operation is between its admission steps.
      let release!: () => void;
      const gate = new Promise<void>((resolveGate) => {
        release = resolveGate;
      });
      this.foregroundMutationTails.set(agentId, gate);
      try {
        return await operation();
      } finally {
        release();
        if (this.foregroundMutationTails.get(agentId) === gate) {
          this.foregroundMutationTails.delete(agentId);
        }
      }
    }

    const run = previous.catch(() => undefined).then(operation);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.foregroundMutationTails.set(agentId, tail);
    try {
      return await run;
    } finally {
      if (this.foregroundMutationTails.get(agentId) === tail) {
        this.foregroundMutationTails.delete(agentId);
      }
    }
  }

  private async replaceAdmittedForegroundTurn(
    agent: ActiveManagedAgent,
    expectedTurnId: string,
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): Promise<AsyncGenerator<AgentStreamEvent>> {
    this.assertSteerAdmissionOwnsTurn(agent, expectedTurnId);
    agent.pendingReplacement = true;
    agent.lifecycle = "running";
    this.touchUpdatedAt(agent);
    this.emitState(agent);

    try {
      await this.cancelAgentRunBefore(agent.id, "replace");
      return this.streamAgent(agent.id, prompt, options);
    } catch (error) {
      const latest = this.agents.get(agent.id);
      if (latest) {
        latest.pendingReplacement = false;
      }
      throw error;
    }
  }

  private async recordAcceptedSteer(
    agent: ActiveManagedAgent,
    prompt: AgentPromptInput,
    clientMessageId: string | undefined,
    expectedTurnId: string,
  ): Promise<void> {
    if (!clientMessageId) {
      return;
    }
    await this.recordSubmittedPrompt(agent, prompt, clientMessageId, {
      messageId: clientMessageId,
      turnId: expectedTurnId,
      sessionGeneration: this.sessionGenerationTokens.get(agent.id),
      turnToken: this.runs.getRun(agent.id)?.token,
    });
    this.emitState(agent, {
      generation: this.sessionGenerationTokens.get(agent.id),
      turnToken: this.runs.getRun(agent.id)?.token,
    });
  }

  async waitForAgentRunStart(agentId: string, options?: WaitForAgentStartOptions): Promise<void> {
    const snapshot = this.getAgent(agentId);
    if (!snapshot) {
      throw new Error(`Agent ${agentId} not found`);
    }

    const pendingRun = this.runs.getPendingRun(agentId);
    if (
      (snapshot.lifecycle === "running" || pendingRun?.start.status === "started") &&
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
          finishErr(createAbortError(options.signal, "wait_for_agent_start aborted"));
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }

      const checkCurrentState = () => {
        const current = this.getAgent(agentId);
        if (!current) {
          finishErr(new Error(`Agent ${agentId} not found`));
          return true;
        }

        const currentPendingRun = this.runs.getPendingRun(agentId);
        if (
          (current.lifecycle === "running" || currentPendingRun?.start.status === "started") &&
          !current.pendingReplacement
        ) {
          finishOk();
          return true;
        }

        if (currentPendingRun?.start.status === "failed") {
          finishErr(new Error(currentPendingRun.start.error));
          return true;
        }

        if (current.lifecycle === "error" && !currentPendingRun) {
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
    const generation = this.requireSessionGeneration(agentId);
    const turnToken = this.runs.getRun(agentId)?.token;
    agent.inFlightPermissionResponses.add(requestId);

    try {
      const result = await agent.session.respondToPermission(requestId, response);
      if (
        !this.isSessionGenerationCurrent(agent, generation) ||
        (turnToken !== undefined && !this.isLatestTurnTokenCurrent(agentId, turnToken))
      ) {
        return result;
      }
      agent.pendingPermissions.delete(requestId);

      try {
        await this.refreshSessionState(agent, { generation, turnToken });
      } catch {
        // Ignore refresh errors - state sync after permission approval is best effort.
      }

      if (
        !this.isSessionGenerationCurrent(agent, generation) ||
        (turnToken !== undefined && !this.isLatestTurnTokenCurrent(agentId, turnToken))
      ) {
        return result;
      }
      this.touchUpdatedAt(agent);
      await this.persistSnapshot(agent, { generation, turnToken });
      if (
        !this.isSessionGenerationCurrent(agent, generation) ||
        (turnToken !== undefined && !this.isLatestTurnTokenCurrent(agentId, turnToken))
      ) {
        return result;
      }
      this.emitState(agent, { generation, turnToken });

      const bufferedResolution = agent.bufferedPermissionResolutions.get(requestId);
      if (bufferedResolution) {
        agent.bufferedPermissionResolutions.delete(requestId);
        this.dispatchStream(
          agent.id,
          bufferedResolution,
          { timestamp: new Date().toISOString() },
          generation,
          turnToken,
        );
      }

      return result;
    } finally {
      agent.inFlightPermissionResponses.delete(requestId);
      agent.bufferedPermissionResolutions.delete(requestId);
    }
  }

  async cancelAgentRun(
    agentId: string,
    expectedTurnId?: string,
  ): Promise<AgentRunCancellationResult> {
    const pendingRun = this.runs.getPendingRun(agentId);
    if (pendingRun?.start.status === "pending") {
      return this.cancelPendingForegroundRun(agentId, expectedTurnId, pendingRun);
    }
    return this.runForegroundMutation(agentId, () =>
      this.cancelAgentRunNow(agentId, expectedTurnId),
    );
  }

  private async cancelPendingForegroundRun(
    agentId: string,
    expectedTurnId: string | undefined,
    pendingRun: PendingForegroundRun,
  ): Promise<AgentRunCancellationResult> {
    const agent = this.requireSessionAgent(agentId);
    if (expectedTurnId !== undefined && agent.activeTurnId !== expectedTurnId) {
      return { status: "stale_turn" };
    }
    if (this.runs.getRun(agentId) !== pendingRun || pendingRun.start.status !== "pending") {
      return this.cancelAgentRunNow(agentId, expectedTurnId);
    }

    if (!pendingRun.providerStartStarted) {
      pendingRun.start = {
        status: "failed",
        error: new TurnStartCanceledError().message,
      };
      pendingRun.stagedEvents.length = 0;
      this.runs.settleForegroundRun(agentId, pendingRun.token);
      return { status: "settled" };
    }

    // A provider call has already crossed the admission boundary. Fence first so its late
    // result/events cannot activate this reservation, then use the provider's bounded interrupt
    // and quarantine path to avoid leaving a native turn owner behind.
    this.fenceSessionGeneration(agent, { settlePendingStart: true });
    const interruptResult = await this.interruptSession(agent.session, agentId);
    await this.quarantineAgentSession(
      agent,
      interruptResult.error ??
        new Error("Provider start was canceled after durable prompt admission"),
    );
    return interruptResult.acknowledged ? { status: "settled" } : { status: "refused" };
  }

  private async cancelAgentRunNow(
    agentId: string,
    expectedTurnId?: string,
  ): Promise<AgentRunCancellationResult> {
    const agent = this.requireSessionAgent(agentId);
    if (expectedTurnId !== undefined && agent.activeTurnId !== expectedTurnId) {
      return { status: "stale_turn" };
    }
    const run =
      this.runs.getRun(agentId) ??
      (agent.lifecycle === "running"
        ? this.runs.trackAutonomousRun(agentId, null, this.requireSessionGeneration(agentId))
        : null);
    if (run) {
      this.latestTurnTokens.set(agentId, run.token);
    }
    if (!run) {
      return { status: "not_running" };
    }

    if (run.kind === "foreground" && run.start.status === "pending") {
      return await this.cancelPendingForegroundRun(agentId, expectedTurnId, run);
    }

    const interruptResult = await this.interruptSession(agent.session, agentId, expectedTurnId);
    const settlement = await this.waitWithTimeout({
      operation: run.settledPromise,
      timeoutMs: interruptResult.acknowledged
        ? this.rescueTimeouts.interruptSessionMs
        : this.rescueTimeouts.interruptSessionMs,
    });

    if (!interruptResult.acknowledged) {
      await this.quarantineAgentSession(agent, interruptResult.error);
      return { status: "refused" };
    }

    const runTurnId = this.runs.getTurnId(agentId);
    if (settlement === "timed_out" && runTurnId) {
      this.logger.warn(
        { agentId, turnId: runTurnId, kind: run.kind },
        "cancelAgentRun: acknowledged turn still active after timeout, force-canceling",
      );
      // Fence before publication. The subscriber may synchronously attempt a replacement;
      // that attempt must observe the quarantined session, never reuse this turn.
      const quarantine = this.quarantineAgentSession(
        agent,
        new Error("Provider cancellation was acknowledged but the run did not settle in time"),
      );
      this.dispatchStream(agent.id, {
        type: "turn_canceled",
        provider: agent.provider,
        reason: "interrupted",
        turnId: runTurnId,
      });
      await quarantine;
    } else if (settlement === "timed_out" && run.kind === "foreground") {
      this.logger.warn(
        { agentId, kind: run.kind },
        "cancelAgentRun: acknowledged pending turn still active after timeout, clearing it",
      );
      const quarantine = this.quarantineAgentSession(
        agent,
        new Error("Provider cancellation was acknowledged but the pending run did not settle"),
      );
      this.dispatchStream(agent.id, {
        type: "turn_canceled",
        provider: agent.provider,
        reason: "interrupted",
      });
      await quarantine;
    } else if (settlement === "timed_out" && run.kind === "autonomous") {
      this.logger.warn(
        { agentId, kind: run.kind },
        "cancelAgentRun: acknowledged turn still active after timeout, force-canceling",
      );
      const quarantine = this.quarantineAgentSession(
        agent,
        new Error("Provider cancellation was acknowledged but the run did not settle in time"),
      );
      this.dispatchStream(agent.id, {
        type: "turn_canceled",
        provider: agent.provider,
        reason: "interrupted",
      });
      await quarantine;
    }

    if (settlement === "timed_out") {
      return { status: "settled" };
    }

    if (agent.pendingPermissions.size > 0) {
      this.resolvePendingPermissionsForAgent(agent, agent.provider, undefined, "Interrupted");
      this.touchUpdatedAt(agent);
      this.emitState(agent);
    }
    return { status: "settled" };
  }

  private async cancelAgentRunBefore(
    agentId: string,
    action: "reload" | "replace" | "rewind",
  ): Promise<void> {
    const result = await this.cancelAgentRun(agentId);
    if (result.status === "refused") {
      throw new AgentRunCancellationError(agentId, action);
    }
  }

  private async interruptSession(
    session: AgentSession,
    agentId: string,
    expectedTurnId?: string,
  ): Promise<{ acknowledged: boolean; error?: unknown }> {
    try {
      const result = await this.waitWithTimeout({
        operation: session.interrupt(expectedTurnId),
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
        return { acknowledged: false };
      }
      return { acknowledged: true };
    } catch (error) {
      this.logger.error({ err: error, agentId }, "Failed to interrupt session");
      return { acknowledged: false, error };
    }
  }

  private async quarantineAgentSession(agent: ActiveManagedAgent, reason?: unknown): Promise<void> {
    this.quarantinedAgentIds.add(agent.id);
    // This is synchronous on purpose: reload must observe a settled, fenced run before it can
    // preserve any state or install a replacement session.
    this.fenceSessionGeneration(agent, { settlePendingStart: true });
    this.agentStreamCoalescer.discard(agent.id);
    this.runs.cancelWaiters(agent, (turnId) => ({
      type: "turn_canceled",
      provider: agent.provider,
      reason: "interrupted",
      turnId,
    }));
    this.runs.clearAgentRun(agent.id);
    this.logger.error(
      { err: reason, agentId: agent.id, provider: agent.provider },
      "Quarantining agent session after cancellation failure",
    );
    const close = Promise.resolve().then(() => agent.session.close());
    try {
      const result = await this.waitWithTimeout({
        operation: close,
        timeoutMs: this.rescueTimeouts.interruptSessionMs,
        onLateError: (error) => {
          this.logger.error(
            { err: error, agentId: agent.id },
            "Quarantined agent session close failed after timeout",
          );
        },
      });
      if (result === "timed_out") {
        this.logger.error(
          { agentId: agent.id, timeoutMs: this.rescueTimeouts.interruptSessionMs },
          "Quarantined agent session close timed out",
        );
      }
    } catch (error) {
      this.logger.error(
        { err: error, agentId: agent.id },
        "Failed to close quarantined agent session",
      );
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
   * Hydrates the runtime timeline from provider history. No-ops if already hydrated.
   */
  async hydrateTimelineFromProvider(
    agentId: string,
    options?: HydrateTimelineOptions,
  ): Promise<void> {
    const agent = this.requireSessionAgent(agentId);
    await this.hydrateTimelineFromLegacyProviderHistory(
      agent,
      options,
      this.requireSessionGeneration(agentId),
    );
  }

  async rewind(agentId: string, messageId: string, mode: RewindMode): Promise<void> {
    const agent = this.requireSessionAgent(agentId);
    const submittedRow = this.timelineStore
      .getRows(agentId)
      .find(
        (row) =>
          row.item.type === "user_message" &&
          row.item.messageId === messageId &&
          row.item.clientMessageId === messageId,
      );
    if (submittedRow && !submittedRow.providerMessageId) {
      throw new Error("Cannot rewind before the provider acknowledges the submitted prompt");
    }
    const providerMessageId = submittedRow?.providerMessageId ?? messageId;

    if (this.hasInFlightRun(agentId)) {
      await this.cancelAgentRunBefore(agentId, "rewind");
    }

    const lock = this.runs.createPendingRun(agentId, this.requireSessionGeneration(agentId));
    this.latestTurnTokens.set(agentId, lock.token);
    try {
      this.logger.info(
        { agentId, provider: agent.provider, messageId, mode },
        "agent.rewind.start",
      );
      await invokeRewindCapability(agent.session, { messageId: providerMessageId, mode });
      if (mode !== "files") {
        await this.hydrateTimelineFromProvider(agentId, {
          force: true,
          broadcast: true,
          broadcastTimeline: false,
          turnToken: lock.token,
        });
        if (
          this.isSessionGenerationCurrent(agent, lock.generation) &&
          this.isLatestTurnTokenCurrent(agentId, lock.token)
        ) {
          this.dispatch({
            type: "timeline_replacement",
            agentId,
            epoch: this.timelineStore.getEpoch(agentId),
          });
        }
      }
      await this.refreshRuntimeInfo(agent, {
        generation: lock.generation,
        turnToken: lock.token,
      });
      await this.persistSnapshot(agent, {
        generation: lock.generation,
        turnToken: lock.token,
      });
      this.logger.info(
        { agentId, provider: agent.provider, messageId, mode },
        "agent.rewind.complete",
      );
    } catch (error) {
      this.logger.warn(
        { err: error, agentId, provider: agent.provider, messageId, mode },
        "agent.rewind.failed",
      );
      throw error;
    } finally {
      this.runs.settleForegroundRun(agentId, lock.token);
    }
  }

  async deleteAgentState(agentId: string): Promise<void> {
    this.discardRetainedAgentState(agentId);
    await this.deleteCommittedTimeline(agentId);
  }

  async deleteCommittedTimeline(agentId: string, generation?: symbol): Promise<void> {
    const store = this.durableTimelineStore;
    if (!store) return;
    await this.queueDurableTimelineMutation(agentId, generation, () => store.deleteAgent(agentId));
  }

  private async replaceCommittedTimeline(
    agentId: string,
    rows: readonly AgentTimelineRow[],
    generation: symbol,
    turnToken?: string,
    metadata?: { epoch: string; nextSeq: number },
  ): Promise<boolean> {
    const store = this.durableTimelineStore;
    if (!store) return true;
    const result = await this.queueDurableTimelineMutation(
      agentId,
      generation,
      () =>
        store.replaceCommitted(agentId, rows, {
          epoch: metadata?.epoch,
          nextSeq: metadata?.nextSeq,
          shouldCommit: () =>
            this.isSessionGenerationCurrentById(agentId, generation) &&
            (turnToken === undefined || this.isLatestTurnTokenCurrent(agentId, turnToken)),
        }),
      turnToken,
    );
    return result === true;
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
    return lastLiveItem ?? (await this.durableTimelineStore?.getLastItem(agentId)) ?? null;
  }

  async waitForAgentEvent(
    agentId: string,
    options?: WaitForAgentOptions,
  ): Promise<WaitForAgentResult> {
    const snapshot = this.getAgent(agentId);
    if (!snapshot) {
      throw new Error(`Agent ${agentId} not found`);
    }

    const pendingForegroundRun = this.runs.getPendingRun(agentId);
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
        pendingForegroundRun?.start.status === "started";
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
      createdAt?: Date;
      updatedAt?: Date;
      lastUserMessageAt?: Date | null;
      labels?: Record<string, string>;
      timeline?: AgentTimelineItem[];
      timelineRows?: AgentTimelineRow[];
      timelineNextSeq?: number;
      persistence?: AgentPersistenceHandle;
      historyPrimed?: boolean;
      lastUsage?: AgentUsage;
      lastError?: string;
      attention?: AttentionState;
      initialTitle?: string | null;
      publishWhenReady?: boolean;
      workspaceId?: string;
      owner?: AgentOwner;
    },
  ): Promise<ManagedAgent> {
    let registered = false;
    try {
      this.assertAcceptingAgentRegistrations();
      const resolvedAgentId = validateAgentId(agentId, "registerSession");
      if (this.agents.has(resolvedAgentId)) {
        throw new Error(`Agent with id ${resolvedAgentId} already exists`);
      }
      const initialPersistedTitle = await this.resolveInitialPersistedTitle(
        resolvedAgentId,
        config,
        options?.initialTitle ?? null,
      );

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

      this.assertAcceptingAgentRegistrations();
      this.agents.set(resolvedAgentId, managed);
      this.sessionGenerationTokens.set(resolvedAgentId, Symbol(`session:${resolvedAgentId}`));
      this.quarantinedAgentIds.delete(resolvedAgentId);
      registered = true;
      // Initialize previousStatus to track transitions
      this.previousStatuses.set(resolvedAgentId, managed.lifecycle);
      await this.refreshRuntimeInfo(managed, { emit: false });
      this.assertAgentRegistrationActive(managed);
      await this.persistSnapshot(managed, {
        title: initialPersistedTitle,
      });
      this.assertAgentRegistrationActive(managed);
      if (!options?.publishWhenReady) {
        this.emitState(managed, { persist: false });
      }

      await this.refreshSessionState(managed, { emit: false });
      this.assertAgentRegistrationActive(managed);
      managed.lifecycle = "idle";
      this.touchUpdatedAt(managed);
      await this.persistSnapshot(managed);
      this.assertAgentRegistrationActive(managed);
      this.emitState(managed, { persist: false });
      this.subscribeToSession(managed);
      return { ...managed };
    } catch (error) {
      if (!registered) {
        await this.closeUnregisteredSession(session);
      }
      throw error;
    }
  }

  private assertAcceptingAgentRegistrations(): void {
    if (!this.acceptingAgentRegistrations) {
      throw new AgentManagerShuttingDownError();
    }
  }

  private assertAgentRegistrationActive(agent: ActiveManagedAgent): void {
    if (!this.acceptingAgentRegistrations || this.agents.get(agent.id) !== agent) {
      throw new AgentManagerShuttingDownError();
    }
  }

  private async closeUnregisteredSession(session: AgentSession): Promise<void> {
    try {
      await session.close();
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to close unregistered agent session");
    }
  }

  private async requireExternalMcpSupport(
    session: AgentSession,
    storedConfig: AgentSessionConfig,
  ): Promise<void> {
    if (
      Object.keys(storedConfig.mcpServers ?? {}).length === 0 ||
      session.capabilities.supportsMcpServers === true
    ) {
      return;
    }
    await this.closeUnregisteredSession(session);
    throw new Error(`Provider '${storedConfig.provider}' does not support MCP servers`);
  }

  private async initializeAgentTimelineForRegister(params: {
    agentId: string;
    now: Date;
    options:
      | {
          timeline?: AgentTimelineItem[];
          timelineRows?: AgentTimelineRow[];
          timelineNextSeq?: number;
          persistence?: AgentPersistenceHandle;
          createdAt?: Date;
          updatedAt?: Date;
        }
      | undefined;
  }): Promise<{ durableTimelineHasRows: boolean }> {
    const { agentId, now, options } = params;
    const timelineAlreadyPrimed = this.timelineStore.has(agentId);
    const timelineHasRows = timelineAlreadyPrimed && this.timelineStore.getRows(agentId).length > 0;
    const explicitTimelineSeed = buildExplicitTimelineSeedForRegister(now, options);
    const shouldSeedFromDurable =
      !explicitTimelineSeed && !timelineHasRows && this.durableTimelineStore;
    const durableTimelineSeed = shouldSeedFromDurable
      ? await this.loadCommittedTimelineSeed(agentId, now)
      : null;
    const durableTimelineHasRows =
      timelineAlreadyPrimed ||
      (durableTimelineSeed != null && (durableTimelineSeed.nextSeq ?? 1) > 1);
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
          persistence?: AgentPersistenceHandle;
          workspaceId?: string;
          owner?: AgentOwner;
        }
      | undefined;
  }): ActiveManagedAgent {
    const { resolvedAgentId, session, config, now, durableTimelineHasRows, options } = params;
    return {
      id: resolvedAgentId,
      provider: config.provider,
      cwd: config.cwd,
      workspaceId: options?.workspaceId,
      owner: options?.owner,
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
      activeTurnId: null,
      activeTurnStartedAt: null,
      foregroundTurnWaiters: new Set<ForegroundTurnWaiter>(),
      finalizedForegroundTurnIds: new Set<string>(),
      unsubscribeSession: null,
      persistence: attachPersistenceCwd(
        options?.persistence ?? session.describePersistence(),
        config.cwd,
      ),
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
    const committed = await this.durableTimelineStore.fetchCommitted(agentId, { limit: 0 });
    return {
      rows: committed.rows,
      epoch: committed.epoch,
      nextSeq: committed.window.nextSeq,
      timestamp: now.toISOString(),
    };
  }

  private prepareAgentForClosure(
    agent: LiveManagedAgent,
    cancelReason: string,
  ): ManagedAgentClosed {
    this.fenceSessionGeneration(agent, { settlePendingStart: true });
    this.agentStreamCoalescer.flushAndDiscard(agent.id);
    this.agents.delete(agent.id);
    this.previousStatuses.delete(agent.id);
    this.runs.cancelWaiters(agent, (turnId) => ({
      type: "turn_canceled",
      provider: agent.provider,
      reason: cancelReason,
      turnId,
    }));
    this.runs.clearAgentRun(agent.id);
    return {
      ...agent,
      lifecycle: "closed",
      session: null,
      activeForegroundTurnId: null,
      activeTurnId: null,
      activeTurnStartedAt: null,
      pendingPermissions: new Map(),
      bufferedPermissionResolutions: new Map(),
      inFlightPermissionResponses: new Set(),
      pendingReplacement: false,
      foregroundTurnWaiters: new Set(),
      finalizedForegroundTurnIds: new Set(),
      unsubscribeSession: null,
    };
  }

  private invalidateSessionGeneration(agentId: string): void {
    this.sessionGenerationTokens.delete(agentId);
    this.latestTurnTokens.delete(agentId);
    this.turnTokensById.delete(agentId);
  }

  private fenceSessionGeneration(
    agent: ActiveManagedAgent,
    options?: { settlePendingStart?: boolean },
  ): void {
    const generation = this.sessionGenerationTokens.get(agent.id);
    const pendingRun = this.runs.getPendingRun(agent.id);
    if (
      options?.settlePendingStart &&
      generation !== undefined &&
      pendingRun?.generation === generation &&
      pendingRun.start.status === "pending"
    ) {
      pendingRun.start = {
        status: "failed",
        error: "Agent session generation was fenced before turn start",
      };
      pendingRun.stagedEvents.length = 0;
      this.runs.settleForegroundRun(agent.id, pendingRun.token);
    }
    this.invalidateSessionGeneration(agent.id);
    if (agent.unsubscribeSession) {
      agent.unsubscribeSession();
      agent.unsubscribeSession = null;
    }
  }

  private discardRetainedAgentState(agentId: string): void {
    this.timelineStore.delete(agentId);
    for (const event of this.providerSubagents.deleteParent(agentId)) {
      this.dispatch({ type: "provider_subagent", event });
    }
  }

  private emitClosedAgent(agent: ManagedAgentClosed, options?: { persist?: boolean }): void {
    this.emitState(agent, options);
  }
  private subscribeToSession(agent: ActiveManagedAgent): void {
    if (agent.unsubscribeSession) {
      return;
    }
    const agentId = agent.id;
    const generation = this.sessionGenerationTokens.get(agentId);
    if (!generation) {
      throw new Error(`Agent ${agentId} session generation is not registered`);
    }
    const unsubscribe = agent.session.subscribe((event: AgentStreamEvent) => {
      this.enqueueSessionEvent(agentId, event, generation);
    });
    agent.unsubscribeSession = unsubscribe;
  }

  private enqueueSessionEvent(
    agentId: string,
    event: AgentStreamEvent,
    generation = this.sessionGenerationTokens.get(agentId),
    turnToken = this.resolveTurnTokenForEvent(agentId, event),
  ): void {
    if (!generation || this.sessionGenerationTokens.get(agentId) !== generation) {
      return;
    }
    const queuedEvent: PendingAgentSessionEvent = {
      generation,
      event,
      ...(turnToken !== undefined ? { turnToken } : {}),
    };
    this.logger.trace(
      {
        agentId,
        provider: event.provider,
        sessionId: this.agents.get(agentId)?.persistence?.sessionId ?? undefined,
        turnId: getAgentStreamEventTurnId(event),
        event,
      },
      "agent.manager.enqueue",
    );
    const steerBarrier = this.steerEventBarriers.get(agentId);
    if (steerBarrier) {
      steerBarrier.events.push(queuedEvent);
      return;
    }
    const pendingRun = this.runs.getPendingRun(agentId);
    if (pendingRun?.start.status === "pending") {
      pendingRun.stagedEvents.push(queuedEvent);
      return;
    }
    const previous = this.sessionEventTails.get(agentId) ?? Promise.resolve();
    const processing = previous
      .catch(() => undefined)
      .then(async () => {
        if (this.sessionGenerationTokens.get(agentId) !== queuedEvent.generation) {
          return;
        }
        const current = this.agents.get(agentId);
        if (!current) {
          return;
        }
        if (current.session == null) {
          return;
        }
        this.logger.trace(
          {
            agentId,
            provider: queuedEvent.event.provider,
            sessionId: current.persistence?.sessionId ?? undefined,
            turnId: getAgentStreamEventTurnId(queuedEvent.event),
            event: queuedEvent.event,
          },
          "agent.manager.dequeue",
        );
        await this.dispatchSessionEvent(
          current,
          queuedEvent.event,
          queuedEvent.generation,
          queuedEvent.turnToken,
        );
        return;
      })
      .catch((err) => {
        this.logger.error(
          { err, agentId, eventType: queuedEvent.event.type },
          "Failed to process session event",
        );
      });
    const bounded = this.waitWithTimeout({
      operation: processing,
      timeoutMs: this.rescueTimeouts.reloadSessionCloseMs,
      onLateError: (error) => {
        this.logger.warn(
          { err: error, agentId, eventType: queuedEvent.event.type },
          "Session event failed after processing timeout",
        );
      },
    }).then((result) => {
      if (result === "timed_out") {
        this.logger.warn(
          { agentId, eventType: queuedEvent.event.type },
          "Timed out processing session event",
        );
      }
      return undefined;
    });

    // Keep the real processing tail for ordering. Track a bounded observer separately so flush
    // cannot hang on a provider callback, while a live session still serializes later events
    // behind the unresolved callback until lifecycle fencing detaches the tail.
    this.sessionEventTails.set(agentId, processing);
    this.trackBackgroundTask(bounded);
    void processing.finally(() => {
      if (this.sessionEventTails.get(agentId) === processing) {
        this.sessionEventTails.delete(agentId);
      }
    });
  }

  /**
   * Provider mutations may synchronously emit config events that are processed through the
   * asynchronous session queue. Apply those events before committing the mutation's explicit
   * manager state so call order remains authoritative.
   */
  private async drainSessionEvents(agentId: string): Promise<void> {
    while (true) {
      const tail = this.sessionEventTails.get(agentId);
      if (!tail) {
        return;
      }
      const result = await this.waitWithTimeout({
        operation: tail,
        timeoutMs: this.rescueTimeouts.reloadSessionCloseMs,
        onLateError: (error) => {
          this.logger.warn(
            { err: error, agentId },
            "Session event queue failed after drain timeout",
          );
        },
      });
      if (result === "timed_out") {
        this.logger.warn(
          { agentId, timeoutMs: this.rescueTimeouts.reloadSessionCloseMs },
          "Timed out draining session events",
        );
        // Do not let a retired generation's stuck tail serialize the replacement session. The
        // tail's callbacks still carry their generation fence and will safely no-op if they ever
        // resume, so dropping the active pointer is enough to detach it from future events.
        if (this.sessionEventTails.get(agentId) === tail) {
          this.sessionEventTails.delete(agentId);
        }
        return;
      }
      if (this.sessionEventTails.get(agentId) === tail) {
        return;
      }
    }
  }

  private async dispatchSessionEvent(
    agent: ActiveManagedAgent,
    event: AgentStreamEvent,
    sessionGeneration?: symbol,
    turnToken?: string,
  ): Promise<void> {
    if (
      sessionGeneration !== undefined &&
      (this.sessionGenerationTokens.get(agent.id) !== sessionGeneration ||
        this.agents.get(agent.id) !== agent)
    ) {
      return;
    }
    if (turnToken !== undefined && !this.isLiveTurnTokenCurrent(agent.id, turnToken)) {
      return;
    }
    await this.drainCoalescedTimeline(agent.id);
    if (event.type === "provider_subagent") {
      const update = this.providerSubagents.apply(agent.id, event.provider, event.event);
      this.dispatch({ type: "provider_subagent", event: update });
      return;
    }
    const turnId = getAgentStreamEventTurnId(event);
    const matchingWaiters = this.runs.getMatchingWaiters(agent, turnId);
    this.logger.trace(
      {
        agentId: agent.id,
        provider: event.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId,
        matchingWaiterCount: matchingWaiters.length,
        event,
      },
      "agent.manager.dispatch_session_event",
    );

    const shouldNotifyWaiters = await this.handleStreamEvent(agent, event, {
      sessionGeneration,
      turnToken,
    });
    if (
      sessionGeneration !== undefined &&
      (this.sessionGenerationTokens.get(agent.id) !== sessionGeneration ||
        this.agents.get(agent.id) !== agent)
    ) {
      return;
    }
    if (turnToken !== undefined && !this.isLatestTurnTokenCurrent(agent.id, turnToken)) {
      return;
    }

    if (!shouldNotifyWaiters) {
      return;
    }

    this.runs.notifyWaiters(matchingWaiters, event, {
      terminal: isTurnTerminalEvent(event),
    });
    this.logger.trace(
      {
        agentId: agent.id,
        provider: event.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId,
        notifiedWaiterCount: matchingWaiters.length,
        terminal: isTurnTerminalEvent(event),
        event,
      },
      "agent.manager.notify_waiters",
    );
  }

  private async resolveInitialPersistedTitle(
    agentId: string,
    config: AgentSessionConfig,
    fallbackTitle: string | null,
  ): Promise<string | null> {
    const existing = await this.registry?.get(agentId);
    if (existing) {
      return existing.title ?? null;
    }
    const explicitTitle =
      typeof config.title === "string" && config.title.trim().length > 0
        ? config.title.trim()
        : null;
    return explicitTitle ?? fallbackTitle;
  }

  private async persistSnapshot(
    agent: ManagedAgent,
    options?: {
      title?: string | null;
      internal?: boolean;
      generation?: symbol;
      turnToken?: string;
    },
  ): Promise<void> {
    if (!this.registry) {
      return;
    }
    const currentAgent = this.agents.get(agent.id);
    if (currentAgent !== undefined && currentAgent !== agent) {
      return;
    }
    const generation =
      options?.generation ??
      (currentAgent === agent ? this.sessionGenerationTokens.get(agent.id) : undefined);
    if (currentAgent === agent && generation === undefined) {
      return;
    }
    if (
      generation !== undefined &&
      (this.sessionGenerationTokens.get(agent.id) !== generation ||
        this.agents.get(agent.id) !== agent)
    ) {
      return;
    }
    if (
      options?.turnToken !== undefined &&
      !this.isLatestTurnTokenCurrent(agent.id, options.turnToken)
    ) {
      return;
    }
    // Don't persist internal agents - they're ephemeral system tasks
    if (agent.internal) {
      return;
    }
    const shouldCommit = generation
      ? () =>
          this.isSessionGenerationCurrent(agent, generation) &&
          (options?.turnToken === undefined ||
            this.isLatestTurnTokenCurrent(agent.id, options.turnToken))
      : undefined;
    await this.registry.applySnapshot(
      agent,
      generation && options?.generation === undefined ? { ...options, generation } : options,
      shouldCommit,
    );
  }

  private requireRegistry(): AgentStorage {
    if (!this.registry) {
      throw new Error("Agent storage unavailable");
    }
    return this.registry;
  }

  private async refreshSessionState(
    agent: ActiveManagedAgent,
    options?: { emit?: boolean; generation?: symbol; turnToken?: string },
  ): Promise<void> {
    const generation = options?.generation ?? this.sessionGenerationTokens.get(agent.id);
    if (!generation || !this.isRefreshCurrent(agent, generation, options?.turnToken)) {
      return;
    }
    if (!(await this.refreshAvailableModes(agent, generation, options?.turnToken))) return;
    if (!(await this.refreshCurrentMode(agent, generation, options?.turnToken))) return;
    if (!this.refreshPendingPermissions(agent, generation, options?.turnToken)) return;
    if (!this.isRefreshCurrent(agent, generation, options?.turnToken)) return;
    this.syncFeaturesFromSession(agent);
    await this.refreshRuntimeInfo(agent, { ...options, generation });
  }

  private async refreshAvailableModes(
    agent: ActiveManagedAgent,
    generation: symbol,
    turnToken?: string,
  ): Promise<boolean> {
    try {
      const modes = await agent.session.getAvailableModes();
      if (!this.isRefreshCurrent(agent, generation, turnToken)) return false;
      agent.availableModes = modes;
    } catch {
      if (!this.isRefreshCurrent(agent, generation, turnToken)) return false;
      agent.availableModes = [];
    }
    return true;
  }

  private async refreshCurrentMode(
    agent: ActiveManagedAgent,
    generation: symbol,
    turnToken?: string,
  ): Promise<boolean> {
    try {
      const currentModeId = await agent.session.getCurrentMode();
      if (!this.isRefreshCurrent(agent, generation, turnToken)) return false;
      agent.currentModeId = currentModeId;
    } catch {
      if (!this.isRefreshCurrent(agent, generation, turnToken)) return false;
      agent.currentModeId = null;
    }
    return true;
  }

  private refreshPendingPermissions(
    agent: ActiveManagedAgent,
    generation: symbol,
    turnToken?: string,
  ): boolean {
    try {
      const pending = agent.session.getPendingPermissions();
      if (!this.isRefreshCurrent(agent, generation, turnToken)) return false;
      agent.pendingPermissions = new Map(pending.map((request) => [request.id, request]));
    } catch {
      if (!this.isRefreshCurrent(agent, generation, turnToken)) return false;
      agent.pendingPermissions.clear();
    }
    return true;
  }

  private async refreshRuntimeInfo(
    agent: ActiveManagedAgent,
    options?: { emit?: boolean; generation?: symbol; turnToken?: string },
  ): Promise<void> {
    const generation = options?.generation ?? this.sessionGenerationTokens.get(agent.id);
    if (!generation || !this.isRefreshCurrent(agent, generation, options?.turnToken)) {
      return;
    }
    try {
      const newInfo = await agent.session.getRuntimeInfo();
      if (!this.isRefreshCurrent(agent, generation, options?.turnToken)) return;
      const changed = this.runtimeInfoChanged(agent.runtimeInfo, newInfo);
      agent.runtimeInfo = newInfo;
      if (!agent.persistence && newInfo.sessionId) {
        agent.persistence = attachPersistenceCwd(
          { provider: agent.provider, sessionId: newInfo.sessionId },
          agent.cwd,
        );
      }
      // Emit state if runtimeInfo changed so clients get the updated model
      if (changed && options?.emit !== false) {
        this.emitState(agent, { generation, turnToken: options?.turnToken });
      }
    } catch {
      // Keep existing runtimeInfo if refresh fails.
    }
  }

  private runtimeInfoChanged(
    previous: ManagedAgent["runtimeInfo"],
    next: NonNullable<ManagedAgent["runtimeInfo"]>,
  ): boolean {
    return (
      next.model !== previous?.model ||
      next.thinkingOptionId !== previous?.thinkingOptionId ||
      next.sessionId !== previous?.sessionId ||
      next.modeId !== previous?.modeId
    );
  }

  private async hydrateTimelineFromLegacyProviderHistory(
    agent: ActiveManagedAgent,
    options?: HydrateTimelineOptions,
    generation?: symbol,
  ): Promise<void> {
    const sessionGeneration = generation ?? this.requireSessionGeneration(agent.id);
    if (!this.isSessionGenerationCurrent(agent, sessionGeneration)) return;
    if (agent.historyPrimed && !options?.force) {
      return;
    }

    const broadcast = options?.broadcast ?? false;
    const broadcastTimeline = options?.broadcastTimeline ?? broadcast;

    if (options?.force) {
      await this.forceHydrateTimelineFromLegacyProviderHistory(
        agent,
        typeof broadcast === "function" ? broadcast() : broadcast,
        typeof broadcastTimeline === "function" ? broadcastTimeline() : broadcastTimeline,
        sessionGeneration,
        options?.turnToken,
      );
      return;
    }

    await this.primeTimelineFromLegacyProviderHistory(
      agent,
      broadcast,
      sessionGeneration,
      options?.turnToken,
    );
  }

  // Force hydration builds a detached replacement before touching live memory.
  // oxlint-disable-next-line complexity
  private async forceHydrateTimelineFromLegacyProviderHistory(
    agent: ActiveManagedAgent,
    broadcast: boolean,
    broadcastTimeline: boolean,
    generation: symbol,
    turnToken?: string,
  ): Promise<void> {
    const historyEvents: Extract<AgentStreamEvent, { type: "timeline" }>[] = [];
    const providerSubagentEvents: Extract<AgentStreamEvent, { type: "provider_subagent" }>[] = [];
    for await (const rawEvent of agent.session.streamHistory()) {
      if (!this.isHydrationCurrent(agent, generation, turnToken)) return;
      const event = limitAgentStreamEventContent(rawEvent);
      if (event.type === "timeline") {
        if (event.item.type === "user_message" && isSystemInjectedEnvelope(event.item.text)) {
          continue;
        }
        historyEvents.push(event);
      } else if (event.type === "provider_subagent") {
        providerSubagentEvents.push(event);
      }
    }

    if (!this.isHydrationCurrent(agent, generation, turnToken)) return;

    const candidateStore = new InMemoryAgentTimelineStore();
    candidateStore.initialize(agent.id, { timestamp: new Date().toISOString() });
    const candidateRows: AgentTimelineRow[] = [];
    for (const event of historyEvents) {
      candidateRows.push(
        candidateStore.append(
          agent.id,
          event.item,
          event.timestamp ? { timestamp: event.timestamp } : undefined,
        ),
      );
    }
    const candidateEpoch = candidateStore.getEpoch(agent.id);
    const accepted = await this.replaceCommittedTimeline(
      agent.id,
      candidateRows,
      generation,
      turnToken,
      { epoch: candidateEpoch, nextSeq: candidateRows.length + 1 },
    );
    if (!accepted || !this.isHydrationCurrent(agent, generation, turnToken)) return;

    this.agentStreamCoalescer.discard(agent.id);
    this.timelineStore.initialize(agent.id, {
      rows: candidateRows,
      epoch: candidateEpoch,
      nextSeq: candidateRows.length + 1,
    });
    if (!this.isHydrationCurrent(agent, generation, turnToken)) return;
    agent.historyPrimed = true;

    const removedSubagents = this.providerSubagents.deleteParent(agent.id);
    for (const event of removedSubagents) {
      if (broadcast && this.isHydrationCurrent(agent, generation, turnToken)) {
        this.dispatch({ type: "provider_subagent", event });
      }
    }
    for (const event of providerSubagentEvents) {
      if (!this.isHydrationCurrent(agent, generation, turnToken)) return;
      const update = this.providerSubagents.apply(agent.id, event.provider, event.event);
      if (broadcast && this.isHydrationCurrent(agent, generation, turnToken)) {
        this.dispatch({ type: "provider_subagent", event: update });
      }
    }
    for (const [index, event] of historyEvents.entries()) {
      if (!this.isHydrationCurrent(agent, generation, turnToken)) return;
      const row = candidateRows[index];
      if (broadcastTimeline) {
        this.dispatchStream(
          agent.id,
          event,
          {
            seq: row.seq,
            epoch: candidateEpoch,
            timestamp: row.timestamp,
          },
          generation,
          turnToken,
        );
      }
    }
    if (!this.isHydrationCurrent(agent, generation, turnToken)) return;
    this.touchUpdatedAt(agent);
    this.emitState(agent, { generation, turnToken });
  }

  // History hydration intentionally keeps its event filtering and persistence decisions together.
  // oxlint-disable-next-line complexity
  private async primeTimelineFromLegacyProviderHistory(
    agent: ActiveManagedAgent,
    broadcast: boolean | (() => boolean),
    generation: symbol,
    turnToken?: string,
  ): Promise<void> {
    const timelineEvents: Extract<AgentStreamEvent, { type: "timeline" }>[] = [];
    const providerSubagentEvents: Extract<AgentStreamEvent, { type: "provider_subagent" }>[] = [];
    if (!this.isHydrationCurrent(agent, generation, turnToken)) return;
    try {
      for await (const rawEvent of agent.session.streamHistory()) {
        if (!this.isHydrationCurrent(agent, generation, turnToken)) return;
        const event = limitAgentStreamEventContent(rawEvent);
        if (event.type === "provider_subagent") {
          providerSubagentEvents.push(event);
          continue;
        }
        if (event.type !== "timeline") {
          continue;
        }
        if (event.item.type === "user_message" && isSystemInjectedEnvelope(event.item.text)) {
          continue;
        }
        timelineEvents.push(event);
      }
    } catch (error) {
      this.logger.warn({ err: error, agentId: agent.id }, "Failed to hydrate provider history");
      throw error;
    }
    if (!this.isHydrationCurrent(agent, generation, turnToken)) return;
    const currentRows = this.timelineStore.getRows(agent.id);
    const currentFetch = this.timelineStore.fetch(agent.id, { limit: 0 });
    const candidateStore = new InMemoryAgentTimelineStore();
    candidateStore.initialize(agent.id, {
      rows: currentRows,
      epoch: currentFetch.epoch,
      nextSeq: currentFetch.window.nextSeq,
    });
    const candidateEvents: Array<{
      event: Extract<AgentStreamEvent, { type: "timeline" }>;
      row: AgentTimelineRow;
    }> = [];
    const committedItemCounts = new Map<string, number>();
    for (const row of currentRows) {
      const key = JSON.stringify(row.item);
      committedItemCounts.set(key, (committedItemCounts.get(key) ?? 0) + 1);
    }
    for (const entry of timelineEvents) {
      if (entry.item.type === "user_message" && entry.item.clientMessageId) {
        const existing = candidateStore.getSubmittedUserMessage(
          agent.id,
          entry.item.clientMessageId,
        );
        if (existing) {
          candidateStore.updateSubmittedUserMessage(agent.id, entry.item.clientMessageId, {
            ...(entry.turnId !== undefined ? { turnId: entry.turnId } : {}),
            ...(entry.item.messageId !== undefined
              ? { providerMessageId: entry.item.messageId }
              : {}),
          });
          continue;
        }
      }
      const itemKey = JSON.stringify(entry.item);
      const committedCount = committedItemCounts.get(itemKey) ?? 0;
      if (committedCount > 0) {
        committedItemCounts.set(itemKey, committedCount - 1);
        continue;
      }
      const row = candidateStore.append(
        agent.id,
        entry.item,
        entry.timestamp ? { timestamp: entry.timestamp } : undefined,
      );
      candidateEvents.push({ event: entry, row });
    }
    const candidateRows = candidateStore.getRows(agent.id);
    const accepted = await this.replaceCommittedTimeline(
      agent.id,
      candidateRows,
      generation,
      turnToken,
      {
        epoch: candidateStore.getEpoch(agent.id),
        nextSeq: candidateStore.fetch(agent.id, { limit: 0 }).window.nextSeq,
      },
    );
    if (!accepted || !this.isHydrationCurrent(agent, generation, turnToken)) return;
    this.timelineStore.initialize(agent.id, {
      rows: candidateRows,
      epoch: candidateStore.getEpoch(agent.id),
      nextSeq: candidateStore.fetch(agent.id, { limit: 0 }).window.nextSeq,
    });
    if (!this.isHydrationCurrent(agent, generation, turnToken)) return;
    agent.historyPrimed = true;

    const shouldBroadcast = typeof broadcast === "function" ? broadcast() : broadcast;
    for (const event of providerSubagentEvents) {
      if (!this.isHydrationCurrent(agent, generation, turnToken)) return;
      const update = this.providerSubagents.apply(agent.id, event.provider, event.event);
      if (shouldBroadcast) {
        this.dispatch({ type: "provider_subagent", event: update });
      }
    }
    for (const { event, row } of candidateEvents) {
      if (!this.isHydrationCurrent(agent, generation, turnToken)) return;
      if (shouldBroadcast) {
        this.dispatchStream(
          agent.id,
          event,
          {
            seq: row.seq,
            epoch: candidateStore.getEpoch(agent.id),
            timestamp: row.timestamp,
          },
          generation,
          turnToken,
        );
      }
    }
  }

  private notifyForegroundTurnWaiters(
    agentId: string,
    event: AgentStreamEvent,
    generation?: symbol,
    turnToken?: string,
  ): void {
    if (generation !== undefined && !this.isSessionGenerationCurrentById(agentId, generation)) {
      return;
    }
    if (turnToken !== undefined && !this.isLatestTurnTokenCurrent(agentId, turnToken)) {
      return;
    }
    const turnId = getAgentStreamEventTurnId(event);
    if (turnId == null) {
      return;
    }

    const agent = this.agents.get(agentId);
    if (!agent) {
      return;
    }

    this.runs.notifyAgentWaiters(agent, event);
    this.logger.trace(
      {
        agentId,
        provider: event.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId,
        event,
      },
      "agent.manager.notify_waiters.coalesced",
    );
  }

  private enqueueCoalescedTimelineCommit(payload: AgentStreamCoalescerFlush): void {
    const previous = this.coalescedTimelineTails.get(payload.agentId) ?? Promise.resolve();
    const operation = previous.then(async () => {
      if (
        (payload.generation !== undefined &&
          !this.isSessionGenerationCurrentById(payload.agentId, payload.generation)) ||
        (payload.turnToken !== undefined &&
          !this.isLatestTurnTokenCurrent(payload.agentId, payload.turnToken))
      ) {
        return undefined;
      }
      const event = await this.recordAndDispatchTimelineItem(
        payload.agentId,
        payload.item,
        payload.provider,
        payload.turnId,
        {
          sessionGeneration: payload.generation,
          turnToken: payload.turnToken,
        },
      );
      this.notifyForegroundTurnWaiters(
        payload.agentId,
        event,
        payload.generation,
        payload.turnToken,
      );
      return undefined;
    });
    const settled = operation.catch((error) => {
      this.logger.error(
        { err: error, agentId: payload.agentId, itemType: payload.item.type },
        "Failed to commit coalesced timeline item",
      );
    });
    this.coalescedTimelineTails.set(payload.agentId, settled);
    this.trackBackgroundTask(settled);
    void settled.then(() => {
      if (this.coalescedTimelineTails.get(payload.agentId) === settled) {
        this.coalescedTimelineTails.delete(payload.agentId);
      }
      return undefined;
    });
  }

  private async drainCoalescedTimeline(agentId: string): Promise<void> {
    const tail = this.coalescedTimelineTails.get(agentId);
    if (!tail) {
      return;
    }
    const result = await this.waitWithTimeout({
      operation: tail,
      timeoutMs: this.rescueTimeouts.durableTimelineMutationMs,
      onLateError: (error) => {
        this.logger.warn(
          { err: error, agentId },
          "Coalesced timeline mutation failed after drain timeout",
        );
      },
    });
    if (result === "timed_out") {
      this.logger.warn(
        { agentId, timeoutMs: this.rescueTimeouts.durableTimelineMutationMs },
        "Timed out draining coalesced timeline mutations",
      );
    }
  }

  // This is the final generation/turn gate before provider events mutate state or publish.
  // oxlint-disable-next-line complexity
  private async handleStreamEvent(
    agent: ActiveManagedAgent,
    event: AgentStreamEvent,
    options?: HandleStreamEventOptions,
  ): Promise<boolean> {
    const resolvedTurnToken = options?.turnToken ?? this.resolveTurnTokenForEvent(agent.id, event);
    if (resolvedTurnToken !== undefined) {
      options = { ...options, turnToken: resolvedTurnToken };
    }
    if (!this.shouldHandleSessionEvent(agent, options)) {
      return false;
    }
    event = limitAgentStreamEventContent(event);
    const identified = attachManagedTurnIdentity(agent, event, options?.fromHistory === true);
    event = identified.event;
    const eventTurnId = identified.turnId;
    const isForegroundEvent = agent.activeForegroundTurnId === eventTurnId;
    this.traceHandleStreamEventStart(agent, event, eventTurnId, isForegroundEvent);
    if (
      eventTurnId &&
      isTurnTerminalEvent(event) &&
      this.runs.hasFinalizedTurn(agent, eventTurnId)
    ) {
      return false;
    }

    // Only update timestamp for live events, not history replay
    if (!options?.fromHistory) {
      this.touchUpdatedAt(agent);
      if (
        this.agentStreamCoalescer.handle(
          agent.id,
          event,
          options?.sessionGeneration,
          options?.turnToken,
        )
      ) {
        this.traceCoalescerBuffered(agent, event, eventTurnId);
        await this.drainCoalescedTimeline(agent.id);
        return false;
      }
      this.agentStreamCoalescer.flushFor(agent.id);
      await this.drainCoalescedTimeline(agent.id);
    }

    let terminalDisposition: ActiveTurnTerminalDisposition = "untracked";
    if (isTurnTerminalEvent(event)) {
      terminalDisposition = this.applyActiveTurnTerminal(
        agent,
        eventTurnId,
        options?.fromHistory === true,
      );
    }

    const flags: StreamEventFlags = { shouldDispatchEvent: true, shouldNotifyWaiters: true };

    const dispatchPromise = this.dispatchStreamEventByType({
      agent,
      event,
      options,
      isForegroundEvent,
      eventTurnId,
      terminalDisposition,
      flags,
    });
    if (dispatchPromise) {
      await dispatchPromise;
    }

    if (!this.shouldHandleSessionEvent(agent, options)) {
      return false;
    }

    if (!options?.fromHistory) {
      if (isTurnTerminalEvent(event)) {
        this.runs.settleTerminalRun(agent.id, eventTurnId);
        if (isForegroundEvent) {
          this.finalizeForegroundTurn(agent, eventTurnId, options?.turnToken);
        }
      }

      if (flags.shouldDispatchEvent) {
        this.dispatchStream(
          agent.id,
          event,
          { timestamp: new Date().toISOString() },
          options?.sessionGeneration,
          options?.turnToken,
        );
      }
    }

    this.traceHandleStreamEventEnd(agent, event, eventTurnId, flags);

    return flags.shouldNotifyWaiters;
  }

  private traceHandleStreamEventStart(
    agent: ActiveManagedAgent,
    event: AgentStreamEvent,
    turnId: string | undefined,
    isForegroundEvent: boolean,
  ): void {
    this.logger.trace(
      {
        agentId: agent.id,
        provider: event.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId,
        lifecycle: agent.lifecycle,
        activeForegroundTurnId: agent.activeForegroundTurnId,
        isForegroundEvent,
        event,
      },
      "agent.manager.handle_stream_event.start",
    );
  }

  private traceCoalescerBuffered(
    agent: ActiveManagedAgent,
    event: AgentStreamEvent,
    turnId: string | undefined,
  ): void {
    this.logger.trace(
      {
        agentId: agent.id,
        provider: event.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId,
        event,
      },
      "agent.manager.coalescer.buffer",
    );
  }

  private traceHandleStreamEventEnd(
    agent: ActiveManagedAgent,
    event: AgentStreamEvent,
    turnId: string | undefined,
    flags: StreamEventFlags,
  ): void {
    this.logger.trace(
      {
        agentId: agent.id,
        provider: event.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId,
        lifecycle: agent.lifecycle,
        activeForegroundTurnId: agent.activeForegroundTurnId,
        shouldDispatchEvent: flags.shouldDispatchEvent,
        shouldNotifyWaiters: flags.shouldNotifyWaiters,
        event,
      },
      "agent.manager.handle_stream_event.end",
    );
  }

  // This dispatcher owns the provider event matrix so every event reaches the same generation-aware handlers.
  // oxlint-disable-next-line complexity
  private dispatchStreamEventByType(params: {
    agent: ActiveManagedAgent;
    event: AgentStreamEvent;
    options: HandleStreamEventOptions | undefined;
    isForegroundEvent: boolean;
    eventTurnId: string | undefined;
    terminalDisposition: ActiveTurnTerminalDisposition;
    flags: StreamEventFlags;
  }): Promise<void> | undefined {
    const { agent, event, options, isForegroundEvent, eventTurnId, terminalDisposition, flags } =
      params;
    switch (event.type) {
      case "thread_started":
        this.onStreamThreadStarted(agent, options);
        return undefined;
      case "usage_updated":
        agent.lastUsage = event.usage;
        this.emitState(agent, {
          generation: options?.sessionGeneration,
          turnToken: options?.turnToken,
        });
        return undefined;
      case "mode_changed":
        agent.currentModeId = event.currentModeId;
        agent.availableModes = event.availableModes;
        if (agent.runtimeInfo) {
          agent.runtimeInfo = { ...agent.runtimeInfo, modeId: event.currentModeId };
        }
        flags.shouldDispatchEvent = false;
        this.emitState(agent, {
          generation: options?.sessionGeneration,
          turnToken: options?.turnToken,
        });
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
        this.emitState(agent, {
          generation: options?.sessionGeneration,
          turnToken: options?.turnToken,
        });
        return undefined;
      case "thinking_option_changed":
        agent.config.thinkingOptionId = event.thinkingOptionId ?? undefined;
        if (agent.runtimeInfo) {
          agent.runtimeInfo = {
            ...agent.runtimeInfo,
            thinkingOptionId: event.thinkingOptionId,
          };
        }
        flags.shouldDispatchEvent = false;
        this.emitState(agent, {
          generation: options?.sessionGeneration,
          turnToken: options?.turnToken,
        });
        return undefined;
      case "timeline":
        return this.onStreamTimelineEvent({ agent, event, options, flags });
      case "turn_completed":
        this.onStreamTurnCompleted({
          agent,
          event,
          eventTurnId,
          isForegroundEvent,
          terminalDisposition,
          options,
        });
        return undefined;
      case "turn_failed":
        return this.onStreamTurnFailed({
          agent,
          event,
          eventTurnId,
          isForegroundEvent,
          terminalDisposition,
          options,
        });
      case "turn_canceled":
        this.onStreamTurnCanceled({
          agent,
          event,
          eventTurnId,
          isForegroundEvent,
          terminalDisposition,
          options,
        });
        return undefined;
      case "turn_started":
        this.onStreamTurnStarted({
          agent,
          eventTurnId,
          isForegroundEvent,
          flags,
          options,
        });
        return undefined;
      case "permission_requested":
        this.onStreamPermissionRequested(agent, event, options);
        return undefined;
      case "permission_resolved":
        this.onStreamPermissionResolved({ agent, event, options, flags });
        return undefined;
      default:
        return undefined;
    }
  }

  private onStreamThreadStarted(
    agent: ActiveManagedAgent,
    options?: HandleStreamEventOptions,
  ): void {
    if (!this.shouldHandleSessionEvent(agent, options)) return;
    const previousSessionId = agent.persistence?.sessionId ?? null;
    const handle = agent.session.describePersistence();
    if (handle) {
      agent.persistence = attachPersistenceCwd(handle, agent.cwd);
      if (agent.persistence?.sessionId !== previousSessionId) {
        this.emitState(agent, {
          generation: options?.sessionGeneration,
          turnToken: options?.turnToken,
        });
      }
    }
    void this.refreshRuntimeInfo(agent, {
      generation: options?.sessionGeneration,
      turnToken: options?.turnToken,
    });
  }

  private async onStreamTimelineEvent(params: {
    agent: ActiveManagedAgent;
    event: Extract<AgentStreamEvent, { type: "timeline" }>;
    options: HandleStreamEventOptions | undefined;
    flags: StreamEventFlags;
  }): Promise<void> {
    const { agent, event, options, flags } = params;

    if (event.item.type === "user_message" && isSystemInjectedEnvelope(event.item.text)) {
      flags.shouldDispatchEvent = false;
      flags.shouldNotifyWaiters = false;
      return;
    }

    if (
      event.item.type === "user_message" &&
      event.item.clientMessageId &&
      (await this.reconcileSubmittedPromptEcho(
        agent,
        event.item,
        event.turnId,
        options?.sessionGeneration,
        options?.turnToken,
      ))
    ) {
      flags.shouldDispatchEvent = false;
      flags.shouldNotifyWaiters = false;
      return;
    }

    if (options?.fromHistory) {
      await this.recordTimeline(
        agent.id,
        event.item,
        event.timestamp ? { timestamp: event.timestamp } : undefined,
        options?.sessionGeneration,
        options?.turnToken,
      );
      flags.shouldDispatchEvent = false;
      flags.shouldNotifyWaiters = false;
      return;
    }

    await this.recordAndDispatchTimelineItem(agent.id, event.item, event.provider, event.turnId, {
      sessionGeneration: options?.sessionGeneration,
      turnToken: options?.turnToken,
    });
    if (event.item.type === "user_message") {
      if (!this.shouldHandleSessionEvent(agent, options)) return;
      agent.lastUserMessageAt = new Date();
      this.emitState(agent, {
        generation: options?.sessionGeneration,
        turnToken: options?.turnToken,
      });
    }
    flags.shouldDispatchEvent = false;
    flags.shouldNotifyWaiters = true;
  }

  private onStreamTurnCompleted(params: {
    agent: ActiveManagedAgent;
    event: Extract<AgentStreamEvent, { type: "turn_completed" }>;
    eventTurnId: string | undefined;
    isForegroundEvent: boolean;
    terminalDisposition: ActiveTurnTerminalDisposition;
    options: HandleStreamEventOptions | undefined;
  }): void {
    const { agent, event, eventTurnId, isForegroundEvent, terminalDisposition, options } = params;
    this.logger.trace(
      {
        agentId: agent.id,
        provider: agent.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId: eventTurnId,
        lifecycle: agent.lifecycle,
        activeForegroundTurnId: agent.activeForegroundTurnId,
      },
      "agent.manager.turn.completed",
    );
    if (terminalDisposition === "stale") return;
    if (event.usage) {
      agent.lastUsage = { ...agent.lastUsage, ...event.usage };
    }
    // If no usage on turn_completed, keep lastUsage as-is so context window
    // data accumulated during streaming isn't lost when the provider omits
    // it from the completion event.
    agent.lastError = undefined;
    if (
      !isForegroundEvent &&
      !agent.activeForegroundTurnId &&
      agent.lifecycle !== "idle" &&
      !agent.pendingReplacement
    ) {
      (agent as ActiveManagedAgent).lifecycle = "idle";
      this.emitState(agent, {
        generation: options?.sessionGeneration,
        turnToken: options?.turnToken,
      });
    }
    void this.refreshRuntimeInfo(agent, {
      generation: options?.sessionGeneration,
      turnToken: options?.turnToken,
    });
  }

  private async onStreamTurnFailed(params: {
    agent: ActiveManagedAgent;
    event: Extract<AgentStreamEvent, { type: "turn_failed" }>;
    eventTurnId: string | undefined;
    isForegroundEvent: boolean;
    terminalDisposition: ActiveTurnTerminalDisposition;
    options: HandleStreamEventOptions | undefined;
  }): Promise<void> {
    const { agent, event, eventTurnId, isForegroundEvent, terminalDisposition, options } = params;
    this.logger.warn(
      {
        agentId: agent.id,
        provider: agent.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId: eventTurnId,
        lifecycle: agent.lifecycle,
        activeForegroundTurnId: agent.activeForegroundTurnId,
        eventTurnId,
        error: event.error,
        code: event.code,
        diagnostic: event.diagnostic,
      },
      "handleStreamEvent: turn_failed",
    );
    if (terminalDisposition === "stale") return;
    await this.appendSystemErrorTimelineMessage(
      agent,
      event.provider,
      this.formatTurnFailedMessage(event),
      options,
    );
    if (!this.shouldHandleSessionEvent(agent, options)) return;
    if (!isForegroundEvent && !agent.activeForegroundTurnId) {
      agent.lifecycle = "error";
    }
    agent.lastError = event.error;
    this.resolvePendingPermissionsForAgent(agent, event.provider, options, "Turn failed");
    if (!isForegroundEvent && !agent.activeForegroundTurnId) {
      this.emitState(agent, {
        generation: options?.sessionGeneration,
        turnToken: options?.turnToken,
      });
    }
  }

  private onStreamTurnCanceled(params: {
    agent: ActiveManagedAgent;
    event: Extract<AgentStreamEvent, { type: "turn_canceled" }>;
    eventTurnId: string | undefined;
    isForegroundEvent: boolean;
    terminalDisposition: ActiveTurnTerminalDisposition;
    options: HandleStreamEventOptions | undefined;
  }): void {
    const { agent, event, eventTurnId, isForegroundEvent, terminalDisposition, options } = params;
    this.logger.trace(
      {
        agentId: agent.id,
        provider: agent.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId: eventTurnId,
        lifecycle: agent.lifecycle,
        activeForegroundTurnId: agent.activeForegroundTurnId,
        eventTurnId,
      },
      "agent.manager.turn.canceled",
    );
    if (terminalDisposition === "stale") return;
    if (!isForegroundEvent && !agent.activeForegroundTurnId && !agent.pendingReplacement) {
      agent.lifecycle = "idle";
    }
    agent.lastError = undefined;
    this.resolvePendingPermissionsForAgent(agent, event.provider, options, "Interrupted");
    if (!isForegroundEvent && !agent.activeForegroundTurnId) {
      this.emitState(agent, {
        generation: options?.sessionGeneration,
        turnToken: options?.turnToken,
      });
    }
  }

  private onStreamTurnStarted(params: {
    agent: ActiveManagedAgent;
    eventTurnId: string | undefined;
    isForegroundEvent: boolean;
    flags: StreamEventFlags;
    options: HandleStreamEventOptions | undefined;
  }): void {
    const { agent, eventTurnId, isForegroundEvent, flags, options } = params;
    this.logger.trace(
      {
        agentId: agent.id,
        provider: agent.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId: eventTurnId,
        lifecycle: agent.lifecycle,
        activeForegroundTurnId: agent.activeForegroundTurnId,
      },
      "agent.manager.turn.started",
    );
    if (isForegroundEvent) {
      flags.shouldDispatchEvent = false;
      flags.shouldNotifyWaiters = false;
      return;
    }
    if (agent.activeForegroundTurnId) {
      flags.shouldDispatchEvent = false;
      flags.shouldNotifyWaiters = false;
      return;
    }
    const generation = options?.sessionGeneration ?? this.sessionGenerationTokens.get(agent.id);
    if (!generation) return;
    const run = this.runs.trackAutonomousRun(agent.id, eventTurnId ?? null, generation);
    this.latestTurnTokens.set(agent.id, run.token);
    if (eventTurnId) {
      this.registerTurnToken(agent.id, eventTurnId, run.token);
    }
    if (eventTurnId) {
      this.openActiveTurn(agent, eventTurnId, new Date());
    }
    agent.lifecycle = "running";
    this.emitState(agent, { generation, turnToken: options?.turnToken });
  }

  private onStreamPermissionRequested(
    agent: ActiveManagedAgent,
    event: Extract<AgentStreamEvent, { type: "permission_requested" }>,
    options?: HandleStreamEventOptions,
  ): void {
    const hadPendingPermissions = agent.pendingPermissions.size > 0;
    agent.pendingPermissions.set(event.request.id, event.request);
    if (!hadPendingPermissions && !agent.internal) {
      this.broadcastAgentAttention(agent, "permission");
    }
    this.emitState(agent, {
      generation: options?.sessionGeneration,
      turnToken: options?.turnToken,
    });
  }

  private onStreamPermissionResolved(params: {
    agent: ActiveManagedAgent;
    event: Extract<AgentStreamEvent, { type: "permission_resolved" }>;
    options: HandleStreamEventOptions | undefined;
    flags: StreamEventFlags;
  }): void {
    const { agent, event, options, flags } = params;
    agent.pendingPermissions.delete(event.requestId);
    if (!options?.fromHistory && agent.inFlightPermissionResponses.has(event.requestId)) {
      agent.bufferedPermissionResolutions.set(event.requestId, event);
      flags.shouldDispatchEvent = false;
      return;
    }
    this.emitState(agent, {
      generation: options?.sessionGeneration,
      turnToken: options?.turnToken,
    });
  }

  private resolvePendingPermissionsForAgent(
    agent: ActiveManagedAgent,
    provider: AgentProvider,
    options: HandleStreamEventOptions | undefined,
    message: string,
  ): void {
    for (const [requestId] of agent.pendingPermissions) {
      agent.pendingPermissions.delete(requestId);
      if (!options?.fromHistory) {
        this.dispatchStream(
          agent.id,
          {
            type: "permission_resolved",
            provider,
            requestId,
            resolution: { behavior: "deny", message },
          },
          undefined,
          options?.sessionGeneration,
          options?.turnToken,
        );
      }
    }
  }

  // oxlint-disable-next-line complexity
  private async recordAndDispatchTimelineItem(
    agentId: string,
    item: AgentTimelineItem,
    provider: AgentProvider,
    turnId?: string,
    options?: {
      providerMessageId?: string;
      sessionGeneration?: symbol;
      turnToken?: string;
    },
  ): Promise<AgentStreamEvent> {
    if (
      options?.turnToken !== undefined &&
      !this.isLatestTurnTokenCurrent(agentId, options.turnToken)
    ) {
      throw new TurnStartCanceledError();
    }
    const row = await this.recordTimeline(
      agentId,
      item,
      { providerMessageId: options?.providerMessageId, turnId },
      options?.sessionGeneration,
      options?.turnToken,
    );
    if (
      (options?.sessionGeneration !== undefined &&
        !this.isSessionGenerationCurrentById(agentId, options.sessionGeneration)) ||
      (options?.turnToken !== undefined &&
        !this.isLatestTurnTokenCurrent(agentId, options.turnToken))
    ) {
      throw new TurnStartCanceledError();
    }
    const event = this.dispatchCommittedTimelineRow(
      agentId,
      row,
      provider,
      options?.sessionGeneration,
      options?.turnToken,
    );
    if (
      item.type === "tool_call" &&
      item.status === "completed" &&
      item.detail?.type === "shell" &&
      commandMayHaveChangedExternalState(item.detail.command)
    ) {
      const agent = this.agents.get(agentId);
      if (
        agent &&
        (options?.sessionGeneration === undefined ||
          this.isSessionGenerationCurrent(agent, options.sessionGeneration))
      ) {
        this.onWorkspaceStateMayHaveChanged?.({ cwd: agent.cwd });
      }
    }
    return event;
  }

  private dispatchCommittedTimelineRow(
    agentId: string,
    row: AgentTimelineRow,
    provider: AgentProvider,
    generation?: symbol,
    turnToken?: string,
  ): AgentStreamEvent {
    const event: AgentStreamEvent = {
      type: "timeline",
      item: row.item,
      provider,
      ...(row.turnId !== undefined ? { turnId: row.turnId } : {}),
    };
    this.dispatchStream(
      agentId,
      event,
      {
        seq: row.seq,
        epoch: this.timelineStore.getEpoch(agentId),
        timestamp: row.timestamp,
      },
      generation,
      turnToken,
    );
    return event;
  }

  // oxlint-disable-next-line complexity
  private async recordSubmittedPrompt(
    agent: ActiveManagedAgent,
    prompt: AgentPromptInput,
    clientMessageId: string,
    options?: {
      messageId?: string;
      providerMessageId?: string;
      turnId?: string;
      sessionGeneration?: symbol;
      turnToken?: string;
      pendingRun?: PendingForegroundRun;
      dispatch?: boolean;
    },
  ): Promise<SubmittedPromptRecord | null> {
    const currentAgent = this.agents.get(agent.id);
    if (currentAgent !== undefined && currentAgent !== agent) {
      return null;
    }
    const generation =
      options?.sessionGeneration ??
      (currentAgent === agent ? this.sessionGenerationTokens.get(agent.id) : undefined);
    if (generation !== undefined && !this.isSessionGenerationCurrent(agent, generation)) {
      return null;
    }
    if (
      options?.turnToken !== undefined &&
      !this.isLatestTurnTokenCurrent(agent.id, options.turnToken)
    ) {
      return null;
    }
    if (options?.pendingRun && !this.isPendingForegroundRunCurrent(agent, options.pendingRun)) {
      return null;
    }
    const item: AgentTimelineItem = {
      type: "user_message",
      text: submittedPromptText(prompt),
      clientMessageId,
      ...(options?.messageId ? { messageId: options.messageId } : {}),
    };

    let recorded: SubmittedPromptRecord | undefined;
    const store = this.durableTimelineStore;
    if (!store) {
      const existing = this.timelineStore.getSubmittedUserMessage(agent.id, clientMessageId);
      recorded = existing
        ? { row: existing, inserted: false }
        : {
            row: this.timelineStore.append(agent.id, item, {
              turnId: options?.turnId,
              providerMessageId: options?.providerMessageId,
            }),
            inserted: true,
          };
    } else {
      const mutation = this.queueDurableTimelineMutation(
        agent.id,
        generation,
        async (): Promise<SubmittedPromptRecord | undefined> => {
          const existing = this.timelineStore.getSubmittedUserMessage(agent.id, clientMessageId);
          if (existing) {
            return { row: existing, inserted: false };
          }
          const committedRows = await store.getCommittedRows(agent.id);
          this.mergeCommittedTimelineRows(agent.id, committedRows, {
            generation,
            turnToken: options?.turnToken,
            pendingRun: options?.pendingRun,
          });
          const durableExisting = committedRows.find(
            (row) =>
              row.item.type === "user_message" && row.item.clientMessageId === clientMessageId,
          );
          if (durableExisting) {
            return { row: durableExisting, inserted: false };
          }
          const durableNextSeq = committedRows.reduce(
            (nextSeq, row) => Math.max(nextSeq, row.seq + 1),
            1,
          );
          const nextSeq = Math.max(
            this.timelineStore.fetch(agent.id, { limit: 0 }).window.nextSeq,
            durableNextSeq,
          );
          const row: AgentTimelineRow = {
            seq: nextSeq,
            timestamp: new Date().toISOString(),
            item,
            ...(options?.turnId ? { turnId: options.turnId } : {}),
            ...(options?.providerMessageId ? { providerMessageId: options.providerMessageId } : {}),
          };
          await store.bulkInsert(agent.id, [row]);
          if (
            (generation !== undefined &&
              !this.isSessionGenerationCurrentById(agent.id, generation)) ||
            (options?.turnToken !== undefined &&
              !this.isLatestTurnTokenCurrent(agent.id, options.turnToken)) ||
            (options?.pendingRun !== undefined &&
              !this.isPendingForegroundRunCurrentById(agent.id, options.pendingRun))
          ) {
            return;
          }
          this.timelineStore.appendRow(agent.id, row);
          return { row, inserted: true };
        },
        options?.turnToken,
        {
          operation: "submitted prompt admission",
          pendingRun: options?.pendingRun,
        },
      );
      recorded = await mutation;
      if (!recorded) {
        return null;
      }
    }

    if (
      (generation !== undefined && !this.isSessionGenerationCurrent(agent, generation)) ||
      (options?.turnToken !== undefined &&
        !this.isLatestTurnTokenCurrent(agent.id, options.turnToken))
    ) {
      return null;
    }
    if (options?.pendingRun && !this.isPendingForegroundRunCurrent(agent, options.pendingRun)) {
      return null;
    }
    if (recorded.inserted) {
      this.touchUpdatedAt(agent);
      agent.lastUserMessageAt = new Date();
      if (options?.dispatch !== false) {
        this.dispatchCommittedTimelineRow(
          agent.id,
          recorded.row,
          agent.provider,
          generation,
          options?.turnToken,
        );
      }
    }
    return recorded;
  }

  private async attachSubmittedPromptTurn(
    agent: ActiveManagedAgent,
    submitted: SubmittedPromptRecord,
    turnId: string,
    providerMessageId: string | undefined,
    pendingRun: PendingForegroundRun,
  ): Promise<SubmittedPromptRecord> {
    this.assertPendingForegroundRunCurrent(agent, pendingRun);
    const row: AgentTimelineRow = {
      ...submitted.row,
      turnId,
      ...(providerMessageId !== undefined ? { providerMessageId } : {}),
    };
    const store = this.durableTimelineStore;
    if (store) {
      await this.queueDurableTimelineMutation(
        agent.id,
        pendingRun.generation,
        () => store.updateCommittedRow(agent.id, row),
        pendingRun.token,
        {
          operation: "submitted prompt identity",
          pendingRun,
        },
      );
      this.assertPendingForegroundRunCurrent(agent, pendingRun);
    }
    if (row.item.type !== "user_message" || !row.item.clientMessageId) {
      throw new DurableTimelineMutationError({
        code: "DURABLE_TIMELINE_MUTATION_FAILED",
        agentId: agent.id,
        operation: "submitted prompt identity",
        cause: new Error("Submitted prompt admission row has no client message identity"),
      });
    }
    const updated = this.timelineStore.updateSubmittedUserMessage(
      agent.id,
      row.item.clientMessageId,
      {
        turnId,
        ...(providerMessageId !== undefined ? { providerMessageId } : {}),
      },
    );
    if (!updated) {
      throw new DurableTimelineMutationError({
        code: "DURABLE_TIMELINE_MUTATION_FAILED",
        agentId: agent.id,
        operation: "submitted prompt identity",
        cause: new Error("Submitted prompt admission row disappeared before activation"),
      });
    }
    return { row: updated, inserted: submitted.inserted };
  }

  private async reconcileSubmittedPromptEcho(
    agent: ActiveManagedAgent,
    item: Extract<AgentTimelineItem, { type: "user_message" }>,
    turnId?: string,
    generation?: symbol,
    turnToken?: string,
  ): Promise<AgentTimelineRow | null> {
    const { clientMessageId, messageId } = item;
    if (!clientMessageId) return null;
    let existing = this.timelineStore.getSubmittedUserMessage(agent.id, clientMessageId);
    if (!existing) {
      const recorded = await this.recordSubmittedPrompt(agent, item.text, clientMessageId, {
        messageId: clientMessageId,
        ...(messageId ? { providerMessageId: messageId } : {}),
        ...(turnId ? { turnId } : {}),
        ...(generation ? { sessionGeneration: generation } : {}),
        ...(turnToken ? { turnToken } : {}),
      });
      existing = recorded?.row ?? null;
    }
    if (!existing || existing.item.type !== "user_message") return null;
    if (messageId) {
      const enriched = this.timelineStore.enrichSubmittedUserMessage(
        agent.id,
        clientMessageId,
        messageId,
      );
      if (enriched)
        await this.enqueueDurableTimelineUpdate(agent.id, enriched, generation, turnToken);
      return enriched ?? existing;
    }
    return existing;
  }

  private mergeCommittedTimelineRows(
    agentId: string,
    rows: readonly AgentTimelineRow[],
    options?: {
      generation?: symbol;
      turnToken?: string;
      pendingRun?: PendingForegroundRun;
    },
  ): void {
    if (
      !this.agents.has(agentId) ||
      (options?.generation !== undefined &&
        !this.isSessionGenerationCurrentById(agentId, options.generation)) ||
      (options?.turnToken !== undefined &&
        !this.isLatestTurnTokenCurrent(agentId, options.turnToken)) ||
      (options?.pendingRun !== undefined &&
        !this.isPendingForegroundRunCurrentById(agentId, options.pendingRun))
    ) {
      return;
    }

    const knownSequences = new Set(this.timelineStore.getRows(agentId).map((row) => row.seq));
    for (const row of [...rows].sort((left, right) => left.seq - right.seq)) {
      if (knownSequences.has(row.seq)) {
        continue;
      }
      const nextSeq = this.timelineStore.fetch(agentId, { limit: 0 }).window.nextSeq;
      if (row.seq < nextSeq) {
        knownSequences.add(row.seq);
        continue;
      }
      if (row.seq > nextSeq) {
        break;
      }
      this.timelineStore.appendRow(agentId, row);
      knownSequences.add(row.seq);
    }
  }

  private async appendSystemErrorTimelineMessage(
    agent: ActiveManagedAgent,
    provider: AgentProvider,
    message: string,
    options?: HandleStreamEventOptions,
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
    if (
      options?.sessionGeneration !== undefined &&
      !this.isSessionGenerationCurrent(agent, options.sessionGeneration)
    ) {
      return;
    }
    if (
      options?.turnToken !== undefined &&
      !this.isLatestTurnTokenCurrent(agent.id, options.turnToken)
    ) {
      return;
    }
    if (lastItem?.type === "assistant_message" && lastItem.text === text) {
      return;
    }

    const item: AgentTimelineItem = { type: "assistant_message", text };
    const row = await this.recordTimeline(
      agent.id,
      item,
      undefined,
      options?.sessionGeneration,
      options?.turnToken,
    );
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
        timestamp: row.timestamp,
      },
      options?.sessionGeneration,
      options?.turnToken,
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

  private isSessionGenerationCurrent(agent: ManagedAgent, generation: symbol): boolean {
    return (
      this.sessionGenerationTokens.get(agent.id) === generation &&
      this.agents.get(agent.id) === agent
    );
  }

  private isSessionGenerationCurrentById(agentId: string, generation: symbol): boolean {
    return this.sessionGenerationTokens.get(agentId) === generation;
  }

  private registerTurnToken(agentId: string, turnId: string, token: string): void {
    let tokens = this.turnTokensById.get(agentId);
    if (!tokens) {
      tokens = new Map();
      this.turnTokensById.set(agentId, tokens);
    }
    tokens.set(turnId, token);
    this.latestTurnTokens.set(agentId, token);
  }

  private resolveTurnTokenForEvent(agentId: string, event: AgentStreamEvent): string | undefined {
    const turnId = getAgentStreamEventTurnId(event);
    if (turnId !== undefined) {
      const knownToken = this.turnTokensById.get(agentId)?.get(turnId);
      if (knownToken !== undefined) {
        return knownToken;
      }
    }
    const run = this.runs.getRun(agentId);
    return run?.token;
  }

  private isLatestTurnTokenCurrent(agentId: string, turnToken: string): boolean {
    return this.latestTurnTokens.get(agentId) === turnToken;
  }

  private isRefreshCurrent(
    agent: ActiveManagedAgent,
    generation: symbol,
    turnToken?: string,
  ): boolean {
    return (
      this.isSessionGenerationCurrent(agent, generation) &&
      (turnToken === undefined || this.isLatestTurnTokenCurrent(agent.id, turnToken))
    );
  }

  private isHydrationCurrent(
    agent: ActiveManagedAgent,
    generation: symbol,
    turnToken?: string,
  ): boolean {
    return (
      this.isSessionGenerationCurrent(agent, generation) &&
      (turnToken === undefined || this.isLatestTurnTokenCurrent(agent.id, turnToken))
    );
  }

  private isLiveTurnTokenCurrent(agentId: string, turnToken: string): boolean {
    return this.runs.getRun(agentId)?.token === turnToken;
  }

  private requireSessionGeneration(agentId: string): symbol {
    const generation = this.sessionGenerationTokens.get(agentId);
    if (!generation) {
      throw new TurnStartCanceledError();
    }
    return generation;
  }

  private shouldHandleSessionEvent(
    agent: ActiveManagedAgent,
    options?: HandleStreamEventOptions,
  ): boolean {
    if (
      options?.sessionGeneration === undefined ||
      !this.isSessionGenerationCurrent(agent, options.sessionGeneration)
    ) {
      return options?.sessionGeneration === undefined;
    }
    if (
      options.turnToken !== undefined &&
      !this.isLiveTurnTokenCurrent(agent.id, options.turnToken)
    ) {
      return false;
    }
    return true;
  }

  private async recordTimeline(
    agentId: string,
    item: AgentTimelineItem,
    options?: {
      timestamp?: string;
      providerMessageId?: string;
      turnId?: string;
    },
    generation?: symbol,
    turnToken?: string,
  ): Promise<AgentTimelineRow> {
    if (generation !== undefined && !this.isSessionGenerationCurrentById(agentId, generation)) {
      throw new TurnStartCanceledError();
    }
    if (turnToken !== undefined && !this.isLatestTurnTokenCurrent(agentId, turnToken)) {
      throw new TurnStartCanceledError();
    }
    item = limitAgentTimelineItemContent(item);
    const store = this.durableTimelineStore;
    if (!store) {
      return this.timelineStore.append(agentId, item, options);
    }

    let mutationTimedOut = false;
    const commit = this.queueDurableTimelineMutation(
      agentId,
      generation,
      async () => {
        const committedRows = await store.getCommittedRows(agentId);
        this.mergeCommittedTimelineRows(agentId, committedRows, { generation, turnToken });
        const durableNextSeq = committedRows.reduce(
          (nextSeq, row) => Math.max(nextSeq, row.seq + 1),
          1,
        );
        const nextSeq = Math.max(
          this.timelineStore.fetch(agentId, { limit: 0 }).window.nextSeq,
          durableNextSeq,
        );
        const row: AgentTimelineRow = {
          seq: nextSeq,
          timestamp: options?.timestamp ?? new Date().toISOString(),
          item,
          ...(options?.turnId ? { turnId: options.turnId } : {}),
          ...(options?.providerMessageId ? { providerMessageId: options.providerMessageId } : {}),
        };
        await store.bulkInsert(agentId, [row]);
        if (
          mutationTimedOut ||
          (generation !== undefined && !this.isSessionGenerationCurrentById(agentId, generation)) ||
          (turnToken !== undefined && !this.isLatestTurnTokenCurrent(agentId, turnToken))
        ) {
          // The durable row is now stable, but this generation is retired (or the caller timed
          // out). Return it to let the caller observe the commit without reviving retired memory.
          return row;
        }
        this.timelineStore.appendRow(agentId, row);
        return row;
      },
      turnToken,
      {
        operation: "timeline append",
        onTimeout: () => {
          mutationTimedOut = true;
        },
      },
    );
    const result = commit.then((row) => {
      if (!row) {
        throw new TurnStartCanceledError();
      }
      return row;
    });
    this.trackBackgroundTask(
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }

  private canEmitState(agent: ManagedAgent, generation?: symbol, turnToken?: string): boolean {
    const currentAgent = this.agents.get(agent.id);
    if (currentAgent === undefined) {
      return generation === undefined && agent.lifecycle === "closed";
    }
    if (currentAgent !== agent || generation === undefined) {
      return false;
    }
    return (
      this.isSessionGenerationCurrent(agent, generation) &&
      (turnToken === undefined || this.isLatestTurnTokenCurrent(agent.id, turnToken))
    );
  }

  private emitState(
    agent: ManagedAgent,
    options?: { persist?: boolean; generation?: symbol; turnToken?: string },
  ): void {
    const currentAgent = this.agents.get(agent.id);
    const generation =
      options?.generation ??
      (currentAgent === agent ? this.sessionGenerationTokens.get(agent.id) : undefined);
    if (!this.canEmitState(agent, generation, options?.turnToken)) {
      return;
    }
    // Keep attention as an edge-triggered unread signal, not a level signal.
    this.checkAndSetAttention(agent);
    if (!this.canEmitState(agent, generation, options?.turnToken)) return;
    if (options?.persist !== false) {
      this.enqueueBackgroundPersist(agent, generation, options?.turnToken);
    }

    this.syncFeaturesFromSession(agent);

    this.logger.trace(
      {
        agentId: agent.id,
        provider: agent.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId: agent.activeForegroundTurnId ?? undefined,
        lifecycle: agent.lifecycle,
        activeForegroundTurnId: agent.activeForegroundTurnId,
        pendingPermissions: agent.pendingPermissions.size,
        persist: options?.persist !== false,
      },
      "agent.manager.emit_state",
    );

    if (!this.canEmitState(agent, generation, options?.turnToken)) return;
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

  private enqueueBackgroundPersist(
    agent: ManagedAgent,
    generation?: symbol,
    turnToken?: string,
  ): void {
    const task = Promise.resolve()
      .then(() => {
        if (
          generation !== undefined &&
          (this.sessionGenerationTokens.get(agent.id) !== generation ||
            this.agents.get(agent.id) !== agent)
        ) {
          return;
        }
        return this.persistSnapshot(agent, { generation, turnToken });
      })
      .catch((err) => {
        this.logger.error({ err, agentId: agent.id }, "Failed to persist agent snapshot");
      });
    this.trackBackgroundTask(task);
  }

  private enqueueDurableTimelineBulkInsert(
    agentId: string,
    rows: readonly AgentTimelineRow[],
    generation?: symbol,
    turnToken?: string,
  ): void {
    const store = this.durableTimelineStore;
    if (!store || rows.length === 0) {
      return;
    }
    const task = this.queueDurableTimelineMutation(
      agentId,
      generation,
      () => store.bulkInsert(agentId, rows),
      turnToken,
    ).catch((err) => {
      this.logger.error(
        { err, agentId, rowCount: rows.length },
        "Failed to seed durable timeline store",
      );
    });
    this.trackBackgroundTask(task);
  }

  private enqueueDurableTimelineUpdate(
    agentId: string,
    row: AgentTimelineRow,
    generation?: symbol,
    turnToken?: string,
  ): Promise<void> {
    const store = this.durableTimelineStore;
    if (!store) return Promise.resolve();
    const task = this.queueDurableTimelineMutation(
      agentId,
      generation,
      () => store.updateCommittedRow(agentId, row),
      turnToken,
    ).catch((err) => {
      this.logger.error(
        { err, agentId, seq: row.seq, itemType: row.item.type },
        "Failed to enrich durable timeline row",
      );
    });
    this.trackBackgroundTask(task);
    return task;
  }

  private queueDurableTimelineMutation(
    agentId: string,
    generation: symbol | undefined,
    mutation: () => Promise<void>,
    turnToken?: string,
    options?: DurableTimelineMutationOptions,
  ): Promise<void>;
  private queueDurableTimelineMutation<T>(
    agentId: string,
    generation: symbol | undefined,
    mutation: () => Promise<T>,
    turnToken?: string,
    options?: DurableTimelineMutationOptions,
  ): Promise<T | undefined>;
  private queueDurableTimelineMutation<T>(
    agentId: string,
    generation: symbol | undefined,
    mutation: () => Promise<T>,
    turnToken?: string,
    options?: DurableTimelineMutationOptions,
  ): Promise<T | undefined> {
    const previous = this.durableTimelineMutationTails.get(agentId) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        if (
          (generation !== undefined && !this.isSessionGenerationCurrentById(agentId, generation)) ||
          (turnToken !== undefined && !this.isLatestTurnTokenCurrent(agentId, turnToken)) ||
          (options?.pendingRun !== undefined &&
            !this.isPendingForegroundRunCurrentById(agentId, options.pendingRun))
        ) {
          return;
        }
        return await mutation();
      });
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    this.durableTimelineMutationTails.set(agentId, tail);
    void tail.then(() => {
      if (this.durableTimelineMutationTails.get(agentId) === tail) {
        this.durableTimelineMutationTails.delete(agentId);
      }
      return undefined;
    });
    return this.waitForDurableTimelineMutation(operation, {
      agentId,
      operation: options?.operation ?? "mutation",
      onTimeout: options?.onTimeout,
    });
  }

  private async drainDurableTimelineMutations(agentId: string): Promise<void> {
    const tail = this.durableTimelineMutationTails.get(agentId);
    if (!tail) {
      return;
    }
    const result = await this.waitWithTimeout({
      operation: tail,
      timeoutMs: this.rescueTimeouts.durableTimelineMutationMs,
      onLateError: (error) => {
        this.logger.warn(
          { err: error, agentId },
          "Durable timeline mutation failed after drain timeout",
        );
      },
    });
    if (result === "timed_out") {
      this.logger.warn(
        { agentId, timeoutMs: this.rescueTimeouts.durableTimelineMutationMs },
        "Timed out draining durable timeline mutations",
      );
    }
  }

  private async waitForDurableTimelineMutation<T>(
    operation: Promise<T | undefined>,
    params: { agentId: string; operation: string; onTimeout?: () => void },
  ): Promise<T | undefined> {
    let timer: NodeJS.Timeout | null = null;
    const result = operation.then(
      (value) => value,
      (error: unknown) => {
        throw new DurableTimelineMutationError({
          code: "DURABLE_TIMELINE_MUTATION_FAILED",
          agentId: params.agentId,
          operation: params.operation,
          cause: error,
        });
      },
    );
    const timeout = new Promise<T | undefined>((_, reject) => {
      timer = setTimeout(() => {
        params.onTimeout?.();
        reject(
          new DurableTimelineMutationError({
            code: "DURABLE_TIMELINE_MUTATION_TIMEOUT",
            agentId: params.agentId,
            operation: params.operation,
            timeoutMs: this.rescueTimeouts.durableTimelineMutationMs,
          }),
        );
      }, this.rescueTimeouts.durableTimelineMutationMs);
    });
    try {
      return await Promise.race([result, timeout]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private trackBackgroundTask(task: Promise<void>): void {
    this.backgroundTasks.add(task);
    void task.finally(() => {
      this.backgroundTasks.delete(task);
    });
  }

  private trackAgentRegistrationOperation<T>(result: Promise<T>): Promise<T> {
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.agentRegistrationTasks.add(settled);
    void settled.then(() => {
      this.agentRegistrationTasks.delete(settled);
      return undefined;
    });
    return result;
  }

  /**
   * Flush any background persistence work (best-effort).
   */
  async flush(): Promise<void> {
    await this.flushTasks({ includeAgentRegistrations: false });
  }

  /**
   * Flush persistence and agent registrations that crossed the synchronous
   * shutdown barrier. Those registrations own provider sessions until they
   * either install them or close them.
   */
  async flushForShutdown(): Promise<void> {
    await this.flushTasks({ includeAgentRegistrations: true });
  }

  private async flushTasks(options: { includeAgentRegistrations: boolean }): Promise<void> {
    this.agentStreamCoalescer.flushAll();
    // Drain tasks, including tasks spawned while awaiting.
    while (
      this.backgroundTasks.size > 0 ||
      (options.includeAgentRegistrations && this.agentRegistrationTasks.size > 0)
    ) {
      const pending = options.includeAgentRegistrations
        ? [...this.backgroundTasks, ...this.agentRegistrationTasks]
        : [...this.backgroundTasks];
      await Promise.allSettled(pending);
    }
  }

  private broadcastAgentAttention(
    agent: ManagedAgent,
    reason: "finished" | "error" | "permission",
  ): void {
    if (isDelegatedAgent(agent)) {
      return;
    }

    this.onAgentAttention?.({
      agentId: agent.id,
      provider: agent.provider,
      reason,
    });
  }

  private dispatchStream(
    agentId: string,
    event: AgentStreamEvent,
    metadata?: {
      seq?: number;
      epoch?: string;
      timestamp?: string;
    },
    generation?: symbol,
    turnToken?: string,
  ): void {
    if (generation !== undefined && !this.isSessionGenerationCurrentById(agentId, generation)) {
      return;
    }
    if (turnToken !== undefined && !this.isLatestTurnTokenCurrent(agentId, turnToken)) {
      return;
    }
    if (event.type === "timeline") {
      event = {
        ...event,
        item: limitAgentTimelineItemContent(event.item),
      };
    }
    const agent = this.agents.get(agentId);
    this.logger.trace(
      {
        agentId,
        provider: event.provider,
        sessionId: agent?.persistence?.sessionId ?? undefined,
        turnId: getAgentStreamEventTurnId(event),
        metadata,
        event,
      },
      "agent.manager.dispatch_stream",
    );
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
      if (
        subscriber.agentId &&
        event.type === "provider_subagent" &&
        subscriber.agentId !==
          (event.event.type === "upsert"
            ? event.event.subagent.parentAgentId
            : event.event.parentAgentId)
      ) {
        continue;
      }
      // Skip internal agents for global subscribers (those without a specific agentId)
      if (!subscriber.agentId && this.eventBelongsToInternalAgent(event)) {
        continue;
      }
      subscriber.callback(event);
    }
  }

  private eventBelongsToInternalAgent(event: AgentManagerEvent): boolean {
    if (event.type === "agent_state") return event.agent.internal === true;
    if (event.type === "agent_stream") return this.agents.get(event.agentId)?.internal === true;
    if (event.type !== "provider_subagent") return false;
    const parentAgentId =
      event.event.type === "upsert"
        ? event.event.subagent.parentAgentId
        : event.event.parentAgentId;
    return this.agents.get(parentAgentId)?.internal === true;
  }

  private async normalizeConfig(
    config: AgentSessionConfig,
    options: NormalizeConfigOptions = {},
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

    const shouldResolveDefaultModel = options.resolveDefaultModel ?? true;
    if (shouldResolveDefaultModel && !normalized.model) {
      const defaultModelId = await this.resolveDefaultModelId(normalized);
      if (defaultModelId) {
        normalized.model = defaultModelId;
      }
    }

    return this.applyProviderConfiguration(normalized);
  }

  private applyProviderConfiguration(config: AgentSessionConfig): AgentSessionConfig {
    const definition = this.providerDefinitions.get(config.provider);
    if (config.providerOptions !== undefined && !definition?.validateOptions) {
      throw new Error(`Provider '${config.provider}' does not accept providerOptions`);
    }
    const validatedOptions = definition?.validateOptions?.(config.providerOptions);
    const withOptions = definition?.applyOptions
      ? definition.applyOptions(config, validatedOptions)
      : config;
    this.validateToolPolicyServers(withOptions);
    if (withOptions.toolPolicy && !definition?.applyToolPolicy) {
      throw new Error(
        `Provider '${config.provider}' cannot preapprove exact MCP tools for unattended execution`,
      );
    }
    return definition?.applyToolPolicy
      ? definition.applyToolPolicy(withOptions, withOptions.toolPolicy)
      : withOptions;
  }

  private validateToolPolicyServers(config: AgentSessionConfig): void {
    if (!config.toolPolicy) return;
    const serverNames = new Set(Object.keys(config.mcpServers ?? {}));
    for (const grant of config.toolPolicy.preapproved) {
      if (!serverNames.has(grant.server)) {
        throw new Error(
          `toolPolicy preapproval '${grant.server}.${grant.tool}' requires MCP server '${grant.server}' in the same agent request`,
        );
      }
    }
  }

  private async resolveDefaultModelId(config: AgentSessionConfig): Promise<string | undefined> {
    const client = this.clients.get(config.provider);
    if (!client) {
      return undefined;
    }
    try {
      const catalog = await client.fetchCatalog({
        scope: "workspace",
        cwd: config.cwd,
        force: false,
      });
      return (catalog.models.find((model) => model.isDefault) ?? catalog.models[0])?.id;
    } catch {
      // Provider may not support model listing — leave model undefined.
      return undefined;
    }
  }

  private async prepareSessionConfig(
    config: AgentSessionConfig,
    agentId: string,
    env?: Record<string, string>,
  ): Promise<PreparedSessionConfig> {
    const storedConfig = await this.normalizeConfig(stripInternalPaseoMcpServer(config), { env });
    const launchConfig = this.applyDaemonAppendSystemPrompt(
      withRuntimePaseoMcpServer({
        config: storedConfig,
        agentId,
        mcpBaseUrl: this.mcpBaseUrl,
        mcpAuthToken: this.mcpAuthToken,
      }),
    );
    return { storedConfig, launchConfig };
  }

  private applyDaemonAppendSystemPrompt(config: AgentSessionConfig): AgentSessionConfig {
    const daemonAppendSystemPrompt = this.appendSystemPrompt.trim();
    const next = { ...config };
    delete next.daemonAppendSystemPrompt;

    return daemonAppendSystemPrompt
      ? {
          ...next,
          daemonAppendSystemPrompt,
        }
      : next;
  }

  private async buildLaunchContext(
    agentId: string,
    client: AgentClient,
    cwd: string,
    env?: Record<string, string>,
  ): Promise<AgentLaunchContext> {
    const context: AgentLaunchContext = {
      agentId,
      env: {
        ...env,
        PASEO_AGENT_ID: agentId,
        PASEO_AGENT_CWD: cwd,
      },
    };
    if (
      this.paseoToolsEnabled &&
      client.capabilities.supportsNativePaseoTools &&
      this.paseoToolCatalogFactory
    ) {
      context.paseoTools = await this.paseoToolCatalogFactory({ callerAgentId: agentId });
    }
    return context;
  }

  private resolveProviderLaunchConfig(
    launchConfig: AgentSessionConfig,
    launchContext: AgentLaunchContext,
  ): AgentSessionConfig {
    return launchContext.paseoTools ? stripInternalPaseoMcpServer(launchConfig) : launchConfig;
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

  private async syncNativeArchiveState(
    provider: AgentProvider,
    persistence: AgentPersistenceHandle | null | undefined,
    state: "archive" | "restore",
  ): Promise<void> {
    if (!persistence) return;
    const client = this.clients.get(provider);
    const sync =
      state === "archive" ? client?.archiveNativeSession : client?.unarchiveNativeSession;
    if (!sync) return;
    if (state === "restore") {
      await sync.call(client, persistence);
      return;
    }
    try {
      await sync.call(client, persistence);
    } catch (error) {
      this.logger.warn(
        { error, provider, sessionId: persistence.sessionId },
        "Failed to archive native session (best-effort)",
      );
    }
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

  private requirePublicAgent(id: string): LiveManagedAgent {
    const agent = this.requireAgent(id);
    if (agent.internal) {
      throw new Error(`Unknown agent '${agent.id}'`);
    }
    return agent;
  }
}

export function commandMayHaveChangedExternalState(command: string): boolean {
  const normalized = command.toLowerCase();
  // Commands that operate on remote state and do NOT trigger local file
  // watchers. Local git mutations (commit, checkout, merge, rebase, reset,
  // pull) are already caught by watchers on .git/HEAD and refs/heads/.
  return (
    // GitHub PR operations (merge, close, create, edit, comment, review)
    /\bgh\s+pr\s+(merge|close|create|edit|comment|review)\b/.test(normalized) ||
    // Pushes to remote — local refs unchanged, but remote state (PR checks,
    // mergeable status) may shift immediately after.
    /\bgit\s+push\b/.test(normalized) ||
    // Fetches update refs/remotes/ which our watchers do not watch, so
    // ahead/behind counts can drift stale until the next refresh.
    /\bgit\s+fetch\b/.test(normalized)
  );
}
