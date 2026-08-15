import { Buffer } from "buffer";
import { z } from "zod";
import { AgentStatusSchema, AgentTimelineItemPayloadSchema } from "@getpaseo/protocol/messages";
import { AgentProviderSchema } from "@getpaseo/protocol/provider-manifest";
import {
  normalizeProjectDescriptor,
  normalizeWorkspaceDescriptor,
  selectAgentTimelineState,
  useSessionStore,
  type Agent,
  type SessionReplica,
  type SessionReplicaTimeline,
  type SessionState,
  type ProjectDescriptor,
  type WorkspaceDescriptor,
} from "@/stores/session-store";
import { isUnreconciledLocalUserMessage, type StreamItem } from "@/types/stream";
import { normalizeAgentSnapshot } from "@/utils/agent-snapshots";

const STORAGE_KEY = "@paseo:replica-cache";
const CACHE_VERSION = 6;
const PERSIST_DELAY_MS = 750;
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
    activityType: z.enum(["system", "info", "success", "warning", "error"]),
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
  status: z.enum(["needs_input", "failed", "running", "attention", "done"]),
  statusEnteredAt: IsoDateSchema.nullable(),
  activityAt: z.null(),
  archivingAt: z.string().nullable(),
  diffStat: z.strictObject({ additions: z.number(), deletions: z.number() }).nullable(),
  scripts: z.array(WorkspaceScriptSchema),
  gitRuntime: WorkspaceGitRuntimeSchema,
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

const StoredCacheSchema = z.strictObject({
  version: z.literal(CACHE_VERSION),
  hosts: z.array(StoredHostSchema),
});

type StoredAgent = z.infer<typeof StoredAgentSchema>;
type StoredHost = z.infer<typeof StoredHostSchema>;
type StoredTimelineItem = z.infer<typeof StoredTimelineItemSchema>;
type StoredWorkspace = z.infer<typeof StoredWorkspaceSchema>;
type StoredProject = z.infer<typeof StoredProjectSchema>;

interface ReplicaInput {
  agents: ReadonlyMap<string, Agent>;
  workspaces: ReadonlyMap<string, WorkspaceDescriptor>;
  projects: ReadonlyMap<string, ProjectDescriptor>;
  focusedAgent: Agent | undefined;
  timelineItems: StreamItem[] | undefined;
  timelineRange: SessionReplicaTimeline["range"];
  timelineHasOlder: boolean;
}

export interface ReplicaCacheStorage {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
}

interface ReplicaCacheOptions {
  maxBytes?: number;
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
    timestamp: item.timestamp.toISOString(),
  };
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
      const storedTool = AgentTimelineItemPayloadSchema.safeParse({
        type: "tool_call",
        callId: item.payload.data.callId,
        name: item.payload.data.name,
        status: item.payload.data.status,
        error: item.payload.data.error,
        detail: item.payload.data.detail,
        ...(item.payload.data.metadata ? { metadata: item.payload.data.metadata } : {}),
      });
      if (!storedTool.success || storedTool.data.type !== "tool_call") return null;
      return {
        ...base,
        kind: item.kind,
        provider: item.payload.data.provider,
        item: storedTool.data,
      };
  }
}

