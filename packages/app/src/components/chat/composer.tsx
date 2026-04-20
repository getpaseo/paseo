import { useCallback, useMemo, useRef, useState } from "react";
import {
  Pressable,
  Text,
  TextInput,
  View,
  type TextInputKeyPressEventData,
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
} from "react-native";
import {
  Bold,
  Code,
  FileUp,
  Heading1,
  Image as ImageIcon,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Paperclip,
  Quote,
  Send,
  Strikethrough,
  X,
} from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { ChatAttachment, ChatChannel, ChatMember } from "@/api/chat";
import type { PendingUpload } from "@/hooks/chat/use-upload";
import {
  detectMentionTrigger,
  filterChannelsByQuery,
  filterMembersByQuery,
  type MentionTrigger,
} from "./mentions";

interface ComposerProps {
  placeholder?: string;
  disabled?: boolean;
  onSend: (content: string, attachments?: ChatAttachment[]) => void;
  onTyping?: () => void;
  /** Members of the current channel — used to populate @ autocomplete. */
  members?: ChatMember[];
  /** All channels visible to the user in this org — used for # autocomplete. */
  channels?: ChatChannel[];
  /** Current in-flight uploads — rendered as preview chips above the input. */
  pendingUploads?: PendingUpload[];
  onRemoveUpload?: (localId: string) => void;
  onPickAttachment?: () => void;
  onPickFile?: () => void;
}

