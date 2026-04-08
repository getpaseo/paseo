import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type { DaemonClient } from "@server/client/daemon-client";
import type { AgentDirectoryEntry } from "@/types/agent-directory";
import type { StreamItem } from "@/types/stream";
import type { PendingPermission } from "@/types/shared";
import type { AttachmentMetadata } from "@/attachments/types";
import type { AgentLifecycleStatus } from "@server/shared/agent-lifecycle";
import type {
  AgentPermissionResponse,
  AgentPermissionRequest,
  AgentSessionConfig,
  AgentFeature,
  AgentProvider,
  AgentMode,
  AgentCapabilityFlags,
  AgentModelDefinition,
  AgentUsage,
  AgentPersistenceHandle,
} from "@server/server/agent/agent-sdk-types";
import type {
  FileDownloadTokenResponse,
  GitSetupOptions,
  ServerInfoStatusPayload,
  ProjectPlacementPayload,
  ServerCapabilities,
  WorkspaceDescriptorPayload,
} from "@server/shared/messages";
import { normalizeWorkspaceIdentity } from "@/utils/workspace-identity";
import {
  createAgentLastActivityCoalescer,
  type AgentLastActivityCommitter,
} from "@/runtime/activity";

// Re-export types that were in session-context
export type MessageEntry =
  | {
      type: "user";
      id: string;
      timestamp: number;
      message: string;
    }
  | {
      type: "assistant";
      id: string;
      timestamp: number;
      message: string;
    }
  | {
      type: "activity";
      id: string;
      timestamp: number;
      activityType: "system" | "info" | "success" | "error";
      message: string;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "artifact";
      id: string;
      timestamp: number;
      artifactId: string;
      artifactType: string;
      title: string;
    }
  | {
      type: "tool_call";
      id: string;
      timestamp: number;
      toolName: string;
      args: unknown | null;
      result?: unknown | null;
      error?: unknown | null;
      status: "executing" | "completed" | "failed";
    };

export interface AgentRuntimeInfo {
  provider: AgentProvider;
  sessionId: string | null;
  model?: string | null;
  modeId?: string | null;
  extra?: Record<string, unknown>;
}

export interface Agent {
  serverId: string;
  id: string;
  provider: AgentProvider;
  status: AgentLifecycleStatus;
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
  model: string | null;
  features?: AgentFeature[];
  thinkingOptionId?: string | null;
  requiresAttention?: boolean;
  attentionReason?: "finished" | "error" | "permission" | null;
  attentionTimestamp?: Date | null;
  archivedAt?: Date | null;
  labels: Record<string, string>;
  projectPlacement?: ProjectPlacementPayload | null;
}

export interface WorkspaceDescriptor {
  id: string;
  projectId: string;
  projectDisplayName: string;
  projectRootPath: string;
  projectKind: WorkspaceDescriptorPayload["projectKind"];
  workspaceKind: WorkspaceDescriptorPayload["workspaceKind"];
  name: string;
  status: WorkspaceDescriptorPayload["status"];
  activityAt: Date | null;
  diffStat: { additions: number; deletions: number } | null;
}

export function normalizeWorkspaceDescriptor(
  payload: WorkspaceDescriptorPayload,
): WorkspaceDescriptor {
  const activityAt = payload.activityAt ? new Date(payload.activityAt) : null;
  return {
    id: normalizeWorkspaceIdentity(payload.id) ?? payload.id,
    projectId: payload.projectId,
    projectDisplayName: payload.projectDisplayName,
    projectRootPath: payload.projectRootPath,
    projectKind: payload.projectKind,
    workspaceKind: payload.workspaceKind,
    name: payload.name,
    status: payload.status,
    activityAt: activityAt && !Number.isNaN(activityAt.getTime()) ? activityAt : null,
    diffStat: payload.diffStat ?? null,
  };
}

export function mergeWorkspaceSnapshotWithExisting(input: {
  incoming: WorkspaceDescriptor;
  existing?: WorkspaceDescriptor | null;
}): WorkspaceDescriptor {
  const { incoming, existing } = input;
  if (!existing || existing.id !== incoming.id) {
    return incoming;
  }

  return {
    ...incoming,
    diffStat: incoming.diffStat ?? existing.diffStat,
  };
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
  mimeType?: string;
  size: number;
  modifiedAt: string;
}

interface ExplorerDirectory {
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

export type DaemonServerInfo = {
  serverId: string;
  hostname: string | null;
  version: string | null;
  capabilities?: ServerCapabilities;
  features?: ServerInfoStatusPayload["features"];
};

export interface AgentTimelineCursorState {
  epoch: string;
  startSeq: number;
  endSeq: number;
}

// Per-session state
export interface SessionState {
  serverId: string;

