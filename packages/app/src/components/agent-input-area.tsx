import { View, Pressable, Text, ActivityIndicator, Platform } from 'react-native'
import { useState, useEffect, useRef, useCallback } from 'react'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { ArrowUp, Square, Pencil, AudioLines } from 'lucide-react-native'
import Animated, { useAnimatedStyle } from 'react-native-reanimated'
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useIsFocused } from '@react-navigation/native'
import { FOOTER_HEIGHT, MAX_CONTENT_WIDTH } from '@/constants/layout'
import { generateMessageId, type StreamItem } from '@/types/stream'
import { AgentStatusBar } from './agent-status-bar'
import { useImageAttachmentPicker } from '@/hooks/use-image-attachment-picker'
import { useSessionStore } from '@/stores/session-store'
import { useDraftStore } from '@/stores/draft-store'
import {
  MessageInput,
  type MessagePayload,
  type ImageAttachment,
  type MessageInputRef,
} from './message-input'
import { Theme } from '@/styles/theme'
import type { DraftCommandConfig } from '@/hooks/use-agent-commands-query'
import { encodeImages } from '@/utils/encode-images'
import { useKeyboardShortcutsStore } from '@/stores/keyboard-shortcuts-store'
import { focusWithRetries } from '@/utils/web-focus'
import { useVoiceOptional } from '@/contexts/voice-context'
import { useToast } from '@/contexts/toast-context'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Shortcut } from '@/components/ui/shortcut'
import { Autocomplete } from '@/components/ui/autocomplete'
import { useAgentAutocomplete } from '@/hooks/use-agent-autocomplete'
import { useHostRuntimeSession } from '@/runtime/host-runtime'

type QueuedMessage = {
  id: string
  text: string
  images?: ImageAttachment[]
}

interface AgentInputAreaProps {
  agentId: string
  serverId: string
  onSubmitMessage?: (payload: MessagePayload) => Promise<void>
  /** Externally controlled loading state. When true, disables the submit button. */
  isSubmitLoading?: boolean
  /** When true, blurs the input immediately when submitting. */
  blurOnSubmit?: boolean
  value?: string
  onChangeText?: (text: string) => void
  /** When true, auto-focuses the text input on web. */
  autoFocus?: boolean
  /** Callback to expose the addImages function to parent components */
  onAddImages?: (addImages: (images: ImageAttachment[]) => void) => void
  /** Optional draft context for listing commands before an agent exists. */
  commandDraftConfig?: DraftCommandConfig
}