export function Composer({
  placeholder = "Message",
  disabled,
  onSend,
  onTyping,
  members = [],
  channels = [],
  pendingUploads,
  onRemoveUpload,
  onPickAttachment,
  onPickFile,
}: ComposerProps) {
  const [value, setValue] = useState("");
  const [selection, setSelection] = useState<{ start: number; end: number }>({
    start: 0,
    end: 0,
  });
  const [uploadMenuOpen, setUploadMenuOpen] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const { theme } = useUnistyles();
  const lastTypingAt = useRef(0);
  const inputRef = useRef<TextInput | null>(null);

  const readyAttachments = useMemo(
    () =>
      (pendingUploads ?? [])
        .filter((p) => p.status === "ready" && p.attachment)
        .map((p) => p.attachment!),
    [pendingUploads],
  );
  const anyPendingUploading = useMemo(
    () => (pendingUploads ?? []).some((p) => p.status === "uploading"),
    [pendingUploads],
  );

  const submit = useCallback(() => {
    const trimmed = value.trim();
    const hasContent = trimmed.length > 0;
    const hasAttachments = readyAttachments.length > 0;
    if (!hasContent && !hasAttachments) return;
    if (disabled || anyPendingUploading) return;
    onSend(trimmed, hasAttachments ? readyAttachments : undefined);
    setValue("");
    setSelection({ start: 0, end: 0 });
  }, [value, disabled, onSend, readyAttachments, anyPendingUploading]);

  const handleChange = (next: string) => {
    setValue(next);
    if (!onTyping) return;
    const now = Date.now();
    if (now - lastTypingAt.current > 2_000) {
      lastTypingAt.current = now;
      onTyping();
    }
  };

  const handleSelection = (e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
    setSelection(e.nativeEvent.selection);
  };

  const wrapSelection = useCallback(
    (prefix: string, suffix: string = prefix) => {
      const { start, end } = selection;
      const before = value.slice(0, start);
      const selected = value.slice(start, end) || "text";
      const after = value.slice(end);
      const next = `${before}${prefix}${selected}${suffix}${after}`;
      setValue(next);
      // Put caret right after the closing marker.
      const caret = before.length + prefix.length + selected.length + suffix.length;
      setSelection({ start: caret, end: caret });
    },
    [selection, value],
  );

  const prependLine = useCallback(
    (prefix: string) => {
      const { start } = selection;
      // Find the line start at or before caret.
      const lineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
      const before = value.slice(0, lineStart);
      const after = value.slice(lineStart);
      const next = `${before}${prefix}${after}`;
      setValue(next);
      const caret = start + prefix.length;
      setSelection({ start: caret, end: caret });
    },
    [selection, value],
  );

  const insertLink = useCallback(() => {
    const { start, end } = selection;
    const before = value.slice(0, start);
    const selected = value.slice(start, end) || "text";
    const after = value.slice(end);
    const next = `${before}[${selected}](url)${after}`;
    setValue(next);
    const urlStart = before.length + selected.length + 3;
    setSelection({ start: urlStart, end: urlStart + 3 });
  }, [selection, value]);

  const handleKeyPress = (e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
    const native = e.nativeEvent as TextInputKeyPressEventData & {
      shiftKey?: boolean;
      metaKey?: boolean;
      ctrlKey?: boolean;
      preventDefault?: () => void;
    };
    const modifier = native.metaKey || native.ctrlKey;
    // Enter without shift = send (web/desktop hardware keyboard).
    if (native.key === "Enter" && !native.shiftKey && !modifier) {
      native.preventDefault?.();
      submit();
      return;
    }
    if (!modifier) return;
    if (native.key === "b" || native.key === "B") {
      native.preventDefault?.();
      wrapSelection("**");
    } else if (native.key === "i" || native.key === "I") {
      native.preventDefault?.();
      wrapSelection("*");
    } else if (native.key === "e" || native.key === "E") {
      native.preventDefault?.();
      wrapSelection("`");
    }
  };

  const trigger: MentionTrigger | null = useMemo(
    () => detectMentionTrigger(value, selection.start),
    [value, selection.start],
  );

  const suggestions = useMemo(() => {
    if (!trigger) return null;
    if (trigger.kind === "@") {
      return filterMembersByQuery(members, trigger.query).map((m) => ({
        key: m.userId,
        label: `@${m.name}`,
        sub: m.email,
        token: `<@${m.userId}>`,
      }));
    }
    return filterChannelsByQuery(channels, trigger.query).map((c) => ({
      key: c.id,
      label: `#${c.name ?? ""}`,
      sub: c.topic ?? "",
      token: `<#${c.id}>`,
    }));
  }, [trigger, members, channels]);

  const acceptSuggestion = (tk: string) => {
    if (!trigger) return;
    const before = value.slice(0, trigger.startIndex);
    const after = value.slice(trigger.endIndex);
    const needsSpace = after.length === 0 || !after.startsWith(" ");
    const next = `${before}${tk}${needsSpace ? " " : ""}${after}`;
    setValue(next);
    const caret = before.length + tk.length + (needsSpace ? 1 : 0);
    setSelection({ start: caret, end: caret });
    // refocus input so the user can keep typing
    inputRef.current?.focus();
  };

  const canSend =
    (value.trim().length > 0 || readyAttachments.length > 0) && !disabled && !anyPendingUploading;

  return (
    <View style={styles.container}>
      {suggestions && suggestions.length > 0 ? (
        <View style={styles.suggestions}>
          {suggestions.map((s) => (
            <Pressable
              key={s.key}
              onPress={() => acceptSuggestion(s.token)}
              style={styles.suggestionRow}
              accessibilityRole="button"
            >
              <Text style={styles.suggestionLabel}>{s.label}</Text>
              {s.sub ? (
                <Text style={styles.suggestionSub} numberOfLines={1}>
                  {s.sub}
                </Text>
              ) : null}
            </Pressable>
          ))}
        </View>
      ) : null}

      {pendingUploads && pendingUploads.length > 0 ? (
        <View style={styles.uploadsRow}>
          {pendingUploads.map((p) => (
            <View
              key={p.localId}
              style={[styles.uploadChip, p.status === "error" && styles.uploadChipError]}
            >
              <Text style={styles.uploadName} numberOfLines={1}>
                {p.filename}
              </Text>
              <Text style={styles.uploadStatus}>
                {p.status === "uploading"
                  ? "Uploading…"
                  : p.status === "error"
                    ? (p.error ?? "Failed")
                    : "Ready"}
              </Text>
              {onRemoveUpload ? (
                <Pressable
                  onPress={() => onRemoveUpload(p.localId)}
                  style={styles.uploadRemove}
                  accessibilityRole="button"
                  accessibilityLabel="Remove attachment"
                >
                  <X size={12} color={theme.colors.foregroundMuted} />
                </Pressable>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}

      <View style={styles.toolbarRow}>
        <ToolbarBtn onPress={() => wrapSelection("**")} label="Bold">
          <Bold size={14} color={theme.colors.foregroundMuted} />
        </ToolbarBtn>
        <ToolbarBtn onPress={() => wrapSelection("*")} label="Italic">
          <Italic size={14} color={theme.colors.foregroundMuted} />
        </ToolbarBtn>
        <ToolbarBtn onPress={() => wrapSelection("~~")} label="Strikethrough">
          <Strikethrough size={14} color={theme.colors.foregroundMuted} />
        </ToolbarBtn>
        <View style={styles.divider} />
        <ToolbarBtn onPress={insertLink} label="Link">
          <LinkIcon size={14} color={theme.colors.foregroundMuted} />
        </ToolbarBtn>
        <ToolbarBtn onPress={() => wrapSelection("`")} label="Code">
          <Code size={14} color={theme.colors.foregroundMuted} />
        </ToolbarBtn>
        <ToolbarBtn onPress={() => prependLine("> ")} label="Quote">
          <Quote size={14} color={theme.colors.foregroundMuted} />
        </ToolbarBtn>
        <ToolbarBtn onPress={() => prependLine("# ")} label="Heading">
          <Heading1 size={14} color={theme.colors.foregroundMuted} />
        </ToolbarBtn>
        <View style={styles.divider} />
        <ToolbarBtn onPress={() => prependLine("- ")} label="Bulleted list">
          <List size={14} color={theme.colors.foregroundMuted} />
        </ToolbarBtn>
        <ToolbarBtn onPress={() => prependLine("1. ")} label="Numbered list">
          <ListOrdered size={14} color={theme.colors.foregroundMuted} />
        </ToolbarBtn>
        {onPickAttachment || onPickFile ? (
          <>
            <View style={styles.divider} />
            <View style={styles.uploadMenuWrap}>
              <ToolbarBtn onPress={() => setUploadMenuOpen((p) => !p)} label="Attach">
                <Paperclip size={14} color={theme.colors.foregroundMuted} />
              </ToolbarBtn>
              {uploadMenuOpen ? (
                <>
                  <Pressable
                    onPress={() => setUploadMenuOpen(false)}
                    style={styles.uploadMenuBackdrop}
                  />
                  <View style={styles.uploadMenu}>
                    {onPickAttachment ? (
                      <Pressable
                        onPress={() => {
                          setUploadMenuOpen(false);
                          onPickAttachment();
                        }}
                        style={styles.uploadMenuItem}
                        accessibilityRole="button"
                      >
                        <ImageIcon size={14} color={theme.colors.foregroundMuted} />
                        <Text style={styles.uploadMenuLabel}>Image or video</Text>
                      </Pressable>
                    ) : null}
                    {onPickFile ? (
                      <Pressable
                        onPress={() => {
                          setUploadMenuOpen(false);
                          onPickFile();
                        }}
                        style={styles.uploadMenuItem}
                        accessibilityRole="button"
                      >
                        <FileUp size={14} color={theme.colors.foregroundMuted} />
                        <Text style={styles.uploadMenuLabel}>File</Text>
                      </Pressable>
                    ) : null}
                  </View>
                </>
              ) : null}
            </View>
          </>
        ) : null}
      </View>

      <View style={styles.inputRow}>
        <TextInput
          ref={inputRef}
          value={value}
          onChangeText={handleChange}
          onSelectionChange={handleSelection}
          selection={selection}
          placeholder={placeholder}
          placeholderTextColor={theme.colors.foregroundMuted}
          style={[styles.input, inputFocused && styles.inputFocused]}
          multiline
          editable={!disabled}
          onKeyPress={handleKeyPress}
          onFocus={() => setInputFocused(true)}
          onBlur={() => setInputFocused(false)}
        />
        <Pressable
          onPress={submit}
          disabled={!canSend}
          style={[styles.sendBtn, !canSend && styles.sendBtnDisabled]}
          accessibilityRole="button"
          accessibilityLabel="Send message"
        >
          <Send
            size={14}
            color={canSend ? "#ffffff" : theme.colors.foregroundMuted}
            strokeWidth={2}
          />
        </Pressable>
      </View>
    </View>
  );
}

function ToolbarBtn({
  children,
  onPress,
  label,
}: {
  children: React.ReactNode;
  onPress: () => void;
  label: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={styles.toolbarBtn}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  toolbarRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[2],
    paddingTop: 6,
    paddingBottom: 2,
    gap: 2,
  },
  toolbarBtn: {
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 4,
  },
  divider: {
    width: 1,
    height: 16,
    marginHorizontal: 4,
    backgroundColor: theme.colors.border,
  },
  uploadMenuWrap: {
    position: "relative",
  },
  uploadMenuBackdrop: {
    position: "absolute",
    top: -1000,
    left: -1000,
    right: -1000,
    bottom: -1000,
    zIndex: 9,
  },
  uploadMenu: {
    position: "absolute",
    bottom: "100%",
    left: 0,
    marginBottom: 6,
    minWidth: 180,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: theme.colors.surface0,
    borderWidth: 1,
    borderColor: theme.colors.border,
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    zIndex: 10,
  },
  uploadMenuItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  uploadMenuLabel: {
    fontSize: 13,
    color: theme.colors.foreground,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 0,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  input: {
    flex: 1,
    minHeight: 38,
    maxHeight: 140,
    paddingLeft: theme.spacing[3],
    paddingRight: 48,
    paddingVertical: 9,
    borderTopLeftRadius: 8,
    borderBottomLeftRadius: 8,
    borderTopRightRadius: 8,
    borderBottomRightRadius: 8,
    backgroundColor: theme.colors.surface1,
    color: theme.colors.foreground,
    fontSize: 14,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  inputFocused: {
    borderColor: theme.colors.brandMagenta,
  },
  // Send button sits over the right edge of the input (absolute), so the
  // input + send read as a single surface instead of two disconnected rectangles.
  sendBtn: {
    position: "absolute",
    right: theme.spacing[3] + 6,
    bottom: theme.spacing[2] + 5,
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
    backgroundColor: theme.colors.brandMagenta,
  },
  sendBtnDisabled: {
    backgroundColor: "transparent",
    opacity: 0.55,
  },
  suggestions: {
    maxHeight: 220,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  suggestionRow: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: 8,
  },
  suggestionLabel: {
    fontSize: 14,
    color: theme.colors.foreground,
    fontWeight: "500",
  },
  suggestionSub: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
    marginTop: 2,
  },
  uploadsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[1],
  },
  uploadChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingLeft: 8,
    paddingRight: 4,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    maxWidth: 240,
  },
  uploadChipError: {
    borderColor: "#e57373",
  },
  uploadName: {
    fontSize: 12,
    color: theme.colors.foreground,
    fontWeight: "500",
    flexShrink: 1,
  },
  uploadStatus: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
    fontStyle: "italic",
  },
  uploadRemove: {
    padding: 2,
    borderRadius: 3,
  },
}));