  // Daemon client (immutable reference)
  client: DaemonClient | null;

  // Server metadata (from server_info handshake)
  serverInfo: DaemonServerInfo | null;

  // Hydration status
  hasHydratedAgents: boolean;
  hasHydratedWorkspaces: boolean;

  // Audio state
  isPlayingAudio: boolean;

  // Focus
  focusedAgentId: string | null;

  // Messages
  messages: MessageEntry[];
  currentAssistantMessage: string;

  // Stream state (head/tail model)
  agentStreamTail: Map<string, StreamItem[]>;
  agentStreamHead: Map<string, StreamItem[]>;
  agentTimelineCursor: Map<string, AgentTimelineCursorState>;
  historySyncGeneration: number;
  agentHistorySyncGeneration: Map<string, number>;
  agentAuthoritativeHistoryApplied: Map<string, boolean>;

  // Initializing agents (used for UI loading state)
  initializingAgents: Map<string, boolean>;

  // Agents
  agents: Map<string, Agent>;
  workspaces: Map<string, WorkspaceDescriptor>;

  // Permissions
  pendingPermissions: Map<string, PendingPermission>;

  // File explorer
  fileExplorer: Map<string, AgentFileExplorerState>;

  // Queued messages
  queuedMessages: Map<string, Array<{ id: string; text: string; images?: AttachmentMetadata[] }>>;
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
  initializeSession: (serverId: string, client: DaemonClient) => void;
  clearSession: (serverId: string) => void;
  getSession: (serverId: string) => SessionState | undefined;
  updateSessionClient: (serverId: string, client: DaemonClient) => void;
  updateSessionServerInfo: (serverId: string, info: DaemonServerInfo) => void;

  // Audio state
  setIsPlayingAudio: (serverId: string, playing: boolean) => void;

  // Focus
  setFocusedAgentId: (serverId: string, agentId: string | null) => void;

  // Messages
  setMessages: (
    serverId: string,
    messages: MessageEntry[] | ((prev: MessageEntry[]) => MessageEntry[]),
  ) => void;
  setCurrentAssistantMessage: (
    serverId: string,
    message: string | ((prev: string) => string),
  ) => void;

  // Stream state (head/tail model)
  setAgentStreamTail: (
    serverId: string,
    state:
      | Map<string, StreamItem[]>
      | ((prev: Map<string, StreamItem[]>) => Map<string, StreamItem[]>),
  ) => void;
  setAgentStreamHead: (
    serverId: string,
    state:
      | Map<string, StreamItem[]>
      | ((prev: Map<string, StreamItem[]>) => Map<string, StreamItem[]>),
  ) => void;
  setAgentStreamState: (
    serverId: string,
    agentId: string,
    state: { tail?: StreamItem[]; head?: StreamItem[] },
  ) => void;
  clearAgentStreamHead: (serverId: string, agentId: string) => void;
  setAgentTimelineCursor: (
    serverId: string,
    state:
      | Map<string, AgentTimelineCursorState>
      | ((prev: Map<string, AgentTimelineCursorState>) => Map<string, AgentTimelineCursorState>),
  ) => void;
  bumpHistorySyncGeneration: (serverId: string) => void;
  markAgentHistorySynchronized: (serverId: string, agentId: string) => void;
  setAgentAuthoritativeHistoryApplied: (
    serverId: string,
    agentId: string,
    applied: boolean,
  ) => void;

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
  setWorkspaces: (
    serverId: string,
    workspaces:
      | Map<string, WorkspaceDescriptor>
      | ((prev: Map<string, WorkspaceDescriptor>) => Map<string, WorkspaceDescriptor>),
  ) => void;
  mergeWorkspaces: (serverId: string, workspaces: Iterable<WorkspaceDescriptor>) => void;
  removeWorkspace: (serverId: string, workspaceId: string) => void;

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
      | Map<string, Array<{ id: string; text: string; images?: AttachmentMetadata[] }>>
      | ((
          prev: Map<string, Array<{ id: string; text: string; images?: AttachmentMetadata[] }>>,
        ) => Map<string, Array<{ id: string; text: string; images?: AttachmentMetadata[] }>>),
  ) => void;

  // Hydration
  setHasHydratedAgents: (serverId: string, hydrated: boolean) => void;
  setHasHydratedWorkspaces: (serverId: string, hydrated: boolean) => void;

