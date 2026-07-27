import {
  View,
  Text,
  TextInput,
  Pressable,
  Platform,
  ActivityIndicator,
  useWindowDimensions,
  NativeSyntheticEvent,
  TextInputContentSizeChangeEventData,
  TextInputSelectionChangeEventData,
} from "react-native";
import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useImperativeHandle,
  useMemo,
  forwardRef,
} from "react";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { ArrowUp, Mic, MicOff, CornerDownLeft, Plus, Square } from "lucide-react-native";
import { useDictation } from "@/hooks/use-dictation";
import { DictationOverlay } from "@/components/dictation-controls";
import { RealtimeVoiceOverlay } from "@/components/realtime-voice-overlay";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useSessionStore } from "@/stores/session-store";
import { useVoiceOptional } from "@/contexts/voice-context";
import { useToast } from "@/contexts/toast-context";
import { resolveVoiceUnavailableMessage } from "@/utils/server-info-capabilities";
import {
  collectImageFilesFromClipboardData,
  filesToImageAttachments,
} from "@/utils/image-attachments-from-files";
import type { ComposerAttachment } from "@/attachments/types";
import type { ImageAttachment, MessagePayload } from "@/composer/types";
import { computeSendableContent } from "./sendable-content";
import { focusWithRetries } from "@/utils/web-focus";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Shortcut } from "@/components/ui/shortcut";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { useDismissKeyboardOnOpen } from "@/components/ui/keyboard-dismiss";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { useIosHardwareKeyboardSubmit } from "@/hooks/use-ios-hardware-keyboard-submit";
import { formatShortcut, type ShortcutKey } from "@/utils/format-shortcut";
import { getShortcutOs } from "@/utils/shortcut-platform";
import type { MessageInputKeyboardActionKind } from "@/keyboard/actions";
import { isWeb } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useComposerHeightMirror } from "./height-mirror";
import {
  resolveSendTooltipLabel,
  resolveSubmitAccessibilityLabel,
  resolveVoiceAccessibilityLabel,
  resolveVoiceTooltipText,
} from "./labels";
import {
  computeCanStartDictation,
  resolveComposerSurfacePresentation,
  runAlternateSendAction,
  runDefaultSendAction,
  runMessageInputKeyboardAction,
  stopRealtimeVoice,
} from "./state";
import {
  handleComposerBeforeInput,
  handleComposerKeyPress,
  shouldSubmitComposerFromNativeReturn,
} from "./key-press";
import { resolveComposerPrimaryButtonState, runComposerPrimaryButtonAction } from "./button-state";

const DEFAULT_SEND_KEYS: ShortcutKey[][] = [["Enter"]];
const MOD_SEND_KEYS: ShortcutKey[][] = [["mod", "Enter"]];
const COMPOSER_INPUT_DATASET = { composerInput: "" } as const;

export type EnterKeyBehavior = "send" | "newline";

export interface AttachmentMenuItem {
  id: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  icon?: React.ReactElement | null;
}

