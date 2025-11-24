import {
  View,
  TextInput,
  Pressable,
  NativeSyntheticEvent,
  TextInputContentSizeChangeEventData,
  TextInputKeyPressEventData,
  Image,
  Platform,
  Text,
  ActivityIndicator,
} from "react-native";
import { useState, useEffect, useRef, useLayoutEffect, useCallback } from "react";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Mic, ArrowUp, AudioLines, Square, Paperclip, X, Pencil } from "lucide-react-native";
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
import { AUDIO_DEBUG_ENABLED } from "@/config/audio-debug";
import { AudioDebugNotice, type AudioDebugInfo } from "./audio-debug-notice";

type QueuedMessage = {
  id: string;
  text: string;
  images?: Array<{ uri: string; mimeType: string }>;
};

interface AgentInputAreaProps {
  agentId: string;
}

const MIN_INPUT_HEIGHT = 50;
const MAX_INPUT_HEIGHT = 160;
const MAX_INPUT_WIDTH = 960;
const BASE_VERTICAL_PADDING = (FOOTER_HEIGHT - MIN_INPUT_HEIGHT) / 2;
// Android currently crashes inside ViewGroup.dispatchDraw when running Reanimated
// entering/exiting animations (see react-native-reanimated#8422), so guard them.
const SHOULD_DISABLE_ENTRY_EXIT_ANIMATIONS = Platform.OS === "android";
const REALTIME_FADE_IN = SHOULD_DISABLE_ENTRY_EXIT_ANIMATIONS ? undefined : FadeIn.duration(250);
const REALTIME_FADE_OUT = SHOULD_DISABLE_ENTRY_EXIT_ANIMATIONS ? undefined : FadeOut.duration(250);
const IS_WEB = Platform.OS === "web";
const SHOULD_DEBUG_INPUT_HEIGHT = IS_WEB;
type WebTextInputKeyPressEvent = NativeSyntheticEvent<
  TextInputKeyPressEventData & {
    metaKey?: boolean;
    ctrlKey?: boolean;
    shiftKey?: boolean;
  }
>;
type TextAreaHandle = {
  scrollHeight?: number;
  style?: {
    height?: string;
    overflowY?: string;
  } & Record<string, unknown>;
};

