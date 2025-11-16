import { createContext, useContext, useState, useRef, ReactNode, useCallback, useEffect } from "react";
import { useWebSocket, type UseWebSocketReturn } from "@/hooks/use-websocket";
import { useAudioPlayer } from "@/hooks/use-audio-player";
import { reduceStreamUpdate, generateMessageId, hydrateStreamState, type StreamItem } from "@/types/stream";
import type { PendingPermission } from "@/types/shared";
import type {
  ActivityLogPayload,
  AgentSnapshotPayload,
  AgentStreamEventPayload,
  SessionInboundMessage,
  WSInboundMessage,
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
  AgentUsage,
  AgentPersistenceHandle,
} from "@server/server/agent/agent-sdk-types";
import { ScrollView } from "react-native";
import * as FileSystem from 'expo-file-system';

const derivePendingPermissionKey = (agentId: string, request: AgentPermissionRequest) => {
  const fallbackId =
    request.id ||
    (typeof request.metadata?.id === "string" ? request.metadata.id : undefined) ||
    request.name ||
    request.title ||
    `${request.kind}:${JSON.stringify(request.input ?? request.metadata ?? request.raw ?? {})}`;

  return `${agentId}:${fallbackId}`;
};

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

export interface Agent {
  id: string;
  provider: AgentProvider;
  status: AgentLifecycleStatus;
  createdAt: Date;
  updatedAt: Date;
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
}

const createExplorerState = (): AgentFileExplorerState => ({
  directories: new Map(),
  files: new Map(),
  isLoading: false,
  lastError: null,
  pendingRequest: null,
  currentPath: ".",
});

function normalizeAgentSnapshot(snapshot: AgentSnapshotPayload): Agent {
  const createdAt = new Date(snapshot.createdAt);
  const updatedAt = new Date(snapshot.updatedAt);
  return {
    id: snapshot.id,
    provider: snapshot.provider,
    status: snapshot.status as AgentLifecycleStatus,
    createdAt,
    updatedAt,
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
  };
}


interface SessionContextValue {
  // WebSocket
  ws: UseWebSocketReturn;

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
  setCurrentAssistantMessage: (message: string) => void;
  agentStreamState: Map<string, StreamItem[]>;
  setAgentStreamState: (state: Map<string, StreamItem[]> | ((prev: Map<string, StreamItem[]>) => Map<string, StreamItem[]>)) => void;
  initializingAgents: Map<string, boolean>;

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
  requestDirectoryListing: (agentId: string, path: string) => void;
  requestFilePreview: (agentId: string, path: string) => void;