export interface MessageInputProps {
  value: string;
  onChangeText: (text: string) => void;
  onSubmit: (payload: MessagePayload) => void;
  /** When true, the submit button is enabled even without text or images (e.g. external attachment selected). */
  hasExternalContent?: boolean;
  /** When true, the submit button stays visible and can submit even with no content. */
  allowEmptySubmit?: boolean;
  /** Optional accessibility label for the primary submit button. */
  submitButtonAccessibilityLabel?: string;
  /** Optional testID for the primary submit button. */
  submitButtonTestID?: string;
  submitIcon?: "arrow" | "return";
  isSubmitDisabled?: boolean;
  isSubmitLoading?: boolean;
  /** When true, keep the grown input height after submit (text is preserved, not cleared). */
  preserveHeightOnSubmit?: boolean;
  attachments: ComposerAttachment[];
  cwd: string;
  attachmentMenuItems: AttachmentMenuItem[];
  onAttachButtonRef?: (node: View | null) => void;
  onAddImages?: (images: ImageAttachment[]) => void;
  client: DaemonClient | null;
  /** Dictation start gate from host runtime (socket connected + directory ready). */
  isReadyForDictation?: boolean;
  /**
   * When false, hide the dictation mic (host feature disabled).
   * When undefined/true, show it. Mute control during active voice mode still shows.
   */
  isDictationFeatureEnabled?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  autoFocusKey?: string;
  disabled?: boolean;
  /** True when this composer's pane is focused. Used to gate global hotkeys and stop dictation when hidden. */
  isPaneFocused?: boolean;
  /** Content to render on the left side of the composer toolbar (e.g., AgentControls) */
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
  /** When "always", keep the send button visible (disabled when empty). */
  sendButtonVisibility?: "always" | "whenContent";
  /** Controls whether a plain Enter submits or inserts a newline. */
  enterKeyBehavior?: EnterKeyBehavior;
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
  /** Extra styles merged onto the input wrapper (e.g. elevated background). */
  inputWrapperStyle?: import("react-native").ViewStyle;
  /** Content rendered inside the bordered input surface, above the text input (e.g. attachment pills). */
  attachmentSlot?: React.ReactNode;
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

const MIN_INPUT_HEIGHT_MOBILE = 30;
const MIN_INPUT_HEIGHT_DESKTOP = 46;
const DEFAULT_MAX_INPUT_HEIGHT = 160;
const MAX_INPUT_VIEWPORT_RATIO = 0.5;
const MIN_INPUT_HEIGHT = isWeb ? MIN_INPUT_HEIGHT_DESKTOP : MIN_INPUT_HEIGHT_MOBILE;
const ATTACHMENT_SHEET_SNAP_POINTS = ["34%", "45%"];

interface TextAreaHandle {
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
}

function AttachButtonIcon({
  hovered,
  onAttachButtonRef,
  buttonIconSize,
}: {
  hovered: boolean;
  onAttachButtonRef: ((node: View | null) => void) | undefined;
  buttonIconSize: number;
}) {
  // Prefer themed variants over uniProps — lucide forwards unknown props to SVG <path> on web.
  const Icon = hovered ? ThemedPlusForeground : ThemedPlusMuted;
  return (
    <View ref={onAttachButtonRef} collapsable={false} style={styles.attachButtonAnchor}>
      <Icon size={buttonIconSize} />
    </View>
  );
}

function AttachmentMenuList({ items }: { items: AttachmentMenuItem[] }) {
  return (
    <>
      {items.map((item) => (
        <DropdownMenuItem
          key={item.id}
          testID={`message-input-attachment-menu-item-${item.id}`}
          disabled={item.disabled}
          onSelect={item.onSelect}
          leading={item.icon ?? null}
        >
          {item.label}
        </DropdownMenuItem>
      ))}
    </>
  );
}

function AttachmentSheetItem({
  item,
  onSelect,
}: {
  item: AttachmentMenuItem;
  onSelect: (item: AttachmentMenuItem) => void;
}) {
  const handlePress = useCallback(() => {
    onSelect(item);
  }, [item, onSelect]);
  const pressableStyle = useCallback(
    ({ pressed }: { pressed: boolean }) => [
      styles.attachmentSheetItem,
      pressed && styles.attachmentSheetItemPressed,
      item.disabled && styles.buttonDisabled,
    ],
    [item.disabled],
  );

  return (
    <Pressable
      testID={`message-input-attachment-menu-item-${item.id}`}
      accessibilityRole="button"
      disabled={item.disabled}
      onPress={handlePress}
      style={pressableStyle}
    >
      {item.icon ? <View style={styles.attachmentSheetItemIcon}>{item.icon}</View> : null}
      <Text style={styles.attachmentSheetItemText}>{item.label}</Text>
    </Pressable>
  );
}

function AttachmentSheetList({
  items,
  onSelect,
}: {
  items: AttachmentMenuItem[];
  onSelect: (item: AttachmentMenuItem) => void;
}) {
  return (
    <View style={styles.attachmentSheetList}>
      {items.map((item) => (
        <AttachmentSheetItem key={item.id} item={item} onSelect={onSelect} />
      ))}
    </View>
  );
}

function AttachmentDropdown({
  isConnected,
  disabled,
  attachButtonStyle,
  renderAttachButtonIcon,
  attachmentMenuItems,
  addAttachmentLabel,
}: {
  isConnected: boolean;
  disabled: boolean;
  attachButtonStyle: React.ComponentProps<typeof DropdownMenuTrigger>["style"];
  renderAttachButtonIcon: (input: { hovered?: boolean }) => React.ReactElement;
  attachmentMenuItems: AttachmentMenuItem[];
  addAttachmentLabel: string;
}) {
  const isCompact = useIsCompactFormFactor();
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  useDismissKeyboardOnOpen(isSheetOpen, isCompact);

  const isButtonDisabled = !isConnected || disabled;
  const attachmentSheetHeader = useMemo<SheetHeader>(
    () => ({ title: addAttachmentLabel }),
    [addAttachmentLabel],
  );
  const handleOpenSheet = useCallback(() => {
    if (isButtonDisabled) return;
    setIsSheetOpen(true);
  }, [isButtonDisabled]);
  const handleCloseSheet = useCallback(() => {
    setIsSheetOpen(false);
  }, []);
  const handleSheetItemSelect = useCallback((item: AttachmentMenuItem) => {
    if (item.disabled) return;
    setIsSheetOpen(false);
    if (Platform.OS === "ios") {
      setTimeout(item.onSelect, 250);
      return;
    }
    item.onSelect();
  }, []);
  const mobileAttachButtonStyle = useCallback(
    (state: { pressed: boolean; hovered?: boolean }) => {
      if (typeof attachButtonStyle === "function") {
        return attachButtonStyle({ ...state, hovered: Boolean(state.hovered), open: isSheetOpen });
      }
      return attachButtonStyle;
    },
    [attachButtonStyle, isSheetOpen],
  );
  const renderMobileAttachButtonIcon = useCallback(
    ({ hovered }: { hovered?: boolean }) => renderAttachButtonIcon({ hovered }),
    [renderAttachButtonIcon],
  );

  if (isCompact) {
    return (
      <>
        <Pressable
          disabled={isButtonDisabled}
          accessibilityLabel={addAttachmentLabel}
          accessibilityRole="button"
          testID="message-input-attach-button"
          onPress={handleOpenSheet}
          style={mobileAttachButtonStyle}
        >
          {renderMobileAttachButtonIcon}
        </Pressable>
        <AdaptiveModalSheet
          header={attachmentSheetHeader}
          visible={isSheetOpen}
          onClose={handleCloseSheet}
          snapPoints={ATTACHMENT_SHEET_SNAP_POINTS}
          testID="message-input-attachment-menu"
        >
          <AttachmentSheetList items={attachmentMenuItems} onSelect={handleSheetItemSelect} />
        </AdaptiveModalSheet>
      </>
    );
  }

  return (
    <DropdownMenu>
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger
            disabled={isButtonDisabled}
            accessibilityLabel={addAttachmentLabel}
            accessibilityRole="button"
            testID="message-input-attach-button"
            style={attachButtonStyle}
          >
            {renderAttachButtonIcon}
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" align="center" offset={8}>
          <Text style={styles.tooltipText}>{addAttachmentLabel}</Text>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        side="top"
        align="start"
        offset={8}
        minWidth={220}
        testID="message-input-attachment-menu"
      >
        <AttachmentMenuList items={attachmentMenuItems} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function VoiceButtonIcon({
  hovered,
  isDictating,
  isMutedRealtime,
  buttonIconSize,
}: {
  hovered: boolean;
  isDictating: boolean;
  isMutedRealtime: boolean;
  buttonIconSize: number;
}) {
  if (isDictating) {
    return <Square size={buttonIconSize} color="white" fill="white" />;
  }
  if (isMutedRealtime) {
    const Icon = hovered ? ThemedMicOffForeground : ThemedMicOffMuted;
    return <Icon size={buttonIconSize} />;
  }
  const Icon = hovered ? ThemedMicForeground : ThemedMicMuted;
  return <Icon size={buttonIconSize} />;
}

type ShortcutChord = NonNullable<React.ComponentProps<typeof Shortcut>["chord"]>;

function VoiceTooltipBody({
  voiceTooltipText,
  shortcut,
}: {
  voiceTooltipText: string;
  shortcut: ShortcutChord | null | undefined;
}) {
  return (
    <View style={styles.tooltipRow}>
      <Text style={styles.tooltipText}>{voiceTooltipText}</Text>
      {shortcut ? <Shortcut chord={shortcut} /> : null}
    </View>
  );
}

function SendTooltipBody({
  label,
  sendKeys,
}: {
  label: string;
  sendKeys: ShortcutChord | null | undefined;
}) {
  return (
    <View style={styles.tooltipRow}>
      <Text style={styles.tooltipText}>{label}</Text>
      {sendKeys ? <Shortcut chord={sendKeys} /> : null}
    </View>
  );
}

function SendButtonContent({
  isSubmitLoading,
  isStopButton,
  submitIcon,
  buttonIconSize,
}: {
  isSubmitLoading: boolean;
  isStopButton: boolean;
  submitIcon: "arrow" | "return";
  buttonIconSize: number;
}) {
  if (isStopButton) {
    return <View style={styles.stopIcon} />;
  }
  if (isSubmitLoading) {
    return <ThemedActivityIndicatorAccent size="small" />;
  }
  if (submitIcon === "return") {
    return <ThemedCornerDownLeftAccent size={buttonIconSize} />;
  }
  return <ThemedArrowUpAccent size={buttonIconSize} />;
}

function useWebComposerKeyDown(
  getWebTextArea: () => TextAreaHandle | null,
  onKeyDown: (event: KeyboardEvent) => void,
  remountToken: string | undefined,
) {
  const onKeyDownRef = useRef(onKeyDown);
  onKeyDownRef.current = onKeyDown;

  useEffect(() => {
    if (!isWeb) return;
    const element = getWebTextArea();
    if (!(element instanceof HTMLElement)) return;
    const handleKeyDown = (event: KeyboardEvent) => onKeyDownRef.current(event);
    element.addEventListener("keydown", handleKeyDown);
    return () => element.removeEventListener("keydown", handleKeyDown);
  }, [getWebTextArea, remountToken]);
}

function useMobileWebComposerBeforeInput(
  getWebTextArea: () => TextAreaHandle | null,
  enabled: boolean,
  onBeforeInput: (event: InputEvent) => void,
  remountToken: string | undefined,
) {
  const onBeforeInputRef = useRef(onBeforeInput);
  onBeforeInputRef.current = onBeforeInput;

  useEffect(() => {
    if (!isWeb || !enabled) return;
    const element = getWebTextArea();
    if (!(element instanceof HTMLElement)) return;
    const handleBeforeInput = (event: Event) => onBeforeInputRef.current(event as InputEvent);
    element.addEventListener("beforeinput", handleBeforeInput);
    return () => element.removeEventListener("beforeinput", handleBeforeInput);
  }, [enabled, getWebTextArea, remountToken]);
}

function resolveTextInputReturnConfiguration(shouldSubmitOnEnter: boolean): {
  submitBehavior: "submit" | "newline" | undefined;
  returnKeyType: "send" | "default";
} {
  if (isWeb) {
    return {
      submitBehavior: undefined,
      returnKeyType: shouldSubmitOnEnter ? "send" : "default",
    };
  }
  return shouldSubmitOnEnter
    ? { submitBehavior: "submit", returnKeyType: "send" }
    : { submitBehavior: "newline", returnKeyType: "default" };
}

function getTextInputNativeElement(
  current: TextInput | (TextInput & { getNativeRef?: () => unknown }) | null,
): HTMLElement | null {
  if (!current) return null;
  const handle = current as TextInput & { getNativeRef?: () => unknown };
  const native = typeof handle.getNativeRef === "function" ? handle.getNativeRef() : current;
  return native instanceof HTMLElement ? native : null;
}

interface PasteImagesEffectArgs {
  getWebTextArea: () => TextAreaHandle | null;
  isConnected: boolean;
  disabled: boolean;
  isDictating: boolean;
  isRealtimeVoiceForCurrentAgent: boolean;
  onAddImages: ((images: ImageAttachment[]) => void) | undefined;
}

function usePasteImagesEffect(args: PasteImagesEffectArgs): void {
  const {
    getWebTextArea,
    isConnected,
    disabled,
    isDictating,
    isRealtimeVoiceForCurrentAgent,
    onAddImages,
  } = args;

  useEffect(() => {
    if (!isWeb || !onAddImages) return;

    const textarea = getWebTextArea() as
      | (TextAreaHandle & {
          addEventListener?: (type: string, listener: (e: ClipboardEvent) => void) => void;
          removeEventListener?: (type: string, listener: (e: ClipboardEvent) => void) => void;
        })
      | null;
    if (
      !textarea ||
      typeof textarea.addEventListener !== "function" ||
      typeof textarea.removeEventListener !== "function"
    ) {
      return;
    }

    let disposed = false;
    const handlePaste = (event: ClipboardEvent) => {
      if (!isConnected || disabled || isDictating || isRealtimeVoiceForCurrentAgent) return;

      const imageFiles = collectImageFilesFromClipboardData(event.clipboardData);
      if (imageFiles.length === 0) return;

      event.preventDefault();

      void filesToImageAttachments(imageFiles)
        .then((pastedAttachments) => {
          if (disposed || pastedAttachments.length === 0) return;
          onAddImages(pastedAttachments);
          return;
        })
        .catch((error) => {
          console.error("[MessageInput] Failed to process pasted images:", error);
        });
    };

    textarea.addEventListener("paste", handlePaste);
    return () => {
      disposed = true;
      textarea.removeEventListener?.("paste", handlePaste);
    };
  }, [
    disabled,
    getWebTextArea,
    isConnected,
    isDictating,
    isRealtimeVoiceForCurrentAgent,
    onAddImages,
  ]);
}

function useAutoFocusOnWebEffect(
  textInputRef: React.MutableRefObject<
    TextInput | (TextInput & { getNativeRef?: () => unknown }) | null
  >,
  autoFocus: boolean,
  autoFocusKey: string | undefined,
): void {
  useEffect(() => {
    if (!isWeb || !autoFocus) return;
    return focusWithRetries({
      focus: () => textInputRef.current?.focus(),
      isFocused: () => {
        const element = getTextInputNativeElement(textInputRef.current);
        const active = typeof document !== "undefined" ? document.activeElement : null;
        return Boolean(element) && active === element;
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocus, autoFocusKey]);
}

function MessageInputOverlay({
  showDictationOverlay,
  showRealtimeOverlay,
  voice,
  dictationVolume,
  dictationDuration,
  isDictating,
  isDictationProcessing,
  dictationStatus,
  dictationError,
  onCancelRecording,
  onAcceptRecording,
  onAcceptAndSendRecording,
  onRetryFailedRecording,
  onDiscardFailedRecording,
  onRealtimeVoiceStop,
}: {
  showDictationOverlay: boolean;
  showRealtimeOverlay: boolean;
  voice:
    | {
        isMuted: boolean;
        isVoiceSwitching: boolean;
        toggleMute: () => void;
      }
    | null
    | undefined;
  dictationVolume: number;
  dictationDuration: number;
  isDictating: boolean;
  isDictationProcessing: boolean;
  dictationStatus: React.ComponentProps<typeof DictationOverlay>["status"];
  dictationError: string | null;
  onCancelRecording: () => Promise<void>;
  onAcceptRecording: () => Promise<void>;
  onAcceptAndSendRecording: () => Promise<void>;
  onRetryFailedRecording: () => void;
  onDiscardFailedRecording: () => void;
  onRealtimeVoiceStop: () => void;
}) {
  if (showDictationOverlay) {
    return (
      <DictationOverlay
        volume={dictationVolume}
        duration={dictationDuration}
        isRecording={isDictating}
        isProcessing={isDictationProcessing}
        status={dictationStatus}
        errorText={dictationStatus === "failed" ? (dictationError ?? undefined) : undefined}
        onCancel={onCancelRecording}
        onAccept={onAcceptRecording}
        onAcceptAndSend={onAcceptAndSendRecording}
        onRetry={dictationStatus === "failed" ? onRetryFailedRecording : undefined}
        onDiscard={dictationStatus === "failed" ? onDiscardFailedRecording : undefined}
      />
    );
  }
  if (showRealtimeOverlay && voice) {
    return (
      <RealtimeVoiceOverlay
        isMuted={voice.isMuted}
        isSwitching={voice.isVoiceSwitching}
        onToggleMute={voice.toggleMute}
        onStop={onRealtimeVoiceStop}
      />
    );
  }
  return null;
}

function FocusHint({
  visible,
  focusInputKeys,
  label,
}: {
  visible: boolean;
  focusInputKeys: ShortcutChord | null | undefined;
  label: string;
}) {
  if (!visible || !focusInputKeys || !label.trim()) return null;
  return (
    <Text style={styles.focusHintText} pointerEvents="none">
      {label}
    </Text>
  );
}

function VoiceButtonTooltip({
  shouldShow,
  onVoicePress,
  isDictationStartEnabled,
  voiceButtonAccessibilityLabel,
  voiceButtonStyle,
  renderVoiceButtonIcon,
  voiceTooltipText,
  isRealtimeVoiceForCurrentAgent,
  voiceMuteToggleKeys,
  dictationToggleKeys,
}: {
  shouldShow: boolean;
  onVoicePress: () => void;
  isDictationStartEnabled: boolean;
  voiceButtonAccessibilityLabel: string;
  voiceButtonStyle: React.ComponentProps<typeof TooltipTrigger>["style"];
  renderVoiceButtonIcon: (input: { hovered?: boolean }) => React.ReactElement;
  voiceTooltipText: string;
  isRealtimeVoiceForCurrentAgent: boolean;
  voiceMuteToggleKeys: ShortcutChord | null | undefined;
  dictationToggleKeys: ShortcutChord | null | undefined;
}) {
  if (!shouldShow) return null;
  const shortcut = isRealtimeVoiceForCurrentAgent ? voiceMuteToggleKeys : dictationToggleKeys;
  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger
        onPress={onVoicePress}
        disabled={!isDictationStartEnabled}
        accessibilityRole="button"
        accessibilityLabel={voiceButtonAccessibilityLabel}
        style={voiceButtonStyle}
      >
        {renderVoiceButtonIcon}
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <VoiceTooltipBody voiceTooltipText={voiceTooltipText} shortcut={shortcut} />
      </TooltipContent>
    </Tooltip>
  );
}

function SendButtonTooltip({
  shouldShow,
  onPrimaryAction,
  isSendButtonDisabled,
  submitAccessibilityLabel,
  sendButtonCombinedStyle,
  isSubmitLoading,
  isStopButton,
  submitIcon,
  submitButtonTestID,
  buttonIconSize,
  sendKeys,
  sendTooltipLabel,
}: {
  shouldShow: boolean;
  onPrimaryAction: () => void;
  isSendButtonDisabled: boolean;
  submitAccessibilityLabel: string;
  sendButtonCombinedStyle: React.ComponentProps<typeof TooltipTrigger>["style"];
  isSubmitLoading: boolean;
  isStopButton: boolean;
  submitIcon: "arrow" | "return";
  submitButtonTestID: string | undefined;
  buttonIconSize: number;
  sendKeys: ShortcutChord | null | undefined;
  sendTooltipLabel: string;
}) {
  if (!shouldShow) return null;
  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger
        onPress={onPrimaryAction}
        disabled={isSendButtonDisabled}
        accessibilityLabel={submitAccessibilityLabel}
        accessibilityRole="button"
        testID={submitButtonTestID}
        style={sendButtonCombinedStyle}
      >
        <SendButtonContent
          isSubmitLoading={isSubmitLoading}
          isStopButton={isStopButton}
          submitIcon={submitIcon}
          buttonIconSize={buttonIconSize}
        />
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <SendTooltipBody label={sendTooltipLabel} sendKeys={sendKeys} />
      </TooltipContent>
    </Tooltip>
  );
}

interface DictationTranscriptContext {
  value: string;
  defaultSendBehavior: "interrupt" | "queue";
  isAgentRunning: boolean;
  onQueue: ((payload: MessagePayload) => void) | undefined;
  onSubmit: (payload: MessagePayload) => void;
  onChangeText: (text: string) => void;
  attachments: ComposerAttachment[];
  cwd: string;
  autoSend: boolean;
}

function applyDictationTranscript(text: string, ctx: DictationTranscriptContext): void {
  if (!text) return;
  const shouldPad = ctx.value.length > 0 && !/\s$/.test(ctx.value);
  const nextValue = `${ctx.value}${shouldPad ? " " : ""}${text}`;

  if (!ctx.autoSend) {
    ctx.onChangeText(nextValue);
    return;
  }

  if (ctx.defaultSendBehavior === "queue" && ctx.isAgentRunning && ctx.onQueue) {
    ctx.onQueue({ text: nextValue, attachments: ctx.attachments, cwd: ctx.cwd });
    ctx.onChangeText("");
    return;
  }

  ctx.onSubmit({
    text: nextValue,
    attachments: ctx.attachments,
    cwd: ctx.cwd,
    forceSend: ctx.isAgentRunning || undefined,
  });
}

interface ToggleRealtimeVoiceContext {
  voice:
    | {
        isVoiceSwitching: boolean;
        isVoiceModeForAgent: (serverId: string, agentId: string) => boolean;
        startVoice: (serverId: string, agentId: string) => Promise<unknown>;
      }
    | null
    | undefined;
  voiceServerId: string | undefined;
  voiceAgentId: string | undefined;
  isConnected: boolean;
  disabled: boolean;
  isAgentRunning: boolean;
  handleStopRealtimeVoice: () => Promise<unknown> | void;
  toast: { error: (msg: string) => void };
  interruptBeforeVoiceMessage: string;
}

function toggleRealtimeVoiceImpl(ctx: ToggleRealtimeVoiceContext): void {
  if (!ctx.voice || !ctx.voiceServerId || !ctx.voiceAgentId || !ctx.isConnected || ctx.disabled) {
    return;
  }
  if (ctx.voice.isVoiceSwitching) return;
  if (ctx.voice.isVoiceModeForAgent(ctx.voiceServerId, ctx.voiceAgentId)) {
    void ctx.handleStopRealtimeVoice();
    return;
  }
  if (ctx.isAgentRunning) {
    ctx.toast.error(ctx.interruptBeforeVoiceMessage);
    return;
  }
  void ctx.voice.startVoice(ctx.voiceServerId, ctx.voiceAgentId).catch((error) => {
    console.error("[MessageInput] Failed to start realtime voice", error);
    const message = extractErrorMessage(error);
    if (message && message.trim().length > 0) {
      ctx.toast.error(message);
    }
  });
}

interface StartDictationContext {
  dictationUnavailableMessage: string | null | undefined;
  canStartDictation: () => boolean;
  toast: { error: (msg: string) => void };
  startDictation: () => Promise<void>;
}

async function startDictationIfAvailableImpl(ctx: StartDictationContext): Promise<void> {
  if (ctx.dictationUnavailableMessage) {
    ctx.toast.error(ctx.dictationUnavailableMessage);
    return;
  }
  if (!ctx.canStartDictation()) {
    return;
  }
  await ctx.startDictation();
}

interface VoicePressContext {
  isRealtimeVoiceForCurrentAgent: boolean;
  voice: { toggleMute: () => void } | null | undefined;
  isDictating: boolean;
  cancelDictation: () => Promise<void> | void;
  startDictationIfAvailable: () => Promise<void>;
}

async function handleVoicePressImpl(ctx: VoicePressContext): Promise<void> {
  if (ctx.isRealtimeVoiceForCurrentAgent && ctx.voice) {
    ctx.voice.toggleMute();
    return;
  }
  if (ctx.isDictating) {
    await ctx.cancelDictation();
    return;
  }
  await ctx.startDictationIfAvailable();
}

interface SendMessageContext {
  value: string;
  attachments: ComposerAttachment[];
  hasExternalContent: boolean;
  allowEmptySubmit: boolean;
  cwd: string;
  isAgentRunning: boolean;
  onSubmit: (payload: MessagePayload) => void;
  onMinimizeHeight: () => void;
  preserveHeightOnSubmit: boolean;
}

function sendMessageImpl(ctx: SendMessageContext): void {
  const trimmed = ctx.value.trim();
  if (
    !trimmed &&
    ctx.attachments.length === 0 &&
    !ctx.hasExternalContent &&
    !ctx.allowEmptySubmit
  ) {
    return;
  }
  ctx.onSubmit({
    text: trimmed,
    attachments: ctx.attachments,
    cwd: ctx.cwd,
    forceSend: ctx.isAgentRunning || undefined,
  });
  // When the host preserves and locks the composer (e.g. new-workspace creation),
  // the text stays put — collapsing the height would clip it. Keep it grown.
  if (!ctx.preserveHeightOnSubmit) {
    ctx.onMinimizeHeight();
  }
}

interface QueueMessageContext {
  value: string;
  attachments: ComposerAttachment[];
  cwd: string;
  onQueue: ((payload: MessagePayload) => void) | undefined;
  onChangeText: (text: string) => void;
  onMinimizeHeight: () => void;
}

function queueMessageImpl(ctx: QueueMessageContext): void {
  if (!ctx.onQueue) return;
  const trimmed = ctx.value.trim();
  if (!trimmed && ctx.attachments.length === 0) return;
  ctx.onQueue({ text: trimmed, attachments: ctx.attachments, cwd: ctx.cwd });
  ctx.onChangeText("");
  ctx.onMinimizeHeight();
}

function computeIsRealtimeVoiceForAgent(
  voice: { isVoiceModeForAgent: (serverId: string, agentId: string) => boolean } | null | undefined,
  voiceServerId: string | undefined,
  voiceAgentId: string | undefined,
): boolean {
  if (!voice || !voiceServerId || !voiceAgentId) return false;
  return voice.isVoiceModeForAgent(voiceServerId, voiceAgentId);
}

function computeShouldShowDictationOverlay(
  isDictating: boolean,
  isDictationProcessing: boolean,
  dictationStatus: string,
): boolean {
  return isDictating || isDictationProcessing || dictationStatus === "failed";
}

function computeIsDictationStartEnabled(
  isReadyForDictation: boolean | undefined,
  isConnected: boolean,
  disabled: boolean,
): boolean {
  return (isReadyForDictation ?? isConnected) && !disabled;
}

function resolveMaxInputHeight(windowHeight: number): number {
  if (!Number.isFinite(windowHeight) || windowHeight <= 0) return DEFAULT_MAX_INPUT_HEIGHT;
  return Math.max(DEFAULT_MAX_INPUT_HEIGHT, Math.floor(windowHeight * MAX_INPUT_VIEWPORT_RATIO));
}

function computeTextInputHeightStyle(inputHeight: number, maxInputHeight: number) {
  if (isWeb) {
    return {
      height: inputHeight,
      minHeight: MIN_INPUT_HEIGHT,
      maxHeight: maxInputHeight,
    };
  }
  return {
    minHeight: MIN_INPUT_HEIGHT,
    maxHeight: maxInputHeight,
  };
}

function isTextAreaLike(v: unknown): v is TextAreaHandle {
  return typeof v === "object" && v !== null && "scrollHeight" in v;
}

function getWebTextAreaImpl(
  current: TextInput | (TextInput & { getNativeRef?: () => unknown }) | null,
): TextAreaHandle | null {
  if (!current) return null;
  const candidate = current as { getNativeRef?: () => unknown };
  if (typeof candidate.getNativeRef === "function") {
    const native = candidate.getNativeRef();
    if (isTextAreaLike(native)) return native;
  }
  if (isTextAreaLike(current)) return current;
  return null;
}

interface ResolvedMessageInputProps {
  value: string;
  onChangeText: (text: string) => void;
  onSubmit: (payload: MessagePayload) => void;
  hasExternalContent: boolean;
  allowEmptySubmit: boolean;
  submitButtonAccessibilityLabel: string | undefined;
  submitButtonTestID: string | undefined;
  submitIcon: "arrow" | "return";
  isSubmitDisabled: boolean;
  isSubmitLoading: boolean;
  preserveHeightOnSubmit: boolean;
  attachments: ComposerAttachment[];
  cwd: string;
  attachmentMenuItems: AttachmentMenuItem[];
  onAttachButtonRef: ((node: View | null) => void) | undefined;
  onAddImages: ((images: ImageAttachment[]) => void) | undefined;
  client: DaemonClient | null;
  isReadyForDictation: boolean | undefined;
  isDictationFeatureEnabled: boolean;
  placeholder: string | undefined;
  autoFocus: boolean;
  autoFocusKey: string | undefined;
  disabled: boolean;
  isPaneFocused: boolean;
  leftContent: React.ReactNode;
  beforeVoiceContent: React.ReactNode;
  rightContent: React.ReactNode;
  voiceServerId: string | undefined;
  voiceAgentId: string | undefined;
  isAgentRunning: boolean;
  defaultSendBehavior: "interrupt" | "queue";
  sendButtonVisibility: "always" | "whenContent";
  enterKeyBehavior: EnterKeyBehavior;
  onQueue: ((payload: MessagePayload) => void) | undefined;
  onSubmitLoadingPress: (() => void) | undefined;
  onKeyPressCallback: ((event: { key: string; preventDefault: () => void }) => boolean) | undefined;
  onSelectionChangeCallback: ((selection: { start: number; end: number }) => void) | undefined;
  onFocusChange: ((focused: boolean) => void) | undefined;
  onHeightChange: ((height: number) => void) | undefined;
  inputWrapperStyle: import("react-native").ViewStyle | undefined;
  attachmentSlot: React.ReactNode;
}

function resolveMessageInputProps(props: MessageInputProps): ResolvedMessageInputProps {
  return {
    value: props.value,
    onChangeText: props.onChangeText,
    onSubmit: props.onSubmit,
    hasExternalContent: props.hasExternalContent ?? false,
    allowEmptySubmit: props.allowEmptySubmit ?? false,
    submitButtonAccessibilityLabel: props.submitButtonAccessibilityLabel,
    submitButtonTestID: props.submitButtonTestID,
    submitIcon: props.submitIcon ?? "arrow",
    isSubmitDisabled: props.isSubmitDisabled ?? false,
    isSubmitLoading: props.isSubmitLoading ?? false,
    preserveHeightOnSubmit: props.preserveHeightOnSubmit ?? false,
    attachments: props.attachments,
    cwd: props.cwd,
    attachmentMenuItems: props.attachmentMenuItems,
    onAttachButtonRef: props.onAttachButtonRef,
    onAddImages: props.onAddImages,
    client: props.client,
    isReadyForDictation: props.isReadyForDictation,
    isDictationFeatureEnabled: props.isDictationFeatureEnabled !== false,
    placeholder: props.placeholder,
    autoFocus: props.autoFocus ?? false,
    autoFocusKey: props.autoFocusKey,
    disabled: props.disabled ?? false,
    isPaneFocused: props.isPaneFocused ?? true,
    leftContent: props.leftContent,
    beforeVoiceContent: props.beforeVoiceContent,
    rightContent: props.rightContent,
    voiceServerId: props.voiceServerId,
    voiceAgentId: props.voiceAgentId,
    isAgentRunning: props.isAgentRunning ?? false,
    defaultSendBehavior: props.defaultSendBehavior ?? "interrupt",
    sendButtonVisibility: props.sendButtonVisibility ?? "always",
    enterKeyBehavior: props.enterKeyBehavior ?? "send",
    onQueue: props.onQueue,
    onSubmitLoadingPress: props.onSubmitLoadingPress,
    onKeyPressCallback: props.onKeyPress,
    onSelectionChangeCallback: props.onSelectionChange,
    onFocusChange: props.onFocusChange,
    onHeightChange: props.onHeightChange,
    inputWrapperStyle: props.inputWrapperStyle,
    attachmentSlot: props.attachmentSlot,
  };
}

function extractErrorMessage(error: unknown): string | null {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return null;
}

export const MessageInput = forwardRef<MessageInputRef, MessageInputProps>(
  // eslint-disable-next-line complexity -- composer input owns dictation, voice mute, and send affordances
  function MessageInput(props, ref) {
    const {
      value,
      onChangeText,
      onSubmit,
      hasExternalContent,
      allowEmptySubmit,
      submitButtonAccessibilityLabel,
      submitButtonTestID,
      submitIcon,
      isSubmitDisabled,
      isSubmitLoading,
      preserveHeightOnSubmit,
      attachments,
      cwd,
      attachmentMenuItems,
      onAttachButtonRef,
      onAddImages,
      client,
      isReadyForDictation,
      isDictationFeatureEnabled,
      placeholder,
      autoFocus,
      autoFocusKey,
      disabled,
      isPaneFocused,
      leftContent,
      beforeVoiceContent,
      rightContent,
      voiceServerId,
      voiceAgentId,
      isAgentRunning,
      defaultSendBehavior,
      sendButtonVisibility,
      enterKeyBehavior,
      onQueue,
      onSubmitLoadingPress,
      onKeyPressCallback,
      onSelectionChangeCallback,
      onFocusChange,
      onHeightChange,
      inputWrapperStyle,
      attachmentSlot,
    } = resolveMessageInputProps(props);
    const { t } = useTranslation();
    const isCompact = useIsCompactFormFactor();
    const { height: windowHeight } = useWindowDimensions();
    const maxInputHeight = resolveMaxInputHeight(windowHeight);
    const buttonIconSize = isWeb ? ICON_SIZE.md : ICON_SIZE.lg;
    const toast = useToast();
    const voice = useVoiceOptional();
    const voiceMuteToggleKeys = useShortcutKeys("voice-mute-toggle");
    const dictationToggleKeys = useShortcutKeys("dictation-toggle");
    const focusInputKeys = useShortcutKeys("focus-message-input");
    const [inputHeight, setInputHeight] = useState(MIN_INPUT_HEIGHT);
    const [isInputFocused, setIsInputFocused] = useState(false);
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
      runKeyboardAction: (action) =>
        runMessageInputKeyboardAction(action, {
          focusInput: () => textInputRef.current?.focus(),
          isDictationRecording: isDictationActive,
          markTranscriptForSend: () => {
            sendAfterTranscriptRef.current = true;
          },
          confirmDictation,
          cancelDictation,
          startDictation: startDictationIfAvailable,
          toggleRealtimeVoice: handleToggleRealtimeVoiceShortcut,
          isRealtimeVoiceActive: isRealtimeVoiceForCurrentAgent,
          toggleRealtimeVoiceMute: () => voice?.toggleMute(),
        }),
      getNativeElement: () => (isWeb ? getTextInputNativeElement(textInputRef.current) : null),
    }));
    const inputHeightRef = useRef(MIN_INPUT_HEIGHT);
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

    useAutoFocusOnWebEffect(textInputRef, autoFocus, autoFocusKey);

    const handleDictationTranscript = useCallback(
      (text: string, _meta: { requestId: string }) => {
        const autoSend = sendAfterTranscriptRef.current;
        sendAfterTranscriptRef.current = false;
        applyDictationTranscript(text, {
          value: valueRef.current,
          defaultSendBehavior,
          isAgentRunning,
          onQueue,
          onSubmit,
          onChangeText,
          attachments,
          cwd,
          autoSend,
        });
      },
      [onChangeText, onSubmit, onQueue, attachments, cwd, isAgentRunning, defaultSendBehavior],
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

    const canStartDictation = useCallback(
      () =>
        computeCanStartDictation({
          client,
          isReadyForDictation,
          disabled,
          dictationUnavailableMessage,
        }),
      [client, disabled, dictationUnavailableMessage, isReadyForDictation],
    );

    const canConfirmDictation = useCallback(() => client?.isConnected ?? false, [client]);
    const isConnected = client?.isConnected ?? false;
    const isDictationStartEnabled = computeIsDictationStartEnabled(
      isReadyForDictation,
      isConnected,
      disabled,
    );

    const {
      isRecording: isDictating,
      isRecordingActive: isDictationActive,
      isProcessing: isDictationProcessing,
      partialTranscript: _dictationPartialTranscript,
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
      enableDuration: true,
    });

    const isRealtimeVoiceForCurrentAgent = computeIsRealtimeVoiceForAgent(
      voice,
      voiceServerId,
      voiceAgentId,
    );
    const showDictationOverlay = computeShouldShowDictationOverlay(
      isDictating,
      isDictationProcessing,
      dictationStatus,
    );
    const showRealtimeOverlay = isRealtimeVoiceForCurrentAgent;
    const showOverlay = showDictationOverlay || showRealtimeOverlay;
    const surfacePresentation = resolveComposerSurfacePresentation(showOverlay);

    useEffect(() => {
      if (isDictating || isDictationProcessing) {
        return;
      }
      sendAfterTranscriptRef.current = false;
    }, [dictationStatus, isDictating, isDictationProcessing]);

    const startDictationIfAvailable = useCallback(
      () =>
        startDictationIfAvailableImpl({
          dictationUnavailableMessage,
          canStartDictation,
          toast,
          startDictation,
        }),
      [canStartDictation, dictationUnavailableMessage, startDictation, toast],
    );

    const handleVoicePress = useCallback(
      () =>
        handleVoicePressImpl({
          isRealtimeVoiceForCurrentAgent,
          voice,
          isDictating,
          cancelDictation,
          startDictationIfAvailable,
        }),
      [
        cancelDictation,
        isDictating,
        isRealtimeVoiceForCurrentAgent,
        startDictationIfAvailable,
        voice,
      ],
    );

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
      try {
        await stopRealtimeVoice({
          voice,
          isRealtimeVoiceForCurrentAgent,
          isAgentRunning,
          client,
          voiceAgentId,
        });
      } catch (error) {
        console.error("[MessageInput] Failed to stop realtime voice", error);
        const message = extractErrorMessage(error);
        if (message && message.trim().length > 0) {
          toast.error(message);
        }
      }
    }, [client, isAgentRunning, isRealtimeVoiceForCurrentAgent, toast, voice, voiceAgentId]);

