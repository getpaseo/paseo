import { createContext, useState, useRef, ReactNode, useCallback, useEffect, useMemo } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useWebSocket, type UseWebSocketReturn } from "@/hooks/use-websocket";
import { useDaemonRequest } from "@/hooks/use-daemon-request";
import { useSessionRpc } from "@/hooks/use-session-rpc";
import { useAudioPlayer } from "@/hooks/use-audio-player";
import { reduceStreamUpdate, generateMessageId, hydrateStreamState, type StreamItem } from "@/types/stream";
import type { PendingPermission } from "@/types/shared";
import type {
  ActivityLogPayload,
  AgentSnapshotPayload,
  AgentStreamEventPayload,
  WSInboundMessage,
  GitSetupOptions,
  SessionOutboundMessage,
} from "@server/server/messages";
import type {
  AgentLifecycleStatus,
} from "@server/server/agent/agent-manager";
import type {
  AgentPermissionResponse,
  AgentSessionConfig,
  AgentProvider,
  AgentPermissionRequest,
  AgentMode,
  AgentCapabilityFlags,
  AgentModelDefinition,
  AgentUsage,
  AgentPersistenceHandle,
} from "@server/server/agent/agent-sdk-types";
import { ScrollView } from "react-native";
import * as FileSystem from 'expo-file-system';
import { useDaemonConnections } from "./daemon-connections-context";
import { useSessionStore } from "@/stores/session-store";
import type { AgentDirectoryEntry } from "@/types/agent-directory";
import { SESSION_DEBUG_PERSIST_FULL_SNAPSHOT } from "@/config/session-debug";
import { publishSessionHeavyState, clearSessionHeavyState } from "@/stores/session-heavy-state";
import type { SessionHeavyState } from "@/stores/session-heavy-state";

const derivePendingPermissionKey = (agentId: string, request: AgentPermissionRequest) => {
  const fallbackId =
    request.id ||
    (typeof request.metadata?.id === "string" ? request.metadata.id : undefined) ||
    request.name ||
    request.title ||
    `${request.kind}:${JSON.stringify(request.input ?? request.metadata ?? {})}`;

  return `${agentId}:${fallbackId}`;
};

type DraftInput = {
  text: string;
  images: Array<{ uri: string; mimeType: string }>;
};

type GitDiffResponseMessage = Extract<
  SessionOutboundMessage,
  { type: "git_diff_response" }
>;

type FileExplorerResponseMessage = Extract<
  SessionOutboundMessage,
  { type: "file_explorer_response" }
>;

type StatusMessage = Extract<SessionOutboundMessage, { type: "status" }>;

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

type ProviderModelState = {
  models: AgentModelDefinition[] | null;
  fetchedAt: Date | null;
  error: string | null;
  isLoading: boolean;
};

