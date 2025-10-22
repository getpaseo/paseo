import { useEffect, useState, useRef } from "react";
import {
  View,
  Pressable,
  Text,
  TextInput,
  Platform,
  KeyboardAvoidingView,
  ScrollView,
  Animated,
} from "react-native";
import { router } from "expo-router";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";
import { theme as defaultTheme } from "../styles/theme";

// Simple unique ID generator
let messageIdCounter = 0;
function generateMessageId(): string {
  return `msg_${Date.now()}_${messageIdCounter++}`;
}
import { useWebSocket } from "@/hooks/use-websocket";
import { useAudioRecorder } from "@/hooks/use-audio-recorder";
import { useAudioPlayer } from "@/hooks/use-audio-player";
import { useSpeechmaticsAudio } from "@/hooks/use-speechmatics-audio";
import { useSettings } from "@/hooks/use-settings";
import { ConnectionStatus } from "@/components/connection-status";
import {
  UserMessage,
  AssistantMessage,
  ActivityLog,
  ToolCall,
} from "@/components/message";
import { ArtifactDrawer, type Artifact } from "@/components/artifact-drawer";
import { ActiveProcesses } from "@/components/active-processes";
import { AgentStreamView } from "@/components/agent-stream-view";
import { ConversationSelector } from "@/components/conversation-selector";
import {
  Settings,
  Mic,
  ArrowUp,
  Square,
  AudioLines,
} from "lucide-react-native";
import type {
  ActivityLogPayload,
  SessionInboundMessage,
  WSInboundMessage,
} from "@server/server/messages";
import type { AgentStatus } from "@server/server/acp/types";
import type { SessionNotification } from "@agentclientprotocol/sdk";

type MessageEntry =
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

type ViewMode = "orchestrator" | "agent";

interface Agent {
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
}

interface Command {
  id: string;
  name: string;
  workingDirectory: string;
  currentCommand: string;
  isDead: boolean;
  exitCode: number | null;
}

interface AgentUpdate {
  timestamp: Date;
  notification: SessionNotification;
}

