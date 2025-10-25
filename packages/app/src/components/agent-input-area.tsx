import {
  View,
  TextInput,
  Pressable,
  NativeSyntheticEvent,
  TextInputContentSizeChangeEventData,
} from "react-native";
import { useState } from "react";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Mic, ArrowUp, AudioLines, Square } from "lucide-react-native";
import { useSession } from "@/contexts/session-context";
import { useRealtime } from "@/contexts/realtime-context";
import { useAudioRecorder } from "@/hooks/use-audio-recorder";

interface AgentInputAreaProps {
  agentId: string;
}

const MIN_INPUT_HEIGHT = 40;
const MAX_INPUT_HEIGHT = 160;

export function AgentInputArea({ agentId }: AgentInputAreaProps) {
  const { theme } = useUnistyles();
  const { ws, sendAgentMessage, sendAgentAudio } = useSession();
  const { startRealtime } = useRealtime();
  const audioRecorder = useAudioRecorder();

  const [userInput, setUserInput] = useState("");
  const [inputHeight, setInputHeight] = useState(MIN_INPUT_HEIGHT);
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  async function handleSendMessage() {
    if (!userInput.trim() || !ws.isConnected) return;

    const message = userInput.trim();
    setUserInput("");
    setInputHeight(MIN_INPUT_HEIGHT);
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

  function handleContentSizeChange(
    event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>,
  ) {
    const contentHeight = event.nativeEvent.contentSize.height;
    const boundedHeight = Math.min(
      MAX_INPUT_HEIGHT,
      Math.max(MIN_INPUT_HEIGHT, contentHeight),
    );

    setInputHeight((currentHeight) => {
      if (Math.abs(currentHeight - boundedHeight) < 1) {
        return currentHeight;
      }

      return boundedHeight;
    });
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
        style={[
          styles.textInput,
          { height: inputHeight, minHeight: MIN_INPUT_HEIGHT, maxHeight: MAX_INPUT_HEIGHT },
        ]}
        multiline
        scrollEnabled={inputHeight >= MAX_INPUT_HEIGHT}
        onContentSizeChange={handleContentSizeChange}
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
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[4],
    gap: theme.spacing[3],
    minHeight: 88,
  },
  textInput: {
    flex: 1,
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
