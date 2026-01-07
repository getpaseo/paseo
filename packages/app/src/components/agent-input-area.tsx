import {
  View,
  Pressable,
  Platform,
  Text,
  ActivityIndicator,
} from "react-native";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ArrowUp, AudioLines, Square, Pencil } from "lucide-react-native";
import Animated, {
  useAnimatedStyle,
  FadeIn,
  FadeOut,
} from "react-native-reanimated";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRealtime } from "@/contexts/realtime-context";
import { FOOTER_HEIGHT } from "@/constants/layout";
import { generateMessageId } from "@/types/stream";
import { AgentStatusBar } from "./agent-status-bar";
import { RealtimeControls } from "./realtime-controls";
import { useImageAttachmentPicker } from "@/hooks/use-image-attachment-picker";
import { useSessionStore } from "@/stores/session-store";
import {
  MessageInput,
  type MessagePayload,
  type ImageAttachment,
} from "./message-input";
import type { UseWebSocketReturn } from "@/hooks/use-websocket";
import { Theme } from "@/styles/theme";

type QueuedMessage = {
  id: string;
  text: string;
  images?: ImageAttachment[];
};

interface AgentInputAreaProps {
  agentId: string;
  serverId: string;
  onSubmitMessage?: (payload: MessagePayload) => Promise<void>;
  /** Externally controlled loading state. When true, disables the submit button. */
  isSubmitLoading?: boolean;
  value?: string;
  onChangeText?: (text: string) => void;
  /** When true, auto-focuses the text input on web. */
  autoFocus?: boolean;
  /** Callback to expose the addImages function to parent components */
  onAddImages?: (addImages: (images: ImageAttachment[]) => void) => void;
}

const EMPTY_ARRAY: readonly QueuedMessage[] = [];
const MAX_INPUT_WIDTH = 960;
// Android currently crashes inside ViewGroup.dispatchDraw when running Reanimated
// entering/exiting animations (see react-native-reanimated#8422), so guard them.
const SHOULD_DISABLE_ENTRY_EXIT_ANIMATIONS = Platform.OS === "android";
const REALTIME_FADE_IN = SHOULD_DISABLE_ENTRY_EXIT_ANIMATIONS
  ? undefined
  : FadeIn.duration(250);
const REALTIME_FADE_OUT = SHOULD_DISABLE_ENTRY_EXIT_ANIMATIONS
  ? undefined
  : FadeOut.duration(250);

