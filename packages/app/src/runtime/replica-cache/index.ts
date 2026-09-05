import { z } from "zod";
import {
  AgentStatusSchema,
  AgentTimelineItemPayloadSchema,
  WorkspaceGitHubRuntimePayloadSchema,
} from "@getpaseo/protocol/messages";
import { AgentProviderSchema } from "@getpaseo/protocol/provider-manifest";
import type { PluginTimelineData } from "@getpaseo/plugin";
import {
  normalizeProjectDescriptor,
  normalizeWorkspaceDescriptor,
  type Agent,
  type AgentTimelineCursorState,
  type ProjectDescriptor,
  type WorkspaceDescriptor,
} from "@/stores/session-store";
import {
  isUnreconciledLocalUserMessage,
  type AgentToolCallData,
  type StreamItem,
} from "@/types/stream";
import { normalizeAgentSnapshot } from "@/utils/agent-snapshots";
import { clearLegacyReplicaCache } from "./legacy-cleanup";
import {
  REPLICA_SINGLETON_ROW_ID,
  type ReplicaRow,
  type ReplicaRowChanges,
  type ReplicaRowKey,
  type ReplicaRowKind,
  type ReplicaRowStore,
} from "./row-store";

const PERSIST_DELAY_MS = 5_000;
const MAX_TIMELINE_ITEMS = 50;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const IsoDateSchema = z.iso.datetime();
const TimelinePositionSchema = z.strictObject({
  epoch: z.string(),
  seq: z.number().int().nonnegative(),
});
const PluginTimelineDataSchema: z.ZodType<PluginTimelineData> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(PluginTimelineDataSchema),
    z.record(z.string(), PluginTimelineDataSchema),
  ]),
);

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
    type: z.enum(["added", "started", "completed"]),
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
    kind: z.literal("notification"),
    sourceType: z.enum(["error", "notification"]),
    level: z.enum(["info", "warning", "error"]),
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
  z.strictObject({
    ...TimelineItemBaseShape,
    kind: z.literal("plugin"),
    pluginId: z.string(),
    pluginItemId: z.string(),
    itemKind: z.string(),
    version: z.number().int().positive(),
    data: PluginTimelineDataSchema,
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

type StoredAgent = z.infer<typeof StoredAgentSchema>;
type StoredTimeline = z.infer<typeof StoredTimelineSchema>;
type StoredTimelineItem = z.infer<typeof StoredTimelineItemSchema>;
type StoredToolCall = Extract<StoredTimelineItem, { kind: "tool_call" }>["item"];
type StoredWorkspace = z.infer<typeof StoredWorkspaceSchema>;
type StoredProject = z.infer<typeof StoredProjectSchema>;

interface ReplicaCacheOptions {
  maxBytes?: number;
  clearLegacyCache?: () => Promise<void>;
}

export interface CachedDirectory {
  agents: Map<string, Agent>;
  workspaces: Map<string, WorkspaceDescriptor>;
  projects: Map<string, ProjectDescriptor>;
  checkpoint?: DirectoryCheckpoint;
}

export interface CachedWorkspace {
  workspace: WorkspaceDescriptor;
  project?: ProjectDescriptor;
}

export interface DirectoryCursor {
  generation: string;
  afterSeq: number;
}

export interface DirectoryCheckpoint {
  projects?: DirectoryCursor;
  workspaces?: DirectoryCursor;
  agents?: DirectoryCursor;
}

const DirectoryCursorSchema = z.strictObject({
  generation: z.string(),
  afterSeq: z.number().int().nonnegative(),
});

const DirectoryCheckpointSchema = z.strictObject({
  projects: DirectoryCursorSchema.optional(),
  workspaces: DirectoryCursorSchema.optional(),
  agents: DirectoryCursorSchema.optional(),
});

export interface CachedTimeline {
  agentId: string;
  items: StreamItem[];
  range: AgentTimelineCursorState | null;
  hasOlder: boolean;
}

function deserializeTimeline(stored: StoredTimeline | null): CachedTimeline | null {
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
    case "notification":
      return {
        ...base,
        kind: item.kind,
        sourceType: item.sourceType,
        level: item.level,
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
    case "plugin":
      return {
        ...base,
        kind: item.kind,
        pluginId: item.pluginId,
        pluginItemId: item.pluginItemId,
        itemKind: item.itemKind,
        version: item.version,
        data: item.data,
      };
  }
}

function deserializeTimelineItem(item: StoredTimelineItem): StreamItem {
  if (item.kind === "plugin") {
    return {
      id: item.id,
      ...(item.timelineCursor ? { timelineCursor: item.timelineCursor } : {}),
      ...(item.turnId ? { turnId: item.turnId } : {}),
      timestamp: new Date(item.timestamp),
      kind: item.kind,
      pluginId: item.pluginId,
      pluginItemId: item.pluginItemId,
      itemKind: item.itemKind,
      version: item.version,
      data: item.data,
    };
  }
  return deserializeBuiltinTimelineItem(item);
}

function deserializeBuiltinTimelineItem(
  item: Exclude<StoredTimelineItem, { kind: "plugin" }>,
): StreamItem {
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
    case "notification":
      return {
        ...base,
        kind: item.kind,
        sourceType: item.sourceType,
        level: item.level,
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
    case "tool_call":
      return item.payload.source === "agent";
    default:
      return true;
  }
}

function serializeTimeline(timeline: CachedTimeline): StoredTimeline | null {
  const canonicalItems = timeline.items.filter(
    (item) => item.kind !== "user_message" || !isUnreconciledLocalUserMessage(item),
  );
  const items = canonicalItems.map(serializeTimelineItem).filter((item) => item !== null);
  const range = timeline.range;
  const canPersistCoverage =
    range !== null &&
    range.retainedRanges === undefined &&
    canonicalItems.length <= MAX_TIMELINE_ITEMS &&
    items.length === canonicalItems.length &&
    canonicalItems.every(
      (item) =>
        isTimelineItemStoredLosslessly(item) &&
        item.timelineCursor?.epoch === range.epoch &&
        item.timelineCursor.seq >= range.startSeq &&
        item.timelineCursor.seq <= range.endSeq,
    ) &&
    canonicalItems.some((item) => item.timelineCursor?.seq === range.endSeq);
  return {
    agentId: timeline.agentId,
    items: items.slice(-MAX_TIMELINE_ITEMS),
    range: canPersistCoverage
      ? { epoch: range.epoch, startSeq: range.startSeq, endSeq: range.endSeq }
      : null,
    hasOlder: canPersistCoverage ? timeline.hasOlder : false,
  };
}

function rowKey(key: Pick<ReplicaRowKey, "kind" | "id">): string {
  return `${key.kind}\u0000${key.id}`;
}

function pendingRowKey(key: ReplicaRowKey): string {
  return `${key.serverId}\u0000${rowKey(key)}`;
}

// Budget accounting runs over every stored row of a touched host on each persist. Rows are
// immutable once stored, so their size is computed once. The count itself avoids the JS Buffer
// polyfill, which materialises the whole byte array just to measure it.
const rowBytesCache = new WeakMap<ReplicaRow, number>();

function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

function rowBytes(row: ReplicaRow): number {
  let bytes = rowBytesCache.get(row);
  if (bytes === undefined) {
    bytes = utf8ByteLength(row.payload);
    rowBytesCache.set(row, bytes);
  }
  return bytes;
}

function parseJsonPayload(payload: string): unknown {
  return JSON.parse(payload);
}

function parseStoredPayload<Value>(schema: z.ZodType<Value>, payload: string): Value {
  const parsed = schema.safeParse(parseJsonPayload(payload));
  if (!parsed.success) throw new Error("Invalid replica row payload");
  return parsed.data;
}

interface DirectoryReadAccumulator {
  agents: Map<string, Agent>;
  workspaces: Map<string, WorkspaceDescriptor>;
  projects: Map<string, ProjectDescriptor>;
  checkpoint?: DirectoryCheckpoint;
}

interface PendingReplicaChanges extends ReplicaRowChanges {
  directoryReplacements: Map<string, Set<string>>;
}

function applyDirectoryRow(
  serverId: string,
  row: ReplicaRow,
  result: DirectoryReadAccumulator,
): void {
  switch (row.kind) {
    case "agent": {
      const stored = parseStoredPayload(StoredAgentSchema, row.payload);
      if (stored.snapshot.id !== row.id) throw new Error("Replica agent row id mismatch");
      result.agents.set(row.id, deserializeAgent(serverId, stored));
      return;
    }
    case "workspace": {
      const stored = parseStoredPayload(StoredWorkspaceSchema, row.payload);
      if (stored.id !== row.id) throw new Error("Replica workspace row id mismatch");
      result.workspaces.set(row.id, normalizeWorkspaceDescriptor(stored));
      return;
    }
    case "project": {
      const stored = parseStoredPayload(StoredProjectSchema, row.payload);
      if (stored.projectId !== row.id) throw new Error("Replica project row id mismatch");
      result.projects.set(row.id, normalizeProjectDescriptor(stored));
      return;
    }
    case "checkpoint":
      if (row.id !== REPLICA_SINGLETON_ROW_ID) {
        throw new Error("Replica checkpoint row id mismatch");
      }
      result.checkpoint = parseStoredPayload(DirectoryCheckpointSchema, row.payload);
      return;
    default:
      return;
  }
}

function directoryEntityForRow(row: ReplicaRow): keyof DirectoryCheckpoint | undefined {
  if (row.kind === "agent") return "agents";
  if (row.kind === "workspace") return "workspaces";
  if (row.kind === "project") return "projects";
  return undefined;
}

export class ReplicaCache {
  private readonly activeServerIds = new Set<string>();
  private readonly hostRevisions = new Map<string, number>();
  private readonly storedRows = new Map<string, Map<string, ReplicaRow>>();
  private readonly hostBytes = new Map<string, number>();
  private readonly hostWriteOrder = new Map<string, true>();
  private pendingUpserts = new Map<string, ReplicaRow>();
  private pendingDeletes = new Map<string, ReplicaRowKey>();
  private pendingDirectoryReplacements = new Map<string, Set<string>>();
  private readonly maxBytes: number;
  private totalBytes = 0;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private preparePromise: Promise<void> | null = null;
  private storedIndexPromise: Promise<void> | null = null;

  constructor(
    private readonly rowStore: ReplicaRowStore,
    options: ReplicaCacheOptions = {},
  ) {
    this.maxBytes = Math.max(options.maxBytes ?? MAX_CACHE_BYTES, 0);
    this.clearLegacyCache = options.clearLegacyCache ?? clearLegacyReplicaCache;
  }

  private readonly clearLegacyCache: () => Promise<void>;

  async readAgent(serverId: string, agentId: string): Promise<Agent | undefined> {
    const rows = await this.readRows(serverId, ["agent"], [agentId]);
    const row = rows[0];
    if (!row) return undefined;
    try {
      const stored = parseStoredPayload(StoredAgentSchema, row.payload);
      if (stored.snapshot.id !== row.id) throw new Error("Replica agent row id mismatch");
      return deserializeAgent(serverId, stored);
    } catch {
      await this.deleteInvalidRow(row);
      return undefined;
    }
  }

  async readWorkspace(serverId: string, workspaceId: string): Promise<CachedWorkspace | undefined> {
    const workspaceRow = (await this.readRows(serverId, ["workspace"], [workspaceId]))[0];
    if (!workspaceRow) return undefined;
    let workspace: WorkspaceDescriptor;
    try {
      const stored = parseStoredPayload(StoredWorkspaceSchema, workspaceRow.payload);
      if (stored.id !== workspaceRow.id) throw new Error("Replica workspace row id mismatch");
      workspace = normalizeWorkspaceDescriptor(stored);
    } catch {
      await this.deleteInvalidRow(workspaceRow);
      return undefined;
    }

    let project: ProjectDescriptor | undefined;
    const projectRow = (await this.readRows(serverId, ["project"], [workspace.projectId]))[0];
    if (projectRow) {
      try {
        const stored = parseStoredPayload(StoredProjectSchema, projectRow.payload);
        if (stored.projectId !== projectRow.id) throw new Error("Replica project row id mismatch");
        project = normalizeProjectDescriptor(stored);
      } catch {
        await this.deleteInvalidRow(projectRow);
      }
    }

    return { workspace, ...(project ? { project } : {}) };
  }

  async readDirectory(serverId: string): Promise<CachedDirectory> {
    const rows = await this.readRows(serverId, ["agent", "workspace", "project", "checkpoint"]);
    const result: DirectoryReadAccumulator = {
      agents: new Map(),
      workspaces: new Map(),
      projects: new Map(),
    };
    const invalidEntities = new Set<keyof DirectoryCheckpoint>();
    const invalidRows: ReplicaRow[] = [];
    for (const row of rows) {
      try {
        applyDirectoryRow(serverId, row, result);
      } catch {
        const invalidEntity = directoryEntityForRow(row);
        if (invalidEntity) invalidEntities.add(invalidEntity);
        invalidRows.push(row);
      }
    }
    if (result.checkpoint && invalidEntities.size > 0) {
      result.checkpoint = { ...result.checkpoint };
      for (const entity of invalidEntities) delete result.checkpoint[entity];
    }
    if (invalidRows.length > 0) {
      await this.repairInvalidDirectoryRows(serverId, invalidRows, result.checkpoint);
    }
    return result;
  }

  async readTimeline(serverId: string, agentId: string): Promise<CachedTimeline | undefined> {
    const rows = await this.readRows(serverId, ["timeline"], [agentId]);
    const row = rows[0];
    if (!row) return undefined;
    try {
      const stored = parseStoredPayload(StoredTimelineSchema, row.payload);
      if (stored.agentId !== agentId) return undefined;
      return deserializeTimeline(stored) ?? undefined;
    } catch {
      await this.deleteInvalidRow(row);
      return undefined;
    }
  }

  private async readRows(
    serverId: string,
    kinds: readonly ReplicaRowKind[],
    ids?: readonly string[],
  ): Promise<ReplicaRow[]> {
    if (!this.activeServerIds.has(serverId)) return [];
    try {
      await this.prepareStore();
      while (this.activeServerIds.has(serverId)) {
        await this.flush();
        const revision = this.hostRevisions.get(serverId) ?? 0;
        const rows = await this.rowStore.read(serverId, kinds, ids);
        if (this.canReadHostRevision(serverId, revision)) return rows;
      }
      return [];
    } catch {
      return [];
    }
  }

  private async deleteInvalidRow(row: ReplicaRow): Promise<void> {
    const invalidEntity = directoryEntityForRow(row);
    if (!invalidEntity) {
      const changes = { upserts: [], deletes: [row] } satisfies ReplicaRowChanges;
      await this.queueOperation(async () => {
        await this.rowStore.apply(changes);
        this.applyStoredChanges(changes);
      });
      return;
    }

    const checkpointRow = (
      await this.readRows(row.serverId, ["checkpoint"], [REPLICA_SINGLETON_ROW_ID])
    )[0];
    let checkpoint: DirectoryCheckpoint | undefined;
    if (checkpointRow) {
      try {
        checkpoint = parseStoredPayload(DirectoryCheckpointSchema, checkpointRow.payload);
        checkpoint = { ...checkpoint };
        delete checkpoint[invalidEntity];
      } catch {
        checkpoint = undefined;
      }
    }
    const changes: ReplicaRowChanges = {
      deletes: [row, ...(checkpointRow && !checkpoint ? [checkpointRow] : [])],
      upserts:
        checkpointRow && checkpoint
          ? [
              {
                serverId: row.serverId,
                kind: "checkpoint",
                id: REPLICA_SINGLETON_ROW_ID,
                payload: JSON.stringify(checkpoint),
              },
            ]
          : [],
    };
    await this.queueOperation(async () => {
      await this.rowStore.apply(changes);
      this.applyStoredChanges(changes);
    });
  }

  private async repairInvalidDirectoryRows(
    serverId: string,
    invalidRows: ReplicaRow[],
    checkpoint: DirectoryCheckpoint | undefined,
  ): Promise<void> {
    const checkpointWasInvalid = invalidRows.some((row) => row.kind === "checkpoint");
    const changes: ReplicaRowChanges = {
      deletes: invalidRows,
      upserts:
        checkpoint !== undefined && !checkpointWasInvalid
          ? [
              {
                serverId,
                kind: "checkpoint",
                id: REPLICA_SINGLETON_ROW_ID,
                payload: JSON.stringify(checkpoint),
              },
            ]
          : [],
    };
    await this.queueOperation(async () => {
      await this.rowStore.apply(changes);
      this.applyStoredChanges(changes);
    });
  }

  commitDirectory(
    serverId: string,
    directory: {
      agents: Map<string, Agent>;
      workspaces: Map<string, WorkspaceDescriptor>;
      projects: Map<string, ProjectDescriptor>;
      checkpoint?: DirectoryCheckpoint;
    },
  ): void {
    if (!this.activeServerIds.has(serverId)) return;
    this.advanceHostRevision(serverId);
    this.clearPendingDirectoryChanges(serverId);
    const desiredRows: ReplicaRow[] = [];
    for (const agent of directory.agents.values()) {
      desiredRows.push(this.entityRow(serverId, "agent", agent.id, serializeAgent(agent)));
    }
    for (const workspace of directory.workspaces.values()) {
      desiredRows.push(
        this.entityRow(serverId, "workspace", workspace.id, serializeWorkspace(workspace)),
      );
    }
    for (const project of directory.projects.values()) {
      desiredRows.push(
        this.entityRow(serverId, "project", project.projectId, serializeProject(project)),
      );
    }
    if (directory.checkpoint) {
      desiredRows.push(
        this.entityRow(serverId, "checkpoint", REPLICA_SINGLETON_ROW_ID, directory.checkpoint),
      );
    }
    for (const row of desiredRows) this.queueUpsert(row);
    this.pendingDirectoryReplacements.set(serverId, new Set(desiredRows.map((row) => rowKey(row))));
    this.schedulePersist();
  }

  commitTimeline(serverId: string, agentId: string, timeline: CachedTimeline): void {
    if (!this.activeServerIds.has(serverId)) return;
    if (timeline.agentId !== agentId) throw new Error("Timeline cache key does not match payload");
    this.advanceHostRevision(serverId);
    const stored = serializeTimeline(timeline);
    if (stored) this.queueEntityUpsert(serverId, "timeline", agentId, stored);
    else this.queueEntityDelete(serverId, "timeline", agentId);
    this.schedulePersist();
  }

  setHosts(serverIds: Iterable<string>): void {
    const next = new Set(serverIds);
    const removed = [...this.activeServerIds].filter((serverId) => !next.has(serverId));
    const added = [...next].filter((serverId) => !this.activeServerIds.has(serverId));
    for (const serverId of [...removed, ...added]) this.advanceHostRevision(serverId);
    this.activeServerIds.clear();
    for (const serverId of next) this.activeServerIds.add(serverId);
    for (const serverId of removed) {
      this.removeStoredHost(serverId);
      this.dropPendingHostChanges(serverId);
      this.queueOperation(() => this.rowStore.deleteHost(serverId));
    }
  }

  reconcileServerId(oldServerId: string, newServerId: string): void {
    this.advanceHostRevision(oldServerId);
    this.advanceHostRevision(newServerId);
    const rows = this.storedRows.get(oldServerId);
    if (rows) {
      const newRows = this.storedRows.get(newServerId) ?? new Map<string, ReplicaRow>();
      this.totalBytes -=
        (this.hostBytes.get(oldServerId) ?? 0) + (this.hostBytes.get(newServerId) ?? 0);
      this.storedRows.delete(oldServerId);
      for (const [key, row] of rows) newRows.set(key, { ...row, serverId: newServerId });
      this.storedRows.set(newServerId, newRows);
      const bytes = [...newRows.values()].reduce((sum, row) => sum + rowBytes(row), 0);
      this.hostBytes.delete(oldServerId);
      this.hostBytes.set(newServerId, bytes);
      this.totalBytes += bytes;
      this.hostWriteOrder.delete(oldServerId);
      this.touchHost(newServerId);
    }
    this.renamePendingHostChanges(oldServerId, newServerId);
    if (this.activeServerIds.delete(oldServerId)) this.activeServerIds.add(newServerId);
    this.queueOperation(() => this.rowStore.renameHost(oldServerId, newServerId));
  }

  async flush(): Promise<void> {
    await this.persist();
    await this.writeQueue.catch(() => undefined);
  }

  private async flushPending(): Promise<void> {
    await this.persist();
  }

  private async persist(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (!this.hasPendingChanges()) return;
    const write = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        const pending = this.drainPendingChanges();
        try {
          await this.prepareStore();
          await this.ensureStoredIndex();
          const changes = this.materializeDirectoryReplacements(pending);
          const boundedChanges = await this.fitChangesToBudget(changes);
          if (boundedChanges.upserts.length > 0 || boundedChanges.deletes.length > 0) {
            await this.rowStore.apply(boundedChanges);
            this.applyStoredChanges(boundedChanges);
          }
        } catch {
          this.restorePendingChanges(pending);
          if (this.hasPendingChanges()) this.schedulePersist();
        }
        return undefined;
      });
    this.writeQueue = write;
    await write;
  }

  private queueEntityUpsert(
    serverId: string,
    kind: ReplicaRowKind,
    id: string,
    value: unknown,
  ): void {
    this.queueUpsert(this.entityRow(serverId, kind, id, value));
  }

  private entityRow(
    serverId: string,
    kind: ReplicaRowKind,
    id: string,
    value: unknown,
  ): ReplicaRow {
    return { serverId, kind, id, payload: JSON.stringify(value) };
  }

  private clearPendingDirectoryChanges(serverId: string): void {
    const isDirectoryRow = (row: ReplicaRowKey) => row.kind !== "timeline";
    for (const [key, row] of this.pendingUpserts) {
      if (row.serverId === serverId && isDirectoryRow(row)) this.pendingUpserts.delete(key);
    }
    for (const [key, row] of this.pendingDeletes) {
      if (row.serverId === serverId && isDirectoryRow(row)) this.pendingDeletes.delete(key);
    }
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
    return (
      this.pendingUpserts.size > 0 ||
      this.pendingDeletes.size > 0 ||
      this.pendingDirectoryReplacements.size > 0
    );
  }

  private canReadHostRevision(serverId: string, revision: number): boolean {
    return (
      this.activeServerIds.has(serverId) &&
      (this.hostRevisions.get(serverId) ?? 0) === revision &&
      !this.hasPendingHostChanges(serverId)
    );
  }

  private hasPendingHostChanges(serverId: string): boolean {
    if (this.pendingDirectoryReplacements.has(serverId)) return true;
    for (const row of this.pendingUpserts.values()) {
      if (row.serverId === serverId) return true;
    }
    for (const row of this.pendingDeletes.values()) {
      if (row.serverId === serverId) return true;
    }
    return false;
  }

  private advanceHostRevision(serverId: string): void {
    this.hostRevisions.set(serverId, (this.hostRevisions.get(serverId) ?? 0) + 1);
  }

  private drainPendingChanges(): PendingReplicaChanges {
    const changes = {
      upserts: [...this.pendingUpserts.values()],
      deletes: [...this.pendingDeletes.values()],
      directoryReplacements: this.pendingDirectoryReplacements,
    };
    this.pendingUpserts = new Map();
    this.pendingDeletes = new Map();
    this.pendingDirectoryReplacements = new Map();
    return changes;
  }

  private materializeDirectoryReplacements(pending: PendingReplicaChanges): ReplicaRowChanges {
    const deletes = new Map(pending.deletes.map((row) => [pendingRowKey(row), row]));
    for (const [serverId, desiredRows] of pending.directoryReplacements) {
      for (const row of this.storedRows.get(serverId)?.values() ?? []) {
        if (row.kind !== "timeline" && !desiredRows.has(rowKey(row))) {
          deletes.set(pendingRowKey(row), row);
        }
      }
    }
    return { upserts: pending.upserts, deletes: [...deletes.values()] };
  }

  private restorePendingChanges(changes: PendingReplicaChanges): void {
    for (const [serverId, desiredRows] of changes.directoryReplacements) {
      if (this.activeServerIds.has(serverId) && !this.pendingDirectoryReplacements.has(serverId)) {
        this.pendingDirectoryReplacements.set(serverId, desiredRows);
      }
    }
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
        this.adjustHostBytes(key.serverId, -rowBytes(previous));
      }
      touchedServerIds.add(key.serverId);
    }
    for (const row of changes.upserts) {
      const rows = this.storedRows.get(row.serverId) ?? new Map<string, ReplicaRow>();
      const previous = rows.get(rowKey(row));
      const previousBytes = previous ? rowBytes(previous) : 0;
      rows.set(rowKey(row), row);
      this.storedRows.set(row.serverId, rows);
      this.adjustHostBytes(row.serverId, rowBytes(row) - previousBytes);
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
        [...rows.values()].reduce((sum, row) => sum + rowBytes(row), 0),
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
      if (this.storedRows.has(serverId)) await this.rowStore.deleteHost(serverId);
      this.removeStoredHost(serverId);
      // The next accepted owner commit must rebuild the complete host replica. Retaining the
      // directory replacement marker ensures its checkpoint and rows stay atomic.
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
    this.pendingDirectoryReplacements.delete(serverId);
    for (const [key, row] of this.pendingUpserts) {
      if (row.serverId === serverId) this.pendingUpserts.delete(key);
    }
    for (const [key, row] of this.pendingDeletes) {
      if (row.serverId === serverId) this.pendingDeletes.delete(key);
    }
  }

  private renamePendingHostChanges(oldServerId: string, newServerId: string): void {
    const changes = this.drainPendingChanges();
    for (const [serverId, desiredRows] of changes.directoryReplacements) {
      this.pendingDirectoryReplacements.set(
        serverId === oldServerId ? newServerId : serverId,
        desiredRows,
      );
    }
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

  private ensureStoredIndex(): Promise<void> {
    this.storedIndexPromise ??= this.rowStore.readAll().then(async (hosts) => {
      this.storedRows.clear();
      this.hostBytes.clear();
      this.hostWriteOrder.clear();
      this.totalBytes = 0;
      for (const host of hosts) {
        if (!this.activeServerIds.has(host.serverId)) {
          await this.rowStore.deleteHost(host.serverId);
          continue;
        }
        const rows = new Map(host.rows.map((row) => [rowKey(row), row]));
        const bytes = host.rows.reduce((sum, row) => sum + rowBytes(row), 0);
        this.storedRows.set(host.serverId, rows);
        this.hostBytes.set(host.serverId, bytes);
        this.totalBytes += bytes;
        this.touchHost(host.serverId);
      }
      return undefined;
    });
    return this.storedIndexPromise;
  }

  private queueOperation(operation: () => Promise<void>): Promise<void> {
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        await this.prepareStore();
        await operation();
        return undefined;
      })
      .catch(() => undefined);
    return this.writeQueue;
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flushPending();
    }, PERSIST_DELAY_MS);
  }
}