export interface Agent {
  serverId: string;
  id: string;
  provider: AgentProvider;
  status: AgentLifecycleStatus;
  createdAt: Date;
  updatedAt: Date;
   lastUserMessageAt: Date | null;
  lastActivityAt: Date;
  sessionId: string | null;
  capabilities: AgentCapabilityFlags;
  currentModeId: string | null;
  availableModes: AgentMode[];
  pendingPermissions: AgentPermissionRequest[];
  persistence: AgentPersistenceHandle | null;
  lastUsage?: AgentUsage;
  lastError?: string | null;
  title: string | null;
  cwd: string;
  model: string | null;
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

const createExplorerState = (): AgentFileExplorerState => ({
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

const SESSION_SNAPSHOT_STORAGE_PREFIX = "@paseo:session-snapshot:";
const SESSION_SNAPSHOT_VERSION = 2;
export const MAX_MESSAGES_PER_AGENT = 200;
export const MAX_STREAM_ITEMS_PER_AGENT = 200;

const EMPTY_MESSAGES: MessageEntry[] = [];
const EMPTY_AGENT_STREAM_STATE = new Map<string, StreamItem[]>();
const DEFAULT_AGENT_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
};

type PersistedDirectoryEntry = Omit<AgentDirectoryEntry, "lastActivityAt"> & {
  lastActivityAt: string;
};

type LegacySessionSnapshot = {
  agents: AgentSnapshotPayload[];
  commands: Command[];
  savedAt: string;
};

type LightweightSessionSnapshot = {
  version: typeof SESSION_SNAPSHOT_VERSION;
  directory: PersistedDirectoryEntry[];
  savedAt: string;
  full?: {
    agents: AgentSnapshotPayload[];
    commands: Command[];
  };
};

type LoadedSessionSnapshot =
  | {
      kind: "legacy";
      agents: AgentSnapshotPayload[];
      commands: Command[];
      savedAt: string;
    }
  | {
      kind: "lightweight";
      directory: AgentDirectoryEntry[];
      savedAt: string;
      full?: {
        agents: AgentSnapshotPayload[];
        commands: Command[];
      };
    };

const getSessionSnapshotStorageKey = (serverId: string): string => {
  return `${SESSION_SNAPSHOT_STORAGE_PREFIX}${serverId}`;
};

function isLegacySessionSnapshot(payload: any): payload is LegacySessionSnapshot {
  return Array.isArray(payload?.agents) && Array.isArray(payload?.commands);
}

function isLightweightSessionSnapshot(payload: any): payload is LightweightSessionSnapshot {
  return (
    payload?.version === SESSION_SNAPSHOT_VERSION &&
    Array.isArray(payload?.directory)
  );
}

function deserializePersistedDirectoryEntry(entry: PersistedDirectoryEntry): AgentDirectoryEntry {
  return {
    ...entry,
    lastActivityAt: new Date(entry.lastActivityAt),
  };
}

function serializeDirectoryEntry(entry: AgentDirectoryEntry): PersistedDirectoryEntry {
  return {
    ...entry,
    lastActivityAt: entry.lastActivityAt.toISOString(),
  };
}

async function loadPersistedSessionSnapshot(serverId: string): Promise<LoadedSessionSnapshot | null> {
  try {
    const raw = await AsyncStorage.getItem(getSessionSnapshotStorageKey(serverId));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (isLightweightSessionSnapshot(parsed)) {
      return {
        kind: "lightweight",
        directory: parsed.directory.map(deserializePersistedDirectoryEntry),
        savedAt: parsed.savedAt,
        full: parsed.full,
      };
    }
    if (!isLegacySessionSnapshot(parsed)) {
      return null;
    }
    return {
      kind: "legacy",
      agents: parsed.agents,
      commands: parsed.commands,
      savedAt: parsed.savedAt,
    };
  } catch (error) {
    console.error(`[Session] Failed to load persisted snapshot for ${serverId}`, error);
    return null;
  }
}

async function persistSessionSnapshot(
  serverId: string,
  snapshot: { agents: AgentSnapshotPayload[]; commands: Command[]; directory: AgentDirectoryEntry[] }
) {
  try {
    const payload: LightweightSessionSnapshot = {
      version: SESSION_SNAPSHOT_VERSION,
      directory: snapshot.directory.map(serializeDirectoryEntry),
      savedAt: new Date().toISOString(),
      ...(SESSION_DEBUG_PERSIST_FULL_SNAPSHOT
        ? { full: { agents: snapshot.agents, commands: snapshot.commands } }
        : {}),
    };
    const persistenceMode = SESSION_DEBUG_PERSIST_FULL_SNAPSHOT ? "full" : "directory";
    await AsyncStorage.setItem(getSessionSnapshotStorageKey(serverId), JSON.stringify(payload));
    console.log("[Session] Persisted snapshot", {
      serverId,
      agentCount: snapshot.directory.length,
      mode: persistenceMode,
    });
  } catch (error) {
    console.error(`[Session] Failed to persist snapshot for ${serverId}`, error);
  }
}

type PendingAgentLifecycleRequest = {
  kind: "initialize" | "refresh";
  params: {
    agentId: string;
    requestId?: string;
  };
};

function normalizeAgentSnapshot(snapshot: AgentSnapshotPayload, serverId: string): Agent {
  const createdAt = new Date(snapshot.createdAt);
  const updatedAt = new Date(snapshot.updatedAt);
  const lastUserMessageAt = snapshot.lastUserMessageAt ? new Date(snapshot.lastUserMessageAt) : null;
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
    lastUsage: snapshot.lastUsage,
    lastError: snapshot.lastError ?? null,
    title: snapshot.title ?? null,
    cwd: snapshot.cwd,
    model: snapshot.model ?? null,
  };
}

function buildSessionStateFromSnapshots(serverId: string, snapshots: AgentSnapshotPayload[]) {
  const agents = new Map<string, Agent>();
  const pendingPermissions = new Map<string, PendingPermission>();

  for (const snapshot of snapshots) {
    const agent = normalizeAgentSnapshot(snapshot, serverId);
    agents.set(agent.id, agent);
    for (const request of agent.pendingPermissions) {
      const key = derivePendingPermissionKey(agent.id, request);
      pendingPermissions.set(key, { key, agentId: agent.id, request });
    }
  }

  return { agents, pendingPermissions };
}

function buildAgentDirectoryEntries(serverId: string, agents: Map<string, Agent>): AgentDirectoryEntry[] {
  const entries: AgentDirectoryEntry[] = [];
  for (const agent of agents.values()) {
    entries.push({
      id: agent.id,
      serverId,
      title: agent.title ?? null,
      status: agent.status,
      lastActivityAt: agent.lastActivityAt,
      cwd: agent.cwd,
      provider: agent.provider,
    });
  }
  return entries;
}

function buildAgentsFromDirectoryEntries(serverId: string, entries: AgentDirectoryEntry[]) {
  const agents = new Map<string, Agent>();
  for (const entry of entries) {
    const lastActivity = entry.lastActivityAt ?? new Date();
    agents.set(entry.id, {
      serverId,
      id: entry.id,
      provider: entry.provider,
      status: entry.status,
      createdAt: lastActivity,
      updatedAt: lastActivity,
      lastUserMessageAt: null,
      lastActivityAt: lastActivity,
      sessionId: null,
      capabilities: DEFAULT_AGENT_CAPABILITIES,
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      lastUsage: undefined,
      lastError: null,
      title: entry.title ?? null,
      cwd: entry.cwd,
      model: null,
    });
  }
  return agents;
}

function capMessages(entries: MessageEntry[], serverId: string): MessageEntry[] {
  if (entries.length <= MAX_MESSAGES_PER_AGENT) {
    return entries;
  }
  const trimmed = entries.slice(-MAX_MESSAGES_PER_AGENT);
  console.log("[Session] Trimmed messages", {
    serverId,
    before: entries.length,
    after: trimmed.length,
    cap: MAX_MESSAGES_PER_AGENT,
  });
  return trimmed;
}

function capAgentStreamState(map: Map<string, StreamItem[]>, serverId: string): Map<string, StreamItem[]> {
  let trimmed = false;
  const trimmedAgents: Array<{ agentId: string; before: number; after: number }> = [];
  const next = new Map(map);

  for (const [agentId, stream] of map.entries()) {
    if (stream.length <= MAX_STREAM_ITEMS_PER_AGENT) {
      continue;
    }
    trimmed = true;
    const capped = stream.slice(-MAX_STREAM_ITEMS_PER_AGENT);
    next.set(agentId, capped);
    trimmedAgents.push({
      agentId,
      before: stream.length,
      after: capped.length,
    });
  }

  if (trimmed) {
    console.log("[Session] Trimmed stream buffers", {
      serverId,
      cap: MAX_STREAM_ITEMS_PER_AGENT,
      agents: trimmedAgents,
    });
    return next;
  }

  return map;
}

function filterSessionStorePayload(payload: Partial<SessionContextValue>): Partial<SessionContextValue> {
  const { messages: _messages, agentStreamState: _agentStreamState, ...rest } = payload;
  const next: Partial<SessionContextValue> = { ...rest };
  if (_messages !== undefined) {
    next.messages = EMPTY_MESSAGES;
  }
  if (_agentStreamState !== undefined) {
    next.agentStreamState = EMPTY_AGENT_STREAM_STATE;
  }
  return next;
}


export interface SessionContextValue {
  serverId: string;
  // WebSocket
  ws: UseWebSocketReturn;
  hasHydratedAgents: boolean;