const EMPTY_ARRAY: readonly QueuedMessage[] = []

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
  commandDraftConfig,
}: AgentInputAreaProps) {
  const { theme } = useUnistyles()
  const insets = useSafeAreaInsets()
  const { height: keyboardHeight } = useReanimatedKeyboardAnimation()
  const isScreenFocused = useIsFocused()
  const messageInputActionRequest = useKeyboardShortcutsStore((s) => s.messageInputActionRequest)
  const clearMessageInputActionRequest = useKeyboardShortcutsStore(
    (s) => s.clearMessageInputActionRequest
  )

  const { client, isConnected, snapshot } = useHostRuntimeSession(serverId)
  const toast = useToast()
  const voice = useVoiceOptional()
  const isDictationReady =
    isConnected &&
    (snapshot?.agentDirectoryStatus === 'ready' ||
      snapshot?.agentDirectoryStatus === 'revalidating' ||
      snapshot?.agentDirectoryStatus === 'error_after_ready')

  const agent = useSessionStore((state) => state.sessions[serverId]?.agents?.get(agentId))

  const getDraftInput = useDraftStore((state) => state.getDraftInput)
  const saveDraftInput = useDraftStore((state) => state.saveDraftInput)

  const queuedMessagesRaw = useSessionStore((state) =>
    state.sessions[serverId]?.queuedMessages?.get(agentId)
  )
  const queuedMessages = queuedMessagesRaw ?? EMPTY_ARRAY

  const setQueuedMessages = useSessionStore((state) => state.setQueuedMessages)
  const setAgentStreamTail = useSessionStore((state) => state.setAgentStreamTail)
  const setAgentStreamHead = useSessionStore((state) => state.setAgentStreamHead)

  const [internalInput, setInternalInput] = useState('')
  const userInput = value ?? internalInput
  const setUserInput = onChangeText ?? setInternalInput
  const [cursorIndex, setCursorIndex] = useState(0)
  const [isProcessing, setIsProcessing] = useState(false)
  const [selectedImages, setSelectedImages] = useState<ImageAttachment[]>([])
  const [isCancellingAgent, setIsCancellingAgent] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const lastHandledMessageInputActionRequestIdRef = useRef<number | null>(null)
  const messageInputRef = useRef<MessageInputRef>(null)

  const autocomplete = useAgentAutocomplete({
    userInput,
    cursorIndex,
    setUserInput,
    serverId,
    agentId,
    draftConfig: commandDraftConfig,
    onAutocompleteApplied: () => {
      messageInputRef.current?.focus()
    },
  })

  // Clear send error when user edits the input
  useEffect(() => {
    if (sendError && userInput) {
      setSendError(null)
    }
  }, [userInput, sendError])

  useEffect(() => {
    setCursorIndex((current) => Math.min(current, userInput.length))
  }, [userInput.length])

  const { pickImages } = useImageAttachmentPicker()
  const agentIdRef = useRef(agentId)
  const sendAgentMessageRef = useRef<
    ((agentId: string, text: string, images?: ImageAttachment[]) => Promise<void>) | null
  >(null)
  const onSubmitMessageRef = useRef(onSubmitMessage)

  // Expose addImages function to parent for drag-and-drop support
  const addImages = useCallback((images: ImageAttachment[]) => {
    setSelectedImages((prev) => [...prev, ...images])
  }, [])

  useEffect(() => {
    onAddImages?.(addImages)
  }, [addImages, onAddImages])

  const submitMessage = useCallback(async (text: string, images?: ImageAttachment[]) => {
    if (onSubmitMessageRef.current) {
      await onSubmitMessageRef.current({ text, images })
      return
    }
    if (!sendAgentMessageRef.current) {
      throw new Error('Host is not connected')
    }
    await sendAgentMessageRef.current(agentIdRef.current, text, images)
  }, [])

  useEffect(() => {
    agentIdRef.current = agentId
  }, [agentId])

  useEffect(() => {
    sendAgentMessageRef.current = async (
      agentId: string,
      text: string,
      images?: ImageAttachment[]
    ) => {
      if (!client) {
        throw new Error('Host is not connected')
      }

      const messageId = generateMessageId()
      const userMessage: StreamItem = {
        kind: 'user_message',
        id: messageId,
        text,
        timestamp: new Date(),
        ...(images && images.length > 0 ? { images } : {}),
      }

      // Append to head if streaming (keeps the user message with the current
      // turn so late text_deltas still find the existing assistant_message).
      // Otherwise append to tail.
      const currentHead = useSessionStore
        .getState()
        .sessions[serverId]?.agentStreamHead?.get(agentId)
      if (currentHead && currentHead.length > 0) {
        setAgentStreamHead(serverId, (prev) => {
          const head = prev.get(agentId) || []
          const updated = new Map(prev)
          updated.set(agentId, [...head, userMessage])
          return updated
        })
      } else {
        setAgentStreamTail(serverId, (prev) => {
          const currentStream = prev.get(agentId) || []
          const updated = new Map(prev)
          updated.set(agentId, [...currentStream, userMessage])
          return updated
        })
      }

      const imagesData = await encodeImages(images)
      await client.sendAgentMessage(agentId, text, {
        messageId,
        ...(imagesData && imagesData.length > 0 ? { images: imagesData } : {}),
      })
    }
  }, [client, serverId, setAgentStreamTail, setAgentStreamHead])

  useEffect(() => {
    onSubmitMessageRef.current = onSubmitMessage
  }, [onSubmitMessage])

  const isAgentRunning = agent?.status === 'running'
  const agentUpdatedAtMs = agent?.updatedAt?.getTime() ?? 0

  const prevIsAgentRunningRef = useRef(isAgentRunning)
  const latestAgentUpdatedAtRef = useRef(agentUpdatedAtMs)
  useEffect(() => {
    const previousUpdatedAt = latestAgentUpdatedAtRef.current
    if (agentUpdatedAtMs < previousUpdatedAt) {
      if (isProcessing && !isAgentRunning) {
        prevIsAgentRunningRef.current = false
        setIsProcessing(false)
      }
      return
    }

    const wasRunning = prevIsAgentRunningRef.current
    let shouldClearProcessing = false

    if (isProcessing) {
      const hasEnteredRunning = !wasRunning && isAgentRunning
      const hasFreshRunningUpdateWhileRunning =
        wasRunning && isAgentRunning && agentUpdatedAtMs > previousUpdatedAt
      const hasStoppedRunning = wasRunning && !isAgentRunning

      shouldClearProcessing =
        hasEnteredRunning || hasFreshRunningUpdateWhileRunning || hasStoppedRunning
    }

    prevIsAgentRunningRef.current = isAgentRunning
    latestAgentUpdatedAtRef.current = agentUpdatedAtMs

    if (shouldClearProcessing) {
      setIsProcessing(false)
    }
  }, [agentUpdatedAtMs, isAgentRunning, isProcessing])

  const updateQueue = useCallback(
    (updater: (current: QueuedMessage[]) => QueuedMessage[]) => {
      setQueuedMessages(serverId, (prev: Map<string, QueuedMessage[]>) => {
        const next = new Map(prev)
        next.set(agentId, updater(prev.get(agentId) ?? []))
        return next
      })
    },
    [agentId, serverId, setQueuedMessages]
  )

  function queueMessage(message: string, imageAttachments?: ImageAttachment[]) {
    const trimmedMessage = message.trim()
    if (!trimmedMessage && !imageAttachments?.length) return

    const newItem = {
      id: generateMessageId(),
      text: trimmedMessage,
      images: imageAttachments,
    }

    setQueuedMessages(serverId, (prev: Map<string, QueuedMessage[]>) => {
      const next = new Map(prev)
      next.set(agentId, [...(prev.get(agentId) ?? []), newItem])
      return next
    })

    const isControlled = value !== undefined
    if (!isControlled) {
      setUserInput('')
    }
    setSelectedImages([])
  }

  async function sendMessageWithContent(
    message: string,
    imageAttachments?: ImageAttachment[],
    forceSend?: boolean
  ) {
    const trimmedMessage = message.trim()
    if (!trimmedMessage) return
    // When the parent controls submission (e.g. draft agent creation), let it
    // decide what to do even if the socket is currently disconnected (so we
    // don't no-op and lose deterministic error handling in the UI/tests).
    if (!sendAgentMessageRef.current && !onSubmitMessageRef.current) return

    if (agent?.status === 'running' && !forceSend) {
      queueMessage(trimmedMessage, imageAttachments)
      return
    }

    // Clear input optimistically before awaiting server ack.
    // Save values so we can restore on error.
    const savedImages = imageAttachments
    if (!onSubmitMessageRef.current) {
      if (value !== undefined) {
        onChangeText?.('')
      } else {
        setUserInput('')
      }
    }
    setSelectedImages([])
    setSendError(null)
    setIsProcessing(true)

    try {
      await submitMessage(trimmedMessage, imageAttachments)
    } catch (error) {
      console.error('[AgentInput] Failed to send message:', error)
      // Restore input so the user never loses their message
      if (!onSubmitMessageRef.current) {
        if (value !== undefined) {
          onChangeText?.(trimmedMessage)
        } else {
          setUserInput(trimmedMessage)
        }
      }
      if (savedImages) {
        setSelectedImages(savedImages)
      }
      setSendError(error instanceof Error ? error.message : 'Failed to send message')
      setIsProcessing(false)
    }
  }

  function handleSubmit(payload: MessagePayload) {
    if (blurOnSubmit) {
      messageInputRef.current?.blur()
    }
    void sendMessageWithContent(payload.text, payload.images, payload.forceSend)
  }

  async function handlePickImage() {
    const result = await pickImages()
    if (!result?.assets?.length) {
      return
    }

    const newImages = result.assets.map((asset) => ({
      uri: asset.uri,
      mimeType: asset.mimeType || 'image/jpeg',
    }))
    setSelectedImages((prev) => [...prev, ...newImages])
  }

  function handleRemoveImage(index: number) {
    setSelectedImages((prev) => prev.filter((_, i) => i !== index))
  }

  useEffect(() => {
    if (!isAgentRunning || !isConnected) {
      setIsCancellingAgent(false)
    }
  }, [isAgentRunning, isConnected])

  // Hydrate draft only when switching agents (uncontrolled mode only)
  const isControlled = value !== undefined
  useEffect(() => {
    // Skip draft hydration for controlled inputs - parent manages state
    if (isControlled) {
      return
    }
    const draft = getDraftInput(agentId)
    if (!draft) {
      setUserInput('')
      setSelectedImages([])
      return
    }

    setUserInput(draft.text)
    setSelectedImages(draft.images as ImageAttachment[])
  }, [agentId, getDraftInput, isControlled])

  // Persist drafts into the shared session store with change detection to avoid redundant work
  useEffect(() => {
    const existing = getDraftInput(agentId)
    const isSameText = existing?.text === userInput
    const existingImages: ImageAttachment[] = (existing?.images ?? []) as ImageAttachment[]
    const isSameImages =
      existingImages.length === selectedImages.length &&
      existingImages.every((img, idx) => {
        return (
          img.uri === selectedImages[idx]?.uri && img.mimeType === selectedImages[idx]?.mimeType
        )
      })

    if (isSameText && isSameImages) {
      return
    }

    saveDraftInput(agentId, { text: userInput, images: selectedImages })
  }, [agentId, userInput, selectedImages, getDraftInput, saveDraftInput])

  // Keyboard-dispatched message-input actions are routed through store requests.
  useEffect(() => {
    if (!isScreenFocused) return
    if (!messageInputActionRequest) return

    const currentKey = `${serverId}:${agentId}`
    if (messageInputActionRequest.agentKey !== currentKey) {
      return
    }

    if (lastHandledMessageInputActionRequestIdRef.current === messageInputActionRequest.id) {
      return
    }
    lastHandledMessageInputActionRequestIdRef.current = messageInputActionRequest.id

    if (messageInputActionRequest.kind !== 'focus') {
      messageInputRef.current?.runKeyboardAction(messageInputActionRequest.kind)
      clearMessageInputActionRequest(messageInputActionRequest.id)
      return
    }

    if (Platform.OS !== 'web') {
      messageInputRef.current?.focus()
      clearMessageInputActionRequest(messageInputActionRequest.id)
      return
    }

    return focusWithRetries({
      focus: () => messageInputRef.current?.focus(),
      isFocused: () => {
        const el = messageInputRef.current?.getNativeElement?.() ?? null
        const active = typeof document !== 'undefined' ? document.activeElement : null
        return Boolean(el) && active === el
      },
      onSuccess: () => clearMessageInputActionRequest(messageInputActionRequest.id),
      onTimeout: () => clearMessageInputActionRequest(messageInputActionRequest.id),
    })
  }, [
    agentId,
    clearMessageInputActionRequest,
    isScreenFocused,
    messageInputActionRequest,
    serverId,
  ])

  const keyboardAnimatedStyle = useAnimatedStyle(() => {
    'worklet'
    const absoluteHeight = Math.abs(keyboardHeight.value)
    const shift = Math.max(0, absoluteHeight - insets.bottom)
    return {
      transform: [{ translateY: -shift }],
    }
  })

  function handleCancelAgent() {
    if (!agent || agent.status !== 'running' || isCancellingAgent) {
      return
    }
    if (!isConnected || !client) {
      return
    }
    setIsCancellingAgent(true)
    void client.cancelAgent(agentIdRef.current)
    messageInputRef.current?.focus()
  }

  const isVoiceModeForAgent = voice?.isVoiceModeForAgent(serverId, agentId) ?? false

  const handleToggleRealtimeVoice = useCallback(() => {
    if (!voice || !isConnected) {
      return
    }
    if (voice.isVoiceSwitching) {
      return
    }
    if (voice.isVoiceModeForAgent(serverId, agentId)) {
      return
    }
    void voice.startVoice(serverId, agentId).catch((error) => {
      console.error('[AgentInputArea] Failed to start voice mode', error)
      const message =
        error instanceof Error ? error.message : typeof error === 'string' ? error : null
      if (message && message.trim().length > 0) {
        toast.error(message)
      }
    })
  }, [agentId, isConnected, serverId, toast, voice])

  function handleEditQueuedMessage(id: string) {
    const item = queuedMessages.find((q) => q.id === id)
    if (!item) return

    updateQueue((current) => current.filter((q) => q.id !== id))
    setUserInput(item.text)
    setSelectedImages(item.images ?? [])
  }

  async function handleSendQueuedNow(id: string) {
    const item = queuedMessages.find((q) => q.id === id)
    if (!item) return
    if (!sendAgentMessageRef.current && !onSubmitMessageRef.current) return

    updateQueue((current) => current.filter((q) => q.id !== id))

    // Reuse the regular send path; server-side send atomically interrupts any active run.
    try {
      await submitMessage(item.text, item.images)
    } catch (error) {
      updateQueue((current) => [item, ...current])
      setSendError(error instanceof Error ? error.message : 'Failed to send message')
    }
  }

  const handleQueue = useCallback((payload: MessagePayload) => {
    queueMessage(payload.text, payload.images)
  }, [])

  const hasSendableContent = userInput.trim().length > 0 || selectedImages.length > 0

  // Handle keyboard navigation for command autocomplete and stop action.
  const handleCommandKeyPress = useCallback(
    (event: { key: string; preventDefault: () => void }) => {
      if (
        event.key === 'Escape' &&
        isAgentRunning &&
        !hasSendableContent &&
        !isCancellingAgent &&
        isConnected
      ) {
        event.preventDefault()
        handleCancelAgent()
        return true
      }

      return autocomplete.onKeyPress(event)
    },
    [
      autocomplete,
      hasSendableContent,
      isAgentRunning,
      isCancellingAgent,
      isConnected,
      handleCancelAgent,
    ]
  )

  const cancelButton =
    isAgentRunning && !hasSendableContent && !isProcessing ? (
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger
          onPress={handleCancelAgent}
          disabled={!isConnected || isCancellingAgent}
          accessibilityLabel={isCancellingAgent ? 'Canceling agent' : 'Stop agent'}
          accessibilityRole="button"
          style={[
            styles.cancelButton as any,
            (!isConnected || isCancellingAgent ? styles.buttonDisabled : undefined) as any,
          ]}
        >
          {isCancellingAgent ? (
            <ActivityIndicator size="small" color="white" />
          ) : (
            <Square size={theme.iconSize.lg} color="white" fill="white" />
          )}
        </TooltipTrigger>
        <TooltipContent side="top" align="center" offset={8}>
          <View style={styles.tooltipRow}>
            <Text style={styles.tooltipText}>Interrupt</Text>
            <Shortcut keys={['Esc']} style={styles.tooltipShortcut} />
          </View>
        </TooltipContent>
      </Tooltip>
    ) : null

  const rightContent = (
    <View style={styles.rightControls}>
      {!isVoiceModeForAgent ? (
        <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
          <TooltipTrigger
            onPress={handleToggleRealtimeVoice}
            disabled={!isConnected || voice?.isVoiceSwitching}
            accessibilityLabel="Enable Voice mode"
            accessibilityRole="button"
            style={[
              styles.realtimeVoiceButton as any,
              (!isConnected || voice?.isVoiceSwitching ? styles.buttonDisabled : undefined) as any,
            ]}
          >
            {voice?.isVoiceSwitching ? (
              <ActivityIndicator size="small" color="white" />
            ) : (
              <AudioLines size={theme.iconSize.lg} color={theme.colors.foreground} />
            )}
          </TooltipTrigger>
          <TooltipContent side="top" align="center" offset={8}>
            <View style={styles.tooltipRow}>
              <Text style={styles.tooltipText}>Voice mode</Text>
              <Shortcut keys={['mod', 'shift', 'D']} style={styles.tooltipShortcut} />
            </View>
          </TooltipContent>
        </Tooltip>
      ) : null}
      {cancelButton}
    </View>
  )

  const leftContent = <AgentStatusBar agentId={agentId} serverId={serverId} />

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
              onSubmitLoadingPress={isAgentRunning ? handleCancelAgent : undefined}
              onKeyPress={handleCommandKeyPress}
              onSelectionChange={(selection) => {
                setCursorIndex(selection.start)
              }}
            />
          </View>
        </View>
      </View>
    </Animated.View>
  )
}

