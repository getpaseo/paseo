import {
  View,
  Pressable,
  Text,
  ActivityIndicator,
  Platform,
  Alert,
} from "react-native";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ArrowUp, Square, Pencil, AudioLines } from "lucide-react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useIsFocused } from "@react-navigation/native";
import { FOOTER_HEIGHT, MAX_CONTENT_WIDTH } from "@/constants/layout";
import { generateMessageId } from "@/types/stream";
import { AgentStatusBar } from "./agent-status-bar";
import { useImageAttachmentPicker } from "@/hooks/use-image-attachment-picker";
import { useSessionStore } from "@/stores/session-store";
import { useDraftStore } from "@/stores/draft-store";
import {
  MessageInput,
  type MessagePayload,
  type ImageAttachment,
  type MessageInputRef,
} from "./message-input";
import { Theme } from "@/styles/theme";
import { CommandAutocomplete } from "./command-autocomplete";
import { useAgentCommandsQuery } from "@/hooks/use-agent-commands-query";
import { encodeImages } from "@/utils/encode-images";
import { useKeyboardNavStore } from "@/stores/keyboard-nav-store";
import { focusWithRetries } from "@/utils/web-focus";
import { useVoiceOptional } from "@/contexts/voice-context";

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
  /** When true, blurs the input immediately when submitting. */
  blurOnSubmit?: boolean;
  value?: string;
  onChangeText?: (text: string) => void;
  /** When true, auto-focuses the text input on web. */
  autoFocus?: boolean;
  /** Callback to expose the addImages function to parent components */
  onAddImages?: (addImages: (images: ImageAttachment[]) => void) => void;
}

const EMPTY_ARRAY: readonly QueuedMessage[] = [];

