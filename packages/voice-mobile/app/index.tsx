import { useEffect, useState, useRef } from 'react';
import { View, ScrollView, KeyboardAvoidingView, Platform, Pressable, Text, TextInput, Keyboard } from 'react-native';
import { router } from 'expo-router';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Simple unique ID generator
let messageIdCounter = 0;
function generateMessageId(): string {
  return `msg_${Date.now()}_${messageIdCounter++}`;
}
import { useWebSocket } from '@/hooks/use-websocket';
import { useAudioRecorder } from '@/hooks/use-audio-recorder';
import { useAudioPlayer } from '@/hooks/use-audio-player';
import { useSettings } from '@/hooks/use-settings';
import { ConnectionStatus } from '@/components/connection-status';
import { UserMessage, AssistantMessage, ActivityLog, ToolCall } from '@/components/message';
import { ArtifactDrawer, type Artifact } from '@/components/artifact-drawer';
import { ActiveProcesses } from '@/components/active-processes';
import { AgentStreamView } from '@/components/agent-stream-view';
import { ConversationSelector } from '@/components/conversation-selector';
import { MaterialIcons } from '@expo/vector-icons';
import type {
  ActivityLogPayload,
  SessionInboundMessage,
  WSInboundMessage,
} from '@voice-assistant/server/messages';
import type { AgentStatus } from '@voice-assistant/server/acp/types';
import type { SessionNotification } from '@agentclientprotocol/sdk';

type MessageEntry =
  | {
      type: 'user';
      id: string;
      timestamp: number;
      message: string;
    }
  | {
      type: 'assistant';
      id: string;
      timestamp: number;
      message: string;
    }
  | {
      type: 'activity';
      id: string;
      timestamp: number;
      activityType: 'system' | 'info' | 'success' | 'error';
      message: string;
      metadata?: Record<string, unknown>;
    }
  | {
      type: 'tool_call';
      id: string;
      timestamp: number;
      toolName: string;
      args: any;
      result?: any;
      error?: any;
      status: 'executing' | 'completed' | 'failed';
    };

type ViewMode = 'orchestrator' | 'agent';

interface Agent {
  id: string;
  status: AgentStatus;
  createdAt: Date;
  type: 'claude';
  sessionId?: string;
  error?: string;
  currentModeId?: string;
  availableModes?: Array<{ id: string; name: string; description?: string | null }>;
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
  const audioRecorder = useAudioRecorder();
  const audioPlayer = useAudioPlayer({ useSpeaker: settings.useSpeaker });
  const insets = useSafeAreaInsets();

  const [messages, setMessages] = useState<MessageEntry[]>([]);
  const [currentAssistantMessage, setCurrentAssistantMessage] = useState('');
  const [isProcessingAudio, setIsProcessingAudio] = useState(false);
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [userInput, setUserInput] = useState('');

  // Artifact state
  const [artifacts, setArtifacts] = useState<Map<string, Artifact>>(new Map());
  const [currentArtifact, setCurrentArtifact] = useState<Artifact | null>(null);

