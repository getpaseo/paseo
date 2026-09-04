import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import Animated, { FadeIn } from "react-native-reanimated";
import { Bookmark, X } from "lucide-react-native";
import { Combobox, ComboboxItem, type ComboboxOption } from "@/components/ui/combobox";
import { useToast } from "@/contexts/toast-context";
import { useComposerKeyboardScope } from "@/composer/keyboard-scope";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import type { KeyboardActionDefinition } from "@/keyboard/keyboard-action-dispatcher";
import {
  buildPromptStashScopeKey,
  countOtherScopeEntries,
  EMPTY_PROMPT_STASH_QUEUE,
  mergeStashRestoreAttachments,
  mergeStashRestoreText,
  usePromptStashStore,
  type PromptStashEntry,
} from "@/stores/prompt-stash-store";
import { scheduleAttachmentGc } from "@/stores/draft-store";
import type { UserComposerAttachment } from "@/attachments/types";
import { generateMessageId } from "@/types/stream";
import { formatTimeAgo } from "@/utils/time";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import type { TFunction } from "i18next";

const SNIPPET_MAX_CHARS = 80;

type AttachmentListUpdater =
  | UserComposerAttachment[]
  | ((prev: UserComposerAttachment[]) => UserComposerAttachment[]);

interface ComposerStashProps {
  /** Provider the composer is currently targeting; scopes the stash queue. */
  provider: string | null;
  /** Anchor for the picker popover (the message input container). */
  anchorRef: RefObject<View | null>;
  userInput: string;
  setUserInput: (text: string) => void;
  attachments: UserComposerAttachment[];
  setAttachments: (updater: AttachmentListUpdater) => void;
  /** When true (composer locked/submitting), stashing is suppressed. */
  disabled: boolean;
  focusInput: () => void;
}

function stashEntrySnippet(entry: PromptStashEntry, t: TFunction): string {
  const collapsed = entry.text.trim().replace(/\s+/g, " ");
  if (collapsed.length > 0) {
    return collapsed.length > SNIPPET_MAX_CHARS
      ? `${collapsed.slice(0, SNIPPET_MAX_CHARS)}…`
      : collapsed;
  }
  return t("composer.stash.attachmentsOnly", { count: entry.attachments.length });
}

function stashEntryDescription(entry: PromptStashEntry, t: TFunction): string {
  const timeLabel = formatTimeAgo(new Date(entry.createdAt));
  if (entry.text.trim().length > 0 && entry.attachments.length > 0) {
    return `${timeLabel} · ${t("composer.stash.attachmentsOnly", {
      count: entry.attachments.length,
    })}`;
  }
  return timeLabel;
}

interface StashMenuItemProps {
  option: ComboboxOption;
  active: boolean;
  onPress: () => void;
  description: string;
  deleteLabel: string;
  onDelete: (entryId: string) => void;
}

function StashMenuItem({
  option,
  active,
  onPress,
  description,
  deleteLabel,
  onDelete,
}: StashMenuItemProps) {
  const handleDelete = useCallback(() => {
    onDelete(option.id);
  }, [onDelete, option.id]);
  const deleteButtonStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.deleteButton,
      (hovered || pressed) && styles.deleteButtonHovered,
    ],
    [],
  );
  const leadingSlot = useMemo(
    () => <ThemedBookmark size={ICON_SIZE.sm} uniProps={iconMutedMapping} />,
    [],
  );
  const trailingSlot = useMemo(
    () => (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={deleteLabel}
        onPress={handleDelete}
        style={deleteButtonStyle}
        testID={`composer-stash-delete-${option.id}`}
      >
        <ThemedX size={ICON_SIZE.sm} uniProps={iconMutedMapping} />
      </Pressable>
    ),
    [deleteButtonStyle, deleteLabel, handleDelete, option.id],
  );
  return (
    <ComboboxItem
      testID={`composer-stash-option-${option.id}`}
      label={option.label}
      description={description}
      active={active}
      onPress={onPress}
      leadingSlot={leadingSlot}
      trailingSlot={trailingSlot}
    />
  );
}

interface StashUndoToastProps {
  entryId: string;
  message: string;
  undoLabel: string;
  onRestore: (entryId: string) => void;
  onRestored: () => void;
}

