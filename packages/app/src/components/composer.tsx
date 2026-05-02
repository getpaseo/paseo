import {
  View,
  Pressable,
  Text,
  ActivityIndicator,
  Image,
  type PressableStateCallbackType,
} from "react-native";
import { useState, useEffect, useRef, useCallback, useMemo, memo, type ReactElement } from "react";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useShallow } from "zustand/shallow";
import {
  ArrowUp,
  Square,
  Pencil,
  AudioLines,
  CircleDot,
  GitPullRequest,
  Github,
  Paperclip,
} from "lucide-react-native";
import Animated from "react-native-reanimated";
import { useQuery } from "@tanstack/react-query";
import { FOOTER_HEIGHT, MAX_CONTENT_WIDTH } from "@/constants/layout";
import { generateMessageId, type StreamItem } from "@/types/stream";
import {
  AgentStatusBar,
  DraftAgentStatusBar,
  type DraftAgentStatusBarProps,
} from "./agent-status-bar";
import { ContextWindowMeter } from "./context-window-meter";
import { useImageAttachmentPicker } from "@/hooks/use-image-attachment-picker";
import type { PickedImageAttachmentInput } from "@/hooks/image-attachment-picker";
import { useSessionStore } from "@/stores/session-store";
import {
  MessageInput,
  type MessagePayload,
  type ImageAttachment,
  type MessageInputRef,
  type AttachmentMenuItem,
} from "./message-input";
import { ICON_SIZE, type Theme } from "@/styles/theme";
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
import { resolveStatusControlMode } from "@/components/composer.status-controls";
import { useKeyboardShiftStyle } from "@/hooks/use-keyboard-shift-style";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import type { KeyboardActionDefinition } from "@/keyboard/keyboard-action-dispatcher";
import type { MessageInputKeyboardActionKind } from "@/keyboard/actions";
import { submitAgentInput } from "@/components/agent-input-submit";
import { useAppSettings } from "@/hooks/use-settings";
import { isWeb, isNative } from "@/constants/platform";
import type { GitHubSearchItem } from "@server/shared/messages";
import type {
  AttachmentMetadata,
  ComposerAttachment,
  UserComposerAttachment,
  WorkspaceComposerAttachment,
} from "@/attachments/types";
import { composerWorkspaceAttachment } from "@/attachments/composer-workspace-attachments";
import { useAttachmentPreviewUrl } from "@/attachments/use-attachment-preview-url";
import { Combobox, ComboboxItem, type ComboboxOption } from "@/components/ui/combobox";
import { splitComposerAttachmentsForSubmit } from "@/components/composer-attachments";
import { AttachmentPill } from "@/components/attachment-pill";
import { AttachmentLightbox } from "@/components/attachment-lightbox";
import { openExternalUrl } from "@/utils/open-external-url";
import { useIsDictationReady } from "@/hooks/use-is-dictation-ready";

interface QueuedMessage {
  id: string;
  text: string;
  attachments: ComposerAttachment[];
}

type AttachmentListUpdater =
  | UserComposerAttachment[]
  | ((prev: UserComposerAttachment[]) => UserComposerAttachment[]);

function noop() {}

function resolveComposerButtonIconSize(): number {
  return isWeb ? ICON_SIZE.md : ICON_SIZE.lg;
}

function resolveIsComposerLocked(
  submitBehavior: "clear" | "preserve-and-lock",
  isSubmitLoading: boolean,
): boolean {
  return submitBehavior === "preserve-and-lock" && isSubmitLoading;
}

function resolveIsVoiceModeForAgent(
  voice: ReturnType<typeof useVoiceOptional>,
  serverId: string,
  agentId: string,
): boolean {
  return voice?.isVoiceModeForAgent(serverId, agentId) ?? false;
}

function resolveKeyboardPriority(isMessageInputFocused: boolean): number {
  return isMessageInputFocused ? 200 : 100;
}

function resolveIsDesktopWebBreakpoint(isMobile: boolean): boolean {
  return isWeb && !isMobile;
}

function resolveMessagePlaceholder(isDesktopWebBreakpoint: boolean): string {
  return isDesktopWebBreakpoint ? DESKTOP_MESSAGE_PLACEHOLDER : MOBILE_MESSAGE_PLACEHOLDER;
}