function deserializeTimelineItem(item: StoredTimelineItem): StreamItem {
  const base = {
    id: item.id,
    ...(item.timelineCursor ? { timelineCursor: item.timelineCursor } : {}),
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

function replicaInputsEqual(left: ReplicaInput, right: ReplicaInput): boolean {
  return (
    left.agents === right.agents &&
    left.workspaces === right.workspaces &&
    left.projects === right.projects &&
    left.focusedAgent === right.focusedAgent &&
    left.timelineItems === right.timelineItems &&
    left.timelineRange === right.timelineRange &&
    left.timelineHasOlder === right.timelineHasOlder
  );
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
    focusedAgent: agent,
    timelineItems: timeline.status === "cold" ? undefined : timeline.items,
    timelineRange: timeline.status === "synced" ? timeline.range : null,
    timelineHasOlder: timeline.status === "synced" && timeline.older === "available",
  };
}

function serializeHost(serverId: string, input: ReplicaInput, directorySync?: unknown): StoredHost {
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
  return {
    serverId,
    agents: Array.from(input.agents.values(), serializeAgent),
    workspaces: Array.from(input.workspaces.values(), serializeWorkspace),
    projects: Array.from(input.projects.values(), serializeProject),
    emptyProjects: [],
    timeline:
      input.focusedAgent && items
        ? {
            agentId: input.focusedAgent.id,
            items: items.slice(-MAX_TIMELINE_ITEMS),
            range: canPersistCoverage
              ? { epoch: range.epoch, startSeq: range.startSeq, endSeq: range.endSeq }
              : null,
            hasOlder: canPersistCoverage ? input.timelineHasOlder : false,
          }
        : null,
    ...(directorySync ? { directorySync } : {}),
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

export class ReplicaCache {
  private readonly activeServerIds = new Set<string>();
  private readonly storedHosts = new Map<string, StoredHost>();
  private readonly lastFocusedAgentIds = new Map<string, string>();
  private readonly capturedInputs = new Map<string, ReplicaInput>();
  private readonly maxBytes: number;
  private needsPersist = false;
  private unsubscribe: (() => void) | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: ReplicaCacheStorage,
    options: ReplicaCacheOptions = {},
  ) {
    const emptyPayloadBytes = Buffer.byteLength(
      JSON.stringify({ version: CACHE_VERSION, hosts: [] }),
      "utf8",
    );
    this.maxBytes = Math.max(options.maxBytes ?? MAX_CACHE_BYTES, emptyPayloadBytes);
  }

  setHosts(serverIds: Iterable<string>): void {
    const next = new Set(serverIds);
    this.activeServerIds.clear();
    for (const serverId of next) this.activeServerIds.add(serverId);
    let removedStoredHost = false;
    for (const serverId of this.storedHosts.keys()) {
      if (!next.has(serverId)) {
        this.storedHosts.delete(serverId);
        removedStoredHost = true;
      }
    }
    for (const serverId of this.lastFocusedAgentIds.keys()) {
      if (!next.has(serverId)) this.lastFocusedAgentIds.delete(serverId);
    }
    for (const serverId of this.capturedInputs.keys()) {
      if (!next.has(serverId)) this.capturedInputs.delete(serverId);
    }
    if (removedStoredHost) this.needsPersist = true;
    if (this.unsubscribe && this.needsPersist) this.schedulePersist();
  }

  async restore(): Promise<void> {
    let raw: string | null;
    try {
      raw = await this.storage.getItem(STORAGE_KEY);
    } catch {
      return;
    }
    if (!raw) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await this.clearInvalidCache();
      return;
    }
    const cache = StoredCacheSchema.safeParse(parsed);
    if (!cache.success) {
      await this.clearInvalidCache();
      return;
    }
    for (const host of cache.data.hosts) {
      if (!this.activeServerIds.has(host.serverId)) {
        this.needsPersist = true;
        continue;
      }
      this.storedHosts.set(host.serverId, host);
      if (host.timeline) this.lastFocusedAgentIds.set(host.serverId, host.timeline.agentId);
    }
    const bounded = this.buildBoundedPayload();
    if (!bounded) {
      await this.clearInvalidCache();
      this.storedHosts.clear();
      return;
    }
    if (bounded.evicted) this.needsPersist = true;
    for (const host of this.storedHosts.values()) {
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

  start(): void {
    if (this.unsubscribe) return;
    const changedBeforeSubscription = this.captureSessions();
    this.unsubscribe = useSessionStore.subscribe((state) => {
      if (this.activeServerIds.size === 0) return;
      let changed = false;
      for (const serverId of this.activeServerIds) {
        const session = state.sessions[serverId];
        if (session && this.captureHost(serverId, session)) changed = true;
      }
      if (changed) this.schedulePersist();
    });
    if (changedBeforeSubscription || this.needsPersist) this.schedulePersist();
  }

  reconcileServerId(oldServerId: string, newServerId: string): void {
    const stored = this.storedHosts.get(oldServerId);
    if (stored) {
      this.storedHosts.delete(oldServerId);
      this.storedHosts.set(newServerId, { ...stored, serverId: newServerId });
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
    if (this.activeServerIds.delete(oldServerId)) this.activeServerIds.add(newServerId);
    this.needsPersist = true;
    this.schedulePersist();
  }

  readDirectoryCheckpoint(serverId: string): unknown {
    return this.storedHosts.get(serverId)?.directorySync;
  }

  writeDirectoryCheckpoint(serverId: string, checkpoint: unknown): void {
    let stored = this.storedHosts.get(serverId);
    if (!stored) {
      const session = useSessionStore.getState().sessions[serverId];
      if (!session) return;
      const input = selectReplicaInput(session, this.lastFocusedAgentIds.get(serverId) ?? null);
      this.capturedInputs.set(serverId, input);
      stored = serializeHost(serverId, input);
    }
    this.storedHosts.delete(serverId);
    this.storedHosts.set(serverId, { ...stored, directorySync: checkpoint });
    this.schedulePersist();
  }

  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.captureSessions();
    const bounded = this.buildBoundedPayload();
    this.needsPersist = false;
    if (!bounded) {
      await this.clearInvalidCache();
      return;
    }
    const write = this.writeQueue
      .catch(() => undefined)
      .then(() => this.storage.setItem(STORAGE_KEY, bounded.payload));
    this.writeQueue = write;
    await write.catch(() => undefined);
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

  private captureHost(serverId: string, session: SessionState): boolean {
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
    if (previous && replicaInputsEqual(previous, input)) return false;

    this.capturedInputs.set(serverId, input);
    const directorySync = this.storedHosts.get(serverId)?.directorySync;
    this.storedHosts.delete(serverId);
    this.storedHosts.set(serverId, serializeHost(serverId, input, directorySync));
    return true;
  }

  private buildBoundedPayload(): { payload: string; evicted: boolean } | null {
    let evicted = false;
    let payload = this.serialize();
    if (payload === null) return null;
    while (Buffer.byteLength(payload, "utf8") > this.maxBytes && this.storedHosts.size > 0) {
      const oldestServerId = this.storedHosts.keys().next().value;
      if (oldestServerId === undefined) break;
      this.storedHosts.delete(oldestServerId);
      evicted = true;
      payload = this.serialize();
      if (payload === null) return null;
    }
    return { payload, evicted };
  }

  private serialize(): string | null {
    const cache = StoredCacheSchema.safeParse({
      version: CACHE_VERSION,
      hosts: Array.from(this.storedHosts.values()),
    });
    return cache.success ? JSON.stringify(cache.data) : null;
  }

  private async clearInvalidCache(): Promise<void> {
    try {
      await this.storage.removeItem(STORAGE_KEY);
    } catch {
      // A storage failure must not turn invalid cached data into application state.
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flush();
    }, PERSIST_DELAY_MS);
  }
}