    const handleToggleRealtimeVoiceShortcut = useCallback(() => {
      toggleRealtimeVoiceImpl({
        voice,
        voiceServerId,
        voiceAgentId,
        isConnected,
        disabled,
        isAgentRunning,
        handleStopRealtimeVoice,
        toast,
        interruptBeforeVoiceMessage: t("composer.voice.interruptBeforeVoice"),
      });
    }, [
      disabled,
      handleStopRealtimeVoice,
      isAgentRunning,
      isConnected,
      t,
      toast,
      voice,
      voiceAgentId,
      voiceServerId,
    ]);

    const minimizeInputHeight = useCallback(() => {
      inputHeightRef.current = MIN_INPUT_HEIGHT;
      setInputHeight(MIN_INPUT_HEIGHT);
      onHeightChange?.(MIN_INPUT_HEIGHT);
    }, [onHeightChange]);

    const handleSendMessage = useCallback(
      () =>
        sendMessageImpl({
          value: valueRef.current,
          attachments,
          hasExternalContent,
          allowEmptySubmit,
          cwd,
          isAgentRunning,
          onSubmit,
          onMinimizeHeight: minimizeInputHeight,
          preserveHeightOnSubmit,
        }),
      [
        allowEmptySubmit,
        attachments,
        cwd,
        onSubmit,
        isAgentRunning,
        hasExternalContent,
        minimizeInputHeight,
        preserveHeightOnSubmit,
      ],
    );

