import equal from "fast-deep-equal";
import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ViewedTimelineUiBridge } from "@/timeline/viewed-timeline-sync";
import type { AgentDirectoryEntry } from "@/types/agent-directory";
import { type StreamItem, type TodoEntry } from "@/types/stream";
import {
  getActiveMessageSubmissions,
  type MessageSubmissionRecord,
} from "@/composer/submission/model";
import type { PendingPermission } from "@/types/shared";
import type { ComposerAttachment } from "@/attachments/types";
import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";
import type {
  AgentPermissionRequest,
  AgentFeature,
  AgentProvider,
  AgentMode,
  AgentCapabilityFlags,
  AgentUsage,
  AgentPersistenceHandle,
} from "@getpaseo/protocol/agent-types";
import type {
  ServerInfoStatusPayload,
  ProjectPlacementPayload,
  ServerCapabilities,
  WorkspaceDescriptorPayload,
  WorkspaceProjectDescriptorPayload,
} from "@getpaseo/protocol/messages";
import {
  normalizeWorkspaceOpaqueId,
  normalizeWorkspacePath,
  resolveWorkspaceMapKeyByIdentity,
} from "@/utils/workspace-identity";
import {
  createAgentLastActivityCoalescer,
  type AgentLastActivityCommitter,
} from "@/runtime/activity";
import {
  buildWorkspaceAgentActivityIndex,
  type WorkspaceAgentActivity,
} from "@/utils/workspace-agent-activity";
import {
  resolveTurnPresentation,
  TURN_LIVENESS_IDLE,
  type TurnLiveness,
  type TurnPresentation,
} from "@/timeline/turn-liveness";

export interface AgentRuntimeInfo {
  provider: AgentProvider;
  sessionId: string | null;
  model?: string | null;
  modeId?: string | null;
  thinkingOptionId?: string | null;
  extra?: Record<string, unknown>;
}

export interface Agent {
  serverId: string;
  id: string;
  provider: AgentProvider;
  status: AgentLifecycleStatus;
  turn: TurnLiveness;
  createdAt: Date;
  updatedAt: Date;
  lastUserMessageAt: Date | null;
  lastActivityAt: Date;
  capabilities: AgentCapabilityFlags;
  currentModeId: string | null;
  availableModes: AgentMode[];
  pendingPermissions: AgentPermissionRequest[];
  persistence: AgentPersistenceHandle | null;
  runtimeInfo?: AgentRuntimeInfo;
  lastUsage?: AgentUsage;
  lastError?: string | null;
  title: string | null;
  cwd: string;
  workspaceId?: string;
  model: string | null;
  features?: AgentFeature[];
  thinkingOptionId?: string | null;
  requiresAttention?: boolean;
  attentionReason?: "finished" | "error" | "permission" | null;
  attentionTimestamp?: Date | null;
  archivedAt?: Date | null;
  parentAgentId: string | null;
  labels: Record<string, string>;
  projectPlacement?: ProjectPlacementPayload | null;
}

export interface WorkspaceDescriptor {
  id: string;
  projectId: string;
  projectDisplayName: string;
  projectCustomName?: string | null;
  projectCustomIconRevision?: string | null;
  projectRootPath: string;
  workspaceDirectory: string;
  worktreeSlug?: WorkspaceDescriptorPayload["worktreeSlug"];
  projectKind: WorkspaceDescriptorPayload["projectKind"];
  workspaceKind: WorkspaceDescriptorPayload["workspaceKind"];
  name: string;
  title?: string | null;
  pinnedAt?: string | null;
  labels?: string[];
  status: WorkspaceDescriptorPayload["status"];
  statusEnteredAt: Date | null;
  archivingAt: string | null;
  diffStat: { additions: number; deletions: number } | null;
  scripts: WorkspaceDescriptorPayload["scripts"];
  gitRuntime?: WorkspaceDescriptorPayload["gitRuntime"];
  githubRuntime?: WorkspaceDescriptorPayload["githubRuntime"];
  forge?: WorkspaceDescriptorPayload["forge"];
  project?: ProjectPlacementPayload;
}

export function normalizeWorkspaceDescriptor(
  payload: WorkspaceDescriptorPayload,
): WorkspaceDescriptor {
  const statusEnteredAtRaw = payload.statusEnteredAt;
  const statusEnteredAt: Date | null =
    typeof statusEnteredAtRaw === "string" && statusEnteredAtRaw.length > 0
      ? new Date(statusEnteredAtRaw)
      : null;
  return {
    id: normalizeWorkspaceOpaqueId(payload.id) ?? payload.id,
    projectId: payload.projectId,
    projectDisplayName: payload.projectDisplayName,
    projectCustomName: payload.projectCustomName ?? null,
    projectCustomIconRevision: payload.projectCustomIconRevision ?? null,
    projectRootPath: payload.projectRootPath,
    // Canonicalize the workspace directory once, at the store boundary, so every
    // consumer can read workspace.workspaceDirectory directly. Empty means "no
    // usable directory" (older daemons may omit it; the wire field is optional).
    workspaceDirectory: normalizeWorkspacePath(payload.workspaceDirectory) ?? "",
    worktreeSlug: payload.worktreeSlug,
    projectKind: payload.projectKind,
    workspaceKind: payload.workspaceKind,
    name: payload.name,
    title: payload.title ?? null,
    pinnedAt: payload.pinnedAt ?? null,
    // COMPAT(workspaceLabels): old daemons omit assignments.
    labels: payload.labels ?? [],
    status: payload.status,
    statusEnteredAt,
    archivingAt: payload.archivingAt ?? null,
    diffStat: payload.diffStat ?? null,
    scripts: (payload.scripts ?? []).map((s) => Object.assign({}, s)),
    gitRuntime: payload.gitRuntime,
    githubRuntime: payload.githubRuntime,
    forge: payload.forge,
    project: payload.project,
  };
}

