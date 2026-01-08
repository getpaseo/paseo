import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type { UseWebSocketReturn } from "@/hooks/use-websocket";
import type { useAudioPlayer } from "@/hooks/use-audio-player";
import type { AgentDirectoryEntry } from "@/types/agent-directory";
import type { StreamItem } from "@/types/stream";
import type { PendingPermission } from "@/types/shared";
import type {
  AgentLifecycleStatus,
} from "@server/server/agent/agent-manager";
import type {
  AgentPermissionResponse,
  AgentSessionConfig,
  AgentProvider,
  AgentMode,
  AgentCapabilityFlags,
  AgentModelDefinition,
  AgentUsage,
  AgentPersistenceHandle,
} from "@server/server/agent/agent-sdk-types";
import type { FileDownloadTokenResponse, GitSetupOptions } from "@server/server/messages";
import { isPerfLoggingEnabled, measurePayload, perfLog } from "@/utils/perf";

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
      args: any;
      result?: any;
      error?: any;
      status: "executing" | "completed" | "failed";
    };

export type DraftInput = {
  text: string;
  images: Array<{ uri: string; mimeType: string }>;
};

export type ProviderModelState = {
  models: AgentModelDefinition[] | null;
  fetchedAt: Date | null;
  error: string | null;
  isLoading: boolean;
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
  pendingPermissions: any[];
  persistence: AgentPersistenceHandle | null;
  runtimeInfo?: AgentRuntimeInfo;
  lastUsage?: AgentUsage;
  lastError?: string | null;
  title: string | null;
  cwd: string;
  model: string | null;
  requiresAttention?: boolean;
  attentionReason?: "finished" | "error" | "permission" | null;
  attentionTimestamp?: Date | null;
  parentAgentId?: string | null;
}

export interface Command {
  id: string;
  name: string;
  workingDirectory: string;
  currentCommand: string;
  isDead: boolean;
  exitCode: number | null;
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
}

// Per-session state
export interface SessionState {
  serverId: string;

  // WebSocket (immutable reference)
  ws: UseWebSocketReturn | null;

  // Audio player (immutable reference)
  audioPlayer: ReturnType<typeof useAudioPlayer> | null;

  // Imperative methods from SessionProvider
  methods: {
    setVoiceDetectionFlags: (isDetecting: boolean, isSpeaking: boolean) => void;
    requestGitDiff: (agentId: string) => void;
    requestDirectoryListing: (agentId: string, path: string, options?: { recordHistory?: boolean }) => void;
    requestFilePreview: (agentId: string, path: string) => void;
    requestFileDownloadToken: (agentId: string, path: string) => Promise<FileDownloadTokenResponse["payload"]>;
    navigateExplorerBack: (agentId: string) => string | null;
    requestProviderModels: (provider: any, options?: { cwd?: string }) => void;
    restartServer: (reason?: string) => void;
    initializeAgent: (params: { agentId: string; requestId?: string }) => void;
    refreshAgent: (params: { agentId: string; requestId?: string }) => void;
    refreshSession: () => void;
    cancelAgentRun: (agentId: string) => void;
    sendAgentMessage: (
      agentId: string,
      message: string,
      images?: Array<{ uri: string; mimeType?: string }>
    ) => Promise<void>;
    sendAgentAudio: (
      agentId: string | undefined,
      audioBlob: Blob,
      requestId?: string,
      options?: { mode?: "transcribe_only" | "auto_run" }
    ) => Promise<void>;
    deleteAgent: (agentId: string) => void;
    createAgent: (options: {
      config: any;
      initialPrompt: string;
      images?: Array<{ uri: string; mimeType?: string }>;
      git?: any;
      worktreeName?: string;
      requestId?: string;
    }) => Promise<void>;
    setAgentMode: (agentId: string, modeId: string) => void;
    respondToPermission: (agentId: string, requestId: string, response: any) => void;
  } | null;

  // Hydration status
  hasHydratedAgents: boolean;

  // Audio state
  isPlayingAudio: boolean;

