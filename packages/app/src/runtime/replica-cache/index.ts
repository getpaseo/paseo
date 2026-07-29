import { Buffer } from "buffer";
import { z } from "zod";
import {
  AgentSnapshotPayloadSchema,
  ProjectPlacementPayloadSchema,
  WorkspaceDescriptorPayloadSchema,
  WorkspaceProjectDescriptorPayloadSchema,
  type AgentSnapshotPayload,
  type WorkspaceDescriptorPayload,
} from "@getpaseo/protocol/messages";
import {
  normalizeEmptyProjectDescriptor,
  normalizeWorkspaceDescriptor,
  useSessionStore,
  type Agent,
  type SessionReplica,
  type SessionState,
  type WorkspaceDescriptor,
} from "@/stores/session-store";
import type { StreamItem } from "@/types/stream";
import { normalizeAgentSnapshot } from "@/utils/agent-snapshots";

const STORAGE_KEY = "@paseo:replica-cache";
const CACHE_VERSION = 1;
const PERSIST_DELAY_MS = 750;
const MAX_TIMELINE_ITEMS = 50;
const MAX_CACHE_BYTES = 1024 * 1024;
const DATE_TAG = "__paseoDate";

const StoredAgentSchema = z.object({
  snapshot: AgentSnapshotPayloadSchema,
  projectPlacement: ProjectPlacementPayloadSchema.nullable(),
  lastActivityAt: z.string(),
});

const StoredTimelineSchema = z.object({
  agentId: z.string(),
  items: z.unknown(),
  cursor: z
    .object({
      epoch: z.string(),
      startSeq: z.number().int().nonnegative(),
      endSeq: z.number().int().nonnegative(),
    })
    .nullable(),
  hasOlder: z.boolean(),
});

const StoredHostSchema = z.object({
  serverId: z.string(),
  agents: z.array(StoredAgentSchema),
  workspaces: z.array(WorkspaceDescriptorPayloadSchema),
  emptyProjects: z.array(WorkspaceProjectDescriptorPayloadSchema),
  timeline: StoredTimelineSchema.nullable(),
});

const StoredCacheSchema = z.object({
  version: z.literal(CACHE_VERSION),
  hosts: z.array(StoredHostSchema),
});

type StoredAgent = z.infer<typeof StoredAgentSchema>;
type StoredHost = z.infer<typeof StoredHostSchema>;

export interface ReplicaCacheStorage {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
}

interface ReplicaCacheOptions {
  maxBytes?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === "string";
}

function isStreamItem(value: unknown): value is StreamItem {
  if (!isRecord(value) || !hasString(value, "id") || !(value.timestamp instanceof Date)) {
    return false;
  }
  switch (value.kind) {
    case "user_message":
    case "assistant_message":
      return hasString(value, "text");
    case "thought":
      return hasString(value, "text") && (value.status === "loading" || value.status === "ready");
    case "tool_call":
      return isRecord(value.payload) && isRecord(value.payload.data);
    case "todo_list":
      return hasString(value, "provider") && Array.isArray(value.items);
    case "activity_log":
      return hasString(value, "message") && hasString(value, "activityType");
    case "compaction":
      return value.status === "loading" || value.status === "completed";
    default:
      return false;
  }
}

function encodeDates(value: unknown): unknown {
  if (value instanceof Date) {
    return { [DATE_TAG]: value.toISOString() };
  }
  if (Array.isArray(value)) {
    return value.map(encodeDates);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, encodeDates(entry)]));
}

function decodeDates(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(decodeDates);
  }
  if (!isRecord(value)) {
    return value;
  }
  if (Object.keys(value).length === 1 && typeof value[DATE_TAG] === "string") {
    const date = new Date(value[DATE_TAG]);
    return Number.isNaN(date.getTime()) ? value : date;
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, decodeDates(entry)]));
}

function deserializeTimeline(stored: StoredHost["timeline"]): SessionReplica["timeline"] {
  if (!stored) {
    return null;
  }
  const decoded = decodeDates(stored.items);
  if (!Array.isArray(decoded) || !decoded.every(isStreamItem)) {
    return null;
  }
  return {
    agentId: stored.agentId,
    items: decoded,
    cursor: stored.cursor,
    hasOlder: stored.hasOlder,
  };
}

