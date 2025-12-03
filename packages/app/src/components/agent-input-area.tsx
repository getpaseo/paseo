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
import { useState, useEffect, useRef, useLayoutEffect, useCallback, useMemo } from "react";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Mic, ArrowUp, AudioLines, Square, Paperclip, X, Pencil } from "lucide-react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  FadeIn,
  FadeOut,
} from "react-native-reanimated";
import { useRealtime } from "@/contexts/realtime-context";
import { useDictation } from "@/hooks/use-dictation";
import { FOOTER_HEIGHT } from "@/contexts/footer-controls-context";
import { VoiceNoteRecordingOverlay } from "./voice-note-recording-overlay";
import { DictationStatusNotice, type DictationToastVariant } from "./dictation-status-notice";
import { generateMessageId } from "@/types/stream";
import { AgentStatusBar } from "./agent-status-bar";
import { RealtimeControls } from "./realtime-controls";
import { useImageAttachmentPicker } from "@/hooks/use-image-attachment-picker";
import { AUDIO_DEBUG_ENABLED } from "@/config/audio-debug";
import { AudioDebugNotice, type AudioDebugInfo } from "./audio-debug-notice";
import { useSessionStore } from "@/stores/session-store";
import type { UseWebSocketReturn } from "@/hooks/use-websocket";
import type { SessionOutboundMessage } from "@server/server/messages";

type QueuedMessage = {
  id: string;
  text: string;
  images?: Array<{ uri: string; mimeType: string }>;
};

interface AgentInputAreaProps {
  agentId: string;
  serverId: string;
}

const MIN_INPUT_HEIGHT = 50;
const MAX_INPUT_HEIGHT = 160;
const EMPTY_ARRAY: readonly QueuedMessage[] = [];
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

type DictationToastConfig = {
  variant: DictationToastVariant;
  title: string;
  subtitle?: string;
  meta?: string;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss?: () => void;
};

