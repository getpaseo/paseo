import { createContext, useRef, ReactNode, useCallback, useEffect, useMemo } from "react";
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useWebSocket, type UseWebSocketReturn } from "@/hooks/use-websocket";
import { useDaemonRequest } from "@/hooks/use-daemon-request";
import { useSessionRpc } from "@/hooks/use-session-rpc";
import { useAudioPlayer } from "@/hooks/use-audio-player";
import {
  applyStreamEventWithBuffer,
  generateMessageId,
  hydrateStreamState,
} from "@/types/stream";
import type {
  ActivityLogPayload,
  AgentSnapshotPayload,
  AgentStreamEventPayload,
  WSInboundMessage,
  SessionOutboundMessage,
} from "@server/server/messages";
import type {
  AgentLifecycleStatus,
} from "@server/server/agent/agent-manager";
import type {
  AgentPermissionRequest,
} from "@server/server/agent/agent-sdk-types";
import { File } from "expo-file-system";
import { useDaemonConnections } from "./daemon-connections-context";
import { useSessionStore } from "@/stores/session-store";
import type { AgentDirectoryEntry } from "@/types/agent-directory";

// Re-export types from session-store for backward compatibility
export type {
  MessageEntry,
  DraftInput,
  ProviderModelState,
  Agent,
  Command,
  ExplorerEntry,
  ExplorerFile,
  ExplorerEntryKind,
  ExplorerFileKind,
  ExplorerEncoding,
  AgentFileExplorerState,
} from "@/stores/session-store";

const derivePendingPermissionKey = (agentId: string, request: AgentPermissionRequest) => {
  const fallbackId =
    request.id ||
    (typeof request.metadata?.id === "string" ? request.metadata.id : undefined) ||
    request.name ||
    request.title ||
    `${request.kind}:${JSON.stringify(request.input ?? request.metadata ?? {})}`;

  return `${agentId}:${fallbackId}`;
};

type GitDiffResponseMessage = Extract<
  SessionOutboundMessage,
  { type: "git_diff_response" }
>;

type FileExplorerResponseMessage = Extract<
  SessionOutboundMessage,
  { type: "file_explorer_response" }
>;

type FileDownloadTokenResponseMessage = Extract<
  SessionOutboundMessage,
  { type: "file_download_token_response" }
>;

type StatusMessage = Extract<SessionOutboundMessage, { type: "status" }>;

const SESSION_SNAPSHOT_STORAGE_PREFIX = "@paseo:session-snapshot:";

type PersistedSessionSnapshot = {
  agents: AgentSnapshotPayload[];
  commands: Array<{
    id: string;
    name: string;
    workingDirectory: string;
    currentCommand: string;
    isDead: boolean;
    exitCode: number | null;
  }>;
  savedAt: string;
};

const getSessionSnapshotStorageKey = (serverId: string): string => {
  return `${SESSION_SNAPSHOT_STORAGE_PREFIX}${serverId}`;
};

async function loadPersistedSessionSnapshot(serverId: string): Promise<PersistedSessionSnapshot | null> {
  try {
    const raw = await AsyncStorage.getItem(getSessionSnapshotStorageKey(serverId));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as PersistedSessionSnapshot;
    if (!Array.isArray(parsed?.agents) || !Array.isArray(parsed?.commands)) {
      return null;
    }
    return parsed;
  } catch (error) {
    console.error(`[Session] Failed to load persisted snapshot for ${serverId}`, error);
    return null;
  }
}

async function persistSessionSnapshot(serverId: string, snapshot: { agents: AgentSnapshotPayload[]; commands: any[] }) {
  try {
    const payload: PersistedSessionSnapshot = {
      agents: snapshot.agents,
      commands: snapshot.commands,
      savedAt: new Date().toISOString(),
    };
    await AsyncStorage.setItem(getSessionSnapshotStorageKey(serverId), JSON.stringify(payload));
  } catch (error) {
    console.error(`[Session] Failed to persist snapshot for ${serverId}`, error);
  }
}

function normalizeAgentSnapshot(snapshot: AgentSnapshotPayload, serverId: string) {
  const createdAt = new Date(snapshot.createdAt);
  const updatedAt = new Date(snapshot.updatedAt);
  const lastUserMessageAt = snapshot.lastUserMessageAt ? new Date(snapshot.lastUserMessageAt) : null;
  const attentionTimestamp = snapshot.attentionTimestamp ? new Date(snapshot.attentionTimestamp) : null;
  return {
    serverId,
    id: snapshot.id,
    provider: snapshot.provider,
    status: snapshot.status as AgentLifecycleStatus,
    createdAt,
    updatedAt,
    lastUserMessageAt,
    lastActivityAt: updatedAt,
    sessionId: snapshot.sessionId,
    capabilities: snapshot.capabilities,
    currentModeId: snapshot.currentModeId,
    availableModes: snapshot.availableModes ?? [],
    pendingPermissions: snapshot.pendingPermissions ?? [],
    persistence: snapshot.persistence ?? null,
    runtimeInfo: snapshot.runtimeInfo,
    lastUsage: snapshot.lastUsage,
    lastError: snapshot.lastError ?? null,
    title: snapshot.title ?? null,
    cwd: snapshot.cwd,
    model: snapshot.model ?? null,
    requiresAttention: snapshot.requiresAttention ?? false,
    attentionReason: snapshot.attentionReason ?? null,
    attentionTimestamp,
    parentAgentId: snapshot.parentAgentId,
  };
}

const createExplorerState = () => ({
  directories: new Map(),
  files: new Map(),
  isLoading: false,
  lastError: null,
  pendingRequest: null,
  currentPath: ".",
  history: ["."],
  lastVisitedPath: ".",
});

const pushHistory = (history: string[], path: string): string[] => {
  const normalizedHistory = history.length === 0 ? ["."] : history;
  const last = normalizedHistory[normalizedHistory.length - 1];
  if (last === path) {
    return normalizedHistory;
  }
  return [...normalizedHistory, path];
};

// Lightweight context for imperative APIs only (no state)
export interface SessionContextValue {
  serverId: string;
  ws: UseWebSocketReturn;
  audioPlayer: ReturnType<typeof useAudioPlayer>;
  setVoiceDetectionFlags: (isDetecting: boolean, isSpeaking: boolean) => void;
  requestGitDiff: (agentId: string) => void;
  requestDirectoryListing: (agentId: string, path: string, options?: { recordHistory?: boolean }) => void;
  requestFilePreview: (agentId: string, path: string) => void;
  requestFileDownloadToken: (agentId: string, path: string) => Promise<FileDownloadTokenResponseMessage["payload"]>;
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
    agentId: string,
    audioBlob: Blob,
    requestId?: string,
    options?: { mode?: "transcribe_only" | "auto_run" }
  ) => Promise<void>;
  deleteAgent: (agentId: string) => void;
  createAgent: (options: {
    config: any;
    initialPrompt: string;
    git?: any;
    worktreeName?: string;
    requestId?: string;
  }) => void;
  resumeAgent: (options: { handle: any; overrides?: any; requestId?: string }) => void;
  setAgentMode: (agentId: string, modeId: string) => void;
  respondToPermission: (agentId: string, requestId: string, response: any) => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