export function AgentInputArea({ agentId }: AgentInputAreaProps) {
  const { theme } = useUnistyles();
  const {
    ws,
    sendAgentMessage,
    sendAgentAudio,
    agents,
    cancelAgentRun,
    getDraftInput,
    saveDraftInput,
    queuedMessages: queuedMessagesByAgent,
    setQueuedMessages: setQueuedMessagesByAgent,
  } = useSession();
  const { startRealtime, stopRealtime, isRealtimeMode } = useRealtime();
  
  const [userInput, setUserInput] = useState("");
  const [inputHeight, setInputHeight] = useState(MIN_INPUT_HEIGHT);
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [selectedImages, setSelectedImages] = useState<Array<{ uri: string; mimeType: string }>>([]);
  const [recordingVolume, setRecordingVolume] = useState(0);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [transcribingRequestId, setTranscribingRequestId] = useState<string | null>(null);
  const [isCancellingAgent, setIsCancellingAgent] = useState(false);
  const [audioDebugInfo, setAudioDebugInfo] = useState<AudioDebugInfo | null>(null);
  
  const recordingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const textInputRef = useRef<TextInput | (TextInput & { getNativeRef?: () => unknown }) | null>(null);
  const inputHeightRef = useRef(MIN_INPUT_HEIGHT);
  const baselineInputHeightRef = useRef<number | null>(null);
  const overlayTransition = useSharedValue(0);
  const { pickImages } = useImageAttachmentPicker();
  const shouldShowAudioDebug = AUDIO_DEBUG_ENABLED;
  const pendingTranscriptionRef = useRef<{ requestId: string } | null>(null);
  const agentIdRef = useRef(agentId);
  const sendAgentMessageRef = useRef(sendAgentMessage);
  const agentStatusRef = useRef<string | undefined>(undefined);
  const updateQueueRef = useRef<
    ((updater: (current: QueuedMessage[]) => QueuedMessage[]) => void) | null
  >(null);

  const audioRecorder = useAudioRecorder({
    onAudioLevel: (level) => {
      setRecordingVolume(level);
    },
  });

  const debugInputHeight = (label: string, payload: Record<string, unknown>) => {
    if (!SHOULD_DEBUG_INPUT_HEIGHT) {
      return;
    }
    console.log(`[AgentInput][InputHeight] ${label}`, payload);
  };
  useEffect(() => {
    inputHeightRef.current = inputHeight;
  }, [inputHeight]);

  useEffect(() => {
    agentIdRef.current = agentId;
  }, [agentId]);

  useEffect(() => {
    sendAgentMessageRef.current = sendAgentMessage;
  }, [sendAgentMessage]);

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

    if (shouldShowAudioDebug) {
      setAudioDebugInfo(null);
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
        pendingTranscriptionRef.current = {
          requestId,
        };
        console.log("[AgentInput] Audio recorded:", audioData.size, "bytes", "requestId:", requestId);

        try {
          // Send audio to agent for transcription and processing
          await sendAgentAudio(agentId, audioData, requestId, { mode: "transcribe_only" });
          console.log("[AgentInput] Audio sent to agent");
        } catch (error) {
          console.error("[AgentInput] Failed to send audio:", error);
          // Clear transcribing state on error
          setTranscribingRequestId(null);
          pendingTranscriptionRef.current = null;
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
      pendingTranscriptionRef.current = null;
      overlayTransition.value = withTiming(0, { duration: 250 });
    }
  }

  useEffect(() => {
    const unsubscribe = ws.on("transcription_result", (message) => {
      if (message.type !== "transcription_result") {
        return;
      }

      const pending = pendingTranscriptionRef.current;
      if (!pending || !message.payload.requestId) {
        return;
      }

      if (message.payload.requestId !== pending.requestId) {
        return;
      }

      console.log("[AgentInput] Transcription completed for requestId:", pending.requestId);
      pendingTranscriptionRef.current = null;
      setTranscribingRequestId(null);
      overlayTransition.value = withTiming(0, { duration: 250 });

      if (shouldShowAudioDebug) {
        setAudioDebugInfo({
          requestId: pending.requestId,
          transcript: message.payload.text?.trim(),
          debugRecordingPath: message.payload.debugRecordingPath ?? undefined,
          format: message.payload.format,
          byteLength: message.payload.byteLength,
          duration: message.payload.duration,
          avgLogprob: message.payload.avgLogprob,
          isLowConfidence: message.payload.isLowConfidence,
        });
      }

      const transcriptText = message.payload.text?.trim();
      if (!transcriptText) {
        return;
      }

      const shouldQueue = agentStatusRef.current === "running";
      if (shouldQueue) {
        updateQueueRef.current?.((current) => [
          ...current,
          {
            id: generateMessageId(),
            text: transcriptText,
          },
        ]);
        return;
      }

      void (async () => {
        try {
          await sendAgentMessageRef.current?.(agentIdRef.current, transcriptText);
        } catch (error) {
          console.error("[AgentInput] Failed to send transcribed message:", error);
          updateQueueRef.current?.((current) => [
            ...current,
            {
              id: generateMessageId(),
              text: transcriptText,
            },
          ]);
        }
      })();
    });

    return () => {
      unsubscribe();
    };
  }, [ws, overlayTransition, shouldShowAudioDebug]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (recordingIntervalRef.current) {
        clearInterval(recordingIntervalRef.current);
      }
    };
  }, []);


  function isTextAreaLike(value: unknown): value is TextAreaHandle {
    if (!value || typeof value !== "object") {
      return false;
    }
    const candidate = value as TextAreaHandle;
    return typeof candidate.scrollHeight === "number" && typeof candidate.style === "object";
  }

  function getWebTextArea(): TextAreaHandle | null {
    if (!IS_WEB) {
      return null;
    }

    const node = textInputRef.current;
    if (!node) {
      debugInputHeight("missing-ref", {});
      return null;
    }

    if (isTextAreaLike(node)) {
      debugInputHeight("using-ref", {
        scrollHeight: node.scrollHeight,
        inlineHeight: node.style?.height,
      });
      return node;
    }

    if (typeof (node as { getNativeRef?: () => unknown }).getNativeRef === "function") {
      const native = (node as { getNativeRef?: () => unknown }).getNativeRef?.();
      if (isTextAreaLike(native)) {
        debugInputHeight("using-native-ref", {
          scrollHeight: native.scrollHeight,
          inlineHeight: native.style?.height,
        });
        return native;
      }
    }

    debugInputHeight("no-textarea-found", {});
    return null;
  }

  function focusWebTextInput(): void {
    if (!IS_WEB) {
      return;
    }
    const node = textInputRef.current;
    if (!node) {
      return;
    }

    const target: unknown =
      typeof (node as { focus?: () => void }).focus === "function"
        ? node
        : typeof (node as { getNativeRef?: () => unknown }).getNativeRef === "function"
          ? (node as { getNativeRef?: () => unknown }).getNativeRef?.()
          : null;

    if (target && typeof (target as { focus?: () => void }).focus === "function") {
      const exec = () => (target as { focus: () => void }).focus();
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(exec);
      } else {
        setTimeout(exec, 0);
      }
    }
  }

  function measureWebInputHeight(source: string): boolean {
    if (!IS_WEB) {
      return false;
    }
    const element = getWebTextArea();
    if (!element?.style || typeof element.scrollHeight !== "number") {
      debugInputHeight(`${source}-missing`, {});
      return false;
    }
    const previousHeight = element.style.height;
    element.style.height = "auto";
    const measuredHeight = element.scrollHeight;
    element.style.height = previousHeight ?? "";
    const bounded = applyMeasuredHeight(measuredHeight, source, {
      scrollHeight: element.scrollHeight,
      inlineHeight: previousHeight,
    });
    element.style.height = `${bounded}px`;
    element.style.minHeight = `${MIN_INPUT_HEIGHT}px`;
    element.style.maxHeight = `${MAX_INPUT_HEIGHT}px`;
    element.style.overflowY = bounded >= MAX_INPUT_HEIGHT ? "auto" : "hidden";
    return true;
  }

  function applyMeasuredHeight(
    measuredHeight: number,
    source: string,
    details: Record<string, unknown> = {},
  ): number {
    const existingBaseline = baselineInputHeightRef.current;
    if (existingBaseline === null) {
      baselineInputHeightRef.current = measuredHeight;
    }
    const baseline = baselineInputHeightRef.current ?? measuredHeight;
    const normalizedHeight = measuredHeight - baseline + MIN_INPUT_HEIGHT;
    const bounded = Math.min(
      MAX_INPUT_HEIGHT,
      Math.max(MIN_INPUT_HEIGHT, normalizedHeight),
    );
    debugInputHeight(source, {
      measuredHeight,
      normalizedHeight,
      bounded,
      baseline,
      ...details,
    });
    setBoundedInputHeight(bounded);
    return bounded;
  }

  function setBoundedInputHeight(nextHeight: number) {
    const boundedHeight = Math.min(
      MAX_INPUT_HEIGHT,
      Math.max(MIN_INPUT_HEIGHT, nextHeight),
    );

    if (Math.abs(inputHeightRef.current - boundedHeight) < 1) {
      return;
    }

    debugInputHeight("set-state", {
      nextHeight,
      boundedHeight,
      previousHeight: inputHeightRef.current,
    });
    setInputHeight(boundedHeight);
  }

  function handleContentSizeChange(
    event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>,
  ) {
    if (IS_WEB && measureWebInputHeight("web-measure")) {
      return;
    }

    applyMeasuredHeight(event.nativeEvent.contentSize.height, "native-measure", {
      width: event.nativeEvent.contentSize.width,
    });
  }

  const agent = agents.get(agentId);
  const isAgentRunning = agent?.status === "running";
  agentStatusRef.current = agent?.status;
  const hasText = userInput.trim().length > 0;
  const hasImages = selectedImages.length > 0;
  const hasSendableContent = hasText || hasImages;
  const shouldShowSendButton = !isAgentRunning && hasSendableContent;
  const shouldShowVoiceControls = !hasSendableContent;
  const queuedMessages = queuedMessagesByAgent.get(agentId) ?? [];
  const shouldHandleDesktopSubmit = IS_WEB;

  const updateQueue = useCallback(
    (updater: (current: QueuedMessage[]) => QueuedMessage[]) => {
      setQueuedMessagesByAgent((prev) => {
        const next = new Map(prev);
        next.set(agentId, updater(prev.get(agentId) ?? []));
        return next;
      });
    },
    [agentId, setQueuedMessagesByAgent],
  );
  useEffect(() => {
    updateQueueRef.current = updateQueue;
  }, [updateQueue]);


  useLayoutEffect(() => {
    if (!IS_WEB) {
      return;
    }
    measureWebInputHeight("layout-effect");
  }, [userInput]);

  function handleDesktopSubmitKeyPress(event: WebTextInputKeyPressEvent) {
    if (!shouldHandleDesktopSubmit) {
      return;
    }
    if (event.nativeEvent.key !== "Enter") {
      return;
    }
    const { metaKey, ctrlKey, shiftKey } = event.nativeEvent;
    if (shiftKey || metaKey || ctrlKey) {
      return;
    }
    event.preventDefault();
    if (isAgentRunning) {
      if (!hasSendableContent || !ws.isConnected) {
        return;
      }
      handleQueueCurrentInput();
      return;
    }
    if (!shouldShowSendButton || isProcessing || !ws.isConnected) {
      return;
    }
    void handleSendMessage();
  }

  useEffect(() => {
    if (!isAgentRunning || !ws.isConnected) {
      setIsCancellingAgent(false);
    }
  }, [isAgentRunning, ws.isConnected]);

  useEffect(() => {
    if (!IS_WEB) {
      return;
    }

    const listener = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const isCommandLike = event.metaKey || event.ctrlKey;

      if (isCommandLike && !event.altKey && key === "d") {
        event.preventDefault();
        event.stopPropagation();

        if (isRecording) {
          void handleSendRecording();
          return;
        }

        if (!isRealtimeMode && shouldShowVoiceControls && ws.isConnected) {
          void handleVoicePress();
        }
        return;
      }

      if (key === "escape" && isRecording) {
        event.preventDefault();
        event.stopPropagation();
        void handleCancelRecording();
      }
    };

    window.addEventListener("keydown", listener, true);
    return () => {
      window.removeEventListener("keydown", listener, true);
    };
  }, [
    isRecording,
    isRealtimeMode,
    shouldShowVoiceControls,
    ws,
    handleVoicePress,
    handleSendRecording,
    handleCancelRecording,
  ]);

  useEffect(() => {
    focusWebTextInput();
  }, [agentId]);

  // Hydrate draft only when switching agents
  useEffect(() => {
    const draft = getDraftInput(agentId);
    if (!draft) {
      setUserInput("");
      setSelectedImages([]);
      return;
    }

    setUserInput(draft.text);
    setSelectedImages(draft.images);
  }, [agentId, getDraftInput]);

  // Persist drafts into the shared session store with change detection to avoid redundant work
  useEffect(() => {
    const existing = getDraftInput(agentId);
    const isSameText = existing?.text === userInput;
    const existingImages = existing?.images ?? [];
    const isSameImages =
      existingImages.length === selectedImages.length &&
      existingImages.every((img, idx) => img.uri === selectedImages[idx]?.uri && img.mimeType === selectedImages[idx]?.mimeType);

    if (isSameText && isSameImages) {
      return;
    }

    saveDraftInput(agentId, { text: userInput, images: selectedImages });
  }, [agentId, userInput, selectedImages, getDraftInput, saveDraftInput]);

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
    if (!agent || agent.status !== "running" || isCancellingAgent) {
      return;
    }
    if (!ws.isConnected) {
      return;
    }
    setIsCancellingAgent(true);
    cancelAgentRun(agentId);
  }

  function handleQueueCurrentInput() {
    if (!hasSendableContent) return;

    const newItem = {
      id: generateMessageId(),
      text: userInput.trim(),
      images: selectedImages.length ? selectedImages : undefined,
    };

    updateQueue((current) => [...current, newItem]);
    setUserInput("");
    setSelectedImages([]);
    setInputHeight(MIN_INPUT_HEIGHT);
  }

  function handleEditQueuedMessage(id: string) {
    const item = queuedMessages.find((q) => q.id === id);
    if (!item) return;

    updateQueue((current) => current.filter((q) => q.id !== id));
    setUserInput(item.text);
    setSelectedImages(item.images ?? []);
  }

  async function handleSendQueuedNow(id: string) {
    const item = queuedMessages.find((q) => q.id === id);
    if (!item || !ws.isConnected) return;

    updateQueue((current) => current.filter((q) => q.id !== id));

    // Cancels current agent run before sending queued prompt
    handleCancelAgent();
    await sendAgentMessage(agentId, item.text, item.images?.map((img) => img.uri));
  }

  const realtimeButton = (
    <Pressable
      onPress={handleRealtimePress}
      disabled={!ws.isConnected && !isRealtimeMode}
      style={[
        styles.realtimeButton as any,
        (isRealtimeMode ? styles.realtimeButtonActive : undefined) as any,
        (!ws.isConnected && !isRealtimeMode ? styles.buttonDisabled : undefined) as any,
      ]}
    >
      {isRealtimeMode ? (
        <Square size={18} color={theme.colors.background} fill={theme.colors.background} />
      ) : (
        <AudioLines size={20} color={theme.colors.background} />
      )}
    </Pressable>
  );

  const voiceButton = (
    <Pressable
      onPress={handleVoicePress}
      disabled={!ws.isConnected || isRealtimeMode}
      style={[
        styles.voiceButton as any,
        (!ws.isConnected || isRealtimeMode ? styles.buttonDisabled : undefined) as any,
        (isRecording ? styles.voiceButtonRecording : undefined) as any,
      ]}
    >
      {isRecording ? (
        <Square size={14} color="white" fill="white" />
      ) : (
        <Mic size={20} color={theme.colors.foreground} />
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
        <View style={styles.inputAreaContent}>
          {/* Regular input controls */}
          <Animated.View style={[styles.inputContainer, inputAnimatedStyle]}>
            {shouldShowAudioDebug && audioDebugInfo ? (
              <AudioDebugNotice
                info={audioDebugInfo}
                onDismiss={() => setAudioDebugInfo(null)}
              />
            ) : null}
          {/* Queue list */}
          {queuedMessages.length > 0 && (
            <View style={styles.queueContainer}>
              {queuedMessages.map((item) => (
                <View key={item.id} style={styles.queueItem}>
                  <Text style={styles.queueText} numberOfLines={2} ellipsizeMode="tail">
                    {item.text}
                  </Text>
                  <View style={styles.queueActions}>
                    <Pressable onPress={() => handleEditQueuedMessage(item.id)} style={styles.queueActionButton}>
                      <Pencil size={14} color={theme.colors.foreground} />
                    </Pressable>
                    <Pressable
                      onPress={() => handleSendQueuedNow(item.id)}
                      style={[styles.queueActionButton, styles.queueSendButton]}
                    >
                      <ArrowUp size={14} color={theme.colors.background} />
                    </Pressable>
                  </View>
                </View>
              ))}
            </View>
          )}

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
            ref={textInputRef}
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
            onKeyPress={shouldHandleDesktopSubmit ? handleDesktopSubmitKeyPress : undefined}
          />

          {/* Button row below input */}
          <View style={styles.buttonRow}>
            {/* Left button group */}
            <View style={styles.leftButtonGroup}>
              <Pressable
                onPress={handlePickImage}
                disabled={!ws.isConnected}
                style={[
                  styles.attachButton as any,
                  (!ws.isConnected ? styles.buttonDisabled : undefined) as any,
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
                  {shouldShowVoiceControls && voiceButton}
                  {hasSendableContent && (
                    <Pressable
                      onPress={handleQueueCurrentInput}
                      disabled={!ws.isConnected}
                      accessibilityLabel="Queue message while agent is running"
                      accessibilityRole="button"
                      style={[
                        styles.queueButton as any,
                        (!ws.isConnected ? styles.buttonDisabled : undefined) as any,
                      ]}
                    >
                      <ArrowUp size={20} color="white" />
                    </Pressable>
                  )}
                  {realtimeButton}
                  <Pressable
                    onPress={handleCancelAgent}
                    disabled={!ws.isConnected || isCancellingAgent}
                    accessibilityLabel={isCancellingAgent ? "Canceling agent" : "Stop agent"}
                    accessibilityRole="button"
                    style={[
                      styles.cancelButton as any,
                      (!ws.isConnected || isCancellingAgent ? styles.buttonDisabled : undefined) as any,
                    ]}
                  >
                    {isCancellingAgent ? (
                      <ActivityIndicator size="small" color="white" />
                    ) : (
                      <Square size={18} color="white" fill="white" />
                    )}
                  </Pressable>
                </>
              ) : shouldShowSendButton ? (
                <Pressable
                  onPress={handleSendMessage}
                  disabled={!ws.isConnected || isProcessing}
                style={[
                  styles.sendButton as any,
                  (!ws.isConnected || isProcessing ? styles.buttonDisabled : undefined) as any,
                ]}
                >
                  <ArrowUp size={20} color="white" />
                </Pressable>
                  ) : shouldShowVoiceControls ? (
                    <>
                      {voiceButton}
                      {realtimeButton}
                    </>
                  ) : null}
            </View>
          </View>
          </Animated.View>
        </View>

        {/* Voice note recording overlay */}
        <Animated.View style={[styles.overlayContainer, overlayAnimatedStyle]}>
          <View style={styles.inputAreaContent}>
            <VoiceNoteRecordingOverlay
              volume={recordingVolume}
              duration={recordingDuration}
              onCancel={handleCancelRecording}
              onSend={handleSendRecording}
              isTranscribing={transcribingRequestId !== null}
            />
          </View>
        </Animated.View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create(((theme: any) => ({
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
    alignItems: "center",
    width: "100%",
  },
  inputAreaContent: {
    width: "100%",
    maxWidth: MAX_INPUT_WIDTH,
  },
  inputContainer: {
    flexDirection: "column",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    gap: theme.spacing[3],
    minHeight: FOOTER_HEIGHT,
    width: "100%",
  },
  overlayContainer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: FOOTER_HEIGHT,
    alignItems: "center",
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
    ...(IS_WEB
      ? {
          outlineStyle: "none" as const,
          outlineWidth: 0,
          outlineColor: "transparent",
        }
      : {}),
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
    width: 40,
    height: 40,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.palette.red[500],
    alignItems: "center",
    justifyContent: "center",
  },
  queueButton: {
    width: 40,
    height: 40,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.palette.blue[600],
    alignItems: "center",
    justifyContent: "center",
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  queueContainer: {
    flexDirection: "column",
    gap: theme.spacing[2],
  },
  queueItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.card,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    gap: theme.spacing[2],
  },
  queueText: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  queueActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  queueActionButton: {
    width: 32,
    height: 32,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.muted,
  },
  queueSendButton: {
    backgroundColor: theme.colors.palette.blue[600],
  },
})) as any) as Record<string, any>;