export interface ProjectDescriptor {
  projectId: string;
  projectKey?: string | null;
  projectDisplayName: string;
  projectCustomName: string | null;
  projectCustomIconRevision?: string | null;
  projectIconRevision?: string;
  projectRootPath: string;
  projectKind: WorkspaceDescriptorPayload["projectKind"];
}

export function normalizeProjectDescriptor(
  payload: WorkspaceProjectDescriptorPayload,
): ProjectDescriptor {
  return {
    projectId: payload.projectId,
    projectKey: payload.projectKey ?? null,
    projectDisplayName: payload.projectDisplayName,
    projectCustomName: payload.projectCustomName ?? null,
    projectCustomIconRevision: payload.projectCustomIconRevision ?? null,
    projectIconRevision: payload.projectIconRevision,
    projectRootPath: payload.projectRootPath,
    projectKind: payload.projectKind,
  };
}

function preserveWorkspaceDescriptorIdentity(
  incoming: WorkspaceDescriptor,
  existing?: WorkspaceDescriptor | null,
): WorkspaceDescriptor {
  if (existing && equal(existing, incoming)) {
    return existing;
  }
  return incoming;
}

function preserveMapIdentity<Key, Value>(
  existing: Map<Key, Value>,
  incoming: Map<Key, Value>,
): Map<Key, Value> {
  if (existing === incoming) {
    return existing;
  }

  const next = new Map<Key, Value>();
  let changed = existing.size !== incoming.size;
  const existingEntries = existing.entries();

  for (const [key, workspace] of incoming) {
    const existingWorkspace = existing.get(key);
    const nextWorkspace =
      existingWorkspace && equal(existingWorkspace, workspace) ? existingWorkspace : workspace;
    next.set(key, nextWorkspace);
    const existingEntry = existingEntries.next().value;
    if (!existingEntry || existingEntry[0] !== key || existingEntry[1] !== nextWorkspace) {
      changed = true;
    }
  }

  return changed ? next : existing;
}

export type ExplorerEntryKind = "file" | "directory";
export type ExplorerFileKind = "text" | "image" | "binary";
export type ExplorerEncoding = "utf-8" | "base64" | "none";

export interface ExplorerEntry {
  name: string;
  path: string;
  kind: ExplorerEntryKind;
  size: number;
  modifiedAt: string;
}

export interface ExplorerFile {
  path: string;
  kind: ExplorerFileKind;
  encoding: ExplorerEncoding;
  content?: string;
  // TextDecoder removes a leading UTF-8 BOM; retain this bit so file writes can restore it.
  hasBom: boolean;
  mimeType?: string;
  size: number;
  modifiedAt: string;
  revision?: string;
}

export interface ExplorerDirectory {
  path: string;
  entries: ExplorerEntry[];
}

interface ExplorerRequestState {
  path: string;
  mode: "list" | "file";
}

export interface AgentFileExplorerState {
  directories: Map<string, ExplorerDirectory>;
  files: Map<string, ExplorerFile>;
  isLoading: boolean;
  lastError: string | null;
  pendingRequest: ExplorerRequestState | null;
  currentPath: string;
  history: string[];
  lastVisitedPath: string;
  selectedEntryPath: string | null;
}

export interface DaemonServerInfo {
  serverId: string;
  hostname: string | null;
  version: string | null;
  desktopManaged?: boolean;
  capabilities?: ServerCapabilities;
  features?: ServerInfoStatusPayload["features"];
}

export interface AgentTimelineCursorState {
  epoch: string;
  startSeq: number;
  endSeq: number;
  retainedRanges?: Array<{
    startSeq: number;
    endSeq: number;
    hasOlder?: boolean;
  }>;
}

function sameTimelineRange(
  current: AgentTimelineCursorState | undefined,
  next: AgentTimelineCursorState | null,
): boolean {
  return (
    current?.epoch === next?.epoch &&
    current?.startSeq === next?.startSeq &&
    current?.endSeq === next?.endSeq &&
    current?.retainedRanges === next?.retainedRanges
  );
}

export type AgentTimelineState =
  | { status: "cold" }
  | { status: "painted"; items: StreamItem[] }
  | {
      status: "synced";
      items: StreamItem[];
      range: AgentTimelineCursorState | null;
      older: "available" | "none";
      newer: "available" | "none";
    };

export function selectAgentTimelineState(
  session: SessionState | undefined,
  agentId: string,
): AgentTimelineState {
  if (!session) return { status: "cold" };
  const items = session.agentStreamTail.get(agentId) ?? [];
  if (session.agentAuthoritativeHistoryApplied.get(agentId) === true) {
    return {
      status: "synced",
      items,
      range: session.agentTimelineCursor.get(agentId) ?? null,
      older: session.agentTimelineHasOlder.get(agentId) === true ? "available" : "none",
      newer: session.agentTimelineHasNewer.get(agentId) === true ? "available" : "none",
    };
  }
  return items.length > 0 ? { status: "painted", items } : { status: "cold" };
}

export function selectAgentTurnPresentation(
  session: SessionState | undefined,
  agentId: string,
): TurnPresentation {
  return resolveTurnPresentation(
    session?.agents.get(agentId)?.turn ??
      session?.agentDetails.get(agentId)?.turn ??
      TURN_LIVENESS_IDLE,
    getActiveMessageSubmissions(session?.messageSubmissions.get(agentId)).length > 0,
  );
}

