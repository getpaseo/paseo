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
  createAgent: (options: { cwd: string; autoStart?: boolean }) => void;
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

    return () => {
      unsubSessionState();
      unsubAgentCreated();
      unsubAgentStatus();
      unsubAgentUpdate();
      unsubPermissionRequest();
    };
  }, [ws]);

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

  const createAgent = useCallback((options: { cwd: string; autoStart?: boolean }) => {
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