async function pickAndPersistImages(
  pickImages: () => Promise<PickedImageAttachmentInput[] | null>,
): Promise<ImageAttachment[]> {
  const result = await pickImages();
  if (!result?.length) return [];
  return await Promise.all(
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
}

function removeAttachmentAtIndex<T extends ComposerAttachment>(prev: T[], index: number): T[] {
  const removed = prev[index];
  if (removed?.kind === "image") {
    void deleteAttachments([removed.metadata]);
  }
  return prev.filter((_, i) => i !== index);
}

function buildCancelButtonStyle(isConnected: boolean, isCancellingAgent: boolean): object[] {
  const disabled =
    !isConnected || isCancellingAgent ? (styles.buttonDisabled as object) : undefined;
  return [styles.cancelButton as object, disabled].filter((value): value is object =>
    Boolean(value),
  );
}

function buildRealtimeVoiceButtonStyle(
  hovered: boolean | undefined,
  voiceButtonDisabled: boolean,
): object[] {
  const hoveredStyle = hovered ? (styles.iconButtonHovered as object) : undefined;
  const disabledStyle = voiceButtonDisabled ? (styles.buttonDisabled as object) : undefined;
  return [styles.realtimeVoiceButton as object, hoveredStyle, disabledStyle].filter(
    (value): value is object => Boolean(value),
  );
}

function buildAgentStateSelector(serverId: string, agentId: string) {
  return (state: ReturnType<typeof useSessionStore.getState>) => {
    const agent = state.sessions[serverId]?.agents?.get(agentId) ?? null;
    return {
      status: agent?.status ?? null,
      contextWindowMaxTokens: agent?.lastUsage?.contextWindowMaxTokens ?? null,
      contextWindowUsedTokens: agent?.lastUsage?.contextWindowUsedTokens ?? null,
    };
  };
}

interface BuildGithubSearchQueryOptionsArgs {
  serverId: string;
  cwd: string;
  githubSearchQueryTrimmed: string;
  isGithubPickerOpen: boolean;
  isConnected: boolean;
  client: ReturnType<typeof useHostRuntimeClient>;
}

function buildGithubSearchQueryOptions(args: BuildGithubSearchQueryOptionsArgs) {
  const { serverId, cwd, githubSearchQueryTrimmed, isGithubPickerOpen, isConnected, client } = args;
  const hasClient = Boolean(client);
  const cwdIsSet = cwd.trim().length > 0;
  const enabled = isGithubPickerOpen && isConnected && hasClient && cwdIsSet;
  return {
    queryKey: ["composer-github-search", serverId, cwd, githubSearchQueryTrimmed],
    queryFn: async () => {
      if (!client) throw new Error("Host is not connected");
      return client.searchGitHub({ cwd, query: githubSearchQueryTrimmed, limit: 20 });
    },
    enabled,
    staleTime: 30_000,
  };
}

function renderContextWindowMeterSlot(
  contextWindowMaxTokens: number | null,
  contextWindowUsedTokens: number | null,
): ReactElement {
  const meter =
    contextWindowMaxTokens !== null && contextWindowUsedTokens !== null ? (
      <ContextWindowMeter maxTokens={contextWindowMaxTokens} usedTokens={contextWindowUsedTokens} />
    ) : null;
  return <View style={styles.contextWindowMeterSlot}>{meter}</View>;
}

interface RenderLeftContentArgs {
  statusControls: DraftAgentStatusBarProps | undefined;
  agentId: string;
  serverId: string;
  focusInput: () => void;
}

function renderLeftContent(args: RenderLeftContentArgs): ReactElement {
  const { statusControls, agentId, serverId, focusInput } = args;
  if (resolveStatusControlMode(statusControls) === "draft" && statusControls) {
    return <DraftAgentStatusBar {...statusControls} />;
  }
  return <AgentStatusBar agentId={agentId} serverId={serverId} onDropdownClose={focusInput} />;
}

function findGithubItemByOption(
  items: readonly GitHubSearchItem[],
  optionId: string,
): GitHubSearchItem | undefined {
  return items.find((candidate) => `${candidate.kind}:${candidate.number}` === optionId);
}

function isAttachmentSelectedForGithubItem(
  current: readonly ComposerAttachment[],
  item: GitHubSearchItem,
): boolean {
  return composerWorkspaceAttachment
    .userAttachmentsOnly(current)
    .some(
      (attachment) =>
        attachment.kind !== "image" &&
        attachment.item.kind === item.kind &&
        attachment.item.number === item.number,
    );
}

function buildGithubAttachment(item: GitHubSearchItem): UserComposerAttachment {
  return item.kind === "pr" ? { kind: "github_pr", item } : { kind: "github_issue", item };
}

function toggleGithubAttachment(
  current: UserComposerAttachment[],
  item: GitHubSearchItem,
): UserComposerAttachment[] {
  const matches = (attachment: UserComposerAttachment) =>
    attachment.kind !== "image" &&
    attachment.item.kind === item.kind &&
    attachment.item.number === item.number;
  if (current.some(matches)) {
    return current.filter((attachment) => !matches(attachment));
  }
  return [...current, buildGithubAttachment(item)];
}

interface RenderAttachmentPreviewListArgs {
  selectedAttachments: ComposerAttachment[];
  isComposerLocked: boolean;
  handleOpenAttachment: (attachment: ComposerAttachment) => void;
  handleRemoveAttachment: (index: number) => void;
}

function renderAttachmentPreviewList(args: RenderAttachmentPreviewListArgs): ReactElement | null {
  const { selectedAttachments, isComposerLocked, handleOpenAttachment, handleRemoveAttachment } =
    args;
  if (selectedAttachments.length === 0) return null;
  return (
    <View style={styles.attachmentPreviewContainer} testID="composer-attachment-pills">
      {selectedAttachments.map((attachment, index) =>
        renderComposerAttachmentPill({
          attachment,
          index,
          disabled: isComposerLocked,
          onOpen: handleOpenAttachment,
          onRemove: handleRemoveAttachment,
        }),
      )}
    </View>
  );
}

interface RenderQueueListArgs {
  queuedMessages: readonly QueuedMessage[];
  handleEditQueuedMessage: (id: string) => void;
  handleSendQueuedNow: (id: string) => Promise<void>;
}

function renderQueueList(args: RenderQueueListArgs): ReactElement | null {
  const { queuedMessages, handleEditQueuedMessage, handleSendQueuedNow } = args;
  if (queuedMessages.length === 0) return null;
  return (
    <View style={styles.queueContainer}>
      {queuedMessages.map((item) => (
        <QueuedMessageRow
          key={item.id}
          item={item}
          onEdit={handleEditQueuedMessage}
          onSendNow={handleSendQueuedNow}
        />
      ))}
    </View>
  );
}

function renderAutocompletePopover(
  autocomplete: ReturnType<typeof useAgentAutocomplete>,
): ReactElement | null {
  if (!autocomplete.isVisible) return null;
  return (
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
  );
}

interface RenderComposerAttachmentPillArgs {
  attachment: ComposerAttachment;
  index: number;
  disabled: boolean;
  onOpen: (attachment: ComposerAttachment) => void;
  onRemove: (index: number) => void;
}

function renderComposerAttachmentPill(args: RenderComposerAttachmentPillArgs): ReactElement {
  const { attachment, index, disabled, onOpen, onRemove } = args;
  if (attachment.kind === "image") {
    return (
      <ImageAttachmentPill
        key={attachment.metadata.id}
        attachment={attachment}
        index={index}
        disabled={disabled}
        onOpen={onOpen}
        onRemove={onRemove}
      />
    );
  }
  if (composerWorkspaceAttachment.is(attachment)) {
    return composerWorkspaceAttachment.renderPill({
      attachment,
      index,
      disabled,
      onOpen,
      onRemove,
    });
  }
  return (
    <GithubAttachmentPill
      key={`${attachment.item.kind}:${attachment.item.number}`}
      attachment={attachment}
      index={index}
      disabled={disabled}
      onOpen={onOpen}
      onRemove={onRemove}
    />
  );
}

function resolveVoiceStartErrorMessage(error: unknown): string | null {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return null;
}

interface AttemptStartRealtimeVoiceArgs {
  voice: ReturnType<typeof useVoiceOptional>;
  isConnected: boolean;
  hasAgent: boolean;
  serverId: string;
  agentId: string;
  toastErrorRef: { current: (message: string) => void };
}

function attemptStartRealtimeVoice(args: AttemptStartRealtimeVoiceArgs): void {
  const { voice, isConnected, hasAgent, serverId, agentId, toastErrorRef } = args;
  if (!voice || !isConnected || !hasAgent) return;
  if (voice.isVoiceSwitching) return;
  if (voice.isVoiceModeForAgent(serverId, agentId)) return;
  void voice.startVoice(serverId, agentId).catch((error) => {
    console.error("[Composer] Failed to start voice mode", error);
    const message = resolveVoiceStartErrorMessage(error);
    if (message && message.trim().length > 0) {
      toastErrorRef.current(message);
    }
  });
}

interface DispatchAgentMessageSendArgs {
  client: NonNullable<ReturnType<typeof useHostRuntimeClient>>;
  serverId: string;
  targetAgentId: string;
  text: string;
  sendAttachments: ComposerAttachment[];
  setAgentStreamHead: ReturnType<typeof useSessionStore.getState>["setAgentStreamHead"];
  setAgentStreamTail: ReturnType<typeof useSessionStore.getState>["setAgentStreamTail"];
}

function appendUserMessageToStream(
  args: DispatchAgentMessageSendArgs & { userMessage: StreamItem },
): void {
  const { serverId, targetAgentId, userMessage, setAgentStreamHead, setAgentStreamTail } = args;
  const currentHead = useSessionStore
    .getState()
    .sessions[serverId]?.agentStreamHead?.get(targetAgentId);
  if (currentHead && currentHead.length > 0) {
    setAgentStreamHead(serverId, (prev) => {
      const head = prev.get(targetAgentId) || [];
      const updated = new Map(prev);
      updated.set(targetAgentId, [...head, userMessage]);
      return updated;
    });
    return;
  }
  setAgentStreamTail(serverId, (prev) => {
    const currentStream = prev.get(targetAgentId) || [];
    const updated = new Map(prev);
    updated.set(targetAgentId, [...currentStream, userMessage]);
    return updated;
  });
}

async function dispatchAgentMessageSend(args: DispatchAgentMessageSendArgs): Promise<void> {
  const { client, targetAgentId, text, sendAttachments } = args;
  const wirePayload = splitComposerAttachmentsForSubmit(sendAttachments);
  const clientMessageId = generateMessageId();
  const userMessage: StreamItem = {
    kind: "user_message",
    id: clientMessageId,
    text,
    timestamp: new Date(),
    ...(wirePayload.images.length > 0 ? { images: wirePayload.images } : {}),
    ...(wirePayload.attachments.length > 0 ? { attachments: wirePayload.attachments } : {}),
  };
  appendUserMessageToStream({ ...args, userMessage });
  const imagesData = await encodeImages(wirePayload.images);
  await client.sendAgentMessage(targetAgentId, text, {
    messageId: clientMessageId,
    images: imagesData ?? [],
    attachments: wirePayload.attachments,
  });
}

function openComposerAttachment(
  attachment: ComposerAttachment,
  setLightboxMetadata: (metadata: AttachmentMetadata) => void,
  openWorkspaceAttachment: (input: { attachment: ComposerAttachment }) => boolean,
): void {
  if (attachment.kind === "image") {
    setLightboxMetadata(attachment.metadata);
    return;
  }
  if (composerWorkspaceAttachment.is(attachment)) {
    openWorkspaceAttachment({ attachment });
    return;
  }
  void openExternalUrl(attachment.item.url);
}

interface CancelRunningAgentArgs {
  isAgentRunning: boolean;
  isCancellingAgent: boolean;
  isConnected: boolean;
  client: ReturnType<typeof useHostRuntimeClient>;
  agentIdRef: { current: string };
  setIsCancellingAgent: (value: boolean) => void;
  messageInputRef: { current: MessageInputRef | null };
}

function cancelRunningAgent(args: CancelRunningAgentArgs): void {
  const {
    isAgentRunning,
    isCancellingAgent,
    isConnected,
    client,
    agentIdRef,
    setIsCancellingAgent,
    messageInputRef,
  } = args;
  if (!isAgentRunning || isCancellingAgent) return;
  if (!isConnected || !client) return;
  setIsCancellingAgent(true);
  void client.cancelAgent(agentIdRef.current);
  messageInputRef.current?.focus();
}

function focusMessageInputWithPlatformStrategy(messageInputRef: {
  current: MessageInputRef | null;
}): void {
  if (isNative) {
    messageInputRef.current?.focus();
    return;
  }
  focusWithRetries({
    focus: () => messageInputRef.current?.focus(),
    isFocused: () => {
      const el = messageInputRef.current?.getNativeElement?.() ?? null;
      const active = typeof document !== "undefined" ? document.activeElement : null;
      return Boolean(el) && active === el;
    },
  });
}

interface DispatchComposerKeyboardActionArgs {
  action: KeyboardActionDefinition;
  isPaneFocused: boolean;
  messageInputRef: { current: MessageInputRef | null };
  isAgentRunning: boolean;
  isCancellingAgent: boolean;
  isConnected: boolean;
  handleCancelAgent: () => void;
  focusMessageInputForKeyboardAction: () => void;
}

function dispatchComposerKeyboardAction(args: DispatchComposerKeyboardActionArgs): boolean {
  const {
    action,
    isPaneFocused,
    messageInputRef,
    isAgentRunning,
    isCancellingAgent,
    isConnected,
    handleCancelAgent,
    focusMessageInputForKeyboardAction,
  } = args;
  if (!isPaneFocused) return false;

  if (action.id === "agent.interrupt") {
    if (messageInputRef.current?.runKeyboardAction("dictation-cancel")) return true;
    if (!isAgentRunning || isCancellingAgent || !isConnected) return false;
    handleCancelAgent();
    return true;
  }

  if (action.id === "message-input.focus") {
    focusMessageInputForKeyboardAction();
    return true;
  }

  const passthroughAction = resolveMessageInputPassthroughAction(action.id);
  if (!passthroughAction) return false;
  const result = messageInputRef.current?.runKeyboardAction(passthroughAction);
  if (passthroughAction === "send" || passthroughAction === "dictation-confirm") {
    return result ?? false;
  }
  return true;
}

function resolveMessageInputPassthroughAction(
  actionId: string,
): MessageInputKeyboardActionKind | null {
  switch (actionId) {
    case "message-input.send":
      return "send";
    case "message-input.dictation-confirm":
      return "dictation-confirm";
    case "message-input.dictation-toggle":
      return "dictation-toggle";
    case "message-input.dictation-cancel":
      return "dictation-cancel";
    case "message-input.voice-toggle":
      return "voice-toggle";
    case "message-input.voice-mute-toggle":
      return "voice-mute-toggle";
    default:
      return null;
  }
}

interface QueuedMessageRowProps {
  item: QueuedMessage;
  onEdit: (id: string) => void;
  onSendNow: (id: string) => void;
}

function QueuedMessageRow({ item, onEdit, onSendNow }: QueuedMessageRowProps) {
  const handleEdit = useCallback(() => {
    onEdit(item.id);
  }, [onEdit, item.id]);
  const handleSendNow = useCallback(() => {
    onSendNow(item.id);
  }, [onSendNow, item.id]);
  return (
    <View style={styles.queueItem}>
      <Text style={styles.queueText} numberOfLines={2} ellipsizeMode="tail">
        {item.text}
      </Text>
      <View style={styles.queueActions}>
        <Pressable
          onPress={handleEdit}
          style={styles.queueActionButton}
          accessibilityLabel="Edit queued message"
        >
          <ThemedPencil size={ICON_SIZE.sm} uniProps={iconForegroundMapping} />
        </Pressable>
        <Pressable
          onPress={handleSendNow}
          style={QUEUE_SEND_BUTTON_STYLE}
          accessibilityLabel="Send queued message now"
        >
          <ArrowUp size={ICON_SIZE.sm} color="white" />
        </Pressable>
      </View>
    </View>
  );
}

function ImageAttachmentThumbnail({ image }: { image: ImageAttachment }) {
  const uri = useAttachmentPreviewUrl(image);
  const source = useMemo(() => ({ uri: uri ?? "" }), [uri]);
  if (!uri) {
    return <View style={styles.imageThumbnailPlaceholder} />;
  }
  return <Image source={source} style={styles.imageThumbnail} />;
}

interface ImageAttachmentPillProps {
  attachment: Extract<ComposerAttachment, { kind: "image" }>;
  index: number;
  disabled: boolean;
  onOpen: (attachment: ComposerAttachment) => void;
  onRemove: (index: number) => void;
}

function ImageAttachmentPill({
  attachment,
  index,
  disabled,
  onOpen,
  onRemove,
}: ImageAttachmentPillProps) {
  const handleOpen = useCallback(() => {
    onOpen(attachment);
  }, [onOpen, attachment]);
  const handleRemove = useCallback(() => {
    onRemove(index);
  }, [onRemove, index]);
  return (
    <AttachmentPill
      testID="composer-image-attachment-pill"
      onOpen={handleOpen}
      onRemove={handleRemove}
      openAccessibilityLabel="Open image attachment"
      removeAccessibilityLabel="Remove image attachment"
      disabled={disabled}
    >
      <ImageAttachmentThumbnail image={attachment.metadata} />
    </AttachmentPill>
  );
}

interface GithubAttachmentPillProps {
  attachment: Extract<ComposerAttachment, { kind: "github_pr" | "github_issue" }>;
  index: number;
  disabled: boolean;
  onOpen: (attachment: ComposerAttachment) => void;
  onRemove: (index: number) => void;
}

function GithubAttachmentPill({
  attachment,
  index,
  disabled,
  onOpen,
  onRemove,
}: GithubAttachmentPillProps) {
  const item = attachment.item;
  const kindLabel = item.kind === "pr" ? "PR" : "issue";
  const handleOpen = useCallback(() => {
    onOpen(attachment);
  }, [onOpen, attachment]);
  const handleRemove = useCallback(() => {
    onRemove(index);
  }, [onRemove, index]);
  return (
    <AttachmentPill
      testID="composer-github-attachment-pill"
      onOpen={handleOpen}
      onRemove={handleRemove}
      openAccessibilityLabel={`Open ${kindLabel} #${item.number}`}
      removeAccessibilityLabel={`Remove ${kindLabel} #${item.number}`}
      disabled={disabled}
    >
      <View style={styles.githubPillBody}>
        <View style={styles.githubPillIcon}>
          {item.kind === "pr" ? (
            <ThemedGitPullRequest size={ICON_SIZE.sm} uniProps={iconForegroundMutedMapping} />
          ) : (
            <ThemedCircleDot size={ICON_SIZE.sm} uniProps={iconForegroundMutedMapping} />
          )}
        </View>
        <Text style={styles.githubPillText} numberOfLines={1}>
          #{item.number} {item.title}
        </Text>
      </View>
    </AttachmentPill>
  );
}

interface GithubPickerOptionProps {
  label: string;
  testID: string;
  active: boolean;
  selected: boolean;
  item: GitHubSearchItem;
  onToggle: (item: GitHubSearchItem) => void;
}

function GithubPickerOption({
  label,
  testID,
  active,
  selected,
  item,
  onToggle,
}: GithubPickerOptionProps) {
  const handlePress = useCallback(() => {
    onToggle(item);
  }, [onToggle, item]);
  const leadingSlot = useMemo(
    () =>
      item.kind === "pr" ? (
        <ThemedGitPullRequest size={ICON_SIZE.sm} uniProps={iconForegroundMutedMapping} />
      ) : (
        <ThemedCircleDot size={ICON_SIZE.sm} uniProps={iconForegroundMutedMapping} />
      ),
    [item.kind],
  );
  return (
    <ComboboxItem
      testID={testID}
      label={label}
      selected={selected}
      active={active}
      onPress={handlePress}
      leadingSlot={leadingSlot}
    />
  );
}

interface ComposerProps {
  agentId: string;
  serverId: string;
  isPaneFocused: boolean;
  onSubmitMessage?: (payload: MessagePayload) => Promise<void>;
  /** When true, the submit button is enabled even without text or images (e.g. external attachment selected). */
  hasExternalContent?: boolean;
  /** When true, the composer can submit even with no text or attachments. */
  allowEmptySubmit?: boolean;
  /** Optional accessibility label for the primary submit button. */
  submitButtonAccessibilityLabel?: string;
  submitIcon?: "arrow" | "return";
  /** Externally controlled loading state. When true, disables the submit button. */
  isSubmitLoading?: boolean;
  submitBehavior?: "clear" | "preserve-and-lock";
  /** When true, blurs the input immediately when submitting. */
  blurOnSubmit?: boolean;
  value: string;
  onChangeText: (text: string) => void;
  attachments: UserComposerAttachment[];
  workspaceAttachments?: readonly WorkspaceComposerAttachment[];
  onOpenWorkspaceAttachment?: (attachment: WorkspaceComposerAttachment) => void;
  onChangeAttachments: (updater: AttachmentListUpdater) => void;
  cwd: string;
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
  /** Extra styles merged onto the message input wrapper (e.g. elevated background). */
  inputWrapperStyle?: import("react-native").ViewStyle;
}

const EMPTY_ARRAY: readonly QueuedMessage[] = [];
const DESKTOP_MESSAGE_PLACEHOLDER = "Message the agent, tag @files, or use /commands and /skills";
const MOBILE_MESSAGE_PLACEHOLDER = "Message, @files, /commands";
const StableMessageInput = memo(MessageInput);

function resolveContextWindowValues(
  rawMax: number | null,
  rawUsed: number | null,
): { contextWindowMaxTokens: number | null; contextWindowUsedTokens: number | null } {
  if (typeof rawMax === "number" && typeof rawUsed === "number") {
    return { contextWindowMaxTokens: rawMax, contextWindowUsedTokens: rawUsed };
  }
  return { contextWindowMaxTokens: null, contextWindowUsedTokens: null };
}

interface ComposerCancelButtonProps {
  buttonIconSize: number;
  cancelButtonStyle: (object | undefined)[];
  handleCancelAgent: () => void;
  isConnected: boolean;
  isCancellingAgent: boolean;
  agentInterruptKeys: ReturnType<typeof useShortcutKeys>;
}

function ComposerCancelButton({
  buttonIconSize,
  cancelButtonStyle,
  handleCancelAgent,
  isConnected,
  isCancellingAgent,
  agentInterruptKeys,
}: ComposerCancelButtonProps) {
  const accessibilityLabel = isCancellingAgent ? "Canceling agent" : "Stop agent";
  const icon = isCancellingAgent ? (
    <ActivityIndicator size="small" color="white" />
  ) : (
    <Square size={buttonIconSize} color="white" fill="white" />
  );
  const shortcutNode = agentInterruptKeys ? <Shortcut chord={agentInterruptKeys} /> : null;
  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger
        onPress={handleCancelAgent}
        disabled={!isConnected || isCancellingAgent}
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="button"
        style={cancelButtonStyle}
      >
        {icon}
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <View style={styles.tooltipRow}>
          <Text style={styles.tooltipText}>Interrupt</Text>
          {shortcutNode}
        </View>
      </TooltipContent>
    </Tooltip>
  );
}