  // Audio
  audioPlayer: ReturnType<typeof useAudioPlayer>;
  isPlayingAudio: boolean;
  setIsPlayingAudio: (playing: boolean) => void;
  
  // Voice detection flags (updated by RealtimeContext)
  setVoiceDetectionFlags: (isDetecting: boolean, isSpeaking: boolean) => void;
  focusedAgentId: string | null;
  setFocusedAgentId: (agentId: string | null) => void;

  // Messages and stream state
  messages: MessageEntry[];
  setMessages: (messages: MessageEntry[] | ((prev: MessageEntry[]) => MessageEntry[])) => void;
  currentAssistantMessage: string;
  setCurrentAssistantMessage: (message: string | ((prev: string) => string)) => void;
  agentStreamState: Map<string, StreamItem[]>;
  setAgentStreamState: (state: Map<string, StreamItem[]> | ((prev: Map<string, StreamItem[]>) => Map<string, StreamItem[]>)) => void;
  initializingAgents: Map<string, boolean>;

  // Queued messages and draft input per agent
  getDraftInput: (agentId: string) => DraftInput | undefined;
  saveDraftInput: (agentId: string, draft: DraftInput) => void;
  queuedMessages: Map<string, Array<{ id: string; text: string; images?: Array<{ uri: string; mimeType: string }> }>>;
  setQueuedMessages: (value: Map<string, Array<{ id: string; text: string; images?: Array<{ uri: string; mimeType: string }> }>> | ((prev: Map<string, Array<{ id: string; text: string; images?: Array<{ uri: string; mimeType: string }> }>>) => Map<string, Array<{ id: string; text: string; images?: Array<{ uri: string; mimeType: string }> }>>)) => void;

  // Agents and commands
  agents: Map<string, Agent>;
  setAgents: (agents: Map<string, Agent> | ((prev: Map<string, Agent>) => Map<string, Agent>)) => void;
  commands: Map<string, Command>;
  setCommands: (commands: Map<string, Command> | ((prev: Map<string, Command>) => Map<string, Command>)) => void;

  // Permissions
  pendingPermissions: Map<string, PendingPermission>;
  setPendingPermissions: (perms: Map<string, PendingPermission> | ((prev: Map<string, PendingPermission>) => Map<string, PendingPermission>)) => void;

  // Git diffs
  gitDiffs: Map<string, string>;
  requestGitDiff: (agentId: string) => void;

  // File explorer
  fileExplorer: Map<string, AgentFileExplorerState>;
  requestDirectoryListing: (agentId: string, path: string, options?: { recordHistory?: boolean }) => void;
  requestFilePreview: (agentId: string, path: string) => void;
  navigateExplorerBack: (agentId: string) => string | null;

  providerModels: Map<AgentProvider, ProviderModelState>;
  requestProviderModels: (provider: AgentProvider, options?: { cwd?: string }) => void;

  // Helpers
  restartServer: (reason?: string) => void;
  initializeAgent: (params: { agentId: string; requestId?: string }) => void;
  refreshAgent: (params: { agentId: string; requestId?: string }) => void;
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
    config: AgentSessionConfig;
    initialPrompt: string;
    git?: GitSetupOptions;
    worktreeName?: string;
    requestId?: string;
  }) => void;
  resumeAgent: (options: { handle: AgentPersistenceHandle; overrides?: Partial<AgentSessionConfig>; requestId?: string }) => void;
  setAgentMode: (agentId: string, modeId: string) => void;
  respondToPermission: (agentId: string, requestId: string, response: AgentPermissionResponse) => void;
}

type SyncSessionField = <K extends keyof SessionContextValue>(
  key: K,
  value: SessionContextValue[K]
) => void;

function useSyncedSessionState<K extends keyof SessionContextValue>(
  key: K,
  initialValue: SessionContextValue[K] | (() => SessionContextValue[K]),
  syncField: SyncSessionField
): [
  SessionContextValue[K],
  (valueOrUpdater: SessionContextValue[K] | ((prev: SessionContextValue[K]) => SessionContextValue[K])) => void
] {
  const [state, setState] = useState<SessionContextValue[K]>(() => {
    return typeof initialValue === "function"
      ? (initialValue as () => SessionContextValue[K])()
      : initialValue;
  });

  const setAndSync = useCallback(
    (valueOrUpdater: SessionContextValue[K] | ((prev: SessionContextValue[K]) => SessionContextValue[K])) => {
      setState((previous: SessionContextValue[K]) => {
        const next =
          typeof valueOrUpdater === "function"
            ? (valueOrUpdater as (prev: SessionContextValue[K]) => SessionContextValue[K])(previous)
            : valueOrUpdater;

        if (Object.is(previous, next)) {
          return previous;
        }

        syncField(key, next);
        return next;
      });
    },
    [key, syncField]
  );

  return [state, setAndSync];
}

const SessionContext = createContext<SessionContextValue | null>(null);

interface SessionProviderProps {
  children: ReactNode;
  serverUrl: string;
  serverId: string;
}

