import {
  View,
  TextInput,
  Pressable,
  NativeSyntheticEvent,
  TextInputContentSizeChangeEventData,
  TextInputKeyPressEventData,
  Image,
  Platform,
  BackHandler,
} from "react-native";
import { useState, useRef, useCallback, useEffect } from "react";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Mic, ArrowUp, Paperclip, X, Square } from "lucide-react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
} from "react-native-reanimated";
import { useDictation } from "@/hooks/use-dictation";
import { DictationOverlay } from "./dictation-controls";
import type { UseWebSocketReturn } from "@/hooks/use-websocket";
import type { SessionContextValue } from "@/contexts/session-context";

export interface ImageAttachment {
  uri: string;
  mimeType: string;
}

export interface MessagePayload {
  text: string;
  images?: ImageAttachment[];
  /** When true, bypasses queue and sends immediately even if agent is running */
  forceSend?: boolean;
}

export interface MessageInputProps {
  value: string;
  onChangeText: (text: string) => void;
  onSubmit: (payload: MessagePayload) => void;
  isSubmitDisabled?: boolean;
  isSubmitLoading?: boolean;
  images?: ImageAttachment[];
  onPickImages?: () => void;
  onRemoveImage?: (index: number) => void;
  ws: UseWebSocketReturn;
  sendAgentAudio: SessionContextValue["sendAgentAudio"];
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  /** Content to render on the left side of the button row (e.g., AgentStatusBar) */
  leftContent?: React.ReactNode;
  /** Content to render on the right side after voice button (e.g., realtime button, cancel button) */
  rightContent?: React.ReactNode;
  /** When true and there's sendable content, calls onQueue instead of onSubmit */
  isAgentRunning?: boolean;
  /** Callback for queue button when agent is running */
  onQueue?: (payload: MessagePayload) => void;
}

const MIN_INPUT_HEIGHT = 30;
const MAX_INPUT_HEIGHT = 160;
const IS_WEB = Platform.OS === "web";

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