interface ComposerCancelButtonSlotProps extends ComposerCancelButtonProps {
  isAgentRunning: boolean;
  hasSendableContent: boolean;
  isProcessing: boolean;
}

function ComposerCancelButtonSlot({
  isAgentRunning,
  hasSendableContent,
  isProcessing,
  ...rest
}: ComposerCancelButtonSlotProps) {
  if (!isAgentRunning || hasSendableContent || isProcessing) return null;
  return <ComposerCancelButton {...rest} />;
}

interface ComposerVoiceModeButtonProps {
  buttonIconSize: number;
  handleToggleRealtimeVoice: () => void;
  isConnected: boolean;
  isVoiceSwitching: boolean;
  realtimeVoiceButtonStyle: (
    state: PressableStateCallbackType & { hovered?: boolean },
  ) => (object | undefined)[];
  voiceToggleKeys: ReturnType<typeof useShortcutKeys>;
}

interface ComposerRightControlsSlotProps extends ComposerVoiceModeButtonProps {
  isVoiceModeForAgent: boolean;
  hasAgent: boolean;
  isAgentRunning: boolean;
  hasSendableContent: boolean;
  isProcessing: boolean;
  cancelButton: ReactElement;
}

function ComposerRightControlsSlot({
  isVoiceModeForAgent,
  hasAgent,
  isAgentRunning,
  hasSendableContent,
  isProcessing,
  cancelButton,
  ...voiceProps
}: ComposerRightControlsSlotProps) {
  const showVoiceModeButton = !isVoiceModeForAgent && hasAgent;
  const shouldShowCancelButton = isAgentRunning && !hasSendableContent && !isProcessing;
  if (!showVoiceModeButton && !shouldShowCancelButton) return null;
  return (
    <View style={styles.rightControls}>
      {showVoiceModeButton ? <ComposerVoiceModeButton {...voiceProps} /> : null}
      {cancelButton}
    </View>
  );
}