  // Multi-view navigation state
  const [viewMode, setViewMode] = useState<ViewMode>('orchestrator');
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);

  // Agent and command state
  const [agents, setAgents] = useState<Map<string, Agent>>(new Map());
  const [commands, setCommands] = useState<Map<string, Command>>(new Map());
  const [agentUpdates, setAgentUpdates] = useState<Map<string, AgentUpdate[]>>(new Map());

  const scrollViewRef = useRef<ScrollView>(null);

  // Keep screen awake if setting is enabled
  useEffect(() => {
    if (settings.keepScreenOn) {
      activateKeepAwakeAsync('voice-assistant');
    } else {
      deactivateKeepAwake('voice-assistant');
    }
  }, [settings.keepScreenOn]);

  // Auto-scroll to bottom when messages update
  useEffect(() => {
    scrollViewRef.current?.scrollToEnd({ animated: true });
  }, [messages, currentAssistantMessage]);

  // WebSocket message handlers
  useEffect(() => {
    // Session state handler - initial agents/commands
    const unsubSessionState = ws.on('session_state', (message) => {
      if (message.type !== 'session_state') return;
      const { agents: agentsList, commands: commandsList } = message.payload;

      console.log('[App] Session state received:', agentsList.length, 'agents,', commandsList.length, 'commands');

      // Update agents
      setAgents(new Map(agentsList.map((a) => [a.id, a as Agent])));

      // Update commands
      setCommands(new Map(commandsList.map((c) => [c.id, c as Command])));
    });

    // Agent created handler
    const unsubAgentCreated = ws.on('agent_created', (message) => {
      if (message.type !== 'agent_created') return;
      const { agentId, status, type, currentModeId, availableModes } = message.payload;

      console.log('[App] Agent created:', agentId);

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
    const unsubAgentUpdate = ws.on('agent_update', (message) => {
      if (message.type !== 'agent_update') return;
      const { agentId, timestamp, notification } = message.payload;

      console.log('[App] Agent update:', agentId);

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
    const unsubAgentStatus = ws.on('agent_status', (message) => {
      if (message.type !== 'agent_status') return;
      const { agentId, status, info } = message.payload;

      console.log('[App] Agent status changed:', agentId, status);

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
    const unsubActivity = ws.on('activity_log', (message) => {
      if (message.type !== 'activity_log') return;
      const data = message.payload;

      // Handle tool calls
      if (data.type === 'tool_call' && data.metadata) {
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
            type: 'tool_call',
            id: toolCallId,
            timestamp: Date.now(),
            toolName,
            args,
            status: 'executing',
          },
        ]);
        return;
      }

      // Handle tool results
      if (data.type === 'tool_result' && data.metadata) {
        const { toolCallId, result } = data.metadata as {
          toolCallId: string;
          result: unknown;
        };

        setMessages((prev) =>
          prev.map((msg) =>
            msg.type === 'tool_call' && msg.id === toolCallId
              ? { ...msg, result, status: 'completed' as const }
              : msg
          )
        );
        return;
      }

      // Handle tool errors
      if (
        data.type === 'error' &&
        data.metadata &&
        'toolCallId' in data.metadata
      ) {
        const { toolCallId, error } = data.metadata as {
          toolCallId: string;
          error: unknown;
        };

        setMessages((prev) =>
          prev.map((msg) =>
            msg.type === 'tool_call' && msg.id === toolCallId
              ? { ...msg, error, status: 'failed' as const }
              : msg
          )
        );
      }

      // Map activity types to message types
      let activityType: 'system' | 'info' | 'success' | 'error' = 'info';
      if (data.type === 'error') activityType = 'error';

      // Add user transcripts as user messages
      if (data.type === 'transcript') {
        setMessages((prev) => [
          ...prev,
          {
            type: 'user',
            id: generateMessageId(),
            timestamp: Date.now(),
            message: data.content,
          },
        ]);
        return;
      }

      // Add assistant messages
      if (data.type === 'assistant') {
        setMessages((prev) => [
          ...prev,
          {
            type: 'assistant',
            id: generateMessageId(),
            timestamp: Date.now(),
            message: data.content,
          },
        ]);
        setCurrentAssistantMessage('');
        return;
      }

      // Add activity log for other types
      setMessages((prev) => [
        ...prev,
        {
          type: 'activity',
          id: generateMessageId(),
          timestamp: Date.now(),
          activityType,
          message: data.content,
          metadata: data.metadata,
        },
      ]);
    });

    // Assistant chunk handler (streaming)
    const unsubChunk = ws.on('assistant_chunk', (message) => {
      if (message.type !== 'assistant_chunk') return;
      setCurrentAssistantMessage((prev) => prev + message.payload.chunk);
    });

    // Transcription result handler
    const unsubTranscription = ws.on('transcription_result', (message) => {
      if (message.type !== 'transcription_result') return;

      setIsProcessingAudio(false);

      const transcriptText = message.payload.text.trim();

      if (!transcriptText) {
        // Empty transcription - false positive, resume playback
        console.log('[App] Empty transcription (false positive) - resuming playback');
        audioPlayer.resume();
      } else {
        // Has content - real speech detected, stop playback
        console.log('[App] Transcription received - stopping playback');
        audioPlayer.stop();
        setIsPlayingAudio(false);
        setCurrentAssistantMessage('');
      }
    });

    // Audio output handler (TTS)
    const unsubAudioOutput = ws.on('audio_output', async (message) => {
      if (message.type !== 'audio_output') return;
      const data = message.payload;

      try {
        setIsPlayingAudio(true);

        // Create blob-like object with correct mime type (React Native compatible)
        const mimeType =
          data.format === 'mp3' ? 'audio/mpeg' : `audio/${data.format}`;
        const base64Audio = data.audio;

        // Create a Blob-like object that works in React Native
        const audioBlob = {
          type: mimeType,
          size: Math.ceil(base64Audio.length * 3 / 4), // Approximate size from base64
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
          type: 'session',
          message: {
            type: 'audio_played',
            id: data.id,
          },
        };
        ws.send(confirmMessage);

        setIsPlayingAudio(false);
      } catch (error: any) {
        console.error('[App] Audio playback error:', error);
        setMessages((prev) => [
          ...prev,
          {
            type: 'activity',
            id: generateMessageId(),
            timestamp: Date.now(),
            activityType: 'error',
            message: `Audio playback failed: ${error.message}`,
          },
        ]);
        setIsPlayingAudio(false);
      }
    });

    // Status handler
    const unsubStatus = ws.on('status', (message) => {
      if (message.type !== 'status') return;
      const msg =
        'message' in message.payload
          ? String(message.payload.message)
          : `Status: ${message.payload.status}`;

      setMessages((prev) => [
        ...prev,
        {
          type: 'activity',
          id: generateMessageId(),
          timestamp: Date.now(),
          activityType: 'info',
          message: msg,
        },
      ]);
    });

    // Conversation loaded handler
    const unsubConversationLoaded = ws.on('conversation_loaded', (message) => {
      if (message.type !== 'conversation_loaded') return;
      const { conversationId, messageCount } = message.payload;

      setMessages((prev) => [
        ...prev,
        {
          type: 'activity',
          id: generateMessageId(),
          timestamp: Date.now(),
          activityType: 'success',
          message: `Loaded conversation with ${messageCount} messages`,
        },
      ]);
    });

    // Artifact handler
    const unsubArtifact = ws.on('artifact', (message) => {
      if (message.type !== 'artifact') return;
      const artifactData = message.payload;

      console.log('[App] Received artifact:', artifactData.id, artifactData.type, artifactData.title);

      // Store artifact
      setArtifacts((prev) => {
        const updated = new Map(prev);
        updated.set(artifactData.id, artifactData);
        return updated;
      });

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
          type: 'activity',
          id: generateMessageId(),
          timestamp: Date.now(),
          activityType: 'success',
          message: 'WebSocket connected',
        },
      ]);
    } else if (messages.length > 0) {
      setMessages((prev) => [
        ...prev,
        {
          type: 'activity',
          id: generateMessageId(),
          timestamp: Date.now(),
          activityType: 'error',
          message: 'WebSocket disconnected',
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
        console.log('[App] Stopping recording...');
        const audioBlob = await audioRecorder.stop();
        setIsRecording(false);

        const format = audioBlob.type || 'audio/m4a';
        console.log(
          `[App] Recording complete: ${audioBlob.size} bytes, format: ${format}`
        );

        setIsProcessingAudio(true);
        setMessages((prev) => [
          ...prev,
          {
            type: 'activity',
            id: generateMessageId(),
            timestamp: Date.now(),
            activityType: 'info',
            message: 'Sending audio to server...',
          },
        ]);

        // Convert to base64
        const arrayBuffer = await audioBlob.arrayBuffer();
        const base64Audio = btoa(
          new Uint8Array(arrayBuffer).reduce(
            (data, byte) => data + String.fromCharCode(byte),
            ''
          )
        );

        // Send to server (properly typed)
        const audioMessage: WSInboundMessage = {
          type: 'session',
          message: {
            type: 'audio_chunk',
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
        console.error('[App] Recording error:', error);
        setMessages((prev) => [
          ...prev,
          {
            type: 'activity',
            id: generateMessageId(),
            timestamp: Date.now(),
            activityType: 'error',
            message: `Failed to record audio: ${error.message}`,
          },
        ]);
        setIsRecording(false);
      }
    } else {
      // Start recording
      try {
        console.log('[App] Starting recording...');

        // Stop any currently playing audio
        audioPlayer.stop();
        setIsPlayingAudio(false);

        await audioRecorder.start();
        setIsRecording(true);
      } catch (error: any) {
        console.error('[App] Failed to start recording:', error);
        setMessages((prev) => [
          ...prev,
          {
            type: 'activity',
            id: generateMessageId(),
            timestamp: Date.now(),
            activityType: 'error',
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
      console.log('[App] Opening artifact:', artifactId);
      setCurrentArtifact(artifact);
    } else {
      console.warn('[App] Artifact not found:', artifactId);
    }
  }

  // Close artifact drawer
  function handleCloseArtifact() {
    setCurrentArtifact(null);
  }

  // Handle agent selection
  function handleSelectAgent(agentId: string) {
    setActiveAgentId(agentId);
    setViewMode('agent');
  }

  // Handle back to orchestrator
  function handleBackToOrchestrator() {
    setActiveAgentId(null);
    setViewMode('orchestrator');
  }

  // Agent control handlers
  function handleKillAgent(agentId: string) {
    console.log('[App] Kill agent:', agentId);
    // TODO: Implement kill agent API call
  }

  function handleCancelAgent(agentId: string) {
    console.log('[App] Cancel agent:', agentId);
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
    setUserInput('');
    setCurrentAssistantMessage('');
    Keyboard.dismiss();
  }

  function handleCancel() {
    console.log('[App] Cancelling operations...');

    // Stop audio playback
    audioPlayer.stop();
    setIsPlayingAudio(false);

    // Clear streaming state
    setCurrentAssistantMessage('');

    // Reset processing state
    setIsProcessingAudio(false);

    // Send abort request to server (properly typed)
    const abortMessage: WSInboundMessage = {
      type: 'session',
      message: {
        type: 'abort_request',
      },
    };
    ws.send(abortMessage);

    setMessages((prev) => [
      ...prev,
      {
        type: 'activity',
        id: generateMessageId(),
        timestamp: Date.now(),
        activityType: 'info',
        message: 'Operations cancelled',
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

  // Conversation selection handler
  function handleSelectConversation(newConversationId: string | null) {
    // Clear all state
    setMessages([]);
    setCurrentAssistantMessage('');
    setUserInput('');
    setArtifacts(new Map());
    setCurrentArtifact(null);
    setAgents(new Map());
    setCommands(new Map());
    setAgentUpdates(new Map());
    setViewMode('orchestrator');
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
  if (viewMode === 'agent' && activeAgentId) {
    const agent = agents.get(activeAgentId);
    const updates = agentUpdates.get(activeAgentId) || [];

    if (!agent) {
      return (
        <View className="flex-1 bg-black items-center justify-center">
          <Text className="text-white">Agent not found</Text>
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
      className="flex-1 bg-black"
    >
      <View className="flex-1">
        {/* Connection status header with buttons */}
        <View style={{ paddingTop: insets.top + 16 }}>
          <View className="flex-row items-center justify-between px-6 pb-4">
            <View className="flex-1">
              <ConnectionStatus isConnected={ws.isConnected} />
            </View>
            <View className="flex-row items-center gap-2">
              <ConversationSelector
                currentConversationId={conversationId}
                onSelectConversation={handleSelectConversation}
                websocket={ws}
              />
              <Pressable
                onPress={() => router.push('/settings')}
                className="bg-zinc-800 p-3 rounded-lg"
              >
                <MaterialIcons name="settings" size={20} color="white" />
              </Pressable>
            </View>
          </View>
        </View>

        {/* Active processes bar */}
        <ActiveProcesses
          agents={Array.from(agents.values())}
          commands={Array.from(commands.values())}
          activeProcessId={activeAgentId}
          activeProcessType={activeAgentId ? 'agent' : null}
          onSelectAgent={handleSelectAgent}
          onBackToOrchestrator={handleBackToOrchestrator}
        />

        {/* Messages */}
        <ScrollView
          ref={scrollViewRef}
          className="flex-1"
          contentContainerClassName="pb-4"
        >
          {messages.map((msg) => {
            if (msg.type === 'user') {
              return (
                <UserMessage
                  key={msg.id}
                  message={msg.message}
                  timestamp={msg.timestamp}
                />
              );
            }

            if (msg.type === 'assistant') {
              return (
                <AssistantMessage
                  key={msg.id}
                  message={msg.message}
                  timestamp={msg.timestamp}
                />
              );
            }

            if (msg.type === 'activity') {
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

            if (msg.type === 'tool_call') {
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
        <View className="pt-4 px-6 border-t border-zinc-800" style={{ paddingBottom: Math.max(insets.bottom, 32) }}>
          {/* Text input */}
          <TextInput
            value={userInput}
            onChangeText={setUserInput}
            placeholder="Say something..."
            placeholderTextColor="#71717a"
            className="bg-zinc-800 text-white rounded-2xl px-4 py-3 mb-4 max-h-32"
            multiline
            editable={!isRecording && ws.isConnected}
          />

          {/* Buttons */}
          <View className="flex-row items-center justify-center gap-4">
            {/* Realtime mode button (placeholder) */}
            <Pressable
              disabled={true}
              className="w-16 h-16 rounded-full bg-zinc-800 items-center justify-center opacity-50"
            >
              <View className="w-8 h-8 items-center justify-center">
                <View className="w-6 h-6 rounded-full border-2 border-white" />
                <View className="absolute w-3 h-3 rounded-full border-2 border-white" />
              </View>
            </Pressable>

            {/* Main action button */}
            <Pressable
              onPress={handleButtonClick}
              disabled={!ws.isConnected}
              className={`w-20 h-20 rounded-full items-center justify-center ${
                !ws.isConnected ? 'opacity-50' : 'opacity-100'
              } ${
                isRecording
                  ? 'bg-red-500'
                  : isInProgress
                  ? 'bg-red-600'
                  : userInput.trim()
                  ? 'bg-blue-600'
                  : 'bg-zinc-700'
              }`}
            >
              {isInProgress ? (
                <View className="relative w-6 h-6">
                  <View className="absolute w-6 h-0.5 bg-white rotate-45" style={{top: 11}} />
                  <View className="absolute w-6 h-0.5 bg-white -rotate-45" style={{top: 11}} />
                </View>
              ) : isRecording ? (
                <View className="w-4 h-4 bg-white rounded-full" />
              ) : userInput.trim() ? (
                <Text className="text-white text-xl">▶</Text>
              ) : (
                <View className="w-6 h-8 relative">
                  <View className="absolute bottom-0 left-1/2 -ml-2 w-4 h-6 bg-white rounded-t-full" />
                  <View className="absolute bottom-0 left-1/2 -ml-3 w-6 h-1.5 bg-white rounded-full" />
                </View>
              )}
            </Pressable>
          </View>
        </View>

        {/* Artifact drawer */}
        <ArtifactDrawer
          artifact={currentArtifact}
          onClose={handleCloseArtifact}
        />
      </View>
    </KeyboardAvoidingView>
  );
}
