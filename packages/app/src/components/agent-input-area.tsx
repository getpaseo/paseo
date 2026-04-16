import { View, Pressable, Text, ActivityIndicator } from "react-native";
import { useState, useEffect, useRef, useCallback } from "react";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useShallow } from "zustand/shallow";
import { ArrowUp, Square, Pencil, AudioLines } from "lucide-react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FOOTER_HEIGHT, MAX_CONTENT_WIDTH } from "@/constants/layout";
import { generateMessageId, type StreamItem } from "@/types/stream";
import {
  AgentStatusBar,
  DraftAgentStatusBar,
  type DraftAgentStatusBarProps,
} from "./agent-status-bar";
import { ContextWindowMeter } from "./context-window-meter";
import { useImageAttachmentPicker } from "@/hooks/use-image-attachment-picker";
import { useSessionStore } from "@/stores/session-store";
import {
  MessageInput,
  type MessagePayload,
  type ImageAttachment,
  type MessageInputRef,
} from "./message-input";
import { Theme } from "@/styles/theme";
import type { DraftCommandConfig } from "@/hooks/use-agent-commands-query";
import { encodeImages } from "@/utils/encode-images";
import { focusWithRetries } from "@/utils/web-focus";
import { useVoiceOptional } from "@/contexts/voice-context";
import { useToast } from "@/contexts/toast-context";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Shortcut } from "@/components/ui/shortcut";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { Autocomplete } from "@/components/ui/autocomplete";
import { useAgentAutocomplete } from "@/hooks/use-agent-autocomplete";
import {
  useHostRuntimeAgentDirectoryStatus,
  useHostRuntimeClient,
  useHostRuntimeIsConnected,
} from "@/runtime/host-runtime";
import {
  deleteAttachments,
  persistAttachmentFromBlob,
  persistAttachmentFromFileUri,
} from "@/attachments/service";
import { resolveStatusControlMode } from "@/components/agent-input-area.status-controls";
import { markScrollInvestigationRender } from "@/utils/scroll-jank-investigation";
import { useKeyboardShiftStyle } from "@/hooks/use-keyboard-shift-style";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import type { KeyboardActionDefinition } from "@/keyboard/keyboard-action-dispatcher";
import { submitAgentInput } from "@/components/agent-input-submit";
import { useAppSettings } from "@/hooks/use-settings";
import { isWeb, isNative } from "@/constants/platform";

type QueuedMessage = {
  id: string;
  text: string;
  images?: ImageAttachment[];
};

type ImageListUpdater = ImageAttachment[] | ((prev: ImageAttachment[]) => ImageAttachment[]);

interface AgentInputAreaProps {
  agentId: string;
  serverId: string;
  isPaneFocused: boolean;
  onSubmitMessage?: (payload: MessagePayload) => Promise<void>;
  /** Externally controlled loading state. When true, disables the submit button. */
  isSubmitLoading?: boolean;
  /** When true, blurs the input immediately when submitting. */
  blurOnSubmit?: boolean;
  value: string;
  onChangeText: (text: string) => void;
  images: ImageAttachment[];
  onChangeImages: (updater: ImageListUpdater) => void;
  clearDraft: (lifecycle: "sent" | "abandoned") => void;
  /** When true, auto-focuses the text input on web. */
  autoFocus?: boolean;
  /** Callback to expose the addImages function to parent components */
  onAddImages?: (addImages: (images: ImageAttachment[]) => void) => void;
  /** Callback to expose a focus function to parent components (desktop only). */
  onFocusInput?: (focus: () => void) => void;
  /** Optional draft context for listing commands before an agent exists. */
  commandDraftConfig?: DraftCommandConfig;
  /** Called when a message is about to be sent (any path: keyboard, dictation, queued). */
  onMessageSent?: () => void;
  onComposerHeightChange?: (height: number) => void;
  onAttentionInputFocus?: () => void;
  onAttentionPromptSend?: () => void;
  /** Controlled status controls rendered in input area (draft flows). */
  statusControls?: DraftAgentStatusBarProps;
}

const EMPTY_ARRAY: readonly QueuedMessage[] = [];
const DESKTOP_MESSAGE_PLACEHOLDER = "Message the agent, tag @files, or use /commands and /skills";
const MOBILE_MESSAGE_PLACEHOLDER = "Message, @files, /commands";