    const handleQueueMessage = useCallback(
      () =>
        queueMessageImpl({
          value: valueRef.current,
          attachments,
          cwd,
          onQueue,
          onChangeText,
          onMinimizeHeight: minimizeInputHeight,
        }),
      [attachments, cwd, onQueue, onChangeText, minimizeInputHeight],
    );

    const handleDefaultSendAction = useCallback(() => {
      runDefaultSendAction({
        defaultSendBehavior,
        isAgentRunning,
        onQueue,
        handleSendMessage,
        handleQueueMessage,
      });
    }, [defaultSendBehavior, isAgentRunning, onQueue, handleQueueMessage, handleSendMessage]);

    const handleAlternateSendAction = useCallback(() => {
      runAlternateSendAction({
        defaultSendBehavior,
        isAgentRunning,
        onQueue,
        handleSendMessage,
        handleQueueMessage,
      });
    }, [defaultSendBehavior, isAgentRunning, handleSendMessage, handleQueueMessage, onQueue]);

    const getWebTextArea = useCallback(
      (): TextAreaHandle | null => getWebTextAreaImpl(textInputRef.current),
      [],
    );

    const webTextareaRef = useRef<HTMLElement | null>(null);

    useLayoutEffect(() => {
      if (isWeb) {
        webTextareaRef.current = getWebTextArea() as HTMLElement | null;
      }
    }, [getWebTextArea]);

