import { Buffer } from "buffer";
import { Keyboard } from "react-native";
import { z } from "zod";
import {
  AgentStatusSchema,
  AgentTimelineItemPayloadSchema,
  WorkspaceGitHubRuntimePayloadSchema,
} from "@getpaseo/protocol/messages";
import { AgentProviderSchema } from "@getpaseo/protocol/provider-manifest";
import {
  normalizeProjectDescriptor,
  normalizeWorkspaceDescriptor,
  selectAgentTimelineState,
  useSessionStore,
  type Agent,
  type SessionReplica,
  type SessionState,
  type ProjectDescriptor,
  type WorkspaceDescriptor,
} from "@/stores/session-store";
import {
  isUnreconciledLocalUserMessage,
  type AgentToolCallData,
  type StreamItem,
} from "@/types/stream";
import { normalizeAgentSnapshot } from "@/utils/agent-snapshots";
import {
  diffReplicaInput,
  hasReplicaInputChanges,
  type ReplicaInput,
  type ReplicaInputChanges,
} from "./diff";
import { clearLegacyReplicaCache } from "./legacy-cleanup";
import {
  REPLICA_SINGLETON_ROW_ID,
  type ReplicaHostRows,
  type ReplicaRow,
  type ReplicaRowChanges,
  type ReplicaRowKey,
  type ReplicaRowKind,
  type ReplicaRowStore,
} from "./row-store";

const PERSIST_AFTER_USER_INACTIVITY_MS = 5_000;
const MAX_TIMELINE_ITEMS = 50;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const IsoDateSchema = z.iso.datetime();
const TimelinePositionSchema = z.strictObject({
  epoch: z.string(),
  seq: z.number().int().nonnegative(),
});

const TimelineItemBaseShape = {
  id: z.string(),
  timelineCursor: TimelinePositionSchema.optional(),
  // COMPAT(active-turn-membership): absent on caches written before turn membership.
  turnId: z.string().optional(),
  timestamp: IsoDateSchema,
};

const TodoEntrySchema = z.strictObject({
  text: z.string(),
  completed: z.boolean(),
  id: z.string().optional(),
  status: z.enum(["pending", "in_progress", "completed"]).optional(),
  activeForm: z.string().optional(),
});

const TaskActivitySchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("created"), count: z.number().int().nonnegative() }),
  z.strictObject({
    type: z.enum(["added", "started", "completed", "reopened"]),
    task: z.string(),
  }),
]);

const StoredTimelineItemSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...TimelineItemBaseShape,
    kind: z.literal("user_message"),
    clientMessageId: z.string().optional(),
    messageId: z.string().optional(),
    text: z.string(),
  }),
  z.strictObject({
    ...TimelineItemBaseShape,
    kind: z.literal("assistant_message"),
    messageId: z.string().optional(),
    text: z.string(),
    blockGroupId: z.string().optional(),
    blockIndex: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({
    ...TimelineItemBaseShape,
    kind: z.literal("thought"),
    text: z.string(),
    status: z.enum(["loading", "ready"]),
  }),
  z.strictObject({
    ...TimelineItemBaseShape,
    kind: z.literal("todo_list"),
    provider: AgentProviderSchema,
    items: z.array(TodoEntrySchema),
    activity: TaskActivitySchema,
  }),
  z.strictObject({
    ...TimelineItemBaseShape,
    kind: z.literal("activity_log"),
    activityType: z.enum(["system", "info", "success", "error"]),
    message: z.string(),
  }),
  z.strictObject({
    ...TimelineItemBaseShape,
    kind: z.literal("compaction"),
    status: z.enum(["loading", "completed"]),
    trigger: z.enum(["auto", "manual"]).optional(),
    preTokens: z.number().nonnegative().optional(),
  }),
  z.strictObject({
    ...TimelineItemBaseShape,
    kind: z.literal("tool_call"),
    provider: AgentProviderSchema,
    item: AgentTimelineItemPayloadSchema.refine((item) => item.type === "tool_call"),
  }),
]);

const AgentCapabilitiesSchema = z.strictObject({
  supportsStreaming: z.boolean(),
  supportsSessionPersistence: z.boolean(),
  supportsSessionListing: z.boolean().optional(),
  supportsDynamicModes: z.boolean(),
  supportsMcpServers: z.boolean(),
  supportsReasoningStream: z.boolean(),
  supportsToolInvocations: z.boolean(),
  supportsRewindConversation: z.boolean().optional(),
  supportsRewindFiles: z.boolean().optional(),
  supportsRewindBoth: z.boolean().optional(),
});

const StoredProjectCheckoutSchema = z.union([
  z.strictObject({
    cwd: z.string(),
    isGit: z.literal(false),
    currentBranch: z.null(),
    remoteUrl: z.null(),
    worktreeRoot: z.null(),
    isPaseoOwnedWorktree: z.literal(false),
    mainRepoRoot: z.null(),
  }),
  z.strictObject({
    cwd: z.string(),
    isGit: z.literal(true),
    currentBranch: z.string().nullable(),
    remoteUrl: z.string().nullable(),
    worktreeRoot: z.string(),
    isPaseoOwnedWorktree: z.literal(false),
    mainRepoRoot: z.string().nullable(),
  }),
  z.strictObject({
    cwd: z.string(),
    isGit: z.literal(true),
    currentBranch: z.string().nullable(),
    remoteUrl: z.string().nullable(),
    worktreeRoot: z.string(),
    isPaseoOwnedWorktree: z.literal(true),
    mainRepoRoot: z.string(),
  }),
]);

const StoredProjectPlacementSchema = z.strictObject({
  projectKey: z.string(),
  projectName: z.string(),
  workspaceName: z.string().nullable().optional(),
  checkout: StoredProjectCheckoutSchema,
});