function serializeAgent(agent: Agent): StoredAgent {
  const snapshot: AgentSnapshotPayload = {
    id: agent.id,
    provider: agent.provider,
    cwd: agent.cwd,
    ...(agent.workspaceId ? { workspaceId: agent.workspaceId } : {}),
    model: agent.model,
    ...(agent.features ? { features: agent.features } : {}),
    thinkingOptionId: agent.thinkingOptionId ?? null,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
    lastUserMessageAt: agent.lastUserMessageAt?.toISOString() ?? null,
    status: agent.status,
    capabilities: agent.capabilities,
    currentModeId: agent.currentModeId,
    availableModes: agent.availableModes,
    pendingPermissions: [],
    persistence: agent.persistence,
    ...(agent.runtimeInfo ? { runtimeInfo: agent.runtimeInfo } : {}),
    ...(agent.lastUsage ? { lastUsage: agent.lastUsage } : {}),
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
    projectPlacement: agent.projectPlacement ?? null,
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

function serializeWorkspace(workspace: WorkspaceDescriptor): WorkspaceDescriptorPayload {
  return {
    id: workspace.id,
    projectId: workspace.projectId,
    projectDisplayName: workspace.projectDisplayName,
    projectCustomName: workspace.projectCustomName ?? null,
    projectRootPath: workspace.projectRootPath,
    workspaceDirectory: workspace.workspaceDirectory,
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
    scripts: workspace.scripts,
    gitRuntime: workspace.gitRuntime,
    githubRuntime: workspace.githubRuntime,
    forge: workspace.forge,
    project: workspace.project,
  };
}

function deserializeHost(stored: StoredHost): SessionReplica {
  const agents = stored.agents.map((entry) => deserializeAgent(stored.serverId, entry));
  const workspaces = stored.workspaces.map(normalizeWorkspaceDescriptor);
  const emptyProjects = stored.emptyProjects.map(normalizeEmptyProjectDescriptor);
  return {
    agents: new Map(agents.map((agent) => [agent.id, agent])),
    workspaces: new Map(workspaces.map((workspace) => [workspace.id, workspace])),
    emptyProjects: new Map(emptyProjects.map((project) => [project.projectId, project])),
    timeline: deserializeTimeline(stored.timeline),
  };
}

export class ReplicaCache {
  private readonly activeServerIds = new Set<string>();
  private readonly storedHosts = new Map<string, StoredHost>();
  private readonly lastFocusedAgentIds = new Map<string, string>();
  private readonly capturedSessions = new Map<string, SessionState>();
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
    for (const serverId of this.capturedSessions.keys()) {
      if (!next.has(serverId)) this.capturedSessions.delete(serverId);
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
      return;
    }
    const cache = StoredCacheSchema.safeParse(parsed);
    if (!cache.success) return;
    for (const host of cache.data.hosts) {
      if (!this.activeServerIds.has(host.serverId)) {
        this.needsPersist = true;
        continue;
      }
      this.storedHosts.set(host.serverId, host);
      if (host.timeline) this.lastFocusedAgentIds.set(host.serverId, host.timeline.agentId);
    }
    if (this.buildBoundedPayload().evicted) this.needsPersist = true;
    for (const host of this.storedHosts.values()) {
      useSessionStore.getState().restoreSessionReplica(host.serverId, deserializeHost(host));
      const session = useSessionStore.getState().sessions[host.serverId];
      if (session) this.capturedSessions.set(host.serverId, session);
    }
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = useSessionStore.subscribe((state) => {
      if (this.activeServerIds.size === 0) return;
      for (const serverId of this.activeServerIds) {
        const focusedAgentId = state.sessions[serverId]?.focusedAgentId;
        if (focusedAgentId) this.lastFocusedAgentIds.set(serverId, focusedAgentId);
      }
      this.schedulePersist();
    });
    if (this.needsPersist) this.schedulePersist();
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
    const capturedSession = this.capturedSessions.get(oldServerId);
    if (capturedSession) {
      this.capturedSessions.delete(oldServerId);
      this.capturedSessions.set(newServerId, capturedSession);
    }
    if (this.activeServerIds.delete(oldServerId)) this.activeServerIds.add(newServerId);
    this.needsPersist = true;
    this.schedulePersist();
  }

  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.captureSessions();
    const { payload } = this.buildBoundedPayload();
    this.needsPersist = false;
    const write = this.writeQueue
      .catch(() => undefined)
      .then(() => this.storage.setItem(STORAGE_KEY, payload));
    this.writeQueue = write;
    await write.catch(() => undefined);
  }

  private captureSessions(): void {
    const sessions = useSessionStore.getState().sessions;
    for (const serverId of this.activeServerIds) {
      const session = sessions[serverId];
      if (!session) continue;
      if (this.capturedSessions.get(serverId) === session) continue;
      this.capturedSessions.set(serverId, session);
      if (session.focusedAgentId) {
        this.lastFocusedAgentIds.set(serverId, session.focusedAgentId);
      }
      const focusedAgentId = this.lastFocusedAgentIds.get(serverId) ?? null;
      const focusedAgent = focusedAgentId ? session.agents.get(focusedAgentId) : undefined;
      const focusedWorkspace = focusedAgent
        ? ((focusedAgent.workspaceId
            ? session.workspaces.get(focusedAgent.workspaceId)
            : undefined) ??
          Array.from(session.workspaces.values()).find(
            (workspace) => workspace.workspaceDirectory === focusedAgent.cwd,
          ))
        : undefined;
      const items = focusedAgentId ? session.agentStreamTail.get(focusedAgentId) : undefined;
      const timeline =
        focusedAgent && items
          ? {
              agentId: focusedAgent.id,
              items: encodeDates(items.slice(-MAX_TIMELINE_ITEMS)),
              cursor: session.agentTimelineCursor.get(focusedAgent.id) ?? null,
              hasOlder: session.agentTimelineHasOlder.get(focusedAgent.id) ?? false,
            }
          : null;
      const stored: StoredHost = {
        serverId,
        agents: focusedAgent ? [serializeAgent(focusedAgent)] : [],
        workspaces: focusedWorkspace ? [serializeWorkspace(focusedWorkspace)] : [],
        emptyProjects: [],
        timeline,
      };
      this.storedHosts.delete(serverId);
      this.storedHosts.set(serverId, stored);
    }
  }

  private buildBoundedPayload(): { payload: string; evicted: boolean } {
    let evicted = false;
    let payload = this.serialize();
    while (Buffer.byteLength(payload, "utf8") > this.maxBytes && this.storedHosts.size > 0) {
      const oldestServerId = this.storedHosts.keys().next().value;
      if (oldestServerId === undefined) break;
      this.storedHosts.delete(oldestServerId);
      evicted = true;
      payload = this.serialize();
    }
    return { payload, evicted };
  }

  private serialize(): string {
    return JSON.stringify({
      version: CACHE_VERSION,
      hosts: Array.from(this.storedHosts.values()),
    });
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flush();
    }, PERSIST_DELAY_MS);
  }
}