    usePasteImagesEffect({
      getWebTextArea,
      isConnected,
      disabled,
      isDictating,
      isRealtimeVoiceForCurrentAgent,
      onAddImages,
    });

    const setBoundedInputHeight = useCallback(
      (nextHeight: number) => {
        const bounded = Math.max(MIN_INPUT_HEIGHT, Math.min(maxInputHeight, nextHeight));
        if (Math.abs(inputHeightRef.current - bounded) < 1) return;
        inputHeightRef.current = bounded;
        setInputHeight(bounded);
        onHeightChange?.(bounded);
      },
      [maxInputHeight, onHeightChange],
    );

    useEffect(() => {
      setBoundedInputHeight(inputHeightRef.current);
    }, [setBoundedInputHeight]);

    useComposerHeightMirror({
      value,
      textareaRef: webTextareaRef,
      minHeight: MIN_INPUT_HEIGHT,
      maxHeight: maxInputHeight,
      onHeight: setBoundedInputHeight,
    });

    const handleContentSizeChange = useCallback(
      (event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>) => {
        if (isWeb) return;
        setBoundedInputHeight(event.nativeEvent.contentSize.height);
      },
      [setBoundedInputHeight],
    );

    const handleSelectionChange = useCallback(
      (event: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
        const start = event.nativeEvent.selection?.start ?? 0;
        const end = event.nativeEvent.selection?.end ?? start;
        onSelectionChangeCallback?.({ start, end });
      },
      [onSelectionChangeCallback],
    );