interface SessionProviderProps {
  children: ReactNode;
  serverUrl: string;
  serverId: string;
}

// SessionProvider: Pure WebSocket message handler that updates Zustand store
export function SessionProvider({ children, serverUrl, serverId }: SessionProviderProps) {
  const ws = useWebSocket(serverUrl);
  const wsIsConnected = ws.isConnected;
  const {
    updateConnectionStatus,
  } = useDaemonConnections();

  // Zustand store actions
  const initializeSession = useSessionStore((state) => state.initializeSession);
  const clearSession = useSessionStore((state) => state.clearSession);
  const setIsPlayingAudio = useSessionStore((state) => state.setIsPlayingAudio);
  const setMessages = useSessionStore((state) => state.setMessages);
  const setCurrentAssistantMessage = useSessionStore((state) => state.setCurrentAssistantMessage);
  const setAgentStreamState = useSessionStore((state) => state.setAgentStreamState);
  const setAgentStreamingBuffer = useSessionStore((state) => state.setAgentStreamingBuffer);
  const clearAgentStreamingBuffer = useSessionStore((state) => state.clearAgentStreamingBuffer);
  const setInitializingAgents = useSessionStore((state) => state.setInitializingAgents);
  const setHasHydratedAgents = useSessionStore((state) => state.setHasHydratedAgents);
  const setAgents = useSessionStore((state) => state.setAgents);
  const setAgentLastActivity = useSessionStore((state) => state.setAgentLastActivity);
  const setCommands = useSessionStore((state) => state.setCommands);
  const setPendingPermissions = useSessionStore((state) => state.setPendingPermissions);
  const setGitDiffs = useSessionStore((state) => state.setGitDiffs);
  const setFileExplorer = useSessionStore((state) => state.setFileExplorer);
  const setProviderModels = useSessionStore((state) => state.setProviderModels);
  const getDraftInput = useSessionStore((state) => state.getDraftInput);
  const saveDraftInput = useSessionStore((state) => state.saveDraftInput);
  const setQueuedMessages = useSessionStore((state) => state.setQueuedMessages);
  const getSession = useSessionStore((state) => state.getSession);

  // State for voice detection flags (will be set by RealtimeContext)
  const isDetectingRef = useRef(false);
  const isSpeakingRef = useRef(false);

  const audioPlayer = useAudioPlayer({
    isDetecting: () => isDetectingRef.current,
    isSpeaking: () => isSpeakingRef.current,
  });

  const activeAudioGroupsRef = useRef<Set<string>>(new Set());
  const previousAgentStatusRef = useRef<Map<string, AgentLifecycleStatus>>(new Map());
  const providerModelRequestIdsRef = useRef<Map<any, string>>(new Map());
  const hasHydratedSnapshotRef = useRef(false);
  const hasRequestedInitialSnapshotRef = useRef(false);
  const sessionStateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Buffer for streaming audio chunks
  interface AudioChunk {
    chunkIndex: number;
    audio: string; // base64
    format: string;
    id: string;
  }
  const audioChunkBuffersRef = useRef<Map<string, AudioChunk[]>>(new Map());

  // Initialize session in store
  useEffect(() => {
    initializeSession(serverId, ws, audioPlayer);
  }, [serverId, ws, audioPlayer, initializeSession]);

  const updateSessionWebSocket = useSessionStore((state) => state.updateSessionWebSocket);
  useEffect(() => {
    updateSessionWebSocket(serverId, ws);
  }, [serverId, ws, updateSessionWebSocket]);

  // Connection status tracking
  useEffect(() => {
    if (ws.isConnected) {
      updateConnectionStatus(serverId, {
        status: "online",
        lastOnlineAt: new Date().toISOString(),
      });
      return;
    }

    if (ws.isConnecting) {
      updateConnectionStatus(serverId, { status: "connecting" });
      return;
    }

    if (ws.lastError) {
      updateConnectionStatus(serverId, { status: "error", lastError: ws.lastError });
      return;
    }

    updateConnectionStatus(serverId, { status: "offline" });
  }, [serverId, updateConnectionStatus, ws.isConnected, ws.isConnecting, ws.lastError]);

  // If the socket drops mid-initialization, clear pending flags
  useEffect(() => {
    if (!ws.isConnected) {
      setInitializingAgents(serverId, new Map());
    }
  }, [serverId, ws.isConnected, setInitializingAgents]);

  useEffect(() => {
    return () => {
      updateConnectionStatus(serverId, { status: "offline", lastError: null });
    };
  }, [serverId, updateConnectionStatus]);

  useEffect(() => {
    hasHydratedSnapshotRef.current = false;
    setHasHydratedAgents(serverId, false);
  }, [serverId, setHasHydratedAgents]);

  useEffect(() => {
    let isMounted = true;

    const hydrateFromSnapshot = async () => {
      if (hasHydratedSnapshotRef.current) {
        return;
      }
      hasHydratedSnapshotRef.current = true;
      const snapshot = await loadPersistedSessionSnapshot(serverId);
      if (!snapshot || !isMounted) {
        return;
      }

      const agents = new Map();
      const pendingPermissions = new Map();
      const agentLastActivity = new Map();

      for (const agentSnapshot of snapshot.agents) {
        const agent = normalizeAgentSnapshot(agentSnapshot, serverId);
        agents.set(agent.id, agent);
        agentLastActivity.set(agent.id, agent.lastActivityAt);
        for (const request of agent.pendingPermissions) {
          const key = derivePendingPermissionKey(agent.id, request);
          pendingPermissions.set(key, { key, agentId: agent.id, request });
        }
      }

      setAgents(serverId, (prev) => {
        if (prev.size > 0) {
          return prev;
        }
        return agents;
      });

      // Initialize agentLastActivity slice (top-level)
      for (const [agentId, timestamp] of agentLastActivity.entries()) {
        setAgentLastActivity(agentId, timestamp);
      }

      setPendingPermissions(serverId, pendingPermissions);
      const commandEntries = snapshot.commands ?? [];
      setCommands(serverId, (prev) => {
        if (prev.size > 0) {
          return prev;
        }
        return new Map(commandEntries.map((command) => [command.id, command]));
      });
      setHasHydratedAgents(serverId, true);
    };

    void hydrateFromSnapshot();

    return () => {
      isMounted = false;
    };
  }, [serverId, setAgents, setCommands, setPendingPermissions, setHasHydratedAgents]);

  const updateExplorerState = useCallback(
    (agentId: string, updater: (state: any) => any) => {
      setFileExplorer(serverId, (prev) => {
        const next = new Map(prev);
        const current = next.get(agentId) ?? createExplorerState();
        next.set(agentId, updater(current));
        return next;
      });
    },
    [serverId, setFileExplorer]
  );

  const gitDiffRequest = useDaemonRequest<
    { agentId: string },
    { agentId: string; diff: string },
    GitDiffResponseMessage
  >({
    ws,
    responseType: "git_diff_response",
    buildRequest: ({ params }) => ({
      type: "session",
      message: {
        type: "git_diff_request",
        agentId: params?.agentId ?? "",
      },
    }),
    matchResponse: (message, context) =>
      message.payload.agentId === context.params?.agentId,
    getRequestKey: (params) => params?.agentId ?? "default",
    selectData: (message) => ({
      agentId: message.payload.agentId,
      diff: message.payload.diff ?? "",
    }),
    extractError: (message) =>
      message.payload.error ? new Error(message.payload.error) : null,
    timeoutMs: 10000,
    keepPreviousData: false,
  });

  const refreshAgentRequest = useDaemonRequest<
    { agentId: string },
    { agentId: string; lifecycle: AgentLifecycleStatus | undefined },
    StatusMessage
  >({
    ws,
    responseType: "status",
    buildRequest: ({ params, requestId }) => ({
      type: "session",
      message: {
        type: "refresh_agent_request",
        agentId: params?.agentId ?? "",
        requestId,
      },
    }),
    matchResponse: (message, context) =>
      message.payload.status === "agent_initialized" &&
      (message.payload as { agentId?: string }).agentId === context.params?.agentId &&
      (message.payload as { requestId?: string }).requestId === context.requestId,
    getRequestKey: (params) => params?.agentId ?? "default",
    selectData: (message) => ({
      agentId: (message.payload as { agentId?: string }).agentId ?? "",
      lifecycle: (message.payload as { agentStatus?: AgentLifecycleStatus }).agentStatus,
    }),
    extractError: (message) =>
      message.payload.status === "error"
        ? new Error((message.payload as { message?: string }).message ?? "Refresh failed")
        : null,
    timeoutMs: 15000,
    keepPreviousData: false,
  });

  const directoryListingRequest = useDaemonRequest<
    { agentId: string; path: string },
    FileExplorerResponseMessage["payload"],
    FileExplorerResponseMessage
  >({
    ws,
    responseType: "file_explorer_response",
    buildRequest: ({ params }) => ({
      type: "session",
      message: {
        type: "file_explorer_request",
        agentId: params?.agentId ?? "",
        path: params?.path,
        mode: "list",
      },
    }),
    matchResponse: (message, context) =>
      message.payload.mode === "list" &&
      message.payload.agentId === context.params?.agentId &&
      message.payload.path === context.params?.path,
    getRequestKey: (params) =>
      params ? `${params.agentId}:list:${params.path}` : "default",
    selectData: (message) => message.payload,
    extractError: (message) =>
      message.payload.error ? new Error(message.payload.error) : null,
    timeoutMs: 10000,
    keepPreviousData: false,
  });

  const filePreviewRequest = useDaemonRequest<
    { agentId: string; path: string },
    FileExplorerResponseMessage["payload"],
    FileExplorerResponseMessage
  >({
    ws,
    responseType: "file_explorer_response",
    buildRequest: ({ params }) => ({
      type: "session",
      message: {
        type: "file_explorer_request",
        agentId: params?.agentId ?? "",
        path: params?.path,
        mode: "file",
      },
    }),
    matchResponse: (message, context) =>
      message.payload.mode === "file" &&
      message.payload.agentId === context.params?.agentId &&
      message.payload.path === context.params?.path,
    getRequestKey: (params) =>
      params ? `${params.agentId}:file:${params.path}` : "default",
    selectData: (message) => message.payload,
    extractError: (message) =>
      message.payload.error ? new Error(message.payload.error) : null,
    timeoutMs: 10000,
    keepPreviousData: false,
  });

  const fileDownloadTokenRequest = useDaemonRequest<
    { agentId: string; path: string },
    FileDownloadTokenResponseMessage["payload"],
    FileDownloadTokenResponseMessage
  >({
    ws,
    responseType: "file_download_token_response",
    buildRequest: ({ params, requestId }) => ({
      type: "session",
      message: {
        type: "file_download_token_request",
        agentId: params?.agentId ?? "",
        path: params?.path ?? "",
        requestId,
      },
    }),
    matchResponse: (message, context) => {
      if (message.payload.requestId) {
        return message.payload.requestId === context.requestId;
      }
      return (
        message.payload.agentId === context.params?.agentId &&
        message.payload.path === context.params?.path
      );
    },
    getRequestKey: (params) =>
      params ? `${params.agentId}:download:${params.path}` : "default",
    selectData: (message) => message.payload,
    extractError: (message) =>
      message.payload.error ? new Error(message.payload.error) : null,
    timeoutMs: 10000,
    keepPreviousData: false,
  });

  const initializeAgentRpc = useSessionRpc({
    ws,
    requestType: "initialize_agent_request",
    responseType: "initialize_agent_request",
  });

  useEffect(() => {
    if (!wsIsConnected) {
      hasRequestedInitialSnapshotRef.current = false;
      return;
    }
    if (hasRequestedInitialSnapshotRef.current) {
      return;
    }
    hasRequestedInitialSnapshotRef.current = true;

    const MAX_RETRIES = 3;
    const TIMEOUT_MS = 15000;
    const RETRY_DELAY_MS = 2000;

    let retryCount = 0;

    const requestSessionState = () => {
      console.log(`[Session] Requesting session_state (attempt ${retryCount + 1}/${MAX_RETRIES + 1})`, { serverId });

      ws.send({
        type: "session",
        message: {
          type: "load_conversation_request",
          conversationId: ws.conversationId ?? "",
        },
      });

      if (sessionStateTimeoutRef.current) {
        clearTimeout(sessionStateTimeoutRef.current);
      }

      sessionStateTimeoutRef.current = setTimeout(() => {
        if (retryCount < MAX_RETRIES) {
          retryCount++;
          console.warn(`[Session] session_state timeout, retrying in ${RETRY_DELAY_MS}ms`, {
            serverId,
            attempt: retryCount,
            maxRetries: MAX_RETRIES,
          });

          setTimeout(() => {
            requestSessionState();
          }, RETRY_DELAY_MS);
        } else {
          console.error(`[Session] session_state failed after ${MAX_RETRIES} retries`, { serverId });

          setHasHydratedAgents(serverId, true);
          updateConnectionStatus(serverId, {
            status: "online",
            lastOnlineAt: new Date().toISOString(),
            sessionReady: true
          });
        }
      }, TIMEOUT_MS);
    };

    requestSessionState();

    return () => {
      if (sessionStateTimeoutRef.current) {
        clearTimeout(sessionStateTimeoutRef.current);
        sessionStateTimeoutRef.current = null;
      }
    };
  }, [wsIsConnected, ws, serverId, setHasHydratedAgents, updateConnectionStatus]);

  // WebSocket message handlers - directly update Zustand store
  useEffect(() => {
    console.log("[Session] Setting up session_state listener for", serverId);

    const unsubSessionState = ws.on("session_state", (message) => {
      if (message.type !== "session_state") return;

      if (sessionStateTimeoutRef.current) {
        clearTimeout(sessionStateTimeoutRef.current);
        sessionStateTimeoutRef.current = null;
      }

      const { agents: agentsList, commands: commandsList } = message.payload;

      console.log("[Session] ✅ Received session_state:", agentsList.length, "agents,", commandsList.length, "commands");
      setInitializingAgents(serverId, new Map());

      const agents = new Map();
      const pendingPermissions = new Map();
      const agentLastActivity = new Map();

      for (const agentSnapshot of agentsList) {
        const agent = normalizeAgentSnapshot(agentSnapshot, serverId);
        agents.set(agent.id, agent);
        agentLastActivity.set(agent.id, agent.lastActivityAt);
        for (const request of agent.pendingPermissions) {
          const key = derivePendingPermissionKey(agent.id, request);
          pendingPermissions.set(key, { key, agentId: agent.id, request });
        }
      }

      const normalizedCommands = commandsList.map((command) => command);

      setAgents(serverId, agents);

      // Initialize agentLastActivity slice (top-level)
      for (const [agentId, timestamp] of agentLastActivity.entries()) {
        setAgentLastActivity(agentId, timestamp);
      }

      setPendingPermissions(serverId, pendingPermissions);
      setCommands(serverId, new Map(normalizedCommands.map((command: any) => [command.id, command])));
      setAgentStreamState(serverId, (prev) => {
        if (prev.size === 0) {
          return prev;
        }

        const validAgentIds = new Set(agentsList.map((snapshot) => snapshot.id));
        let changed = false;
        const next = new Map(prev);

        for (const agentId of prev.keys()) {
          if (!validAgentIds.has(agentId)) {
            next.delete(agentId);
            changed = true;
          }
        }

        return changed ? next : prev;
      });
      setAgentStreamingBuffer(serverId, (prev) => {
        if (prev.size === 0) {
          return prev;
        }

        const validAgentIds = new Set(agentsList.map((snapshot) => snapshot.id));
        let changed = false;
        const next = new Map(prev);

        for (const agentId of prev.keys()) {
          if (!validAgentIds.has(agentId)) {
            next.delete(agentId);
            changed = true;
          }
        }

        return changed ? next : prev;
      });
      setInitializingAgents(serverId, (prev) => {
        if (prev.size === 0) {
          return prev;
        }

        const validAgentIds = new Set(agentsList.map((snapshot) => snapshot.id));
        let changed = false;
        const next = new Map(prev);

        for (const agentId of prev.keys()) {
          if (!validAgentIds.has(agentId)) {
            next.delete(agentId);
            changed = true;
          }
        }

        return changed ? next : prev;
      });
      void persistSessionSnapshot(serverId, { agents: agentsList, commands: normalizedCommands });
      setHasHydratedAgents(serverId, true);
      updateConnectionStatus(serverId, { status: "online", lastOnlineAt: new Date().toISOString(), sessionReady: true });
    });

    const unsubAgentState = ws.on("agent_state", (message) => {
      if (message.type !== "agent_state") return;
      const snapshot = message.payload;
      const agent = normalizeAgentSnapshot(snapshot, serverId);

      console.log("[Session] Agent state update:", agent.id, agent.status);

      setAgents(serverId, (prev) => {
        const next = new Map(prev);
        next.set(agent.id, agent);
        return next;
      });

      // Update agentLastActivity slice (top-level)
      setAgentLastActivity(agent.id, agent.lastActivityAt);

      setPendingPermissions(serverId, (prev) => {
        const next = new Map(prev);
        for (const [key, pending] of Array.from(next.entries())) {
          if (pending.agentId === agent.id) {
            next.delete(key);
          }
        }
        for (const request of agent.pendingPermissions) {
          const key = derivePendingPermissionKey(agent.id, request);
          next.set(key, { key, agentId: agent.id, request });
        }
        return next;
      });
    });

    const unsubAgentStream = ws.on("agent_stream", (message) => {
      if (message.type !== "agent_stream") return;
      const { agentId, event, timestamp } = message.payload;
      const parsedTimestamp = new Date(timestamp);

      console.log("[Session] agent_stream", { agentId, eventType: event.type });

      const session = useSessionStore.getState().sessions[serverId];
      const currentStream = session?.agentStreamState.get(agentId) ?? [];
      const currentBuffer = session?.agentStreamingBuffer.get(agentId) ?? null;
      const { stream, buffer, changedStream, changedBuffer } = applyStreamEventWithBuffer({
        state: currentStream,
        buffer: currentBuffer,
        event: event as AgentStreamEventPayload,
        timestamp: parsedTimestamp,
      });

      if (changedStream) {
        setAgentStreamState(serverId, (prev) => {
          const next = new Map(prev);
          next.set(agentId, stream);
          return next;
        });
      }

      if (changedBuffer) {
        setAgentStreamingBuffer(serverId, (prev) => {
          const next = new Map(prev);
          if (buffer) {
            next.set(agentId, buffer);
          } else {
            next.delete(agentId);
          }
          return next;
        });
      }

      setInitializingAgents(serverId, (prev) => {
        const currentState = prev.get(agentId);
        if (currentState === false) {
          return prev;
        }
        const next = new Map(prev);
        next.set(agentId, false);
        return next;
      });

      // NOTE: We don't update lastActivityAt on every stream event to prevent
      // cascading rerenders. The agent_state handler updates agent.lastActivityAt
      // on status changes, which is sufficient for sorting and display purposes.
    });

    const unsubAgentStreamSnapshot = ws.on("agent_stream_snapshot", (message) => {
      if (message.type !== "agent_stream_snapshot") return;
      const { agentId, events } = message.payload;

      console.log("[Session] agent_stream_snapshot", {
        agentId,
        eventCount: events.length,
      });

      const hydrated = hydrateStreamState(
        events.map(({ event, timestamp }) => ({
          event: event as AgentStreamEventPayload,
          timestamp: new Date(timestamp),
        }))
      );

      setAgentStreamState(serverId, (prev) => {
        const next = new Map(prev);
        next.set(agentId, hydrated);
        return next;
      });
      clearAgentStreamingBuffer(serverId, agentId);

      setInitializingAgents(serverId, (prev) => {
        if (!prev.has(agentId)) {
          return prev;
        }
        const next = new Map(prev);
        next.set(agentId, false);
        return next;
      });
    });

    const unsubStatus = ws.on("status", (message) => {
      if (message.type !== "status") return;
      const status = message.payload.status;
      if (status === "agent_initialized" && "agentId" in message.payload) {
        console.log("[Session] status agent_initialized", {
          agentId: (message.payload as any).agentId,
          requestId: (message.payload as any).requestId,
        });
      }
      if (status === "agent_initialized" && "agentId" in message.payload) {
        const agentId = (message.payload as any).agentId as string | undefined;
        if (agentId) {
          setInitializingAgents(serverId, (prev) => {
            const next = new Map(prev);
            next.set(agentId, false);
            return next;
          });
        }
      }
    });

    const unsubPermissionRequest = ws.on("agent_permission_request", (message) => {
      if (message.type !== "agent_permission_request") return;
      const { agentId, request } = message.payload;

      console.log("[Session] Permission request:", request.id, "for agent:", agentId);

      setPendingPermissions(serverId, (prev) => {
        const next = new Map(prev);
        const key = derivePendingPermissionKey(agentId, request);
        next.set(key, { key, agentId, request });
        return next;
      });
    });

    const unsubPermissionResolved = ws.on("agent_permission_resolved", (message) => {
      if (message.type !== "agent_permission_resolved") return;
      const { requestId, agentId } = message.payload;

      console.log("[Session] Permission resolved:", requestId, "for agent:", agentId);

      setPendingPermissions(serverId, (prev) => {
        const next = new Map(prev);
        const derivedKey = `${agentId}:${requestId}`;
        if (!next.delete(derivedKey)) {
          for (const [key, pending] of next.entries()) {
            if (pending.agentId === agentId && pending.request.id === requestId) {
              next.delete(key);
              break;
            }
          }
        }
        return next;
      });
    });

    const unsubAudioOutput = ws.on("audio_output", async (message) => {
      if (message.type !== "audio_output") return;
      const data = message.payload;
      const playbackGroupId = data.groupId ?? data.id;
      const isFinalChunk = data.isLastChunk ?? true;
      const chunkIndex = data.chunkIndex ?? 0;

      activeAudioGroupsRef.current.add(playbackGroupId);
      setIsPlayingAudio(serverId, true);

      if (!audioChunkBuffersRef.current.has(playbackGroupId)) {
        audioChunkBuffersRef.current.set(playbackGroupId, []);
      }

      const buffer = audioChunkBuffersRef.current.get(playbackGroupId)!;
      buffer.push({
        chunkIndex,
        audio: data.audio,
        format: data.format,
        id: data.id,
      });

      if (!isFinalChunk) {
        console.log(`[Session] Buffered chunk ${chunkIndex} for group ${playbackGroupId}`);
        return;
      }

      console.log(`[Session] Received final chunk for group ${playbackGroupId}, total chunks: ${buffer.length}`);
      buffer.sort((a, b) => a.chunkIndex - b.chunkIndex);

      let playbackFailed = false;
      const chunkIds = buffer.map(chunk => chunk.id);

      try {
        const mimeType =
          data.format === "mp3" ? "audio/mpeg" : `audio/${data.format}`;

        const decodedChunks: Uint8Array[] = [];
        let totalSize = 0;

        for (const chunk of buffer) {
          const binaryString = atob(chunk.audio);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          decodedChunks.push(bytes);
          totalSize += bytes.length;
        }

        const concatenatedBytes = new Uint8Array(totalSize);
        let offset = 0;
        for (const chunk of decodedChunks) {
          concatenatedBytes.set(chunk, offset);
          offset += chunk.length;
        }

        console.log(`[Session] Playing concatenated audio: ${buffer.length} chunks, ${totalSize} bytes`);

        const audioBlob = {
          type: mimeType,
          size: totalSize,
          arrayBuffer: async () => {
            return concatenatedBytes.buffer;
          },
        } as Blob;

        await audioPlayer.play(audioBlob);

        for (const chunkId of chunkIds) {
          const confirmMessage: WSInboundMessage = {
            type: "session",
            message: {
              type: "audio_played",
              id: chunkId,
            },
          };
          ws.send(confirmMessage);
        }
      } catch (error: any) {
        playbackFailed = true;
        console.error("[Session] Audio playback error:", error);

        for (const chunkId of chunkIds) {
          const confirmMessage: WSInboundMessage = {
            type: "session",
            message: {
              type: "audio_played",
              id: chunkId,
            },
          };
          ws.send(confirmMessage);
        }
      } finally {
        audioChunkBuffersRef.current.delete(playbackGroupId);
        activeAudioGroupsRef.current.delete(playbackGroupId);

        if (activeAudioGroupsRef.current.size === 0) {
          setIsPlayingAudio(serverId, false);
        }
      }
    });

    const unsubActivity = ws.on("activity_log", (message) => {
      if (message.type !== "activity_log") return;
      const data = message.payload;

      if (data.type === "system" && data.content.includes("Transcribing")) {
        return;
      }

      if (data.type === "tool_call" && data.metadata) {
        const {
          toolCallId,
          toolName,
          arguments: args,
        } = data.metadata as {
          toolCallId: string;
          toolName: string;
          arguments: unknown;
        };

        setMessages(serverId, (prev) => [
          ...prev,
          {
            type: "tool_call",
            id: toolCallId,
            timestamp: Date.now(),
            toolName,
            args,
            status: "executing",
          },
        ]);
        return;
      }

      if (data.type === "tool_result" && data.metadata) {
        const { toolCallId, result } = data.metadata as {
          toolCallId: string;
          result: unknown;
        };

        setMessages(serverId, (prev) =>
          prev.map((msg) =>
            msg.type === "tool_call" && msg.id === toolCallId
              ? { ...msg, result, status: "completed" as const }
              : msg
          )
        );
        return;
      }

      if (
        data.type === "error" &&
        data.metadata &&
        "toolCallId" in data.metadata
      ) {
        const { toolCallId, error } = data.metadata as {
          toolCallId: string;
          error: unknown;
        };

        setMessages(serverId, (prev) =>
          prev.map((msg) =>
            msg.type === "tool_call" && msg.id === toolCallId
              ? { ...msg, error, status: "failed" as const }
              : msg
          )
        );
      }

      let activityType: "system" | "info" | "success" | "error" = "info";
      if (data.type === "error") activityType = "error";

      if (data.type === "transcript") {
        setMessages(serverId, (prev) => [
          ...prev,
          {
            type: "user",
            id: generateMessageId(),
            timestamp: Date.now(),
            message: data.content,
          },
        ]);
        return;
      }

      if (data.type === "assistant") {
        setMessages(serverId, (prev) => [
          ...prev,
          {
            type: "assistant",
            id: generateMessageId(),
            timestamp: Date.now(),
            message: data.content,
          },
        ]);
        setCurrentAssistantMessage(serverId, "");
        return;
      }

      setMessages(serverId, (prev) => [
        ...prev,
        {
          type: "activity",
          id: generateMessageId(),
          timestamp: Date.now(),
          activityType,
          message: data.content,
          metadata: data.metadata,
        },
      ]);
    });

    const unsubChunk = ws.on("assistant_chunk", (message) => {
      if (message.type !== "assistant_chunk") return;
      setCurrentAssistantMessage(serverId, (prev) => prev + message.payload.chunk);
    });

    const unsubTranscription = ws.on("transcription_result", (message) => {
      if (message.type !== "transcription_result") return;

      const transcriptText = message.payload.text.trim();

      if (!transcriptText) {
        console.log("[Session] Empty transcription (false positive) - ignoring");
      } else {
        console.log("[Session] Transcription received - stopping playback");
        audioPlayer.stop();
        setIsPlayingAudio(serverId, false);
        setCurrentAssistantMessage(serverId, "");
      }
    });

    const unsubProviderModels = ws.on(
      "list_provider_models_response",
      (message) => {
        if (message.type !== "list_provider_models_response") {
          return;
        }
        const { provider, models, error, fetchedAt, requestId } = message.payload;
        const latestRequestId = providerModelRequestIdsRef.current.get(provider);
        if (latestRequestId && requestId && requestId !== latestRequestId) {
          return;
        }
        if (requestId) {
          providerModelRequestIdsRef.current.delete(provider);
        }
        setProviderModels(serverId, (prev) => {
          const next = new Map(prev);
          next.set(provider, {
            models: models ?? null,
            error: error ?? null,
            fetchedAt: new Date(fetchedAt),
            isLoading: false,
          });
          return next;
        });
      }
    );

    const unsubAgentDeleted = ws.on("agent_deleted", (message) => {
      if (message.type !== "agent_deleted") {
        return;
      }
      const { agentId } = message.payload;
      console.log("[Session] Agent deleted:", agentId);

      setAgents(serverId, (prev) => {
        if (!prev.has(agentId)) {
          return prev;
        }
        const next = new Map(prev);
        next.delete(agentId);
        return next;
      });

      // Remove from agentLastActivity slice (top-level)
      useSessionStore.setState((state) => {
        if (!state.agentLastActivity.has(agentId)) {
          return state;
        }
        const nextActivity = new Map(state.agentLastActivity);
        nextActivity.delete(agentId);
        return {
          ...state,
          agentLastActivity: nextActivity,
        };
      });

      setAgentStreamState(serverId, (prev) => {
        if (!prev.has(agentId)) {
          return prev;
        }
        const next = new Map(prev);
        next.delete(agentId);
        return next;
      });
      clearAgentStreamingBuffer(serverId, agentId);

      // Remove draft input
      saveDraftInput(agentId, { text: "", images: [] });

      setPendingPermissions(serverId, (prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const [key, pending] of prev.entries()) {
          if (pending.agentId === agentId) {
            next.delete(key);
            changed = true;
          }
        }
        return changed ? next : prev;
      });

      setInitializingAgents(serverId, (prev) => {
        if (!prev.has(agentId)) {
          return prev;
        }
        const next = new Map(prev);
        next.delete(agentId);
        return next;
      });

      setGitDiffs(serverId, (prev) => {
        if (!prev.has(agentId)) {
          return prev;
        }
        const next = new Map(prev);
        next.delete(agentId);
        return next;
      });

      setFileExplorer(serverId, (prev) => {
        if (!prev.has(agentId)) {
          return prev;
        }
        const next = new Map(prev);
        next.delete(agentId);
        return next;
      });
    });

    return () => {
      unsubSessionState();
      unsubAgentState();
      unsubAgentStream();
      unsubAgentStreamSnapshot();
      unsubStatus();
      unsubPermissionRequest();
      unsubPermissionResolved();
      unsubAudioOutput();
      unsubActivity();
      unsubChunk();
      unsubTranscription();
      unsubProviderModels();
      unsubAgentDeleted();
    };
  }, [ws, audioPlayer, serverId, setIsPlayingAudio, setMessages, setCurrentAssistantMessage, setAgentStreamState, setAgentStreamingBuffer, clearAgentStreamingBuffer, setInitializingAgents, setAgents, setAgentLastActivity, setCommands, setPendingPermissions, setGitDiffs, setFileExplorer, setProviderModels, setHasHydratedAgents, updateConnectionStatus, getSession, saveDraftInput]);

  // Auto-flush queued messages when agent transitions from running -> not running
  useEffect(() => {
    const session = getSession(serverId);
    if (!session) return;

    for (const [agentId, agent] of session.agents.entries()) {
      const prevStatus = previousAgentStatusRef.current.get(agentId);
      if (prevStatus === "running" && agent.status !== "running") {
        const queue = session.queuedMessages.get(agentId);
        if (queue && queue.length > 0) {
          const [next, ...rest] = queue;
          void sendAgentMessage(agentId, next.text, next.images);
          setQueuedMessages(serverId, (prev) => {
            const updated = new Map(prev);
            updated.set(agentId, rest);
            return updated;
          });
        }
      }
      previousAgentStatusRef.current.set(agentId, agent.status);
    }
  }, [serverId, getSession, setQueuedMessages]);

  const initializeAgent = useCallback(({ agentId, requestId }: { agentId: string; requestId?: string }) => {
    console.log("[Session] initializeAgent called", { agentId, requestId });
    setInitializingAgents(serverId, (prev) => {
      const next = new Map(prev);
      next.set(agentId, true);
      return next;
    });

    setAgentStreamState(serverId, (prev) => {
      const next = new Map(prev);
      next.set(agentId, []);
      return next;
    });
    clearAgentStreamingBuffer(serverId, agentId);

    initializeAgentRpc
      .send({ agentId })
      .catch((error) => {
        console.warn("[Session] initializeAgent failed", { agentId, error });
        setInitializingAgents(serverId, (prev) => {
          const next = new Map(prev);
          next.set(agentId, false);
          return next;
        });
      });
  }, [serverId, initializeAgentRpc, setAgentStreamState, setInitializingAgents, clearAgentStreamingBuffer]);

  const refreshAgent = useCallback(({ agentId, requestId }: { agentId: string; requestId?: string }) => {
    setInitializingAgents(serverId, (prev) => {
      const next = new Map(prev);
      next.set(agentId, true);
      return next;
    });

    setAgentStreamState(serverId, (prev) => {
      const next = new Map(prev);
      next.set(agentId, []);
      return next;
    });
    clearAgentStreamingBuffer(serverId, agentId);

    refreshAgentRequest
      .execute({ agentId }, { requestKeyOverride: agentId, dedupe: false })
      .catch((error) => {
        console.warn("[Session] refreshAgent failed", { agentId, error });
        setInitializingAgents(serverId, (prev) => {
          const next = new Map(prev);
          next.set(agentId, false);
          return next;
        });
      });
  }, [serverId, refreshAgentRequest, setAgentStreamState, setInitializingAgents, clearAgentStreamingBuffer]);

  const requestProviderModels = useCallback((provider: any, options?: { cwd?: string }) => {
    const requestId = generateMessageId();
    providerModelRequestIdsRef.current.set(provider, requestId);
    setProviderModels(serverId, (prev) => {
      const next = new Map(prev);
      const current =
        prev.get(provider) ?? {
          models: null,
          fetchedAt: null,
          error: null,
          isLoading: false,
        };
      next.set(provider, {
        ...current,
        isLoading: true,
        error: null,
      });
      return next;
    });
    const msg: WSInboundMessage = {
      type: "session",
      message: {
        type: "list_provider_models_request",
        provider,
        ...(options?.cwd ? { cwd: options.cwd } : {}),
        requestId,
      },
    };
    ws.send(msg);
  }, [serverId, ws, setProviderModels]);

  const encodeImages = useCallback(async (
    images?: Array<{ uri: string; mimeType?: string }>
  ) => {
    if (!images || images.length === 0) {
      return undefined;
    }
    const encodedImages = await Promise.all(
      images.map(async ({ uri, mimeType }) => {
        try {
          const data = await (async () => {
            if (Platform.OS === "web") {
              if (uri.startsWith("data:")) {
                const [, base64] = uri.split(",", 2);
                if (!base64) {
                  throw new Error("Malformed data URI for image.");
                }
                return base64;
              }
              const response = await fetch(uri);
              if (!response.ok) {
                throw new Error(`Failed to fetch image: ${response.status}`);
              }
              const blob = await response.blob();
              const base64 = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => {
                  if (typeof reader.result !== "string") {
                    reject(new Error("Unexpected FileReader result type."));
                    return;
                  }
                  const [, resultBase64] = reader.result.split(",", 2);
                  if (!resultBase64) {
                    reject(new Error("Failed to read image data as base64."));
                    return;
                  }
                  resolve(resultBase64);
                };
                reader.onerror = () => {
                  reject(reader.error ?? new Error("Failed to read image data."));
                };
                reader.readAsDataURL(blob);
              });
              return base64;
            }
            const file = new File(uri);
            return await file.base64();
          })();
          return {
            data,
            mimeType: mimeType ?? "image/jpeg",
          };
        } catch (error) {
          console.error("[Session] Failed to convert image:", error);
          return null;
        }
      })
    );
    const validImages = encodedImages.filter(
      (entry): entry is { data: string; mimeType: string } => entry !== null
    );
    return validImages.length > 0 ? validImages : undefined;
  }, []);

  const sendAgentMessage = useCallback(async (
    agentId: string,
    message: string,
    images?: Array<{ uri: string; mimeType?: string }>
  ) => {
    const messageId = generateMessageId();

    setAgentStreamState(serverId, (prev) => {
      const currentStream = prev.get(agentId) || [];
      const nextItem: any = {
        kind: "user_message",
        id: messageId,
        text: message,
        timestamp: new Date(),
      };
      const updated = new Map(prev);
      updated.set(agentId, [...currentStream, nextItem]);
      return updated;
    });

    const imagesData = await encodeImages(images);

    const msg: WSInboundMessage = {
      type: "session",
      message: {
        type: "send_agent_message",
        agentId,
        text: message,
        messageId,
        ...(imagesData && imagesData.length > 0 ? { images: imagesData } : {}),
      },
    };
    ws.send(msg);
  }, [encodeImages, serverId, ws, setAgentStreamState]);

  const cancelAgentRun = useCallback((agentId: string) => {
    const msg: WSInboundMessage = {
      type: "session",
      message: {
        type: "cancel_agent_request",
        agentId,
      },
    };
    ws.send(msg);
  }, [ws]);

  const deleteAgent = useCallback((agentId: string) => {
    const msg: WSInboundMessage = {
      type: "session",
      message: {
        type: "delete_agent_request",
        agentId,
      },
    };
    ws.send(msg);
  }, [ws]);

  const restartServer = useCallback((reason?: string) => {
    const msg: WSInboundMessage = {
      type: "session",
      message: {
        type: "restart_server_request",
        ...(reason && reason.trim().length > 0 ? { reason } : {}),
      },
    };
    ws.send(msg);
  }, [ws]);

  const sendAgentAudio = useCallback(async (
    agentId: string,
    audioBlob: Blob,
    requestId?: string,
    options?: { mode?: "transcribe_only" | "auto_run" }
  ) => {
    try {
      const isSocketConnected = ws.getConnectionState ? ws.getConnectionState().isConnected : ws.isConnected;
      if (!isSocketConnected) {
        throw new Error("WebSocket is disconnected");
      }
      const arrayBuffer = await audioBlob.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64Audio = btoa(binary);

      const deriveFormat = (mimeType: string | undefined): string => {
        if (!mimeType || mimeType.length === 0) {
          return "webm";
        }
        const slashIndex = mimeType.indexOf("/");
        let formatPart = slashIndex >= 0 ? mimeType.slice(slashIndex + 1) : mimeType;
        const semicolonIndex = formatPart.indexOf(";");
        if (semicolonIndex >= 0) {
          formatPart = formatPart.slice(0, semicolonIndex);
        }
        return formatPart.trim().length > 0 ? formatPart.trim() : "webm";
      };

      const format = deriveFormat(audioBlob.type);

      const msg: WSInboundMessage = {
        type: "session",
        message: {
          type: "send_agent_audio",
          agentId,
          audio: base64Audio,
          format,
          isLast: true,
          requestId,
          ...(options?.mode ? { mode: options.mode } : {}),
        },
      };
      ws.send(msg);

      console.log("[Session] Sent audio to agent:", agentId, format, audioBlob.size, "bytes", requestId ? `(requestId: ${requestId})` : "");
    } catch (error) {
      console.error("[Session] Failed to send audio:", error);
      throw error;
    }
  }, [ws]);

  const createAgent = useCallback(async ({ config, initialPrompt, images, git, worktreeName, requestId }: { config: any; initialPrompt: string; images?: Array<{ uri: string; mimeType?: string }>; git?: any; worktreeName?: string; requestId?: string }) => {
    console.log("[Session] createAgent called with images:", images?.length ?? 0, images);
    const trimmedPrompt = initialPrompt.trim();
    let imagesData: Array<{ data: string; mimeType: string }> | undefined;
    try {
      imagesData = await encodeImages(images);
      console.log("[Session] encodeImages result:", imagesData?.length ?? 0, imagesData?.map(img => ({ dataLength: img.data?.length ?? 0, mimeType: img.mimeType })));
    } catch (error) {
      console.error("[Session] Failed to prepare images for agent creation:", error);
    }
    const msg: WSInboundMessage = {
      type: "session",
      message: {
        type: "create_agent_request",
        config,
        ...(trimmedPrompt ? { initialPrompt: trimmedPrompt } : {}),
        ...(imagesData && imagesData.length > 0 ? { images: imagesData } : {}),
        ...(git ? { git } : {}),
        ...(worktreeName ? { worktreeName } : {}),
        ...(requestId ? { requestId } : {}),
      },
    };
    console.log("[Session] createAgent message has images:", 'images' in msg.message, (msg.message as any).images?.length);
    ws.send(msg);
  }, [encodeImages, ws]);

  const resumeAgent = useCallback(({ handle, overrides, requestId }: { handle: any; overrides?: any; requestId?: string }) => {
    const msg: WSInboundMessage = {
      type: "session",
      message: {
        type: "resume_agent_request",
        handle,
        ...(overrides ? { overrides } : {}),
        ...(requestId ? { requestId } : {}),
      },
    };
    ws.send(msg);
  }, [ws]);

  const setAgentMode = useCallback((agentId: string, modeId: string) => {
    const msg: WSInboundMessage = {
      type: "session",
      message: {
        type: "set_agent_mode",
        agentId,
        modeId,
      },
    };
    ws.send(msg);
  }, [ws]);

  const respondToPermission = useCallback((agentId: string, requestId: string, response: any) => {
    const msg: WSInboundMessage = {
      type: "session",
      message: {
        type: "agent_permission_response",
        agentId,
        requestId,
        response,
      },
    };
    ws.send(msg);
  }, [ws]);

  const setVoiceDetectionFlags = useCallback((isDetecting: boolean, isSpeaking: boolean) => {
    isDetectingRef.current = isDetecting;
    isSpeakingRef.current = isSpeaking;
  }, []);

  const requestGitDiff = useCallback((agentId: string) => {
    gitDiffRequest
      .execute({ agentId })
      .then((result) => {
        setGitDiffs(serverId, (prev) => new Map(prev).set(result.agentId, result.diff));
      })
      .catch((error) => {
        setGitDiffs(serverId, (prev) => new Map(prev).set(agentId, `Error: ${error.message}`));
      });
  }, [serverId, gitDiffRequest, setGitDiffs]);

  const requestDirectoryListing = useCallback((agentId: string, path: string, options?: { recordHistory?: boolean }) => {
    const normalizedPath = path && path.length > 0 ? path : ".";
    const shouldRecordHistory = options?.recordHistory ?? true;

    updateExplorerState(agentId, (state: any) => ({
      ...state,
      isLoading: true,
      lastError: null,
      pendingRequest: { path: normalizedPath, mode: "list" },
      currentPath: normalizedPath,
      history: shouldRecordHistory ? pushHistory(state.history, normalizedPath) : state.history,
      lastVisitedPath: normalizedPath,
    }));

    directoryListingRequest
      .execute({ agentId, path: normalizedPath })
      .then((payload) => {
        updateExplorerState(agentId, (state: any) => {
          const nextState: any = {
            ...state,
            isLoading: false,
            lastError: payload.error ?? null,
            pendingRequest: null,
            directories: state.directories,
            files: state.files,
          };

          if (!payload.error && payload.directory) {
            const directories = new Map(state.directories);
            directories.set(payload.directory.path, payload.directory);
            nextState.directories = directories;
          }

          return nextState;
        });
      })
      .catch((error) => {
        updateExplorerState(agentId, (state: any) => ({
          ...state,
          isLoading: false,
          lastError: error.message,
          pendingRequest: null,
        }));
      });
  }, [directoryListingRequest, updateExplorerState]);

  const requestFilePreview = useCallback((agentId: string, path: string) => {
    const normalizedPath = path && path.length > 0 ? path : ".";
    updateExplorerState(agentId, (state: any) => ({
      ...state,
      isLoading: true,
      pendingRequest: { path: normalizedPath, mode: "file" },
    }));

    filePreviewRequest
      .execute({ agentId, path: normalizedPath })
      .then((payload) => {
        updateExplorerState(agentId, (state: any) => {
          const nextState: any = {
            ...state,
            isLoading: false,
            pendingRequest: null,
            directories: state.directories,
            files: state.files,
          };

          if (!payload.error && payload.file) {
            const files = new Map(state.files);
            files.set(payload.file.path, payload.file);
            nextState.files = files;
          }

          return nextState;
        });
      })
      .catch((error) => {
        updateExplorerState(agentId, (state: any) => ({
          ...state,
          isLoading: false,
          pendingRequest: null,
        }));
      });
  }, [filePreviewRequest, updateExplorerState]);

  const requestFileDownloadToken = useCallback(
    (agentId: string, path: string) => {
      return fileDownloadTokenRequest.execute({ agentId, path });
    },
    [fileDownloadTokenRequest]
  );

  const navigateExplorerBack = useCallback((agentId: string) => {
    let targetPath: string | null = null;

    updateExplorerState(agentId, (state: any) => {
      if (!state.history || state.history.length <= 1) {
        return state;
      }

      const nextHistory = state.history.slice(0, -1);
      targetPath = nextHistory[nextHistory.length - 1] ?? ".";

      return {
        ...state,
        isLoading: true,
        lastError: null,
        pendingRequest: { path: targetPath, mode: "list" },
        currentPath: targetPath,
        history: nextHistory,
        lastVisitedPath: targetPath,
      };
    });

    if (!targetPath) {
      return null;
    }

    directoryListingRequest
      .execute({ agentId, path: targetPath })
      .then((payload) => {
        updateExplorerState(agentId, (state: any) => {
          const nextState: any = {
            ...state,
            isLoading: false,
            lastError: payload.error ?? null,
            pendingRequest: null,
            directories: state.directories,
            files: state.files,
          };

          if (!payload.error && payload.directory) {
            const directories = new Map(state.directories);
            directories.set(payload.directory.path, payload.directory);
            nextState.directories = directories;
          }

          return nextState;
        });
      })
      .catch((error) => {
        updateExplorerState(agentId, (state: any) => ({
          ...state,
          isLoading: false,
          lastError: error.message,
          pendingRequest: null,
        }));
      });
    return targetPath;
  }, [directoryListingRequest, updateExplorerState]);

  const refreshSession = useCallback(() => {
    console.log(`[Session] Manual refresh requested for ${serverId}`);
    ws.send({
      type: "session",
      message: {
        type: "load_conversation_request",
        conversationId: ws.conversationId ?? "",
      },
    });
  }, [ws, serverId]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearSession(serverId);
    };
  }, [serverId, clearSession]);

  const value = useMemo<SessionContextValue>(
    () => ({
      serverId,
      ws,
      audioPlayer,
      setVoiceDetectionFlags,
      requestGitDiff,
      requestDirectoryListing,
      requestFilePreview,
      requestFileDownloadToken,
      navigateExplorerBack,
      requestProviderModels,
      restartServer,
      initializeAgent,
      refreshAgent,
      refreshSession,
      cancelAgentRun,
      deleteAgent,
      sendAgentMessage,
      sendAgentAudio,
      createAgent,
      resumeAgent,
      setAgentMode,
      respondToPermission,
    }),
    [
      serverId,
      ws,
      audioPlayer,
      setVoiceDetectionFlags,
      requestGitDiff,
      requestDirectoryListing,
      requestFilePreview,
      requestFileDownloadToken,
      navigateExplorerBack,
      requestProviderModels,
      restartServer,
      initializeAgent,
      refreshAgent,
      refreshSession,
      cancelAgentRun,
      deleteAgent,
      sendAgentMessage,
      sendAgentAudio,
      createAgent,
      resumeAgent,
      setAgentMode,
      respondToPermission,
    ]
  );

  // Sync imperative methods to Zustand store so components can access them via selectors
  // Memoize the methods object to avoid infinite re-renders (object reference must be stable)
  const setSessionMethods = useSessionStore((state) => state.setSessionMethods);
  const methods = useMemo(() => ({
    setVoiceDetectionFlags,
    requestGitDiff,
    requestDirectoryListing,
    requestFilePreview,
    requestFileDownloadToken,
    navigateExplorerBack,
    requestProviderModels,
    restartServer,
    initializeAgent,
    refreshAgent,
    refreshSession,
    cancelAgentRun,
    sendAgentMessage,
    sendAgentAudio,
    deleteAgent,
    createAgent,
    resumeAgent,
    setAgentMode,
    respondToPermission,
  }), [
    setVoiceDetectionFlags,
    requestGitDiff,
    requestDirectoryListing,
    requestFilePreview,
    requestFileDownloadToken,
    navigateExplorerBack,
    requestProviderModels,
    restartServer,
    initializeAgent,
    refreshAgent,
    refreshSession,
    cancelAgentRun,
    sendAgentMessage,
    sendAgentAudio,
    deleteAgent,
    createAgent,
    resumeAgent,
    setAgentMode,
    respondToPermission,
  ]);

  useEffect(() => {
    setSessionMethods(serverId, methods);
  }, [serverId, setSessionMethods, methods]);

  return (
    <SessionContext.Provider value={value}>
      {children}
    </SessionContext.Provider>
  );
}

// Export the context for components that need imperative APIs
export { SessionContext };
