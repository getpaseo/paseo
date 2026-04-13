import {
  View,
  Text,
  TextInput,
  Pressable,
  ActivityIndicator,
  NativeSyntheticEvent,
  TextInputContentSizeChangeEventData,
  TextInputKeyPressEventData,
  TextInputSelectionChangeEventData,
  Image,
  BackHandler,
} from "react-native";
import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useImperativeHandle,
  forwardRef,
} from "react";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Mic, MicOff, ArrowUp, Paperclip, Plus, X, Square } from "lucide-react-native";
import Animated, { useSharedValue, useAnimatedStyle, withTiming } from "react-native-reanimated";
import { useDictation } from "@/hooks/use-dictation";
import { DictationOverlay } from "./dictation-controls";
import { RealtimeVoiceOverlay } from "./realtime-voice-overlay";
import type { DaemonClient } from "@server/client/daemon-client";
import { useSessionStore } from "@/stores/session-store";
import { useVoiceOptional } from "@/contexts/voice-context";
import { useToast } from "@/contexts/toast-context";
import { resolveVoiceUnavailableMessage } from "@/utils/server-info-capabilities";
import {
  collectImageFilesFromClipboardData,
  filesToImageAttachments,
} from "@/utils/image-attachments-from-files";
import type { AttachmentMetadata } from "@/attachments/types";
import { useAttachmentPreviewUrl } from "@/attachments/use-attachment-preview-url";
import { focusWithRetries } from "@/utils/web-focus";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Shortcut } from "@/components/ui/shortcut";
import { useWebElementScrollbar } from "@/components/use-web-scrollbar";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import type { MessageInputKeyboardActionKind } from "@/keyboard/actions";
import {
  markScrollInvestigationEvent,
  markScrollInvestigationRender,
} from "@/utils/scroll-jank-investigation";
import { isWeb } from "@/constants/platform";

export type ImageAttachment = AttachmentMetadata;

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
  onAddImages?: (images: ImageAttachment[]) => void;
  onRemoveImage?: (index: number) => void;
  client: DaemonClient | null;
  /** Dictation start gate from host runtime (socket connected + directory ready). */
  isReadyForDictation?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  autoFocusKey?: string;
  disabled?: boolean;
  /** True when this input is the active composer. Used to gate global hotkeys and stop dictation when hidden. */
  isInputActive?: boolean;
  /** Content to render on the left side of the button row (e.g., AgentStatusBar) */
  leftContent?: React.ReactNode;
  /** Content to render on the right side before the voice button (e.g., context window meter) */
  beforeVoiceContent?: React.ReactNode;
  /** Content to render on the right side after voice button (e.g., realtime button, cancel button) */
  rightContent?: React.ReactNode;
  voiceServerId?: string;
  voiceAgentId?: string;
  /** When true and there's sendable content, calls onQueue instead of onSubmit */
  isAgentRunning?: boolean;
  /** Controls what the default send action (Enter, send button, dictation) does
   *  when the agent is running. "interrupt" sends immediately, "queue" queues. */
  defaultSendBehavior?: "interrupt" | "queue";
  /** Callback for queue button when agent is running */
  onQueue?: (payload: MessagePayload) => void;
  /** Optional handler used when submit button is in loading state. */
  onSubmitLoadingPress?: () => void;
  /** Intercept key press events before default handling. Return true to prevent default. */
  onKeyPress?: (event: { key: string; preventDefault: () => void }) => boolean;
  /** Reports cursor selection updates from the underlying input. */
  onSelectionChange?: (selection: { start: number; end: number }) => void;
  onFocusChange?: (focused: boolean) => void;
  onHeightChange?: (height: number) => void;
}

export interface MessageInputRef {
  focus: () => void;
  blur: () => void;
  runKeyboardAction: (action: MessageInputKeyboardActionKind) => boolean;
  /**
   * Web-only: return the underlying DOM element for focus assertions/retries.
   * May return null if not mounted or on native.
   */
  getNativeElement?: () => HTMLElement | null;
}

const MIN_INPUT_HEIGHT = 30;
const MAX_INPUT_HEIGHT = 160;

type WebTextInputKeyPressEvent = NativeSyntheticEvent<
  TextInputKeyPressEventData & {
    metaKey?: boolean;
    ctrlKey?: boolean;
    shiftKey?: boolean;
    // Web-only: present on DOM KeyboardEvent during IME composition (CJK input).
    isComposing?: boolean;
    keyCode?: number;
  }
>;

type TextAreaHandle = {
  scrollHeight?: number;
  clientHeight?: number;
  offsetHeight?: number;
  scrollTop?: number;
  selectionStart?: number | null;
  selectionEnd?: number | null;
  style?: {
    height?: string;
    overflowY?: string;
  } & Record<string, unknown>;
};

function logWebStickyBottom(_event: string, _details: Record<string, unknown>): void {
  // Intentionally disabled: this path is too noisy during voice debugging.
}

function getDebugNow(): number | null {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return Number(performance.now().toFixed(3));
  }
  return null;
}