    const shouldSubmitOnEnter = enterKeyBehavior === "send";
    const shouldSubmitOnModEnter = enterKeyBehavior === "newline";
    const textInputReturnConfiguration = resolveTextInputReturnConfiguration(shouldSubmitOnEnter);

    const { canSubmitContent, shouldShowSendButton } = computeSendableContent({
      value,
      attachments,
      hasExternalContent,
      allowEmptySubmit,
      isSubmitLoading,
      sendButtonVisibility,
    });
    const effectiveIsSubmitDisabled = isSubmitDisabled || !canSubmitContent;
    const primaryButtonState = resolveComposerPrimaryButtonState({
      disabled,
      isSubmitDisabled: effectiveIsSubmitDisabled,
      isSubmitLoading,
      canSubmitContent,
      isAgentRunning,
      canStop: typeof onSubmitLoadingPress === "function",
      canQueue: typeof onQueue === "function",
    });
    const isStopButton = primaryButtonState.mode === "stop";
    const buttonActionQueues = primaryButtonState.mode === "queue";
    const shouldShowPrimaryButton = shouldShowSendButton || isStopButton;
    const handlePrimaryButtonAction = useCallback(() => {
      runComposerPrimaryButtonAction(primaryButtonState.mode, {
        stop: () => onSubmitLoadingPress?.(),
        queue: handleQueueMessage,
        send: handleDefaultSendAction,
      });
    }, [
      handleDefaultSendAction,
      handleQueueMessage,
      onSubmitLoadingPress,
      primaryButtonState.mode,
    ]);