// SessionProvider feeds session state into Zustand; external consumers should use useDaemonSession or useSessionStore instead of accessing SessionContext directly.
export function SessionProvider({ children, serverUrl, serverId }: SessionProviderProps) {
  const ws = useWebSocket(serverUrl);
  const wsIsConnected = ws.isConnected;
  const {
    updateConnectionStatus,
  } = useDaemonConnections();
  const setSession = useSessionStore((state) => state.setSession);
  const updateSession = useSessionStore((state) => state.updateSession);
  const clearSession = useSessionStore((state) => state.clearSession);
  const setAgentDirectory = useSessionStore((state) => state.setAgentDirectory);
  const clearAgentDirectory = useSessionStore((state) => state.clearAgentDirectory);
  const hasRegisteredSessionRef = useRef(false);
  const pendingSessionUpdatesRef = useRef<Partial<SessionContextValue>>({});
  const initialSessionValueRef = useRef<SessionContextValue | null>(null);

  const syncSessionPartial = useCallback(
    (partial: Partial<SessionContextValue>) => {
      const filtered = filterSessionStorePayload(partial);
      if (!hasRegisteredSessionRef.current) {
        pendingSessionUpdatesRef.current = {
          ...pendingSessionUpdatesRef.current,
          ...filtered,
        };
        return;
      }
      updateSession(serverId, filtered);
    },
    [serverId, updateSession]
  );

  const syncSessionField = useCallback<SyncSessionField>(
    (key, value) => {
      syncSessionPartial({ [key]: value } as Partial<SessionContextValue>);
    },
    [syncSessionPartial]
  );

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

  // If the socket drops mid-initialization, clear pending flags so screens don't spin forever
  useEffect(() => {
    if (!ws.isConnected) {
      setInitializingAgents(new Map());
    }
  }, [ws.isConnected]);

  useEffect(() => {
    return () => {
      updateConnectionStatus(serverId, { status: "offline", lastError: null });
    };
  }, [serverId, updateConnectionStatus]);
  
  // State for voice detection flags (will be set by RealtimeContext)
  const isDetectingRef = useRef(false);
  const isSpeakingRef = useRef(false);
  
  const audioPlayer = useAudioPlayer({
    isDetecting: () => isDetectingRef.current,
    isSpeaking: () => isSpeakingRef.current,
  });

  const [isPlayingAudio, updateIsPlayingAudio] = useSyncedSessionState("isPlayingAudio", false, syncSessionField);
  const setIsPlayingAudio = useCallback((playing: boolean) => {
    updateIsPlayingAudio(playing);
  }, [updateIsPlayingAudio]);
  const [focusedAgentOverride, setFocusedAgentOverride] = useState<string | null>(null);
  const [orchestratorFocusedAgentId, setOrchestratorFocusedAgentId] = useState<string | null>(null);
  const [messages, setLocalMessages] = useState<MessageEntry[]>([]);
  const setMessages = useCallback<SessionContextValue["setMessages"]>(
    (valueOrUpdater) => {
      setLocalMessages((previous) => {
        const next =
          typeof valueOrUpdater === "function"
            ? (valueOrUpdater as (prev: MessageEntry[]) => MessageEntry[])(previous)
            : valueOrUpdater;
        return capMessages(next, serverId);
      });
    },
    [serverId]
  );
  const [currentAssistantMessage, setCurrentAssistantMessage] = useSyncedSessionState("currentAssistantMessage", "", syncSessionField);
  const [agentStreamState, setLocalAgentStreamState] = useState<Map<string, StreamItem[]>>(
    () => new Map<string, StreamItem[]>()
  );
  const setAgentStreamState = useCallback<SessionContextValue["setAgentStreamState"]>(
    (valueOrUpdater) => {
      setLocalAgentStreamState((previous) => {
        const next =
          typeof valueOrUpdater === "function"
            ? (valueOrUpdater as (prev: Map<string, StreamItem[]>) => Map<string, StreamItem[]>)(previous)
            : valueOrUpdater;
        return capAgentStreamState(next, serverId);
      });
    },
    [serverId]
  );
  const [initializingAgents, setInitializingAgents] = useSyncedSessionState("initializingAgents", () => new Map<string, boolean>(), syncSessionField);
  const [hasHydratedAgents, setHasHydratedAgents] = useSyncedSessionState("hasHydratedAgents", false, syncSessionField);

  const [agents, setAgents] = useSyncedSessionState("agents", () => new Map<string, Agent>(), syncSessionField);
  const lightweightAgentDirectory = useMemo(
    () => buildAgentDirectoryEntries(serverId, agents),
    [agents, serverId]
  );
  useEffect(() => {
    setAgentDirectory(serverId, lightweightAgentDirectory);
  }, [lightweightAgentDirectory, serverId, setAgentDirectory]);
  const [commands, setCommands] = useSyncedSessionState("commands", () => new Map<string, Command>(), syncSessionField);
  const [pendingPermissions, setPendingPermissions] = useSyncedSessionState("pendingPermissions", () => new Map<string, PendingPermission>(), syncSessionField);
  const [gitDiffs, setGitDiffs] = useSyncedSessionState("gitDiffs", () => new Map<string, string>(), syncSessionField);
  const [fileExplorer, setFileExplorer] = useSyncedSessionState("fileExplorer", () => new Map<string, AgentFileExplorerState>(), syncSessionField);
  const [providerModels, setProviderModels] = useSyncedSessionState("providerModels", () => new Map<AgentProvider, ProviderModelState>(), syncSessionField);
  const draftInputsRef = useRef<Map<string, DraftInput>>(new Map());
  const getDraftInput = useCallback<SessionContextValue["getDraftInput"]>((agentId) => {
    return draftInputsRef.current.get(agentId);
  }, []);

  const saveDraftInput = useCallback<SessionContextValue["saveDraftInput"]>((agentId, draft) => {
    draftInputsRef.current.set(agentId, {
      text: draft.text,
      images: draft.images,
    });
  }, []);
  const [queuedMessages, setQueuedMessages] = useSyncedSessionState("queuedMessages", () => new Map(), syncSessionField);
  const heavyStateRef = useRef<SessionHeavyState>({
    messages,
    agentStreamState,
  });

  useEffect(() => {
    heavyStateRef.current = {
      messages,
      agentStreamState,
    };
    publishSessionHeavyState(serverId, heavyStateRef.current);
  }, [agentStreamState, messages, serverId]);

  useEffect(() => {
    return () => {
      clearSessionHeavyState(serverId);
    };
  }, [serverId]);
  const activeAudioGroupsRef = useRef<Set<string>>(new Set());
  const previousAgentStatusRef = useRef<Map<string, AgentLifecycleStatus>>(new Map());
  const providerModelRequestIdsRef = useRef<Map<AgentProvider, string>>(new Map());
  const hasHydratedSnapshotRef = useRef(false);
  const hasRequestedInitialSnapshotRef = useRef(false);

  // Buffer for streaming audio chunks
  interface AudioChunk {
    chunkIndex: number;
    audio: string; // base64
    format: string;
    id: string;
  }
  const audioChunkBuffersRef = useRef<Map<string, AudioChunk[]>>(new Map());

  const focusedAgentId = focusedAgentOverride ?? orchestratorFocusedAgentId;
  const setFocusedAgentId = useCallback((agentId: string | null) => {
    setFocusedAgentOverride(agentId);
  }, []);

  useEffect(() => {
    hasHydratedSnapshotRef.current = false;
    setHasHydratedAgents(false);
  }, [serverId]);

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

      const hasFullSnapshot = snapshot.kind === "legacy" || Boolean(snapshot.full);
      const snapshotMode = hasFullSnapshot ? "full" : "directory";
      const agentCount =
        snapshot.kind === "legacy"
          ? snapshot.agents.length
          : snapshot.directory.length;

      console.log("[Session] Hydrating snapshot", {
        serverId,
        mode: snapshotMode,
        agentCount,
      });

      if (hasFullSnapshot) {
        const fullAgents = snapshot.kind === "legacy" ? snapshot.agents : snapshot.full?.agents ?? [];
        const fullCommands = snapshot.kind === "legacy" ? snapshot.commands : snapshot.full?.commands ?? [];

        const { agents: hydratedAgents, pendingPermissions: hydratedPermissions } =
          buildSessionStateFromSnapshots(serverId, fullAgents);

        let applied = false;
        setAgents((prev) => {
          if (prev.size > 0) {
            return prev;
          }
          applied = true;
          return hydratedAgents;
        });

        if (!applied) {
          return;
        }

        setPendingPermissions(hydratedPermissions);
        setCommands((prev) => {
          if (prev.size > 0) {
            return prev;
          }
          return new Map(fullCommands.map((command) => [command.id, command]));
        });
      } else {
        const stubAgents = buildAgentsFromDirectoryEntries(serverId, snapshot.directory);
        let applied = false;
        setAgents((prev) => {
          if (prev.size > 0) {
            return prev;
          }
          applied = true;
          return stubAgents;
        });

        if (!applied) {
          return;
        }

        setPendingPermissions(new Map());
        setCommands((prev) => (prev.size > 0 ? prev : new Map()));
      }

      setHasHydratedAgents(true);
    };

    void hydrateFromSnapshot();

    return () => {
      isMounted = false;
    };
  }, [serverId]);

  useEffect(() => {
    if (focusedAgentOverride) {
      if (orchestratorFocusedAgentId !== null) {
        setOrchestratorFocusedAgentId(null);
      }
      return;
    }

    let latestRunningAgentId: string | null = null;
    let latestActivityTimestamp = -Infinity;

    for (const agent of agents.values()) {
      if (agent.status !== "running") {
        continue;
      }

      const activityTimestamp = agent.lastActivityAt?.getTime() ?? agent.updatedAt.getTime();
      if (activityTimestamp > latestActivityTimestamp) {
        latestActivityTimestamp = activityTimestamp;
        latestRunningAgentId = agent.id;
      }
    }

    if (latestRunningAgentId !== orchestratorFocusedAgentId) {
      setOrchestratorFocusedAgentId(latestRunningAgentId);
    }
  }, [agents, focusedAgentOverride, orchestratorFocusedAgentId]);

  const updateExplorerState = useCallback(
    (agentId: string, updater: (state: AgentFileExplorerState) => AgentFileExplorerState) => {
      setFileExplorer((prev) => {
        const next = new Map(prev);
        const current = next.get(agentId) ?? createExplorerState();
        next.set(agentId, updater(current));
        return next;
      });
    },
    []
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
    ws.send({
      type: "session",
      message: {
        type: "load_conversation_request",
        conversationId: ws.conversationId ?? "",
      },
    });
  }, [wsIsConnected, ws]);

  // WebSocket message handlers
  useEffect(() => {
    // Session state - initial agents/commands
    const unsubSessionState = ws.on("session_state", (message) => {
      if (message.type !== "session_state") return;
      const { agents: agentsList, commands: commandsList } = message.payload;

      console.log("[Session] Session state:", agentsList.length, "agents,", commandsList.length, "commands");
      setInitializingAgents(new Map());

      const { agents: hydratedAgents, pendingPermissions: hydratedPermissions } = buildSessionStateFromSnapshots(
        serverId,
        agentsList
      );
      const directoryEntries = buildAgentDirectoryEntries(serverId, hydratedAgents);
      const normalizedCommands = commandsList.map((command) => command as Command);

      setAgents(hydratedAgents);
      setPendingPermissions(hydratedPermissions);
      setCommands(new Map(normalizedCommands.map((command) => [command.id, command])));
      setAgentStreamState((prev) => {
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
      setInitializingAgents((prev) => {
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
      void persistSessionSnapshot(serverId, { agents: agentsList, commands: normalizedCommands, directory: directoryEntries });
      setHasHydratedAgents(true);
      updateConnectionStatus(serverId, { status: "online", lastOnlineAt: new Date().toISOString(), sessionReady: true });
    });

    const unsubAgentState = ws.on("agent_state", (message) => {
      if (message.type !== "agent_state") return;
      const snapshot = message.payload;
      const agent = normalizeAgentSnapshot(snapshot, serverId);

      console.log("[Session] Agent state update:", agent.id, agent.status);

      setAgents((prev) => {
        const next = new Map(prev);
        next.set(agent.id, agent);
        return next;
      });

      setPendingPermissions((prev) => {
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

      setAgentStreamState((prev) => {
        const currentStream = prev.get(agentId) || [];
        const newStream = reduceStreamUpdate(
          currentStream,
          event as AgentStreamEventPayload,
          parsedTimestamp
        );
        const next = new Map(prev);
        next.set(agentId, newStream);
        return next;
      });

      setInitializingAgents((prev) => {
        const currentState = prev.get(agentId);
        if (currentState === false) {
          return prev;
        }
        const next = new Map(prev);
        next.set(agentId, false);
        return next;
      });

      setAgents((prev) => {
        const existing = prev.get(agentId);
        if (!existing) {
          return prev;
        }
        const next = new Map(prev);
        next.set(agentId, {
          ...existing,
          lastActivityAt: parsedTimestamp,
          updatedAt: parsedTimestamp,
        });
        return next;
      });
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

      setAgentStreamState((prev) => {
        const next = new Map(prev);
        next.set(agentId, hydrated);
        return next;
      });

      setInitializingAgents((prev) => {
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
          setInitializingAgents((prev) => {
            const next = new Map(prev);
            next.set(agentId, false);
            return next;
          });
        }
      }
    });

    // Permission request
    const unsubPermissionRequest = ws.on("agent_permission_request", (message) => {
      if (message.type !== "agent_permission_request") return;
      const { agentId, request } = message.payload;

      console.log("[Session] Permission request:", request.id, "for agent:", agentId);

      setPendingPermissions((prev) => {
        const next = new Map(prev);
        const key = derivePendingPermissionKey(agentId, request);
        next.set(key, { key, agentId, request });
        return next;
      });
    });

    // Permission resolved - remove from pending
    const unsubPermissionResolved = ws.on("agent_permission_resolved", (message) => {
      if (message.type !== "agent_permission_resolved") return;
      const { requestId, agentId } = message.payload;

      console.log("[Session] Permission resolved:", requestId, "for agent:", agentId);

      setPendingPermissions((prev) => {
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

    // Audio output
    const unsubAudioOutput = ws.on("audio_output", async (message) => {
      if (message.type !== "audio_output") return;
      const data = message.payload;
      const playbackGroupId = data.groupId ?? data.id;
      const isFinalChunk = data.isLastChunk ?? true;
      const chunkIndex = data.chunkIndex ?? 0;

      activeAudioGroupsRef.current.add(playbackGroupId);
      setIsPlayingAudio(true);

      // Buffer the chunk
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

      // Only play when we receive the final chunk
      if (!isFinalChunk) {
        console.log(`[Session] Buffered chunk ${chunkIndex} for group ${playbackGroupId}`);
        return;
      }

      // We have all chunks - sort by index and concatenate
      console.log(`[Session] Received final chunk for group ${playbackGroupId}, total chunks: ${buffer.length}`);
      buffer.sort((a, b) => a.chunkIndex - b.chunkIndex);

      let playbackFailed = false;
      const chunkIds = buffer.map(chunk => chunk.id);

      try {
        const mimeType =
          data.format === "mp3" ? "audio/mpeg" : `audio/${data.format}`;

        // Decode each chunk separately and concatenate binary data
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

        // Concatenate all decoded chunks
        const concatenatedBytes = new Uint8Array(totalSize);
        let offset = 0;
        for (const chunk of decodedChunks) {
          concatenatedBytes.set(chunk, offset);
          offset += chunk.length;
        }

        console.log(`[Session] Playing concatenated audio: ${buffer.length} chunks, ${totalSize} bytes`);

        // Create a Blob-like object that works in React Native
        const audioBlob = {
          type: mimeType,
          size: totalSize,
          arrayBuffer: async () => {
            return concatenatedBytes.buffer;
          },
        } as Blob;

        // Play concatenated audio
        await audioPlayer.play(audioBlob);

        // Send confirmation for all chunks
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

        // Still send confirmation for all chunks even on error
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
        // Clean up buffer and active group
        audioChunkBuffersRef.current.delete(playbackGroupId);
        activeAudioGroupsRef.current.delete(playbackGroupId);

        if (activeAudioGroupsRef.current.size === 0) {
          setIsPlayingAudio(false);
        }
      }
    });

    // Activity log handler
    const unsubActivity = ws.on("activity_log", (message) => {
      if (message.type !== "activity_log") return;
      const data = message.payload;

      // Filter out transcription activity logs
      if (data.type === "system" && data.content.includes("Transcribing")) {
        return;
      }

      // Handle tool calls
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

        setMessages((prev) => [
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

      // Handle tool results
      if (data.type === "tool_result" && data.metadata) {
        const { toolCallId, result } = data.metadata as {
          toolCallId: string;
          result: unknown;
        };

        setMessages((prev) =>
          prev.map((msg) =>
            msg.type === "tool_call" && msg.id === toolCallId
              ? { ...msg, result, status: "completed" as const }
              : msg
          )
        );
        return;
      }

      // Handle tool errors
      if (
        data.type === "error" &&
        data.metadata &&
        "toolCallId" in data.metadata
      ) {
        const { toolCallId, error } = data.metadata as {
          toolCallId: string;
          error: unknown;
        };

        setMessages((prev) =>
          prev.map((msg) =>
            msg.type === "tool_call" && msg.id === toolCallId
              ? { ...msg, error, status: "failed" as const }
              : msg
          )
        );
      }

      // Map activity types to message types
      let activityType: "system" | "info" | "success" | "error" = "info";
      if (data.type === "error") activityType = "error";

      // Add user transcripts as user messages
      if (data.type === "transcript") {
        setMessages((prev) => [
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

      // Add assistant messages
      if (data.type === "assistant") {
        setMessages((prev) => [
          ...prev,
          {
            type: "assistant",
            id: generateMessageId(),
            timestamp: Date.now(),
            message: data.content,
          },
        ]);
        setCurrentAssistantMessage("");
        return;
      }

      // Add activity log for other types
      setMessages((prev) => [
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

    // Assistant chunk handler (streaming)
    const unsubChunk = ws.on("assistant_chunk", (message) => {
      if (message.type !== "assistant_chunk") return;
      setCurrentAssistantMessage((prev) => prev + message.payload.chunk);
    });

    // Transcription result handler
    const unsubTranscription = ws.on("transcription_result", (message) => {
      if (message.type !== "transcription_result") return;

      const transcriptText = message.payload.text.trim();

      if (!transcriptText) {
        // Empty transcription - false positive, let playback continue
        console.log("[Session] Empty transcription (false positive) - ignoring");
      } else {
        // Has content - real speech detected, stop playback
        console.log("[Session] Transcription received - stopping playback");
        audioPlayer.stop();
        setIsPlayingAudio(false);
        setCurrentAssistantMessage("");
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
        setProviderModels((prev) => {
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

      setAgents((prev) => {
        if (!prev.has(agentId)) {
          return prev;
        }
        const next = new Map(prev);
        next.delete(agentId);
        return next;
      });

      setAgentStreamState((prev) => {
        if (!prev.has(agentId)) {
          return prev;
        }
        const next = new Map(prev);
        next.delete(agentId);
        return next;
      });

      draftInputsRef.current.delete(agentId);

      setPendingPermissions((prev) => {
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

      setInitializingAgents((prev) => {
        if (!prev.has(agentId)) {
          return prev;
        }
        const next = new Map(prev);
        next.delete(agentId);
        return next;
      });

      setGitDiffs((prev) => {
        if (!prev.has(agentId)) {
          return prev;
        }
        const next = new Map(prev);
        next.delete(agentId);
        return next;
      });

      setFileExplorer((prev) => {
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
  }, [ws, audioPlayer, setIsPlayingAudio, updateExplorerState]);

  const initializeAgent = useCallback(({ agentId, requestId }: { agentId: string; requestId?: string }) => {
    console.log("[Session] initializeAgent called", { agentId, requestId });
    setInitializingAgents((prev) => {
      const next = new Map(prev);
      next.set(agentId, true);
      return next;
    });

    setAgentStreamState((prev) => {
      const next = new Map(prev);
      next.set(agentId, []);
      return next;
    });

    initializeAgentRpc
      .send({ agentId })
      .catch((error) => {
        console.warn("[Session] initializeAgent failed", { agentId, error });
        setInitializingAgents((prev) => {
          const next = new Map(prev);
          next.set(agentId, false);
          return next;
        });
      });
  }, [initializeAgentRpc, setAgentStreamState, setInitializingAgents]);

  const refreshAgent = useCallback(({ agentId, requestId }: { agentId: string; requestId?: string }) => {
    setInitializingAgents((prev) => {
      const next = new Map(prev);
      next.set(agentId, true);
      return next;
    });

    setAgentStreamState((prev) => {
      const next = new Map(prev);
      next.set(agentId, []);
      return next;
    });

    refreshAgentRequest
      .execute({ agentId }, { requestKeyOverride: agentId, dedupe: false })
      .catch((error) => {
        console.warn("[Session] refreshAgent failed", { agentId, error });
        setInitializingAgents((prev) => {
          const next = new Map(prev);
          next.set(agentId, false);
          return next;
        });
      });
  }, [refreshAgentRequest, setAgentStreamState, setInitializingAgents]);

  const requestProviderModels = useCallback((provider: AgentProvider, options?: { cwd?: string }) => {
    const requestId = generateMessageId();
    providerModelRequestIdsRef.current.set(provider, requestId);
    setProviderModels((prev) => {
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
  }, [ws]);

  const sendAgentMessage = useCallback(async (
    agentId: string,
    message: string,
    images?: Array<{ uri: string; mimeType?: string }>
  ) => {
    // Generate unique message ID for deduplication
    const messageId = generateMessageId();

    // Optimistically add user message to stream
    setAgentStreamState((prev) => {
      const currentStream = prev.get(agentId) || [];
      const nextItem: StreamItem = {
        kind: "user_message",
        id: messageId,
        text: message,
        timestamp: new Date(),
      };
      const updated = new Map(prev);
      updated.set(agentId, [...currentStream, nextItem]);
      return updated;
    });

    // Convert images to base64 if provided
    let imagesData: Array<{ data: string; mimeType: string }> | undefined;
    if (images && images.length > 0) {
      const encodedImages = await Promise.all(
        images.map(async ({ uri, mimeType }) => {
          try {
            const data = await FileSystem.readAsStringAsync(uri, {
              encoding: "base64",
            });
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
      if (validImages.length > 0) {
        imagesData = validImages;
      }
    }

    // Send to agent with messageId and optional images
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
  }, [ws]);

  // Auto-flush queued messages when an agent transitions from running -> not running
  useEffect(() => {
    for (const [agentId, agent] of agents.entries()) {
      const prevStatus = previousAgentStatusRef.current.get(agentId);
      if (prevStatus === "running" && agent.status !== "running") {
        const queue = queuedMessages.get(agentId);
        if (queue && queue.length > 0) {
          const [next, ...rest] = queue;
          void sendAgentMessage(agentId, next.text, next.images);
          setQueuedMessages((prev) => {
            const updated = new Map(prev);
            updated.set(agentId, rest);
            return updated;
          });
        }
      }
      previousAgentStatusRef.current.set(agentId, agent.status);
    }
  }, [agents, queuedMessages, sendAgentMessage]);

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
      // Convert blob to base64
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

      // Determine format from MIME type (strip codec metadata)
      const format = deriveFormat(audioBlob.type);

      // Send audio message
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

  const createAgent = useCallback(({ config, initialPrompt, git, worktreeName, requestId }: { config: AgentSessionConfig; initialPrompt: string; git?: GitSetupOptions; worktreeName?: string; requestId?: string }) => {
    const trimmedPrompt = initialPrompt.trim();
    const msg: WSInboundMessage = {
      type: "session",
      message: {
        type: "create_agent_request",
        config,
        ...(trimmedPrompt ? { initialPrompt: trimmedPrompt } : {}),
        ...(git ? { git } : {}),
        ...(worktreeName ? { worktreeName } : {}),
        ...(requestId ? { requestId } : {}),
      },
    };
    ws.send(msg);
  }, [ws]);

  const resumeAgent = useCallback(({ handle, overrides, requestId }: { handle: AgentPersistenceHandle; overrides?: Partial<AgentSessionConfig>; requestId?: string }) => {
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

  const respondToPermission = useCallback((agentId: string, requestId: string, response: AgentPermissionResponse) => {
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
        setGitDiffs((prev) => new Map(prev).set(result.agentId, result.diff));
      })
      .catch((error) => {
        setGitDiffs((prev) => new Map(prev).set(agentId, `Error: ${error.message}`));
      });
  }, [gitDiffRequest, setGitDiffs]);

  const requestDirectoryListing = useCallback((agentId: string, path: string, options?: { recordHistory?: boolean }) => {
    const normalizedPath = path && path.length > 0 ? path : ".";
    const shouldRecordHistory = options?.recordHistory ?? true;

    updateExplorerState(agentId, (state) => ({
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
        updateExplorerState(agentId, (state) => {
          const nextState: AgentFileExplorerState = {
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
        updateExplorerState(agentId, (state) => ({
          ...state,
          isLoading: false,
          lastError: error.message,
          pendingRequest: null,
        }));
      });
  }, [directoryListingRequest, updateExplorerState]);

  const requestFilePreview = useCallback((agentId: string, path: string) => {
    const normalizedPath = path && path.length > 0 ? path : ".";
    updateExplorerState(agentId, (state) => ({
      ...state,
      isLoading: true,
      lastError: null,
      pendingRequest: { path: normalizedPath, mode: "file" },
    }));

    filePreviewRequest
      .execute({ agentId, path: normalizedPath })
      .then((payload) => {
        updateExplorerState(agentId, (state) => {
          const nextState: AgentFileExplorerState = {
            ...state,
            isLoading: false,
            lastError: payload.error ?? null,
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
        updateExplorerState(agentId, (state) => ({
          ...state,
          isLoading: false,
          lastError: error.message,
          pendingRequest: null,
        }));
      });
  }, [filePreviewRequest, updateExplorerState]);

  const navigateExplorerBack = useCallback((agentId: string) => {
    let targetPath: string | null = null;

    updateExplorerState(agentId, (state) => {
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
      };
    });

    if (!targetPath) {
      return null;
    }

    const msg: WSInboundMessage = {
      type: "session",
      message: {
        type: "file_explorer_request",
        agentId,
        path: targetPath,
        mode: "list",
      },
    };
    ws.send(msg);
    return targetPath;
  }, [updateExplorerState, ws]);

  const value = useMemo<SessionContextValue>(
    () => ({
      serverId,
      ws,
      hasHydratedAgents,
      audioPlayer,
      isPlayingAudio,
      setIsPlayingAudio,
      setVoiceDetectionFlags,
      focusedAgentId,
      setFocusedAgentId,
      messages,
      setMessages,
      currentAssistantMessage,
      setCurrentAssistantMessage,
      agentStreamState,
      setAgentStreamState,
      initializingAgents,
      agents,
      setAgents,
      commands,
      setCommands,
      pendingPermissions,
      setPendingPermissions,
      gitDiffs,
      requestGitDiff,
      fileExplorer,
      providerModels,
      requestProviderModels,
      getDraftInput,
      saveDraftInput,
      queuedMessages,
      setQueuedMessages,
      requestDirectoryListing,
      requestFilePreview,
      navigateExplorerBack,
      restartServer,
      initializeAgent,
      refreshAgent,
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
      agentStreamState,
      agents,
      audioPlayer,
      cancelAgentRun,
      commands,
      createAgent,
      currentAssistantMessage,
      deleteAgent,
      fileExplorer,
      focusedAgentId,
      getDraftInput,
      gitDiffs,
      hasHydratedAgents,
      isPlayingAudio,
      initializeAgent,
      initializingAgents,
      messages,
      navigateExplorerBack,
      pendingPermissions,
      providerModels,
      queuedMessages,
      refreshAgent,
      requestDirectoryListing,
      requestFilePreview,
      requestGitDiff,
      requestProviderModels,
      respondToPermission,
      resumeAgent,
      restartServer,
      saveDraftInput,
      sendAgentAudio,
      sendAgentMessage,
      serverId,
      setAgentMode,
      setAgentStreamState,
      setAgents,
      setCommands,
      setCurrentAssistantMessage,
      setFocusedAgentId,
      setIsPlayingAudio,
      setMessages,
      setPendingPermissions,
      setQueuedMessages,
      setVoiceDetectionFlags,
      ws,
    ]
  );

  if (initialSessionValueRef.current === null) {
    initialSessionValueRef.current = value;
  }

  useEffect(() => {
    syncSessionField("focusedAgentId", focusedAgentId);
  }, [focusedAgentId, syncSessionField]);

  useEffect(() => {
    syncSessionPartial({
      serverId,
      ws,
      audioPlayer,
    });
  }, [audioPlayer, serverId, syncSessionPartial, ws]);

  const sessionFunctionBindings = useMemo(
    () => ({
      setIsPlayingAudio,
      setVoiceDetectionFlags,
      setFocusedAgentId,
      setMessages,
      setCurrentAssistantMessage,
      setAgentStreamState,
      setAgents,
      setCommands,
      setPendingPermissions,
      requestGitDiff,
      requestDirectoryListing,
      requestFilePreview,
      navigateExplorerBack,
      requestProviderModels,
      restartServer,
      initializeAgent,
      refreshAgent,
      cancelAgentRun,
      deleteAgent,
      sendAgentMessage,
      sendAgentAudio,
      createAgent,
      resumeAgent,
      setAgentMode,
      respondToPermission,
      getDraftInput,
      saveDraftInput,
      setQueuedMessages,
    }),
    [
      cancelAgentRun,
      createAgent,
      deleteAgent,
      getDraftInput,
      initializeAgent,
      navigateExplorerBack,
      refreshAgent,
      requestDirectoryListing,
      requestFilePreview,
      requestGitDiff,
      requestProviderModels,
      respondToPermission,
      resumeAgent,
      restartServer,
      saveDraftInput,
      sendAgentAudio,
      sendAgentMessage,
      setAgentMode,
      setAgentStreamState,
      setAgents,
      setCommands,
      setCurrentAssistantMessage,
      setFocusedAgentId,
      setIsPlayingAudio,
      setMessages,
      setPendingPermissions,
      setQueuedMessages,
      setVoiceDetectionFlags,
    ]
  );

  useEffect(() => {
    syncSessionPartial(sessionFunctionBindings);
  }, [sessionFunctionBindings, syncSessionPartial]);

  useEffect(() => {
    const initialSnapshot = initialSessionValueRef.current as SessionContextValue;
    const initialPayload = filterSessionStorePayload({
      ...initialSnapshot,
      ...pendingSessionUpdatesRef.current,
    }) as SessionContextValue;
    pendingSessionUpdatesRef.current = {};
    setSession(serverId, initialPayload);
    hasRegisteredSessionRef.current = true;

    return () => {
      hasRegisteredSessionRef.current = false;
      pendingSessionUpdatesRef.current = {};
      clearSession(serverId);
      clearAgentDirectory(serverId);
    };
  }, [clearAgentDirectory, clearSession, serverId, setSession]);

  return (
    <SessionContext.Provider value={value}>
      {children}
    </SessionContext.Provider>
  );
}