const StoredAgentSnapshotSchema = z.strictObject({
  id: z.string(),
  provider: AgentProviderSchema,
  cwd: z.string(),
  workspaceId: z.string().optional(),
  model: z.string().nullable(),
  thinkingOptionId: z.string().nullable().optional(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  lastUserMessageAt: IsoDateSchema.nullable(),
  status: AgentStatusSchema,
  activeTurn: z
    .strictObject({
      turnId: z.string(),
      startedAt: IsoDateSchema.nullable(),
    })
    .nullable()
    .optional(),
  capabilities: AgentCapabilitiesSchema,
  currentModeId: z.string().nullable(),
  availableModes: z.array(z.never()).max(0),
  pendingPermissions: z.array(z.never()).max(0),
  persistence: z.null(),
  lastError: z.string().optional(),
  title: z.string().nullable(),
  labels: z.record(z.string(), z.string()),
  requiresAttention: z.boolean().optional(),
  attentionReason: z.enum(["finished", "error", "permission"]).nullable().optional(),
  attentionTimestamp: IsoDateSchema.nullable().optional(),
  archivedAt: IsoDateSchema.nullable().optional(),
});

const StoredAgentSchema = z.strictObject({
  snapshot: StoredAgentSnapshotSchema,
  projectPlacement: StoredProjectPlacementSchema.nullable(),
  lastActivityAt: IsoDateSchema,
});

const WorkspaceScriptSchema = z.strictObject({
  scriptName: z.string(),
  type: z.enum(["script", "service"]),
  hostname: z.string(),
  port: z.number().int().positive().nullable(),
  localProxyUrl: z.string().nullable().optional(),
  publicProxyUrl: z.string().nullable().optional(),
  proxyUrl: z.string().nullable(),
  lifecycle: z.enum(["running", "stopped"]),
  health: z.enum(["healthy", "unhealthy"]).nullable(),
  exitCode: z.number().nullable(),
  terminalId: z.string().nullable(),
});

const WorkspaceGitRuntimeSchema = z
  .strictObject({
    currentBranch: z.string().nullable().optional(),
    remoteUrl: z.string().nullable().optional(),
    isPaseoOwnedWorktree: z.boolean().optional(),
    isDirty: z.boolean().nullable().optional(),
    aheadBehind: z.strictObject({ ahead: z.number(), behind: z.number() }).nullable().optional(),
    aheadOfOrigin: z.number().nullable().optional(),
    behindOfOrigin: z.number().nullable().optional(),
  })
  .nullable()
  .optional();

const StoredWorkspaceSchema = z.strictObject({
  id: z.string(),
  projectId: z.string(),
  projectDisplayName: z.string(),
  projectCustomName: z.string().nullable(),
  projectCustomIconRevision: z.string().nullable(),
  projectRootPath: z.string(),
  workspaceDirectory: z.string(),
  worktreeSlug: z.string().optional(),
  projectKind: z.enum(["git", "non_git", "directory"]),
  workspaceKind: z.enum(["directory", "local_checkout", "checkout", "worktree"]),
  name: z.string(),
  title: z.string().nullable(),
  pinnedAt: z.string().nullable(),
  // Optional because entries written before labels existed have none. A cached workspace that
  // dropped them painted its row without its chips and stayed that way: the directory cursor is
  // current on reconnect, so the daemon has nothing newer to send back.
  labels: z.array(z.string()).optional(),
  status: z.enum(["needs_input", "failed", "running", "attention", "done"]),
  statusEnteredAt: IsoDateSchema.nullable(),
  activityAt: z.null(),
  archivingAt: z.string().nullable(),
  diffStat: z.strictObject({ additions: z.number(), deletions: z.number() }).nullable(),
  scripts: z.array(WorkspaceScriptSchema),
  gitRuntime: WorkspaceGitRuntimeSchema,
  githubRuntime: WorkspaceGitHubRuntimePayloadSchema,
  forge: z.string().optional(),
});

const StoredProjectSchema = z.strictObject({
  projectId: z.string(),
  projectKey: z.string().optional(),
  projectDisplayName: z.string(),
  projectCustomName: z.string().nullable(),
  projectCustomIconRevision: z.string().nullable(),
  projectIconRevision: z.string().optional(),
  projectRootPath: z.string(),
  projectKind: z.enum(["git", "non_git", "directory"]),
});

const StoredTimelineSchema = z.strictObject({
  agentId: z.string(),
  items: z.array(StoredTimelineItemSchema),
  range: z
    .strictObject({
      epoch: z.string(),
      startSeq: z.number().int().nonnegative(),
      endSeq: z.number().int().nonnegative(),
    })
    .nullable(),
  hasOlder: z.boolean(),
});

const StoredHostSchema = z.strictObject({
  serverId: z.string(),
  agents: z.array(StoredAgentSchema),
  workspaces: z.array(StoredWorkspaceSchema),
  projects: z.array(StoredProjectSchema),
  emptyProjects: z.array(StoredProjectSchema),
  timeline: StoredTimelineSchema.nullable(),
  directorySync: z.unknown().optional(),
});

type StoredAgent = z.infer<typeof StoredAgentSchema>;
type StoredHost = z.infer<typeof StoredHostSchema>;
type StoredTimeline = z.infer<typeof StoredTimelineSchema>;
type StoredTimelineItem = z.infer<typeof StoredTimelineItemSchema>;
type StoredToolCall = Extract<StoredTimelineItem, { kind: "tool_call" }>["item"];
type StoredWorkspace = z.infer<typeof StoredWorkspaceSchema>;
type StoredProject = z.infer<typeof StoredProjectSchema>;

interface ReplicaCacheOptions {
  maxBytes?: number;
  clearLegacyCache?: () => Promise<void>;
}

function deserializeTimeline(stored: StoredHost["timeline"]): SessionReplica["timeline"] {
  if (!stored) {
    return null;
  }
  return {
    agentId: stored.agentId,
    items: stored.items.map(deserializeTimelineItem),
    range: stored.range,
    hasOlder: stored.hasOlder,
  };
}

function timelineBase(item: StreamItem) {
  return {
    id: item.id,
    ...(item.timelineCursor ? { timelineCursor: item.timelineCursor } : {}),
    ...(item.turnId ? { turnId: item.turnId } : {}),
    timestamp: item.timestamp.toISOString(),
  };
}

function serializeAgentToolCall(data: AgentToolCallData): StoredToolCall {
  const base = {
    type: "tool_call" as const,
    callId: data.callId,
    name: data.name,
    detail: data.detail,
    ...(data.metadata ? { metadata: data.metadata } : {}),
  };
  switch (data.status) {
    case "running":
    case "completed":
    case "canceled":
      return { ...base, status: data.status, error: null };
    case "failed":
      return { ...base, status: data.status, error: data.error };
  }
}

function serializeTimelineItem(item: StreamItem): StoredTimelineItem | null {
  const base = timelineBase(item);
  switch (item.kind) {
    case "user_message":
      return {
        ...base,
        kind: item.kind,
        ...(item.clientMessageId ? { clientMessageId: item.clientMessageId } : {}),
        ...(item.messageId ? { messageId: item.messageId } : {}),
        text: item.text,
      };
    case "assistant_message":
      return {
        ...base,
        kind: item.kind,
        ...(item.messageId ? { messageId: item.messageId } : {}),
        text: item.text,
        ...(item.blockGroupId ? { blockGroupId: item.blockGroupId } : {}),
        ...(item.blockIndex !== undefined ? { blockIndex: item.blockIndex } : {}),
      };
    case "thought":
      return { ...base, kind: item.kind, text: item.text, status: item.status };
    case "todo_list":
      return {
        ...base,
        kind: item.kind,
        provider: item.provider,
        items: item.items,
        activity: item.activity,
      };
    case "activity_log":
      return {
        ...base,
        kind: item.kind,
        activityType: item.activityType,
        message: item.message,
      };
    case "compaction":
      return {
        ...base,
        kind: item.kind,
        status: item.status,
        ...(item.trigger ? { trigger: item.trigger } : {}),
        ...(item.preTokens !== undefined ? { preTokens: item.preTokens } : {}),
      };
    case "tool_call":
      if (item.payload.source !== "agent") return null;
      return {
        ...base,
        kind: item.kind,
        provider: item.payload.data.provider,
        item: serializeAgentToolCall(item.payload.data),
      };
  }
}

function deserializeTimelineItem(item: StoredTimelineItem): StreamItem {
  const base = {
    id: item.id,
    ...(item.timelineCursor ? { timelineCursor: item.timelineCursor } : {}),
    ...(item.turnId ? { turnId: item.turnId } : {}),
    timestamp: new Date(item.timestamp),
  };
  switch (item.kind) {
    case "user_message":
      return {
        ...base,
        kind: item.kind,
        ...(item.clientMessageId ? { clientMessageId: item.clientMessageId } : {}),
        ...(item.messageId ? { messageId: item.messageId } : {}),
        text: item.text,
      };
    case "assistant_message":
      return {
        ...base,
        kind: item.kind,
        ...(item.messageId ? { messageId: item.messageId } : {}),
        text: item.text,
        ...(item.blockGroupId ? { blockGroupId: item.blockGroupId } : {}),
        ...(item.blockIndex !== undefined ? { blockIndex: item.blockIndex } : {}),
      };
    case "thought":
      return { ...base, kind: item.kind, text: item.text, status: item.status };
    case "todo_list":
      return {
        ...base,
        kind: item.kind,
        provider: item.provider,
        items: item.items,
        activity: item.activity,
      };
    case "activity_log":
      return {
        ...base,
        kind: item.kind,
        activityType: item.activityType,
        message: item.message,
      };
    case "compaction":
      return {
        ...base,
        kind: item.kind,
        status: item.status,
        ...(item.trigger ? { trigger: item.trigger } : {}),
        ...(item.preTokens !== undefined ? { preTokens: item.preTokens } : {}),
      };
    case "tool_call": {
      const tool = item.item;
      if (tool.type !== "tool_call") {
        throw new Error("Stored tool call contains a non-tool timeline item");
      }
      return {
        ...base,
        kind: item.kind,
        payload: {
          source: "agent",
          data: {
            provider: item.provider,
            callId: tool.callId,
            name: tool.name,
            status: tool.status,
            error: tool.error,
            detail: tool.detail,
            ...(tool.metadata ? { metadata: tool.metadata } : {}),
          },
        },
      };
    }
  }
}

function serializeProjectPlacement(agent: Agent): StoredAgent["projectPlacement"] {
  return agent.projectPlacement ?? null;
}

function serializeAgent(agent: Agent): StoredAgent {
  const snapshot = {
    id: agent.id,
    provider: agent.provider,
    cwd: agent.cwd,
    ...(agent.workspaceId ? { workspaceId: agent.workspaceId } : {}),
    model: agent.model,
    thinkingOptionId: agent.thinkingOptionId ?? null,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
    lastUserMessageAt: agent.lastUserMessageAt?.toISOString() ?? null,
    status: agent.status,
    ...(agent.activeTurn?.turnId
      ? {
          activeTurn: {
            turnId: agent.activeTurn.turnId,
            startedAt: agent.activeTurn.startedAt?.toISOString() ?? null,
          },
        }
      : {}),
    capabilities: {
      supportsStreaming: agent.capabilities.supportsStreaming,
      supportsSessionPersistence: agent.capabilities.supportsSessionPersistence,
      ...(agent.capabilities.supportsSessionListing !== undefined
        ? { supportsSessionListing: agent.capabilities.supportsSessionListing }
        : {}),
      supportsDynamicModes: agent.capabilities.supportsDynamicModes,
      supportsMcpServers: agent.capabilities.supportsMcpServers,
      supportsReasoningStream: agent.capabilities.supportsReasoningStream,
      supportsToolInvocations: agent.capabilities.supportsToolInvocations,
      ...(agent.capabilities.supportsRewindConversation !== undefined
        ? { supportsRewindConversation: agent.capabilities.supportsRewindConversation }
        : {}),
      ...(agent.capabilities.supportsRewindFiles !== undefined
        ? { supportsRewindFiles: agent.capabilities.supportsRewindFiles }
        : {}),
      ...(agent.capabilities.supportsRewindBoth !== undefined
        ? { supportsRewindBoth: agent.capabilities.supportsRewindBoth }
        : {}),
    },
    currentModeId: agent.currentModeId,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    ...(agent.lastError ? { lastError: agent.lastError } : {}),
    title: agent.title,
    labels: agent.labels,
    requiresAttention: agent.requiresAttention ?? false,
    attentionReason: agent.attentionReason ?? null,
    attentionTimestamp: agent.attentionTimestamp?.toISOString() ?? null,
    archivedAt: agent.archivedAt?.toISOString() ?? null,
  };
  return {
    snapshot,
    projectPlacement: serializeProjectPlacement(agent),
    lastActivityAt: agent.lastActivityAt.toISOString(),
  };
}

function deserializeAgent(serverId: string, stored: StoredAgent): Agent {
  return {
    ...normalizeAgentSnapshot(stored.snapshot, serverId),
    lastActivityAt: new Date(stored.lastActivityAt),
    projectPlacement: stored.projectPlacement,
  };
}

function serializeWorkspace(workspace: WorkspaceDescriptor): StoredWorkspace {
  return {
    id: workspace.id,
    projectId: workspace.projectId,
    projectDisplayName: workspace.projectDisplayName,
    projectCustomName: workspace.projectCustomName ?? null,
    projectCustomIconRevision: workspace.projectCustomIconRevision ?? null,
    projectRootPath: workspace.projectRootPath,
    workspaceDirectory: workspace.workspaceDirectory,
    worktreeSlug: workspace.worktreeSlug,
    projectKind: workspace.projectKind,
    workspaceKind: workspace.workspaceKind,
    name: workspace.name,
    title: workspace.title ?? null,
    pinnedAt: workspace.pinnedAt ?? null,
    labels: workspace.labels,
    status: workspace.status,
    statusEnteredAt: workspace.statusEnteredAt?.toISOString() ?? null,
    activityAt: null,
    archivingAt: workspace.archivingAt,
    diffStat: workspace.diffStat,
    scripts: workspace.scripts.map((script) => ({
      scriptName: script.scriptName,
      type: script.type,
      hostname: script.hostname,
      port: script.port,
      ...(script.localProxyUrl !== undefined ? { localProxyUrl: script.localProxyUrl } : {}),
      ...(script.publicProxyUrl !== undefined ? { publicProxyUrl: script.publicProxyUrl } : {}),
      proxyUrl: script.proxyUrl,
      lifecycle: script.lifecycle,
      health: script.health,
      exitCode: script.exitCode,
      terminalId: script.terminalId,
    })),
    gitRuntime: workspace.gitRuntime,
    githubRuntime: workspace.githubRuntime,
    forge: workspace.forge,
  };
}

function serializeProject(project: ProjectDescriptor): StoredProject {
  return {
    projectId: project.projectId,
    ...(project.projectKey ? { projectKey: project.projectKey } : {}),
    projectDisplayName: project.projectDisplayName,
    projectCustomName: project.projectCustomName,
    projectCustomIconRevision: project.projectCustomIconRevision ?? null,
    projectIconRevision: project.projectIconRevision,
    projectRootPath: project.projectRootPath,
    projectKind: project.projectKind,
  };
}

function isTimelineItemStoredLosslessly(item: StreamItem): boolean {
  switch (item.kind) {
    case "user_message":
      return (item.images?.length ?? 0) === 0 && (item.attachments?.length ?? 0) === 0;
    case "activity_log":
      return item.metadata === undefined;
    case "tool_call":
      return item.payload.source === "agent";
    default:
      return true;
  }
}

function selectReplicaInput(session: SessionState, agentId: string | null): ReplicaInput {
  const agent = agentId ? session.agents.get(agentId) : undefined;
  const timeline = agentId
    ? selectAgentTimelineState(session, agentId)
    : { status: "cold" as const };
  return {
    agents: session.agents,
    workspaces: session.workspaces,
    projects: session.projects,
    focusedAgentId: agent?.id,
    timelineItems: timeline.status === "cold" ? undefined : timeline.items,
    timelineRange: timeline.status === "synced" ? timeline.range : null,
    timelineHasOlder: timeline.status === "synced" && timeline.older === "available",
  };
}

function serializeTimeline(input: ReplicaInput): StoredTimeline | null {
  const canonicalItems = input.timelineItems?.filter(
    (item) => item.kind !== "user_message" || !isUnreconciledLocalUserMessage(item),
  );
  const items = canonicalItems
    ? canonicalItems.map(serializeTimelineItem).filter((item) => item !== null)
    : undefined;
  const range = input.timelineRange;
  const canPersistCoverage =
    range !== null &&
    range.retainedRanges === undefined &&
    canonicalItems !== undefined &&
    canonicalItems.length <= MAX_TIMELINE_ITEMS &&
    items?.length === canonicalItems.length &&
    canonicalItems.every(
      (item) =>
        isTimelineItemStoredLosslessly(item) &&
        item.timelineCursor?.epoch === range.epoch &&
        item.timelineCursor.seq >= range.startSeq &&
        item.timelineCursor.seq <= range.endSeq,
    ) &&
    canonicalItems.some((item) => item.timelineCursor?.seq === range.endSeq);
  if (!input.focusedAgentId || !items) return null;
  return {
    agentId: input.focusedAgentId,
    items: items.slice(-MAX_TIMELINE_ITEMS),
    range: canPersistCoverage
      ? { epoch: range.epoch, startSeq: range.startSeq, endSeq: range.endSeq }
      : null,
    hasOlder: canPersistCoverage ? input.timelineHasOlder : false,
  };
}

function deserializeHost(stored: StoredHost): SessionReplica {
  const agents = stored.agents.map((entry) => deserializeAgent(stored.serverId, entry));
  const workspaces = stored.workspaces.map(normalizeWorkspaceDescriptor);
  const listedProjects = stored.projects.map(normalizeProjectDescriptor);
  const legacyProjects = [
    ...stored.emptyProjects.map(normalizeProjectDescriptor),
    ...workspaces.map(legacyProjectDescriptorFromWorkspace),
  ];
  const projects = new Map(
    [...legacyProjects, ...listedProjects].map((project) => [project.projectId, project]),
  );
  return {
    agents: new Map(agents.map((agent) => [agent.id, agent])),
    workspaces: new Map(workspaces.map((workspace) => [workspace.id, workspace])),
    projects,
    timeline: deserializeTimeline(stored.timeline),
  };
}

function legacyProjectDescriptorFromWorkspace(workspace: WorkspaceDescriptor): ProjectDescriptor {
  return {
    projectId: workspace.projectId,
    projectKey: null,
    projectDisplayName: workspace.projectDisplayName,
    projectCustomName: workspace.projectCustomName ?? null,
    projectRootPath: workspace.projectRootPath,
    projectKind: workspace.projectKind,
  };
}

function rowKey(key: Pick<ReplicaRowKey, "kind" | "id">): string {
  return `${key.kind}\u0000${key.id}`;
}

function pendingRowKey(key: ReplicaRowKey): string {
  return `${key.serverId}\u0000${rowKey(key)}`;
}

function payloadBytes(payload: string): number {
  return Buffer.byteLength(payload, "utf8");
}

function parseJsonPayload(payload: string): unknown {
  return JSON.parse(payload);
}

function parseStoredPayload<Value>(schema: z.ZodType<Value>, payload: string): Value {
  const parsed = schema.safeParse(parseJsonPayload(payload));
  if (!parsed.success) throw new Error("Invalid replica row payload");
  return parsed.data;
}

export class ReplicaCache {
  private readonly activeServerIds = new Set<string>();
  private readonly storedRows = new Map<string, Map<string, ReplicaRow>>();
  private readonly hostBytes = new Map<string, number>();
  private readonly hostWriteOrder = new Map<string, true>();
  private readonly evictedHostBytes = new Map<string, number>();
  private readonly lastFocusedAgentIds = new Map<string, string>();
  private readonly capturedInputs = new Map<string, ReplicaInput>();
  private readonly directoryCheckpoints = new Map<string, unknown>();
  private readonly checkpointInputs = new Map<string, unknown>();
  private pendingUpserts = new Map<string, ReplicaRow>();
  private pendingDeletes = new Map<string, ReplicaRowKey>();
  private readonly maxBytes: number;
  private totalBytes = 0;
  private unsubscribe: (() => void) | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private preparePromise: Promise<void> | null = null;

  constructor(
    private readonly rowStore: ReplicaRowStore,
    options: ReplicaCacheOptions = {},
  ) {
    this.maxBytes = Math.max(options.maxBytes ?? MAX_CACHE_BYTES, 0);
    this.clearLegacyCache = options.clearLegacyCache ?? clearLegacyReplicaCache;
  }

  private readonly clearLegacyCache: () => Promise<void>;

  setHosts(serverIds: Iterable<string>): void {
    const next = new Set(serverIds);
    const removed = [...this.activeServerIds].filter((serverId) => !next.has(serverId));
    this.activeServerIds.clear();
    for (const serverId of next) this.activeServerIds.add(serverId);
    for (const serverId of removed) {
      this.removeStoredHost(serverId);
      this.dropPendingHostChanges(serverId);
      this.queueOperation(() => this.rowStore.deleteHost(serverId));
    }
    for (const serverId of this.lastFocusedAgentIds.keys()) {
      if (!next.has(serverId)) this.lastFocusedAgentIds.delete(serverId);
    }
    for (const serverId of this.capturedInputs.keys()) {
      if (!next.has(serverId)) this.capturedInputs.delete(serverId);
    }
    for (const serverId of this.directoryCheckpoints.keys()) {
      if (!next.has(serverId)) this.directoryCheckpoints.delete(serverId);
    }
    for (const serverId of this.checkpointInputs.keys()) {
      if (!next.has(serverId)) this.checkpointInputs.delete(serverId);
    }
    for (const serverId of this.evictedHostBytes.keys()) {
      if (!next.has(serverId)) this.evictedHostBytes.delete(serverId);
    }
  }

  async restore(): Promise<void> {
    try {
      await this.prepareStore();
    } catch {
      return;
    }
    let hosts: ReplicaHostRows[];
    try {
      hosts = await this.rowStore.readAll();
    } catch {
      return;
    }
    this.storedRows.clear();
    this.hostBytes.clear();
    this.hostWriteOrder.clear();
    this.directoryCheckpoints.clear();
    this.checkpointInputs.clear();
    this.totalBytes = 0;
    const restoredHosts: StoredHost[] = [];
    try {
      for (const hostRows of hosts) {
        if (!this.activeServerIds.has(hostRows.serverId)) {
          await this.rowStore.deleteHost(hostRows.serverId);
          continue;
        }
        restoredHosts.push(this.restoreHostRows(hostRows));
      }
    } catch {
      await this.clearInvalidCache();
      return;
    }
    await this.evictOverBudget();
    for (const host of restoredHosts) {
      if (!this.storedRows.has(host.serverId)) continue;
      if (host.timeline) this.lastFocusedAgentIds.set(host.serverId, host.timeline.agentId);
      useSessionStore.getState().restoreSessionReplica(host.serverId, deserializeHost(host));
      const session = useSessionStore.getState().sessions[host.serverId];
      if (session) {
        this.capturedInputs.set(
          host.serverId,
          selectReplicaInput(session, this.lastFocusedAgentIds.get(host.serverId) ?? null),
        );
      }
    }
  }

  recordUserActivity(): void {
    if (!this.persistTimer) return;
    clearTimeout(this.persistTimer);
    this.persistTimer = null;
    this.schedulePersist();
  }

  start(): void {
    if (this.unsubscribe) return;
    const changedBeforeSubscription = this.captureSessions();
    this.unsubscribe = useSessionStore.subscribe(() => {
      if (this.activeServerIds.size === 0) return;
      this.schedulePersist();
    });
    if (changedBeforeSubscription || this.hasPendingChanges()) this.schedulePersist();
  }

  reconcileServerId(oldServerId: string, newServerId: string): void {
    const rows = this.storedRows.get(oldServerId);
    if (rows) {
      const newRows = this.storedRows.get(newServerId) ?? new Map<string, ReplicaRow>();
      this.totalBytes -=
        (this.hostBytes.get(oldServerId) ?? 0) + (this.hostBytes.get(newServerId) ?? 0);
      this.storedRows.delete(oldServerId);
      for (const [key, row] of rows) newRows.set(key, { ...row, serverId: newServerId });
      this.storedRows.set(newServerId, newRows);
      const bytes = [...newRows.values()].reduce((sum, row) => sum + payloadBytes(row.payload), 0);
      this.hostBytes.delete(oldServerId);
      this.hostBytes.set(newServerId, bytes);
      this.totalBytes += bytes;
      this.hostWriteOrder.delete(oldServerId);
      this.touchHost(newServerId);
    }
    const focusedAgentId = this.lastFocusedAgentIds.get(oldServerId);
    if (focusedAgentId) {
      this.lastFocusedAgentIds.delete(oldServerId);
      this.lastFocusedAgentIds.set(newServerId, focusedAgentId);
    }
    const capturedInput = this.capturedInputs.get(oldServerId);
    if (capturedInput) {
      this.capturedInputs.delete(oldServerId);
      this.capturedInputs.set(newServerId, capturedInput);
    }
    if (this.directoryCheckpoints.has(oldServerId)) {
      const checkpoint = this.directoryCheckpoints.get(oldServerId);
      this.directoryCheckpoints.delete(oldServerId);
      this.directoryCheckpoints.set(newServerId, checkpoint);
    }
    if (this.checkpointInputs.has(oldServerId)) {
      const checkpoint = this.checkpointInputs.get(oldServerId);
      this.checkpointInputs.delete(oldServerId);
      this.checkpointInputs.set(newServerId, checkpoint);
    }
    const evictedBytes = this.evictedHostBytes.get(oldServerId);
    if (evictedBytes !== undefined) {
      this.evictedHostBytes.delete(oldServerId);
      this.evictedHostBytes.set(newServerId, evictedBytes);
    }
    this.renamePendingHostChanges(oldServerId, newServerId);
    if (this.activeServerIds.delete(oldServerId)) this.activeServerIds.add(newServerId);
    this.queueOperation(() => this.rowStore.renameHost(oldServerId, newServerId));
  }

  readDirectoryCheckpoint(serverId: string): unknown {
    return this.directoryCheckpoints.get(serverId);
  }

  writeDirectoryCheckpoint(serverId: string, checkpoint: unknown): void {
    if (this.checkpointInputs.get(serverId) === checkpoint) return;
    this.checkpointInputs.set(serverId, checkpoint);
    this.directoryCheckpoints.set(serverId, checkpoint);
    if (this.evictedHostBytes.has(serverId)) {
      const session = useSessionStore.getState().sessions[serverId];
      if (!session) return;
      this.captureHost(serverId, session, true);
    }
    const payload = JSON.stringify(checkpoint);
    if (payload === undefined) {
      this.queueDelete({
        serverId,
        kind: "checkpoint",
        id: REPLICA_SINGLETON_ROW_ID,
      });
    } else {
      this.queueUpsert({
        serverId,
        kind: "checkpoint",
        id: REPLICA_SINGLETON_ROW_ID,
        payload,
      });
    }
    this.schedulePersist();
  }

  async flush(): Promise<void> {
    await this.persist(false);
    await this.writeQueue.catch(() => undefined);
  }

  private async flushPending(): Promise<void> {
    if (Keyboard.isVisible()) {
      this.schedulePersist();
      return;
    }
    await this.persist(true);
  }

  private async persist(skipUnchanged: boolean): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    const changed = this.captureSessions();
    if (skipUnchanged && !changed && !this.hasPendingChanges()) return;
    const write = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        const changes = this.drainPendingChanges();
        if (changes.upserts.length === 0 && changes.deletes.length === 0) return;
        try {
          await this.prepareStore();
          const boundedChanges = await this.fitChangesToBudget(changes);
          if (boundedChanges.upserts.length > 0 || boundedChanges.deletes.length > 0) {
            await this.rowStore.apply(boundedChanges);
            this.applyStoredChanges(boundedChanges);
          }
        } catch {
          this.restorePendingChanges(changes);
          if (this.hasPendingChanges()) this.schedulePersist();
        }
        return undefined;
      });
    this.writeQueue = write;
    await write;
  }

  private captureSessions(): boolean {
    const sessions = useSessionStore.getState().sessions;
    let changed = false;
    for (const serverId of this.activeServerIds) {
      const session = sessions[serverId];
      if (!session) continue;
      if (this.captureHost(serverId, session)) changed = true;
    }
    return changed;
  }

  private captureHost(serverId: string, session: SessionState, force = false): boolean {
    if (session.focusedAgentId) {
      this.lastFocusedAgentIds.set(serverId, session.focusedAgentId);
    }
    const focusedAgentId = this.lastFocusedAgentIds.get(serverId) ?? null;
    const previous = this.capturedInputs.get(serverId);
    const selected = selectReplicaInput(session, focusedAgentId);
    const hasTimelineHead =
      focusedAgentId !== null && (session.agentStreamHead.get(focusedAgentId)?.length ?? 0) > 0;
    let input = selected;
    if (hasTimelineHead && previous && selected.timelineItems === previous.timelineItems) {
      input = {
        ...selected,
        timelineRange: previous.timelineRange,
        timelineHasOlder: previous.timelineHasOlder,
      };
    } else if (hasTimelineHead) {
      input = { ...selected, timelineRange: null, timelineHasOlder: false };
    }
    const changes = diffReplicaInput(previous, input);
    this.capturedInputs.set(serverId, input);
    const isEvicted = this.evictedHostBytes.has(serverId);
    if (!hasReplicaInputChanges(changes) && !(force && isEvicted)) return false;
    const persistedChanges = isEvicted ? diffReplicaInput(undefined, input) : changes;
    this.queueReplicaChanges(serverId, input, persistedChanges);
    return true;
  }

  private queueReplicaChanges(
    serverId: string,
    input: ReplicaInput,
    changes: ReplicaInputChanges,
  ): void {
    for (const agent of changes.agents.upserts) {
      this.queueEntityUpsert(serverId, "agent", agent.id, serializeAgent(agent));
    }
    for (const id of changes.agents.deletes) this.queueEntityDelete(serverId, "agent", id);
    for (const workspace of changes.workspaces.upserts) {
      this.queueEntityUpsert(serverId, "workspace", workspace.id, serializeWorkspace(workspace));
    }
    for (const id of changes.workspaces.deletes) this.queueEntityDelete(serverId, "workspace", id);
    for (const project of changes.projects.upserts) {
      this.queueEntityUpsert(serverId, "project", project.projectId, serializeProject(project));
    }
    for (const id of changes.projects.deletes) this.queueEntityDelete(serverId, "project", id);
    if (!changes.timelineChanged) return;
    const timeline = serializeTimeline(input);
    if (timeline) {
      this.queueEntityUpsert(serverId, "timeline", REPLICA_SINGLETON_ROW_ID, timeline);
    } else {
      this.queueEntityDelete(serverId, "timeline", REPLICA_SINGLETON_ROW_ID);
    }
  }

  private queueEntityUpsert(
    serverId: string,
    kind: ReplicaRowKind,
    id: string,
    value: unknown,
  ): void {
    this.queueUpsert({ serverId, kind, id, payload: JSON.stringify(value) });
  }

  private async clearInvalidCache(): Promise<void> {
    try {
      await this.rowStore.clear();
    } catch {
      // A storage failure must not turn invalid cached data into application state.
    }
    this.storedRows.clear();
    this.hostBytes.clear();
    this.hostWriteOrder.clear();
    this.evictedHostBytes.clear();
    this.directoryCheckpoints.clear();
    this.checkpointInputs.clear();
    this.capturedInputs.clear();
    this.lastFocusedAgentIds.clear();
    this.pendingUpserts.clear();
    this.pendingDeletes.clear();
    this.totalBytes = 0;
  }

  private restoreHostRows(hostRows: ReplicaHostRows): StoredHost {
    const agents: StoredAgent[] = [];
    const workspaces: StoredWorkspace[] = [];
    const projects: StoredProject[] = [];
    let timeline: StoredTimeline | null = null;
    let checkpoint: unknown;
    const rows = new Map<string, ReplicaRow>();
    let bytes = 0;
    for (const row of hostRows.rows) {
      if (row.serverId !== hostRows.serverId) throw new Error("Replica row host key mismatch");
      switch (row.kind) {
        case "agent": {
          const agent = parseStoredPayload(StoredAgentSchema, row.payload);
          if (agent.snapshot.id !== row.id) throw new Error("Replica agent row id mismatch");
          agents.push(agent);
          break;
        }
        case "workspace": {
          const workspace = parseStoredPayload(StoredWorkspaceSchema, row.payload);
          if (workspace.id !== row.id) throw new Error("Replica workspace row id mismatch");
          workspaces.push(workspace);
          break;
        }
        case "project": {
          const project = parseStoredPayload(StoredProjectSchema, row.payload);
          if (project.projectId !== row.id) throw new Error("Replica project row id mismatch");
          projects.push(project);
          break;
        }
        case "timeline":
          if (row.id !== REPLICA_SINGLETON_ROW_ID) {
            throw new Error("Replica timeline row id mismatch");
          }
          timeline = parseStoredPayload(StoredTimelineSchema, row.payload);
          break;
        case "checkpoint":
          if (row.id !== REPLICA_SINGLETON_ROW_ID) {
            throw new Error("Replica checkpoint row id mismatch");
          }
          checkpoint = parseJsonPayload(row.payload);
          break;
        default:
          throw new Error("Unknown replica row kind");
      }
      rows.set(rowKey(row), row);
      bytes += payloadBytes(row.payload);
    }
    this.storedRows.set(hostRows.serverId, rows);
    this.hostBytes.set(hostRows.serverId, bytes);
    this.totalBytes += bytes;
    this.touchHost(hostRows.serverId);
    if (checkpoint !== undefined) {
      this.directoryCheckpoints.set(hostRows.serverId, checkpoint);
      this.checkpointInputs.set(hostRows.serverId, checkpoint);
    }
    return {
      serverId: hostRows.serverId,
      agents,
      workspaces,
      projects,
      emptyProjects: [],
      timeline,
      ...(checkpoint !== undefined ? { directorySync: checkpoint } : {}),
    };
  }

  private queueEntityDelete(serverId: string, kind: ReplicaRowKind, id: string): void {
    this.queueDelete({ serverId, kind, id });
  }

  private queueUpsert(row: ReplicaRow): void {
    const key = pendingRowKey(row);
    this.pendingDeletes.delete(key);
    this.pendingUpserts.set(key, row);
  }

  private queueDelete(key: ReplicaRowKey): void {
    const pendingKey = pendingRowKey(key);
    this.pendingUpserts.delete(pendingKey);
    this.pendingDeletes.set(pendingKey, key);
  }

  private hasPendingChanges(): boolean {
    return this.pendingUpserts.size > 0 || this.pendingDeletes.size > 0;
  }

  private drainPendingChanges(): ReplicaRowChanges {
    const changes = {
      upserts: [...this.pendingUpserts.values()],
      deletes: [...this.pendingDeletes.values()],
    };
    this.pendingUpserts = new Map();
    this.pendingDeletes = new Map();
    return changes;
  }

  private restorePendingChanges(changes: ReplicaRowChanges): void {
    for (const key of changes.deletes) {
      const pendingKey = pendingRowKey(key);
      if (
        this.activeServerIds.has(key.serverId) &&
        !this.pendingUpserts.has(pendingKey) &&
        !this.pendingDeletes.has(pendingKey)
      ) {
        this.queueDelete(key);
      }
    }
    for (const row of changes.upserts) {
      const pendingKey = pendingRowKey(row);
      if (
        this.activeServerIds.has(row.serverId) &&
        !this.pendingUpserts.has(pendingKey) &&
        !this.pendingDeletes.has(pendingKey)
      ) {
        this.queueUpsert(row);
      }
    }
  }

  private applyStoredChanges(changes: ReplicaRowChanges): void {
    const touchedServerIds = new Set<string>();
    for (const key of changes.deletes) {
      const rows = this.storedRows.get(key.serverId);
      const previous = rows?.get(rowKey(key));
      if (previous) {
        rows?.delete(rowKey(key));
        this.adjustHostBytes(key.serverId, -payloadBytes(previous.payload));
      }
      touchedServerIds.add(key.serverId);
    }
    for (const row of changes.upserts) {
      const rows = this.storedRows.get(row.serverId) ?? new Map<string, ReplicaRow>();
      const previous = rows.get(rowKey(row));
      const previousBytes = previous ? payloadBytes(previous.payload) : 0;
      rows.set(rowKey(row), row);
      this.storedRows.set(row.serverId, rows);
      this.adjustHostBytes(row.serverId, payloadBytes(row.payload) - previousBytes);
      this.evictedHostBytes.delete(row.serverId);
      touchedServerIds.add(row.serverId);
    }
    for (const serverId of touchedServerIds) {
      if ((this.storedRows.get(serverId)?.size ?? 0) === 0) {
        this.removeStoredHost(serverId);
      } else {
        this.touchHost(serverId);
      }
    }
  }

  private adjustHostBytes(serverId: string, delta: number): void {
    this.hostBytes.set(serverId, (this.hostBytes.get(serverId) ?? 0) + delta);
    this.totalBytes += delta;
  }

  private touchHost(serverId: string): void {
    this.hostWriteOrder.delete(serverId);
    this.hostWriteOrder.set(serverId, true);
  }

  private async evictOverBudget(): Promise<void> {
    while (this.totalBytes > this.maxBytes) {
      const oldestServerId = this.hostWriteOrder.keys().next().value;
      if (oldestServerId === undefined) return;
      const bytes = this.hostBytes.get(oldestServerId) ?? 0;
      await this.rowStore.deleteHost(oldestServerId);
      this.removeStoredHost(oldestServerId);
      this.evictedHostBytes.set(oldestServerId, bytes);
      this.directoryCheckpoints.delete(oldestServerId);
      this.checkpointInputs.delete(oldestServerId);
    }
  }

  private async fitChangesToBudget(changes: ReplicaRowChanges): Promise<ReplicaRowChanges> {
    const touchedServerIds = new Set<string>();
    for (const key of changes.deletes) touchedServerIds.add(key.serverId);
    for (const row of changes.upserts) touchedServerIds.add(row.serverId);

    const projectedRows = new Map<string, Map<string, ReplicaRow>>();
    const projectedBytes = new Map(this.hostBytes);
    for (const serverId of touchedServerIds) {
      projectedRows.set(serverId, new Map(this.storedRows.get(serverId)));
    }
    for (const key of changes.deletes) {
      projectedRows.get(key.serverId)?.delete(rowKey(key));
    }
    for (const row of changes.upserts) {
      projectedRows.get(row.serverId)?.set(rowKey(row), row);
    }
    for (const [serverId, rows] of projectedRows) {
      projectedBytes.set(
        serverId,
        [...rows.values()].reduce((sum, row) => sum + payloadBytes(row.payload), 0),
      );
    }

    const writeOrder = [...this.hostWriteOrder.keys()].filter(
      (serverId) => !touchedServerIds.has(serverId),
    );
    writeOrder.push(...touchedServerIds);
    let projectedTotal = [...projectedBytes.values()].reduce((sum, bytes) => sum + bytes, 0);
    const evicted = new Set<string>();
    while (projectedTotal > this.maxBytes) {
      const serverId = writeOrder.shift();
      if (serverId === undefined) break;
      const bytes = projectedBytes.get(serverId) ?? 0;
      projectedTotal -= bytes;
      projectedBytes.delete(serverId);
      evicted.add(serverId);
      this.evictedHostBytes.set(serverId, bytes);
      if (this.storedRows.has(serverId)) await this.rowStore.deleteHost(serverId);
      this.removeStoredHost(serverId);
      this.directoryCheckpoints.delete(serverId);
      this.checkpointInputs.delete(serverId);
    }

    return {
      upserts: changes.upserts.filter((row) => !evicted.has(row.serverId)),
      deletes: changes.deletes.filter((key) => !evicted.has(key.serverId)),
    };
  }

  private removeStoredHost(serverId: string): void {
    this.totalBytes -= this.hostBytes.get(serverId) ?? 0;
    this.storedRows.delete(serverId);
    this.hostBytes.delete(serverId);
    this.hostWriteOrder.delete(serverId);
  }

  private dropPendingHostChanges(serverId: string): void {
    for (const [key, row] of this.pendingUpserts) {
      if (row.serverId === serverId) this.pendingUpserts.delete(key);
    }
    for (const [key, row] of this.pendingDeletes) {
      if (row.serverId === serverId) this.pendingDeletes.delete(key);
    }
  }

  private renamePendingHostChanges(oldServerId: string, newServerId: string): void {
    const changes = this.drainPendingChanges();
    for (const key of changes.deletes) {
      this.queueDelete(key.serverId === oldServerId ? { ...key, serverId: newServerId } : key);
    }
    for (const row of changes.upserts) {
      this.queueUpsert(row.serverId === oldServerId ? { ...row, serverId: newServerId } : row);
    }
  }

  private prepareStore(): Promise<void> {
    this.preparePromise ??= (async () => {
      await this.rowStore.open();
      // COMPAT(replica-blob-cache): remove after 2026-11
      await this.clearLegacyCache().catch(() => undefined);
    })();
    return this.preparePromise;
  }

  private queueOperation(operation: () => Promise<void>): void {
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        await this.prepareStore();
        await operation();
        return undefined;
      })
      .catch(() => undefined);
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flushPending();
    }, PERSIST_AFTER_USER_INACTIVITY_MS);
  }
}