    const handleWebKeyDown = useCallback(
      (event: KeyboardEvent) => {
        handleComposerKeyPress(
          {
            key: event.key,
            metaKey: event.metaKey,
            ctrlKey: event.ctrlKey,
            shiftKey: event.shiftKey,
            isComposing: event.isComposing,
            keyCode: event.keyCode,
            preventDefault: () => event.preventDefault(),
          },
          {
            onKeyPressCallback,
            submitOnEnter: shouldSubmitOnEnter,
            submitOnModEnter: shouldSubmitOnModEnter,
            useAlternateSendAction: isAgentRunning && Boolean(onQueue),
            isSubmitBlocked: effectiveIsSubmitDisabled || isSubmitLoading || disabled,
            handleAlternateSendAction,
            handleDefaultSendAction,
          },
        );
      },
      [
        disabled,
        effectiveIsSubmitDisabled,
        handleAlternateSendAction,
        handleDefaultSendAction,
        isAgentRunning,
        isSubmitLoading,
        onKeyPressCallback,
        onQueue,
        shouldSubmitOnEnter,
        shouldSubmitOnModEnter,
      ],
    );
    useWebComposerKeyDown(getWebTextArea, handleWebKeyDown, autoFocusKey);

    const handleMobileWebBeforeInput = useCallback(
      (event: InputEvent) => {
        handleComposerBeforeInput(
          {
            inputType: event.inputType,
            isComposing: event.isComposing,
            preventDefault: () => event.preventDefault(),
          },
          {
            submitOnEnter: shouldSubmitOnEnter,
            isSubmitBlocked: effectiveIsSubmitDisabled || isSubmitLoading || disabled,
            handleDefaultSendAction,
          },
        );
      },
      [
        disabled,
        effectiveIsSubmitDisabled,
        handleDefaultSendAction,
        isSubmitLoading,
        shouldSubmitOnEnter,
      ],
    );
    useMobileWebComposerBeforeInput(
      getWebTextArea,
      isCompact && shouldSubmitOnEnter,
      handleMobileWebBeforeInput,
      autoFocusKey,
    );

    const isNativeSubmitBlocked = effectiveIsSubmitDisabled || isSubmitLoading || disabled;
    const handleNativeSubmitEditing = useCallback(() => {
      if (
        shouldSubmitComposerFromNativeReturn({
          enterKeyBehavior,
          isSubmitBlocked: isNativeSubmitBlocked,
        })
      ) {
        handleDefaultSendAction();
      }
    }, [enterKeyBehavior, handleDefaultSendAction, isNativeSubmitBlocked]);

    useIosHardwareKeyboardSubmit({
      isEnabled:
        enterKeyBehavior === "send" &&
        isInputFocused &&
        !effectiveIsSubmitDisabled &&
        !isSubmitLoading &&
        !disabled,
      onSubmit: handleDefaultSendAction,
    });
    const submitAccessibilityLabel = resolveSubmitAccessibilityLabel({
      submitButtonAccessibilityLabel,
      canPressLoadingButton: isStopButton,
      defaultActionQueues: buttonActionQueues,
      isAgentRunning,
      t,
    });

    const voiceButtonAccessibilityLabel = resolveVoiceAccessibilityLabel({
      isRealtimeVoiceForCurrentAgent,
      isMuted: Boolean(voice?.isMuted),
      isDictating,
      t,
    });

    const voiceTooltipText = resolveVoiceTooltipText({
      isRealtimeVoiceForCurrentAgent,
      isMuted: Boolean(voice?.isMuted),
      t,
    });

    const sendTooltipLabel = isStopButton
      ? t("composer.cancel.interrupt")
      : resolveSendTooltipLabel({
          submitButtonAccessibilityLabel,
          defaultActionQueues: buttonActionQueues,
          t,
        });

    const handleInputChange = useCallback(
      (nextValue: string) => {
        valueRef.current = nextValue;
        onChangeText(nextValue);
      },
      [onChangeText],
    );

    const handleInputFocus = useCallback(() => {
      isInputFocusedRef.current = true;
      setIsInputFocused(true);
      onFocusChange?.(true);
    }, [onFocusChange]);

    const handleInputBlur = useCallback(() => {
      isInputFocusedRef.current = false;
      setIsInputFocused(false);
      onFocusChange?.(false);
    }, [onFocusChange]);

    const attachButtonStyle = useCallback(
      ({ hovered }: { hovered?: boolean }) => [
        styles.attachButton,
        Boolean(hovered) && styles.iconButtonHovered,
        (!isConnected || disabled) && styles.buttonDisabled,
      ],
      [isConnected, disabled],
    );

    const voiceButtonStyle = useCallback(
      ({ hovered }: { hovered?: boolean }) => [
        styles.voiceButton,
        Boolean(hovered) && !isDictating && styles.iconButtonHovered,
        !isDictationStartEnabled && styles.buttonDisabled,
        isDictating && styles.voiceButtonRecording,
      ],
      [isDictating, isDictationStartEnabled],
    );

    const handleRealtimeVoiceStop = useCallback(() => {
      void handleStopRealtimeVoice();
    }, [handleStopRealtimeVoice]);

    const inputWrapperCombinedStyle = useMemo(
      () => [
        styles.inputWrapper,
        inputWrapperStyle,
        { opacity: surfacePresentation.input.opacity },
      ],
      [inputWrapperStyle, surfacePresentation.input.opacity],
    );
    const textInputStyle = useMemo(
      () => [styles.textInput, computeTextInputHeightStyle(inputHeight, maxInputHeight)],
      [inputHeight, maxInputHeight],
    );
    const sendButtonCombinedStyle = useMemo(
      () => [styles.sendButton, primaryButtonState.disabled && styles.buttonDisabled],
      [primaryButtonState.disabled],
    );
    const overlayContainerStyle = useMemo(
      () => [styles.overlayContainer, { opacity: surfacePresentation.overlay.opacity }],
      [surfacePresentation.overlay.opacity],
    );

    const renderAttachButtonIcon = useCallback(
      ({ hovered }: { hovered?: boolean }) => (
        <AttachButtonIcon
          hovered={Boolean(hovered)}
          onAttachButtonRef={onAttachButtonRef}
          buttonIconSize={buttonIconSize}
        />
      ),
      [onAttachButtonRef, buttonIconSize],
    );

    const renderVoiceButtonIcon = useCallback(
      ({ hovered }: { hovered?: boolean }) => (
        <VoiceButtonIcon
          hovered={Boolean(hovered)}
          isDictating={isDictating}
          isMutedRealtime={Boolean(isRealtimeVoiceForCurrentAgent && voice?.isMuted)}
          buttonIconSize={buttonIconSize}
        />
      ),
      [isDictating, isRealtimeVoiceForCurrentAgent, voice?.isMuted, buttonIconSize],
    );