export function MessageInput({
  value,
  onChangeText,
  onSubmit,
  isSubmitDisabled = false,
  isSubmitLoading = false,
  images = [],
  onPickImages,
  onRemoveImage,
  ws,
  sendAgentAudio,
  placeholder = "Message...",
  autoFocus = false,
  disabled = false,
  leftContent,
  rightContent,
  isAgentRunning = false,
  onQueue,
}: MessageInputProps) {
  const { theme } = useUnistyles();
  const [inputHeight, setInputHeight] = useState(MIN_INPUT_HEIGHT);
  const textInputRef = useRef<
    TextInput | (TextInput & { getNativeRef?: () => unknown }) | null
  >(null);
  const inputHeightRef = useRef(MIN_INPUT_HEIGHT);
  const baselineInputHeightRef = useRef<number | null>(null);
  const overlayTransition = useSharedValue(0);
  const sendAfterTranscriptRef = useRef(false);
  const valueRef = useRef(value);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  // Autofocus on web when autoFocus prop is true
  useEffect(() => {
    if (!IS_WEB || !autoFocus) return;
    // Use requestAnimationFrame to ensure DOM is ready
    const rafId = requestAnimationFrame(() => {
      textInputRef.current?.focus();
    });
    return () => cancelAnimationFrame(rafId);
  }, [autoFocus]);

  const handleDictationTranscript = useCallback(
    (text: string, _meta: { requestId: string }) => {
      if (!text) return;
      const current = valueRef.current;
      const shouldPad = current.length > 0 && !/\s$/.test(current);
      const nextValue = `${current}${shouldPad ? " " : ""}${text}`;

      const shouldAutoSend = sendAfterTranscriptRef.current;
      sendAfterTranscriptRef.current = false;

      if (shouldAutoSend) {
        const imageAttachments = images.length > 0 ? images : undefined;
        onSubmit({ text: nextValue, images: imageAttachments });
        onChangeText("");
      } else {
        onChangeText(nextValue);
      }

      if (IS_WEB && typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => {
          measureWebInputHeight("dictation");
        });
      }
    },
    [onChangeText, onSubmit, images]
  );

  const handleDictationError = useCallback((error: Error) => {
    console.error("[MessageInput] Dictation error:", error);
  }, []);

  const canStartDictation = useCallback(() => {
    const socketConnected = ws.getConnectionState
      ? ws.getConnectionState().isConnected
      : ws.isConnected;
    return socketConnected && !disabled;
  }, [ws, disabled]);

  const canConfirmDictation = useCallback(() => {
    const socketConnected = ws.getConnectionState
      ? ws.getConnectionState().isConnected
      : ws.isConnected;
    return socketConnected;
  }, [ws]);

  const {
    isRecording: isDictating,
    isProcessing: isDictationProcessing,
    volume: dictationVolume,
    duration: dictationDuration,
    status: dictationStatus,
    startDictation,
    cancelDictation,
    confirmDictation,
    retryFailedDictation,
    discardFailedDictation,
  } = useDictation({
    sendAgentAudio,
    ws,
    mode: "transcribe_only",
    onTranscript: handleDictationTranscript,
    onError: handleDictationError,
    canStart: canStartDictation,
    canConfirm: canConfirmDictation,
    enableDuration: true,
  });

  // Animate overlay
  useEffect(() => {
    const showOverlay =
      isDictating ||
      isDictationProcessing ||
      dictationStatus === "retrying" ||
      dictationStatus === "failed";
    overlayTransition.value = withTiming(showOverlay ? 1 : 0, {
      duration: 200,
    });
  }, [isDictating, isDictationProcessing, dictationStatus, overlayTransition]);

  const overlayAnimatedStyle = useAnimatedStyle(() => ({
    opacity: overlayTransition.value,
    pointerEvents: overlayTransition.value > 0.5 ? "auto" : "none",
  }));

  const inputAnimatedStyle = useAnimatedStyle(() => ({
    opacity: 1 - overlayTransition.value,
  }));

  const handleVoicePress = useCallback(async () => {
    if (isDictating) {
      await cancelDictation();
    } else {
      await startDictation();
    }
  }, [isDictating, cancelDictation, startDictation]);

  const handleCancelRecording = useCallback(async () => {
    await cancelDictation();
  }, [cancelDictation]);

  const handleAcceptRecording = useCallback(async () => {
    sendAfterTranscriptRef.current = false;
    await confirmDictation();
  }, [confirmDictation]);

  const handleAcceptAndSendRecording = useCallback(async () => {
    sendAfterTranscriptRef.current = true;
    await confirmDictation();
  }, [confirmDictation]);

  const handleRetryFailedRecording = useCallback(() => {
    void retryFailedDictation();
  }, [retryFailedDictation]);

  const handleDiscardFailedRecording = useCallback(() => {
    discardFailedDictation();
  }, [discardFailedDictation]);

  const handleSendMessage = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed && images.length === 0) return;
    const payload = {
      text: trimmed,
      images: images.length > 0 ? images : undefined,
    };
    if (isAgentRunning && onQueue) {
      onQueue(payload);
    } else {
      onSubmit(payload);
    }
    onChangeText("");
    // Reset input height
    inputHeightRef.current = MIN_INPUT_HEIGHT;
    setInputHeight(MIN_INPUT_HEIGHT);
  }, [value, images, onSubmit, onChangeText, isAgentRunning, onQueue]);

  // Web input height measurement
  function isTextAreaLike(v: unknown): v is TextAreaHandle {
    return typeof v === "object" && v !== null && "scrollHeight" in v;
  }

  function getWebTextArea(): TextAreaHandle | null {
    const ref = textInputRef.current;
    if (!ref) return null;
    if (typeof (ref as any).getNativeRef === "function") {
      const native = (ref as any).getNativeRef();
      if (isTextAreaLike(native)) return native;
    }
    if (isTextAreaLike(ref)) return ref;
    return null;
  }

  function measureWebInputHeight(source: string): boolean {
    if (!IS_WEB) return false;
    const textarea = getWebTextArea();
    if (!textarea || typeof textarea.scrollHeight !== "number") return false;

    const prevHeight = textarea.style?.height;
    const prevOverflow = textarea.style?.overflowY;
    if (textarea.style) {
      textarea.style.height = "auto";
      textarea.style.overflowY = "hidden";
    }

    const scrollHeight = textarea.scrollHeight ?? 0;
    if (textarea.style) {
      textarea.style.height = prevHeight ?? "";
      textarea.style.overflowY = prevOverflow ?? "";
    }

    if (baselineInputHeightRef.current === null && scrollHeight > 0) {
      baselineInputHeightRef.current = scrollHeight;
    }

    const baseline = baselineInputHeightRef.current ?? MIN_INPUT_HEIGHT;
    const rawTarget = scrollHeight > 0 ? scrollHeight : baseline;
    const bounded = Math.max(
      MIN_INPUT_HEIGHT,
      Math.min(MAX_INPUT_HEIGHT, rawTarget)
    );

    if (Math.abs(inputHeightRef.current - bounded) >= 1) {
      inputHeightRef.current = bounded;
      setInputHeight(bounded);
      return true;
    }
    return false;
  }

  function setBoundedInputHeight(nextHeight: number) {
    const bounded = Math.max(
      MIN_INPUT_HEIGHT,
      Math.min(MAX_INPUT_HEIGHT, nextHeight)
    );
    if (Math.abs(inputHeightRef.current - bounded) < 1) return;
    inputHeightRef.current = bounded;
    setInputHeight(bounded);
  }

  function handleContentSizeChange(
    event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>
  ) {
    if (IS_WEB) {
      measureWebInputHeight("contentSizeChange");
      return;
    }
    const contentHeight = event.nativeEvent.contentSize.height;
    setBoundedInputHeight(contentHeight);
  }

  const shouldHandleDesktopSubmit = IS_WEB;

  function handleDesktopSubmitKeyPress(event: WebTextInputKeyPressEvent) {
    if (!shouldHandleDesktopSubmit) return;
    if (event.nativeEvent.key !== "Enter") return;
    const { shiftKey, metaKey, ctrlKey } = event.nativeEvent;

    // Shift+Enter: add newline (default behavior, don't intercept)
    if (shiftKey) return;

    // Cmd+Enter (Mac) or Ctrl+Enter (Windows/Linux): force send immediately
    if (metaKey || ctrlKey) {
      if (isSubmitDisabled || isSubmitLoading || disabled) return;
      event.preventDefault();
      const trimmed = value.trim();
      if (!trimmed && images.length === 0) return;
      const payload = {
        text: trimmed,
        images: images.length > 0 ? images : undefined,
        forceSend: true,
      };
      onSubmit(payload);
      onChangeText("");
      inputHeightRef.current = MIN_INPUT_HEIGHT;
      setInputHeight(MIN_INPUT_HEIGHT);
      return;
    }

    // Plain Enter: normal send (respects queue behavior)
    if (isSubmitDisabled || isSubmitLoading || disabled) return;
    event.preventDefault();
    handleSendMessage();
  }

  const hasImages = images.length > 0;
  const hasSendableContent = value.trim().length > 0 || hasImages;
  const shouldShowSendButton = hasSendableContent;
  const isConnected = ws.getConnectionState
    ? ws.getConnectionState().isConnected
    : ws.isConnected;

  return (
    <View style={styles.container}>
      {/* Regular input */}
      <Animated.View style={[styles.inputWrapper, inputAnimatedStyle]}>
        {/* Image preview pills */}
        {hasImages && (
          <View style={styles.imagePreviewContainer}>
            {images.map((image, index) => (
              <View key={`${image.uri}-${index}`} style={styles.imagePill}>
                <Image
                  source={{ uri: image.uri }}
                  style={styles.imageThumbnail}
                />
                {onRemoveImage && (
                  <Pressable
                    onPress={() => onRemoveImage(index)}
                    style={styles.removeImageButton}
                  >
                    <X size={16} color={theme.colors.foreground} />
                  </Pressable>
                )}
              </View>
            ))}
          </View>
        )}

        {/* Text input */}
        <TextInput
          ref={textInputRef}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={theme.colors.mutedForeground}
          style={[
            styles.textInput,
            {
              height: inputHeight,
              minHeight: MIN_INPUT_HEIGHT,
              maxHeight: MAX_INPUT_HEIGHT,
            },
          ]}
          multiline
          scrollEnabled={inputHeight >= MAX_INPUT_HEIGHT}
          onContentSizeChange={handleContentSizeChange}
          editable={!isDictating && isConnected && !disabled}
          onKeyPress={
            shouldHandleDesktopSubmit ? handleDesktopSubmitKeyPress : undefined
          }
          autoFocus={IS_WEB && autoFocus}
        />

        {/* Button row */}
        <View style={styles.buttonRow}>
          {/* Left: attachment button + leftContent slot */}
          <View style={styles.leftButtonGroup}>
            {onPickImages && (
              <Pressable
                onPress={onPickImages}
                disabled={!isConnected || disabled}
                style={[
                  styles.attachButton,
                  (!isConnected || disabled) && styles.buttonDisabled,
                ]}
              >
                <Paperclip size={20} color={theme.colors.foreground} />
              </Pressable>
            )}
            {leftContent}
          </View>

          {/* Right: send/queue button, voice button, rightContent slot */}
          <View style={styles.rightButtonGroup}>
            {shouldShowSendButton && (
              <Pressable
                onPress={handleSendMessage}
                disabled={
                  !isConnected ||
                  isSubmitDisabled ||
                  isSubmitLoading ||
                  disabled
                }
                style={[
                  styles.sendButton,
                  (!isConnected ||
                    isSubmitDisabled ||
                    isSubmitLoading ||
                    disabled) &&
                    styles.buttonDisabled,
                ]}
              >
                <ArrowUp size={20} color="white" />
              </Pressable>
            )}
            <Pressable
              onPress={handleVoicePress}
              disabled={!isConnected || disabled}
              style={[
                styles.voiceButton,
                (!isConnected || disabled) && styles.buttonDisabled,
                isDictating && styles.voiceButtonRecording,
              ]}
            >
              {isDictating ? (
                <Square size={14} color="white" fill="white" />
              ) : (
                <Mic size={20} color={theme.colors.foreground} />
              )}
            </Pressable>
            {rightContent}
          </View>
        </View>
      </Animated.View>

      {/* Dictation overlay */}
      <Animated.View style={[styles.overlayContainer, overlayAnimatedStyle]}>
        <DictationOverlay
          volume={dictationVolume}
          duration={dictationDuration}
          isRecording={isDictating}
          isProcessing={isDictationProcessing}
          status={dictationStatus}
          onCancel={handleCancelRecording}
          onAccept={handleAcceptRecording}
          onAcceptAndSend={handleAcceptAndSendRecording}
          onRetry={
            dictationStatus === "failed"
              ? handleRetryFailedRecording
              : undefined
          }
          onDiscard={
            dictationStatus === "failed"
              ? handleDiscardFailedRecording
              : undefined
          }
        />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create(((theme: any) => ({
  container: {
    position: "relative",
  },
  inputWrapper: {
    flexDirection: "column",
    gap: theme.spacing[3],
    backgroundColor: theme.colors.muted,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.accentBorder,
    borderRadius: theme.borderRadius["2xl"],
    paddingVertical: {
      xs: theme.spacing[2],
      md: theme.spacing[4],
    },
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[4],
    },
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
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.normal,
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
    width: 20,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  voiceButton: {
    width: 34,
    height: 34,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  voiceButtonRecording: {
    backgroundColor: theme.colors.destructive,
  },
  sendButton: {
    width: 34,
    height: 34,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.palette.blue[600],
    alignItems: "center",
    justifyContent: "center",
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  overlayContainer: {
    position: "absolute",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    right: 0,
    bottom: 0,
  },
})) as any) as Record<string, any>;
