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
import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  forwardRef,
} from "react";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Mic, ArrowUp, Paperclip, X, Square } from "lucide-react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
} from "react-native-reanimated";
import { useDictation } from "@/hooks/use-dictation";
import { DictationOverlay } from "./dictation-controls";
import type { DaemonClient } from "@server/client/daemon-client";
import { usePanelStore } from "@/stores/panel-store";
import { useVoiceOptional } from "@/contexts/voice-context";

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
  client: DaemonClient | null;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  /** True when the containing screen is focused (React Navigation). Used to disable global hotkeys and cancel dictation when unfocused. */
  isScreenFocused?: boolean;
  /** Content to render on the left side of the button row (e.g., AgentStatusBar) */
  leftContent?: React.ReactNode;
  /** Content to render on the right side after voice button (e.g., realtime button, cancel button) */
  rightContent?: React.ReactNode;
  /** When true and there's sendable content, calls onQueue instead of onSubmit */
  isAgentRunning?: boolean;
  /** Callback for queue button when agent is running */
  onQueue?: (payload: MessagePayload) => void;
  /** Intercept key press events before default handling. Return true to prevent default. */
  onKeyPress?: (event: { key: string; preventDefault: () => void }) => boolean;
}

export interface MessageInputRef {
  focus: () => void;
  blur: () => void;
  /**
   * Web-only: return the underlying DOM element for focus assertions/retries.
   * May return null if not mounted or on native.
   */
  getNativeElement?: () => HTMLElement | null;
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

export const MessageInput = forwardRef<MessageInputRef, MessageInputProps>(
  function MessageInput(
    {
      value,
      onChangeText,
      onSubmit,
      isSubmitDisabled = false,
      isSubmitLoading = false,
      images = [],
      onPickImages,
      onRemoveImage,
      client,
      placeholder = "Message...",
      autoFocus = false,
      disabled = false,
      isScreenFocused = true,
      leftContent,
      rightContent,
      isAgentRunning = false,
      onQueue,
      onKeyPress: onKeyPressCallback,
    },
    ref
  ) {
    const { theme } = useUnistyles();
    const voice = useVoiceOptional();
    const toggleAgentList = usePanelStore((state) => state.toggleAgentList);
    const toggleFileExplorer = usePanelStore((state) => state.toggleFileExplorer);
  const [inputHeight, setInputHeight] = useState(MIN_INPUT_HEIGHT);
  const textInputRef = useRef<
    TextInput | (TextInput & { getNativeRef?: () => unknown }) | null
  >(null);
  const isInputFocusedRef = useRef(false);

    useImperativeHandle(ref, () => ({
      focus: () => {
        textInputRef.current?.focus();
      },
      blur: () => {
        textInputRef.current?.blur?.();
      },
      getNativeElement: () => {
        if (!IS_WEB) return null;
        const current = textInputRef.current as
          | (TextInput & { getNativeRef?: () => unknown })
          | null;
        const native =
          typeof current?.getNativeRef === "function"
            ? current.getNativeRef()
            : current;
        return native instanceof HTMLElement ? native : null;
      },
    }));
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
    const socketConnected = client?.isConnected ?? false;
    return socketConnected && !disabled;
  }, [client, disabled]);

  const canConfirmDictation = useCallback(() => {
    const socketConnected = client?.isConnected ?? false;
    return socketConnected;
  }, [client]);

  const {
    isRecording: isDictating,
    isProcessing: isDictationProcessing,
    partialTranscript: dictationPartialTranscript,
    volume: dictationVolume,
    duration: dictationDuration,
    error: dictationError,
    status: dictationStatus,
    startDictation,
    cancelDictation,
    confirmDictation,
    retryFailedDictation,
    discardFailedDictation,
  } = useDictation({
    client,
    onTranscript: handleDictationTranscript,
    onError: handleDictationError,
    canStart: canStartDictation,
    canConfirm: canConfirmDictation,
    autoStopWhenHidden: { isVisible: isScreenFocused },
    enableDuration: true,
  });

  const isDictatingRef = useRef(isDictating);
  useEffect(() => {
    isDictatingRef.current = isDictating;
  }, [isDictating]);

  useEffect(() => {
    if (isDictating || isDictationProcessing) {
      return;
    }
    sendAfterTranscriptRef.current = false;
  }, [dictationStatus, isDictating, isDictationProcessing]);

