import { memo, useMemo, useState } from "react";
import {
  type GestureResponderEvent,
  Image,
  Linking,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import Markdown from "react-native-markdown-display";
import {
  FileIcon,
  MessageSquare,
  Pencil,
  Pin,
  SmilePlus,
  Trash2,
} from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type {
  ChatChannel,
  ChatMember,
  ChatMessage,
  ChatReactionGroup,
} from "@/api/chat";
import { isNative, isWeb } from "@/constants/platform";
import { Avatar } from "./avatar";
import { ChatEmojiPicker } from "./emoji-picker.web";
import type { EmojiPickerAnchor } from "./emoji-picker";
import { preprocessMarkdown } from "./mentions";
import { ReactionsRow } from "./reactions-row";

// Inject a Slack-style hover stylesheet once. We use a real CSS :hover rule
// instead of React state so there is zero re-render and zero flicker: moving
// the cursor between the message body and the floating toolbar stays inside
// the same hovered element from the browser's perspective.
if (isWeb && typeof document !== "undefined") {
  const ID = "hubcode-chat-msg-hover";
  if (!document.getElementById(ID)) {
    const el = document.createElement("style");
    el.id = ID;
    el.textContent = `
[data-hubcode-row] [data-hubcode-toolbar] { opacity: 0 !important; pointer-events: none !important; transition: opacity 80ms ease-out; }
[data-hubcode-row]:hover [data-hubcode-toolbar] { opacity: 1 !important; pointer-events: auto !important; }
[data-hubcode-row]:hover { background-color: rgba(255,255,255,0.04); }
[data-hubcode-thread]:hover { background-color: rgba(255,255,255,0.06) !important; border-color: rgba(255,255,255,0.12) !important; }
[data-hubcode-thread] [data-hubcode-thread-cta] { display: none !important; }
[data-hubcode-thread]:hover [data-hubcode-thread-cta] { display: inline !important; }
[data-hubcode-thread]:hover [data-hubcode-thread-count]::after { content: " ·"; }
`;
    document.head.appendChild(el);
  }
}

interface MessageBubbleProps {
  message: ChatMessage;
  author?: ChatMember | null;
  membersById: Map<string, ChatMember>;
  channelsById: Map<string, ChatChannel>;
  reactions: readonly ChatReactionGroup[];
  currentUserId: string | null;
  onOpenThread?: (message: ChatMessage) => void;
  onToggleReaction?: (messageId: string, emoji: string, op: "add" | "remove") => void;
  onDelete?: (messageId: string) => void;
  onTogglePin?: (messageId: string, nextPinned: boolean) => void;
  onEdit?: (messageId: string, content: string) => void;
  pinned?: boolean;
  replyCount?: number;
  highlighted?: boolean;
  online?: boolean;
}

export const MessageBubble = memo(function MessageBubble({
  message,
  author,
  membersById,
  channelsById,
  reactions,
  currentUserId,
  onOpenThread,
  onToggleReaction,
  onDelete,
  onTogglePin,
  onEdit,
  pinned,
  replyCount = 0,
  highlighted,
  online,
}: MessageBubbleProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerAnchor, setPickerAnchor] = useState<EmojiPickerAnchor | null>(null);
  const { theme } = useUnistyles();
  const displayName = author?.name ?? message.userId.slice(0, 8);
  const timeLabel = useMemo(() => formatTime(message.createdAt), [message.createdAt]);
  const isDeleted = message.deletedAt !== null;
  const isAuthor = currentUserId === message.userId;

  const markdown = useMemo(
    () => preprocessMarkdown(message.content, { membersById, channelsById }),
    [message.content, membersById, channelsById],
  );

  const markdownStyles = useMemo(() => buildMarkdownStyles(theme), [theme]);

  const startEdit = () => {
    setDraft(message.content);
    setEditing(true);
  };
  const cancelEdit = () => {
    setEditing(false);
    setDraft(message.content);
  };
  const openEmojiPicker = (e: GestureResponderEvent) => {
    const ne = e.nativeEvent as unknown as {
      clientX?: number;
      clientY?: number;
      pageX?: number;
      pageY?: number;
    };
    const x = typeof ne.clientX === "number" ? ne.clientX : ne.pageX ?? null;
    const y = typeof ne.clientY === "number" ? ne.clientY : ne.pageY ?? null;
    if (x !== null && y !== null) {
      setPickerAnchor({ x: x - 10, y: y - 10, width: 20, height: 20 });
    } else {
      setPickerAnchor(null);
    }
    setPickerOpen(true);
  };

  const saveEdit = () => {
    const next = draft.trim();
    if (!next || next === message.content) {
      setEditing(false);
      return;
    }
    onEdit?.(message.id, next);
    setEditing(false);
  };

  const hasAnyAction =
    !isDeleted &&
    !!(
      onToggleReaction ||
      onOpenThread ||
      onTogglePin ||
      (isAuthor && onEdit) ||
      (isAuthor && onDelete)
    );

  const rowWebProps = (isWeb
    ? { dataSet: { hubcodeRow: "1" } }
    : {}) as object;
  const toolbarWebProps = (isWeb
    ? { dataSet: { hubcodeToolbar: "1" } }
    : {}) as object;
  const threadWebProps = (isWeb
    ? { dataSet: { hubcodeThread: "1" } }
    : {}) as object;
  const threadCountWebProps = (isWeb
    ? { dataSet: { hubcodeThreadCount: "1" } }
    : {}) as object;
  const threadCtaWebProps = (isWeb
    ? { dataSet: { hubcodeThreadCta: "1" } }
    : {}) as object;

  return (
    <View
      {...rowWebProps}
      style={[styles.row, highlighted && styles.rowHighlighted]}
    >
      <Avatar
        name={author?.name ?? displayName}
        imageUrl={author?.image ?? null}
        size={36}
        online={online}
      />
      <View style={styles.body}>
        {pinned ? (
          <View style={styles.pinnedRow}>
            <Pin size={10} color={theme.colors.brandMagenta} />
            <Text style={styles.pinnedText}>Pinned</Text>
          </View>
        ) : null}
        <View style={styles.header}>
          <Text style={styles.author}>{displayName}</Text>
          <Text style={styles.time}>{timeLabel}</Text>
          {message.editedAt && !isDeleted ? (
            <Text style={styles.edited}>(edited)</Text>
          ) : null}
        </View>
        {isDeleted ? (
          <Text style={styles.deleted}>This message was deleted</Text>
        ) : editing ? (
          <View style={styles.editWrap}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              multiline
              autoFocus
              style={styles.editInput}
              onKeyPress={(e) => {
                const ne = e.nativeEvent as {
                  key?: string;
                  shiftKey?: boolean;
                  metaKey?: boolean;
                  preventDefault?: () => void;
                };
                if (ne.key === "Escape") {
                  cancelEdit();
                  return;
                }
                if (ne.key === "Enter" && !ne.shiftKey && !ne.metaKey) {
                  ne.preventDefault?.();
                  saveEdit();
                }
              }}
            />
            <View style={styles.editActions}>
              <Pressable onPress={cancelEdit} style={styles.editCancel}>
                <Text style={styles.editCancelText}>Cancel</Text>
              </Pressable>
              <Pressable onPress={saveEdit} style={styles.editSave}>
                <Text style={styles.editSaveText}>Save</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <>
            {markdown.trim().length > 0 ? (
              <Markdown style={markdownStyles}>{markdown}</Markdown>
            ) : null}
            {message.attachments.length > 0 ? (
              <View style={styles.attachmentsWrap}>
                {message.attachments.map((a) => (
                  <AttachmentView key={a.id} attachment={a} />
                ))}
              </View>
            ) : null}
          </>
        )}
        {!isDeleted && onToggleReaction ? (
          <ReactionsRow
            reactions={reactions}
            currentUserId={currentUserId}
            onToggleReaction={(emoji, op) =>
              onToggleReaction(message.id, emoji, op)
            }
            onOpenPicker={openEmojiPicker}
          />
        ) : null}
        {!isDeleted && replyCount > 0 && onOpenThread ? (
          <Pressable
            {...threadWebProps}
            onPress={() => onOpenThread(message)}
            style={styles.threadChip}
            accessibilityRole="button"
            accessibilityLabel={`Open thread, ${replyCount} ${
              replyCount === 1 ? "reply" : "replies"
            }`}
          >
            <MessageSquare size={14} color={theme.colors.brandMagenta} />
            <Text {...threadCountWebProps} style={styles.threadChipText}>
              {replyCount} {replyCount === 1 ? "reply" : "replies"}
            </Text>
            <Text {...threadCtaWebProps} style={styles.threadChipCta}>
              View thread
            </Text>
          </Pressable>
        ) : null}
      </View>
      {hasAnyAction ? (
        <View {...toolbarWebProps} style={styles.toolbar}>
          {onToggleReaction ? (
            <Pressable
              onPress={openEmojiPicker}
              style={styles.toolbarBtn}
              accessibilityLabel="Add reaction"
              accessibilityRole="button"
            >
              <SmilePlus size={15} color={theme.colors.foregroundMuted} />
            </Pressable>
          ) : null}
          {onOpenThread ? (
            <Pressable
              onPress={() => onOpenThread(message)}
              style={styles.toolbarBtn}
              accessibilityLabel="Reply in thread"
              accessibilityRole="button"
            >
              <MessageSquare size={15} color={theme.colors.foregroundMuted} />
            </Pressable>
          ) : null}
          {onTogglePin ? (
            <Pressable
              onPress={() => onTogglePin(message.id, !pinned)}
              style={styles.toolbarBtn}
              accessibilityLabel={pinned ? "Unpin message" : "Pin message"}
              accessibilityRole="button"
            >
              <Pin
                size={15}
                color={pinned ? theme.colors.brandMagenta : theme.colors.foregroundMuted}
              />
            </Pressable>
          ) : null}
          {isAuthor && onEdit ? (
            <Pressable
              onPress={startEdit}
              style={styles.toolbarBtn}
              accessibilityLabel="Edit message"
              accessibilityRole="button"
            >
              <Pencil size={15} color={theme.colors.foregroundMuted} />
            </Pressable>
          ) : null}
          {isAuthor && onDelete ? (
            <Pressable
              onPress={() => onDelete(message.id)}
              style={styles.toolbarBtn}
              accessibilityLabel="Delete message"
              accessibilityRole="button"
            >
              <Trash2 size={15} color={theme.colors.foregroundMuted} />
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {onToggleReaction ? (
        <ChatEmojiPicker
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          onEmojiSelected={(emoji) => {
            onToggleReaction(message.id, emoji, "add");
            setPickerOpen(false);
          }}
          anchor={pickerAnchor}
        />
      ) : null}
    </View>
  );
});

function AttachmentView({
  attachment,
}: {
  attachment: ChatMessage["attachments"][number];
}) {
  const isImage = attachment.mimeType.startsWith("image/");
  const isVideo = attachment.mimeType.startsWith("video/");

  if (isImage) {
    return (
      <Pressable
        onPress={() => void Linking.openURL(attachment.url)}
        accessibilityRole="imagebutton"
        accessibilityLabel={attachment.filename}
      >
        <Image
          source={{ uri: attachment.url }}
          style={[
            styles.attachmentImage,
            attachment.width && attachment.height
              ? { aspectRatio: attachment.width / attachment.height }
              : null,
          ]}
          resizeMode="cover"
        />
      </Pressable>
    );
  }
  if (isVideo) {
    return (
      <Pressable
        onPress={() => void Linking.openURL(attachment.url)}
        style={styles.attachmentFileChip}
        accessibilityRole="button"
        accessibilityLabel={attachment.filename}
      >
        <FileIcon size={14} />
        <Text style={styles.attachmentFilename} numberOfLines={1}>
          🎬 {attachment.filename}
        </Text>
        <Text style={styles.attachmentSize}>{formatBytes(attachment.sizeBytes)}</Text>
      </Pressable>
    );
  }
  return (
    <Pressable
      onPress={() => void Linking.openURL(attachment.url)}
      style={styles.attachmentFileChip}
      accessibilityRole="button"
      accessibilityLabel={attachment.filename}
    >
      <FileIcon size={14} />
      <Text style={styles.attachmentFilename} numberOfLines={1}>
        {attachment.filename}
      </Text>
      <Text style={styles.attachmentSize}>{formatBytes(attachment.sizeBytes)}</Text>
    </Pressable>
  );
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function buildMarkdownStyles(theme: {
  colors: {
    foreground: string;
    foregroundMuted: string;
    surface1: string;
    primary: string;
    border: string;
  };
}): Record<string, object> {
  return {
    body: { color: theme.colors.foreground, fontSize: 14, lineHeight: 20 },
    paragraph: { marginTop: 0, marginBottom: 4, color: theme.colors.foreground },
    strong: { fontWeight: "600", color: theme.colors.foreground },
    em: { fontStyle: "italic" },
    link: { color: theme.colors.primary, textDecorationLine: "underline" },
    code_inline: {
      fontFamily: isNative ? "Menlo" : "Menlo, monospace",
      backgroundColor: theme.colors.surface1,
      color: theme.colors.foreground,
      paddingHorizontal: 4,
      paddingVertical: 1,
      borderRadius: 3,
      fontSize: 13,
    },
    code_block: {
      fontFamily: isNative ? "Menlo" : "Menlo, monospace",
      backgroundColor: theme.colors.surface1,
      color: theme.colors.foreground,
      padding: 8,
      borderRadius: 4,
      fontSize: 13,
    },
    fence: {
      fontFamily: isNative ? "Menlo" : "Menlo, monospace",
      backgroundColor: theme.colors.surface1,
      color: theme.colors.foreground,
      padding: 8,
      borderRadius: 4,
      fontSize: 13,
      marginVertical: 4,
    },
    bullet_list: { marginVertical: 4 },
    ordered_list: { marginVertical: 4 },
    list_item: { marginVertical: 2 },
    blockquote: {
      borderLeftWidth: 3,
      borderLeftColor: theme.colors.border,
      paddingLeft: 8,
      color: theme.colors.foregroundMuted,
    },
    hr: { backgroundColor: theme.colors.border, height: 1, marginVertical: 8 },
    table: {
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 4,
      marginVertical: 6,
      overflow: "hidden",
    },
    thead: {
      backgroundColor: theme.colors.surface1,
    },
    tbody: {},
    th: {
      paddingHorizontal: 8,
      paddingVertical: 6,
      borderRightWidth: 1,
      borderRightColor: theme.colors.border,
    },
    tr: {
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
      flexDirection: "row",
    },
    td: {
      paddingHorizontal: 8,
      paddingVertical: 6,
      borderRightWidth: 1,
      borderRightColor: theme.colors.border,
      flex: 1,
    },
  };
}

const styles = StyleSheet.create((theme) => ({
  row: {
    position: "relative",
    flexDirection: "row",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  rowHighlighted: {
    backgroundColor: theme.colors.surface1,
  },
  toolbar: {
    position: "absolute",
    top: -14,
    right: theme.spacing[3],
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    paddingHorizontal: 4,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: theme.colors.surface0,
    borderWidth: 1,
    borderColor: theme.colors.border,
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    zIndex: 10,
  },
  toolbarBtn: {
    paddingHorizontal: 5,
    paddingVertical: 4,
    borderRadius: 4,
  },
  body: {
    flex: 1,
    gap: 2,
  },
  header: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: theme.spacing[2],
  },
  author: {
    fontSize: 14,
    fontWeight: "600",
    color: theme.colors.foreground,
  },
  time: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
  },
  edited: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
    fontStyle: "italic",
  },
  deleted: {
    fontSize: 13,
    color: theme.colors.foregroundMuted,
    fontStyle: "italic",
  },
  threadChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    paddingHorizontal: 6,
    paddingVertical: 3,
    marginTop: 2,
    borderRadius: 6,
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: "transparent",
  },
  threadChipText: {
    fontSize: 13,
    fontWeight: "700",
    color: theme.colors.brandMagenta,
  },
  threadChipCta: {
    fontSize: 12,
    fontWeight: "500",
    color: theme.colors.foregroundMuted,
  },
  pinnedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    marginBottom: 2,
  },
  pinnedText: {
    fontSize: 10,
    color: theme.colors.brandMagenta,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  editWrap: {
    gap: 6,
  },
  editInput: {
    minHeight: 40,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: 6,
    backgroundColor: theme.colors.surface1,
    color: theme.colors.foreground,
    fontSize: 14,
    borderWidth: 1,
    borderColor: theme.colors.brandMagenta,
  },
  editActions: {
    flexDirection: "row",
    gap: 6,
    justifyContent: "flex-end",
  },
  editCancel: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 4,
  },
  editCancelText: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
  },
  editSave: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 4,
    backgroundColor: theme.colors.brandMagenta,
  },
  editSaveText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#ffffff",
  },
  attachmentsWrap: {
    flexDirection: "column",
    gap: 6,
    marginTop: 4,
  },
  attachmentImage: {
    width: 280,
    maxWidth: "100%",
    maxHeight: 360,
    borderRadius: 6,
    backgroundColor: theme.colors.surface1,
  },
  attachmentFileChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 6,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignSelf: "flex-start",
    maxWidth: 320,
  },
  attachmentFilename: {
    fontSize: 13,
    color: theme.colors.foreground,
    fontWeight: "500",
    flexShrink: 1,
  },
  attachmentSize: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
  },
}));
