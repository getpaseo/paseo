import { createContext, useContext, useState, useRef, ReactNode, useCallback, useEffect } from "react";
import { useWebSocket, type UseWebSocketReturn } from "@/hooks/use-websocket";
import { useAudioPlayer } from "@/hooks/use-audio-player";
import { reduceStreamUpdate, generateMessageId, type StreamItem } from "@/types/stream";
import type {
  ActivityLogPayload,
  SessionInboundMessage,
  WSInboundMessage,
} from "@server/server/messages";
import type { AgentStatus, AgentUpdate, AgentNotification } from "@server/server/acp/types";
import { parseSessionUpdate } from "@/types/agent-activity";
import { ScrollView } from "react-native";

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
  status: AgentStatus;
  createdAt: Date;
  type: "claude";
  sessionId?: string;
  error?: string;
  currentModeId?: string;
  availableModes?: Array<{
    id: string;
    name: string;
    description?: string | null;
  }>;
  title?: string;
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

export interface PendingPermission {
  agentId: string;
  requestId: string;
  sessionId: string;
  toolCall: any;
  options: Array<{
    kind: string;
    name: string;
    optionId: string;
  }>;
}

interface SessionContextValue {
  // WebSocket
  ws: UseWebSocketReturn;

  // Audio
  audioPlayer: ReturnType<typeof useAudioPlayer>;
  isPlayingAudio: boolean;
  setIsPlayingAudio: (playing: boolean) => void;

  // Messages and stream state
  messages: MessageEntry[];
  setMessages: (messages: MessageEntry[] | ((prev: MessageEntry[]) => MessageEntry[])) => void;
  currentAssistantMessage: string;
  setCurrentAssistantMessage: (message: string) => void;
  agentStreamState: Map<string, StreamItem[]>;
  setAgentStreamState: (state: Map<string, StreamItem[]> | ((prev: Map<string, StreamItem[]>) => Map<string, StreamItem[]>)) => void;

  // Agents and commands
  agents: Map<string, Agent>;
  setAgents: (agents: Map<string, Agent> | ((prev: Map<string, Agent>) => Map<string, Agent>)) => void;
  commands: Map<string, Command>;
  setCommands: (commands: Map<string, Command> | ((prev: Map<string, Command>) => Map<string, Command>)) => void;
  agentUpdates: Map<string, AgentUpdate[]>;
  setAgentUpdates: (updates: Map<string, AgentUpdate[]> | ((prev: Map<string, AgentUpdate[]>) => Map<string, AgentUpdate[]>)) => void;

  // Permissions
  pendingPermissions: Map<string, PendingPermission>;
  setPendingPermissions: (perms: Map<string, PendingPermission> | ((prev: Map<string, PendingPermission>) => Map<string, PendingPermission>)) => void;

  // Helpers
  sendAgentMessage: (agentId: string, message: string) => void;
  createAgent: (options: { cwd: string; initialMode?: string; requestId?: string }) => void;
  setAgentMode: (agentId: string, modeId: string) => void;
  respondToPermission: (requestId: string, agentId: string, sessionId: string, selectedOptionIds: string[]) => void;
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
  const audioPlayer = useAudioPlayer();

  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const [messages, setMessages] = useState<MessageEntry[]>([]);
  const [currentAssistantMessage, setCurrentAssistantMessage] = useState("");
  const [agentStreamState, setAgentStreamState] = useState<Map<string, StreamItem[]>>(new Map());

  const [agents, setAgents] = useState<Map<string, Agent>>(new Map());
  const [commands, setCommands] = useState<Map<string, Command>>(new Map());
  const [agentUpdates, setAgentUpdates] = useState<Map<string, AgentUpdate[]>>(new Map());
  const [pendingPermissions, setPendingPermissions] = useState<Map<string, PendingPermission>>(new Map());