function ComposerVoiceModeButton({
  buttonIconSize,
  handleToggleRealtimeVoice,
  isConnected,
  isVoiceSwitching,
  realtimeVoiceButtonStyle,
  voiceToggleKeys,
}: ComposerVoiceModeButtonProps) {
  const shortcutNode = voiceToggleKeys ? <Shortcut chord={voiceToggleKeys} /> : null;
  const renderTriggerContent = useCallback(
    ({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => {
      if (isVoiceSwitching) {
        return <ActivityIndicator size="small" color="white" />;
      }
      const colorMapping = hovered ? iconForegroundMapping : iconForegroundMutedMapping;
      return <ThemedAudioLines size={buttonIconSize} uniProps={colorMapping} />;
    },
    [buttonIconSize, isVoiceSwitching],
  );
  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger
        onPress={handleToggleRealtimeVoice}
        disabled={!isConnected || isVoiceSwitching}
        accessibilityLabel="Enable Voice mode"
        accessibilityRole="button"
        style={realtimeVoiceButtonStyle}
      >
        {renderTriggerContent}
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <View style={styles.tooltipRow}>
          <Text style={styles.tooltipText}>Voice mode</Text>
          {shortcutNode}
        </View>
      </TooltipContent>
    </Tooltip>
  );
}

export function Composer({
  agentId,
  serverId,
  isPaneFocused,
  onSubmitMessage,
  hasExternalContent = false,
  allowEmptySubmit = false,
  submitButtonAccessibilityLabel,
  submitIcon = "arrow",
  isSubmitLoading = false,
  submitBehavior = "clear",
  blurOnSubmit = false,
  value,
  onChangeText,
  attachments,
  workspaceAttachments = [],
  onOpenWorkspaceAttachment,
  onChangeAttachments,
  cwd,
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
  inputWrapperStyle,
}: ComposerProps) {
  const buttonIconSize = resolveComposerButtonIconSize();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const agentDirectoryStatus = useHostRuntimeAgentDirectoryStatus(serverId);
  const toast = useToast();
  const toastErrorRef = useRef(toast.error);
  toastErrorRef.current = toast.error;
  const voice = useVoiceOptional();
  const voiceToggleKeys = useShortcutKeys("voice-toggle");
  const agentInterruptKeys = useShortcutKeys("agent-interrupt");
  const isDictationReady = useIsDictationReady({
    serverId,
    isConnected,
    agentDirectoryStatus,
  });

  const { settings: appSettings } = useAppSettings();

  const agentState = useSessionStore(useShallow(buildAgentStateSelector(serverId, agentId)));

  const queuedMessagesRaw = useSessionStore((state) =>
    state.sessions[serverId]?.queuedMessages?.get(agentId),
  );
  const queuedMessages = queuedMessagesRaw ?? EMPTY_ARRAY;

  const setQueuedMessages = useSessionStore((state) => state.setQueuedMessages);
  const setAgentStreamTail = useSessionStore((state) => state.setAgentStreamTail);
  const setAgentStreamHead = useSessionStore((state) => state.setAgentStreamHead);

  const isMobile = useIsCompactFormFactor();
  const isDesktopWebBreakpoint = resolveIsDesktopWebBreakpoint(isMobile);
  const messagePlaceholder = resolveMessagePlaceholder(isDesktopWebBreakpoint);
  const userInput = value;
  const setUserInput = onChangeText;
  const {
    selectedAttachments,
    buildOutgoingAttachments,
    removeAttachment,
    openAttachment,
    clearSentAttachments,
    completeSubmit,
    resetSuppression,
  } = composerWorkspaceAttachment.useBinding({
    normalAttachments: attachments,
    workspaceAttachments,
    onOpenWorkspaceAttachment,
  });
  const setSelectedAttachments = onChangeAttachments;
  const [cursorIndex, setCursorIndex] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isCancellingAgent, setIsCancellingAgent] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [isMessageInputFocused, setIsMessageInputFocused] = useState(false);
  const [isGithubPickerOpen, setIsGithubPickerOpen] = useState(false);
  const [githubSearchQuery, setGithubSearchQuery] = useState("");
  const [lightboxMetadata, setLightboxMetadata] = useState<AttachmentMetadata | null>(null);
  const attachButtonRef = useRef<View | null>(null);
  const messageInputRef = useRef<MessageInputRef>(null);
  const isComposerLocked = resolveIsComposerLocked(submitBehavior, isSubmitLoading);
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
  const autocompleteOnKeyPressRef = useRef(autocomplete.onKeyPress);
  autocompleteOnKeyPressRef.current = autocomplete.onKeyPress;

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
    ((agentId: string, text: string, attachments: ComposerAttachment[]) => Promise<void>) | null
  >(null);
  const onSubmitMessageRef = useRef(onSubmitMessage);

  // Expose addImages function to parent for drag-and-drop support
  const addImages = useCallback(
    (images: ImageAttachment[]) => {
      setSelectedAttachments((prev) => [
        ...prev,
        ...images.map((metadata) => ({ kind: "image" as const, metadata })),
      ]);
    },
    [setSelectedAttachments],
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
    async (text: string, submitAttachments: ComposerAttachment[]) => {
      onMessageSent?.();
      if (onSubmitMessageRef.current) {
        await onSubmitMessageRef.current({ text, attachments: submitAttachments, cwd });
        return;
      }
      if (!sendAgentMessageRef.current) {
        throw new Error("Host is not connected");
      }
      await sendAgentMessageRef.current(agentIdRef.current, text, submitAttachments);
    },
    [cwd, onMessageSent],
  );

  useEffect(() => {
    agentIdRef.current = agentId;
  }, [agentId]);

  useEffect(() => {
    sendAgentMessageRef.current = async (
      targetAgentId: string,
      text: string,
      sendAttachments: ComposerAttachment[],
    ) => {
      if (!client) {
        throw new Error("Host is not connected");
      }
      await dispatchAgentMessageSend({
        client,
        serverId,
        targetAgentId,
        text,
        sendAttachments,
        setAgentStreamHead,
        setAgentStreamTail,
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

  const queueMessage = useCallback(
    (queuedMessage: string, queuedAttachments: ComposerAttachment[]) => {
      const trimmedMessage = queuedMessage.trim();
      if (!trimmedMessage && queuedAttachments.length === 0) return;

      const newItem = {
        id: generateMessageId(),
        text: trimmedMessage,
        attachments: queuedAttachments,
      };

      setQueuedMessages(serverId, (prev: Map<string, QueuedMessage[]>) => {
        const next = new Map(prev);
        next.set(agentId, [...(prev.get(agentId) ?? []), newItem]);
        return next;
      });

      setUserInput("");
      setSelectedAttachments([]);
      resetSuppression();
      clearSentAttachments(queuedAttachments);
    },
    [
      agentId,
      clearSentAttachments,
      resetSuppression,
      serverId,
      setQueuedMessages,
      setSelectedAttachments,
      setUserInput,
    ],
  );

  const sendMessageWithContent = useCallback(
    async (
      outgoingMessage: string,
      outgoingAttachments: ComposerAttachment[],
      forceSend?: boolean,
    ) => {
      const result = await submitAgentInput({
        message: outgoingMessage,
        attachments: outgoingAttachments,
        hasExternalContent,
        allowEmptySubmit,
        forceSend,
        submitBehavior,
        isAgentRunning,
        // Parent-managed submits are still valid submit paths even when the
        // transport is disconnected, because the parent decides the failure mode.
        canSubmit: Boolean(sendAgentMessageRef.current || onSubmitMessageRef.current),
        queueMessage: ({ message: queuedText, attachments: queuedAttachments }) => {
          queueMessage(queuedText, queuedAttachments);
        },
        submitMessage: async ({ message: submitText, attachments: submitAttachments }) => {
          await submitMessage(submitText, submitAttachments);
        },
        clearDraft,
        setUserInput,
        setAttachments: (nextAttachments) => {
          setSelectedAttachments(composerWorkspaceAttachment.userAttachmentsOnly(nextAttachments));
        },
        setSendError,
        setIsProcessing,
        onSubmitError: (error) => {
          console.error("[AgentInput] Failed to send message:", error);
        },
      });
      completeSubmit({
        result,
        outgoingAttachments,
      });
    },
    [
      allowEmptySubmit,
      clearDraft,
      completeSubmit,
      hasExternalContent,
      isAgentRunning,
      queueMessage,
      setSelectedAttachments,
      setUserInput,
      submitBehavior,
      submitMessage,
    ],
  );

  const handleSubmit = useCallback(
    (payload: MessagePayload) => {
      if (blurOnSubmit) {
        messageInputRef.current?.blur();
      }
      void sendMessageWithContent(
        payload.text,
        buildOutgoingAttachments(attachments),
        payload.forceSend,
      );
    },
    [attachments, blurOnSubmit, buildOutgoingAttachments, sendMessageWithContent],
  );

  const handlePickImage = useCallback(async () => {
    const newImages = await pickAndPersistImages(pickImages);
    if (newImages.length === 0) return;
    addImages(newImages);
  }, [addImages, pickImages]);

  const handleRemoveAttachment = useCallback(
    (index: number) => {
      const didRemoveWorkspaceAttachment = removeAttachment({
        selectedAttachments,
        index,
      });
      if (didRemoveWorkspaceAttachment) {
        return;
      }
      setSelectedAttachments((prev) => removeAttachmentAtIndex(prev, index));
    },
    [removeAttachment, selectedAttachments, setSelectedAttachments],
  );

  const handleOpenAttachment = useCallback(
    (attachment: ComposerAttachment) => {
      openComposerAttachment(attachment, setLightboxMetadata, openAttachment);
    },
    [openAttachment],
  );

  useEffect(() => {
    if (!isAgentRunning || !isConnected) {
      setIsCancellingAgent(false);
    }
  }, [isAgentRunning, isConnected]);

  const handleCancelAgent = useCallback(() => {
    cancelRunningAgent({
      isAgentRunning,
      isCancellingAgent,
      isConnected,
      client,
      agentIdRef,
      setIsCancellingAgent,
      messageInputRef,
    });
  }, [client, isAgentRunning, isCancellingAgent, isConnected]);

  const focusMessageInputForKeyboardAction = useCallback(() => {
    focusMessageInputWithPlatformStrategy(messageInputRef);
  }, []);

  const handleKeyboardAction = useCallback(
    (action: KeyboardActionDefinition): boolean =>
      dispatchComposerKeyboardAction({
        action,
        isPaneFocused,
        messageInputRef,
        isAgentRunning,
        isCancellingAgent,
        isConnected,
        handleCancelAgent,
        focusMessageInputForKeyboardAction,
      }),
    [
      focusMessageInputForKeyboardAction,
      handleCancelAgent,
      isAgentRunning,
      isCancellingAgent,
      isConnected,
      isPaneFocused,
    ],
  );

  useKeyboardActionHandler({
    handlerId: keyboardHandlerIdRef.current,
    actions: [
      "agent.interrupt",
      "message-input.focus",
      "message-input.send",
      "message-input.dictation-toggle",
      "message-input.dictation-cancel",
      "message-input.dictation-confirm",
      "message-input.voice-toggle",
      "message-input.voice-mute-toggle",
    ],
    enabled: isPaneFocused,
    priority: resolveKeyboardPriority(isMessageInputFocused),
    isActive: () => isPaneFocused,
    handle: handleKeyboardAction,
  });

  const { style: keyboardAnimatedStyle } = useKeyboardShiftStyle({
    mode: "translate",
  });

  const isVoiceModeForAgent = resolveIsVoiceModeForAgent(voice, serverId, agentId);

  const handleToggleRealtimeVoice = useCallback(() => {
    attemptStartRealtimeVoice({
      voice,
      isConnected,
      hasAgent,
      serverId,
      agentId,
      toastErrorRef,
    });
  }, [agentId, hasAgent, isConnected, serverId, voice]);

  const handleEditQueuedMessage = useCallback(
    (id: string) => {
      const item = queuedMessages.find((q) => q.id === id);
      if (!item) return;

      updateQueue((current) => current.filter((q) => q.id !== id));
      setUserInput(item.text);
      setSelectedAttachments(composerWorkspaceAttachment.userAttachmentsOnly(item.attachments));
    },
    [queuedMessages, setSelectedAttachments, setUserInput, updateQueue],
  );

  const handleSendQueuedNow = useCallback(
    async (id: string) => {
      const item = queuedMessages.find((q) => q.id === id);
      if (!item) return;
      if (!sendAgentMessageRef.current && !onSubmitMessageRef.current) return;

      updateQueue((current) => current.filter((q) => q.id !== id));

      // Reuse the regular send path; server-side send atomically interrupts any active run.
      try {
        await submitMessage(item.text, item.attachments);
      } catch (error) {
        updateQueue((current) => [item, ...current]);
        setSendError(error instanceof Error ? error.message : "Failed to send message");
      }
    },
    [queuedMessages, submitMessage, updateQueue],
  );

  const handleQueue = useCallback(
    (payload: MessagePayload) => {
      queueMessage(payload.text, buildOutgoingAttachments(attachments));
    },
    [attachments, buildOutgoingAttachments, queueMessage],
  );

  const hasSendableContent = userInput.trim().length > 0 || selectedAttachments.length > 0;

  // Handle keyboard navigation for command autocomplete.
  const handleCommandKeyPress = useCallback(
    (event: { key: string; preventDefault: () => void }) => {
      return autocompleteOnKeyPressRef.current(event);
    },
    [],
  );

  const cancelButtonStyle = useMemo(
    () => buildCancelButtonStyle(isConnected, isCancellingAgent),
    [isConnected, isCancellingAgent],
  );

  const isVoiceSwitching = voice?.isVoiceSwitching ?? false;
  const voiceButtonDisabled = !isConnected || isVoiceSwitching;
  const realtimeVoiceButtonStyle = useCallback(
    (state: PressableStateCallbackType & { hovered?: boolean }) =>
      buildRealtimeVoiceButtonStyle(state.hovered, voiceButtonDisabled),
    [voiceButtonDisabled],
  );

  const cancelButton = useMemo(
    () => (
      <ComposerCancelButtonSlot
        isAgentRunning={isAgentRunning}
        hasSendableContent={hasSendableContent}
        isProcessing={isProcessing}
        buttonIconSize={buttonIconSize}
        cancelButtonStyle={cancelButtonStyle}
        handleCancelAgent={handleCancelAgent}
        isConnected={isConnected}
        isCancellingAgent={isCancellingAgent}
        agentInterruptKeys={agentInterruptKeys}
      />
    ),
    [
      agentInterruptKeys,
      buttonIconSize,
      cancelButtonStyle,
      handleCancelAgent,
      hasSendableContent,
      isAgentRunning,
      isCancellingAgent,
      isConnected,
      isProcessing,
    ],
  );

  const rightContent = useMemo(
    () => (
      <ComposerRightControlsSlot
        isVoiceModeForAgent={isVoiceModeForAgent}
        hasAgent={hasAgent}
        isAgentRunning={isAgentRunning}
        hasSendableContent={hasSendableContent}
        isProcessing={isProcessing}
        buttonIconSize={buttonIconSize}
        handleToggleRealtimeVoice={handleToggleRealtimeVoice}
        isConnected={isConnected}
        isVoiceSwitching={isVoiceSwitching}
        realtimeVoiceButtonStyle={realtimeVoiceButtonStyle}
        voiceToggleKeys={voiceToggleKeys}
        cancelButton={cancelButton}
      />
    ),
    [
      buttonIconSize,
      cancelButton,
      handleToggleRealtimeVoice,
      hasAgent,
      hasSendableContent,
      isAgentRunning,
      isConnected,
      isProcessing,
      isVoiceModeForAgent,
      isVoiceSwitching,
      realtimeVoiceButtonStyle,
      voiceToggleKeys,
    ],
  );

  const { contextWindowMaxTokens, contextWindowUsedTokens } = resolveContextWindowValues(
    agentState.contextWindowMaxTokens,
    agentState.contextWindowUsedTokens,
  );

  const beforeVoiceContent = useMemo(
    () => renderContextWindowMeterSlot(contextWindowMaxTokens, contextWindowUsedTokens),
    [contextWindowMaxTokens, contextWindowUsedTokens],
  );

  const githubSearchQueryTrimmed = githubSearchQuery.trim();
  const githubSearchResultsQuery = useQuery(
    buildGithubSearchQueryOptions({
      serverId,
      cwd,
      githubSearchQueryTrimmed,
      isGithubPickerOpen,
      isConnected,
      client,
    }),
  );

  const githubSearchItemsRaw = githubSearchResultsQuery.data?.items;
  const githubSearchItems = useMemo(() => githubSearchItemsRaw ?? [], [githubSearchItemsRaw]);
  const githubSearchOptions: ComboboxOption[] = useMemo(
    () =>
      githubSearchItems.map((item) => ({
        id: `${item.kind}:${item.number}`,
        label: `#${item.number} ${item.title}`,
        description: githubSearchQueryTrimmed,
      })),
    [githubSearchItems, githubSearchQueryTrimmed],
  );

  const attachmentMenuItems = useMemo<AttachmentMenuItem[]>(
    () => [
      {
        id: "image",
        label: "Add image",
        icon: <ThemedPaperclip size={ICON_SIZE.md} uniProps={iconForegroundMutedMapping} />,
        onSelect: () => {
          void handlePickImage();
        },
      },
      {
        id: "github",
        label: "Add issue or PR",
        icon: <ThemedGithub size={ICON_SIZE.md} uniProps={iconForegroundMutedMapping} />,
        onSelect: () => {
          setIsGithubPickerOpen(true);
        },
      },
    ],
    [handlePickImage],
  );

  const handleToggleGithubItem = useCallback(
    (item: GitHubSearchItem) => {
      setSelectedAttachments((current) => toggleGithubAttachment(current, item));
      setIsGithubPickerOpen(false);
      setGithubSearchQuery("");
    },
    [setSelectedAttachments, setGithubSearchQuery, setIsGithubPickerOpen],
  );

  const leftContent = useMemo(
    () => renderLeftContent({ statusControls, agentId, serverId, focusInput }),
    [agentId, focusInput, serverId, statusControls],
  );

  const handleAttachButtonRef = useCallback((node: View | null) => {
    attachButtonRef.current = node;
  }, []);

  const handleSelectionChange = useCallback((selection: { start: number; end: number }) => {
    setCursorIndex(selection.start);
  }, []);

  const handleFocusChange = useCallback(
    (focused: boolean) => {
      setIsMessageInputFocused(focused);
      if (focused) {
        onAttentionInputFocus?.();
      }
    },
    [onAttentionInputFocus],
  );

  const handleLightboxClose = useCallback(() => {
    setLightboxMetadata(null);
  }, []);

  const handleGithubPickerOpenChange = useCallback(
    (open: boolean) => {
      setIsGithubPickerOpen(open);
      if (!open) {
        setGithubSearchQuery("");
      }
    },
    [setGithubSearchQuery],
  );

  const renderGithubPickerOption = useCallback(
    ({ option, active }: { option: ComboboxOption; selected: boolean; active: boolean }) => {
      const item = findGithubItemByOption(githubSearchItems, option.id);
      if (!item) {
        return <View key={option.id} />;
      }
      const selected = isAttachmentSelectedForGithubItem(selectedAttachments, item);
      return (
        <GithubPickerOption
          key={option.id}
          testID={`composer-github-option-${option.id}`}
          label={option.label}
          selected={selected}
          active={active}
          item={item}
          onToggle={handleToggleGithubItem}
        />
      );
    },
    [githubSearchItems, selectedAttachments, handleToggleGithubItem],
  );

  const composerContainerStyle = useMemo(
    () => [styles.container, keyboardAnimatedStyle],
    [keyboardAnimatedStyle],
  );
  const inputAreaContainerStyle = useMemo(
    () => [styles.inputAreaContainer, isComposerLocked && styles.inputAreaLocked],
    [isComposerLocked],
  );

  const attachmentPreviewList = useMemo(
    () =>
      renderAttachmentPreviewList({
        selectedAttachments,
        isComposerLocked,
        handleOpenAttachment,
        handleRemoveAttachment,
      }),
    [handleOpenAttachment, handleRemoveAttachment, isComposerLocked, selectedAttachments],
  );

  const queueList = useMemo(
    () => renderQueueList({ queuedMessages, handleEditQueuedMessage, handleSendQueuedNow }),
    [handleEditQueuedMessage, handleSendQueuedNow, queuedMessages],
  );

  const autocompletePopover = useMemo(
    () => renderAutocompletePopover(autocomplete),
    [autocomplete],
  );

  const isSubmitBusy = isProcessing || isSubmitLoading;
  const messageInputAutoFocus = autoFocus && isDesktopWebBreakpoint;
  const submitLoadingPressHandler = isAgentRunning ? handleCancelAgent : undefined;
  const sendErrorNode = useMemo(
    () => (sendError ? <Text style={styles.sendErrorText}>{sendError}</Text> : null),
    [sendError],
  );
  const githubEmptyText = githubSearchResultsQuery.isFetching
    ? "Searching..."
    : "No results found.";

  return (
    <Animated.View style={composerContainerStyle}>
      <AttachmentLightbox metadata={lightboxMetadata} onClose={handleLightboxClose} />
      {/* Input area */}
      <View style={inputAreaContainerStyle}>
        <View style={styles.inputAreaContent}>
          {queueList}
          {sendErrorNode}

          <View style={styles.messageInputContainer}>
            {autocompletePopover}
            {attachmentPreviewList}

            {/* MessageInput handles everything: text, dictation, attachments, all buttons */}
            <StableMessageInput
              ref={messageInputRef}
              value={userInput}
              onChangeText={setUserInput}
              onSubmit={handleSubmit}
              hasExternalContent={hasExternalContent}
              allowEmptySubmit={allowEmptySubmit}
              submitButtonAccessibilityLabel={submitButtonAccessibilityLabel}
              submitIcon={submitIcon}
              isSubmitDisabled={isSubmitBusy}
              isSubmitLoading={isSubmitBusy}
              attachments={selectedAttachments}
              cwd={cwd}
              attachmentMenuItems={attachmentMenuItems}
              onAttachButtonRef={handleAttachButtonRef}
              onAddImages={addImages}
              client={client}
              isReadyForDictation={isDictationReady}
              placeholder={messagePlaceholder}
              autoFocus={messageInputAutoFocus}
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
              onSubmitLoadingPress={submitLoadingPressHandler}
              onKeyPress={handleCommandKeyPress}
              onSelectionChange={handleSelectionChange}
              onFocusChange={handleFocusChange}
              onHeightChange={onComposerHeightChange}
              inputWrapperStyle={inputWrapperStyle}
            />
            <Combobox
              options={githubSearchOptions}
              value=""
              onSelect={noop}
              keepOpenOnSelect
              searchable
              searchPlaceholder="Search issues and PRs..."
              title="Attach issue or PR"
              open={isGithubPickerOpen}
              onOpenChange={handleGithubPickerOpenChange}
              onSearchQueryChange={setGithubSearchQuery}
              desktopPlacement="top-start"
              anchorRef={attachButtonRef}
              emptyText={githubEmptyText}
              renderOption={renderGithubPickerOption}
            />
          </View>
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
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
  inputAreaLocked: {
    opacity: 0.6,
  },
  inputAreaContent: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
    gap: theme.spacing[3],
  },
  messageInputContainer: {
    position: "relative",
    width: "100%",
    gap: theme.spacing[3],
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
    marginLeft: theme.spacing[1],
  },
  rightControls: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
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
  attachmentPreviewContainer: {
    flexDirection: "row",
    gap: theme.spacing[2],
    flexWrap: "wrap",
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
  githubPillBody: {
    minHeight: 48,
    maxWidth: 260,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
  },
  githubPillIcon: {
    width: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  githubPillText: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
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
})) as unknown as Record<string, object>;

const QUEUE_SEND_BUTTON_STYLE = [styles.queueActionButton, styles.queueSendButton];

const ThemedPencil = withUnistyles(Pencil);
const ThemedGitPullRequest = withUnistyles(GitPullRequest);
const ThemedCircleDot = withUnistyles(CircleDot);
const ThemedAudioLines = withUnistyles(AudioLines);
const ThemedPaperclip = withUnistyles(Paperclip);
const ThemedGithub = withUnistyles(Github);

const iconForegroundMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const iconForegroundMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
