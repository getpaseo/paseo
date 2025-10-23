import { View, TextInput, Pressable, Text } from "react-native";
import { useState } from "react";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Mic, ArrowUp, AudioLines, Square, ChevronDown } from "lucide-react-native";
import { useSession } from "@/contexts/session-context";
import { useRealtime } from "@/contexts/realtime-context";
import { useAudioRecorder } from "@/hooks/use-audio-recorder";
import { ModeSelectorModal } from "./mode-selector-modal";

interface AgentInputAreaProps {
  agentId: string;
}

export function AgentInputArea({ agentId }: AgentInputAreaProps) {
  const { theme } = useUnistyles();
  const { agents, ws, sendAgentMessage, sendAgentAudio, setAgentMode } = useSession();
  const { isRealtimeMode, startRealtime } = useRealtime();
  const audioRecorder = useAudioRecorder();

  const [userInput, setUserInput] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [showModeSelector, setShowModeSelector] = useState(false);

  const agent = agents.get(agentId);

  // Hide when realtime is active - global footer takes over
  if (isRealtimeMode) {
    return null;
  }

  async function handleSendMessage() {
    if (!userInput.trim() || !ws.isConnected) return;

    const message = userInput.trim();
    setUserInput("");
    setIsProcessing(true);

    try {
      sendAgentMessage(agentId, message);
    } catch (error) {
      console.error("[AgentInput] Failed to send message:", error);
    } finally {
      setIsProcessing(false);
    }
  }

  async function handleVoicePress() {
    if (isRecording) {
      // Stop recording
      try {
        setIsRecording(false);
        const audioData = await audioRecorder.stop();

        if (audioData) {
          setIsProcessing(true);
          console.log("[AgentInput] Audio recorded:", audioData.size, "bytes");

          try {
            // Send audio to agent for transcription and processing
            await sendAgentAudio(agentId, audioData);
            console.log("[AgentInput] Audio sent to agent");
          } catch (error) {
            console.error("[AgentInput] Failed to send audio:", error);
          } finally {
            setIsProcessing(false);
          }
        }
      } catch (error) {
        console.error("[AgentInput] Failed to stop recording:", error);
        setIsRecording(false);
        setIsProcessing(false);
      }
    } else {
      // Start recording
      try {
        await audioRecorder.start();
        setIsRecording(true);
      } catch (error) {
        console.error("[AgentInput] Failed to start recording:", error);
      }
    }
  }

  function handleModeChange(modeId: string) {
    setAgentMode(agentId, modeId);
  }

  const hasText = userInput.trim().length > 0;

  return (
    <View style={styles.container}>
      {/* Text input */}
      <TextInput
        value={userInput}
        onChangeText={setUserInput}
        placeholder="Message agent..."
        placeholderTextColor={theme.colors.mutedForeground}
        style={styles.textInput}
        multiline
        editable={!isRecording && ws.isConnected}
      />

      {/* Controls row */}
      <View style={styles.controlsRow}>
        {/* Mode badge - only show if agent has modes */}
        {agent && agent.availableModes && agent.availableModes.length > 0 && (
          <Pressable
            onPress={() => setShowModeSelector(true)}
            style={({ pressed }) => [
              styles.modeBadge,
              pressed && styles.modeBadgePressed,
            ]}
          >
            <Text style={styles.modeBadgeText}>
              {agent.availableModes?.find(m => m.id === agent.currentModeId)?.name || agent.currentModeId || 'default'}
            </Text>
            <ChevronDown size={14} color={theme.colors.mutedForeground} />
          </Pressable>
        )}

        {/* Buttons */}
        <View style={styles.buttonRow}>
          {hasText ? (
            // Send button when text is entered
            <Pressable
              onPress={handleSendMessage}
              disabled={!ws.isConnected || isProcessing}
              style={[
                styles.sendButton,
                (!ws.isConnected || isProcessing) && styles.buttonDisabled,
              ]}
            >
              <ArrowUp size={20} color="white" />
            </Pressable>
          ) : (
            // Voice and Realtime buttons when no text
            <>
              {/* Voice recording button */}
              <Pressable
                onPress={handleVoicePress}
                disabled={!ws.isConnected}
                style={[
                  styles.voiceButton,
                  !ws.isConnected && styles.buttonDisabled,
                  isRecording && styles.voiceButtonRecording,
                ]}
              >
                {isRecording ? (
                  <Square size={14} color="white" fill="white" />
                ) : (
                  <Mic size={20} color={theme.colors.foreground} />
                )}
              </Pressable>

              {/* Realtime button */}
              <Pressable
                onPress={startRealtime}
                disabled={!ws.isConnected}
                style={[
                  styles.realtimeButton,
                  !ws.isConnected && styles.buttonDisabled,
                ]}
              >
                <AudioLines size={20} color={theme.colors.background} />
              </Pressable>
            </>
          )}
        </View>
      </View>

      {/* Mode selector modal */}
      <ModeSelectorModal
        visible={showModeSelector}
        agent={agent || null}
        onModeChange={handleModeChange}
        onClose={() => setShowModeSelector(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  textInput: {
    minHeight: 44,
    maxHeight: 120,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    backgroundColor: theme.colors.muted,
    borderRadius: theme.borderRadius.lg,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  controlsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  modeBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.muted,
    borderRadius: theme.borderRadius.full,
  },
  modeBadgePressed: {
    backgroundColor: theme.colors.accent,
  },
  modeBadgeText: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    textTransform: "capitalize",
  },
  buttonRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginLeft: "auto",
  },
  sendButton: {
    width: 40,
    height: 40,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.palette.blue[600],
    alignItems: "center",
    justifyContent: "center",
  },
  voiceButton: {
    width: 40,
    height: 40,
    borderRadius: theme.borderRadius.full,
    backgroundColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
  },
  voiceButtonRecording: {
    backgroundColor: theme.colors.destructive,
  },
  realtimeButton: {
    width: 40,
    height: 40,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accentForeground,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonDisabled: {
    opacity: 0.5,
  },
}));
