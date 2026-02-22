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
  Platform,
  BackHandler,
} from 'react-native'
import { useState, useRef, useCallback, useEffect, useImperativeHandle, forwardRef } from 'react'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { Mic, MicOff, ArrowUp, Paperclip, Plus, X, Square } from 'lucide-react-native'
import Animated, { useSharedValue, useAnimatedStyle, withTiming } from 'react-native-reanimated'
import { useDictation } from '@/hooks/use-dictation'
import { DictationOverlay } from './dictation-controls'
import { RealtimeVoiceOverlay } from './realtime-voice-overlay'
import type { DaemonClient } from '@server/client/daemon-client'
import { useSessionStore } from '@/stores/session-store'
import { useVoiceOptional } from '@/contexts/voice-context'
import { useToast } from '@/contexts/toast-context'
import { resolveVoiceUnavailableMessage } from '@/utils/server-info-capabilities'
import {
  collectImageFilesFromClipboardData,
  filesToImageAttachments,
} from '@/utils/image-attachments-from-files'
import type { AttachmentMetadata } from '@/attachments/types'
import { useAttachmentPreviewUrl } from '@/attachments/use-attachment-preview-url'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Shortcut } from '@/components/ui/shortcut'
import type { MessageInputKeyboardActionKind } from '@/keyboard/actions'

export type ImageAttachment = AttachmentMetadata

export interface MessagePayload {
  text: string
  images?: ImageAttachment[]
  /** When true, bypasses queue and sends immediately even if agent is running */
  forceSend?: boolean
}

export interface MessageInputProps {
  value: string
  onChangeText: (text: string) => void
  onSubmit: (payload: MessagePayload) => void
  isSubmitDisabled?: boolean
  isSubmitLoading?: boolean
  images?: ImageAttachment[]
  onPickImages?: () => void
  onAddImages?: (images: ImageAttachment[]) => void
  onRemoveImage?: (index: number) => void
  client: DaemonClient | null
  /** Dictation start gate from host runtime (socket connected + directory ready). */
  isReadyForDictation?: boolean
  placeholder?: string
  autoFocus?: boolean
  disabled?: boolean
  /** True when the containing screen is focused (React Navigation). Used to disable global hotkeys and cancel dictation when unfocused. */
  isScreenFocused?: boolean
  /** Content to render on the left side of the button row (e.g., AgentStatusBar) */
  leftContent?: React.ReactNode
  /** Content to render on the right side after voice button (e.g., realtime button, cancel button) */
  rightContent?: React.ReactNode
  voiceServerId?: string
  voiceAgentId?: string
  /** When true and there's sendable content, calls onQueue instead of onSubmit */
  isAgentRunning?: boolean
  /** Callback for queue button when agent is running */
  onQueue?: (payload: MessagePayload) => void
  /** Optional handler used when submit button is in loading state. */
  onSubmitLoadingPress?: () => void
  /** Intercept key press events before default handling. Return true to prevent default. */
  onKeyPress?: (event: { key: string; preventDefault: () => void }) => boolean
  /** Reports cursor selection updates from the underlying input. */
  onSelectionChange?: (selection: { start: number; end: number }) => void
}

export interface MessageInputRef {
  focus: () => void
  blur: () => void
  runKeyboardAction: (action: MessageInputKeyboardActionKind) => void
  /**
   * Web-only: return the underlying DOM element for focus assertions/retries.
   * May return null if not mounted or on native.
   */
  getNativeElement?: () => HTMLElement | null
}

const MIN_INPUT_HEIGHT = 30
const MAX_INPUT_HEIGHT = 160
const IS_WEB = Platform.OS === 'web'

type WebTextInputKeyPressEvent = NativeSyntheticEvent<
  TextInputKeyPressEventData & {
    metaKey?: boolean
    ctrlKey?: boolean
    shiftKey?: boolean
  }
>