  // Focus
  focusedAgentId: string | null;

  // Messages
  messages: MessageEntry[];
  currentAssistantMessage: string;

  // Stream state
  agentStreamState: Map<string, StreamItem[]>;
  agentStreamingBuffer: Map<string, { id: string; text: string; timestamp: Date }>;

  // Initializing agents
  initializingAgents: Map<string, boolean>;

  // Agents and commands
  agents: Map<string, Agent>;
  commands: Map<string, Command>;

  // Permissions
  pendingPermissions: Map<string, PendingPermission>;

  // Git diffs
  gitDiffs: Map<string, string>;

  // File explorer
  fileExplorer: Map<string, AgentFileExplorerState>;

  // Provider models
  providerModels: Map<AgentProvider, ProviderModelState>;

  // Queued messages
  queuedMessages: Map<string, Array<{ id: string; text: string; images?: Array<{ uri: string; mimeType: string }> }>>;
}

// Global store state
interface SessionStoreState {
  sessions: Record<string, SessionState>;

  // Top-level drafts (keyed by agentId, not serverId:agentId since agent IDs are globally unique)
  drafts: Map<string, DraftInput>;

  // Single draft for the create agent modal
  createModalDraft: DraftInput | null;

  // Agent activity timestamps (top-level, keyed by agentId to prevent cascade rerenders)
  agentLastActivity: Map<string, Date>;
}

// Action types
interface SessionStoreActions {
  // Session management
  initializeSession: (serverId: string, ws: UseWebSocketReturn, audioPlayer: ReturnType<typeof useAudioPlayer>) => void;
  clearSession: (serverId: string) => void;
  getSession: (serverId: string) => SessionState | undefined;
  updateSessionWebSocket: (serverId: string, ws: UseWebSocketReturn) => void;

  // Audio state
  setIsPlayingAudio: (serverId: string, playing: boolean) => void;

  // Focus
  setFocusedAgentId: (serverId: string, agentId: string | null) => void;

  // Messages
  setMessages: (serverId: string, messages: MessageEntry[] | ((prev: MessageEntry[]) => MessageEntry[])) => void;
  setCurrentAssistantMessage: (serverId: string, message: string | ((prev: string) => string)) => void;

  // Stream state
  setAgentStreamState: (serverId: string, state: Map<string, StreamItem[]> | ((prev: Map<string, StreamItem[]>) => Map<string, StreamItem[]>)) => void;
  setAgentStreamingBuffer: (
    serverId: string,
    state:
      | Map<string, { id: string; text: string; timestamp: Date }>
      | ((
          prev: Map<string, { id: string; text: string; timestamp: Date }>
        ) => Map<string, { id: string; text: string; timestamp: Date }>)
  ) => void;
  clearAgentStreamingBuffer: (serverId: string, agentId: string) => void;

  // Initializing agents
  setInitializingAgents: (serverId: string, state: Map<string, boolean> | ((prev: Map<string, boolean>) => Map<string, boolean>)) => void;

  // Agents
  setAgents: (serverId: string, agents: Map<string, Agent> | ((prev: Map<string, Agent>) => Map<string, Agent>)) => void;

  // Agent activity timestamps
  setAgentLastActivity: (agentId: string, timestamp: Date) => void;

  // Commands
  setCommands: (serverId: string, commands: Map<string, Command> | ((prev: Map<string, Command>) => Map<string, Command>)) => void;

  // Permissions
  setPendingPermissions: (serverId: string, perms: Map<string, PendingPermission> | ((prev: Map<string, PendingPermission>) => Map<string, PendingPermission>)) => void;

  // Git diffs
  setGitDiffs: (serverId: string, diffs: Map<string, string> | ((prev: Map<string, string>) => Map<string, string>)) => void;

  // File explorer
  setFileExplorer: (serverId: string, state: Map<string, AgentFileExplorerState> | ((prev: Map<string, AgentFileExplorerState>) => Map<string, AgentFileExplorerState>)) => void;

