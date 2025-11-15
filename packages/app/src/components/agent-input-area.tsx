import {
  View,
  TextInput,
  Pressable,
  NativeSyntheticEvent,
  TextInputContentSizeChangeEventData,
  Image,
  Platform,
  Text,
} from "react-native";
import { useState, useEffect, useRef } from "react";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Mic, ArrowUp, AudioLines, Square, Paperclip, X } from "lucide-react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  FadeIn,
  FadeOut,
} from "react-native-reanimated";
import { useSession } from "@/contexts/session-context";
import { useRealtime } from "@/contexts/realtime-context";
import { useAudioRecorder } from "@/hooks/use-audio-recorder";
import { FOOTER_HEIGHT } from "@/contexts/footer-controls-context";
import { VoiceNoteRecordingOverlay } from "./voice-note-recording-overlay";
import { generateMessageId } from "@/types/stream";
import { AgentStatusBar } from "./agent-status-bar";
import { RealtimeControls } from "./realtime-controls";
import { useImageAttachmentPicker } from "@/hooks/use-image-attachment-picker";

interface AgentInputAreaProps {
  agentId: string;
}

const MIN_INPUT_HEIGHT = 40;
const MAX_INPUT_HEIGHT = 160;
const BASE_VERTICAL_PADDING = (FOOTER_HEIGHT - MIN_INPUT_HEIGHT) / 2;
// Android currently crashes inside ViewGroup.dispatchDraw when running Reanimated
// entering/exiting animations (see react-native-reanimated#8422), so guard them.
const SHOULD_DISABLE_ENTRY_EXIT_ANIMATIONS = Platform.OS === "android";
const REALTIME_FADE_IN = SHOULD_DISABLE_ENTRY_EXIT_ANIMATIONS ? undefined : FadeIn.duration(250);
const REALTIME_FADE_OUT = SHOULD_DISABLE_ENTRY_EXIT_ANIMATIONS ? undefined : FadeOut.duration(250);