  // Agent directory (derived from agents)
  getAgentDirectory: (serverId: string) => AgentDirectoryEntry[] | undefined;
}

type SessionStore = SessionStoreState & SessionStoreActions;

const agentLastActivityCoalescer = createAgentLastActivityCoalescer();

// Helper to create initial session state
function createInitialSessionState(serverId: string, client: DaemonClient): SessionState {
  return {
    serverId,
    client,
    serverInfo: null,
    hasHydratedAgents: false,
    hasHydratedWorkspaces: false,
    isPlayingAudio: false,
    focusedAgentId: null,
    messages: [],
    currentAssistantMessage: "",
    agentStreamTail: new Map(),
    agentStreamHead: new Map(),
    agentTimelineCursor: new Map(),
    historySyncGeneration: 0,
    agentHistorySyncGeneration: new Map(),
    agentAuthoritativeHistoryApplied: new Map(),
    initializingAgents: new Map(),
    agents: new Map(),
    workspaces: new Map(),
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
      initializeSession: (serverId, client) => {
        set((prev) => {
          if (prev.sessions[serverId]) {
            return prev;
          }
          return {
            ...prev,
            sessions: {
              ...prev.sessions,
              [serverId]: createInitialSessionState(serverId, client),
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
          if (session.agents.size > 0) {
            const candidate = new Map(prev.agentLastActivity);
            let changed = false;
            for (const agentId of session.agents.keys()) {
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

      updateSessionClient: (serverId, client) => {
        set((prev) => {
          const session = prev.sessions[serverId];

          if (!session) {
            return prev;
          }

          if (session.client === client) {
            return prev;
          }

          return {
            ...prev,
            sessions: {
              ...prev.sessions,
              [serverId]: {
                ...session,
                client,
              },
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
          const prevHostname = session.serverInfo?.hostname?.trim() || null;
          const nextVersion = info.version?.trim() || null;
          const prevVersion = session.serverInfo?.version?.trim() || null;
          const nextCapabilities = info.capabilities;
          const prevCapabilities = session.serverInfo?.capabilities;
          const nextFeatures = info.features;
          const prevFeatures = session.serverInfo?.features;

          if (
            session.serverInfo?.serverId === info.serverId &&
            prevHostname === nextHostname &&
            prevVersion === nextVersion &&
            areServerCapabilitiesEqual(prevCapabilities, nextCapabilities) &&
            areServerInfoFeaturesEqual(prevFeatures, nextFeatures)
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

      // Messages
      setMessages: (serverId, messages) => {
        set((prev) => {
          const session = prev.sessions[serverId];
          if (!session) {
            return prev;
          }
          const nextMessages =
            typeof messages === "function" ? messages(session.messages) : messages;
          if (session.messages === nextMessages) {
            return prev;
          }
          return {
            ...prev,
            sessions: {
              ...prev.sessions,
              [serverId]: { ...session, messages: nextMessages },
            },
          };
        });
      },

      setCurrentAssistantMessage: (serverId, message) => {
        set((prev) => {
          const session = prev.sessions[serverId];
          if (!session) {
            return prev;
          }
          const nextMessage =
            typeof message === "function" ? message(session.currentAssistantMessage) : message;
          if (session.currentAssistantMessage === nextMessage) {
            return prev;
          }
          return {
            ...prev,
            sessions: {
              ...prev.sessions,
              [serverId]: { ...session, currentAssistantMessage: nextMessage },
            },
          };
        });
      },

      // Stream state (head/tail model)
      setAgentStreamTail: (serverId, state) => {
        set((prev) => {
          const session = prev.sessions[serverId];
          if (!session) {
            return prev;
          }
          const nextState = typeof state === "function" ? state(session.agentStreamTail) : state;
          if (session.agentStreamTail === nextState) {
            return prev;
          }
          return {
            ...prev,
            sessions: {
              ...prev.sessions,
              [serverId]: { ...session, agentStreamTail: nextState },
            },
          };
        });
      },

      setAgentStreamHead: (serverId, state) => {
        set((prev) => {
          const session = prev.sessions[serverId];
          if (!session) {
            return prev;
          }
          const nextState = typeof state === "function" ? state(session.agentStreamHead) : state;
          if (session.agentStreamHead === nextState) {
            return prev;
          }
          return {
            ...prev,
            sessions: {
              ...prev.sessions,
              [serverId]: { ...session, agentStreamHead: nextState },
            },
          };
        });
      },

      setAgentStreamState: (serverId, agentId, state) => {
        set((prev) => {
          const session = prev.sessions[serverId];
          if (!session) {
            return prev;
          }

          let nextTail = session.agentStreamTail;
          let nextHead = session.agentStreamHead;
          let changedTail = false;
          let changedHead = false;

          if (state.tail !== undefined) {
            const existingTail = session.agentStreamTail.get(agentId);
            if (existingTail !== state.tail) {
              nextTail = new Map(session.agentStreamTail);
              nextTail.set(agentId, state.tail);
              changedTail = true;
            }
          }

          if (state.head !== undefined) {
            const existingHead = session.agentStreamHead.get(agentId);
            const shouldDeleteHead = state.head.length === 0;
            if (shouldDeleteHead) {
              if (session.agentStreamHead.has(agentId)) {
                nextHead = new Map(session.agentStreamHead);
                nextHead.delete(agentId);
                changedHead = true;
              }
            } else if (existingHead !== state.head) {
              nextHead = new Map(session.agentStreamHead);
              nextHead.set(agentId, state.head);
              changedHead = true;
            }
          }

          if (!changedTail && !changedHead) {
            return prev;
          }

          return {
            ...prev,
            sessions: {
              ...prev.sessions,
              [serverId]: {
                ...session,
                agentStreamTail: nextTail,
                agentStreamHead: nextHead,
              },
            },
          };
        });
      },

      clearAgentStreamHead: (serverId, agentId) => {
        set((prev) => {
          const session = prev.sessions[serverId];
          if (!session) {
            return prev;
          }
          if (!session.agentStreamHead.has(agentId)) {
            return prev;
          }
          const nextHead = new Map(session.agentStreamHead);
          nextHead.delete(agentId);
          return {
            ...prev,
            sessions: {
              ...prev.sessions,
              [serverId]: { ...session, agentStreamHead: nextHead },
            },
          };
        });
      },

      setAgentTimelineCursor: (serverId, state) => {
        set((prev) => {
          const session = prev.sessions[serverId];
          if (!session) {
            return prev;
          }
          const nextState =
            typeof state === "function" ? state(session.agentTimelineCursor) : state;
          if (session.agentTimelineCursor === nextState) {
            return prev;
          }
          return {
            ...prev,
            sessions: {
              ...prev.sessions,
              [serverId]: { ...session, agentTimelineCursor: nextState },
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

      markAgentHistorySynchronized: (serverId, agentId) => {
        set((prev) => {
          const session = prev.sessions[serverId];
          if (!session) {
            return prev;
          }
          const currentGeneration = session.historySyncGeneration;
          const previousGeneration = session.agentHistorySyncGeneration.get(agentId);
          if (previousGeneration === currentGeneration) {
            return prev;
          }
          const nextMap = new Map(session.agentHistorySyncGeneration);
          nextMap.set(agentId, currentGeneration);
          return {
            ...prev,
            sessions: {
              ...prev.sessions,
              [serverId]: {
                ...session,
                agentHistorySyncGeneration: nextMap,
              },
            },
          };
        });
      },

      setAgentAuthoritativeHistoryApplied: (serverId, agentId, applied) => {
        set((prev) => {
          const session = prev.sessions[serverId];
          if (!session) {
            return prev;
          }

          const previousApplied = session.agentAuthoritativeHistoryApplied.get(agentId) ?? false;
          if (previousApplied === applied) {
            return prev;
          }

          const nextApplied = new Map(session.agentAuthoritativeHistoryApplied);
          if (applied) {
            nextApplied.set(agentId, true);
          } else {
            nextApplied.delete(agentId);
          }

          return {
            ...prev,
            sessions: {
              ...prev.sessions,
              [serverId]: {
                ...session,
                agentAuthoritativeHistoryApplied: nextApplied,
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
              [serverId]: { ...session, agents: nextAgents },
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
          if (session.workspaces === nextWorkspaces) {
            return prev;
          }
          return {
            ...prev,
            sessions: {
              ...prev.sessions,
              [serverId]: { ...session, workspaces: nextWorkspaces },
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
          for (const workspace of nextEntries) {
            const existing = next.get(workspace.id);
            if (existing === workspace) {
              continue;
            }
            next.set(workspace.id, workspace);
            changed = true;
          }
          if (!changed) {
            return prev;
          }
          return {
            ...prev,
            sessions: {
              ...prev.sessions,
              [serverId]: { ...session, workspaces: next },
            },
          };
        });
      },

      removeWorkspace: (serverId, workspaceId) => {
        set((prev) => {
          const session = prev.sessions[serverId];
          if (!session || !session.workspaces.has(workspaceId)) {
            return prev;
          }
          const next = new Map(session.workspaces);
          next.delete(workspaceId);
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