function latestTasksFromStream(items: readonly StreamItem[]): TodoEntry[] {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === "todo_list") return item.items;
  }
  return [];
}

function updateAgentTasks(
  current: Map<string, TodoEntry[]>,
  agentId: string,
  taskSnapshot: TodoEntry[] | undefined,
): Map<string, TodoEntry[]> {
  if (taskSnapshot === undefined || equal(current.get(agentId) ?? [], taskSnapshot)) return current;
  const next = new Map(current);
  if (taskSnapshot.length > 0) next.set(agentId, taskSnapshot);
  else next.delete(agentId);
  return next;
}

export type WorkspaceRestoreStatus = "restoring" | "failed" | "needs-host-upgrade";

// Per-session state
export interface SessionState {
  serverId: string;

  // Daemon client (immutable reference)
  client: DaemonClient | null;
  clientGeneration: number;
  viewedTimelineSync: ViewedTimelineUiBridge | null;

  // Server metadata (from server_info handshake)
  serverInfo: DaemonServerInfo | null;

  // Hydration status
  hasHydratedAgents: boolean;
  hasHydratedWorkspaces: boolean;
  hasWorkspaceDirectorySnapshot: boolean;

  // Audio state
  isPlayingAudio: boolean;

  // Focus
  focusedAgentId: string | null;
  focusedTerminalId: string | null;

  // Stream state (head/tail model)
  agentStreamTail: Map<string, StreamItem[]>;
  agentStreamHead: Map<string, StreamItem[]>;
  agentTasks: Map<string, TodoEntry[]>;
  messageSubmissions: Map<string, MessageSubmissionRecord[]>;
  agentTimelineCursor: Map<string, AgentTimelineCursorState>;
  agentTimelineHasOlder: Map<string, boolean>;
  agentTimelineHasNewer: Map<string, boolean>;
  agentTimelineOlderFetchInFlight: Map<string, boolean>;
  historySyncGeneration: number;
  agentHistorySyncGeneration: Map<string, number>;
  agentAuthoritativeHistoryApplied: Map<string, boolean>;

  // Initializing agents (used for UI loading state)
  initializingAgents: Map<string, boolean>;

  // Agents
  agents: Map<string, Agent>;
  workspaceAgentActivity: Map<string, WorkspaceAgentActivity>;
  agentDetails: Map<string, Agent>;
  workspaces: Map<string, WorkspaceDescriptor>;
  // All active project descriptors, keyed by host-local projectId.
  projects: Map<string, ProjectDescriptor>;
  // Transient restore state for archived workspaces, keyed by normalized
  // workspaceId. Cleared in mergeWorkspaces when the descriptor lands.
  restoringWorkspaces: Map<string, WorkspaceRestoreStatus>;

  // Permissions
  pendingPermissions: Map<string, PendingPermission>;

  // File explorer
  fileExplorer: Map<string, AgentFileExplorerState>;

  // Queued messages
  queuedMessages: Map<
    string,
    Array<{ id: string; text: string; attachments: ComposerAttachment[] }>
  >;
}

// Global store state
interface SessionStoreState {
  sessions: Record<string, SessionState>;

  // Agent activity timestamps (top-level, keyed by agentId to prevent cascade rerenders)
  agentLastActivity: Map<string, Date>;
}

// Action types
interface SessionStoreActions {
  // Session management
  initializeSession: (
    serverId: string,
    client: DaemonClient | null,
    clientGeneration?: number,
  ) => void;
  clearSession: (serverId: string) => void;
  getSession: (serverId: string) => SessionState | undefined;
  updateSessionClient: (serverId: string, client: DaemonClient, clientGeneration?: number) => void;
  setViewedTimelineSync: (serverId: string, sync: ViewedTimelineUiBridge | null) => void;
  updateSessionServerInfo: (serverId: string, info: DaemonServerInfo) => void;

  // Audio state
  setIsPlayingAudio: (serverId: string, playing: boolean) => void;

  // Focus
  setFocusedAgentId: (serverId: string, agentId: string | null) => void;
  setFocusedTerminalId: (serverId: string, terminalId: string | null) => void;

  // Stream state (head/tail model)

  setAgentTimelineOlderFetchInFlight: (
    serverId: string,
    state: Map<string, boolean> | ((prev: Map<string, boolean>) => Map<string, boolean>),
  ) => void;
  bumpHistorySyncGeneration: (serverId: string) => void;

  applyAgentTimelineResponseState: (
    serverId: string,
    agentId: string,
    state: {
      items: StreamItem[];
      head: StreamItem[];
      range: AgentTimelineCursorState | null;
      older: "available" | "none" | "unchanged";
      newer: boolean;
      synchronized: boolean;
      submissions: MessageSubmissionRecord[];
    },
  ) => void;

  removeAgentTimeline: (serverId: string, agentId: string) => void;

  // Initializing agents
  setInitializingAgents: (
    serverId: string,
    state: Map<string, boolean> | ((prev: Map<string, boolean>) => Map<string, boolean>),
  ) => void;

