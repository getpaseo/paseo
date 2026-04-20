import { useEffect, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { X } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { ChatChannel, ChatMember, ChatMessage } from "@/api/chat";
import { useThreadRepliesQuery } from "@/hooks/chat/use-chat-queries";
import { useOrgChatRoom } from "@/hooks/chat/use-org-chat-room";
import { useUploads } from "@/hooks/chat/use-upload";
import {
  selectChannelMessages,
  selectMessageReactions,
  selectTyping,
  useChatStore,
} from "@/stores/chat-store";
import { MessageBubble } from "./message-bubble";
import { MessageList } from "./message-list";
import { Composer } from "./composer";

interface ThreadPanelProps {
  parent: ChatMessage;
  channel: ChatChannel;
  members: ChatMember[];
  channels: ChatChannel[];
  sessionToken: string | null;
  currentUserId: string | null;
  chatRoom: ReturnType<typeof useOrgChatRoom>;
  onClose: () => void;
  /** When the parent screen already renders a Back/title bar (e.g. compact
   * mobile stack), pass true to avoid duplicating "Thread / #channel". */
  hideHeader?: boolean;
}

export function ThreadPanel({
  parent,
  channel,
  members,
  channels,
  sessionToken,
  currentUserId,
  chatRoom,
  onClose,
  hideHeader,
}: ThreadPanelProps) {
  const { theme } = useUnistyles();
  const repliesQuery = useThreadRepliesQuery(parent.id, sessionToken);
  const parentReactions = useChatStore(selectMessageReactions(parent.id));
  const upsertMessage = useChatStore((s) => s.upsertMessage);
  const typingByUser = useChatStore(selectTyping(channel.id));
  const uploads = useUploads({ orgId: channel.orgId, sessionToken });

  const threadTypingNames = useMemo(() => {
    return Object.values(typingByUser)
      .filter((t) => t.userId !== currentUserId && t.parentId === parent.id)
      .map((t) => t.username)
      .filter((v, i, arr) => arr.indexOf(v) === i);
  }, [typingByUser, currentUserId, parent.id]);

  // Seed the store with fetched replies so the realtime event stream and the
  // initial HTTP payload converge. After that, reading from the store is the
  // single source of truth — realtime broadcasts upsert into the same bucket.
  useEffect(() => {
    if (!repliesQuery.data) return;
    for (const m of repliesQuery.data) upsertMessage(m);
  }, [repliesQuery.data, upsertMessage]);

  // Store returns every message in the channel (both top-level and replies).
  // Filter to this thread's replies.
  const allInChannel = useChatStore(selectChannelMessages(channel.id));
  const replies = useMemo(
    () => allInChannel.filter((m) => m.parentId === parent.id),
    [allInChannel, parent.id],
  );

  const memberById = useMemo(() => {
    const map = new Map<string, ChatMember>();
    for (const m of members) map.set(m.userId, m);
    return map;
  }, [members]);
  const channelById = useMemo(() => {
    const map = new Map<string, ChatChannel>();
    for (const c of channels) map.set(c.id, c);
    return map;
  }, [channels]);

  const replyCount = replies.length;
  const disabled = chatRoom.state !== "connected";

  const toggleReaction = (messageId: string, emoji: string, op: "add" | "remove") => {
    if (op === "add") chatRoom.reactAdd({ messageId, emoji });
    else chatRoom.reactRemove({ messageId, emoji });
  };

  return (
    <View style={styles.container}>
      {hideHeader ? null : (
        <View style={styles.header}>
          <View style={styles.headerTitles}>
            <Text style={styles.title}>Thread</Text>
            <Text style={styles.subtitle} numberOfLines={1}>
              #{channel.name ?? ""}
            </Text>
          </View>
          <Pressable
            onPress={onClose}
            style={styles.closeBtn}
            accessibilityRole="button"
            accessibilityLabel="Close thread"
          >
            <X size={16} color={theme.colors.foregroundMuted} />
          </Pressable>
        </View>
      )}
      <View style={styles.parentWrap}>
        <MessageBubble
          message={parent}
          author={memberById.get(parent.userId) ?? null}
          membersById={memberById}
          channelsById={channelById}
          reactions={parentReactions}
          currentUserId={currentUserId}
          onToggleReaction={toggleReaction}
          onEdit={(messageId, content) => chatRoom.edit({ messageId, content })}
          onDelete={(messageId) => chatRoom.remove({ messageId })}
        />
        <View style={styles.replyCountRow}>
          <Text style={styles.replyCountText}>
            {replyCount === 0
              ? "No replies yet"
              : `${replyCount} ${replyCount === 1 ? "reply" : "replies"}`}
          </Text>
          <View style={styles.divider} />
        </View>
      </View>
      <MessageList
        messages={replies}
        members={members}
        channels={channels}
        currentUserId={currentUserId}
        onToggleReaction={toggleReaction}
        onEdit={(messageId, content) => chatRoom.edit({ messageId, content })}
        onDelete={(messageId) => chatRoom.remove({ messageId })}
      />
      {threadTypingNames.length > 0 ? (
        <View style={styles.typingRow}>
          <Text style={styles.typingText}>
            {threadTypingNames.join(", ")} {threadTypingNames.length === 1 ? "is" : "are"} typing…
          </Text>
        </View>
      ) : null}
      <Composer
        placeholder="Reply…"
        disabled={disabled}
        onSend={(content, attachments) => {
          chatRoom.send({
            channelId: channel.id,
            content,
            parentId: parent.id,
            attachments,
          });
          uploads.reset();
        }}
        onTyping={() => chatRoom.typing(channel.id, parent.id)}
        members={members}
        channels={channels}
        pendingUploads={uploads.pending}
        onRemoveUpload={uploads.remove}
        onPickAttachment={uploads.pickImage}
        onPickFile={uploads.pickFile}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  headerTitles: { flex: 1 },
  title: {
    fontSize: 14,
    fontWeight: "600",
    color: theme.colors.foreground,
  },
  subtitle: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
    marginTop: 2,
  },
  closeBtn: {
    padding: 6,
    borderRadius: 4,
  },
  parentWrap: {
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    paddingBottom: theme.spacing[2],
  },
  replyCountRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[1],
  },
  replyCountText: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
  },
  divider: {
    flex: 1,
    height: 1,
    backgroundColor: theme.colors.border,
  },
  typingRow: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: 4,
  },
  typingText: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
    fontStyle: "italic",
  },
}));
