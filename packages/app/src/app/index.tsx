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
  Keyboard,
} from "react-native";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import ReanimatedAnimated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { router } from "expo-router";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
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
import { VolumeMeter } from "@/components/volume-meter";
import {
  Settings,
  Mic,
  ArrowUp,
  Square,
  AudioLines,
  MicOff,
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

interface RealtimeCircleProps {
  volume: number;
  onClose: () => void;
}

function RealtimeCircle({ volume, onClose }: RealtimeCircleProps) {
  const { theme } = useUnistyles();

  // Base size for the circles
  const BASE_SIZE = 80;
  const MIN_SCALE = 1;
  const MAX_SCALE = 1.8;

  // Create animated value for volume-based scaling
  const volumeScale = useSharedValue(MIN_SCALE);
  const pulseScale = useSharedValue(1);

  // Update volume scale when volume changes
  useEffect(() => {
    // Map volume (0-1) to scale range (MIN_SCALE - MAX_SCALE)
    const targetScale = MIN_SCALE + (volume * (MAX_SCALE - MIN_SCALE));
    volumeScale.value = withSpring(targetScale, {
      damping: 15,
      stiffness: 150,
    });
  }, [volume]);

  // Continuous pulsating animation for outer circle
  useEffect(() => {
    pulseScale.value = withRepeat(
      withSequence(
        withTiming(1.3, { duration: 1000 }),
        withTiming(1, { duration: 1000 })
      ),
      -1,
      false
    );
  }, []);

  // Animated style for inner circle (volume reactive)
  const innerCircleStyle = useAnimatedStyle(() => ({
    width: BASE_SIZE,
    height: BASE_SIZE,
    borderRadius: BASE_SIZE / 2,
    transform: [{ scale: volumeScale.value }],
  }));

  // Animated style for outer circle (continuous pulse)
  const outerCircleStyle = useAnimatedStyle(() => ({
    width: BASE_SIZE * 1.5,
    height: BASE_SIZE * 1.5,
    borderRadius: (BASE_SIZE * 1.5) / 2,
    transform: [{ scale: pulseScale.value }],
    opacity: 0.3,
  }));

  return (
    <Pressable
      onPress={onClose}
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <View style={{ position: "relative", alignItems: "center", justifyContent: "center" }}>
        {/* Outer pulsating circle */}
        <ReanimatedAnimated.View
          style={[
            outerCircleStyle,
            {
              position: "absolute",
              backgroundColor: theme.colors.palette.blue[600],
            },
          ]}
        />

        {/* Inner volume-reactive circle */}
        <ReanimatedAnimated.View
          style={[
            innerCircleStyle,
            {
              backgroundColor: theme.colors.palette.blue[600],
            },
          ]}
        />
      </View>
    </Pressable>
  );
}

export default function VoiceAssistantScreen() {
  const { settings, isLoading: settingsLoading } = useSettings();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const ws = useWebSocket(settings.serverUrl, conversationId);

  // Realtime mode state (defined early so we can use it in audioRecorder)
  const [isRealtimeMode, setIsRealtimeMode] = useState(false);
  const isRealtimeModeRef = useRef(isRealtimeMode);
  const pulseAnim = useRef(new Animated.Value(1)).current;

  // Keep ref in sync with state
  useEffect(() => {
    isRealtimeModeRef.current = isRealtimeMode;
  }, [isRealtimeMode]);

  const insets = useSafeAreaInsets();
  const audioRecorder = useAudioRecorder();
  const audioPlayer = useAudioPlayer();

  // Keyboard animation
  const { height: keyboardHeight } = useReanimatedKeyboardAnimation();
  const bottomInset = insets.bottom;
  const animatedKeyboardStyle = useAnimatedStyle(() => {
    "worklet";
    const absoluteHeight = Math.abs(keyboardHeight.value);
    const padding = Math.max(0, absoluteHeight - bottomInset);
    return {
      paddingBottom: padding,
    };
  });

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
    silenceDuration: 2000,
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

      const currentIsRealtimeMode = isRealtimeModeRef.current;

      // Drift protection: Don't play audio generated in different mode
      if (data.isRealtimeMode !== currentIsRealtimeMode) {
        console.log(
          `[App] Skipping audio playback due to mode drift (generated in ${data.isRealtimeMode ? "realtime" : "normal"} mode, currently in ${currentIsRealtimeMode ? "realtime" : "normal"} mode)`
        );

        // Still send confirmation to prevent server from waiting
        const confirmMessage: WSInboundMessage = {
          type: "session",
          message: {
            type: "audio_played",
            id: data.id,
          },
        };
        ws.send(confirmMessage);
        return;
      }

      // Additional check: Don't play if NOT in realtime mode (shouldn't happen with server-side fix, but defense in depth)
      if (!currentIsRealtimeMode) {
        console.log("[App] Skipping audio playback - not in realtime mode");

        // Still send confirmation
        const confirmMessage: WSInboundMessage = {
          type: "session",
          message: {
            type: "audio_played",
            id: data.id,
          },
        };
        ws.send(confirmMessage);
        return;
      }

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
      // Don't show message in UI
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

        // Notify server of mode change
        const modeMessage: WSInboundMessage = {
          type: "session",
          message: {
            type: "set_realtime_mode",
            enabled: true,
          },
        };
        ws.send(modeMessage);

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

        // Notify server of mode change
        const modeMessage: WSInboundMessage = {
          type: "session",
          message: {
            type: "set_realtime_mode",
            enabled: false,
          },
        };
        ws.send(modeMessage);

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
    <View style={styles.container}>
      {/* Fixed Header */}
      <View style={styles.header}>
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
      </View>

      {/* Content Area with Keyboard Handling */}
      <ReanimatedAnimated.View
        style={[styles.contentArea, animatedKeyboardStyle]}
      >
        {/* Scrollable Messages Area */}
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

        {/* Fixed Footer */}
        <View
          style={[
            styles.inputAreaWrapper,
            { paddingBottom: Math.max(insets.bottom, 8) },
          ]}
        >
          {isRealtimeMode ? (
            // Realtime mode - show volume meter and mute button
            <View style={[styles.inputArea, { minHeight: 200 }]}>
              <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
                <VolumeMeter
                  volume={realtimeAudio.volume}
                  isMuted={realtimeAudio.isMuted}
                  isDetecting={realtimeAudio.isDetecting}
                  isSpeaking={realtimeAudio.isSpeaking}
                />
                {/* Debug timer */}
                {(realtimeAudio.isDetecting || realtimeAudio.isSpeaking) && (
                  <Text style={styles.debugTimer}>
                    {(realtimeAudio.segmentDuration / 1000).toFixed(1)}s
                  </Text>
                )}
              </View>
              <View style={styles.realtimeModeButtons}>
                {/* Mute button */}
                <Pressable
                  onPress={() => realtimeAudio.toggleMute()}
                  style={[
                    styles.realtimeMuteButton,
                    realtimeAudio.isMuted && styles.realtimeMuteButtonActive,
                  ]}
                >
                  <MicOff
                    size={20}
                    color={
                      realtimeAudio.isMuted
                        ? defaultTheme.colors.background
                        : defaultTheme.colors.foreground
                    }
                  />
                </Pressable>
                {/* Close button */}
                <Pressable
                  onPress={handleRealtimeToggle}
                  style={styles.realtimeCloseButton}
                >
                  <Square size={18} color="white" fill="white" />
                </Pressable>
              </View>
            </View>
          ) : (
            // Normal mode - show text input and buttons
            <View style={styles.inputArea}>
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
                {userInput.trim().length > 0 ? (
                  // Send button when text is entered
                  <Pressable
                    onPress={handleSendMessage}
                    disabled={!ws.isConnected || isInProgress}
                    style={[
                      styles.sendButton,
                      !ws.isConnected && styles.buttonDisabled,
                    ]}
                  >
                    <ArrowUp size={20} color="white" />
                  </Pressable>
                ) : (
                  // Record and Realtime buttons when no text
                  <>
                    {/* Main action button */}
                    <Pressable
                      onPress={handleButtonClick}
                      disabled={!ws.isConnected}
                      style={[
                        styles.mainButton,
                        !ws.isConnected && styles.buttonDisabled,
                        isRecording && styles.mainButtonRecording,
                        isInProgress && styles.mainButtonInProgress,
                      ]}
                    >
                      {isInProgress ? (
                        <Square size={18} color="white" fill="white" />
                      ) : isRecording ? (
                        <Square size={14} color="white" fill="white" />
                      ) : (
                        <Mic size={20} color={defaultTheme.colors.foreground} />
                      )}
                    </Pressable>

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
                        <AudioLines
                          size={20}
                          color={
                            isRealtimeMode
                              ? defaultTheme.colors.accentForeground
                              : defaultTheme.colors.background
                          }
                        />
                      </Animated.View>
                    </Pressable>
                  </>
                )}
              </View>
            </View>
          )}
        </View>
      </ReanimatedAnimated.View>

      {/* Artifact drawer */}
      <ArtifactDrawer
        artifact={currentArtifact}
        onClose={handleCloseArtifact}
      />
    </View>
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
  header: {
    backgroundColor: theme.colors.background,
  },
  contentArea: {
    flex: 1,
    minHeight: 0,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[6],
    paddingBottom: theme.spacing[4],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
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
    minHeight: 0,
  },
  scrollContent: {
    paddingBottom: theme.spacing[4],
    flexGrow: 1,
  },
  inputAreaWrapper: {
    borderTopRightRadius: theme.borderRadius["2xl"],
    borderTopLeftRadius: theme.borderRadius["2xl"],
    paddingTop: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.muted,
  },
  inputArea: {
    borderRadius: theme.borderRadius["2xl"],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[3],
  },
  textInput: {
    backgroundColor: "transparent",
    color: theme.colors.foreground,
    paddingHorizontal: 0,
    paddingVertical: 0,
    fontSize: theme.fontSize.lg,
    marginBottom: theme.spacing[3],
    maxHeight: 128,
  },
  buttonRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    marginBottom: theme.spacing[1],
  },
  realtimeButton: {
    width: 40,
    height: 40,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.accentForeground,
  },
  realtimeButtonActive: {
    backgroundColor: theme.colors.foreground,
  },
  mainButton: {
    width: 40,
    height: 40,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
  },
  mainButtonRecording: {
    backgroundColor: theme.colors.palette.red[500],
  },
  sendButton: {
    width: 40,
    height: 40,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.palette.blue[600],
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
  realtimeModeButtons: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    paddingTop: theme.spacing[4],
  },
  realtimeMuteButton: {
    width: 48,
    height: 48,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.muted,
    borderWidth: theme.borderWidth[2],
    borderColor: theme.colors.border,
  },
  realtimeMuteButtonActive: {
    backgroundColor: theme.colors.palette.red[500],
    borderColor: theme.colors.palette.red[600],
  },
  realtimeCloseButton: {
    width: 48,
    height: 48,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.palette.red[600],
  },
  debugTimer: {
    marginTop: theme.spacing[2],
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.sm,
    fontFamily: "monospace",
  },
}));