  // WebSocket message handlers
  useEffect(() => {
    // Session state - initial agents/commands
    const unsubSessionState = ws.on("session_state", (message) => {
      if (message.type !== "session_state") return;
      const { agents: agentsList, commands: commandsList } = message.payload;

      console.log("[Session] Session state:", agentsList.length, "agents,", commandsList.length, "commands");

      setAgents(new Map(agentsList.map((a) => [a.id, {
        ...a,
        createdAt: new Date(a.createdAt),
      } as Agent])));

      setCommands(new Map(commandsList.map((c) => [c.id, c as Command])));
    });

    // Agent created
    const unsubAgentCreated = ws.on("agent_created", (message) => {
      if (message.type !== "agent_created") return;
      const { agentId, status, type, currentModeId, availableModes, title, cwd } = message.payload;

      console.log("[Session] Agent created:", agentId);

      const agent: Agent = {
        id: agentId,
        status: status as AgentStatus,
        type,
        createdAt: new Date(),
        title,
        cwd,
        currentModeId,
        availableModes,
      };

      setAgents((prev) => new Map(prev).set(agentId, agent));
      setAgentStreamState((prev) => new Map(prev).set(agentId, []));
    });

    // Agent status update (mode changes, title changes, etc.)
    const unsubAgentStatus = ws.on("agent_status", (message) => {
      if (message.type !== "agent_status") return;
      const { agentId, info } = message.payload;

      console.log("[Session] Agent status update:", agentId, "mode:", info.currentModeId);

      setAgents((prev) => {
        const existingAgent = prev.get(agentId);
        if (!existingAgent) return prev;

        const updatedAgent: Agent = {
          ...existingAgent,
          status: info.status as AgentStatus,
          sessionId: info.sessionId,
          error: info.error,
          currentModeId: info.currentModeId,
          availableModes: info.availableModes,
          title: info.title,
          cwd: info.cwd,
        };

        return new Map(prev).set(agentId, updatedAgent);
      });
    });

    // Agent update
    const unsubAgentUpdate = ws.on("agent_update", (message) => {
      if (message.type !== "agent_update") return;
      const { agentId, notification } = message.payload;

      const update: AgentUpdate = {
        agentId,
        timestamp: new Date(),
        notification,
      };

      setAgentUpdates((prev) => {
        const agentHistory = prev.get(agentId) || [];
        return new Map(prev).set(agentId, [...agentHistory, update]);
      });

      // Update stream state using reducer
      setAgentStreamState((prev) => {
        const currentStream = prev.get(agentId) || [];
        const newStream = reduceStreamUpdate(currentStream, notification, new Date());
        return new Map(prev).set(agentId, newStream);
      });
    });

    // Permission request
    const unsubPermissionRequest = ws.on("agent_permission_request", (message) => {
      if (message.type !== "agent_permission_request") return;
      const { agentId, requestId, sessionId, toolCall, options } = message.payload;

      console.log("[Session] Permission request:", requestId, "for agent:", agentId);

      setPendingPermissions((prev) => new Map(prev).set(requestId, {
        agentId,
        requestId,
        sessionId,
        toolCall,
        options,
      }));
    });

    // Audio output
    const unsubAudioOutput = ws.on("audio_output", async (message) => {
      if (message.type !== "audio_output") return;
      const data = message.payload;

      try {
        setIsPlayingAudio(true);

        // Create blob-like object with correct mime type (React Native compatible)
        const mimeType =
          data.format === "mp3" ? "audio/mpeg" : `audio/${data.format}`;
        const base64Audio = data.audio;

        // Create a Blob-like object that works in React Native
        const audioBlob = {
          type: mimeType,
          size: Math.ceil((base64Audio.length * 3) / 4), // Approximate size from base64
          arrayBuffer: async () => {
            // Convert base64 to ArrayBuffer
            const binaryString = atob(base64Audio);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
              bytes[i] = binaryString.charCodeAt(i);
            }
            return bytes.buffer;
          },
        } as Blob;

        // Play audio
        await audioPlayer.play(audioBlob);

        // Send confirmation back to server
        const confirmMessage: WSInboundMessage = {
          type: "session",
          message: {
            type: "audio_played",
            id: data.id,
          },
        };
        ws.send(confirmMessage);

        setIsPlayingAudio(false);
      } catch (error: any) {
        console.error("[Session] Audio playback error:", error);
        setIsPlayingAudio(false);

        // Still send confirmation even on error to prevent server from waiting
        const confirmMessage: WSInboundMessage = {
          type: "session",
          message: {
            type: "audio_played",
            id: data.id,
          },
        };
        ws.send(confirmMessage);
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

    return () => {
      unsubSessionState();
      unsubAgentCreated();
      unsubAgentStatus();
      unsubAgentUpdate();
      unsubPermissionRequest();
      unsubAudioOutput();
      unsubActivity();
      unsubChunk();
      unsubTranscription();
    };
  }, [ws, audioPlayer, setIsPlayingAudio]);

  const sendAgentMessage = useCallback((agentId: string, message: string) => {
    // Generate unique message ID for deduplication
    const messageId = generateMessageId();

    // Optimistically add user message to stream
    setAgentStreamState((prev) => {
      const currentStream = prev.get(agentId) || [];

      // Create AgentNotification structure that matches server format
      const notification: AgentNotification = {
        type: 'session',
        notification: {
          sessionId: '',
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: 'text', text: message },
            messageId,
          },
        },
      };

      // Use reduceStreamUpdate to properly create the StreamItem
      const newStream = reduceStreamUpdate(currentStream, notification, new Date());

      const updated = new Map(prev);
      updated.set(agentId, newStream);
      return updated;
    });

    // Send to agent with messageId
    const msg: WSInboundMessage = {
      type: "session",
      message: {
        type: "send_agent_message",
        agentId,
        text: message,
        messageId,
      },
    };
    ws.send(msg);
  }, [ws]);

  const createAgent = useCallback((options: { cwd: string; initialMode?: string; requestId?: string }) => {
    const msg: WSInboundMessage = {
      type: "session",
      message: {
        type: "create_agent_request",
        ...options,
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

  const respondToPermission = useCallback((
    requestId: string,
    agentId: string,
    sessionId: string,
    selectedOptionIds: string[]
  ) => {
    const msg: WSInboundMessage = {
      type: "session",
      message: {
        type: "agent_permission_response",
        agentId,
        requestId,
        optionId: selectedOptionIds[0],
      },
    };
    ws.send(msg);

    // Remove from pending
    setPendingPermissions((prev) => {
      const next = new Map(prev);
      next.delete(requestId);
      return next;
    });
  }, [ws]);

  const value: SessionContextValue = {
    ws,
    audioPlayer,
    isPlayingAudio,
    setIsPlayingAudio,
    messages,
    setMessages,
    currentAssistantMessage,
    setCurrentAssistantMessage,
    agentStreamState,
    setAgentStreamState,
    agents,
    setAgents,
    commands,
    setCommands,
    agentUpdates,
    setAgentUpdates,
    pendingPermissions,
    setPendingPermissions,
    sendAgentMessage,
    createAgent,
    setAgentMode,
    respondToPermission,
  };

  return (
    <SessionContext.Provider value={value}>
      {children}
    </SessionContext.Provider>
  );
}