/** Toast body with an inline Undo action; the toast host renders ReactNode content. */
function StashUndoToast({
  entryId,
  message,
  undoLabel,
  onRestore,
  onRestored,
}: StashUndoToastProps) {
  const handleUndo = useCallback(() => {
    onRestore(entryId);
    onRestored();
  }, [entryId, onRestore, onRestored]);
  return (
    <View style={styles.toastRow}>
      <Text style={styles.toastText}>{message}</Text>
      <Pressable
        accessibilityRole="button"
        onPress={handleUndo}
        testID="composer-stash-undo"
        hitSlop={8}
      >
        <Text style={styles.toastUndo}>{undoLabel}</Text>
      </Pressable>
    </View>
  );
}

export function ComposerStash({
  provider,
  anchorRef,
  userInput,
  setUserInput,
  attachments,
  setAttachments,
  disabled,
  focusInput,
}: ComposerStashProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const { isActiveComposer } = useComposerKeyboardScope();
  const [menuOpen, setMenuOpen] = useState(false);

  const scopeKey = buildPromptStashScopeKey(provider);
  const entries = usePromptStashStore(
    (state) => state.queuesByScopeKey[scopeKey] ?? EMPTY_PROMPT_STASH_QUEUE,
  );
  const otherScopesCount = usePromptStashStore((state) =>
    countOtherScopeEntries(state.queuesByScopeKey, scopeKey),
  );

  // Refs so the keyboard handler and toast Undo see the live composer state
  // without re-registering on every keystroke.
  const userInputRef = useRef(userInput);
  userInputRef.current = userInput;
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  const restoreEntry = useCallback(
    (entryId: string) => {
      // A locked/submitting composer must not accept a restore: the submit
      // path clears and restores its own input, and taking the entry without
      // landing it in the composer would lose the prompt. Read through a ref
      // so a stale `disabled` captured by the Undo toast can't slip through.
      if (disabledRef.current) {
        return;
      }
      // Take first so a double activation (click + Enter) can't restore twice.
      const entry = usePromptStashStore.getState().takeEntry(scopeKey, entryId);
      if (!entry) {
        return;
      }
      setMenuOpen(false);
      setUserInput(mergeStashRestoreText(userInputRef.current, entry.text));
      setAttachments((prev) => mergeStashRestoreAttachments(prev, entry.attachments));
      focusInput();
    },
    [focusInput, scopeKey, setAttachments, setUserInput],
  );

  const deleteEntry = useCallback(
    (entryId: string) => {
      if (disabledRef.current) {
        return;
      }
      usePromptStashStore.getState().takeEntry(scopeKey, entryId);
      // Frees the deleted entry's image blobs once nothing else references them.
      scheduleAttachmentGc();
    },
    [scopeKey],
  );

  const showRestoredToast = useCallback(() => {
    toast.show(t("composer.stash.restored"), { durationMs: 2200 });
  }, [t, toast]);

  const showStashedToast = useCallback(
    (entryId: string, evicted: PromptStashEntry | null) => {
      toast.show(
        <StashUndoToast
          entryId={entryId}
          message={evicted ? t("composer.stash.stashedEvicted") : t("composer.stash.stashed")}
          undoLabel={t("composer.stash.undo")}
          onRestore={restoreEntry}
          onRestored={showRestoredToast}
        />,
        { durationMs: 5000 },
      );
    },
    [restoreEntry, showRestoredToast, t, toast],
  );

  const stashOrToggleMenu = useCallback((): boolean => {
    if (disabledRef.current) {
      return false;
    }
    const text = userInputRef.current.trim();
    const currentAttachments = attachmentsRef.current;
    if (text.length === 0 && currentAttachments.length === 0) {
      setMenuOpen((open) => !open);
      return true;
    }
    const entry: PromptStashEntry = {
      id: `stash_${generateMessageId()}`,
      createdAt: Date.now(),
      text,
      attachments: currentAttachments,
      provider,
    };
    const { evicted } = usePromptStashStore.getState().stashEntry(entry);
    if (evicted) {
      scheduleAttachmentGc();
    }
    setUserInput("");
    setAttachments([]);
    showStashedToast(entry.id, evicted);
    return true;
  }, [provider, setAttachments, setUserInput, showStashedToast]);

  const handlerIdRef = useRef(`composer-stash:${Math.random().toString(36).slice(2)}`);
  const handleKeyboardAction = useCallback(
    (action: KeyboardActionDefinition): boolean => {
      if (action.id !== "message-input.stash") return false;
      if (!isActiveComposer) return false;
      return stashOrToggleMenu();
    },
    [isActiveComposer, stashOrToggleMenu],
  );

  useKeyboardActionHandler({
    handlerId: handlerIdRef.current,
    actions: ["message-input.stash"],
    enabled: isActiveComposer,
    priority: 200,
    handle: handleKeyboardAction,
  });

  // The picker is a transient popover, not a panel: resuming typing closes it.
  const previousInputRef = useRef(userInput);
  useEffect(() => {
    if (previousInputRef.current !== userInput) {
      previousInputRef.current = userInput;
      setMenuOpen(false);
    }
  }, [userInput]);

  useEffect(() => {
    if (disabled) {
      setMenuOpen(false);
    }
  }, [disabled]);

  const options = useMemo<ComboboxOption[]>(
    () => entries.map((entry) => ({ id: entry.id, label: stashEntrySnippet(entry, t) })),
    [entries, t],
  );

  const renderOption = useCallback(
    ({
      option,
      active,
      onPress,
    }: {
      option: ComboboxOption;
      selected: boolean;
      active: boolean;
      onPress: () => void;
    }) => {
      const entry = entries.find((candidate) => candidate.id === option.id);
      return (
        <StashMenuItem
          key={option.id}
          option={option}
          active={active}
          onPress={onPress}
          description={entry ? stashEntryDescription(entry, t) : ""}
          deleteLabel={t("composer.stash.deleteEntry")}
          onDelete={deleteEntry}
        />
      );
    },
    [deleteEntry, entries, t],
  );

  // `leading` is load-bearing, not decoration: the desktop inline header only
  // renders when a back/leading/actions/search slot is present, so a
  // title-only header would leave the popover unlabeled on web.
  const header = useMemo(
    () => ({
      title: t("composer.stash.menuTitle"),
      leading: <ThemedBookmark size={ICON_SIZE.sm} uniProps={iconMutedMapping} />,
    }),
    [t],
  );
  const footer = useMemo(
    () =>
      otherScopesCount > 0 ? (
        <Text style={styles.footerText}>
          {t("composer.stash.otherProviders", { count: otherScopesCount })}
        </Text>
      ) : undefined,
    [otherScopesCount, t],
  );

  const toggleMenu = useCallback(() => {
    setMenuOpen((open) => !open);
  }, []);

  const badgeStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.badge,
      (hovered || pressed || menuOpen) && styles.badgeActive,
    ],
    [menuOpen],
  );

  return (
    <>
      {entries.length > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("composer.stash.badgeAccessibilityLabel", {
            count: entries.length,
          })}
          onPress={toggleMenu}
          disabled={disabled}
          style={badgeStyle}
          testID="composer-stash-badge"
        >
          <ThemedBookmark size={ICON_SIZE.xs} uniProps={iconMutedMapping} />
          <Animated.View key={entries.length} entering={FadeIn.duration(180)}>
            <Text style={styles.badgeCount}>{entries.length}</Text>
          </Animated.View>
        </Pressable>
      ) : null}
      <Combobox
        options={options}
        value=""
        onSelect={restoreEntry}
        open={menuOpen}
        onOpenChange={setMenuOpen}
        anchorRef={anchorRef}
        desktopPlacement="top-start"
        desktopMinWidth={320}
        header={header}
        emptyText={t("composer.stash.menuEmpty")}
        renderOption={renderOption}
        footer={footer}
      />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  badge: {
    position: "absolute",
    top: -10,
    right: 12,
    zIndex: 20,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.popover,
    opacity: 0.85,
  },
  badgeActive: {
    opacity: 1,
  },
  badgeCount: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontVariant: ["tabular-nums"],
  },
  deleteButton: {
    width: 24,
    height: 24,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  deleteButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  footerText: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  toastRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  toastText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  toastUndo: {
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
    color: theme.colors.foreground,
    textDecorationLine: "underline",
  },
}));

const ThemedBookmark = withUnistyles(Bookmark);
const ThemedX = withUnistyles(X);
const iconMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