  // Agents
  setAgents: (
    serverId: string,
    agents: Map<string, Agent> | ((prev: Map<string, Agent>) => Map<string, Agent>),
  ) => void;
  setAgentDetails: (
    serverId: string,
    agents: Map<string, Agent> | ((prev: Map<string, Agent>) => Map<string, Agent>),
  ) => void;
  setWorkspaces: (
    serverId: string,
    workspaces:
      | Map<string, WorkspaceDescriptor>
      | ((prev: Map<string, WorkspaceDescriptor>) => Map<string, WorkspaceDescriptor>),
  ) => void;
  mergeWorkspaces: (serverId: string, workspaces: Iterable<WorkspaceDescriptor>) => void;
  removeWorkspace: (serverId: string, workspaceId: string) => void;
  setProjects: (serverId: string, projects: Iterable<ProjectDescriptor>) => void;
  upsertProject: (serverId: string, project: ProjectDescriptor) => void;
  removeProject: (serverId: string, projectId: string) => void;
  setWorkspaceRestoreStatus: (
    serverId: string,
    workspaceId: string,
    status: WorkspaceRestoreStatus,
  ) => void;
  clearWorkspaceRestoreStatus: (serverId: string, workspaceId: string) => void;

  // Agent activity timestamps
  setAgentLastActivity: (agentId: string, timestamp: Date) => void;
  setAgentLastActivityBatch: (
    updates: Map<string, Date> | ((prev: Map<string, Date>) => Map<string, Date>),
  ) => void;
  flushAgentLastActivity: () => void;

  // Permissions
  setPendingPermissions: (
    serverId: string,
    perms:
      | Map<string, PendingPermission>
      | ((prev: Map<string, PendingPermission>) => Map<string, PendingPermission>),
  ) => void;

  // File explorer
  setFileExplorer: (
    serverId: string,
    state:
      | Map<string, AgentFileExplorerState>
      | ((prev: Map<string, AgentFileExplorerState>) => Map<string, AgentFileExplorerState>),
  ) => void;

  // Queued messages
  setQueuedMessages: (
    serverId: string,
    value:
      | Map<string, Array<{ id: string; text: string; attachments: ComposerAttachment[] }>>
      | ((
          prev: Map<string, Array<{ id: string; text: string; attachments: ComposerAttachment[] }>>,
        ) => Map<string, Array<{ id: string; text: string; attachments: ComposerAttachment[] }>>),
  ) => void;

  // Hydration
  setHasHydratedAgents: (serverId: string, hydrated: boolean) => void;
  setHasHydratedWorkspaces: (serverId: string, hydrated: boolean) => void;
  setHasWorkspaceDirectorySnapshot: (serverId: string, available: boolean) => void;

  // Agent directory (derived from agents)
  getAgentDirectory: (serverId: string) => AgentDirectoryEntry[] | undefined;
}

type SessionStore = SessionStoreState & SessionStoreActions;

const agentLastActivityCoalescer = createAgentLastActivityCoalescer();

// Helper to create initial session state
function createInitialSessionState(
  serverId: string,
  client: DaemonClient | null,
  clientGeneration = 0,
): SessionState {
  return {
    serverId,
    client,
    clientGeneration,
    viewedTimelineSync: null,
    serverInfo: null,
    hasHydratedAgents: false,
    hasHydratedWorkspaces: false,
    hasWorkspaceDirectorySnapshot: false,
    isPlayingAudio: false,
    focusedAgentId: null,
    focusedTerminalId: null,
    agentStreamTail: new Map(),
    agentStreamHead: new Map(),
    agentTasks: new Map(),
    messageSubmissions: new Map(),
    agentTimelineCursor: new Map(),
    agentTimelineHasOlder: new Map(),
    agentTimelineHasNewer: new Map(),
    agentTimelineOlderFetchInFlight: new Map(),
    historySyncGeneration: 0,
    agentHistorySyncGeneration: new Map(),
    agentAuthoritativeHistoryApplied: new Map(),
    initializingAgents: new Map(),
    agents: new Map(),
    workspaceAgentActivity: new Map(),
    agentDetails: new Map(),
    workspaces: new Map(),
    projects: new Map(),
    restoringWorkspaces: new Map(),
    pendingPermissions: new Map(),
    fileExplorer: new Map(),
    queuedMessages: new Map(),
  };
}

function areServerCapabilitiesEqual(
  current: ServerCapabilities | undefined,
  next: ServerCapabilities | undefined,
): boolean {
  return JSON.stringify(current ?? null) === JSON.stringify(next ?? null);
}

function areServerInfoFeaturesEqual(
  current: ServerInfoStatusPayload["features"] | undefined,
  next: ServerInfoStatusPayload["features"] | undefined,
): boolean {
  return JSON.stringify(current ?? null) === JSON.stringify(next ?? null);
}

function isSessionServerInfoUnchanged(input: {
  currentServerInfo: SessionState["serverInfo"] | undefined;
  nextHostname: string | null;
  nextVersion: string | null;
  nextDesktopManaged: boolean | undefined;
  nextCapabilities: ServerCapabilities | undefined;
  nextFeatures: ServerInfoStatusPayload["features"] | undefined;
  nextServerId: string;
}): boolean {
  const {
    currentServerInfo,
    nextHostname,
    nextVersion,
    nextDesktopManaged,
    nextCapabilities,
    nextFeatures,
  } = input;
  const prevHostname = currentServerInfo?.hostname?.trim() || null;
  const prevVersion = currentServerInfo?.version?.trim() || null;
  return (
    currentServerInfo?.serverId === input.nextServerId &&
    prevHostname === nextHostname &&
    prevVersion === nextVersion &&
    currentServerInfo?.desktopManaged === nextDesktopManaged &&
    areServerCapabilitiesEqual(currentServerInfo?.capabilities, nextCapabilities) &&
    areServerInfoFeaturesEqual(currentServerInfo?.features, nextFeatures)
  );
}