type TextAreaHandle = {
  scrollHeight?: number
  style?: {
    height?: string
    overflowY?: string
  } & Record<string, unknown>
}

function ImageAttachmentThumbnail({ image }: { image: ImageAttachment }) {
  const uri = useAttachmentPreviewUrl(image)
  if (!uri) {
    return <View style={styles.imageThumbnailPlaceholder} />
  }
  return <Image source={{ uri }} style={styles.imageThumbnail} />
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
    placeholder = 'Message...',
    autoFocus = false,
    disabled = false,
    isScreenFocused = true,
    leftContent,
    rightContent,
    voiceServerId,
    voiceAgentId,
    isAgentRunning = false,
    onQueue,
    onSubmitLoadingPress,
    onKeyPress: onKeyPressCallback,
    onSelectionChange: onSelectionChangeCallback,
  },
  ref
) {
  const { theme } = useUnistyles()
  const toast = useToast()
  const voice = useVoiceOptional()
  const [inputHeight, setInputHeight] = useState(MIN_INPUT_HEIGHT)
  const textInputRef = useRef<TextInput | (TextInput & { getNativeRef?: () => unknown }) | null>(
    null
  )
  const isInputFocusedRef = useRef(false)

  useImperativeHandle(ref, () => ({
    focus: () => {
      textInputRef.current?.focus()
    },
    blur: () => {
      textInputRef.current?.blur?.()
    },
    runKeyboardAction: (action) => {
      if (action === 'focus') {
        textInputRef.current?.focus()
        return
      }

      if (action === 'voice-toggle') {
        handleToggleRealtimeVoiceShortcut()
        return
      }

      if (action === 'voice-mute-toggle') {
        if (isRealtimeVoiceForCurrentAgent) {
          voice?.toggleMute()
        }
        return
      }

      if (action === 'dictation-cancel') {
        if (isDictatingRef.current) {
          cancelDictation()
        }
        return
      }

      if (action === 'dictation-toggle') {
        if (isDictatingRef.current) {
          sendAfterTranscriptRef.current = true
          confirmDictation()
        } else {
          void startDictationIfAvailable()
        }
      }
    },
    getNativeElement: () => {
      if (!IS_WEB) return null
      const current = textInputRef.current as (TextInput & { getNativeRef?: () => unknown }) | null
      const native = typeof current?.getNativeRef === 'function' ? current.getNativeRef() : current
      return native instanceof HTMLElement ? native : null
    },
  }))
  const inputHeightRef = useRef(MIN_INPUT_HEIGHT)
  const baselineInputHeightRef = useRef<number | null>(null)
  const overlayTransition = useSharedValue(0)
  const sendAfterTranscriptRef = useRef(false)
  const valueRef = useRef(value)
  const serverInfo = useSessionStore(
    useCallback(
      (state) => {
        if (!voiceServerId) {
          return null
        }
        return state.sessions[voiceServerId]?.serverInfo ?? null
      },
      [voiceServerId]
    )
  )

  useEffect(() => {
    valueRef.current = value
  }, [value])

  // Autofocus on web when autoFocus prop is true
  useEffect(() => {
    if (!IS_WEB || !autoFocus) return
    // Use requestAnimationFrame to ensure DOM is ready
    const rafId = requestAnimationFrame(() => {
      textInputRef.current?.focus()
    })
    return () => cancelAnimationFrame(rafId)
  }, [autoFocus])

  const handleDictationTranscript = useCallback(
    (text: string, _meta: { requestId: string }) => {
      if (!text) return
      const current = valueRef.current
      const shouldPad = current.length > 0 && !/\s$/.test(current)
      const nextValue = `${current}${shouldPad ? ' ' : ''}${text}`

      const shouldAutoSend = sendAfterTranscriptRef.current
      sendAfterTranscriptRef.current = false

      if (shouldAutoSend) {
        const imageAttachments = images.length > 0 ? images : undefined
        onSubmit({ text: nextValue, images: imageAttachments })
      } else {
        onChangeText(nextValue)
      }

      if (IS_WEB && typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => {
          measureWebInputHeight('dictation')
        })
      }
    },
    [onChangeText, onSubmit, images]
  )

  const handleDictationError = useCallback((error: Error) => {
    console.error('[MessageInput] Dictation error:', error)
  }, [])

  const dictationUnavailableMessage = resolveVoiceUnavailableMessage({
    serverInfo,
    mode: 'dictation',
  })

  const canStartDictation = useCallback(() => {
    const socketConnected = client?.isConnected ?? false
    const readyForDictation = isReadyForDictation ?? socketConnected
    return socketConnected && readyForDictation && !disabled && !dictationUnavailableMessage
  }, [client, disabled, dictationUnavailableMessage, isReadyForDictation])

  const canConfirmDictation = useCallback(() => {
    const socketConnected = client?.isConnected ?? false
    return socketConnected
  }, [client])
  const isConnected = client?.isConnected ?? false
  const isDictationStartEnabled = (isReadyForDictation ?? isConnected) && !disabled

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
    autoStopWhenHidden:
      Platform.OS === 'web' ? undefined : { isVisible: isScreenFocused },
    enableDuration: true,
  })

  const isDictatingRef = useRef(isDictating)
  useEffect(() => {
    isDictatingRef.current = isDictating
  }, [isDictating])

  const isRealtimeVoiceForCurrentAgent =
    !!voice &&
    !!voiceServerId &&
    !!voiceAgentId &&
    voice.isVoiceModeForAgent(voiceServerId, voiceAgentId)
  const showDictationOverlay = isDictating || isDictationProcessing || dictationStatus === 'failed'
  const showRealtimeOverlay = isRealtimeVoiceForCurrentAgent
  const showOverlay = showDictationOverlay || showRealtimeOverlay

  useEffect(() => {
    if (isDictating || isDictationProcessing) {
      return
    }
    sendAfterTranscriptRef.current = false
  }, [dictationStatus, isDictating, isDictationProcessing])

  const startDictationIfAvailable = useCallback(async () => {
    if (dictationUnavailableMessage) {
      toast.error(dictationUnavailableMessage)
      return
    }
    await startDictation()
  }, [dictationUnavailableMessage, startDictation, toast])

  // Animate overlay
  useEffect(() => {
    overlayTransition.value = withTiming(showOverlay ? 1 : 0, {
      duration: 200,
    })
  }, [overlayTransition, showOverlay])

  const overlayAnimatedStyle = useAnimatedStyle(() => ({
    opacity: overlayTransition.value,
    pointerEvents: overlayTransition.value > 0.5 ? 'auto' : 'none',
  }))

  const inputAnimatedStyle = useAnimatedStyle(() => ({
    opacity: 1 - overlayTransition.value,
  }))

  const handleVoicePress = useCallback(async () => {
    if (isRealtimeVoiceForCurrentAgent && voice) {
      voice.toggleMute()
      return
    }

    if (isDictating) {
      await cancelDictation()
    } else {
      await startDictationIfAvailable()
    }
  }, [
    cancelDictation,
    isDictating,
    isRealtimeVoiceForCurrentAgent,
    startDictationIfAvailable,
    voice,
  ])

  const handleCancelRecording = useCallback(async () => {
    await cancelDictation()
  }, [cancelDictation])

  const handleAcceptRecording = useCallback(async () => {
    sendAfterTranscriptRef.current = false
    await confirmDictation()
  }, [confirmDictation])

  const handleAcceptAndSendRecording = useCallback(async () => {
    sendAfterTranscriptRef.current = true
    await confirmDictation()
  }, [confirmDictation])

  const handleRetryFailedRecording = useCallback(() => {
    void retryFailedDictation()
  }, [retryFailedDictation])

  const handleDiscardFailedRecording = useCallback(() => {
    discardFailedDictation()
  }, [discardFailedDictation])

  const handleStopRealtimeVoice = useCallback(async () => {
    if (!voice || !isRealtimeVoiceForCurrentAgent) {
      return
    }

    const tasks: Promise<unknown>[] = []
    if (isAgentRunning && client && voiceAgentId) {
      tasks.push(client.cancelAgent(voiceAgentId))
    }
    tasks.push(voice.stopVoice())

    const results = await Promise.allSettled(tasks)
    results.forEach((result) => {
      if (result.status === 'rejected') {
        console.error('[MessageInput] Failed to stop realtime voice', result.reason)
      }
    })
  }, [client, isAgentRunning, isRealtimeVoiceForCurrentAgent, voice, voiceAgentId])

  const handleToggleRealtimeVoiceShortcut = useCallback(() => {
    if (!voice || !voiceServerId || !voiceAgentId || !isConnected || disabled) {
      return
    }
    if (voice.isVoiceSwitching) {
      return
    }
    if (voice.isVoiceModeForAgent(voiceServerId, voiceAgentId)) {
      void handleStopRealtimeVoice()
      return
    }
    void voice.startVoice(voiceServerId, voiceAgentId).catch((error) => {
      console.error('[MessageInput] Failed to start realtime voice', error)
      const message =
        error instanceof Error ? error.message : typeof error === 'string' ? error : null
      if (message && message.trim().length > 0) {
        toast.error(message)
      }
    })
  }, [disabled, handleStopRealtimeVoice, isConnected, toast, voice, voiceAgentId, voiceServerId])

  const handleSendMessage = useCallback(() => {
    const trimmed = value.trim()
    if (!trimmed && images.length === 0) return
    const payload = {
      text: trimmed,
      images: images.length > 0 ? images : undefined,
      forceSend: isAgentRunning || undefined,
    }
    onSubmit(payload)
    inputHeightRef.current = MIN_INPUT_HEIGHT
    setInputHeight(MIN_INPUT_HEIGHT)
  }, [value, images, onSubmit, isAgentRunning])

  const handleQueueMessage = useCallback(() => {
    if (!onQueue) return
    const trimmed = value.trim()
    if (!trimmed && images.length === 0) return
    const payload = {
      text: trimmed,
      images: images.length > 0 ? images : undefined,
    }
    onQueue(payload)
    onChangeText('')
    inputHeightRef.current = MIN_INPUT_HEIGHT
    setInputHeight(MIN_INPUT_HEIGHT)
  }, [value, images, onQueue, onChangeText])

  // Web input height measurement
  function isTextAreaLike(v: unknown): v is TextAreaHandle {
    return typeof v === 'object' && v !== null && 'scrollHeight' in v
  }

  const getWebTextArea = useCallback((): TextAreaHandle | null => {
    const ref = textInputRef.current
    if (!ref) return null
    if (typeof (ref as any).getNativeRef === 'function') {
      const native = (ref as any).getNativeRef()
      if (isTextAreaLike(native)) return native
    }
    if (isTextAreaLike(ref)) return ref
    return null
  }, [])

  useEffect(() => {
    if (!IS_WEB || !onAddImages) {
      return
    }

    const textarea = getWebTextArea()
    if (
      !textarea ||
      typeof (textarea as any).addEventListener !== 'function' ||
      typeof (textarea as any).removeEventListener !== 'function'
    ) {
      return
    }

    let disposed = false
    const handlePaste = (event: ClipboardEvent) => {
      if (!isConnected || disabled || isDictating || isRealtimeVoiceForCurrentAgent) {
        return
      }

      const imageFiles = collectImageFilesFromClipboardData(event.clipboardData)
      if (imageFiles.length === 0) {
        return
      }

      event.preventDefault()

      void filesToImageAttachments(imageFiles)
        .then((attachments) => {
          if (disposed || attachments.length === 0) {
            return
          }
          onAddImages(attachments)
        })
        .catch((error) => {
          console.error('[MessageInput] Failed to process pasted images:', error)
        })
    }

    ;(textarea as any).addEventListener('paste', handlePaste)
    return () => {
      disposed = true
      ;(textarea as any).removeEventListener('paste', handlePaste)
    }
  }, [
    disabled,
    getWebTextArea,
    isConnected,
    isDictating,
    isRealtimeVoiceForCurrentAgent,
    onAddImages,
  ])

  function measureWebInputHeight(source: string): boolean {
    if (!IS_WEB) return false
    const textarea = getWebTextArea()
    if (!textarea || typeof textarea.scrollHeight !== 'number') return false

    const prevHeight = textarea.style?.height
    const prevOverflow = textarea.style?.overflowY
    if (textarea.style) {
      textarea.style.height = 'auto'
      textarea.style.overflowY = 'hidden'
    }

    const scrollHeight = textarea.scrollHeight ?? 0
    if (textarea.style) {
      textarea.style.height = prevHeight ?? ''
      textarea.style.overflowY = prevOverflow ?? ''
    }

    if (baselineInputHeightRef.current === null && scrollHeight > 0) {
      baselineInputHeightRef.current = scrollHeight
    }

    const baseline = baselineInputHeightRef.current ?? MIN_INPUT_HEIGHT
    const rawTarget = scrollHeight > 0 ? scrollHeight : baseline
    const bounded = Math.max(MIN_INPUT_HEIGHT, Math.min(MAX_INPUT_HEIGHT, rawTarget))

    if (Math.abs(inputHeightRef.current - bounded) >= 1) {
      inputHeightRef.current = bounded
      setInputHeight(bounded)
      return true
    }
    return false
  }

  function setBoundedInputHeight(nextHeight: number) {
    const bounded = Math.max(MIN_INPUT_HEIGHT, Math.min(MAX_INPUT_HEIGHT, nextHeight))
    if (Math.abs(inputHeightRef.current - bounded) < 1) return
    inputHeightRef.current = bounded
    setInputHeight(bounded)
  }

  function handleContentSizeChange(
    event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>
  ) {
    if (IS_WEB) {
      measureWebInputHeight('contentSizeChange')
      return
    }
    const contentHeight = event.nativeEvent.contentSize.height
    setBoundedInputHeight(contentHeight)
  }

  function handleSelectionChange(event: NativeSyntheticEvent<TextInputSelectionChangeEventData>) {
    const start = event.nativeEvent.selection?.start ?? 0
    const end = event.nativeEvent.selection?.end ?? start
    onSelectionChangeCallback?.({ start, end })
  }

  const shouldHandleDesktopSubmit = IS_WEB

  function handleDesktopKeyPress(event: WebTextInputKeyPressEvent) {
    if (!shouldHandleDesktopSubmit) return

    // Allow parent to intercept key events (e.g., for autocomplete navigation)
    if (onKeyPressCallback) {
      const handled = onKeyPressCallback({
        key: event.nativeEvent.key,
        preventDefault: () => event.preventDefault(),
      })
      if (handled) return
    }

    const { shiftKey, metaKey, ctrlKey } = event.nativeEvent

    if (event.nativeEvent.key !== 'Enter') return

    // Shift+Enter: add newline (default behavior, don't intercept)
    if (shiftKey) return

    // Cmd+Enter (Mac) or Ctrl+Enter (Windows/Linux): queue when agent is running
    if ((metaKey || ctrlKey) && isAgentRunning && onQueue) {
      if (isSubmitDisabled || isSubmitLoading || disabled) return
      event.preventDefault()
      handleQueueMessage()
      return
    }

    // Enter: send (interrupts agent if running)
    if (isSubmitDisabled || isSubmitLoading || disabled) return
    event.preventDefault()
    handleSendMessage()
  }

  const hasImages = images.length > 0
  const hasSendableContent = value.trim().length > 0 || hasImages
  const shouldShowSendButton = hasSendableContent || isSubmitLoading
  const canPressLoadingButton = isSubmitLoading && typeof onSubmitLoadingPress === 'function'
  const isSendButtonDisabled =
    disabled || (!canPressLoadingButton && (isSubmitDisabled || isSubmitLoading))
  const submitAccessibilityLabel = canPressLoadingButton
    ? 'Interrupt agent'
    : isAgentRunning
      ? 'Send and interrupt'
      : 'Send message'

  return (
    <View style={styles.container} testID="message-input-root">
      {/* Regular input */}
      <Animated.View style={[styles.inputWrapper, inputAnimatedStyle]}>
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
                          (hovered || !IS_WEB) && styles.removeImageButtonVisible,
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
        <TextInput
          ref={textInputRef}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={theme.colors.mutedForeground}
          onFocus={() => {
            isInputFocusedRef.current = true
          }}
          onBlur={() => {
            isInputFocusedRef.current = false
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
          editable={!isDictating && !isRealtimeVoiceForCurrentAgent && !disabled}
          onKeyPress={shouldHandleDesktopSubmit ? handleDesktopKeyPress : undefined}
          onSelectionChange={handleSelectionChange}
          autoFocus={IS_WEB && autoFocus}
        />

        {/* Button row */}
        <View style={styles.buttonRow}>
          {/* Left: attachment button + leftContent slot */}
          <View style={styles.leftButtonGroup}>
            {onPickImages && (
              <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
                <TooltipTrigger
                  onPress={onPickImages}
                  disabled={!isConnected || disabled}
                  accessibilityLabel="Attach images"
                  accessibilityRole="button"
                  style={[styles.attachButton, (!isConnected || disabled) && styles.buttonDisabled]}
                >
                  <Paperclip size={theme.iconSize.lg} color={theme.colors.foreground} />
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
            <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
              <TooltipTrigger
                onPress={handleVoicePress}
                disabled={!isDictationStartEnabled}
                accessibilityRole="button"
                accessibilityLabel={
                  isRealtimeVoiceForCurrentAgent
                    ? voice?.isMuted
                      ? 'Unmute Voice mode'
                      : 'Mute Voice mode'
                    : isDictating
                      ? 'Stop dictation'
                      : 'Start dictation'
                }
                style={[
                  styles.voiceButton,
                  (!isDictationStartEnabled) && styles.buttonDisabled,
                  isDictating && styles.voiceButtonRecording,
                ]}
              >
                {isDictating ? (
                  <Square size={theme.iconSize.lg} color="white" fill="white" />
                ) : isRealtimeVoiceForCurrentAgent && voice?.isMuted ? (
                  <MicOff size={theme.iconSize.lg} color={theme.colors.foreground} />
                ) : (
                  <Mic size={theme.iconSize.lg} color={theme.colors.foreground} />
                )}
              </TooltipTrigger>
              <TooltipContent side="top" align="center" offset={8}>
                <View style={styles.tooltipRow}>
                  <Text style={styles.tooltipText}>
                    {isRealtimeVoiceForCurrentAgent
                      ? voice?.isMuted
                        ? 'Unmute voice'
                        : 'Mute voice'
                      : 'Dictation'}
                  </Text>
                  <Shortcut
                    keys={isRealtimeVoiceForCurrentAgent ? ['Space'] : ['mod', 'D']}
                    style={styles.tooltipShortcut}
                  />
                </View>
              </TooltipContent>
            </Tooltip>
            {rightContent}
            {hasSendableContent && isAgentRunning && onQueue && (
              <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
                <TooltipTrigger
                  onPress={handleQueueMessage}
                  disabled={!isConnected || disabled}
                  accessibilityLabel="Queue message"
                  accessibilityRole="button"
                  style={[styles.queueButton, (!isConnected || disabled) && styles.buttonDisabled]}
                >
                  <Plus size={theme.iconSize.lg} color="white" />
                </TooltipTrigger>
                <TooltipContent side="top" align="center" offset={8}>
                  <View style={styles.tooltipRow}>
                    <Text style={styles.tooltipText}>Queue</Text>
                    <Shortcut keys={['mod', 'Enter']} style={styles.tooltipShortcut} />
                  </View>
                </TooltipContent>
              </Tooltip>
            )}
            {shouldShowSendButton && (
              <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
                <TooltipTrigger
                  onPress={canPressLoadingButton ? onSubmitLoadingPress : handleSendMessage}
                  disabled={isSendButtonDisabled}
                  accessibilityLabel={submitAccessibilityLabel}
                  accessibilityRole="button"
                  style={[styles.sendButton, isSendButtonDisabled && styles.buttonDisabled]}
                >
                  {isSubmitLoading ? (
                    <ActivityIndicator size="small" color="white" />
                  ) : (
                    <ArrowUp size={theme.iconSize.lg} color="white" />
                  )}
                </TooltipTrigger>
                <TooltipContent side="top" align="center" offset={8}>
                  <View style={styles.tooltipRow}>
                    <Text style={styles.tooltipText}>Send</Text>
                    <Shortcut keys={['Enter']} style={styles.tooltipShortcut} />
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
            errorText={dictationStatus === 'failed' ? (dictationError ?? undefined) : undefined}
            onCancel={handleCancelRecording}
            onAccept={handleAcceptRecording}
            onAcceptAndSend={handleAcceptAndSendRecording}
            onRetry={dictationStatus === 'failed' ? handleRetryFailedRecording : undefined}
            onDiscard={dictationStatus === 'failed' ? handleDiscardFailedRecording : undefined}
          />
        ) : showRealtimeOverlay && voice ? (
          <RealtimeVoiceOverlay
            volume={voice.volume}
            isMuted={voice.isMuted}
            isDetecting={voice.isDetecting}
            isSpeaking={voice.isSpeaking}
            isSwitching={voice.isVoiceSwitching}
            onToggleMute={voice.toggleMute}
            onStop={() => {
              void handleStopRealtimeVoice()
            }}
          />
        ) : null}
      </Animated.View>
    </View>
  )
})

const styles = StyleSheet.create(((theme: any) => ({
  container: {
    position: 'relative',
  },
  inputWrapper: {
    flexDirection: 'column',
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius['2xl'],
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
          transitionProperty: 'border-color',
          transitionDuration: '200ms',
          transitionTimingFunction: 'ease-in-out',
        }
      : {}),
  },
  imagePreviewContainer: {
    flexDirection: 'row',
    gap: theme.spacing[2],
    flexWrap: 'wrap',
  },
  imagePill: {
    position: 'relative',
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderAccent,
    overflow: 'hidden',
    ...(IS_WEB
      ? {
          cursor: 'pointer',
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
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    opacity: 0,
    ...(IS_WEB
      ? {
          transitionProperty: 'opacity',
          transitionDuration: '150ms',
        }
      : {}),
  },
  removeImageButtonVisible: {
    opacity: 1,
  },
  textInput: {
    width: '100%',
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.normal,
    lineHeight: theme.fontSize.lg * 1.4,
    ...(IS_WEB
      ? {
          outlineStyle: 'none' as const,
          outlineWidth: 0,
          outlineColor: 'transparent',
        }
      : {}),
  },
  buttonRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
  },
  leftButtonGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[2],
  },
  rightButtonGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[2],
  },
  attachButton: {
    width: 34,
    height: 34,
    borderRadius: theme.borderRadius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  voiceButton: {
    width: 34,
    height: 34,
    borderRadius: theme.borderRadius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  voiceButtonRecording: {
    backgroundColor: theme.colors.destructive,
  },
  queueButton: {
    width: 34,
    height: 34,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButton: {
    width: 34,
    height: 34,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
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
  overlayContainer: {
    position: 'absolute',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    right: 0,
    bottom: 0,
  },
})) as any) as Record<string, any>
