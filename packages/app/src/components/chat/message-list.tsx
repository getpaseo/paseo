import { useCallback, useMemo, useRef } from "react";
import { ActivityIndicator, FlatList, Text, View, type ListRenderItem } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ChatChannel, ChatMember, ChatMessage } from "@/api/chat";
import { selectMessageReactions, useChatStore, type ChatPresence } from "@/stores/chat-store";
import { MessageBubble } from "./message-bubble";

interface MessageListProps {
  messages: readonly ChatMessage[];
  members: ChatMember[];
  /**
   * Optional fallback pool of authors — typically the org-wide members list.
   * Used when a message's author isn't in `members` (e.g. public channel posts
   * from an org member who hasn't joined the channel explicitly, or a message
   * arriving via realtime before `members` has refetched).
   */
  fallbackAuthors?: ChatMember[];
  channels: ChatChannel[];
  currentUserId: string | null;
  presenceByUser?: Record<string, ChatPresence>;
  pinnedMessageIds?: ReadonlySet<string>;
  replyCountsByParent?: Readonly<Record<string, number>>;
  replyAuthorsByParent?: Readonly<Record<string, readonly string[]>>;
  highlightedMessageId?: string | null;
  onLoadMore?: () => void;
  isLoadingMore?: boolean;
  hasMore?: boolean;
  onOpenThread?: (message: ChatMessage) => void;
  onReply?: (message: ChatMessage) => void;
  onToggleReaction?: (messageId: string, emoji: string, op: "add" | "remove") => void;
  onTogglePin?: (messageId: string, nextPinned: boolean) => void;
  onEdit?: (messageId: string, content: string) => void;
  onDelete?: (messageId: string) => void;
}

export function MessageList({
  messages,
  members,
  fallbackAuthors,
  channels,
  currentUserId,
  presenceByUser,
  pinnedMessageIds,
  replyCountsByParent,
  replyAuthorsByParent,
  highlightedMessageId,
  onLoadMore,
  isLoadingMore,
  hasMore,
  onOpenThread,
  onReply,
  onToggleReaction,
  onTogglePin,
  onEdit,
  onDelete,
}: MessageListProps) {
  const memberById = useMemo(() => {
    const map = new Map<string, ChatMember>();
    // Fill from fallback first so channel members win on conflict.
    if (fallbackAuthors) {
      for (const m of fallbackAuthors) map.set(m.userId, m);
    }
    for (const m of members) map.set(m.userId, m);
    return map;
  }, [members, fallbackAuthors]);

  const channelById = useMemo(() => {
    const map = new Map<string, ChatChannel>();
    for (const c of channels) map.set(c.id, c);
    return map;
  }, [channels]);

  const inverted = useMemo(() => [...messages].reverse(), [messages]);

  const renderItem: ListRenderItem<ChatMessage> = useCallback(
    ({ item }) => (
      <MessageBubbleBridge
        message={item}
        author={memberById.get(item.userId) ?? null}
        membersById={memberById}
        channelsById={channelById}
        currentUserId={currentUserId}
        online={!!presenceByUser?.[item.userId]}
        pinned={pinnedMessageIds?.has(item.id) ?? false}
        replyCount={replyCountsByParent?.[item.id] ?? 0}
        replyAuthorIds={replyAuthorsByParent?.[item.id]}
        highlighted={highlightedMessageId === item.id}
        onOpenThread={onOpenThread}
        onReply={onReply}
        onToggleReaction={onToggleReaction}
        onTogglePin={onTogglePin}
        onEdit={onEdit}
        onDelete={onDelete}
      />
    ),
    [
      memberById,
      channelById,
      currentUserId,
      presenceByUser,
      pinnedMessageIds,
      replyCountsByParent,
      replyAuthorsByParent,
      highlightedMessageId,
      onOpenThread,
      onReply,
      onToggleReaction,
      onTogglePin,
      onEdit,
      onDelete,
    ],
  );

  const endReachedCalled = useRef(false);
  const handleEndReached = useCallback(() => {
    if (endReachedCalled.current) return;
    endReachedCalled.current = true;
    onLoadMore?.();
    setTimeout(() => {
      endReachedCalled.current = false;
    }, 500);
  }, [onLoadMore]);

  return (
    <View style={styles.container}>
      <FlatList
        data={inverted}
        keyExtractor={(m: ChatMessage) => m.id}
        renderItem={renderItem}
        inverted
        onEndReached={handleEndReached}
        onEndReachedThreshold={0.6}
        removeClippedSubviews
        windowSize={11}
        initialNumToRender={30}
        ListFooterComponent={
          isLoadingMore ? (
            <View style={styles.loadMoreRow}>
              <ActivityIndicator size="small" />
              <Text style={styles.loadMoreText}>Loading older messages…</Text>
            </View>
          ) : hasMore === false && inverted.length > 0 ? (
            <View style={styles.loadMoreRow}>
              <Text style={styles.beginningText}>— beginning of conversation —</Text>
            </View>
          ) : null
        }
      />
    </View>
  );
}

/**
 * Small wrapper so each row can subscribe to only its own reactions slice
 * without causing the whole list to re-render when one message reacts.
 */
function MessageBubbleBridge({
  message,
  author,
  membersById,
  channelsById,
  currentUserId,
  online,
  pinned,
  replyCount,
  replyAuthorIds,
  highlighted,
  onOpenThread,
  onReply,
  onToggleReaction,
  onTogglePin,
  onEdit,
  onDelete,
}: {
  message: ChatMessage;
  author: ChatMember | null;
  membersById: Map<string, ChatMember>;
  channelsById: Map<string, ChatChannel>;
  currentUserId: string | null;
  online?: boolean;
  pinned?: boolean;
  replyCount?: number;
  replyAuthorIds?: readonly string[];
  highlighted?: boolean;
  onOpenThread?: (message: ChatMessage) => void;
  onReply?: (message: ChatMessage) => void;
  onToggleReaction?: (messageId: string, emoji: string, op: "add" | "remove") => void;
  onTogglePin?: (messageId: string, nextPinned: boolean) => void;
  onEdit?: (messageId: string, content: string) => void;
  onDelete?: (messageId: string) => void;
}) {
  const reactions = useChatStore(selectMessageReactions(message.id));
  return (
    <MessageBubble
      message={message}
      author={author}
      membersById={membersById}
      channelsById={channelsById}
      reactions={reactions}
      currentUserId={currentUserId}
      online={online}
      pinned={pinned}
      replyCount={replyCount}
      replyAuthorIds={replyAuthorIds}
      highlighted={highlighted}
      onOpenThread={onOpenThread}
      onReply={onReply}
      onToggleReaction={onToggleReaction}
      onTogglePin={onTogglePin}
      onEdit={onEdit}
      onDelete={onDelete}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  loadMoreRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
  },
  loadMoreText: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
  },
  beginningText: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
    opacity: 0.6,
  },
}));