function getElementDescriptor(element: HTMLElement | null): string | null {
  if (!element) return null;
  const tag = element.tagName?.toLowerCase() ?? "unknown";
  const id = element.id ? `#${element.id}` : "";
  const testId = element.getAttribute?.("data-testid");
  const label = element.getAttribute?.("aria-label");
  const suffix = testId ? `[data-testid="${testId}"]` : label ? `[aria-label="${label}"]` : "";
  return `${tag}${id}${suffix}`;
}

function getScrollableAncestorChain(element: HTMLElement | null): string[] {
  if (!element || typeof window === "undefined") {
    return [];
  }
  const results: string[] = [];
  let current = element.parentElement;
  while (current) {
    const style = window.getComputedStyle(current);
    const overflowY = style.overflowY;
    const canScroll =
      (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") &&
      current.scrollHeight > current.clientHeight;
    if (canScroll) {
      results.push(getElementDescriptor(current) ?? current.tagName.toLowerCase());
    }
    current = current.parentElement;
  }
  return results;
}

function ImageAttachmentThumbnail({ image }: { image: ImageAttachment }) {
  const uri = useAttachmentPreviewUrl(image);
  if (!uri) {
    return <View style={styles.imageThumbnailPlaceholder} />;
  }
  return <Image source={{ uri }} style={styles.imageThumbnail} />;
}

export const MessageInput = forwardRef<MessageInputRef, MessageInputProps>(function MessageInput(
  {
    value,
    onChangeText,
    onSubmit,
    isSubmitDisabled = false,
    isSubmitLoading = false,
    images = [],
    onPickImages,
    onAddImages,
    onRemoveImage,
    client,
    isReadyForDictation,
    placeholder = "Message...",
    autoFocus = false,
    autoFocusKey,
    disabled = false,
    isInputActive = true,
    leftContent,
    beforeVoiceContent,
    rightContent,
    voiceServerId,
    voiceAgentId,
    isAgentRunning = false,
    defaultSendBehavior = "interrupt",
    onQueue,
    onSubmitLoadingPress,
    onKeyPress: onKeyPressCallback,
    onSelectionChange: onSelectionChangeCallback,
    onFocusChange,
    onHeightChange,
  },
  ref,
) {
  const { theme } = useUnistyles();
  const buttonIconSize = isWeb ? theme.iconSize.md : theme.iconSize.lg;
  const investigationComponentId = `MessageInput:${voiceServerId ?? "unknown-server"}:${voiceAgentId ?? "unknown-agent"}`;
  markScrollInvestigationRender(investigationComponentId);
  const toast = useToast();
  const voice = useVoiceOptional();
  const sendKeys = useShortcutKeys("message-input-send");
  const voiceMuteToggleKeys = useShortcutKeys("voice-mute-toggle");
  const dictationToggleKeys = useShortcutKeys("dictation-toggle");
  const queueKeys = useShortcutKeys("message-input-queue");
  const [inputHeight, setInputHeight] = useState(MIN_INPUT_HEIGHT);
  const rootRef = useRef<View | null>(null);
  const inputWrapperRef = useRef<View | null>(null);
  const textInputRef = useRef<TextInput | (TextInput & { getNativeRef?: () => unknown }) | null>(
    null,
  );
  const isInputFocusedRef = useRef(false);

  useImperativeHandle(ref, () => ({
    focus: () => {
      textInputRef.current?.focus();
    },
    blur: () => {
      textInputRef.current?.blur?.();
    },
    runKeyboardAction: (action) => {
      if (action === "focus") {
        textInputRef.current?.focus();
        return true;
      }

      if (action === "send" || action === "dictation-confirm") {
        if (isDictatingRef.current) {
          sendAfterTranscriptRef.current = true;
          confirmDictation();
          return true;
        }
        return false;
      }

      if (action === "voice-toggle") {
        handleToggleRealtimeVoiceShortcut();
        return true;
      }

      if (action === "voice-mute-toggle") {
        if (isRealtimeVoiceForCurrentAgent) {
          voice?.toggleMute();
        }
        return true;
      }

      if (action === "dictation-cancel") {
        if (isDictatingRef.current) {
          cancelDictation();
        }
        return true;
      }

      if (action === "dictation-toggle") {
        if (isDictatingRef.current) {
          sendAfterTranscriptRef.current = true;
          confirmDictation();
        } else {
          void startDictationIfAvailable();
        }
        return true;
      }

      return false;
    },
    getNativeElement: () => {
      if (!isWeb) return null;
      const current = textInputRef.current as (TextInput & { getNativeRef?: () => unknown }) | null;
      const native = typeof current?.getNativeRef === "function" ? current.getNativeRef() : current;
      return native instanceof HTMLElement ? native : null;
    },
  }));
  const inputHeightRef = useRef(MIN_INPUT_HEIGHT);
  const baselineInputHeightRef = useRef<number | null>(null);
  const overlayTransition = useSharedValue(0);
  const sendAfterTranscriptRef = useRef(false);
  const valueRef = useRef(value);
  const serverInfo = useSessionStore(
    useCallback(
      (state) => {
        if (!voiceServerId) {
          return null;
        }
        return state.sessions[voiceServerId]?.serverInfo ?? null;
      },
      [voiceServerId],
    ),
  );

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useEffect(() => {
    return () => {
      onFocusChange?.(false);
    };
  }, [onFocusChange]);

  // Autofocus on web when autoFocus is true, and re-run when focus key changes.
  useEffect(() => {
    if (!isWeb || !autoFocus) return;
    return focusWithRetries({
      focus: () => textInputRef.current?.focus(),
      isFocused: () => {
        const current = textInputRef.current as
          | (TextInput & { getNativeRef?: () => unknown })
          | null;
        const native =
          typeof current?.getNativeRef === "function" ? current.getNativeRef() : current;
        const element = native instanceof HTMLElement ? native : null;
        const active = typeof document !== "undefined" ? document.activeElement : null;
        return Boolean(element) && active === element;
      },
    });
  }, [autoFocus, autoFocusKey]);

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
        // Respect send behavior setting: when "queue", dictation queues too.
        if (defaultSendBehavior === "queue" && isAgentRunning && onQueue) {
          onQueue({ text: nextValue, images: imageAttachments });
          onChangeText("");
        } else {
          onSubmit({
            text: nextValue,
            images: imageAttachments,
            forceSend: isAgentRunning || undefined,
          });
        }
      } else {
        onChangeText(nextValue);
      }

      if (isWeb && typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => {
          measureWebInputHeight("dictation");
        });
      }
    },
    [onChangeText, onSubmit, onQueue, images, isAgentRunning, defaultSendBehavior],
  );

  const handleDictationError = useCallback(
    (error: Error) => {
      console.error("[MessageInput] Dictation error:", error);
      toast.error(error.message);
    },
    [toast],
  );

  const dictationUnavailableMessage = resolveVoiceUnavailableMessage({
    serverInfo,
    mode: "dictation",
  });

  const canStartDictation = useCallback(() => {
    const socketConnected = client?.isConnected ?? false;
    const readyForDictation = isReadyForDictation ?? socketConnected;
    return socketConnected && readyForDictation && !disabled && !dictationUnavailableMessage;
  }, [client, disabled, dictationUnavailableMessage, isReadyForDictation]);

  const canConfirmDictation = useCallback(() => {
    const socketConnected = client?.isConnected ?? false;
    return socketConnected;
  }, [client]);
  const isConnected = client?.isConnected ?? false;
  const isDictationStartEnabled = (isReadyForDictation ?? isConnected) && !disabled;

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
    autoStopWhenHidden: { isVisible: isInputActive },
    enableDuration: true,
  });

  const isDictatingRef = useRef(isDictating);
  useEffect(() => {
    isDictatingRef.current = isDictating;
  }, [isDictating]);

  const isRealtimeVoiceForCurrentAgent =
    !!voice &&
    !!voiceServerId &&
    !!voiceAgentId &&
    voice.isVoiceModeForAgent(voiceServerId, voiceAgentId);
  const showDictationOverlay = isDictating || isDictationProcessing || dictationStatus === "failed";
  const showRealtimeOverlay = isRealtimeVoiceForCurrentAgent;
  const showOverlay = showDictationOverlay || showRealtimeOverlay;

  useEffect(() => {
    if (isDictating || isDictationProcessing) {
      return;
    }
    sendAfterTranscriptRef.current = false;
  }, [dictationStatus, isDictating, isDictationProcessing]);

  const startDictationIfAvailable = useCallback(async () => {
    if (dictationUnavailableMessage) {
      isDictatingRef.current = false;
      toast.error(dictationUnavailableMessage);
      return;
    }
    // Keep hotkey toggling deterministic between the async start call and the
    // state-ref sync effect, so a rapid second toggle routes to confirm.
    isDictatingRef.current = true;
    await startDictation();
  }, [dictationUnavailableMessage, startDictation, toast]);

  // Animate overlay
  useEffect(() => {
    overlayTransition.value = withTiming(showOverlay ? 1 : 0, {
      duration: 200,
    });
  }, [overlayTransition, showOverlay]);

  const overlayAnimatedStyle = useAnimatedStyle(() => ({
    opacity: overlayTransition.value,
    pointerEvents: overlayTransition.value > 0.5 ? "auto" : "none",
  }));

  const inputAnimatedStyle = useAnimatedStyle(() => ({
    opacity: 1 - overlayTransition.value,
  }));

  const handleVoicePress = useCallback(async () => {
    if (isRealtimeVoiceForCurrentAgent && voice) {
      voice.toggleMute();
      return;
    }

    if (isDictating) {
      await cancelDictation();
    } else {
      await startDictationIfAvailable();
    }
  }, [
    cancelDictation,
    isDictating,
    isRealtimeVoiceForCurrentAgent,
    startDictationIfAvailable,
    voice,
  ]);

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

  const handleStopRealtimeVoice = useCallback(async () => {
    if (!voice || !isRealtimeVoiceForCurrentAgent) {
      return;
    }

    const tasks: Promise<unknown>[] = [];
    if (isAgentRunning && client && voiceAgentId) {
      tasks.push(client.cancelAgent(voiceAgentId));
    }
    tasks.push(voice.stopVoice());

    const results = await Promise.allSettled(tasks);
    results.forEach((result) => {
      if (result.status === "rejected") {
        console.error("[MessageInput] Failed to stop realtime voice", result.reason);
      }
    });
  }, [client, isAgentRunning, isRealtimeVoiceForCurrentAgent, voice, voiceAgentId]);

  const handleToggleRealtimeVoiceShortcut = useCallback(() => {
    if (!voice || !voiceServerId || !voiceAgentId || !isConnected || disabled) {
      return;
    }
    if (voice.isVoiceSwitching) {
      return;
    }
    if (voice.isVoiceModeForAgent(voiceServerId, voiceAgentId)) {
      void handleStopRealtimeVoice();
      return;
    }
    void voice.startVoice(voiceServerId, voiceAgentId).catch((error) => {
      console.error("[MessageInput] Failed to start realtime voice", error);
      const message =
        error instanceof Error ? error.message : typeof error === "string" ? error : null;
      if (message && message.trim().length > 0) {
        toast.error(message);
      }
    });
  }, [disabled, handleStopRealtimeVoice, isConnected, toast, voice, voiceAgentId, voiceServerId]);

  const handleSendMessage = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed && images.length === 0) return;
    const payload = {
      text: trimmed,
      images: images.length > 0 ? images : undefined,
      forceSend: isAgentRunning || undefined,
    };
    onSubmit(payload);
    inputHeightRef.current = MIN_INPUT_HEIGHT;
    setInputHeight(MIN_INPUT_HEIGHT);
    onHeightChange?.(MIN_INPUT_HEIGHT);
  }, [value, images, onSubmit, isAgentRunning, onHeightChange]);

  const handleQueueMessage = useCallback(() => {
    if (!onQueue) return;
    const trimmed = value.trim();
    if (!trimmed && images.length === 0) return;
    const payload = {
      text: trimmed,
      images: images.length > 0 ? images : undefined,
    };
    onQueue(payload);
    onChangeText("");
    inputHeightRef.current = MIN_INPUT_HEIGHT;
    setInputHeight(MIN_INPUT_HEIGHT);
    onHeightChange?.(MIN_INPUT_HEIGHT);
  }, [value, images, onQueue, onChangeText, onHeightChange]);

  // Default send action: respects the sendBehavior setting.
  // When "interrupt" (default), primary action sends immediately (interrupts).
  // When "queue", primary action queues when agent is running.
  const handleDefaultSendAction = useCallback(() => {
    if (defaultSendBehavior === "queue" && isAgentRunning && onQueue) {
      handleQueueMessage();
    } else {
      handleSendMessage();
    }
  }, [defaultSendBehavior, isAgentRunning, onQueue, handleQueueMessage, handleSendMessage]);

  // Alternate send action: always the opposite of the default.
  const handleAlternateSendAction = useCallback(() => {
    if (defaultSendBehavior === "queue") {
      handleSendMessage(); // interrupt
    } else if (onQueue) {
      handleQueueMessage(); // queue
    }
  }, [defaultSendBehavior, handleSendMessage, handleQueueMessage, onQueue]);

  // Web input height measurement
  function isTextAreaLike(v: unknown): v is TextAreaHandle {
    return typeof v === "object" && v !== null && "scrollHeight" in v;
  }

  const getWebTextArea = useCallback((): TextAreaHandle | null => {
    const ref = textInputRef.current;
    if (!ref) return null;
    if (typeof (ref as any).getNativeRef === "function") {
      const native = (ref as any).getNativeRef();
      if (isTextAreaLike(native)) return native;
    }
    if (isTextAreaLike(ref)) return ref;
    return null;
  }, []);

  const webTextareaRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (isWeb) {
      webTextareaRef.current = getWebTextArea() as HTMLElement | null;
    }
  }, [getWebTextArea]);

  const inputScrollbar = useWebElementScrollbar(webTextareaRef, {
    enabled: isWeb && inputHeight >= MAX_INPUT_HEIGHT,
  });

  const getWebElement = useCallback((target: "root" | "wrapper"): HTMLElement | null => {
    const ref = target === "root" ? rootRef.current : inputWrapperRef.current;
    if (!ref) return null;
    return ref instanceof HTMLElement
      ? ref
      : (ref as unknown as { getBoundingClientRect?: () => DOMRect }).getBoundingClientRect
        ? (ref as unknown as HTMLElement)
        : null;
  }, []);

  useEffect(() => {
    if (!isWeb || !onAddImages) {
      return;
    }

    const textarea = getWebTextArea();
    if (
      !textarea ||
      typeof (textarea as any).addEventListener !== "function" ||
      typeof (textarea as any).removeEventListener !== "function"
    ) {
      return;
    }

    let disposed = false;
    const handlePaste = (event: ClipboardEvent) => {
      if (!isConnected || disabled || isDictating || isRealtimeVoiceForCurrentAgent) {
        return;
      }

      const imageFiles = collectImageFilesFromClipboardData(event.clipboardData);
      if (imageFiles.length === 0) {
        return;
      }

      event.preventDefault();

      void filesToImageAttachments(imageFiles)
        .then((attachments) => {
          if (disposed || attachments.length === 0) {
            return;
          }
          onAddImages(attachments);
        })
        .catch((error) => {
          console.error("[MessageInput] Failed to process pasted images:", error);
        });
    };

    (textarea as any).addEventListener("paste", handlePaste);
    return () => {
      disposed = true;
      (textarea as any).removeEventListener("paste", handlePaste);
    };
  }, [
    disabled,
    getWebTextArea,
    isConnected,
    isDictating,
    isRealtimeVoiceForCurrentAgent,
    onAddImages,
  ]);

  useEffect(() => {
    if (!isWeb || typeof ResizeObserver === "undefined") {
      return;
    }

    const textarea = getWebTextArea();
    const root = getWebElement("root");
    const wrapper = getWebElement("wrapper");
    const observed = [
      { name: "composer_root", element: root },
      { name: "composer_wrapper", element: wrapper },
      { name: "composer_textarea", element: textarea as unknown as HTMLElement | null },
    ].filter(
      (entry): entry is { name: string; element: HTMLElement } =>
        entry.element instanceof HTMLElement,
    );

    if (observed.length === 0) {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const target = entry.target as HTMLElement;
        const match = observed.find((item) => item.element === target);
        if (!match) {
          continue;
        }
        const textareaNode = getWebTextArea();
        logWebStickyBottom("composer_element_resized", {
          target: match.name,
          width: target.clientWidth,
          height: target.clientHeight,
          offsetHeight: target.offsetHeight,
          scrollHeight: target.scrollHeight,
          textareaClientHeight: textareaNode?.clientHeight ?? null,
          textareaOffsetHeight: textareaNode?.offsetHeight ?? null,
          textareaScrollHeight: textareaNode?.scrollHeight ?? null,
          textareaScrollTop:
            (textareaNode as unknown as HTMLTextAreaElement | null)?.scrollTop ?? null,
          valueLength: valueRef.current.length,
        });
      }
    });

    for (const entry of observed) {
      observer.observe(entry.element);
    }

    return () => {
      observer.disconnect();
    };
  }, [getWebElement, getWebTextArea]);

  useEffect(() => {
    if (!isWeb) {
      return;
    }
    const textarea = getWebTextArea() as (HTMLTextAreaElement & TextAreaHandle) | null;
    if (!textarea || typeof textarea.addEventListener !== "function") {
      return;
    }

    const handleScroll = () => {
      const textareaElement = textarea as unknown as HTMLElement;
      const chatScroller =
        typeof document !== "undefined"
          ? (document.querySelector('[data-testid="agent-chat-scroll"]') as HTMLElement | null)
          : null;
      logWebStickyBottom("composer_textarea_scrolled", {
        now: getDebugNow(),
        scrollTop: textarea.scrollTop,
        clientHeight: textarea.clientHeight ?? null,
        scrollHeight: textarea.scrollHeight ?? null,
        selectionStart: textarea.selectionStart ?? null,
        selectionEnd: textarea.selectionEnd ?? null,
        textareaDescriptor: getElementDescriptor(textareaElement),
        chatScrollerDescriptor: getElementDescriptor(chatScroller),
        chatScrollerContainsTextarea: Boolean(
          chatScroller && textareaElement && chatScroller.contains(textareaElement),
        ),
        textareaScrollableAncestors: getScrollableAncestorChain(textareaElement),
        valueLength: valueRef.current.length,
      });
    };

    textarea.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      textarea.removeEventListener("scroll", handleScroll);
    };
  }, [getWebTextArea]);

  function measureWebInputHeight(source: string): boolean {
    if (!isWeb) return false;
    const textarea = getWebTextArea();
    if (!textarea || typeof textarea.scrollHeight !== "number") return false;
    const scrollHeight = textarea.scrollHeight ?? 0;

    if (baselineInputHeightRef.current === null && scrollHeight > 0) {
      baselineInputHeightRef.current = scrollHeight;
      logWebStickyBottom("composer_baseline_measured", {
        source,
        baseline: scrollHeight,
      });
    }

    const baseline = baselineInputHeightRef.current ?? MIN_INPUT_HEIGHT;
    const rawTarget = scrollHeight > 0 ? scrollHeight : baseline;
    const bounded = Math.max(MIN_INPUT_HEIGHT, Math.min(MAX_INPUT_HEIGHT, rawTarget));

    const previousHeight = inputHeightRef.current;
    if (Math.abs(previousHeight - bounded) >= 1) {
      inputHeightRef.current = bounded;
      setInputHeight(bounded);
      onHeightChange?.(bounded);
      logWebStickyBottom("composer_height_changed", {
        source,
        previousHeight,
        nextHeight: bounded,
        scrollHeight,
        clientHeight: textarea.clientHeight ?? null,
        offsetHeight: textarea.offsetHeight ?? null,
        baseline,
        rawTarget,
      });
      return true;
    }
    return false;
  }

  function setBoundedInputHeight(nextHeight: number) {
    const bounded = Math.max(MIN_INPUT_HEIGHT, Math.min(MAX_INPUT_HEIGHT, nextHeight));
    if (Math.abs(inputHeightRef.current - bounded) < 1) return;
    const previousHeight = inputHeightRef.current;
    inputHeightRef.current = bounded;
    setInputHeight(bounded);
    onHeightChange?.(bounded);
    logWebStickyBottom("composer_height_changed_native", {
      previousHeight,
      nextHeight: bounded,
    });
  }

  function handleContentSizeChange(
    event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>,
  ) {
    const contentHeight = event.nativeEvent.contentSize.height;
    if (isWeb) {
      logWebStickyBottom("composer_content_size_change", {
        reportedHeight: contentHeight,
      });
      if (baselineInputHeightRef.current === null && contentHeight > 0) {
        baselineInputHeightRef.current = contentHeight;
        logWebStickyBottom("composer_baseline_measured", {
          source: "contentSizeChange",
          baseline: contentHeight,
        });
      }
      setBoundedInputHeight(contentHeight);
      return;
    }
    setBoundedInputHeight(contentHeight);
  }

  function handleSelectionChange(event: NativeSyntheticEvent<TextInputSelectionChangeEventData>) {
    const start = event.nativeEvent.selection?.start ?? 0;
    const end = event.nativeEvent.selection?.end ?? start;
    if (isWeb) {
      const textarea = getWebTextArea();
      logWebStickyBottom("composer_selection_changed", {
        now: getDebugNow(),
        start,
        end,
        textareaScrollTop: textarea?.scrollTop ?? null,
        textareaClientHeight: textarea?.clientHeight ?? null,
        textareaScrollHeight: textarea?.scrollHeight ?? null,
      });
    }
    onSelectionChangeCallback?.({ start, end });
  }

  const shouldHandleDesktopSubmit = isWeb;

  function handleDesktopKeyPress(event: WebTextInputKeyPressEvent) {
    markScrollInvestigationEvent(investigationComponentId, "keyPress");
    if (!shouldHandleDesktopSubmit) return;

    // IME composition in progress (e.g. CJK input) — all key events belong to the
    // IME, not the app. keyCode 229 is a Chromium fallback for when isComposing is
    // cleared before the keydown fires.
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;

    // Allow parent to intercept key events (e.g., for autocomplete navigation)
    if (onKeyPressCallback) {
      const handled = onKeyPressCallback({
        key: event.nativeEvent.key,
        preventDefault: () => event.preventDefault(),
      });
      if (handled) return;
    }

    const { shiftKey, metaKey, ctrlKey } = event.nativeEvent;

    if (event.nativeEvent.key !== "Enter") return;

    // Shift+Enter: add newline (default behavior, don't intercept)
    if (shiftKey) return;

    // Cmd+Enter (Mac) or Ctrl+Enter (Windows/Linux): alternate action
    if ((metaKey || ctrlKey) && isAgentRunning && onQueue) {
      if (isSubmitDisabled || isSubmitLoading || disabled) return;
      event.preventDefault();
      handleAlternateSendAction();
      return;
    }

    // Enter: default send action (interrupt or queue, based on setting)
    if (isSubmitDisabled || isSubmitLoading || disabled) return;
    event.preventDefault();
    handleDefaultSendAction();
  }

  const hasImages = images.length > 0;
  const hasSendableContent = value.trim().length > 0 || hasImages;
  const shouldShowSendButton = hasSendableContent || isSubmitLoading;
  const canPressLoadingButton = isSubmitLoading && typeof onSubmitLoadingPress === "function";
  const isSendButtonDisabled =
    disabled || (!canPressLoadingButton && (isSubmitDisabled || isSubmitLoading));
  const defaultActionQueues = defaultSendBehavior === "queue" && isAgentRunning;
  const submitAccessibilityLabel = canPressLoadingButton
    ? "Interrupt agent"
    : defaultActionQueues
      ? "Queue message"
      : isAgentRunning
        ? "Send and interrupt"
        : "Send message";

  const handleInputChange = useCallback(
    (nextValue: string) => {
      markScrollInvestigationEvent(investigationComponentId, "inputChange");
      onChangeText(nextValue);
      if (isWeb) {
        logWebStickyBottom("composer_text_changed", {
          valueLength: nextValue.length,
          lineCount: nextValue.split("\n").length,
        });
      }
    },
    [investigationComponentId, onChangeText],
  );

  return (
    <View ref={rootRef} style={styles.container} testID="message-input-root">
      {/* Regular input */}
      <Animated.View ref={inputWrapperRef} style={[styles.inputWrapper, inputAnimatedStyle]}>
        {/* Image preview pills */}
        {hasImages && (
          <View style={styles.imagePreviewContainer} testID="message-input-image-preview">
            {images.map((image, index) => (
              <Pressable
                key={`${image.id}-${index}`}
                testID="message-input-image-pill"
                style={styles.imagePill}
                onPress={onRemoveImage ? () => onRemoveImage(index) : undefined}
              >
                {({ hovered }) => (
                  <>
                    <ImageAttachmentThumbnail image={image} />
                    {onRemoveImage && (
                      <View
                        style={[
                          styles.removeImageButton,
                          (hovered || !isWeb) && styles.removeImageButtonVisible,
                        ]}
                      >
                        <X size={theme.iconSize.md} color="white" />
                      </View>
                    )}
                  </>
                )}
              </Pressable>
            ))}
          </View>
        )}

        {/* Text input */}
        <View style={styles.textInputScrollWrapper}>
          <TextInput
            ref={textInputRef}
            value={value}
            onChangeText={handleInputChange}
            placeholder={placeholder}
            placeholderTextColor={theme.colors.surface4}
            accessibilityLabel="Message agent..."
            onFocus={() => {
              isInputFocusedRef.current = true;
              onFocusChange?.(true);
            }}
            onBlur={() => {
              isInputFocusedRef.current = false;
              onFocusChange?.(false);
            }}
            style={[
              styles.textInput,
              isWeb
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
            scrollEnabled={isWeb ? inputHeight >= MAX_INPUT_HEIGHT : true}
            onContentSizeChange={handleContentSizeChange}
            editable={!isDictating && !isRealtimeVoiceForCurrentAgent && !disabled}
            onKeyPress={shouldHandleDesktopSubmit ? handleDesktopKeyPress : undefined}
            onSelectionChange={handleSelectionChange}
            autoFocus={isWeb && autoFocus}
          />
          {inputScrollbar}
        </View>

        {/* Button row */}
        <View style={styles.buttonRow}>
          {/* Left: attachment button + leftContent slot */}
          <View style={styles.leftButtonGroup}>
            {onPickImages && (
              <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
                <TooltipTrigger asChild>
                  <Pressable
                    onPress={onPickImages}
                    disabled={!isConnected || disabled}
                    accessibilityLabel="Attach images"
                    accessibilityRole="button"
                    style={({ hovered }) => [
                      styles.attachButton,
                      hovered && styles.iconButtonHovered,
                      (!isConnected || disabled) && styles.buttonDisabled,
                    ]}
                  >
                    <Paperclip size={buttonIconSize} color={theme.colors.foreground} />
                  </Pressable>
                </TooltipTrigger>
                <TooltipContent side="top" align="center" offset={8}>
                  <Text style={styles.tooltipText}>Attach images</Text>
                </TooltipContent>
              </Tooltip>
            )}
            {leftContent}
          </View>

          {/* Right: voice button, contextual button (realtime/send/cancel) */}
          <View style={styles.rightButtonGroup}>
            {beforeVoiceContent}
            <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
              <TooltipTrigger
                onPress={handleVoicePress}
                disabled={!isDictationStartEnabled}
                accessibilityRole="button"
                accessibilityLabel={
                  isRealtimeVoiceForCurrentAgent
                    ? voice?.isMuted
                      ? "Unmute Voice mode"
                      : "Mute Voice mode"
                    : isDictating
                      ? "Stop dictation"
                      : "Start dictation"
                }
                style={({ hovered }) => [
                  styles.voiceButton,
                  hovered && !isDictating && styles.iconButtonHovered,
                  !isDictationStartEnabled && styles.buttonDisabled,
                  isDictating && styles.voiceButtonRecording,
                ]}
              >
                {isDictating ? (
                  <Square size={buttonIconSize} color="white" fill="white" />
                ) : isRealtimeVoiceForCurrentAgent && voice?.isMuted ? (
                  <MicOff size={buttonIconSize} color={theme.colors.foreground} />
                ) : (
                  <Mic size={buttonIconSize} color={theme.colors.foreground} />
                )}
              </TooltipTrigger>
              <TooltipContent side="top" align="center" offset={8}>
                <View style={styles.tooltipRow}>
                  <Text style={styles.tooltipText}>
                    {isRealtimeVoiceForCurrentAgent
                      ? voice?.isMuted
                        ? "Unmute voice"
                        : "Mute voice"
                      : "Dictation"}
                  </Text>
                  {(isRealtimeVoiceForCurrentAgent ? voiceMuteToggleKeys : dictationToggleKeys) ? (
                    <Shortcut
                      chord={
                        (isRealtimeVoiceForCurrentAgent
                          ? voiceMuteToggleKeys
                          : dictationToggleKeys)!
                      }
                      style={styles.tooltipShortcut}
                    />
                  ) : null}
                </View>
              </TooltipContent>
            </Tooltip>
            {rightContent}
            {hasSendableContent && isAgentRunning && onQueue && !defaultActionQueues && (
              <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
                <TooltipTrigger
                  onPress={handleAlternateSendAction}
                  disabled={!isConnected || disabled}
                  accessibilityLabel="Queue message"
                  accessibilityRole="button"
                  style={({ hovered }) => [
                    styles.queueButton,
                    hovered && styles.iconButtonHovered,
                    (!isConnected || disabled) && styles.buttonDisabled,
                  ]}
                >
                  <Plus size={buttonIconSize} color="white" />
                </TooltipTrigger>
                <TooltipContent side="top" align="center" offset={8}>
                  <View style={styles.tooltipRow}>
                    <Text style={styles.tooltipText}>Queue</Text>
                    {queueKeys ? (
                      <Shortcut chord={queueKeys} style={styles.tooltipShortcut} />
                    ) : null}
                  </View>
                </TooltipContent>
              </Tooltip>
            )}
            {shouldShowSendButton && (
              <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
                <TooltipTrigger
                  onPress={canPressLoadingButton ? onSubmitLoadingPress : handleDefaultSendAction}
                  disabled={isSendButtonDisabled}
                  accessibilityLabel={submitAccessibilityLabel}
                  accessibilityRole="button"
                  style={[styles.sendButton, isSendButtonDisabled && styles.buttonDisabled]}
                >
                  {isSubmitLoading ? (
                    <ActivityIndicator size="small" color="white" />
                  ) : (
                    <ArrowUp size={buttonIconSize} color="white" />
                  )}
                </TooltipTrigger>
                <TooltipContent side="top" align="center" offset={8}>
                  <View style={styles.tooltipRow}>
                    <Text style={styles.tooltipText}>{defaultActionQueues ? "Queue" : "Send"}</Text>
                    {sendKeys ? <Shortcut chord={sendKeys} style={styles.tooltipShortcut} /> : null}
                  </View>
                </TooltipContent>
              </Tooltip>
            )}
          </View>
        </View>
      </Animated.View>

      {/* Dictation overlay */}
      <Animated.View style={[styles.overlayContainer, overlayAnimatedStyle]}>
        {showDictationOverlay ? (
          <DictationOverlay
            volume={dictationVolume}
            duration={dictationDuration}
            isRecording={isDictating}
            isProcessing={isDictationProcessing}
            status={dictationStatus}
            errorText={dictationStatus === "failed" ? (dictationError ?? undefined) : undefined}
            onCancel={handleCancelRecording}
            onAccept={handleAcceptRecording}
            onAcceptAndSend={handleAcceptAndSendRecording}
            onRetry={dictationStatus === "failed" ? handleRetryFailedRecording : undefined}
            onDiscard={dictationStatus === "failed" ? handleDiscardFailedRecording : undefined}
          />
        ) : showRealtimeOverlay && voice ? (
          <RealtimeVoiceOverlay
            isMuted={voice.isMuted}
            isSwitching={voice.isVoiceSwitching}
            onToggleMute={voice.toggleMute}
            onStop={() => {
              void handleStopRealtimeVoice();
            }}
          />
        ) : null}
      </Animated.View>
    </View>
  );
});