export const useSessionStore = create<SessionStore>()(
  subscribeWithSelector((set, get) => {
    const commitActivityUpdates: AgentLastActivityCommitter = (updates) => {
      set((prev) => {
        let nextActivity: Map<string, Date> | null = null;
        for (const [agentId, timestamp] of updates.entries()) {
          const current = prev.agentLastActivity.get(agentId);
          if (current && current.getTime() >= timestamp.getTime()) {
            continue;
          }
          if (!nextActivity) {
            nextActivity = new Map(prev.agentLastActivity);
          }
          nextActivity.set(agentId, timestamp);
        }
        if (!nextActivity) {
          return prev;
        }
        return {
          ...prev,
          agentLastActivity: nextActivity,
        };
      });
    };
    agentLastActivityCoalescer.setCommitter(commitActivityUpdates);

    return {
      sessions: {},
      agentLastActivity: new Map(),

      // Session management
      initializeSession: (serverId, client, clientGeneration) => {
        set((prev) => {
          if (prev.sessions[serverId]) {
            return prev;
          }
          return {
            ...prev,
            sessions: {
              ...prev.sessions,
              [serverId]: createInitialSessionState(serverId, client, clientGeneration),
            },
          };
        });
      },

      clearSession: (serverId) => {
        agentLastActivityCoalescer.flushNow();
        set((prev) => {
          const session = prev.sessions[serverId];
          if (!session) {
            return prev;
          }
          const nextSessions = { ...prev.sessions };
          delete nextSessions[serverId];
          let nextActivity = prev.agentLastActivity;
          if (session.agents.size > 0 || session.agentDetails.size > 0) {
            const candidate = new Map(prev.agentLastActivity);
            let changed = false;
            for (const agentId of new Set([
              ...session.agents.keys(),
              ...session.agentDetails.keys(),
            ])) {
              if (candidate.delete(agentId)) {
                changed = true;
              }
              agentLastActivityCoalescer.deletePending(agentId);
            }
            if (changed) {
              nextActivity = candidate;
            }
          }
          return {
            ...prev,
            sessions: nextSessions,
            agentLastActivity: nextActivity,
          };
        });
      },

      updateSessionClient: (serverId, client, clientGeneration = 0) => {
        set((prev) => {
          const session = prev.sessions[serverId];

          if (!session) {
            return prev;
          }

          if (session.client === client && session.clientGeneration === clientGeneration) {
            return prev;
          }

          return {
            ...prev,
            sessions: {
              ...prev.sessions,
              [serverId]: {
                ...session,
                client,
                clientGeneration,
              },
            },
          };
        });
      },

      setViewedTimelineSync: (serverId, viewedTimelineSync) => {
        set((prev) => {
          const session = prev.sessions[serverId];
          if (!session || session.viewedTimelineSync === viewedTimelineSync) {
            return prev;
          }
          return {
            ...prev,
            sessions: {
              ...prev.sessions,
              [serverId]: { ...session, viewedTimelineSync },
            },
          };
        });
      },

      updateSessionServerInfo: (serverId, info) => {
        set((prev) => {
          const session = prev.sessions[serverId];
          if (!session) {
            return prev;
          }

          const nextHostname = info.hostname?.trim() || null;
          const nextVersion = info.version?.trim() || null;
          const nextDesktopManaged = info.desktopManaged;
          const nextCapabilities = info.capabilities;
          const nextFeatures = info.features;

          if (
            isSessionServerInfoUnchanged({
              currentServerInfo: session.serverInfo,
              nextHostname,
              nextVersion,
              nextDesktopManaged,
              nextCapabilities,
              nextFeatures,
              nextServerId: info.serverId,
            })
          ) {
            return prev;
          }

          return {
            ...prev,
            sessions: {
              ...prev.sessions,
              [serverId]: {
                ...session,
                serverInfo: {
                  serverId: info.serverId,
                  hostname: nextHostname,
                  version: nextVersion,
                  ...(nextDesktopManaged !== undefined
                    ? { desktopManaged: nextDesktopManaged }
                    : {}),
                  ...(nextCapabilities ? { capabilities: nextCapabilities } : {}),
                  ...(nextFeatures ? { features: nextFeatures } : {}),
                },
              },
            },
          };
        });
      },

      getSession: (serverId) => {
        return get().sessions[serverId];
      },

      // Audio state
      setIsPlayingAudio: (serverId, playing) => {
        set((prev) => {
          const session = prev.sessions[serverId];
          if (!session || session.isPlayingAudio === playing) {
            return prev;
          }
          return {
            ...prev,
            sessions: {
              ...prev.sessions,
              [serverId]: { ...session, isPlayingAudio: playing },
            },
          };
        });
      },

      // Focus
      setFocusedAgentId: (serverId, agentId) => {
        set((prev) => {
          const session = prev.sessions[serverId];
          if (!session || session.focusedAgentId === agentId) {
            return prev;
          }
          return {
            ...prev,
            sessions: {
              ...prev.sessions,
              [serverId]: {
                ...session,
                focusedAgentId: agentId,
              },
            },
          };
        });
      },

      setFocusedTerminalId: (serverId, terminalId) => {
        set((prev) => {
          const session = prev.sessions[serverId];
          if (!session || session.focusedTerminalId === terminalId) {
            return prev;
          }
          return {
            ...prev,
            sessions: {
              ...prev.sessions,
              [serverId]: {
                ...session,
                focusedTerminalId: terminalId,
              },
            },
          };
        });
      },

      // Stream state (head/tail model)

      setAgentTimelineOlderFetchInFlight: (serverId, state) => {
        set((prev) => {
          const session = prev.sessions[serverId];
          if (!session) {
            return prev;
          }
          const nextState =
            typeof state === "function" ? state(session.agentTimelineOlderFetchInFlight) : state;
          if (session.agentTimelineOlderFetchInFlight === nextState) {
            return prev;
          }
          return {
            ...prev,
            sessions: {
              ...prev.sessions,
              [serverId]: { ...session, agentTimelineOlderFetchInFlight: nextState },
            },
          };
        });
      },

      bumpHistorySyncGeneration: (serverId) => {
        set((prev) => {
          const session = prev.sessions[serverId];
          if (!session) {
            return prev;
          }
          const nextGeneration = session.historySyncGeneration + 1;
          return {
            ...prev,
            sessions: {
              ...prev.sessions,
              [serverId]: {
                ...session,
                historySyncGeneration: nextGeneration,
              },
            },
          };
        });
      },

      applyAgentTimelineResponseState: (serverId, agentId, state) => {
        set((prev) => {
          const session = prev.sessions[serverId];
          if (!session) return prev;

          let changed = false;
          const update = <T>(map: Map<string, T>, value: T | undefined): Map<string, T> => {
            if (map.get(agentId) === value) return map;
            changed = true;
            const next = new Map(map);
            if (value === undefined) next.delete(agentId);
            else next.set(agentId, value);
            return next;
          };
          const currentTail = session.agentStreamTail.get(agentId);
          const items =
            currentTail?.length === 0 && state.items.length === 0 ? currentTail : state.items;
          const nextTail = update(session.agentStreamTail, items);
          const nextHead = update(
            session.agentStreamHead,
            state.head.length > 0 ? state.head : undefined,
          );
          const currentRange = session.agentTimelineCursor.get(agentId);
          const rangeUnchanged = sameTimelineRange(currentRange, state.range);
          const nextCursor = rangeUnchanged
            ? session.agentTimelineCursor
            : update(session.agentTimelineCursor, state.range ?? undefined);
          const nextHasOlder =
            state.older === "unchanged"
              ? session.agentTimelineHasOlder
              : update(session.agentTimelineHasOlder, state.older === "available");
          const nextHasNewer = update(session.agentTimelineHasNewer, state.newer);
          const nextAuthoritative = state.synchronized
            ? update(session.agentAuthoritativeHistoryApplied, true)
            : session.agentAuthoritativeHistoryApplied;
          const nextSyncGeneration = state.synchronized
            ? update(session.agentHistorySyncGeneration, session.historySyncGeneration)
            : session.agentHistorySyncGeneration;
          const messageSubmissions = update(
            session.messageSubmissions,
            state.submissions.length > 0 ? state.submissions : undefined,
          );
          const rowsChanged =
            nextTail !== session.agentStreamTail || nextHead !== session.agentStreamHead;
          const agentTasks = rowsChanged
            ? updateAgentTasks(
                session.agentTasks,
                agentId,
                latestTasksFromStream([...state.items, ...state.head]),
              )
            : session.agentTasks;
          if (!changed && agentTasks === session.agentTasks) return prev;

          return {
            ...prev,
            sessions: {
              ...prev.sessions,
              [serverId]: {
                ...session,
                agentStreamTail: nextTail,
                agentStreamHead: nextHead,
                agentTasks,
                agentTimelineCursor: nextCursor,
                agentTimelineHasOlder: nextHasOlder,
                agentTimelineHasNewer: nextHasNewer,
                agentAuthoritativeHistoryApplied: nextAuthoritative,
                agentHistorySyncGeneration: nextSyncGeneration,
                messageSubmissions,
              },
            },
          };
        });
      },

      removeAgentTimeline: (serverId, agentId) => {
        set((previous) => {
          const session = previous.sessions[serverId];
          if (!session) return previous;
          const remove = <T>(map: Map<string, T>): Map<string, T> => {
            const next = new Map(map);
            next.delete(agentId);
            return next;
          };
          return {
            ...previous,
            sessions: {
              ...previous.sessions,
              [serverId]: {
                ...session,
                agentStreamTail: remove(session.agentStreamTail),
                agentStreamHead: remove(session.agentStreamHead),
                agentTimelineCursor: remove(session.agentTimelineCursor),
                agentTimelineHasOlder: remove(session.agentTimelineHasOlder),
                agentTimelineHasNewer: remove(session.agentTimelineHasNewer),
                agentTimelineOlderFetchInFlight: remove(session.agentTimelineOlderFetchInFlight),
                agentAuthoritativeHistoryApplied: remove(session.agentAuthoritativeHistoryApplied),
                agentHistorySyncGeneration: remove(session.agentHistorySyncGeneration),
                messageSubmissions: remove(session.messageSubmissions),
                agentTasks: remove(session.agentTasks),
              },
            },
          };
        });
      },

      // Initializing agents
      setInitializingAgents: (serverId, state) => {
        set((prev) => {
          const session = prev.sessions[serverId];
          if (!session) {
            return prev;
          }
          const nextState = typeof state === "function" ? state(session.initializingAgents) : state;
          if (session.initializingAgents === nextState) {
            return prev;
          }
          return {
            ...prev,
            sessions: {
              ...prev.sessions,
              [serverId]: { ...session, initializingAgents: nextState },
            },
          };
        });
      },

      // Agents
      setAgents: (serverId, agents) => {
        set((prev) => {
          const session = prev.sessions[serverId];
          if (!session) {
            return prev;
          }
          const nextAgents = typeof agents === "function" ? agents(session.agents) : agents;
          if (session.agents === nextAgents) {
            return prev;
          }
          return {
            ...prev,
            sessions: {
              ...prev.sessions,
              [serverId]: {
                ...session,
                agents: nextAgents,
                workspaceAgentActivity: buildWorkspaceAgentActivityIndex(
                  nextAgents,
                  session.workspaceAgentActivity,
                ),
              },
            },
          };
        });
      },

      setAgentDetails: (serverId, agents) => {
        set((prev) => {
          const session = prev.sessions[serverId];
          if (!session) {
            return prev;
          }
          const nextAgents = typeof agents === "function" ? agents(session.agentDetails) : agents;
          if (session.agentDetails === nextAgents) {
            return prev;
          }
          return {
            ...prev,
            sessions: {
              ...prev.sessions,
              [serverId]: { ...session, agentDetails: nextAgents },
            },
          };
        });
      },

      setWorkspaces: (serverId, workspaces) => {
        set((prev) => {
          const session = prev.sessions[serverId];
          if (!session) {
            return prev;
          }
          const nextWorkspaces =
            typeof workspaces === "function" ? workspaces(session.workspaces) : workspaces;
          const preservedWorkspaces = preserveMapIdentity(session.workspaces, nextWorkspaces);
          if (session.workspaces === preservedWorkspaces) {
            return prev;
          }
          return {
            ...prev,
            sessions: {
              ...prev.sessions,
              [serverId]: { ...session, workspaces: preservedWorkspaces },
            },
          };
        });
      },

      setProjects: (serverId, projects) => {
        const next = new Map<string, ProjectDescriptor>();
        for (const project of projects) next.set(project.projectId, project);
        set((prev) => {
          const session = prev.sessions[serverId];
          if (!session) return prev;
          const preservedProjects = preserveMapIdentity(session.projects, next);
          if (session.projects === preservedProjects) return prev;
          return {
            ...prev,
            sessions: {
              ...prev.sessions,
              [serverId]: { ...session, projects: preservedProjects },
            },
          };
        });
      },

      upsertProject: (serverId, project) => {
        set((prev) => {
          const session = prev.sessions[serverId];
          if (!session || equal(session.projects.get(project.projectId), project)) return prev;
          const projects = new Map(session.projects);
          projects.set(project.projectId, project);
          return {
            ...prev,
            sessions: { ...prev.sessions, [serverId]: { ...session, projects } },
          };
        });
      },

      removeProject: (serverId, projectId) => {
        set((prev) => {
          const session = prev.sessions[serverId];
          if (!session?.projects.has(projectId)) return prev;
          const projects = new Map(session.projects);
          projects.delete(projectId);
          return {
            ...prev,
            sessions: { ...prev.sessions, [serverId]: { ...session, projects } },
          };
        });
      },

      setWorkspaceRestoreStatus: (serverId, workspaceId, status) => {
        set((prev) => {
          const session = prev.sessions[serverId];
          if (!session) {
            return prev;
          }
          if (session.restoringWorkspaces.get(workspaceId) === status) {
            return prev;
          }
          // A late dir-gone timeout must not override a successful restore:
          // only mark failed while still restoring and the descriptor is absent.
          if (
            status === "failed" &&
            (session.restoringWorkspaces.get(workspaceId) !== "restoring" ||
              session.workspaces.has(workspaceId))
          ) {
            return prev;
          }
          const next = new Map(session.restoringWorkspaces);
          next.set(workspaceId, status);
          return {
            ...prev,
            sessions: {
              ...prev.sessions,
              [serverId]: { ...session, restoringWorkspaces: next },
            },
          };
        });
      },

      clearWorkspaceRestoreStatus: (serverId, workspaceId) => {
        set((prev) => {
          const session = prev.sessions[serverId];
          if (!session || !session.restoringWorkspaces.has(workspaceId)) {
            return prev;
          }
          const next = new Map(session.restoringWorkspaces);
          next.delete(workspaceId);
          return {
            ...prev,
            sessions: {
              ...prev.sessions,
              [serverId]: { ...session, restoringWorkspaces: next },
            },
          };
        });
      },

      mergeWorkspaces: (serverId, workspaces) => {
        const nextEntries = Array.from(workspaces);
        set((prev) => {
          const session = prev.sessions[serverId];
          if (!session || nextEntries.length === 0) {
            return prev;
          }
          const next = new Map(session.workspaces);
          let changed = false;
          // A descriptor arriving is the success signal for a pending restore:
          // clear it at the source so every entry point converges to "ready".
          let nextRestoring: Map<string, WorkspaceRestoreStatus> | null = null;
          for (const workspace of nextEntries) {
            if (session.restoringWorkspaces.has(workspace.id)) {
              nextRestoring ??= new Map(session.restoringWorkspaces);
              nextRestoring.delete(workspace.id);
              changed = true;
            }
            const existing = next.get(workspace.id);
            const nextWorkspace = preserveWorkspaceDescriptorIdentity(workspace, existing);
            if (existing === nextWorkspace) {
              continue;
            }
            next.set(workspace.id, nextWorkspace);
            changed = true;
          }
          if (!changed) {
            return prev;
          }
          return {
            ...prev,
            sessions: {
              ...prev.sessions,
              [serverId]: {
                ...session,
                workspaces: next,
                restoringWorkspaces: nextRestoring ?? session.restoringWorkspaces,
              },
            },
          };
        });
      },

      removeWorkspace: (serverId, workspaceId) => {
        set((prev) => {
          const session = prev.sessions[serverId];
          const workspaceKey = resolveWorkspaceMapKeyByIdentity({
            workspaces: session?.workspaces,
            workspaceId,
          });
          if (!session || !workspaceKey) {
            return prev;
          }
          const next = new Map(session.workspaces);
          next.delete(workspaceKey);
          return {
            ...prev,
            sessions: {
              ...prev.sessions,
              [serverId]: { ...session, workspaces: next },
            },
          };
        });
      },

      // Agent activity timestamps (top-level, does NOT mutate session object)
      setAgentLastActivity: (agentId, timestamp) => {
        agentLastActivityCoalescer.enqueue(agentId, timestamp);
      },

      setAgentLastActivityBatch: (updates) => {
        set((prev) => {
          const nextActivity =
            typeof updates === "function" ? updates(prev.agentLastActivity) : updates;
          if (nextActivity === prev.agentLastActivity) {
            return prev;
          }
          if (nextActivity.size === 0) {
            if (prev.agentLastActivity.size === 0) {
              return prev;
            }
            return {
              ...prev,
              agentLastActivity: new Map(),
            };
          }
          let changed = false;
          for (const [agentId, timestamp] of nextActivity.entries()) {
            const currentTimestamp = prev.agentLastActivity.get(agentId);
            if (!currentTimestamp || currentTimestamp.getTime() !== timestamp.getTime()) {
              changed = true;
              break;
            }
          }
          if (!changed && nextActivity.size === prev.agentLastActivity.size) {
            return prev;
          }
          return {
            ...prev,
            agentLastActivity: new Map(nextActivity),
          };
        });
      },

      flushAgentLastActivity: () => {
        agentLastActivityCoalescer.flushNow();
      },

      // Permissions
      setPendingPermissions: (serverId, perms) => {
        set((prev) => {
          const session = prev.sessions[serverId];
          if (!session) {
            return prev;
          }
          const nextPerms = typeof perms === "function" ? perms(session.pendingPermissions) : perms;
          if (session.pendingPermissions === nextPerms) {
            return prev;
          }
          return {
            ...prev,
            sessions: {
              ...prev.sessions,
              [serverId]: { ...session, pendingPermissions: nextPerms },
            },
          };
        });
      },

      // File explorer
      setFileExplorer: (serverId, state) => {
        set((prev) => {
          const session = prev.sessions[serverId];
          if (!session) {
            return prev;
          }
          const nextState = typeof state === "function" ? state(session.fileExplorer) : state;
          if (session.fileExplorer === nextState) {
            return prev;
          }
          return {
            ...prev,
            sessions: {
              ...prev.sessions,
              [serverId]: { ...session, fileExplorer: nextState },
            },
          };
        });
      },

      // Queued messages
      setQueuedMessages: (serverId, value) => {
        set((prev) => {
          const session = prev.sessions[serverId];
          if (!session) {
            return prev;
          }
          const nextValue = typeof value === "function" ? value(session.queuedMessages) : value;
          if (session.queuedMessages === nextValue) {
            return prev;
          }
          return {
            ...prev,
            sessions: {
              ...prev.sessions,
              [serverId]: { ...session, queuedMessages: nextValue },
            },
          };
        });
      },

      // Hydration
      setHasHydratedAgents: (serverId, hydrated) => {
        set((prev) => {
          const session = prev.sessions[serverId];
          if (!session || session.hasHydratedAgents === hydrated) {
            return prev;
          }
          return {
            ...prev,
            sessions: {
              ...prev.sessions,
              [serverId]: { ...session, hasHydratedAgents: hydrated },
            },
          };
        });
      },

      setHasHydratedWorkspaces: (serverId, hydrated) => {
        set((prev) => {
          const session = prev.sessions[serverId];
          if (!session || session.hasHydratedWorkspaces === hydrated) {
            return prev;
          }
          return {
            ...prev,
            sessions: {
              ...prev.sessions,
              [serverId]: { ...session, hasHydratedWorkspaces: hydrated },
            },
          };
        });
      },

      setHasWorkspaceDirectorySnapshot: (serverId, available) => {
        set((prev) => {
          const session = prev.sessions[serverId];
          if (!session || session.hasWorkspaceDirectorySnapshot === available) return prev;
          return {
            ...prev,
            sessions: {
              ...prev.sessions,
              [serverId]: { ...session, hasWorkspaceDirectorySnapshot: available },
            },
          };
        });
      },

      // Agent directory - derived from agents (computed on-demand)
      getAgentDirectory: (serverId) => {
        const state = get();
        const session = state.sessions[serverId];
        if (!session) {
          return undefined;
        }

        const entries: AgentDirectoryEntry[] = [];
        for (const agent of session.agents.values()) {
          // Get lastActivityAt from top-level slice, fallback to agent.lastActivityAt
          const lastActivityAt = state.agentLastActivity.get(agent.id) ?? agent.lastActivityAt;
          entries.push({
            id: agent.id,
            serverId,
            title: agent.title ?? null,
            status: agent.status,
            turn: agent.turn,
            lastActivityAt,
            cwd: agent.cwd,
            provider: agent.provider,
            pendingPermissionCount: agent.pendingPermissions.length,
            requiresAttention: agent.requiresAttention ?? false,
            attentionReason: agent.attentionReason ?? null,
            attentionTimestamp: agent.attentionTimestamp ?? null,
            createdAt: agent.createdAt,
            labels: agent.labels,
          });
        }
        return entries;
      },
    };
  }),
);

export function useWorkspaceRestoreStatus(
  serverId: string | null,
  workspaceId: string | null,
): WorkspaceRestoreStatus | null {
  return useSessionStore((state) =>
    serverId && workspaceId
      ? (state.sessions[serverId]?.restoringWorkspaces.get(workspaceId) ?? null)
      : null,
  );
}