export function AgentInputArea({ agentId }: AgentInputAreaProps) {
  const { theme } = useUnistyles();
  const { ws, sendAgentMessage, sendAgentAudio, agents, cancelAgentRun } = useSession();
  const { startRealtime, stopRealtime, isRealtimeMode } = useRealtime();
  
  const [userInput, setUserInput] = useState("");
  const [inputHeight, setInputHeight] = useState(MIN_INPUT_HEIGHT);
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [selectedImages, setSelectedImages] = useState<Array<{ uri: string; mimeType: string }>>([]);
  const [recordingVolume, setRecordingVolume] = useState(0);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [transcribingRequestId, setTranscribingRequestId] = useState<string | null>(null);
  
  const recordingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const overlayTransition = useSharedValue(0);
  const { pickImages } = useImageAttachmentPicker();
  
  const audioRecorder = useAudioRecorder({
    onAudioLevel: (level) => {
      setRecordingVolume(level);
    },
  });

  async function handleSendMessage() {
    if (!userInput.trim() || !ws.isConnected) return;

    const message = userInput.trim();
    const imageUris = selectedImages.length > 0 ? selectedImages.map(img => img.uri) : undefined;
    
    setUserInput("");
    setSelectedImages([]);
    setInputHeight(MIN_INPUT_HEIGHT);
    setIsProcessing(true);

    try {
      await sendAgentMessage(agentId, message, imageUris);
    } catch (error) {
      console.error("[AgentInput] Failed to send message:", error);
    } finally {
      setIsProcessing(false);
    }
  }

  async function handlePickImage() {
    const result = await pickImages();
    if (!result?.assets?.length) {
      return;
    }

    const newImages = result.assets.map(asset => ({
      uri: asset.uri,
      mimeType: asset.mimeType || "image/jpeg",
    }));
    setSelectedImages(prev => [...prev, ...newImages]);
  }

  function handleRemoveImage(index: number) {
    setSelectedImages(prev => prev.filter((_, i) => i !== index));
  }

  async function handleVoicePress() {
    if (isRecording) {
      // This shouldn't happen as button is hidden when recording
      return;
    }
    if (isRealtimeMode) {
      return;
    }
    
    // Start recording
    try {
      await audioRecorder.start();
      setIsRecording(true);
      setRecordingDuration(0);
      overlayTransition.value = withTiming(1, { duration: 250 });
      
      // Start duration timer
      recordingIntervalRef.current = setInterval(() => {
        setRecordingDuration((prev) => prev + 1);
      }, 1000);
    } catch (error) {
      console.error("[AgentInput] Failed to start recording:", error);
    }
  }

  async function handleCancelRecording() {
    try {
      // Stop recording without sending
      await audioRecorder.stop();
      setIsRecording(false);
      overlayTransition.value = withTiming(0, { duration: 250 });
      
      // Clear timer
      if (recordingIntervalRef.current) {
        clearInterval(recordingIntervalRef.current);
        recordingIntervalRef.current = null;
      }
      setRecordingDuration(0);
      setRecordingVolume(0);
    } catch (error) {
      console.error("[AgentInput] Failed to cancel recording:", error);
      setIsRecording(false);
      overlayTransition.value = withTiming(0, { duration: 250 });
    }
  }

  async function handleSendRecording() {
    try {
      const audioData = await audioRecorder.stop();
      setIsRecording(false);
      
      // Clear timer
      if (recordingIntervalRef.current) {
        clearInterval(recordingIntervalRef.current);
        recordingIntervalRef.current = null;
      }
      setRecordingDuration(0);
      setRecordingVolume(0);

      if (audioData) {
        // Generate request ID for tracking transcription
        const requestId = generateMessageId();
        setTranscribingRequestId(requestId);
        console.log("[AgentInput] Audio recorded:", audioData.size, "bytes", "requestId:", requestId);

        try {
          // Send audio to agent for transcription and processing
          await sendAgentAudio(agentId, audioData, requestId);
          console.log("[AgentInput] Audio sent to agent");
        } catch (error) {
          console.error("[AgentInput] Failed to send audio:", error);
          // Clear transcribing state on error
          setTranscribingRequestId(null);
          overlayTransition.value = withTiming(0, { duration: 250 });
        }
      } else {
        // No audio data, dismiss overlay immediately
        overlayTransition.value = withTiming(0, { duration: 250 });
      }
    } catch (error) {
      console.error("[AgentInput] Failed to stop recording:", error);
      setIsRecording(false);
      setTranscribingRequestId(null);
      overlayTransition.value = withTiming(0, { duration: 250 });
    }
  }

  // Listen for transcription completion
  useEffect(() => {
    if (!transcribingRequestId) return;

    const unsubscribe = ws.on("transcription_result", (message) => {
      if (message.type !== "transcription_result") return;
      
      // Check if this transcription result matches our request
      if (message.payload.requestId === transcribingRequestId) {
        console.log("[AgentInput] Transcription completed for requestId:", transcribingRequestId);
        setTranscribingRequestId(null);
        overlayTransition.value = withTiming(0, { duration: 250 });
      }
    });

    return () => {
      unsubscribe();
    };
  }, [transcribingRequestId, ws, overlayTransition]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (recordingIntervalRef.current) {
        clearInterval(recordingIntervalRef.current);
      }
    };
  }, []);

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

  const agent = agents.get(agentId);
  const isAgentRunning = agent?.status === "running";
  const hasText = userInput.trim().length > 0;
  const hasImages = selectedImages.length > 0;
  const hasSendableContent = hasText || hasImages;
  const shouldShowSendButton = !isAgentRunning && hasSendableContent;
  const shouldShowDictateButton = !isAgentRunning && !hasSendableContent;

  const overlayAnimatedStyle = useAnimatedStyle(() => {
    return {
      transform: [{ translateY: (1 - overlayTransition.value) * FOOTER_HEIGHT }],
      opacity: overlayTransition.value,
      pointerEvents: overlayTransition.value > 0.5 ? ("auto" as const) : ("none" as const),
    };
  });

  const inputAnimatedStyle = useAnimatedStyle(() => {
    return {
      opacity: 1 - overlayTransition.value,
      pointerEvents: overlayTransition.value < 0.5 ? ("auto" as const) : ("none" as const),
    };
  });

  async function handleRealtimePress() {
    try {
      if (isRealtimeMode) {
        await stopRealtime();
      } else {
        if (!ws.isConnected) {
          return;
        }
        await startRealtime();
      }
    } catch (error) {
      console.error("[AgentInput] Failed to toggle realtime mode:", error);
    }
  }

  function handleCancelAgent() {
    if (!agent || agent.status !== "running") {
      return;
    }
    if (!ws.isConnected) {
      return;
    }
    cancelAgentRun(agentId);
  }

  const realtimeButton = (
    <Pressable
      onPress={handleRealtimePress}
      disabled={!ws.isConnected && !isRealtimeMode}
      style={[
        styles.realtimeButton,
        isRealtimeMode && styles.realtimeButtonActive,
        (!ws.isConnected && !isRealtimeMode) && styles.buttonDisabled,
      ]}
    >
      {isRealtimeMode ? (
        <Square size={18} color={theme.colors.background} fill={theme.colors.background} />
      ) : (
        <AudioLines size={20} color={theme.colors.background} />
      )}
    </Pressable>
  );

  return (
    <View style={styles.container}>
      {/* Border separator */}
      <View style={styles.borderSeparator} />

      {/* Realtime controls - only when active */}
      {isRealtimeMode && (
        <Animated.View
          style={styles.realtimeControlsContainer}
          entering={REALTIME_FADE_IN}
          exiting={REALTIME_FADE_OUT}
        >
          <RealtimeControls />
        </Animated.View>
      )}

      {/* Input area */}
      <View style={styles.inputAreaContainer}>
        {/* Regular input controls */}
        <Animated.View style={[styles.inputContainer, inputAnimatedStyle]}>
          {/* Image preview pills */}
          {hasImages && (
            <View style={styles.imagePreviewContainer}>
              {selectedImages.map((image, index) => (
                <View key={`${image.uri}-${index}`} style={styles.imagePill}>
                  <Image source={{ uri: image.uri }} style={styles.imageThumbnail} />
                  <Pressable onPress={() => handleRemoveImage(index)} style={styles.removeImageButton}>
                    <X size={16} color={theme.colors.foreground} />
                  </Pressable>
                </View>
              ))}
            </View>
          )}

          {/* Full-width text input */}
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

          {/* Button row below input */}
          <View style={styles.buttonRow}>
            {/* Left button group */}
            <View style={styles.leftButtonGroup}>
              <Pressable
                onPress={handlePickImage}
                disabled={!ws.isConnected}
                style={[
                  styles.attachButton,
                  !ws.isConnected && styles.buttonDisabled,
                ]}
              >
                <Paperclip size={20} color={theme.colors.foreground} />
              </Pressable>
              <AgentStatusBar agentId={agentId} />
            </View>

            {/* Right button group */}
            <View style={styles.rightButtonGroup}>
              {isAgentRunning ? (
                <>
                  {realtimeButton}
                  <Pressable
                    onPress={handleCancelAgent}
                    disabled={!ws.isConnected}
                    style={[
                      styles.cancelButton,
                      !ws.isConnected && styles.buttonDisabled,
                    ]}
                  >
                    <Text style={styles.cancelButtonText}>Cancel</Text>
                  </Pressable>
                </>
              ) : shouldShowSendButton ? (
                <>
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
                  {realtimeButton}
                </>
              ) : shouldShowDictateButton ? (
                <>
                  <Pressable
                    onPress={handleVoicePress}
                    disabled={!ws.isConnected || isRealtimeMode}
                    style={[
                      styles.voiceButton,
                      (!ws.isConnected || isRealtimeMode) && styles.buttonDisabled,
                      isRecording && styles.voiceButtonRecording,
                    ]}
                  >
                    {isRecording ? (
                      <Square size={14} color="white" fill="white" />
                    ) : (
                      <Mic size={20} color={theme.colors.foreground} />
                    )}
                  </Pressable>
                  {realtimeButton}
                </>
              ) : null}
            </View>
          </View>
        </Animated.View>

        {/* Voice note recording overlay */}
        <Animated.View style={[styles.overlayContainer, overlayAnimatedStyle]}>
          <VoiceNoteRecordingOverlay
            volume={recordingVolume}
            duration={recordingDuration}
            onCancel={handleCancelRecording}
            onSend={handleSendRecording}
            isTranscribing={transcribingRequestId !== null}
          />
        </Animated.View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "column",
  },
  borderSeparator: {
    height: theme.borderWidth[1],
    backgroundColor: theme.colors.border,
  },
  realtimeControlsContainer: {
    height: FOOTER_HEIGHT,
  },
  inputAreaContainer: {
    position: "relative",
    minHeight: FOOTER_HEIGHT,
  },
  inputContainer: {
    flexDirection: "column",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    gap: theme.spacing[3],
    minHeight: FOOTER_HEIGHT,
  },
  overlayContainer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: FOOTER_HEIGHT,
  },
  imagePreviewContainer: {
    flexDirection: "row",
    gap: theme.spacing[2],
    flexWrap: "wrap",
  },
  imagePill: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.colors.muted,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[1],
    gap: theme.spacing[2],
  },
  imageThumbnail: {
    width: 40,
    height: 40,
    borderRadius: theme.borderRadius.md,
  },
  removeImageButton: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  textInput: {
    width: "100%",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    backgroundColor: theme.colors.muted,
    borderRadius: theme.borderRadius.lg,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    lineHeight: theme.fontSize.lg * 1.4,
  },
  buttonRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  leftButtonGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  rightButtonGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  attachButton: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
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
  realtimeButtonActive: {
    backgroundColor: theme.colors.palette.blue[600],
  },
  cancelButton: {
    minWidth: 92,
    paddingHorizontal: theme.spacing[4],
    height: 40,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.palette.red[500],
    alignItems: "center",
    justifyContent: "center",
  },
  cancelButtonText: {
    color: theme.colors.background,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
}));