  // Provider models
  setProviderModels: (serverId: string, models: Map<AgentProvider, ProviderModelState> | ((prev: Map<AgentProvider, ProviderModelState>) => Map<AgentProvider, ProviderModelState>)) => void;

  // Draft inputs (top-level, not in sessions)
  getDraftInput: (agentId: string) => DraftInput | undefined;
  saveDraftInput: (agentId: string, draft: DraftInput) => void;

  // Create modal draft
  getCreateModalDraft: () => DraftInput | null;
  saveCreateModalDraft: (draft: DraftInput | null) => void;

  // Queued messages
  setQueuedMessages: (serverId: string, value: Map<string, Array<{ id: string; text: string; images?: Array<{ uri: string; mimeType: string }> }>> | ((prev: Map<string, Array<{ id: string; text: string; images?: Array<{ uri: string; mimeType: string }> }>>) => Map<string, Array<{ id: string; text: string; images?: Array<{ uri: string; mimeType: string }> }>>)) => void;

  // Hydration
  setHasHydratedAgents: (serverId: string, hydrated: boolean) => void;

  // Imperative methods
  setSessionMethods: (serverId: string, methods: SessionState["methods"]) => void;

  // Agent directory (derived from agents)
  getAgentDirectory: (serverId: string) => AgentDirectoryEntry[] | undefined;
}

type SessionStore = SessionStoreState & SessionStoreActions;

const SESSION_STORE_LOG_TAG = "[SessionStore]";
let sessionStoreUpdateCount = 0;

function logSessionStoreUpdate(
  type: string,
  serverId: string,
  payload?: unknown
) {
  if (!isPerfLoggingEnabled()) {
    return;
  }
  sessionStoreUpdateCount += 1;
  const metrics = payload ? measurePayload(payload) : null;
  perfLog(SESSION_STORE_LOG_TAG, {
    event: type,
    serverId,
    updateCount: sessionStoreUpdateCount,
    payloadApproxBytes: metrics?.approxBytes ?? 0,
    payloadFieldCount: metrics?.fieldCount ?? 0,
    timestamp: Date.now(),
  });
}


// Helper to create initial session state
function createInitialSessionState(serverId: string, ws: UseWebSocketReturn, audioPlayer: ReturnType<typeof useAudioPlayer>): SessionState {
  return {
    serverId,
    ws,
    audioPlayer,
    methods: null,
    hasHydratedAgents: false,
    isPlayingAudio: false,
    focusedAgentId: null,
    messages: [],
    currentAssistantMessage: "",
    agentStreamState: new Map(),
    agentStreamingBuffer: new Map(),
    initializingAgents: new Map(),
    agents: new Map(),
    commands: new Map(),
    pendingPermissions: new Map(),
    gitDiffs: new Map(),
    fileExplorer: new Map(),
    providerModels: new Map(),
    queuedMessages: new Map(),
  };
}