export function AgentInputArea({ agentId, serverId }: AgentInputAreaProps) {
  const { theme } = useUnistyles();

  // [INVESTIGATION] Using granular selectors for WebSocket connection status
  const ws = useSessionStore((state) => state.sessions[serverId]?.ws);

  // [INVESTIGATION] Select only the specific agent (not all agents)
  const agent = useSessionStore((state) =>
    state.sessions[serverId]?.agents?.get(agentId)
  );

  // [INVESTIGATION] Get draft input - drafts are at TOP LEVEL (not in session)
  const getDraftInput = useSessionStore((state) => state.getDraftInput);
  const saveDraftInput = useSessionStore((state) => state.saveDraftInput);

  // [INVESTIGATION] Get queued messages for this agent - use stable empty array
  const queuedMessagesRaw = useSessionStore((state) =>
    state.sessions[serverId]?.queuedMessages?.get(agentId)
  );
  const queuedMessages = queuedMessagesRaw ?? EMPTY_ARRAY;

  // [INVESTIGATION] Get methods
  const methods = useSessionStore((state) => state.sessions[serverId]?.methods);
  const sendAgentMessage = methods?.sendAgentMessage;
  const cancelAgentRun = methods?.cancelAgentRun;

  // [INVESTIGATION] Use store action directly for setQueuedMessages
  const setQueuedMessages = useSessionStore((state) => state.setQueuedMessages);

  // Noop fallback for sendAgentAudio (required by useDictation)
  const noopSendAgentAudio = useCallback(async () => {}, []);
  const sendAgentAudio = methods?.sendAgentAudio ?? noopSendAgentAudio;

  // Inert WebSocket fallback for when ws is undefined
  const inertWebSocket = useMemo<UseWebSocketReturn>(
    () => ({
      isConnected: false,
      isConnecting: false,
      conversationId: null,
      lastError: null,
      send: () => {},
      on: () => () => {},
      sendPing: () => {},
      sendUserMessage: () => {},
      subscribeConnectionStatus: () => () => {},
      getConnectionState: () => ({ isConnected: false, isConnecting: false }),
    }),
    []
  );

  const wsOrInert = ws ?? inertWebSocket;
  const { startRealtime, stopRealtime, isRealtimeMode } = useRealtime();
  
  const [userInput, setUserInput] = useState("");
  const [inputHeight, setInputHeight] = useState(MIN_INPUT_HEIGHT);
  const [isProcessing, setIsProcessing] = useState(false);
  const [selectedImages, setSelectedImages] = useState<Array<{ uri: string; mimeType: string }>>([]);
  const [isCancellingAgent, setIsCancellingAgent] = useState(false);
  const [audioDebugInfo, setAudioDebugInfo] = useState<AudioDebugInfo | null>(null);
  const [connectionStatus, setConnectionStatus] = useState(() =>
    wsOrInert.getConnectionState ? wsOrInert.getConnectionState() : { isConnected: wsOrInert.isConnected, isConnecting: wsOrInert.isConnecting }
  );
  const [lastSuccessToastAt, setLastSuccessToastAt] = useState<number | null>(null);
  
  const textInputRef = useRef<TextInput | (TextInput & { getNativeRef?: () => unknown }) | null>(null);
  const inputHeightRef = useRef(MIN_INPUT_HEIGHT);
  const baselineInputHeightRef = useRef<number | null>(null);
  const overlayTransition = useSharedValue(0);
  const { pickImages } = useImageAttachmentPicker();
  const shouldShowAudioDebug = AUDIO_DEBUG_ENABLED;
  const agentIdRef = useRef(agentId);
  const sendAgentMessageRef = useRef(sendAgentMessage);
  const agentStatusRef = useRef<string | undefined>(undefined);
  const updateQueueRef = useRef<
    ((updater: (current: QueuedMessage[]) => QueuedMessage[]) => void) | null
  >(null);
  const handleDictationTranscript = useCallback(
    (text: string) => {
      if (!text) {
        return;
      }
      const shouldQueue = agentStatusRef.current === "running";
      if (shouldQueue) {
        updateQueueRef.current?.((current) => [
          ...current,
          {
            id: generateMessageId(),
            text,
          },
        ]);
        return;
      }
      void (async () => {
        try {
          await sendAgentMessageRef.current?.(agentIdRef.current, text);
        } catch (error) {
          console.error("[AgentInput] Failed to send transcribed message:", error);
          updateQueueRef.current?.((current) => [
            ...current,
            {
              id: generateMessageId(),
              text,
            },
          ]);
        }
      })();
    },
    []
  );

  const handleDictationError = useCallback((error: Error) => {
    console.error("[AgentInput] Dictation error:", error);
  }, []);

  const canStartDictation = useCallback(() => {
    const socketConnected = wsOrInert.getConnectionState ? wsOrInert.getConnectionState().isConnected : wsOrInert.isConnected;
    const allowed = !isRealtimeMode && socketConnected;
    console.log("[AgentInput] canStartDictation", {
      allowed,
      isRealtimeMode,
      wsConnected: socketConnected,
    });
    return allowed;
  }, [isRealtimeMode, wsOrInert]);

  const canConfirmDictation = useCallback(() => {
    const socketConnected = wsOrInert.getConnectionState ? wsOrInert.getConnectionState().isConnected : wsOrInert.isConnected;
    const allowed = socketConnected;
    console.log("[AgentInput] canConfirmDictation", {
      allowed,
      wsConnected: socketConnected,
    });
    return allowed;
  }, [wsOrInert]);

  const {
    isRecording: isDictating,
    isProcessing: isDictationProcessing,
    volume: dictationVolume,
    duration: dictationDuration,
    pendingRequestId: dictationPendingRequestId,
    error: dictationError,
    status: dictationStatus,
    retryAttempt: dictationRetryAttempt,
    maxRetryAttempts: dictationMaxRetryAttempts,
    retryInfo: dictationRetryInfo,
    lastOutcome: dictationLastOutcome,
    startDictation,
    cancelDictation,
    confirmDictation,
    retryFailedDictation,
    discardFailedDictation,
  } = useDictation({
    agentId,
    sendAgentAudio,
    ws: wsOrInert,
    mode: "transcribe_only",
    onTranscript: handleDictationTranscript,
    onError: handleDictationError,
    canStart: canStartDictation,
    canConfirm: canConfirmDictation,
    enableDuration: true,
  });

  const dictationRequestIdRef = useRef<string | null>(null);
  useEffect(() => {
    dictationRequestIdRef.current = dictationPendingRequestId;
  }, [dictationPendingRequestId]);

  useEffect(() => {
    if (!wsOrInert.subscribeConnectionStatus) {
      return;
    }
    return wsOrInert.subscribeConnectionStatus((status) => {
      setConnectionStatus(status);
    });
  }, [wsOrInert]);

  useEffect(() => {
    if (dictationLastOutcome?.type === "success") {
      setLastSuccessToastAt(dictationLastOutcome.timestamp);
    }
  }, [dictationLastOutcome]);

  useEffect(() => {
    if (lastSuccessToastAt === null) {
      return;
    }
    const timeout = setTimeout(() => {
      setLastSuccessToastAt(null);
    }, 4000);
    return () => {
      clearTimeout(timeout);
    };
  }, [lastSuccessToastAt]);

  const successToastVisible = lastSuccessToastAt !== null;

  const handleRetryFailedRecording = useCallback(() => {
    void retryFailedDictation();
  }, [retryFailedDictation]);

  const handleDiscardFailedRecording = useCallback(() => {
    discardFailedDictation();
  }, [discardFailedDictation]);

  const dictationToast = useMemo<DictationToastConfig | null>(() => {
    console.log('[AgentInputArea] Connection status:', {
      isConnected: connectionStatus.isConnected,
      wsIsConnected: wsOrInert.isConnected,
      wsIsConnecting: wsOrInert.isConnecting,
      hasWs: !!ws,
    });

    if (!connectionStatus.isConnected) {
      return {
        variant: "warning",
        title: "Offline",
        subtitle: "Waiting for connection…",
      };
    }

    if (dictationStatus === "recording") {
      return {
        variant: "info",
        title: "Recording voice note…",
        subtitle: "Release to transcribe",
      };
    }

    if (dictationStatus === "uploading") {
      const attemptLabel = `Attempt ${Math.max(1, dictationRetryAttempt || 1)}/${dictationMaxRetryAttempts}`;
      return {
        variant: "info",
        title: "Transcribing…",
        meta: attemptLabel,
      };
    }

    if (dictationStatus === "retrying") {
      const attempt = dictationRetryInfo?.attempt ?? Math.max(1, dictationRetryAttempt || 1);
      const maxAttempts = dictationRetryInfo?.maxAttempts ?? dictationMaxRetryAttempts;
      const nextLabel =
        dictationRetryInfo?.nextRetryMs && dictationRetryInfo.nextRetryMs > 0
          ? ` · Next in ${Math.ceil(dictationRetryInfo.nextRetryMs / 1000)}s`
          : "";
      return {
        variant: "warning",
        title: "Retrying dictation…",
        subtitle: dictationRetryInfo?.errorMessage ?? dictationError ?? "Network error",
        meta: `Attempt ${attempt}/${maxAttempts}${nextLabel}`,
      };
    }

    if (dictationStatus === "failed") {
      return {
        variant: "error",
        title: "Dictation failed",
        subtitle: dictationRetryInfo?.errorMessage ?? dictationError ?? "Unknown error",
        actionLabel: "Retry",
        onAction: handleRetryFailedRecording,
        onDismiss: handleDiscardFailedRecording,
      };
    }

    if (successToastVisible) {
      return {
        variant: "success",
        title: "Transcribed",
        subtitle: "Added to chat",
      };
    }

    return null;
  }, [
    connectionStatus.isConnected,
    dictationError,
    dictationMaxRetryAttempts,
    dictationRetryAttempt,
    dictationRetryInfo,
    dictationStatus,
    handleDiscardFailedRecording,
    handleRetryFailedRecording,
    successToastVisible,
  ]);

  useEffect(() => {
    const shouldShowOverlay = isDictating || isDictationProcessing || dictationStatus === "failed";
    overlayTransition.value = withTiming(shouldShowOverlay ? 1 : 0, { duration: 250 });
  }, [dictationStatus, isDictating, isDictationProcessing, overlayTransition]);

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
    const socketConnected = wsOrInert.getConnectionState ? wsOrInert.getConnectionState().isConnected : wsOrInert.isConnected;
    if (!userInput.trim() || !socketConnected || !sendAgentMessage) return;

    const message = userInput.trim();
    const imageAttachments = selectedImages.length > 0 ? selectedImages : undefined;
    
    setUserInput("");
    setSelectedImages([]);
    setInputHeight(MIN_INPUT_HEIGHT);
    setIsProcessing(true);

    try {
      await sendAgentMessage(agentIdRef.current, message, imageAttachments);
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
    console.log("[AgentInput] handleVoicePress", {
      isDictating,
      isRealtimeMode,
      wsConnected: wsOrInert.isConnected,
    });
    if (isDictating || isRealtimeMode) {
      return;
    }

    if (shouldShowAudioDebug) {
      setAudioDebugInfo(null);
    }

    try {
      await startDictation();
      console.log("[AgentInput] startDictation invoked");
    } catch (error) {
      const isCancelled =
        error instanceof Error && error.message.includes("Recording cancelled");
      if (!isCancelled) {
        console.error("[AgentInput] Failed to start recording:", error);
      }
    }
  }

  async function handleCancelRecording() {
    console.log("[AgentInput] handleCancelRecording", {
      isDictating,
      isDictationProcessing,
    });
    if (dictationStatus === "failed") {
      handleDiscardFailedRecording();
      return;
    }
    if (!isDictating && !isDictationProcessing) {
      return;
    }
    try {
      await cancelDictation();
    } catch (error) {
      console.error("[AgentInput] Failed to cancel recording:", error);
    }
  }

  async function handleSendRecording() {
    console.log("[AgentInput] handleSendRecording", {
      isDictating,
      isDictationProcessing,
    });
    if (dictationStatus === "failed") {
      handleRetryFailedRecording();
      return;
    }
    if (!isDictating) {
      return;
    }
    try {
      await confirmDictation();
    } catch (error) {
      console.error("[AgentInput] Failed to send recording:", error);
    }
  }

  useEffect(() => {
    if (!shouldShowAudioDebug) {
      return;
    }
    const unsubscribe = wsOrInert.on("transcription_result", (message: SessionOutboundMessage) => {
      if (message.type !== "transcription_result") {
        return;
      }

      const pendingRequestId = dictationRequestIdRef.current;
      if (!pendingRequestId || message.payload.requestId !== pendingRequestId) {
        return;
      }

      dictationRequestIdRef.current = null;
      setAudioDebugInfo({
        requestId: pendingRequestId,
        transcript: message.payload.text?.trim(),
        debugRecordingPath: message.payload.debugRecordingPath ?? undefined,
        format: message.payload.format,
        byteLength: message.payload.byteLength,
        duration: message.payload.duration,
        avgLogprob: message.payload.avgLogprob,
        isLowConfidence: message.payload.isLowConfidence,
      });
    });

    return () => {
      unsubscribe();
    };
  }, [shouldShowAudioDebug, wsOrInert]);

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

  const isAgentRunning = agent?.status === "running";
  agentStatusRef.current = agent?.status;
  const hasText = userInput.trim().length > 0;
  const hasImages = selectedImages.length > 0;
  const hasSendableContent = hasText || hasImages;
  const shouldShowSendButton = !isAgentRunning && hasSendableContent;
  const shouldShowVoiceControls = !hasSendableContent;
  const shouldHandleDesktopSubmit = IS_WEB;

  const updateQueue = useCallback(
    (updater: (current: QueuedMessage[]) => QueuedMessage[]) => {
      setQueuedMessages(serverId, (prev: Map<string, QueuedMessage[]>) => {
        const next = new Map(prev);
        next.set(agentId, updater(prev.get(agentId) ?? []));
        return next;
      });
    },
    [agentId, serverId, setQueuedMessages],
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
      if (!hasSendableContent || !wsOrInert.isConnected) {
        return;
      }
      handleQueueCurrentInput();
      return;
    }
    if (!shouldShowSendButton || isProcessing || !wsOrInert.isConnected) {
      return;
    }
    void handleSendMessage();
  }

  useEffect(() => {
    if (!isAgentRunning || !wsOrInert.isConnected) {
      setIsCancellingAgent(false);
    }
  }, [isAgentRunning, wsOrInert.isConnected]);

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

        if (isDictating) {
          void handleSendRecording();
          return;
        }

        if (!isRealtimeMode && shouldShowVoiceControls && wsOrInert.isConnected) {
          void handleVoicePress();
        }
        return;
      }

      if (key === "escape" && isDictating) {
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
    isDictating,
    isRealtimeMode,
    shouldShowVoiceControls,
    wsOrInert,
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
    const existingImages: Array<{ uri: string; mimeType?: string }> = existing?.images ?? [];
    const isSameImages =
      existingImages.length === selectedImages.length &&
      existingImages.every((img: { uri: string; mimeType?: string }, idx: number) => {
        return img.uri === selectedImages[idx]?.uri && img.mimeType === selectedImages[idx]?.mimeType;
      });

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
        if (!wsOrInert.isConnected || !serverId) {
          return;
        }
        await startRealtime(serverId);
      }
    } catch (error) {
      console.error("[AgentInput] Failed to toggle realtime mode:", error);
    }
  }

  function handleCancelAgent() {
    if (!agent || agent.status !== "running" || isCancellingAgent) {
      return;
    }
    if (!wsOrInert.isConnected || !cancelAgentRun) {
      return;
    }
    setIsCancellingAgent(true);
    cancelAgentRun(agentIdRef.current);
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
    if (!item || !wsOrInert.isConnected || !sendAgentMessage) return;

    updateQueue((current) => current.filter((q) => q.id !== id));

    // Cancels current agent run before sending queued prompt
    handleCancelAgent();
    await sendAgentMessage(agentIdRef.current, item.text, item.images);
  }

  const realtimeButton = (
    <Pressable
      onPress={handleRealtimePress}
      disabled={!wsOrInert.isConnected && !isRealtimeMode}
      style={[
        styles.realtimeButton as any,
        (isRealtimeMode ? styles.realtimeButtonActive : undefined) as any,
        (!wsOrInert.isConnected && !isRealtimeMode ? styles.buttonDisabled : undefined) as any,
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
      disabled={!wsOrInert.isConnected || isRealtimeMode}
      style={[
        styles.voiceButton as any,
        (!wsOrInert.isConnected || isRealtimeMode ? styles.buttonDisabled : undefined) as any,
        (isDictating ? styles.voiceButtonRecording : undefined) as any,
      ]}
    >
      {isDictating ? (
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
            editable={!isDictating && wsOrInert.isConnected}
            onKeyPress={shouldHandleDesktopSubmit ? handleDesktopSubmitKeyPress : undefined}
          />

          {/* Button row below input */}
          <View style={styles.buttonRow}>
            {/* Left button group */}
            <View style={styles.leftButtonGroup}>
              <Pressable
                onPress={handlePickImage}
                disabled={!wsOrInert.isConnected}
                style={[
                  styles.attachButton as any,
                  (!wsOrInert.isConnected ? styles.buttonDisabled : undefined) as any,
                ]}
              >
                <Paperclip size={20} color={theme.colors.foreground} />
              </Pressable>
              <AgentStatusBar agentId={agentId} serverId={serverId} />
            </View>

            {/* Right button group */}
            <View style={styles.rightButtonGroup}>
              {isAgentRunning ? (
                <>
                  {shouldShowVoiceControls && voiceButton}
                  {hasSendableContent && (
                    <Pressable
                      onPress={handleQueueCurrentInput}
                      disabled={!wsOrInert.isConnected}
                      accessibilityLabel="Queue message while agent is running"
                      accessibilityRole="button"
                      style={[
                        styles.queueButton as any,
                        (!wsOrInert.isConnected ? styles.buttonDisabled : undefined) as any,
                      ]}
                    >
                      <ArrowUp size={20} color="white" />
                    </Pressable>
                  )}
                  {realtimeButton}
                  <Pressable
                    onPress={handleCancelAgent}
                    disabled={!wsOrInert.isConnected || isCancellingAgent}
                    accessibilityLabel={isCancellingAgent ? "Canceling agent" : "Stop agent"}
                    accessibilityRole="button"
                    style={[
                      styles.cancelButton as any,
                      (!wsOrInert.isConnected || isCancellingAgent ? styles.buttonDisabled : undefined) as any,
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
                  disabled={!wsOrInert.isConnected || isProcessing}
                style={[
                  styles.sendButton as any,
                  (!wsOrInert.isConnected || isProcessing ? styles.buttonDisabled : undefined) as any,
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
              volume={dictationVolume}
              duration={dictationDuration}
              onCancel={handleCancelRecording}
              onSend={handleSendRecording}
              isTranscribing={isDictationProcessing}
              status={dictationStatus}
              onRetry={dictationStatus === "failed" ? handleRetryFailedRecording : undefined}
              onDiscardFailed={dictationStatus === "failed" ? handleDiscardFailedRecording : undefined}
            />
          </View>
        </Animated.View>
      </View>
      {dictationToast ? (
        <View style={styles.dictationToastPortal} pointerEvents="box-none">
          <View pointerEvents="auto">
            <DictationStatusNotice {...dictationToast} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create(((theme: any) => ({
  container: {
    flexDirection: "column",
    position: "relative",
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
    alignItems: "center",
    paddingBottom: theme.spacing[4],
  },
  dictationToastPortal: {
    position: "absolute",
    left: theme.spacing[4],
    right: theme.spacing[4],
    bottom: theme.spacing[4],
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