export function AgentInputArea({
  agentId,
  serverId,
  onSubmitMessage,
  isSubmitLoading = false,
  value,
  onChangeText,
  autoFocus = false,
  onAddImages,
}: AgentInputAreaProps) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const { height: keyboardHeight } = useReanimatedKeyboardAnimation();

  const ws = useSessionStore((state) => state.sessions[serverId]?.ws);

  const agent = useSessionStore((state) =>
    state.sessions[serverId]?.agents?.get(agentId)
  );

  const getDraftInput = useSessionStore((state) => state.getDraftInput);
  const saveDraftInput = useSessionStore((state) => state.saveDraftInput);

  const queuedMessagesRaw = useSessionStore((state) =>
    state.sessions[serverId]?.queuedMessages?.get(agentId)
  );
  const queuedMessages = queuedMessagesRaw ?? EMPTY_ARRAY;

  const methods = useSessionStore((state) => state.sessions[serverId]?.methods);
  const sendAgentMessage = methods?.sendAgentMessage;
  const cancelAgentRun = methods?.cancelAgentRun;

  const setQueuedMessages = useSessionStore((state) => state.setQueuedMessages);

  // Noop fallback for sendAgentAudio (required by MessageInput)
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
      clearAgentAttention: () => {},
      subscribeConnectionStatus: () => () => {},
      getConnectionState: () => ({ isConnected: false, isConnecting: false }),
    }),
    []
  );

  const wsOrInert = ws ?? inertWebSocket;
  const { startRealtime, stopRealtime, isRealtimeMode } = useRealtime();

  const [internalInput, setInternalInput] = useState("");
  const userInput = value ?? internalInput;
  const setUserInput = onChangeText ?? setInternalInput;
  const [isProcessing, setIsProcessing] = useState(false);
  const [selectedImages, setSelectedImages] = useState<ImageAttachment[]>([]);
  const [isCancellingAgent, setIsCancellingAgent] = useState(false);

  const { pickImages } = useImageAttachmentPicker();
  const agentIdRef = useRef(agentId);
  const sendAgentMessageRef = useRef(sendAgentMessage);
  const onSubmitMessageRef = useRef(onSubmitMessage);

  // Expose addImages function to parent for drag-and-drop support
  const addImages = useCallback((images: ImageAttachment[]) => {
    setSelectedImages((prev) => [...prev, ...images]);
  }, []);

  useEffect(() => {
    onAddImages?.(addImages);
  }, [addImages, onAddImages]);

  const submitMessage = useCallback(
    async (text: string, images?: ImageAttachment[]) => {
      if (onSubmitMessageRef.current) {
        await onSubmitMessageRef.current({ text, images });
        return;
      }
      await sendAgentMessageRef.current?.(agentIdRef.current, text, images);
    },
    []
  );

  useEffect(() => {
    agentIdRef.current = agentId;
  }, [agentId]);

  useEffect(() => {
    sendAgentMessageRef.current = sendAgentMessage;
  }, [sendAgentMessage]);

  useEffect(() => {
    onSubmitMessageRef.current = onSubmitMessage;
  }, [onSubmitMessage]);

  const isAgentRunning = agent?.status === "running";

  const updateQueue = useCallback(
    (updater: (current: QueuedMessage[]) => QueuedMessage[]) => {
      setQueuedMessages(serverId, (prev: Map<string, QueuedMessage[]>) => {
        const next = new Map(prev);
        next.set(agentId, updater(prev.get(agentId) ?? []));
        return next;
      });
    },
    [agentId, serverId, setQueuedMessages]
  );

  function queueMessage(message: string, imageAttachments?: ImageAttachment[]) {
    const trimmedMessage = message.trim();
    if (!trimmedMessage && !imageAttachments?.length) return;

    const newItem = {
      id: generateMessageId(),
      text: trimmedMessage,
      images: imageAttachments,
    };

    setQueuedMessages(serverId, (prev: Map<string, QueuedMessage[]>) => {
      const next = new Map(prev);
      next.set(agentId, [...(prev.get(agentId) ?? []), newItem]);
      return next;
    });

    const isControlled = value !== undefined;
    if (!isControlled) {
      setUserInput("");
    }
    setSelectedImages([]);
  }

  async function sendMessageWithContent(
    message: string,
    imageAttachments?: ImageAttachment[],
    forceSend?: boolean
  ) {
    const socketConnected = wsOrInert.getConnectionState
      ? wsOrInert.getConnectionState().isConnected
      : wsOrInert.isConnected;
    if (!message.trim() || !socketConnected) return;
    if (!sendAgentMessage && !onSubmitMessageRef.current) return;

    const trimmedMessage = message.trim();

    if (agent?.status === "running" && !forceSend) {
      queueMessage(trimmedMessage, imageAttachments);
      return;
    }

    const isControlled = value !== undefined;
    if (!isControlled) {
      setUserInput("");
    }
    setSelectedImages([]);
    setIsProcessing(true);

    try {
      await submitMessage(trimmedMessage, imageAttachments);
    } catch (error) {
      console.error("[AgentInput] Failed to send message:", error);
      setUserInput(trimmedMessage);
      if (imageAttachments) {
        setSelectedImages(imageAttachments);
      }
    } finally {
      setIsProcessing(false);
    }
  }

  function handleSubmit(payload: MessagePayload) {
    void sendMessageWithContent(
      payload.text,
      payload.images,
      payload.forceSend
    );
  }

  async function handlePickImage() {
    const result = await pickImages();
    if (!result?.assets?.length) {
      return;
    }

    const newImages = result.assets.map((asset) => ({
      uri: asset.uri,
      mimeType: asset.mimeType || "image/jpeg",
    }));
    setSelectedImages((prev) => [...prev, ...newImages]);
  }

  function handleRemoveImage(index: number) {
    setSelectedImages((prev) => prev.filter((_, i) => i !== index));
  }

  useEffect(() => {
    if (!isAgentRunning || !wsOrInert.isConnected) {
      setIsCancellingAgent(false);
    }
  }, [isAgentRunning, wsOrInert.isConnected]);

  // Hydrate draft only when switching agents
  useEffect(() => {
    const draft = getDraftInput(agentId);
    if (!draft) {
      setUserInput("");
      setSelectedImages([]);
      return;
    }

    setUserInput(draft.text);
    setSelectedImages(draft.images as ImageAttachment[]);
  }, [agentId, getDraftInput]);

  // Persist drafts into the shared session store with change detection to avoid redundant work
  useEffect(() => {
    const existing = getDraftInput(agentId);
    const isSameText = existing?.text === userInput;
    const existingImages: ImageAttachment[] = (existing?.images ??
      []) as ImageAttachment[];
    const isSameImages =
      existingImages.length === selectedImages.length &&
      existingImages.every((img, idx) => {
        return (
          img.uri === selectedImages[idx]?.uri &&
          img.mimeType === selectedImages[idx]?.mimeType
        );
      });

    if (isSameText && isSameImages) {
      return;
    }

    saveDraftInput(agentId, { text: userInput, images: selectedImages });
  }, [agentId, userInput, selectedImages, getDraftInput, saveDraftInput]);

  const keyboardAnimatedStyle = useAnimatedStyle(() => {
    "worklet";
    const absoluteHeight = Math.abs(keyboardHeight.value);
    const shift = Math.max(0, absoluteHeight - insets.bottom);
    return {
      transform: [{ translateY: -shift }],
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

  function handleEditQueuedMessage(id: string) {
    const item = queuedMessages.find((q) => q.id === id);
    if (!item) return;

    updateQueue((current) => current.filter((q) => q.id !== id));
    setUserInput(item.text);
    setSelectedImages(item.images ?? []);
  }

  async function handleSendQueuedNow(id: string) {
    const item = queuedMessages.find((q) => q.id === id);
    if (!item || !wsOrInert.isConnected) return;
    if (!sendAgentMessage && !onSubmitMessageRef.current) return;

    updateQueue((current) => current.filter((q) => q.id !== id));

    // Cancels current agent run before sending queued prompt
    handleCancelAgent();
    await submitMessage(item.text, item.images);
  }

  const handleQueue = useCallback((payload: MessagePayload) => {
    queueMessage(payload.text, payload.images);
  }, []);

  const rightContent = (
    <>
      <Pressable
        onPress={handleRealtimePress}
        disabled={!wsOrInert.isConnected && !isRealtimeMode}
        style={[
          styles.realtimeButton as any,
          (isRealtimeMode ? styles.realtimeButtonActive : undefined) as any,
          (!wsOrInert.isConnected && !isRealtimeMode
            ? styles.buttonDisabled
            : undefined) as any,
        ]}
      >
        {isRealtimeMode ? (
          <Square
            size={18}
            color={theme.colors.background}
            fill={theme.colors.background}
          />
        ) : (
          <AudioLines size={20} color={theme.colors.background} />
        )}
      </Pressable>
      {isAgentRunning && (
        <Pressable
          onPress={handleCancelAgent}
          disabled={!wsOrInert.isConnected || isCancellingAgent}
          accessibilityLabel={
            isCancellingAgent ? "Canceling agent" : "Stop agent"
          }
          accessibilityRole="button"
          style={[
            styles.cancelButton as any,
            (!wsOrInert.isConnected || isCancellingAgent
              ? styles.buttonDisabled
              : undefined) as any,
          ]}
        >
          {isCancellingAgent ? (
            <ActivityIndicator size="small" color="white" />
          ) : (
            <Square size={18} color="white" fill="white" />
          )}
        </Pressable>
      )}
    </>
  );

  const leftContent = <AgentStatusBar agentId={agentId} serverId={serverId} />;

  return (
    <Animated.View
      style={[
        styles.container,
        { paddingBottom: insets.bottom },
        keyboardAnimatedStyle,
      ]}
    >
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
          {/* Queue list */}
          {queuedMessages.length > 0 && (
            <View style={styles.queueContainer}>
              {queuedMessages.map((item) => (
                <View key={item.id} style={styles.queueItem}>
                  <Text
                    style={styles.queueText}
                    numberOfLines={2}
                    ellipsizeMode="tail"
                  >
                    {item.text}
                  </Text>
                  <View style={styles.queueActions}>
                    <Pressable
                      onPress={() => handleEditQueuedMessage(item.id)}
                      style={styles.queueActionButton}
                    >
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

          {/* MessageInput handles everything: text, dictation, attachments, all buttons */}
          <MessageInput
            value={userInput}
            onChangeText={setUserInput}
            onSubmit={handleSubmit}
            isSubmitDisabled={isProcessing || isSubmitLoading}
            isSubmitLoading={isSubmitLoading}
            images={selectedImages}
            onPickImages={handlePickImage}
            onRemoveImage={handleRemoveImage}
            ws={wsOrInert}
            sendAgentAudio={sendAgentAudio}
            placeholder="Message agent..."
            autoFocus={autoFocus}
            disabled={isRealtimeMode}
            leftContent={leftContent}
            rightContent={rightContent}
            isAgentRunning={isAgentRunning}
            onQueue={handleQueue}
          />
        </View>
      </View>
    </Animated.View>
  );
}

const BUTTON_SIZE = 40;

const styles = StyleSheet.create(((theme: Theme) => ({
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
    marginHorizontal: "auto",
    alignItems: "center",
    width: "100%",
    overflow: "hidden",
    padding: theme.spacing[4],
  },
  inputAreaContent: {
    width: "100%",
    maxWidth: MAX_INPUT_WIDTH,
    gap: theme.spacing[3],
  },
  realtimeButton: {
    width: 34,
    height: 34,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accentForeground,
    alignItems: "center",
    justifyContent: "center",
  },
  realtimeButtonActive: {
    backgroundColor: theme.colors.palette.blue[600],
  },
  cancelButton: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.palette.red[500],
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