  // Cmd+D to start/submit dictation, Escape to cancel
  useEffect(() => {
    if (!IS_WEB) return;
    const resolveNativeInput = (): unknown => {
      const current = textInputRef.current as any;
      if (!current) return null;
      if (typeof current.getNativeRef === "function") {
        return current.getNativeRef();
      }
      return current;
    };
    function handleKeyDown(event: KeyboardEvent) {
      const nativeInput = resolveNativeInput();
      const isFromInput = Boolean(nativeInput && event.target === nativeInput);
      if (!isScreenFocused && !isInputFocusedRef.current && !isFromInput) {
        return;
      }
      const dictating = isDictatingRef.current;
      // Cmd+D: start dictation or submit if already dictating
      if (
        (event.metaKey || event.ctrlKey) &&
        (event.code === "KeyD" || event.key.toLowerCase() === "d")
      ) {
        event.preventDefault();
        if (dictating) {
          sendAfterTranscriptRef.current = true;
          confirmDictation();
        } else {
          startDictation();
        }
        return;
      }
      // Escape: cancel dictation
      if (event.key === "Escape" && dictating) {
        event.preventDefault();
        cancelDictation();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [cancelDictation, confirmDictation, isScreenFocused, startDictation]);

  // Animate overlay
  useEffect(() => {
    const showOverlay =
      isDictating ||
      isDictationProcessing ||
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
      if (voice?.isVoiceMode) {
        await voice.stopVoice();
      }
      await startDictation();
    }
  }, [isDictating, cancelDictation, startDictation, voice]);

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
      onChangeText("");
    } else {
      onSubmit(payload);
    }
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

  function handleDesktopKeyPress(event: WebTextInputKeyPressEvent) {
    if (!shouldHandleDesktopSubmit) return;

    // Allow parent to intercept key events (e.g., for autocomplete navigation)
    if (onKeyPressCallback) {
      const handled = onKeyPressCallback({
        key: event.nativeEvent.key,
        preventDefault: () => event.preventDefault(),
      });
      if (handled) return;
    }

    const { shiftKey, metaKey, ctrlKey } = event.nativeEvent;

    const key = event.nativeEvent.key.toLowerCase();

    // Cmd+B or Ctrl+B: toggle sidebar
    if ((metaKey || ctrlKey) && key === "b") {
      event.preventDefault();
      toggleAgentList();
      return;
    }

    // Cmd+E or Ctrl+E: toggle explorer sidebar
    if ((metaKey || ctrlKey) && key === "e") {
      event.preventDefault();
      toggleFileExplorer();
      return;
    }

    // Cmd+D or Ctrl+D: start dictation or submit if already dictating
    if ((metaKey || ctrlKey) && key === "d") {
      event.preventDefault();
      if (isDictating) {
        sendAfterTranscriptRef.current = true;
        confirmDictation();
      } else {
        startDictation();
      }
      return;
    }

    // Escape: cancel dictation
    if (event.nativeEvent.key === "Escape" && isDictating) {
      event.preventDefault();
      cancelDictation();
      return;
    }

    if (event.nativeEvent.key !== "Enter") return;

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
  const isConnected = client?.isConnected ?? false;

  return (
    <View style={styles.container}>
      {/* Regular input */}
      <Animated.View style={[styles.inputWrapper, inputAnimatedStyle]}>
        {/* Image preview pills */}
        {hasImages && (
          <View style={styles.imagePreviewContainer}>
            {images.map((image, index) => (
              <Pressable
                key={`${image.uri}-${index}`}
                style={styles.imagePill}
                onPress={onRemoveImage ? () => onRemoveImage(index) : undefined}
              >
                {({ hovered }) => (
                  <>
                    <Image
                      source={{ uri: image.uri }}
                      style={styles.imageThumbnail}
                    />
                    {onRemoveImage && (
                      <View
                        style={[
                          styles.removeImageButton,
                          (hovered || !IS_WEB) && styles.removeImageButtonVisible,
                        ]}
                      >
                        <X size={16} color="white" />
                      </View>
                    )}
                  </>
                )}
              </Pressable>
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
          onFocus={() => {
            isInputFocusedRef.current = true;
          }}
          onBlur={() => {
            isInputFocusedRef.current = false;
          }}
          style={[
            styles.textInput,
            IS_WEB
              ? {
                  height: inputHeight,
                  minHeight: MIN_INPUT_HEIGHT,
                  maxHeight: MAX_INPUT_HEIGHT,
                }
              : {
                  minHeight: MIN_INPUT_HEIGHT,
                  maxHeight: MAX_INPUT_HEIGHT,
                },
          ]}
          multiline
          scrollEnabled={IS_WEB ? inputHeight >= MAX_INPUT_HEIGHT : true}
          onContentSizeChange={handleContentSizeChange}
          editable={!isDictating && isConnected && !disabled}
          onKeyPress={
            shouldHandleDesktopSubmit ? handleDesktopKeyPress : undefined
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

          {/* Right: voice button, contextual button (realtime/send/cancel) */}
          <View style={styles.rightButtonGroup}>
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
            {!shouldShowSendButton && rightContent}
          </View>
        </View>
      </Animated.View>

      {/* Dictation overlay */}
      <Animated.View style={[styles.overlayContainer, overlayAnimatedStyle]}>
        <DictationOverlay
          volume={dictationVolume}
          duration={dictationDuration}
          transcript={dictationPartialTranscript}
          isRecording={isDictating}
          isProcessing={isDictationProcessing}
          status={dictationStatus}
          errorText={dictationStatus === "failed" ? dictationError ?? undefined : undefined}
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
);

const styles = StyleSheet.create(((theme: any) => ({
  container: {
    position: "relative",
  },
  inputWrapper: {
    flexDirection: "column",
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius["2xl"],
    paddingVertical: {
      xs: theme.spacing[2],
      md: theme.spacing[4],
    },
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[4],
    },
    ...(IS_WEB
      ? {
          transitionProperty: "border-color",
          transitionDuration: "200ms",
          transitionTimingFunction: "ease-in-out",
        }
      : {}),
  },
  imagePreviewContainer: {
    flexDirection: "row",
    gap: theme.spacing[2],
    flexWrap: "wrap",
  },
  imagePill: {
    position: "relative",
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderAccent,
    overflow: "hidden",
    ...(IS_WEB
      ? {
          cursor: "pointer",
        }
      : {}),
  },
  imageThumbnail: {
    width: 48,
    height: 48,
  },
  removeImageButton: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    opacity: 0,
    ...(IS_WEB
      ? {
          transitionProperty: "opacity",
          transitionDuration: "150ms",
        }
      : {}),
  },
  removeImageButtonVisible: {
    opacity: 1,
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
    backgroundColor: theme.colors.accent,
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