export default function VoiceAssistantScreen() {
  const { settings, isLoading: settingsLoading } = useSettings();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const ws = useWebSocket(settings.serverUrl, conversationId);

  // Realtime mode state (defined early so we can use it in audioRecorder)
  const [isRealtimeMode, setIsRealtimeMode] = useState(false);
  const pulseAnim = useRef(new Animated.Value(1)).current;

  const audioRecorder = useAudioRecorder();
  const audioPlayer = useAudioPlayer();
  const insets = useSafeAreaInsets();

  // Realtime audio with Speechmatics (echo cancellation)
  const realtimeAudio = useSpeechmaticsAudio({
    onSpeechStart: () => {
      console.log("[App] Speech detected");
      // Stop audio playback if playing
      if (isPlayingAudio) {
        audioPlayer.stop();
      }
    },
    onSpeechEnd: () => {
      console.log("[App] Speech ended");
    },
    onAudioSegment: (base64Audio: string) => {
      console.log("[App] Sending audio segment, length:", base64Audio.length);

      // Send audio segment to server
      try {
        ws.send({
          type: "session",
          message: {
            type: "audio_chunk",
            audio: base64Audio,
            format: "audio/wav",
            isLast: true, // Complete segment
          },
        });
      } catch (error) {
        console.error("[App] Failed to send audio segment:", error);
      }
    },
    onError: (error) => {
      console.error("[App] Realtime audio error:", error);
      setMessages((prev) => [
        ...prev,
        {
          type: "activity",
          id: generateMessageId(),
          timestamp: Date.now(),
          activityType: "error",
          message: `Realtime audio error: ${error.message}`,
        },
      ]);
    },
    volumeThreshold: 0.3,
    silenceDuration: 1000,
    speechConfirmationDuration: 300,
    detectionGracePeriod: 200,
  });

  const [messages, setMessages] = useState<MessageEntry[]>([]);
  const [currentAssistantMessage, setCurrentAssistantMessage] = useState("");
  const [isProcessingAudio, setIsProcessingAudio] = useState(false);
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [userInput, setUserInput] = useState("");

  // Artifact state
  const [artifacts, setArtifacts] = useState<Map<string, Artifact>>(new Map());
  const [currentArtifact, setCurrentArtifact] = useState<Artifact | null>(null);

  // Multi-view navigation state
  const [viewMode, setViewMode] = useState<ViewMode>("orchestrator");
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);

  // Agent and command state
  const [agents, setAgents] = useState<Map<string, Agent>>(new Map());
  const [commands, setCommands] = useState<Map<string, Command>>(new Map());
  const [agentUpdates, setAgentUpdates] = useState<Map<string, AgentUpdate[]>>(
    new Map()
  );

  const scrollViewRef = useRef<ScrollView>(null);

  // Pulse animation for speech indicator
  useEffect(() => {
    if (realtimeAudio.isSpeaking || realtimeAudio.isDetecting) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.3,
            duration: 400,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 400,
            useNativeDriver: true,
          }),
        ])
      ).start();
    } else {
      pulseAnim.stopAnimation();
      pulseAnim.setValue(1);
    }
  }, [realtimeAudio.isSpeaking, realtimeAudio.isDetecting, pulseAnim]);

  // Keep screen awake if setting is enabled (mobile only)
  useEffect(() => {
    if (Platform.OS === "web") return;

    if (settings.keepScreenOn) {
      activateKeepAwakeAsync("voice-assistant");
    } else {
      deactivateKeepAwake("voice-assistant");
    }
  }, [settings.keepScreenOn]);

  // Auto-scroll to bottom when messages update
  useEffect(() => {
    scrollViewRef.current?.scrollToEnd({ animated: true });
  }, [messages, currentAssistantMessage]);

  // WebSocket message handlers
  useEffect(() => {
    // Session state handler - initial agents/commands
    const unsubSessionState = ws.on("session_state", (message) => {
      if (message.type !== "session_state") return;
      const { agents: agentsList, commands: commandsList } = message.payload;

      console.log(
        "[App] Session state received:",
        agentsList.length,
        "agents,",
        commandsList.length,
        "commands"
      );

      // Update agents
      setAgents(new Map(agentsList.map((a) => [a.id, a as Agent])));

      // Update commands
      setCommands(new Map(commandsList.map((c) => [c.id, c as Command])));
    });

    // Agent created handler
    const unsubAgentCreated = ws.on("agent_created", (message) => {
      if (message.type !== "agent_created") return;
      const { agentId, status, type, currentModeId, availableModes } =
        message.payload;

      console.log("[App] Agent created:", agentId);

      const agent: Agent = {
        id: agentId,
        status: status as AgentStatus,
        type,
        createdAt: new Date(),
        currentModeId,
        availableModes,
      };

      setAgents((prev) => new Map(prev).set(agentId, agent));
      setAgentUpdates((prev) => new Map(prev).set(agentId, []));
    });

    // Agent update handler
    const unsubAgentUpdate = ws.on("agent_update", (message) => {
      if (message.type !== "agent_update") return;
      const { agentId, timestamp, notification } = message.payload;

      console.log("[App] Agent update:", agentId);

      setAgentUpdates((prev) => {
        const updated = new Map(prev);
        const updates = updated.get(agentId) || [];
        updated.set(agentId, [
          ...updates,
          {
            timestamp: new Date(timestamp),
            notification,
          },
        ]);
        return updated;
      });
    });

    // Agent status handler
    const unsubAgentStatus = ws.on("agent_status", (message) => {
      if (message.type !== "agent_status") return;
      const { agentId, status, info } = message.payload;

      console.log("[App] Agent status changed:", agentId, status);

      setAgents((prev) => {
        const updated = new Map(prev);
        const agent = updated.get(agentId);
        if (agent) {
          updated.set(agentId, {
            ...agent,
            status: status as AgentStatus,
            sessionId: info.sessionId,
            error: info.error,
          });
        }
        return updated;
      });
    });

    // Activity log handler
    const unsubActivity = ws.on("activity_log", (message) => {
      if (message.type !== "activity_log") return;
      const data = message.payload;

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

      setIsProcessingAudio(false);

      const transcriptText = message.payload.text.trim();

      if (!transcriptText) {
        // Empty transcription - false positive, let playback continue
        console.log("[App] Empty transcription (false positive) - ignoring");
      } else {
        // Has content - real speech detected, stop playback
        console.log("[App] Transcription received - stopping playback");
        audioPlayer.stop();
        setIsPlayingAudio(false);
        setCurrentAssistantMessage("");
      }
    });

    // Audio output handler (TTS)
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

        // Send confirmation back to server (properly typed)
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
        console.error("[App] Audio playback error:", error);
        setMessages((prev) => [
          ...prev,
          {
            type: "activity",
            id: generateMessageId(),
            timestamp: Date.now(),
            activityType: "error",
            message: `Audio playback failed: ${error.message}`,
          },
        ]);
        setIsPlayingAudio(false);
      }
    });

    // Status handler
    const unsubStatus = ws.on("status", (message) => {
      if (message.type !== "status") return;
      const msg =
        "message" in message.payload
          ? String(message.payload.message)
          : `Status: ${message.payload.status}`;

      setMessages((prev) => [
        ...prev,
        {
          type: "activity",
          id: generateMessageId(),
          timestamp: Date.now(),
          activityType: "info",
          message: msg,
        },
      ]);
    });

    // Conversation loaded handler
    const unsubConversationLoaded = ws.on("conversation_loaded", (message) => {
      if (message.type !== "conversation_loaded") return;
      const { conversationId, messageCount } = message.payload;

      setMessages((prev) => [
        ...prev,
        {
          type: "activity",
          id: generateMessageId(),
          timestamp: Date.now(),
          activityType: "success",
          message: `Loaded conversation with ${messageCount} messages`,
        },
      ]);
    });

    // Artifact handler
    const unsubArtifact = ws.on("artifact", (message) => {
      if (message.type !== "artifact") return;
      const artifactData = message.payload;

      console.log(
        "[App] Received artifact:",
        artifactData.id,
        artifactData.type,
        artifactData.title
      );

      // Store artifact
      setArtifacts((prev) => {
        const updated = new Map(prev);
        updated.set(artifactData.id, artifactData);
        return updated;
      });

      // Add artifact entry to chat history
      setMessages((prev) => [
        ...prev,
        {
          type: "artifact",
          id: generateMessageId(),
          timestamp: Date.now(),
          artifactId: artifactData.id,
          artifactType: artifactData.type,
          title: artifactData.title,
        },
      ]);

      // Show drawer immediately
      setCurrentArtifact(artifactData);
    });

    return () => {
      unsubSessionState();
      unsubAgentCreated();
      unsubAgentUpdate();
      unsubAgentStatus();
      unsubActivity();
      unsubChunk();
      unsubTranscription();
      unsubAudioOutput();
      unsubStatus();
      unsubConversationLoaded();
      unsubArtifact();
    };
  }, [ws, audioPlayer]);

  // Connection status handler
  useEffect(() => {
    if (ws.isConnected) {
      setMessages((prev) => [
        ...prev,
        {
          type: "activity",
          id: generateMessageId(),
          timestamp: Date.now(),
          activityType: "success",
          message: "WebSocket connected",
        },
      ]);
    } else if (messages.length > 0) {
      setMessages((prev) => [
        ...prev,
        {
          type: "activity",
          id: generateMessageId(),
          timestamp: Date.now(),
          activityType: "error",
          message: "WebSocket disconnected",
        },
      ]);
    }
  }, [ws.isConnected]);

  // Voice button handler
  async function handleVoicePress() {
    if (!ws.isConnected) return;

    // If recording, stop and send
    if (isRecording) {
      try {
        console.log("[App] Stopping recording...");
        const audioBlob = await audioRecorder.stop();
        setIsRecording(false);

        const format = audioBlob.type || "audio/m4a";
        console.log(
          `[App] Recording complete: ${audioBlob.size} bytes, format: ${format}`
        );

        setIsProcessingAudio(true);
        setMessages((prev) => [
          ...prev,
          {
            type: "activity",
            id: generateMessageId(),
            timestamp: Date.now(),
            activityType: "info",
            message: "Sending audio to server...",
          },
        ]);

        // Convert to base64
        const arrayBuffer = await audioBlob.arrayBuffer();
        const base64Audio = btoa(
          new Uint8Array(arrayBuffer).reduce(
            (data, byte) => data + String.fromCharCode(byte),
            ""
          )
        );

        // Send to server (properly typed)
        const audioMessage: WSInboundMessage = {
          type: "session",
          message: {
            type: "audio_chunk",
            audio: base64Audio,
            format: format,
            isLast: true,
          },
        };
        ws.send(audioMessage);

        console.log(
          `[App] Sent audio: ${audioBlob.size} bytes, format: ${format}`
        );
      } catch (error: any) {
        console.error("[App] Recording error:", error);
        setMessages((prev) => [
          ...prev,
          {
            type: "activity",
            id: generateMessageId(),
            timestamp: Date.now(),
            activityType: "error",
            message: `Failed to record audio: ${error.message}`,
          },
        ]);
        setIsRecording(false);
      }
    } else {
      // Start recording
      try {
        console.log("[App] Starting recording...");

        // Stop any currently playing audio
        audioPlayer.stop();
        setIsPlayingAudio(false);

        await audioRecorder.start();
        setIsRecording(true);
      } catch (error: any) {
        console.error("[App] Failed to start recording:", error);
        setMessages((prev) => [
          ...prev,
          {
            type: "activity",
            id: generateMessageId(),
            timestamp: Date.now(),
            activityType: "error",
            message: `Failed to start recording: ${error.message}`,
          },
        ]);
      }
    }
  }

  // Handle artifact click from activity log
  function handleArtifactClick(artifactId: string) {
    const artifact = artifacts.get(artifactId);
    if (artifact) {
      console.log("[App] Opening artifact:", artifactId);
      setCurrentArtifact(artifact);
    } else {
      console.warn("[App] Artifact not found:", artifactId);
    }
  }

  // Close artifact drawer
  function handleCloseArtifact() {
    setCurrentArtifact(null);
  }

  // Handle agent selection
  function handleSelectAgent(agentId: string) {
    setActiveAgentId(agentId);
    setViewMode("agent");
  }

  // Handle back to orchestrator
  function handleBackToOrchestrator() {
    setActiveAgentId(null);
    setViewMode("orchestrator");
  }

  // Agent control handlers
  function handleKillAgent(agentId: string) {
    console.log("[App] Kill agent:", agentId);
    // TODO: Implement kill agent API call
  }

  function handleCancelAgent(agentId: string) {
    console.log("[App] Cancel agent:", agentId);
    // TODO: Implement cancel agent API call
  }

  // Text message handlers
  function handleSendMessage() {
    if (!userInput.trim() || !ws.isConnected) return;

    // Stop any currently playing audio
    audioPlayer.stop();
    setIsPlayingAudio(false);

    // Send message to server using the hook's method
    ws.sendUserMessage(userInput);

    // Clear input and reset streaming state
    setUserInput("");
    setCurrentAssistantMessage("");
  }

  function handleCancel() {
    console.log("[App] Cancelling operations...");

    // Stop audio playback
    audioPlayer.stop();
    setIsPlayingAudio(false);

    // Clear streaming state
    setCurrentAssistantMessage("");

    // Reset processing state
    setIsProcessingAudio(false);

    // Send abort request to server (properly typed)
    const abortMessage: WSInboundMessage = {
      type: "session",
      message: {
        type: "abort_request",
      },
    };
    ws.send(abortMessage);

    setMessages((prev) => [
      ...prev,
      {
        type: "activity",
        id: generateMessageId(),
        timestamp: Date.now(),
        activityType: "info",
        message: "Operations cancelled",
      },
    ]);
  }

  // Compute if we're processing
  const isInProgress =
    isProcessingAudio || isPlayingAudio || currentAssistantMessage.length > 0;

  function handleButtonClick() {
    if (isRecording) {
      // Stop recording and send the audio
      handleVoicePress();
    } else if (isInProgress) {
      // Cancel processing/playback
      handleCancel();
    } else if (userInput.trim()) {
      // Send text message
      handleSendMessage();
    } else {
      // Start recording
      handleVoicePress();
    }
  }

  // Realtime mode toggle handler
  async function handleRealtimeToggle() {
    const newRealtimeMode = !isRealtimeMode;

    if (newRealtimeMode) {
      // Start realtime mode
      try {
        await realtimeAudio.start();
        setIsRealtimeMode(true);
        console.log("[App] Realtime mode enabled");

        setMessages((prev) => [
          ...prev,
          {
            type: "activity",
            id: generateMessageId(),
            timestamp: Date.now(),
            activityType: "success",
            message: "Realtime mode started - speak anytime!",
          },
        ]);
      } catch (error: any) {
        console.error("[App] Failed to start realtime mode:", error);
        setMessages((prev) => [
          ...prev,
          {
            type: "activity",
            id: generateMessageId(),
            timestamp: Date.now(),
            activityType: "error",
            message: `Failed to start realtime mode: ${error.message}`,
          },
        ]);
      }
    } else {
      // Stop realtime mode
      try {
        await realtimeAudio.stop();
        setIsRealtimeMode(false);
        console.log("[App] Realtime mode disabled");

        setMessages((prev) => [
          ...prev,
          {
            type: "activity",
            id: generateMessageId(),
            timestamp: Date.now(),
            activityType: "info",
            message: "Realtime mode stopped",
          },
        ]);
      } catch (error: any) {
        console.error("[App] Failed to stop realtime mode:", error);
      }
    }
  }

  // Conversation selection handler
  function handleSelectConversation(newConversationId: string | null) {
    // Clear all state
    setMessages([]);
    setCurrentAssistantMessage("");
    setUserInput("");
    setArtifacts(new Map());
    setCurrentArtifact(null);
    setAgents(new Map());
    setCommands(new Map());
    setAgentUpdates(new Map());
    setViewMode("orchestrator");
    setActiveAgentId(null);

    // Stop any ongoing operations
    if (isRecording) {
      audioRecorder.stop().catch(console.error);
      setIsRecording(false);
    }
    audioPlayer.stop();
    setIsPlayingAudio(false);
    setIsProcessingAudio(false);

    // Update conversation ID (will trigger WebSocket reconnection)
    setConversationId(newConversationId);
  }

  // Render agent stream view
  if (viewMode === "agent" && activeAgentId) {
    const agent = agents.get(activeAgentId);
    const updates = agentUpdates.get(activeAgentId) || [];

    if (!agent) {
      return (
        <View style={styles.agentNotFoundContainer}>
          <Text style={styles.agentNotFoundText}>Agent not found</Text>
        </View>
      );
    }

    return (
      <AgentStreamView
        agentId={activeAgentId}
        agent={agent}
        updates={updates}
        onBack={handleBackToOrchestrator}
        onKillAgent={handleKillAgent}
        onCancelAgent={handleCancelAgent}
      />
    );
  }

  // Render orchestrator view (main chat)
  return (
    <KeyboardAvoidingView
      behavior="padding"
      style={styles.container}
      keyboardVerticalOffset={Platform.OS === "ios" ? insets.top : 0}
    >
      {/* Connection status header with buttons */}
      <View style={{ paddingTop: insets.top + 16 }}>
        <View style={styles.headerRow}>
          <View style={styles.headerLeft}>
            <ConnectionStatus isConnected={ws.isConnected} />
          </View>
          <View style={styles.headerRight}>
            <ConversationSelector
              currentConversationId={conversationId}
              onSelectConversation={handleSelectConversation}
              websocket={ws}
            />
            <Pressable
              onPress={() => router.push("/settings")}
              style={styles.settingsButton}
            >
              <Settings size={20} color="white" />
            </Pressable>
          </View>
        </View>
      </View>

      {/* Active processes bar */}
      <ActiveProcesses
        agents={Array.from(agents.values())}
        commands={Array.from(commands.values())}
        activeProcessId={activeAgentId}
        activeProcessType={activeAgentId ? "agent" : null}
        onSelectAgent={handleSelectAgent}
        onBackToOrchestrator={handleBackToOrchestrator}
      />

      {/* Messages */}
      <ScrollView
        ref={scrollViewRef}
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        {messages.map((msg) => {
          if (msg.type === "user") {
            return (
              <UserMessage
                key={msg.id}
                message={msg.message}
                timestamp={msg.timestamp}
              />
            );
          }

          if (msg.type === "assistant") {
            return (
              <AssistantMessage
                key={msg.id}
                message={msg.message}
                timestamp={msg.timestamp}
              />
            );
          }

          if (msg.type === "activity") {
            return (
              <ActivityLog
                key={msg.id}
                type={msg.activityType}
                message={msg.message}
                timestamp={msg.timestamp}
                metadata={msg.metadata}
                onArtifactClick={handleArtifactClick}
              />
            );
          }

          if (msg.type === "artifact") {
            return (
              <ActivityLog
                key={msg.id}
                type="artifact"
                message=""
                timestamp={msg.timestamp}
                artifactId={msg.artifactId}
                artifactType={msg.artifactType}
                title={msg.title}
                onArtifactClick={handleArtifactClick}
              />
            );
          }

          if (msg.type === "tool_call") {
            return (
              <ToolCall
                key={msg.id}
                toolName={msg.toolName}
                args={msg.args}
                result={msg.result}
                error={msg.error}
                status={msg.status}
              />
            );
          }

          return null;
        })}

        {/* Streaming assistant message */}
        {currentAssistantMessage && (
          <AssistantMessage
            message={currentAssistantMessage}
            timestamp={Date.now()}
            isStreaming={true}
          />
        )}
      </ScrollView>

      {/* Input area */}
      <View
        style={[
          styles.inputArea,
          {
            paddingBottom: Math.max(insets.bottom, 32),
          },
        ]}
      >
        {/* Text input */}
        <TextInput
          value={userInput}
          onChangeText={setUserInput}
          placeholder="Say something..."
          placeholderTextColor={defaultTheme.colors.mutedForeground}
          style={styles.textInput}
          multiline
          editable={!isRecording && ws.isConnected}
        />

        {/* Buttons */}
        <View style={styles.buttonRow}>
          {/* Realtime mode button */}
          <Pressable
            onPress={handleRealtimeToggle}
            disabled={!ws.isConnected}
            style={[
              styles.realtimeButton,
              !ws.isConnected && styles.buttonDisabled,
              isRealtimeMode && styles.realtimeButtonActive,
            ]}
          >
            <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
              <AudioLines size={20} color="white" />
            </Animated.View>
          </Pressable>

          {/* Main action button */}
          <Pressable
            onPress={handleButtonClick}
            disabled={!ws.isConnected}
            style={[
              styles.mainButton,
              !ws.isConnected && styles.buttonDisabled,
              isRecording && styles.mainButtonRecording,
              isInProgress && styles.mainButtonInProgress,
              userInput.trim() &&
                !isRecording &&
                !isInProgress &&
                styles.mainButtonWithText,
            ]}
          >
            {isInProgress ? (
              <Square size={18} color="white" fill="white" />
            ) : isRecording ? (
              <Square size={14} color="white" fill="white" />
            ) : userInput.trim() ? (
              <ArrowUp size={20} color="white" />
            ) : (
              <Mic size={20} color="white" />
            )}
          </Pressable>
        </View>
      </View>

      {/* Artifact drawer */}
      <ArtifactDrawer
        artifact={currentArtifact}
        onClose={handleCloseArtifact}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  agentNotFoundContainer: {
    flex: 1,
    backgroundColor: theme.colors.background,
    alignItems: "center",
    justifyContent: "center",
  },
  agentNotFoundText: {
    color: theme.colors.foreground,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[6],
    paddingBottom: theme.spacing[4],
  },
  headerLeft: {
    flex: 1,
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  settingsButton: {
    backgroundColor: theme.colors.muted,
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: theme.spacing[4],
  },
  inputArea: {
    paddingTop: theme.spacing[4],
    paddingHorizontal: theme.spacing[6],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.background,
  },
  textInput: {
    backgroundColor: theme.colors.muted,
    color: theme.colors.foreground,
    borderRadius: theme.borderRadius["2xl"],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    marginBottom: theme.spacing[4],
    maxHeight: 128,
  },
  buttonRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[3],
  },
  realtimeButton: {
    width: 48,
    height: 48,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.muted,
  },
  realtimeButtonActive: {
    backgroundColor: theme.colors.palette.blue[600],
  },
  mainButton: {
    width: 48,
    height: 48,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.secondary,
  },
  mainButtonRecording: {
    backgroundColor: theme.colors.palette.red[500],
  },
  mainButtonInProgress: {
    backgroundColor: theme.colors.palette.red[600],
  },
  mainButtonWithText: {
    backgroundColor: theme.colors.palette.blue[600],
  },
  buttonDisabled: {
    opacity: theme.opacity[50],
  },
}));