export const useSessionStore = create<SessionStore>()(
  subscribeWithSelector((set, get) => ({
    sessions: {},
    drafts: new Map(),
    createModalDraft: null,
    agentLastActivity: new Map(),

    // Session management
    initializeSession: (serverId, ws, audioPlayer) => {
      set((prev) => {
        if (prev.sessions[serverId]) {
          return prev;
        }
        logSessionStoreUpdate("initializeSession", serverId);
        return {
          ...prev,
          sessions: {
            ...prev.sessions,
            [serverId]: createInitialSessionState(serverId, ws, audioPlayer),
          },
        };
      });
    },

    clearSession: (serverId) => {
      set((prev) => {
        if (!(serverId in prev.sessions)) {
          return prev;
        }
        logSessionStoreUpdate("clearSession", serverId);
        const nextSessions = { ...prev.sessions };
        delete nextSessions[serverId];
        return { ...prev, sessions: nextSessions };
      });
    },

    updateSessionWebSocket: (serverId, ws) => {
      set((prev) => {
        const session = prev.sessions[serverId];

        if (!session) {
          return prev;
        }

        if (session.ws === ws) {
          return prev;
        }

        logSessionStoreUpdate("updateSessionWebSocket", serverId, {
          wasNull: session.ws === null,
          isNowConnected: ws.isConnected,
          isNowConnecting: ws.isConnecting,
        });

        return {
          ...prev,
          sessions: {
            ...prev.sessions,
            [serverId]: {
              ...session,
              ws,
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
        logSessionStoreUpdate("setIsPlayingAudio", serverId, { playing });
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
        logSessionStoreUpdate("setFocusedAgentId", serverId, { agentId });
        return {
          ...prev,
          sessions: {
            ...prev.sessions,
            [serverId]: { ...session, focusedAgentId: agentId },
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
        const nextMessages = typeof messages === "function" ? messages(session.messages) : messages;
        if (session.messages === nextMessages) {
          return prev;
        }
        logSessionStoreUpdate("setMessages", serverId, { count: nextMessages.length });
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
        const nextMessage = typeof message === "function" ? message(session.currentAssistantMessage) : message;
        if (session.currentAssistantMessage === nextMessage) {
          return prev;
        }
        logSessionStoreUpdate("setCurrentAssistantMessage", serverId, { length: nextMessage.length });
        return {
          ...prev,
          sessions: {
            ...prev.sessions,
            [serverId]: { ...session, currentAssistantMessage: nextMessage },
          },
        };
      });
    },

    // Stream state
    setAgentStreamState: (serverId, state) => {
      set((prev) => {
        const session = prev.sessions[serverId];
        if (!session) {
          return prev;
        }
        const nextState = typeof state === "function" ? state(session.agentStreamState) : state;
        if (session.agentStreamState === nextState) {
          return prev;
        }
        logSessionStoreUpdate("setAgentStreamState", serverId, { agentCount: nextState.size });
        return {
          ...prev,
          sessions: {
            ...prev.sessions,
            [serverId]: { ...session, agentStreamState: nextState },
          },
        };
      });
    },

    setAgentStreamingBuffer: (serverId, state) => {
      set((prev) => {
        const session = prev.sessions[serverId];
        if (!session) {
          return prev;
        }
        const nextState = typeof state === "function" ? state(session.agentStreamingBuffer) : state;
        if (session.agentStreamingBuffer === nextState) {
          return prev;
        }
        logSessionStoreUpdate("setAgentStreamingBuffer", serverId, { agentCount: nextState.size });
        return {
          ...prev,
          sessions: {
            ...prev.sessions,
            [serverId]: { ...session, agentStreamingBuffer: nextState },
          },
        };
      });
    },

    clearAgentStreamingBuffer: (serverId, agentId) => {
      set((prev) => {
        const session = prev.sessions[serverId];
        if (!session) {
          return prev;
        }
        if (!session.agentStreamingBuffer.has(agentId)) {
          return prev;
        }
        const nextBuffer = new Map(session.agentStreamingBuffer);
        nextBuffer.delete(agentId);
        logSessionStoreUpdate("clearAgentStreamingBuffer", serverId, { agentId });
        return {
          ...prev,
          sessions: {
            ...prev.sessions,
            [serverId]: { ...session, agentStreamingBuffer: nextBuffer },
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
        logSessionStoreUpdate("setInitializingAgents", serverId, { count: nextState.size });
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
        logSessionStoreUpdate("setAgents", serverId, { count: nextAgents.size });
        return {
          ...prev,
          sessions: {
            ...prev.sessions,
            [serverId]: { ...session, agents: nextAgents },
          },
        };
      });
    },

    // Agent activity timestamps (top-level, does NOT mutate session object)
    setAgentLastActivity: (agentId, timestamp) => {
      set((prev) => {
        const currentTimestamp = prev.agentLastActivity.get(agentId);
        if (currentTimestamp && currentTimestamp.getTime() === timestamp.getTime()) {
          return prev;
        }
        const nextActivity = new Map(prev.agentLastActivity);
        nextActivity.set(agentId, timestamp);
        return {
          ...prev,
          agentLastActivity: nextActivity,
        };
      });
    },

    // Commands
    setCommands: (serverId, commands) => {
      set((prev) => {
        const session = prev.sessions[serverId];
        if (!session) {
          return prev;
        }
        const nextCommands = typeof commands === "function" ? commands(session.commands) : commands;
        if (session.commands === nextCommands) {
          return prev;
        }
        logSessionStoreUpdate("setCommands", serverId, { count: nextCommands.size });
        return {
          ...prev,
          sessions: {
            ...prev.sessions,
            [serverId]: { ...session, commands: nextCommands },
          },
        };
      });
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
        logSessionStoreUpdate("setPendingPermissions", serverId, { count: nextPerms.size });
        return {
          ...prev,
          sessions: {
            ...prev.sessions,
            [serverId]: { ...session, pendingPermissions: nextPerms },
          },
        };
      });
    },

    // Git diffs
    setGitDiffs: (serverId, diffs) => {
      set((prev) => {
        const session = prev.sessions[serverId];
        if (!session) {
          return prev;
        }
        const nextDiffs = typeof diffs === "function" ? diffs(session.gitDiffs) : diffs;
        if (session.gitDiffs === nextDiffs) {
          return prev;
        }
        logSessionStoreUpdate("setGitDiffs", serverId, { count: nextDiffs.size });
        return {
          ...prev,
          sessions: {
            ...prev.sessions,
            [serverId]: { ...session, gitDiffs: nextDiffs },
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
        logSessionStoreUpdate("setFileExplorer", serverId, { agentCount: nextState.size });
        return {
          ...prev,
          sessions: {
            ...prev.sessions,
            [serverId]: { ...session, fileExplorer: nextState },
          },
        };
      });
    },

    // Provider models
    setProviderModels: (serverId, models) => {
      set((prev) => {
        const session = prev.sessions[serverId];
        if (!session) {
          return prev;
        }
        const nextModels = typeof models === "function" ? models(session.providerModels) : models;
        if (session.providerModels === nextModels) {
          return prev;
        }
        logSessionStoreUpdate("setProviderModels", serverId, { providerCount: nextModels.size });
        return {
          ...prev,
          sessions: {
            ...prev.sessions,
            [serverId]: { ...session, providerModels: nextModels },
          },
        };
      });
    },

    // Draft inputs (top-level, keyed by agentId only)
    getDraftInput: (agentId) => {
      return get().drafts.get(agentId);
    },

    saveDraftInput: (agentId, draft) => {
      set((prev) => {
        const nextDrafts = new Map(prev.drafts);
        nextDrafts.set(agentId, draft);
        return {
          ...prev,
          drafts: nextDrafts,
        };
      });
    },

    // Create modal draft
    getCreateModalDraft: () => {
      return get().createModalDraft;
    },

    saveCreateModalDraft: (draft) => {
      set((prev) => ({
        ...prev,
        createModalDraft: draft,
      }));
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
        logSessionStoreUpdate("setQueuedMessages", serverId, { agentCount: nextValue.size });
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
        logSessionStoreUpdate("setHasHydratedAgents", serverId, { hydrated });
        return {
          ...prev,
          sessions: {
            ...prev.sessions,
            [serverId]: { ...session, hasHydratedAgents: hydrated },
          },
        };
      });
    },

    // Imperative methods
    setSessionMethods: (serverId, methods) => {
      set((prev) => {
        const session = prev.sessions[serverId];
        if (!session) {
          return prev;
        }
        // Skip if methods reference is the same (already set)
        if (session.methods === methods) {
          return prev;
        }
        logSessionStoreUpdate("setSessionMethods", serverId, { hasValue: !!methods });
        return {
          ...prev,
          sessions: {
            ...prev.sessions,
            [serverId]: { ...session, methods },
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
          requiresAttention: agent.requiresAttention ?? false,
          attentionReason: agent.attentionReason ?? null,
          attentionTimestamp: agent.attentionTimestamp ?? null,
          parentAgentId: agent.parentAgentId,
        });
      }
      return entries;
    },
  }))
);