export function AgentInputArea({
  agentId,
  serverId,
  isPaneFocused,
  onSubmitMessage,
  isSubmitLoading = false,
  blurOnSubmit = false,
  value,
  onChangeText,
  images,
  onChangeImages,
  clearDraft,
  autoFocus = false,
  onAddImages,
  onFocusInput,
  commandDraftConfig,
  onMessageSent,
  onComposerHeightChange,
  onAttentionInputFocus,
  onAttentionPromptSend,
  statusControls,
}: AgentInputAreaProps) {
  markScrollInvestigationRender(`AgentInputArea:${serverId}:${agentId}`);
  const { theme } = useUnistyles();
  const buttonIconSize = isWeb ? theme.iconSize.md : theme.iconSize.lg;
  const insets = useSafeAreaInsets();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const agentDirectoryStatus = useHostRuntimeAgentDirectoryStatus(serverId);
  const toast = useToast();
  const voice = useVoiceOptional();
  const voiceToggleKeys = useShortcutKeys("voice-toggle");
  const dictationCancelKeys = useShortcutKeys("dictation-cancel");
  const isDictationReady =
    isConnected &&
    (agentDirectoryStatus === "ready" ||
      agentDirectoryStatus === "revalidating" ||
      agentDirectoryStatus === "error_after_ready");

  const { settings: appSettings } = useAppSettings();

  const agentState = useSessionStore(
    useShallow((state) => {
      const agent = state.sessions[serverId]?.agents?.get(agentId) ?? null;
      return {
        status: agent?.status ?? null,
        contextWindowMaxTokens: agent?.lastUsage?.contextWindowMaxTokens ?? null,
        contextWindowUsedTokens: agent?.lastUsage?.contextWindowUsedTokens ?? null,
      };
    }),
  );

  const queuedMessagesRaw = useSessionStore((state) =>
    state.sessions[serverId]?.queuedMessages?.get(agentId),
  );
  const queuedMessages = queuedMessagesRaw ?? EMPTY_ARRAY;

  const setQueuedMessages = useSessionStore((state) => state.setQueuedMessages);
  const setAgentStreamTail = useSessionStore((state) => state.setAgentStreamTail);
  const setAgentStreamHead = useSessionStore((state) => state.setAgentStreamHead);

  const isMobile = useIsCompactFormFactor();
  const isDesktopWebBreakpoint = isWeb && !isMobile;
  const messagePlaceholder = isDesktopWebBreakpoint
    ? DESKTOP_MESSAGE_PLACEHOLDER
    : MOBILE_MESSAGE_PLACEHOLDER;
  const userInput = value;
  const setUserInput = onChangeText;
  const selectedImages = images;
  const setSelectedImages = onChangeImages;
  const [cursorIndex, setCursorIndex] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isCancellingAgent, setIsCancellingAgent] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [isMessageInputFocused, setIsMessageInputFocused] = useState(false);
  const messageInputRef = useRef<MessageInputRef>(null);
  const keyboardHandlerIdRef = useRef(
    `message-input:${serverId}:${agentId}:${Math.random().toString(36).slice(2)}`,
  );

  const autocomplete = useAgentAutocomplete({
    userInput,
    cursorIndex,
    setUserInput,
    serverId,
    agentId,
    draftConfig: commandDraftConfig,
    onAutocompleteApplied: () => {
      messageInputRef.current?.focus();
    },
  });

  // Clear send error when user edits the input
  useEffect(() => {
    if (sendError && userInput) {
      setSendError(null);
    }
  }, [userInput, sendError]);

  useEffect(() => {
    setCursorIndex((current) => Math.min(current, userInput.length));
  }, [userInput.length]);

  const { pickImages } = useImageAttachmentPicker();
  const agentIdRef = useRef(agentId);
  const sendAgentMessageRef = useRef<
    ((agentId: string, text: string, images?: ImageAttachment[]) => Promise<void>) | null
  >(null);
  const onSubmitMessageRef = useRef(onSubmitMessage);

  // Expose addImages function to parent for drag-and-drop support
  const addImages = useCallback(
    (images: ImageAttachment[]) => {
      setSelectedImages((prev) => [...prev, ...images]);
    },
    [setSelectedImages],
  );

  useEffect(() => {
    onAddImages?.(addImages);
  }, [addImages, onAddImages]);

  const focusInput = useCallback(() => {
    if (isNative) return;
    focusWithRetries({
      focus: () => messageInputRef.current?.focus(),
      isFocused: () => {
        const el = messageInputRef.current?.getNativeElement?.() ?? null;
        return el != null && document.activeElement === el;
      },
    });
  }, []);

  useEffect(() => {
    onFocusInput?.(focusInput);
  }, [focusInput, onFocusInput]);

  const submitMessage = useCallback(
    async (text: string, images?: ImageAttachment[]) => {
      onMessageSent?.();
      if (onSubmitMessageRef.current) {
        await onSubmitMessageRef.current({ text, images });
        return;
      }
      if (!sendAgentMessageRef.current) {
        throw new Error("Host is not connected");
      }
      await sendAgentMessageRef.current(agentIdRef.current, text, images);
    },
    [onMessageSent],
  );

  useEffect(() => {
    agentIdRef.current = agentId;
  }, [agentId]);

  useEffect(() => {
    sendAgentMessageRef.current = async (
      agentId: string,
      text: string,
      images?: ImageAttachment[],
    ) => {
      if (!client) {
        throw new Error("Host is not connected");
      }

      const clientMessageId = generateMessageId();
      const userMessage: StreamItem = {
        kind: "user_message",
        id: clientMessageId,
        text,
        timestamp: new Date(),
        ...(images && images.length > 0 ? { images } : {}),
      };

      // Append to head if streaming (keeps the user message with the current
      // turn so late text_deltas still find the existing assistant_message).
      // Otherwise append to tail.
      const currentHead = useSessionStore
        .getState()
        .sessions[serverId]?.agentStreamHead?.get(agentId);
      if (currentHead && currentHead.length > 0) {
        setAgentStreamHead(serverId, (prev) => {
          const head = prev.get(agentId) || [];
          const updated = new Map(prev);
          updated.set(agentId, [...head, userMessage]);
          return updated;
        });
      } else {
        setAgentStreamTail(serverId, (prev) => {
          const currentStream = prev.get(agentId) || [];
          const updated = new Map(prev);
          updated.set(agentId, [...currentStream, userMessage]);
          return updated;
        });
      }
      const imagesData = await encodeImages(images);
      await client.sendAgentMessage(agentId, text, {
        messageId: clientMessageId,
        ...(imagesData && imagesData.length > 0 ? { images: imagesData } : {}),
      });
      onAttentionPromptSend?.();
    };
  }, [client, onAttentionPromptSend, serverId, setAgentStreamTail, setAgentStreamHead]);

  useEffect(() => {
    onSubmitMessageRef.current = onSubmitMessage;
  }, [onSubmitMessage]);

  const isAgentRunning = agentState.status === "running";
  const hasAgent = agentState.status !== null;

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

    setUserInput("");
    setSelectedImages([]);
  }

  async function sendMessageWithContent(
    message: string,
    imageAttachments?: ImageAttachment[],
    forceSend?: boolean,
  ) {
    await submitAgentInput({
      message,
      imageAttachments,
      forceSend,
      isAgentRunning: agentState.status === "running",
      // Parent-managed submits are still valid submit paths even when the
      // transport is disconnected, because the parent decides the failure mode.
      canSubmit: Boolean(sendAgentMessageRef.current || onSubmitMessageRef.current),
      queueMessage: ({ message, imageAttachments }) => {
        queueMessage(message, imageAttachments);
      },
      submitMessage: async ({ message, imageAttachments }) => {
        await submitMessage(message, imageAttachments);
      },
      clearDraft,
      setUserInput,
      setSelectedImages: (images) => {
        setSelectedImages(images);
      },
      setSendError,
      setIsProcessing,
      onSubmitError: (error) => {
        console.error("[AgentInput] Failed to send message:", error);
      },
    });
  }

  function handleSubmit(payload: MessagePayload) {
    if (blurOnSubmit) {
      messageInputRef.current?.blur();
    }
    void sendMessageWithContent(payload.text, payload.images, payload.forceSend);
  }

  async function handlePickImage() {
    const result = await pickImages();
    if (!result?.length) {
      return;
    }

    const newImages = await Promise.all(
      result.map(async (pickedImage) => {
        if (pickedImage.source.kind === "blob") {
          return await persistAttachmentFromBlob({
            blob: pickedImage.source.blob,
            mimeType: pickedImage.mimeType || "image/jpeg",
            fileName: pickedImage.fileName ?? null,
          });
        }

        return await persistAttachmentFromFileUri({
          uri: pickedImage.source.uri,
          mimeType: pickedImage.mimeType || "image/jpeg",
          fileName: pickedImage.fileName ?? null,
        });
      }),
    );
    setSelectedImages((prev) => [...prev, ...newImages]);
  }

  function handleRemoveImage(index: number) {
    setSelectedImages((prev) => {
      const removed = prev[index];
      if (removed) {
        void deleteAttachments([removed]);
      }
      return prev.filter((_, i) => i !== index);
    });
  }

  useEffect(() => {
    if (!isAgentRunning || !isConnected) {
      setIsCancellingAgent(false);
    }
  }, [isAgentRunning, isConnected]);

  const handleKeyboardAction = useCallback(
    (action: KeyboardActionDefinition): boolean => {
      if (!isPaneFocused) {
        return false;
      }

      switch (action.id) {
        case "message-input.send":
          return messageInputRef.current?.runKeyboardAction("send") ?? false;
        case "message-input.dictation-confirm":
          return messageInputRef.current?.runKeyboardAction("dictation-confirm") ?? false;
        case "message-input.focus":
          if (isNative) {
            messageInputRef.current?.focus();
            return true;
          }

          focusWithRetries({
            focus: () => messageInputRef.current?.focus(),
            isFocused: () => {
              const el = messageInputRef.current?.getNativeElement?.() ?? null;
              const active = typeof document !== "undefined" ? document.activeElement : null;
              return Boolean(el) && active === el;
            },
          });
          return true;
        case "message-input.dictation-toggle":
          messageInputRef.current?.runKeyboardAction("dictation-toggle");
          return true;
        case "message-input.dictation-cancel":
          messageInputRef.current?.runKeyboardAction("dictation-cancel");
          return true;
        case "message-input.voice-toggle":
          messageInputRef.current?.runKeyboardAction("voice-toggle");
          return true;
        case "message-input.voice-mute-toggle":
          messageInputRef.current?.runKeyboardAction("voice-mute-toggle");
          return true;
        default:
          return false;
      }
    },
    [isPaneFocused],
  );

  useKeyboardActionHandler({
    handlerId: keyboardHandlerIdRef.current,
    actions: [
      "message-input.focus",
      "message-input.send",
      "message-input.dictation-toggle",
      "message-input.dictation-cancel",
      "message-input.dictation-confirm",
      "message-input.voice-toggle",
      "message-input.voice-mute-toggle",
    ],
    enabled: isPaneFocused,
    priority: isMessageInputFocused ? 200 : 100,
    isActive: () => isPaneFocused,
    handle: handleKeyboardAction,
  });

  const { style: keyboardAnimatedStyle } = useKeyboardShiftStyle({
    mode: "translate",
  });

  function handleCancelAgent() {
    if (!isAgentRunning || isCancellingAgent) {
      return;
    }
    if (!isConnected || !client) {
      return;
    }
    setIsCancellingAgent(true);
    void client.cancelAgent(agentIdRef.current);
    messageInputRef.current?.focus();
  }

  const isVoiceModeForAgent = voice?.isVoiceModeForAgent(serverId, agentId) ?? false;

  const handleToggleRealtimeVoice = useCallback(() => {
    if (!voice || !isConnected || !hasAgent) {
      return;
    }
    if (voice.isVoiceSwitching) {
      return;
    }
    if (voice.isVoiceModeForAgent(serverId, agentId)) {
      return;
    }
    void voice.startVoice(serverId, agentId).catch((error) => {
      console.error("[AgentInputArea] Failed to start voice mode", error);
      const message =
        error instanceof Error ? error.message : typeof error === "string" ? error : null;
      if (message && message.trim().length > 0) {
        toast.error(message);
      }
    });
  }, [agentId, hasAgent, isConnected, serverId, toast, voice]);

  function handleEditQueuedMessage(id: string) {
    const item = queuedMessages.find((q) => q.id === id);
    if (!item) return;

    updateQueue((current) => current.filter((q) => q.id !== id));
    setUserInput(item.text);
    setSelectedImages(item.images ?? []);
  }

  async function handleSendQueuedNow(id: string) {
    const item = queuedMessages.find((q) => q.id === id);
    if (!item) return;
    if (!sendAgentMessageRef.current && !onSubmitMessageRef.current) return;

    updateQueue((current) => current.filter((q) => q.id !== id));

    // Reuse the regular send path; server-side send atomically interrupts any active run.
    try {
      await submitMessage(item.text, item.images);
    } catch (error) {
      updateQueue((current) => [item, ...current]);
      setSendError(error instanceof Error ? error.message : "Failed to send message");
    }
  }

  const handleQueue = useCallback((payload: MessagePayload) => {
    queueMessage(payload.text, payload.images);
  }, []);

  const hasSendableContent = userInput.trim().length > 0 || selectedImages.length > 0;

  // Handle keyboard navigation for command autocomplete and stop action.
  const handleCommandKeyPress = useCallback(
    (event: { key: string; preventDefault: () => void }) => {
      if (
        event.key === "Escape" &&
        isAgentRunning &&
        !hasSendableContent &&
        !isCancellingAgent &&
        isConnected
      ) {
        event.preventDefault();
        handleCancelAgent();
        return true;
      }

      return autocomplete.onKeyPress(event);
    },
    [
      autocomplete,
      hasSendableContent,
      isAgentRunning,
      isCancellingAgent,
      isConnected,
      handleCancelAgent,
    ],
  );

  const cancelButton =
    isAgentRunning && !hasSendableContent && !isProcessing ? (
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger
          onPress={handleCancelAgent}
          disabled={!isConnected || isCancellingAgent}
          accessibilityLabel={isCancellingAgent ? "Canceling agent" : "Stop agent"}
          accessibilityRole="button"
          style={[
            styles.cancelButton as any,
            (!isConnected || isCancellingAgent ? styles.buttonDisabled : undefined) as any,
          ]}
        >
          {isCancellingAgent ? (
            <ActivityIndicator size="small" color="white" />
          ) : (
            <Square size={buttonIconSize} color="white" fill="white" />
          )}
        </TooltipTrigger>
        <TooltipContent side="top" align="center" offset={8}>
          <View style={styles.tooltipRow}>
            <Text style={styles.tooltipText}>Interrupt</Text>
            {dictationCancelKeys ? (
              <Shortcut chord={dictationCancelKeys} style={styles.tooltipShortcut} />
            ) : null}
          </View>
        </TooltipContent>
      </Tooltip>
    ) : null;

  const rightContent = (
    <View style={styles.rightControls}>
      {!isVoiceModeForAgent && hasAgent ? (
        <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
          <TooltipTrigger
            onPress={handleToggleRealtimeVoice}
            disabled={!isConnected || voice?.isVoiceSwitching}
            accessibilityLabel="Enable Voice mode"
            accessibilityRole="button"
            style={({ hovered }) => [
              styles.realtimeVoiceButton as any,
              (hovered ? styles.iconButtonHovered : undefined) as any,
              (!isConnected || voice?.isVoiceSwitching ? styles.buttonDisabled : undefined) as any,
            ]}
          >
            {voice?.isVoiceSwitching ? (
              <ActivityIndicator size="small" color="white" />
            ) : (
              <AudioLines size={buttonIconSize} color={theme.colors.foreground} />
            )}
          </TooltipTrigger>
          <TooltipContent side="top" align="center" offset={8}>
            <View style={styles.tooltipRow}>
              <Text style={styles.tooltipText}>Voice mode</Text>
              {voiceToggleKeys ? (
                <Shortcut chord={voiceToggleKeys} style={styles.tooltipShortcut} />
              ) : null}
            </View>
          </TooltipContent>
        </Tooltip>
      ) : null}
      {cancelButton}
    </View>
  );

  const hasContextWindowMeter =
    typeof agentState.contextWindowMaxTokens === "number" &&
    typeof agentState.contextWindowUsedTokens === "number";
  const contextWindowMaxTokens = hasContextWindowMeter ? agentState.contextWindowMaxTokens : null;
  const contextWindowUsedTokens = hasContextWindowMeter ? agentState.contextWindowUsedTokens : null;

  const beforeVoiceContent = (
    <View style={styles.contextWindowMeterSlot}>
      {contextWindowMaxTokens !== null && contextWindowUsedTokens !== null ? (
        <ContextWindowMeter
          maxTokens={contextWindowMaxTokens}
          usedTokens={contextWindowUsedTokens}
        />
      ) : null}
    </View>
  );

  const leftContent =
    resolveStatusControlMode(statusControls) === "draft" && statusControls ? (
      <DraftAgentStatusBar {...statusControls} />
    ) : (
      <AgentStatusBar agentId={agentId} serverId={serverId} onDropdownClose={focusInput} />
    );

  return (
    <Animated.View
      style={[styles.container, { paddingBottom: insets.bottom }, keyboardAnimatedStyle]}
    >
      {/* Input area */}
      <View style={styles.inputAreaContainer}>
        <View style={styles.inputAreaContent}>
          {/* Queue list */}
          {queuedMessages.length > 0 && (
            <View style={styles.queueContainer}>
              {queuedMessages.map((item) => (
                <View key={item.id} style={styles.queueItem}>
                  <Text style={styles.queueText} numberOfLines={2} ellipsizeMode="tail">
                    {item.text}
                  </Text>
                  <View style={styles.queueActions}>
                    <Pressable
                      onPress={() => handleEditQueuedMessage(item.id)}
                      style={styles.queueActionButton}
                    >
                      <Pencil size={theme.iconSize.sm} color={theme.colors.foreground} />
                    </Pressable>
                    <Pressable
                      onPress={() => handleSendQueuedNow(item.id)}
                      style={[styles.queueActionButton, styles.queueSendButton]}
                    >
                      <ArrowUp size={theme.iconSize.sm} color="white" />
                    </Pressable>
                  </View>
                </View>
              ))}
            </View>
          )}

          {sendError && <Text style={styles.sendErrorText}>{sendError}</Text>}

          <View style={styles.messageInputContainer}>
            {/* Command + file mention autocomplete rendered as a true popover */}
            {autocomplete.isVisible && (
              <View style={styles.autocompletePopover} pointerEvents="box-none">
                <Autocomplete
                  options={autocomplete.options}
                  selectedIndex={autocomplete.selectedIndex}
                  isLoading={autocomplete.isLoading}
                  errorMessage={autocomplete.errorMessage}
                  loadingText={autocomplete.loadingText}
                  emptyText={autocomplete.emptyText}
                  onSelect={autocomplete.onSelectOption}
                />
              </View>
            )}

            {/* MessageInput handles everything: text, dictation, attachments, all buttons */}
            <MessageInput
              ref={messageInputRef}
              value={userInput}
              onChangeText={setUserInput}
              onSubmit={handleSubmit}
              isSubmitDisabled={isProcessing || isSubmitLoading}
              isSubmitLoading={isProcessing || isSubmitLoading}
              images={selectedImages}
              onPickImages={handlePickImage}
              onAddImages={addImages}
              onRemoveImage={handleRemoveImage}
              client={client}
              isReadyForDictation={isDictationReady}
              placeholder={messagePlaceholder}
              autoFocus={autoFocus && isDesktopWebBreakpoint}
              autoFocusKey={`${serverId}:${agentId}`}
              disabled={isSubmitLoading}
              isPaneFocused={isPaneFocused}
              leftContent={leftContent}
              beforeVoiceContent={beforeVoiceContent}
              rightContent={rightContent}
              voiceServerId={serverId}
              voiceAgentId={agentId}
              isAgentRunning={isAgentRunning}
              defaultSendBehavior={appSettings.sendBehavior}
              onQueue={handleQueue}
              onSubmitLoadingPress={isAgentRunning ? handleCancelAgent : undefined}
              onKeyPress={handleCommandKeyPress}
              onSelectionChange={(selection) => {
                setCursorIndex(selection.start);
              }}
              onFocusChange={(focused) => {
                setIsMessageInputFocused(focused);
                if (focused) {
                  onAttentionInputFocus?.();
                }
              }}
              onHeightChange={onComposerHeightChange}
            />
          </View>
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
    overflow: "visible",
    padding: theme.spacing[4],
  },
  inputAreaContent: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
    gap: theme.spacing[3],
  },
  messageInputContainer: {
    position: "relative",
    width: "100%",
  },
  autocompletePopover: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: "100%",
    marginBottom: theme.spacing[3],
    zIndex: 30,
  },
  cancelButton: {
    width: 28,
    height: 28,
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
  contextWindowMeterSlot: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  realtimeVoiceButton: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  realtimeVoiceButtonActive: {
    backgroundColor: theme.colors.palette.green[600],
    borderColor: theme.colors.palette.green[800],
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
    backgroundColor: theme.colors.surface1,
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
    backgroundColor: theme.colors.accent,
  },
  sendErrorText: {
    color: theme.colors.palette.red[500],
    fontSize: theme.fontSize.sm,
  },
})) as any) as Record<string, any>;