export function AgentInputArea({
  agentId,
  serverId,
  onSubmitMessage,
  isSubmitLoading = false,
  blurOnSubmit = false,
  value,
  onChangeText,
  autoFocus = false,
  onAddImages,
}: AgentInputAreaProps) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const { height: keyboardHeight } = useReanimatedKeyboardAnimation();
  const isScreenFocused = useIsFocused();
  const focusChatInputRequest = useKeyboardNavStore((s) => s.focusChatInputRequest);
  const clearFocusChatInputRequest = useKeyboardNavStore((s) => s.clearFocusChatInputRequest);

  const client = useSessionStore(
    (state) => state.sessions[serverId]?.client ?? null
  );
  const voice = useVoiceOptional();
  const isConnected = client?.isConnected ?? false;

  const agent = useSessionStore((state) =>
    state.sessions[serverId]?.agents?.get(agentId)
  );

  const getDraftInput = useDraftStore((state) => state.getDraftInput);
  const saveDraftInput = useDraftStore((state) => state.saveDraftInput);

  const queuedMessagesRaw = useSessionStore((state) =>
    state.sessions[serverId]?.queuedMessages?.get(agentId)
  );
  const queuedMessages = queuedMessagesRaw ?? EMPTY_ARRAY;

  const setQueuedMessages = useSessionStore((state) => state.setQueuedMessages);
  const setAgentStreamTail = useSessionStore((state) => state.setAgentStreamTail);

  const [internalInput, setInternalInput] = useState("");
  const userInput = value ?? internalInput;
  const setUserInput = onChangeText ?? setInternalInput;
  const [isProcessing, setIsProcessing] = useState(false);
  const [selectedImages, setSelectedImages] = useState<ImageAttachment[]>([]);
  const [isCancellingAgent, setIsCancellingAgent] = useState(false);
  const [commandSelectedIndex, setCommandSelectedIndex] = useState(0);
  const lastHandledFocusRequestIdRef = useRef<number | null>(null);

  // Command autocomplete logic
  const showCommandAutocomplete = userInput.startsWith("/") && !userInput.includes(" ");
  const commandFilter = showCommandAutocomplete ? userInput.slice(1) : "";

  // Prefetch commands when agent is available (not on new agent screen)
  const isRealAgent = agentId && !agentId.startsWith("__");
  const { commands } = useAgentCommandsQuery({
    serverId,
    agentId,
    enabled: !!isRealAgent && !!serverId,
  });

  // Filter commands for keyboard navigation
  const filteredCommands = useMemo(() => {
    if (!showCommandAutocomplete) return [];
    const filterLower = commandFilter.toLowerCase();
    return commands.filter((cmd) =>
      cmd.name.toLowerCase().includes(filterLower)
    );
  }, [commands, commandFilter, showCommandAutocomplete]);

  // Reset selection when filter changes
  useEffect(() => {
    setCommandSelectedIndex(0);
  }, [commandFilter]);

  const { pickImages } = useImageAttachmentPicker();
  const agentIdRef = useRef(agentId);
  const sendAgentMessageRef = useRef<
    ((agentId: string, text: string, images?: ImageAttachment[]) => Promise<void>) | null
  >(null);
  const onSubmitMessageRef = useRef(onSubmitMessage);
  const messageInputRef = useRef<MessageInputRef>(null);

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
      if (!sendAgentMessageRef.current) {
        throw new Error("Host is not connected");
      }
      await sendAgentMessageRef.current(agentIdRef.current, text, images);
    },
    []
  );

  useEffect(() => {
    agentIdRef.current = agentId;
  }, [agentId]);

  useEffect(() => {
    sendAgentMessageRef.current = async (
      agentId: string,
      text: string,
      images?: ImageAttachment[]
    ) => {
      if (!client) {
        throw new Error("Host is not connected");
      }

      const messageId = generateMessageId();
      setAgentStreamTail(serverId, (prev) => {
        const currentStream = prev.get(agentId) || [];
        const nextItem: any = {
          kind: "user_message",
          id: messageId,
          text,
          timestamp: new Date(),
        };
        const updated = new Map(prev);
        updated.set(agentId, [...currentStream, nextItem]);
        return updated;
      });

      const imagesData = await encodeImages(images);
      await client.sendAgentMessage(agentId, text, {
        messageId,
        ...(imagesData && imagesData.length > 0 ? { images: imagesData } : {}),
      });
    };
  }, [client, serverId, setAgentStreamTail]);

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
    const socketConnected = isConnected;
    const trimmedMessage = message.trim();
    if (!trimmedMessage) return;
    // When the parent controls submission (e.g. draft agent creation), let it
    // decide what to do even if the socket is currently disconnected (so we
    // don't no-op and lose deterministic error handling in the UI/tests).
    if (!onSubmitMessageRef.current && !socketConnected) return;
    if (!sendAgentMessageRef.current && !onSubmitMessageRef.current) return;

    if (agent?.status === "running" && !forceSend) {
      queueMessage(trimmedMessage, imageAttachments);
      return;
    }

    const isControlledLocal = value !== undefined;
    setSelectedImages([]);
    setIsProcessing(true);

    try {
      await submitMessage(trimmedMessage, imageAttachments);
      // Clear input only after successful submission
      // For controlled inputs with onSubmitMessage, the parent handles clearing
      // because agent creation is async (WebSocket) and errors come back later
      if (onSubmitMessageRef.current) {
        // Parent manages input state - don't clear here
        // Parent will clear on success via onChangeText
      } else if (isControlledLocal) {
        onChangeText?.("");
      } else {
        setUserInput("");
      }
    } catch (error) {
      console.error("[AgentInput] Failed to send message:", error);
      if (imageAttachments) {
        setSelectedImages(imageAttachments);
      }
    } finally {
      setIsProcessing(false);
    }
  }

  function handleSubmit(payload: MessagePayload) {
    if (blurOnSubmit) {
      messageInputRef.current?.blur();
    }
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
    if (!isAgentRunning || !isConnected) {
      setIsCancellingAgent(false);
    }
  }, [isAgentRunning, isConnected]);

  // Hydrate draft only when switching agents (uncontrolled mode only)
  const isControlled = value !== undefined;
  useEffect(() => {
    // Skip draft hydration for controlled inputs - parent manages state
    if (isControlled) {
      return;
    }
    const draft = getDraftInput(agentId);
    if (!draft) {
      setUserInput("");
      setSelectedImages([]);
      return;
    }

    setUserInput(draft.text);
    setSelectedImages(draft.images as ImageAttachment[]);
  }, [agentId, getDraftInput, isControlled]);

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

  // When switching agents from the command center, auto-focus the input on web.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (!isScreenFocused) return;
    if (!focusChatInputRequest) return;

    const currentKey = `${serverId}:${agentId}`;
    if (focusChatInputRequest.agentKey !== currentKey) {
      return;
    }

    if (lastHandledFocusRequestIdRef.current === focusChatInputRequest.id) {
      return;
    }
    lastHandledFocusRequestIdRef.current = focusChatInputRequest.id;

    return focusWithRetries({
      focus: () => messageInputRef.current?.focus(),
      isFocused: () => {
        const el = messageInputRef.current?.getNativeElement?.() ?? null;
        const active =
          typeof document !== "undefined" ? document.activeElement : null;
        return Boolean(el) && active === el;
      },
      onSuccess: () => clearFocusChatInputRequest(),
      onTimeout: () => clearFocusChatInputRequest(),
    });
  }, [
    agentId,
    clearFocusChatInputRequest,
    focusChatInputRequest,
    isScreenFocused,
    serverId,
  ]);

  const keyboardAnimatedStyle = useAnimatedStyle(() => {
    "worklet";
    const absoluteHeight = Math.abs(keyboardHeight.value);
    const shift = Math.max(0, absoluteHeight - insets.bottom);
    return {
      transform: [{ translateY: -shift }],
    };
  });

  function handleCancelAgent() {
    if (!agent || agent.status !== "running" || isCancellingAgent) {
      return;
    }
    if (!isConnected || !client) {
      return;
    }
    setIsCancellingAgent(true);
    void client.cancelAgent(agentIdRef.current);
    messageInputRef.current?.focus();
  }

  const isVoiceModeForAgent =
    voice?.isVoiceModeForAgent(serverId, agentId) ?? false;

  const handleToggleRealtimeVoice = useCallback(() => {
    if (!voice || !isConnected) {
      return;
    }
    if (voice.isVoiceSwitching) {
      return;
    }
    if (voice.isVoiceModeForAgent(serverId, agentId)) {
      void voice.stopVoice().catch((error) => {
        console.error("[AgentInputArea] Failed to stop voice mode", error);
        Alert.alert("Voice failed", "Unable to stop realtime voice mode.");
      });
      return;
    }
    void voice.startVoice(serverId, agentId).catch((error) => {
      console.error("[AgentInputArea] Failed to start voice mode", error);
      Alert.alert("Voice failed", "Unable to start realtime voice mode.");
    });
  }, [agentId, isConnected, serverId, voice]);

  function handleEditQueuedMessage(id: string) {
    const item = queuedMessages.find((q) => q.id === id);
    if (!item) return;

    updateQueue((current) => current.filter((q) => q.id !== id));
    setUserInput(item.text);
    setSelectedImages(item.images ?? []);
  }

  async function handleSendQueuedNow(id: string) {
    const item = queuedMessages.find((q) => q.id === id);
    if (!item || !isConnected) return;
    if (!sendAgentMessageRef.current && !onSubmitMessageRef.current) return;

    updateQueue((current) => current.filter((q) => q.id !== id));

    // Cancels current agent run before sending queued prompt
    handleCancelAgent();
    await submitMessage(item.text, item.images);
  }

  const handleQueue = useCallback((payload: MessagePayload) => {
    queueMessage(payload.text, payload.images);
  }, []);

  // Handle command selection from autocomplete
  const handleCommandSelect = useCallback(
    (cmd: { name: string; description: string; argumentHint: string }) => {
      setUserInput(`/${cmd.name} `);
      messageInputRef.current?.focus();
    },
    [setUserInput]
  );

  // Handle keyboard navigation for command autocomplete
  const handleCommandKeyPress = useCallback(
    (event: { key: string; preventDefault: () => void }) => {
      if (!showCommandAutocomplete || filteredCommands.length === 0) {
        return false;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        setCommandSelectedIndex((prev) =>
          prev > 0 ? prev - 1 : filteredCommands.length - 1
        );
        return true;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setCommandSelectedIndex((prev) =>
          prev < filteredCommands.length - 1 ? prev + 1 : 0
        );
        return true;
      }

      if (event.key === "Tab" || event.key === "Enter") {
        event.preventDefault();
        const selected = filteredCommands[commandSelectedIndex];
        if (selected) {
          handleCommandSelect(selected);
        }
        return true;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        setUserInput("");
        return true;
      }

      return false;
    },
    [
      showCommandAutocomplete,
      filteredCommands,
      commandSelectedIndex,
      handleCommandSelect,
      setUserInput,
    ]
  );

  const cancelButton = isAgentRunning ? (
    <Pressable
      onPress={handleCancelAgent}
      disabled={!isConnected || isCancellingAgent}
      accessibilityLabel={isCancellingAgent ? "Canceling agent" : "Stop agent"}
      accessibilityRole="button"
      style={[
        styles.cancelButton as any,
        (!isConnected || isCancellingAgent
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
  ) : null;

  const rightContent = (
    <View style={styles.rightControls}>
      <Pressable
        onPress={handleToggleRealtimeVoice}
        disabled={!isConnected || voice?.isVoiceSwitching}
        accessibilityLabel={
          isVoiceModeForAgent ? "Disable realtime voice mode" : "Enable realtime voice mode"
        }
        accessibilityRole="button"
        style={[
          styles.realtimeVoiceButton as any,
          isVoiceModeForAgent ? (styles.realtimeVoiceButtonActive as any) : undefined,
          (!isConnected || voice?.isVoiceSwitching
            ? styles.buttonDisabled
            : undefined) as any,
        ]}
      >
        {voice?.isVoiceSwitching ? (
          <ActivityIndicator size="small" color="white" />
        ) : isVoiceModeForAgent ? (
          <Square size={16} color="white" fill="white" />
        ) : (
          <AudioLines size={18} color={theme.colors.foreground} />
        )}
      </Pressable>
      {cancelButton}
    </View>
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

          {/* Command autocomplete dropdown */}
          {showCommandAutocomplete && isRealAgent && (
            <CommandAutocomplete
              serverId={serverId}
              agentId={agentId}
              filter={commandFilter}
              selectedIndex={commandSelectedIndex}
              onSelect={handleCommandSelect}
            />
          )}

          {/* MessageInput handles everything: text, dictation, attachments, all buttons */}
          <MessageInput
            ref={messageInputRef}
            value={userInput}
            onChangeText={setUserInput}
            onSubmit={handleSubmit}
            isSubmitDisabled={isProcessing || isSubmitLoading}
            isSubmitLoading={isSubmitLoading}
            images={selectedImages}
            onPickImages={handlePickImage}
            onRemoveImage={handleRemoveImage}
            client={client}
            placeholder="Message agent..."
            autoFocus={autoFocus}
            disabled={isSubmitLoading}
            isScreenFocused={isScreenFocused}
            leftContent={leftContent}
            rightContent={rightContent}
            voiceServerId={serverId}
            voiceAgentId={agentId}
            isAgentRunning={isAgentRunning}
            onQueue={handleQueue}
            onKeyPress={handleCommandKeyPress}
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
    maxWidth: MAX_CONTENT_WIDTH,
    gap: theme.spacing[3],
  },
  cancelButton: {
    width: 34,
    height: 34,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.palette.red[600],
    alignItems: "center",
    justifyContent: "center",
  },
  rightControls: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  realtimeVoiceButton: {
    width: 34,
    height: 34,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface0,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  realtimeVoiceButtonActive: {
    backgroundColor: theme.colors.palette.green[600],
    borderColor: theme.colors.palette.green[800],
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
    backgroundColor: theme.colors.surface2,
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
    backgroundColor: theme.colors.surface2,
  },
  queueSendButton: {
    backgroundColor: theme.colors.palette.blue[600],
  },
})) as any) as Record<string, any>;
