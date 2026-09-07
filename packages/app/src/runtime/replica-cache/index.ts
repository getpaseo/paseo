import { z } from "zod";
import {
  AgentStatusSchema,
  AgentAttachmentSchema,
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

export type DirectoryReplicaMutation =
  | { kind: "agent"; type: "upsert"; id: string; value: Agent }
  | { kind: "agent"; type: "delete"; id: string }
  | { kind: "workspace"; type: "upsert"; id: string; value: WorkspaceDescriptor }
  | { kind: "workspace"; type: "delete"; id: string }
  | { kind: "project"; type: "upsert"; id: string; value: ProjectDescriptor }
  | { kind: "project"; type: "delete"; id: string };

export interface CachedDirectory {
  agents: Map<string, Agent>;
  workspaces: Map<string, WorkspaceDescriptor>;
  projects: Map<string, ProjectDescriptor>;
  checkpoint?: DirectoryCheckpoint;
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

export interface CachedTimeline {
  agentId: string;
  items: StreamItem[];
  range: AgentTimelineCursorState | null;
  hasOlder: boolean;
}

const PERSIST_DELAY_MS = 1_000;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const IsoDateSchema = z.iso.datetime();
const TimelinePositionSchema = z.strictObject({
  epoch: z.string(),
  seq: z.number().int().nonnegative(),
});
const RowSourceSchema = z.strictObject({
  startSeq: z.number().int().nonnegative(),
  chunks: z
    .array(
      z.strictObject({
        seq: z.number().int().nonnegative(),
        offset: z.number().int().nonnegative(),
      }),
    )
    .optional(),
});
const StoredImageSchema = z.strictObject({
  id: z.string(),
  mimeType: z.string(),
  storageType: z.enum(["web-indexeddb", "desktop-file", "native-file"]),
  storageKey: z.string(),
  fileName: z.string().nullable().optional(),
  byteSize: z.number().nullable().optional(),
  createdAt: z.number(),
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
  // Absent on rows saved before source provenance existed.
  source: RowSourceSchema.optional(),
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
    images: z.array(StoredImageSchema).optional(),
    attachments: z.array(AgentAttachmentSchema).optional(),
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
  turn: z
    .discriminatedUnion("phase", [
      z.strictObject({ phase: z.literal("idle") }),
      z.strictObject({
        phase: z.literal("open"),
        turnId: z.string().nullable(),
        startedAt: IsoDateSchema.nullable(),
      }),
    ])
    .optional(),
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

type StructuredReplicaUpsert =
  | { serverId: string; kind: "agent"; id: string; value: Agent }
  | { serverId: string; kind: "workspace"; id: string; value: WorkspaceDescriptor }
  | { serverId: string; kind: "project"; id: string; value: ProjectDescriptor }
  | { serverId: string; kind: "timeline"; id: string; value: CachedTimeline }
  | { serverId: string; kind: "checkpoint"; id: string; value: DirectoryCheckpoint };

const DirectoryCursorSchema = z.strictObject({
  generation: z.string(),
  afterSeq: z.number().int().nonnegative(),
});

const DirectoryCheckpointSchema = z.strictObject({
  projects: DirectoryCursorSchema.optional(),
  workspaces: DirectoryCursorSchema.optional(),
  agents: DirectoryCursorSchema.optional(),
});

function deserializeTimeline(stored: StoredTimeline): CachedTimeline {
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
    ...(item.source ? { source: item.source } : {}),
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
      return { ...item, ...base };
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
      ...(item.source ? { source: item.source } : {}),
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
    ...(item.source ? { source: item.source } : {}),
    ...(item.turnId ? { turnId: item.turnId } : {}),
    timestamp: new Date(item.timestamp),
  };
  switch (item.kind) {
    case "user_message":
      return { ...item, ...base };
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

function serializeAgentTurn(agent: Agent): NonNullable<StoredAgent["turn"]> {
  if (agent.turn.phase === "idle") return { phase: "idle" };
  return {
    phase: "open",
    turnId: agent.turn.turnId,
    startedAt: agent.turn.startedAt?.toISOString() ?? null,
  };
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
    ...(agent.turn.phase === "open" && agent.turn.turnId
      ? {
          activeTurn: {
            turnId: agent.turn.turnId,
            startedAt: agent.turn.startedAt?.toISOString() ?? null,
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
    turn: serializeAgentTurn(agent),
    projectPlacement: serializeProjectPlacement(agent),
    lastActivityAt: agent.lastActivityAt.toISOString(),
  };
}

function deserializeAgent(serverId: string, stored: StoredAgent): Agent {
  const normalized = normalizeAgentSnapshot(stored.snapshot, serverId);
  let turn = normalized.turn;
  if (stored.turn?.phase === "idle") turn = { phase: "idle", cancellationRequestId: null };
  if (stored.turn?.phase === "open") {
    turn = {
      phase: "open",
      turnId: stored.turn.turnId,
      startedAt: stored.turn.startedAt ? new Date(stored.turn.startedAt) : null,
      cancellationRequestId: null,
    };
  }
  return {
    ...normalized,
    turn,
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

// A saved timeline is either certified or display-only. Certified rows keep the owner's restart page
// with its range, so the next launch resumes with one `after endSeq` page. Everything the range
// cannot vouch for (a discontiguous window or rows the schema cannot encode) falls back to a
// display-only tail that carries no coverage claim.
function isCertifiedTimeline(timeline: CachedTimeline): boolean {
  const range = timeline.range;
  return (
    range !== null &&
    range.retainedRanges === undefined &&
    timeline.items.every(
      (item) =>
        (item.kind === "user_message" && isUnreconciledLocalUserMessage(item)) ||
        ((item.kind !== "tool_call" || item.payload.source === "agent") &&
          item.source !== undefined &&
          item.timelineCursor?.epoch === range.epoch &&
          item.timelineCursor.seq >= range.startSeq &&
          item.timelineCursor.seq <= range.endSeq),
    )
  );
}

function serializeTimelinePayload(timeline: CachedTimeline): string {
  const items = timeline.items
    .filter((item) => item.kind !== "user_message" || !isUnreconciledLocalUserMessage(item))
    .map(serializeTimelineItem)
    .filter((item) => item !== null);
  const range = timeline.range;
  const certified = isCertifiedTimeline(timeline);
  return JSON.stringify({
    agentId: timeline.agentId,
    items,
    range:
      certified && range
        ? { epoch: range.epoch, startSeq: range.startSeq, endSeq: range.endSeq }
        : null,
    hasOlder: certified && timeline.hasOlder,
  } satisfies StoredTimeline);
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

const DIRECTORY_KINDS: readonly ReplicaRowKind[] = ["agent", "workspace", "project", "checkpoint"];

interface PendingRow {
  key: ReplicaRowKey;
  // Null is an accepted deletion.
  upsert: StructuredReplicaUpsert | null;
}

interface PendingBatch {
  rows: Map<string, PendingRow>;
  baselines: Map<string, symbol>;
}

// Scoped disk reads are overlaid by accepted commits, including changes that settled while
// a read was in flight. The full disk index serves write-behind budget accounting only.
export class ReplicaCache {
  private activeServerIds = new Set<string>();
  private readonly storedRows = new Map<string, Map<string, ReplicaRow>>();
  private readonly hostBytes = new Map<string, number>();
  private readonly hostWriteOrder = new Map<string, true>();
  private totalBytes = 0;
  private readonly pendingRows = new Map<string, PendingRow>();
  // Accepted commits overlay any disk read, including reads started before a write settled.
  private readonly acceptedRows = new Map<string, PendingRow>();
  private readonly acceptedBaselines = new Set<string>();
  private readonly hostSources = new Map<string, Set<string>>();
  private readonly pendingBaselines = new Map<string, symbol>();
  private readonly invalidatedHosts = new Set<string>();
  // Renames queued behind the initial load, so the load keeps the old host's rows for them.
  private readonly renamingHosts = new Map<string, string>();
  private readonly maxBytes: number;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  // Memory readiness: the initial load followed by every host identity change, in order.
  private image: Promise<boolean> | null = null;
  // Disk operations run in order; the initial load is the first of them once it starts.
  private disk: Promise<void> = Promise.resolve();
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly rowStore: ReplicaRowStore,
    options: ReplicaCacheOptions = {},
  ) {
    this.maxBytes = Math.max(options.maxBytes ?? MAX_CACHE_BYTES, 0);
    this.clearLegacyCache = options.clearLegacyCache ?? clearLegacyReplicaCache;
  }

  private readonly clearLegacyCache: () => Promise<void>;

  async readDirectory(serverId: string): Promise<CachedDirectory> {
    const rows = await this.readRows(serverId, DIRECTORY_KINDS);
    const result: DirectoryReadAccumulator = {
      agents: new Map(),
      workspaces: new Map(),
      projects: new Map(),
    };
    const invalidEntities = new Set<keyof DirectoryCheckpoint>();
    const invalidRows: ReplicaRow[] = [];
    for (const row of rows) {
      if ("value" in row) {
        switch (row.kind) {
          case "agent":
            result.agents.set(row.id, { ...row.value, serverId });
            break;
          case "workspace":
            result.workspaces.set(row.id, row.value);
            break;
          case "project":
            result.projects.set(row.id, row.value);
            break;
          case "checkpoint":
            result.checkpoint = row.value;
            break;
        }
        continue;
      }
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
      this.repairInvalidDirectoryRows(serverId, invalidRows, result.checkpoint);
    }
    return result;
  }

  async readTimeline(serverId: string, agentId: string): Promise<CachedTimeline | undefined> {
    const row = (await this.readRows(serverId, ["timeline"], [agentId]))[0];
    if (!row) return undefined;
    let timeline: CachedTimeline;
    if ("value" in row) {
      if (row.kind !== "timeline") return undefined;
      timeline = row.value;
    } else {
      try {
        const stored = parseStoredPayload(StoredTimelineSchema, row.payload);
        if (stored.agentId !== agentId) return undefined;
        timeline = deserializeTimeline(stored);
      } catch {
        this.queueDelete(row);
        this.schedulePersist();
        return undefined;
      }
    }
    const certified = isCertifiedTimeline(timeline);
    return {
      ...timeline,
      items: timeline.items.filter(
        (item) =>
          !(item.kind === "user_message" && isUnreconciledLocalUserMessage(item)) &&
          !(item.kind === "tool_call" && item.payload.source !== "agent"),
      ),
      range: certified ? timeline.range : null,
      hasOlder: certified && timeline.hasOlder,
    };
  }

  private async readRows(
    serverId: string,
    kinds: readonly ReplicaRowKind[],
    ids?: readonly string[],
  ): Promise<Array<ReplicaRow | StructuredReplicaUpsert>> {
    if (!this.activeServerIds.has(serverId)) return [];
    const sources = this.hostSources.get(serverId);
    if (!sources) return [];
    const sourceOrder = [...sources];
    const accepted = ids
      ? kinds.every((kind) =>
          ids.every((id) => this.acceptedRows.has(pendingRowKey({ serverId, kind, id }))),
        )
      : this.acceptedBaselines.has(serverId) && !kinds.includes("timeline");
    let stored: ReplicaRow[] = [];
    if (!accepted) {
      try {
        await this.rowStore.open();
        stored = await this.rowStore.read(sourceOrder, kinds, ids);
      } catch {
        // Accepted commits remain readable even if the disk is unavailable.
      }
    }
    if (this.hostSources.get(serverId) !== sources) return [];
    const accepts = (key: ReplicaRowKey) =>
      key.serverId === serverId && kinds.includes(key.kind) && (!ids || ids.includes(key.id));
    const rows = new Map<string, ReplicaRow | StructuredReplicaUpsert>();
    const replacingBaseline = this.acceptedBaselines.has(serverId);
    // Moved rows replace collisions at the destination, even before the disk rename commits.
    stored.sort((a, b) => sourceOrder.indexOf(b.serverId) - sourceOrder.indexOf(a.serverId));
    for (const row of stored) {
      if (replacingBaseline && row.kind !== "timeline") continue;
      rows.set(rowKey(row), { ...row, serverId });
    }
    for (const pending of this.acceptedRows.values()) {
      if (!accepts(pending.key)) continue;
      if (pending.upsert === null) rows.delete(rowKey(pending.key));
      else rows.set(rowKey(pending.key), pending.upsert);
    }
    return [...rows.values()];
  }

  private repairInvalidDirectoryRows(
    serverId: string,
    invalidRows: ReplicaRow[],
    checkpoint: DirectoryCheckpoint | undefined,
  ): void {
    for (const row of invalidRows) this.queueDelete(row);
    const checkpointWasInvalid = invalidRows.some((row) => row.kind === "checkpoint");
    if (checkpoint !== undefined && !checkpointWasInvalid) {
      this.queueUpsert({
        serverId,
        kind: "checkpoint",
        id: REPLICA_SINGLETON_ROW_ID,
        value: checkpoint,
      });
    }
    this.schedulePersist();
  }

  commitDirectoryMutations(
    serverId: string,
    mutations: readonly DirectoryReplicaMutation[],
    checkpoint?: DirectoryCheckpoint,
  ): void {
    if (!this.activeServerIds.has(serverId)) return;
    if (this.invalidatedHosts.has(serverId)) return;
    for (const mutation of mutations) {
      if (mutation.type === "delete") {
        this.queueDelete({ serverId, kind: mutation.kind, id: mutation.id });
      } else {
        this.queueUpsert({
          serverId,
          kind: mutation.kind,
          id: mutation.id,
          value: mutation.value,
        } as StructuredReplicaUpsert);
      }
    }
    if (checkpoint) {
      this.queueUpsert({
        serverId,
        kind: "checkpoint",
        id: REPLICA_SINGLETON_ROW_ID,
        value: checkpoint,
      });
    }
    this.schedulePersist();
  }

  replaceDirectoryBaseline(serverId: string, directory: CachedDirectory): void {
    if (!this.activeServerIds.has(serverId)) return;
    // Replacing the directory must not discard independently accepted timeline changes.
    for (const [key, pending] of this.pendingRows) {
      if (pending.key.serverId === serverId && pending.key.kind !== "timeline") {
        this.pendingRows.delete(key);
      }
    }
    this.pendingBaselines.set(serverId, Symbol("baseline"));
    this.acceptedBaselines.add(serverId);
    for (const [key, row] of this.acceptedRows) {
      if (row.key.serverId === serverId && row.key.kind !== "timeline")
        this.acceptedRows.delete(key);
    }
    for (const [id, value] of directory.agents) {
      this.queueUpsert({ serverId, kind: "agent", id, value });
    }
    for (const [id, value] of directory.workspaces) {
      this.queueUpsert({ serverId, kind: "workspace", id, value });
    }
    for (const [id, value] of directory.projects) {
      this.queueUpsert({ serverId, kind: "project", id, value });
    }
    if (directory.checkpoint) {
      this.queueUpsert({
        serverId,
        kind: "checkpoint",
        id: REPLICA_SINGLETON_ROW_ID,
        value: directory.checkpoint,
      });
    }
    this.schedulePersist();
  }

  removeTimeline(serverId: string, agentId: string): void {
    if (!this.activeServerIds.has(serverId)) return;
    this.queueDelete({ serverId, kind: "timeline", id: agentId });
    this.schedulePersist();
  }

  commitTimeline(
    serverId: string,
    agentId: string,
    timeline: CachedTimeline,
    requireCertified = false,
  ): void {
    if (!this.activeServerIds.has(serverId)) return;
    if (timeline.agentId !== agentId) throw new Error("Timeline cache key does not match payload");
    // The timeline authority can retain a good restart snapshot while its richer accepted
    // page cannot be represented with truthful coverage.
    if (requireCertified && !isCertifiedTimeline(timeline)) return;
    this.queueUpsert({ serverId, kind: "timeline", id: agentId, value: timeline });
    this.schedulePersist();
  }

  setHosts(serverIds: Iterable<string>): void {
    const next = new Set(serverIds);
    const removed = [...this.activeServerIds].filter((serverId) => !next.has(serverId));
    this.activeServerIds = next;
    for (const serverId of next) {
      if (!this.hostSources.has(serverId)) this.hostSources.set(serverId, new Set([serverId]));
    }
    for (const serverId of removed) {
      this.dropAcceptedHost(serverId);
      this.dropPendingHostChanges(serverId);
      this.invalidatedHosts.delete(serverId);
      this.applyToImage(() => this.removeStoredHost(serverId));
      void this.deleteStoredSource(serverId);
    }
  }

  reconcileServerId(oldServerId: string, newServerId: string): void {
    if (oldServerId === newServerId) return;
    this.renamePendingHostChanges(oldServerId, newServerId);
    const sources = this.hostSources.get(oldServerId) ?? new Set<string>();
    const retiredSources = new Set<string>();
    this.hostSources.set(oldServerId, retiredSources);
    this.hostSources.set(newServerId, new Set([...sources, newServerId]));
    if (this.acceptedBaselines.delete(oldServerId)) this.acceptedBaselines.add(newServerId);
    for (const [key, row] of this.acceptedRows) {
      if (row.key.serverId !== oldServerId) continue;
      this.acceptedRows.delete(key);
      const renamed = {
        key: { ...row.key, serverId: newServerId },
        upsert: row.upsert ? { ...row.upsert, serverId: newServerId } : null,
      };
      this.acceptedRows.set(pendingRowKey(renamed.key), renamed);
    }
    if (this.activeServerIds.delete(oldServerId)) this.activeServerIds.add(newServerId);
    this.renamingHosts.set(oldServerId, newServerId);
    this.applyToImage(() => {
      this.renamingHosts.delete(oldServerId);
      this.renameStoredHost(oldServerId, newServerId);
    });
    void this.queueDisk(async () => {
      await this.rowStore.renameHost(oldServerId, newServerId);
      for (const aliases of this.hostSources.values()) aliases.delete(oldServerId);
      if (this.hostSources.get(oldServerId) === retiredSources) retiredSources.add(oldServerId);
    });
  }

  async flush(): Promise<void> {
    await this.persist();
    await this.disk;
  }

  private ready(): Promise<boolean> {
    this.image ??= this.queueDisk(() => this.loadStoredRows()).then(
      () => true,
      () => {
        this.image = null;
        return false;
      },
    );
    return this.image;
  }

  private async loadStoredRows(): Promise<void> {
    // COMPAT(replica-blob-cache): remove after 2026-11
    await this.clearLegacyCache().catch(() => undefined);
    const hosts = await this.rowStore.readAll();
    for (const host of hosts) {
      if (!this.activeServerIds.has(host.serverId) && !this.renamingHosts.has(host.serverId)) {
        await this.rowStore.deleteHost(host.serverId);
      }
    }
    // Publish only after all fallible work succeeds; retries must not count partial loads twice.
    for (const host of hosts) {
      if (!this.activeServerIds.has(host.serverId) && !this.renamingHosts.has(host.serverId)) {
        continue;
      }
      const rows = new Map(host.rows.map((row) => [rowKey(row), row]));
      const bytes = host.rows.reduce((sum, row) => sum + rowBytes(row), 0);
      this.storedRows.set(host.serverId, rows);
      this.hostBytes.set(host.serverId, bytes);
      this.totalBytes += bytes;
      this.touchHost(host.serverId);
    }
  }

  // Keep budget accounting in order with its initial load and host identity changes.
  private applyToImage(mutation: () => void): void {
    if (this.image === null) {
      mutation();
      return;
    }
    this.image = this.image.then((loaded) => {
      // Identity changes still settle when loading fails; the next attempt reads their disk result.
      mutation();
      return loaded;
    });
  }

  private queueDisk(operation: () => Promise<void>): Promise<void> {
    const run = this.disk.then(async () => {
      await this.rowStore.open();
      await operation();
      return undefined;
    });
    this.disk = run.catch(() => undefined);
    return run;
  }

  private persist(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    const write = this.writes.then(() => this.writePendingChanges());
    this.writes = write.catch(() => undefined);
    return write;
  }

  private async writePendingChanges(): Promise<void> {
    if (!this.hasPendingChanges()) return;
    if (!(await this.ready())) {
      this.schedulePersist();
      return;
    }
    const batch: PendingBatch = {
      rows: new Map(this.pendingRows),
      baselines: new Map(this.pendingBaselines),
    };
    const changes = this.materializeBatch(batch);
    const { changes: boundedChanges, evicted } = await this.fitChangesToBudget(changes);
    if (boundedChanges.upserts.length > 0 || boundedChanges.deletes.length > 0) {
      try {
        await this.queueDisk(() => this.rowStore.apply(boundedChanges));
      } catch {
        this.schedulePersist();
        return;
      }
    }
    // The write commits to the mirror only what is still pending unchanged. A host removed or
    // renamed meanwhile already dropped or re-keyed its pending rows, and its disk delete or
    // rename is queued behind this write, so the rows just written must not reappear in memory.
    // A row replaced meanwhile stays pending and is written again.
    const settled = (key: ReplicaRowKey) => {
      const pending = batch.rows.get(pendingRowKey(key));
      return pending !== undefined && this.pendingRows.get(pendingRowKey(key)) === pending;
    };
    const baselineSettled = (serverId: string) =>
      this.pendingBaselines.get(serverId) === batch.baselines.get(serverId);
    this.applyStoredChanges({
      upserts: boundedChanges.upserts.filter(settled),
      deletes: boundedChanges.deletes.filter(
        (key) =>
          settled(key) || (!batch.rows.has(pendingRowKey(key)) && baselineSettled(key.serverId)),
      ),
    });
    for (const [key, pending] of batch.rows) {
      if (this.pendingRows.get(key) === pending) this.pendingRows.delete(key);
    }
    for (const [serverId, token] of batch.baselines) {
      if (this.pendingBaselines.get(serverId) !== token) continue;
      this.pendingBaselines.delete(serverId);
      if (!evicted.has(serverId)) this.invalidatedHosts.delete(serverId);
    }
  }

  private queueUpsert(upsert: StructuredReplicaUpsert): void {
    const row = { key: upsert, upsert };
    this.pendingRows.set(pendingRowKey(upsert), row);
    this.acceptedRows.set(pendingRowKey(upsert), row);
  }

  private queueDelete(key: ReplicaRowKey): void {
    const { serverId, kind, id } = key;
    const row = { key: { serverId, kind, id }, upsert: null };
    this.pendingRows.set(pendingRowKey(key), row);
    this.acceptedRows.set(pendingRowKey(key), row);
  }

  private hasPendingChanges(): boolean {
    return this.pendingRows.size > 0 || this.pendingBaselines.size > 0;
  }

  private materializeBatch(batch: PendingBatch): ReplicaRowChanges {
    const deletes = new Map<string, ReplicaRowKey>();
    const upserts: ReplicaRow[] = [];
    for (const pending of batch.rows.values()) {
      if (pending.upsert === null) deletes.set(pendingRowKey(pending.key), pending.key);
      else upserts.push(materializeUpsert(pending.upsert));
    }
    for (const serverId of batch.baselines.keys()) {
      const replacementKeys = new Set(
        upserts.filter((row) => row.serverId === serverId && row.kind !== "timeline").map(rowKey),
      );
      for (const row of this.storedRows.get(serverId)?.values() ?? []) {
        if (row.kind !== "timeline" && !replacementKeys.has(rowKey(row))) {
          deletes.set(pendingRowKey(row), row);
        }
      }
    }
    return { upserts, deletes: [...deletes.values()] };
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

  private async fitChangesToBudget(
    changes: ReplicaRowChanges,
  ): Promise<{ changes: ReplicaRowChanges; evicted: Set<string> }> {
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
      projectedTotal -= projectedBytes.get(serverId) ?? 0;
      projectedBytes.delete(serverId);
      evicted.add(serverId);
      this.invalidatedHosts.add(serverId);
      this.dropPendingHostChanges(serverId);
      this.dropAcceptedHost(serverId);
      await this.deleteStoredSource(serverId).catch(() => undefined);
      this.removeStoredHost(serverId);
    }

    return {
      changes: {
        upserts: changes.upserts.filter((row) => !evicted.has(row.serverId)),
        deletes: changes.deletes.filter((key) => !evicted.has(key.serverId)),
      },
      evicted,
    };
  }

  private dropAcceptedHost(serverId: string): void {
    this.hostSources.set(serverId, new Set());
    this.acceptedBaselines.delete(serverId);
    for (const [key, row] of this.acceptedRows) {
      if (row.key.serverId === serverId) this.acceptedRows.delete(key);
    }
  }

  private deleteStoredSource(serverId: string): Promise<void> {
    const sources = this.hostSources.get(serverId);
    return this.queueDisk(async () => {
      await this.rowStore.deleteHost(serverId);
      if (this.hostSources.get(serverId) === sources) sources?.add(serverId);
    });
  }

  private removeStoredHost(serverId: string): void {
    this.totalBytes -= this.hostBytes.get(serverId) ?? 0;
    this.storedRows.delete(serverId);
    this.hostBytes.delete(serverId);
    this.hostWriteOrder.delete(serverId);
  }

  private renameStoredHost(oldServerId: string, newServerId: string): void {
    const rows = this.storedRows.get(oldServerId);
    if (!rows) return;
    const newRows = this.storedRows.get(newServerId) ?? new Map<string, ReplicaRow>();
    this.removeStoredHost(oldServerId);
    this.removeStoredHost(newServerId);
    for (const [key, row] of rows) newRows.set(key, { ...row, serverId: newServerId });
    this.storedRows.set(newServerId, newRows);
    const bytes = [...newRows.values()].reduce((sum, row) => sum + rowBytes(row), 0);
    this.hostBytes.set(newServerId, bytes);
    this.totalBytes += bytes;
    this.touchHost(newServerId);
  }

  private dropPendingHostChanges(serverId: string): void {
    this.pendingBaselines.delete(serverId);
    for (const [key, pending] of this.pendingRows) {
      if (pending.key.serverId === serverId) this.pendingRows.delete(key);
    }
  }

  private renamePendingHostChanges(oldServerId: string, newServerId: string): void {
    const renamed = [...this.pendingRows.values()].filter(
      (pending) => pending.key.serverId === oldServerId,
    );
    for (const pending of renamed) {
      this.pendingRows.delete(pendingRowKey(pending.key));
      const key = { ...pending.key, serverId: newServerId };
      this.pendingRows.set(pendingRowKey(key), {
        key,
        upsert: pending.upsert ? { ...pending.upsert, serverId: newServerId } : null,
      });
    }
    const baseline = this.pendingBaselines.get(oldServerId);
    if (baseline) {
      this.pendingBaselines.delete(oldServerId);
      this.pendingBaselines.set(newServerId, baseline);
    }
    if (this.invalidatedHosts.delete(oldServerId)) this.invalidatedHosts.add(newServerId);
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist();
    }, PERSIST_DELAY_MS);
  }
}

function materializeUpsert(upsert: StructuredReplicaUpsert): ReplicaRow {
  let payload: string;
  switch (upsert.kind) {
    case "agent":
      payload = JSON.stringify(serializeAgent(upsert.value));
      break;
    case "workspace":
      payload = JSON.stringify(serializeWorkspace(upsert.value));
      break;
    case "project":
      payload = JSON.stringify(serializeProject(upsert.value));
      break;
    case "timeline":
      payload = serializeTimelinePayload(upsert.value);
      break;
    case "checkpoint":
      payload = JSON.stringify(upsert.value);
      break;
  }
  return { serverId: upsert.serverId, kind: upsert.kind, id: upsert.id, payload };
}
