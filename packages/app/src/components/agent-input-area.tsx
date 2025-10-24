import { View, TextInput, Pressable } from "react-native";
import { useState, useEffect } from "react";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Mic, ArrowUp, AudioLines, Square } from "lucide-react-native";
import { useSession } from "@/contexts/session-context";
import { useRealtime } from "@/contexts/realtime-context";
import { useAudioRecorder } from "@/hooks/use-audio-recorder";
import Animated, {
  useAnimatedStyle,
  withTiming,
  useSharedValue,
} from "react-native-reanimated";

interface AgentInputAreaProps {
  agentId: string;
  isRealtimeMode: boolean;
}

export function AgentInputArea({ agentId, isRealtimeMode }: AgentInputAreaProps) {
  const { theme } = useUnistyles();
  const { ws, sendAgentMessage, sendAgentAudio } = useSession();
  const { startRealtime } = useRealtime();
  const audioRecorder = useAudioRecorder();

  const [userInput, setUserInput] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  // Animated opacity for smooth transitions
  const opacity = useSharedValue(isRealtimeMode ? 0 : 1);

  useEffect(() => {
    opacity.value = withTiming(isRealtimeMode ? 0 : 1, { duration: 250 });
  }, [isRealtimeMode]);

  const animatedStyle = useAnimatedStyle(() => {
    return {
      opacity: opacity.value,
      // When hidden, disable pointer events so GlobalFooter's controls are interactive
      pointerEvents: opacity.value < 0.5 ? ("none" as const) : ("auto" as const),
    };
  });

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

  const hasText = userInput.trim().length > 0;

  return (
    <Animated.View style={[styles.container, animatedStyle]}>
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
    </Animated.View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[4],
    gap: theme.spacing[3],
    height: 88,
  },
  textInput: {
    flex: 1,
    minHeight: 40,
    maxHeight: 80,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.muted,
    borderRadius: theme.borderRadius.lg,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  buttonRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
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