    return (
      <View ref={rootRef} style={styles.container} testID="message-input-root">
        {/* Regular input */}
        <View
          ref={inputWrapperRef}
          style={inputWrapperCombinedStyle}
          pointerEvents={surfacePresentation.input.pointerEvents}
        >
          {attachmentSlot}
          {/* Text input */}
          <View style={styles.textInputScrollWrapper}>
            <ThemedTextInput
              ref={textInputRef}
              dataSet={COMPOSER_INPUT_DATASET}
              value={value}
              onChangeText={handleInputChange}
              placeholder={placeholder ?? t("composer.placeholders.fallback")}
              uniProps={textInputPlaceholderColorMapping}
              accessibilityLabel={t("composer.input.accessibilityLabel")}
              onFocus={handleInputFocus}
              onBlur={handleInputBlur}
              style={textInputStyle}
              multiline
              scrollEnabled={isWeb ? inputHeight >= maxInputHeight : true}
              onContentSizeChange={handleContentSizeChange}
              editable={!isDictating && !isRealtimeVoiceForCurrentAgent && !disabled}
              submitBehavior={textInputReturnConfiguration.submitBehavior}
              onSubmitEditing={!isWeb ? handleNativeSubmitEditing : undefined}
              returnKeyType={textInputReturnConfiguration.returnKeyType}
              onSelectionChange={handleSelectionChange}
              autoFocus={isWeb && autoFocus}
            />
            <FocusHint
              visible={isWeb && isPaneFocused && !isInputFocused && !value}
              focusInputKeys={focusInputKeys}
              label={t("composer.input.focusHint", {
                shortcut: focusInputKeys ? formatShortcut(focusInputKeys[0], getShortcutOs()) : "",
              })}
            />
          </View>

          {/* Button row */}
          <View style={styles.buttonRow}>
            {/* Toolbar left: attachment button + agent controls */}
            <View style={styles.leftButtonGroup}>
              <AttachmentDropdown
                isConnected={isConnected}
                disabled={disabled}
                attachButtonStyle={attachButtonStyle}
                renderAttachButtonIcon={renderAttachButtonIcon}
                attachmentMenuItems={attachmentMenuItems}
                addAttachmentLabel={t("composer.input.addAttachment")}
              />
              {leftContent}
            </View>

            {/* Right: voice button, contextual button (realtime/send/cancel) */}
            <View style={styles.rightButtonGroup}>
              {beforeVoiceContent}
              <VoiceButtonTooltip
                shouldShow={isRealtimeVoiceForCurrentAgent || isDictationFeatureEnabled}
                onVoicePress={handleVoicePress}
                isDictationStartEnabled={isDictationStartEnabled}
                voiceButtonAccessibilityLabel={voiceButtonAccessibilityLabel}
                voiceButtonStyle={voiceButtonStyle}
                renderVoiceButtonIcon={renderVoiceButtonIcon}
                voiceTooltipText={voiceTooltipText}
                isRealtimeVoiceForCurrentAgent={isRealtimeVoiceForCurrentAgent}
                voiceMuteToggleKeys={voiceMuteToggleKeys}
                dictationToggleKeys={dictationToggleKeys}
              />
              {rightContent}
              <SendButtonTooltip
                shouldShow={shouldShowPrimaryButton}
                onPrimaryAction={handlePrimaryButtonAction}
                isSendButtonDisabled={primaryButtonState.disabled}
                submitAccessibilityLabel={submitAccessibilityLabel}
                sendButtonCombinedStyle={sendButtonCombinedStyle}
                isSubmitLoading={isSubmitLoading}
                isStopButton={isStopButton}
                submitIcon={submitIcon}
                submitButtonTestID={submitButtonTestID}
                buttonIconSize={buttonIconSize}
                sendKeys={enterKeyBehavior === "send" ? DEFAULT_SEND_KEYS : MOD_SEND_KEYS}
                sendTooltipLabel={sendTooltipLabel}
              />
            </View>
          </View>
        </View>

        <View
          style={overlayContainerStyle}
          pointerEvents={surfacePresentation.overlay.pointerEvents}
        >
          <MessageInputOverlay
            showDictationOverlay={showDictationOverlay}
            showRealtimeOverlay={showRealtimeOverlay}
            voice={voice}
            dictationVolume={dictationVolume}
            dictationDuration={dictationDuration}
            isDictating={isDictating}
            isDictationProcessing={isDictationProcessing}
            dictationStatus={dictationStatus}
            dictationError={dictationError}
            onCancelRecording={handleCancelRecording}
            onAcceptRecording={handleAcceptRecording}
            onAcceptAndSendRecording={handleAcceptAndSendRecording}
            onRetryFailedRecording={handleRetryFailedRecording}
            onDiscardFailedRecording={handleDiscardFailedRecording}
            onRealtimeVoiceStop={handleRealtimeVoiceStop}
          />
        </View>
      </View>
    );
  },
);

const styles = StyleSheet.create((theme: Theme) => ({
  container: {
    position: "relative",
  },
  inputWrapper: {
    flexDirection: "column",
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
    paddingVertical: {
      xs: theme.spacing[2],
      md: theme.spacing[2],
    },
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[3],
    },
  },
  textInputScrollWrapper: {
    position: "relative",
  },
  focusHintText: {
    position: "absolute",
    top: 0,
    right: 0,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    opacity: 0.5,
  },
  textInput: {
    width: "100%",
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    lineHeight: theme.fontSize.base * 1.4,
    ...(isWeb
      ? ({
          outlineStyle: "none",
          outlineWidth: 0,
          outlineColor: "transparent",
          scrollbarGutter: "stable",
        } as object)
      : {}),
  },
  buttonRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
  },
  leftButtonGroup: {
    minWidth: 0,
    flexShrink: 1,
    flexGrow: 1,
    flexDirection: "row",
    alignItems: "flex-end",
    gap: theme.spacing[0],
  },
  rightButtonGroup: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  attachButton: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  attachButtonAnchor: {
    width: 28,
    height: 28,
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
  sendButton: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accent,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: theme.spacing[1],
  },
  stopIcon: {
    width: 9,
    height: 9,
    borderRadius: 2,
    backgroundColor: theme.colors.accentForeground,
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
  buttonDisabled: {
    opacity: 0.5,
  },
  attachmentSheetList: {
    gap: theme.spacing[1],
  },
  attachmentSheetItem: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.xl,
  },
  attachmentSheetItemPressed: {
    backgroundColor: theme.colors.surface2,
  },
  attachmentSheetItemIcon: {
    width: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  attachmentSheetItemText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
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
})) as unknown as Record<string, object>;

// Prefer withUnistyles mappings over uniProps — lucide forwards unknown props to
// SVG <path> on web, which logs React DOM warnings for `uniProps`.
const ThemedPlusForeground = withUnistyles(Plus, (theme: Theme) => ({
  color: theme.colors.foreground,
}));
const ThemedPlusMuted = withUnistyles(Plus, (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
}));
const ThemedMicForeground = withUnistyles(Mic, (theme: Theme) => ({
  color: theme.colors.foreground,
}));
const ThemedMicMuted = withUnistyles(Mic, (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
}));
const ThemedMicOffForeground = withUnistyles(MicOff, (theme: Theme) => ({
  color: theme.colors.foreground,
}));
const ThemedMicOffMuted = withUnistyles(MicOff, (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
}));
const ThemedArrowUpAccent = withUnistyles(ArrowUp, (theme: Theme) => ({
  color: theme.colors.accentForeground,
}));
const ThemedCornerDownLeftAccent = withUnistyles(CornerDownLeft, (theme: Theme) => ({
  color: theme.colors.accentForeground,
}));
const ThemedActivityIndicatorAccent = withUnistyles(ActivityIndicator, (theme: Theme) => ({
  color: theme.colors.accentForeground,
}));
const ThemedTextInput = withUnistyles(TextInput);

const textInputPlaceholderColorMapping = (theme: Theme) => ({
  placeholderTextColor: theme.colors.surface4,
});