  // Helpers
  initializeAgent: (params: { agentId: string; requestId?: string }) => void;
  refreshAgent: (params: { agentId: string; requestId?: string }) => void;
  cancelAgentRun: (agentId: string) => void;
  sendAgentMessage: (agentId: string, message: string, imageUris?: string[]) => Promise<void>;
  sendAgentAudio: (agentId: string, audioBlob: Blob, requestId?: string) => Promise<void>;
  deleteAgent: (agentId: string) => void;
  createAgent: (options: { config: AgentSessionConfig; worktreeName?: string; requestId?: string }) => void;
  resumeAgent: (options: { handle: AgentPersistenceHandle; overrides?: Partial<AgentSessionConfig>; requestId?: string }) => void;
  setAgentMode: (agentId: string, modeId: string) => void;
  respondToPermission: (agentId: string, requestId: string, response: AgentPermissionResponse) => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function useSession() {
  const context = useContext(SessionContext);
  if (!context) {
    throw new Error("useSession must be used within SessionProvider");
  }
  return context;
}

interface SessionProviderProps {
  children: ReactNode;
  serverUrl: string;
}

export function SessionProvider({ children, serverUrl }: SessionProviderProps) {
  const ws = useWebSocket(serverUrl);
  
  // State for voice detection flags (will be set by RealtimeContext)
  const isDetectingRef = useRef(false);
  const isSpeakingRef = useRef(false);
  
  const audioPlayer = useAudioPlayer({
    isDetecting: () => isDetectingRef.current,
    isSpeaking: () => isSpeakingRef.current,
  });

  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const [focusedAgentOverride, setFocusedAgentOverride] = useState<string | null>(null);
  const [orchestratorFocusedAgentId, setOrchestratorFocusedAgentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageEntry[]>([]);
  const [currentAssistantMessage, setCurrentAssistantMessage] = useState("");
  const [agentStreamState, setAgentStreamState] = useState<Map<string, StreamItem[]>>(new Map());
  const [initializingAgents, setInitializingAgents] = useState<Map<string, boolean>>(new Map());

  const [agents, setAgents] = useState<Map<string, Agent>>(new Map());
  const [commands, setCommands] = useState<Map<string, Command>>(new Map());
  const [pendingPermissions, setPendingPermissions] = useState<Map<string, PendingPermission>>(new Map());
  const [gitDiffs, setGitDiffs] = useState<Map<string, string>>(new Map());
  const [fileExplorer, setFileExplorer] = useState<Map<string, AgentFileExplorerState>>(new Map());
  const activeAudioGroupsRef = useRef<Set<string>>(new Set());

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

  // WebSocket message handlers
  useEffect(() => {
    // Session state - initial agents/commands
    const unsubSessionState = ws.on("session_state", (message) => {
      if (message.type !== "session_state") return;
      const { agents: agentsList, commands: commandsList } = message.payload;

      console.log("[Session] Session state:", agentsList.length, "agents,", commandsList.length, "commands");

      const nextAgents = new Map<string, Agent>();
      const nextPermissions = new Map<string, PendingPermission>();

      for (const snapshot of agentsList) {
        const agent = normalizeAgentSnapshot(snapshot);
        nextAgents.set(agent.id, agent);
        for (const request of agent.pendingPermissions) {
          const key = derivePendingPermissionKey(agent.id, request);
          nextPermissions.set(key, { key, agentId: agent.id, request });
        }
      }

      setAgents(nextAgents);
      setPendingPermissions(nextPermissions);
      setCommands(new Map(commandsList.map((c) => [c.id, c as Command])));
      setAgentStreamState(() => {
        const next = new Map<string, StreamItem[]>();
        for (const snapshot of agentsList) {
          next.set(snapshot.id, []);
        }
        return next;
      });
      setInitializingAgents(new Map());
    });

    const unsubAgentState = ws.on("agent_state", (message) => {
      if (message.type !== "agent_state") return;
      const snapshot = message.payload;
      const agent = normalizeAgentSnapshot(snapshot);

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

    // Git diff response handler
    const unsubGitDiff = ws.on("git_diff_response", (message) => {
      if (message.type !== "git_diff_response") return;
      const { agentId, diff, error } = message.payload;

      console.log("[Session] Git diff response for agent:", agentId, error ? `(error: ${error})` : "");

      if (error) {
        console.error("[Session] Git diff error:", error);
        setGitDiffs((prev) => new Map(prev).set(agentId, `Error: ${error}`));
      } else {
        setGitDiffs((prev) => new Map(prev).set(agentId, diff || ""));
      }
    });

    const unsubFileExplorer = ws.on("file_explorer_response", (message) => {
      if (message.type !== "file_explorer_response") {
        return;
      }
      const { agentId, directory, file, mode, error } = message.payload;

      console.log(
        "[Session] File explorer response for agent:",
        agentId,
        mode,
        error ? `(error: ${error})` : ""
      );

      updateExplorerState(agentId, (state) => {
        const nextState: AgentFileExplorerState = {
          ...state,
          isLoading: false,
          lastError: error ?? null,
          pendingRequest: null,
          directories: state.directories,
          files: state.files,
        };

        if (!error) {
          if (mode === "list" && directory) {
            const directories = new Map(state.directories);
            directories.set(directory.path, directory);
            nextState.directories = directories;
          }

          if (mode === "file" && file) {
            const files = new Map(state.files);
            files.set(file.path, file);
            nextState.files = files;
          }
        }

        return nextState;
      });
    });

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
      unsubGitDiff();
      unsubFileExplorer();
      unsubAgentDeleted();
    };
  }, [ws, audioPlayer, setIsPlayingAudio, updateExplorerState]);

  const initializeAgent = useCallback(({ agentId, requestId }: { agentId: string; requestId?: string }) => {
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

    const msg: WSInboundMessage = {
      type: "session",
      message: {
        type: "initialize_agent_request",
        agentId,
        requestId,
      },
    };
    ws.send(msg);
  }, [ws]);

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

    const msg: WSInboundMessage = {
      type: "session",
      message: {
        type: "refresh_agent_request",
        agentId,
        requestId,
      },
    };
    ws.send(msg);
  }, [ws]);

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

  const sendAgentMessage = useCallback(async (agentId: string, message: string, imageUris?: string[]) => {
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
    if (imageUris && imageUris.length > 0) {
      imagesData = [];
      for (const imageUri of imageUris) {
        try {
          // Use FileSystem.File to read the image as base64
          const file = new FileSystem.File(imageUri);
          const base64 = file.base64Sync();
          
          // Get MIME type from the file
          const mimeType = file.type || 'image/jpeg';
          
          imagesData.push({
            data: base64,
            mimeType,
          });
        } catch (error) {
          console.error('[Session] Failed to convert image:', error);
        }
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

  const sendAgentAudio = useCallback(async (agentId: string, audioBlob: Blob, requestId?: string) => {
    try {
      // Convert blob to base64
      const arrayBuffer = await audioBlob.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64Audio = btoa(binary);

      // Determine format from MIME type
      const format = audioBlob.type.split('/')[1] || 'm4a';

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
        },
      };
      ws.send(msg);

      console.log("[Session] Sent audio to agent:", agentId, format, audioBlob.size, "bytes", requestId ? `(requestId: ${requestId})` : "");
    } catch (error) {
      console.error("[Session] Failed to send audio:", error);
      throw error;
    }
  }, [ws]);

  const createAgent = useCallback(({ config, worktreeName, requestId }: { config: AgentSessionConfig; worktreeName?: string; requestId?: string }) => {
    const msg: WSInboundMessage = {
      type: "session",
      message: {
        type: "create_agent_request",
        config,
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
    const msg: WSInboundMessage = {
      type: "session",
      message: {
        type: "git_diff_request",
        agentId,
      },
    };
    ws.send(msg);
  }, [ws]);

  const requestDirectoryListing = useCallback((agentId: string, path: string) => {
    const normalizedPath = path && path.length > 0 ? path : ".";
    updateExplorerState(agentId, (state) => ({
      ...state,
      isLoading: true,
      lastError: null,
      pendingRequest: { path: normalizedPath, mode: "list" },
      currentPath: normalizedPath,
    }));

    const msg: WSInboundMessage = {
      type: "session",
      message: {
        type: "file_explorer_request",
        agentId,
        path: normalizedPath,
        mode: "list",
      },
    };
    ws.send(msg);
  }, [updateExplorerState, ws]);

  const requestFilePreview = useCallback((agentId: string, path: string) => {
    const normalizedPath = path && path.length > 0 ? path : ".";
    updateExplorerState(agentId, (state) => ({
      ...state,
      isLoading: true,
      lastError: null,
      pendingRequest: { path: normalizedPath, mode: "file" },
    }));

    const msg: WSInboundMessage = {
      type: "session",
      message: {
        type: "file_explorer_request",
        agentId,
        path: normalizedPath,
        mode: "file",
      },
    };
    ws.send(msg);
  }, [updateExplorerState, ws]);

  const value: SessionContextValue = {
    ws,
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
    requestDirectoryListing,
    requestFilePreview,
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
  };

  return (
    <SessionContext.Provider value={value}>
      {children}
    </SessionContext.Provider>
  );
}