const styles = StyleSheet.create(((theme: any) => ({
  container: {
    position: "relative",
  },
  inputWrapper: {
    flexDirection: "column",
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface1,
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
    ...(isWeb
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
    ...(isWeb
      ? {
          cursor: "pointer",
        }
      : {}),
  },
  imageThumbnail: {
    width: 48,
    height: 48,
  },
  imageThumbnailPlaceholder: {
    width: 48,
    height: 48,
    backgroundColor: theme.colors.surface2,
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
    ...(isWeb
      ? {
          transitionProperty: "opacity",
          transitionDuration: "150ms",
        }
      : {}),
  },
  removeImageButtonVisible: {
    opacity: 1,
  },
  textInputScrollWrapper: {
    position: "relative",
  },
  textInput: {
    width: "100%",
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    lineHeight: theme.fontSize.base * 1.4,
    ...(isWeb
      ? {
          outlineStyle: "none" as const,
          outlineWidth: 0,
          outlineColor: "transparent",
        }
      : {}),
  },
  buttonRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
  },
  leftButtonGroup: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: theme.spacing[1],
  },
  rightButtonGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: isWeb ? theme.spacing[2] : theme.spacing[1],
  },
  attachButton: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  voiceButton: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  voiceButtonRecording: {
    backgroundColor: theme.colors.destructive,
  },
  queueButton: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface1,
    alignItems: "center",
    justifyContent: "center",
  },
  sendButton: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  iconButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  tooltipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  tooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.popoverForeground,
  },
  tooltipShortcut: {
    backgroundColor: theme.colors.surface3,
    borderColor: theme.colors.borderAccent,
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