const BUTTON_SIZE = 40

const styles = StyleSheet.create(((theme: Theme) => ({
  container: {
    flexDirection: 'column',
    position: 'relative',
  },
  borderSeparator: {
    height: theme.borderWidth[1],
    backgroundColor: theme.colors.border,
  },
  inputAreaContainer: {
    position: 'relative',
    minHeight: FOOTER_HEIGHT,
    marginHorizontal: 'auto',
    alignItems: 'center',
    width: '100%',
    overflow: 'visible',
    padding: theme.spacing[4],
  },
  inputAreaContent: {
    width: '100%',
    maxWidth: MAX_CONTENT_WIDTH,
    gap: theme.spacing[3],
  },
  messageInputContainer: {
    position: 'relative',
    width: '100%',
  },
  autocompletePopover: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: '100%',
    marginBottom: theme.spacing[3],
    zIndex: 30,
  },
  cancelButton: {
    width: 34,
    height: 34,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.palette.red[600],
    alignItems: 'center',
    justifyContent: 'center',
  },
  rightControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[2],
  },
  realtimeVoiceButton: {
    width: 34,
    height: 34,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface0,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  realtimeVoiceButtonActive: {
    backgroundColor: theme.colors.palette.green[600],
    borderColor: theme.colors.palette.green[800],
  },
  tooltipRow: {
    flexDirection: 'row',
    alignItems: 'center',
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
    flexDirection: 'column',
    gap: theme.spacing[2],
  },
  queueItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
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
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[2],
  },
  queueActionButton: {
    width: 32,
    height: 32,
    borderRadius: theme.borderRadius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surface2,
  },
  queueSendButton: {
    backgroundColor: theme.colors.accent,
  },
  sendErrorText: {
    color: theme.colors.palette.red[500],
    fontSize: theme.fontSize.sm,
  },
})) as any) as Record<string, any>
