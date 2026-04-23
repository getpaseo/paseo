import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { FlaskConical, Hash, Lock, PanelLeft, Pin, User } from "lucide-react-native";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { ChatMessage, ChatChannel } from "@/api/chat";
import {
  useChannelMembersQuery,
  useChannelMessages,
  useChannelsQuery,
  usePinMutation,
  usePinsQuery,
  useUnpinMutation,
} from "@/hooks/chat/use-chat-queries";
import { useOrgMembersQuery } from "@/hooks/chat/use-org-members";
import {
  useChatStore,
  selectChannelMessages,
  selectOrgPresence,
  selectTyping,
} from "@/stores/chat-store";
import { useOrgChatRoom } from "@/hooks/chat/use-org-chat-room";
import { useUploads } from "@/hooks/chat/use-upload";
import { MessageList } from "./message-list";
import { Composer } from "./composer";
import { ChannelHeaderMembers } from "./channel-header-members";
import { ChannelMembersModal } from "./channel-members-modal";
import { PinsModal } from "./pins-modal";
import { applySlashCommand } from "./slash-commands";

interface ChannelMessagesProps {
  channel: ChatChannel;
  sessionToken: string | null;
  currentUserId: string | null;
  chatRoom: ReturnType<typeof useOrgChatRoom>;
  onOpenThread: (parent: ChatMessage) => void;
  highlightedMessageId?: string | null;
  /** Wide-layout only: whether the channels/DMs pane is currently visible. */
  channelsPaneOpen?: boolean;
  onToggleChannelsPane?: () => void;
}

export function ChannelMessages({
  channel,
  sessionToken,
  currentUserId,
  chatRoom,
  onOpenThread,
  highlightedMessageId,
  channelsPaneOpen,
  onToggleChannelsPane,
}: ChannelMessagesProps) {
  const { theme } = useUnistyles();
  const messagesQuery = useChannelMessages(channel.id, sessionToken);
  const membersQuery = useChannelMembersQuery(channel.id, sessionToken);
  const orgMembersQuery = useOrgMembersQuery(channel.orgId, sessionToken);
  const allChannelsQuery = useChannelsQuery(channel.orgId, sessionToken);
  // Derive an author fallback from org members so public-channel posts from
  // users who aren't explicit channel members still render with name + avatar
  // instead of the skeleton placeholder.
  const orgMemberFallback = useMemo(() => {
    const list = orgMembersQuery.data ?? [];
    return list
      .filter((m) => m.user !== null)
      .map((m) => ({
        userId: m.userId,
        role: m.role === "admin" ? ("admin" as const) : ("member" as const),
        joinedAt: m.createdAt,
        name: m.user?.name ?? "",
        email: m.user?.email ?? "",
        image: m.user?.image ?? null,
      }));
  }, [orgMembersQuery.data]);
  const allMessages = useChatStore(selectChannelMessages(channel.id));
  const messages = useMemo(() => allMessages.filter((m) => m.parentId === null), [allMessages]);
  const replyCountsByParent = useMemo(() => {
    const counts: Record<string, number> = {};
    // Seed from server-provided replyCount on each parent message so the
    // chip shows up before the thread is ever opened.
    for (const m of allMessages) {
      if (m.parentId === null && m.replyCount && m.replyCount > 0) {
        counts[m.id] = m.replyCount;
      }
    }
    // Override with locally-known reply count (authoritative once replies
    // have been loaded into the store — keeps up with realtime events).
    const local: Record<string, number> = {};
    for (const m of allMessages) {
      if (m.parentId && !m.deletedAt) {
        local[m.parentId] = (local[m.parentId] ?? 0) + 1;
      }
    }
    for (const [pid, n] of Object.entries(local)) {
      counts[pid] = Math.max(counts[pid] ?? 0, n);
    }
    return counts;
  }, [allMessages]);
  // Distinct replier userIds per parent — used to render a Slack-style avatar
  // stack on the reply chip. Seed from the server-provided `replyUserIds` on
  // each parent so the stack shows up before the thread is ever opened, then
  // let locally-loaded replies override (authoritative once the thread loads).
  const replyAuthorsByParent = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const m of allMessages) {
      if (m.parentId === null && m.replyUserIds && m.replyUserIds.length > 0) {
        out[m.id] = [...m.replyUserIds];
      }
    }
    const seenByParent = new Map<string, Set<string>>();
    for (const m of allMessages) {
      if (!m.parentId || m.deletedAt) continue;
      let seen = seenByParent.get(m.parentId);
      if (!seen) {
        seen = new Set<string>();
        seenByParent.set(m.parentId, seen);
      }
      if (!seen.has(m.userId)) {
        seen.add(m.userId);
      }
    }
    for (const [pid, set] of seenByParent) {
      if (set.size === 0) continue;
      out[pid] = Array.from(set);
    }
    return out;
  }, [allMessages]);
  const typingByUser = useChatStore(selectTyping(channel.id));
  const presenceByUser = useChatStore(selectOrgPresence(channel.orgId));

  const [membersOpen, setMembersOpen] = useState(false);
  const [pinsOpen, setPinsOpen] = useState(false);
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const uploads = useUploads({ orgId: channel.orgId, sessionToken });
  const pinsQuery = usePinsQuery(channel.id, sessionToken);
  const pinMutation = usePinMutation(sessionToken);
  const unpinMutation = useUnpinMutation(sessionToken);
  const pinnedIds = useMemo(
    () => new Set((pinsQuery.data ?? []).map((p) => p.messageId)),
    [pinsQuery.data],
  );

  const Icon = channel.kind === "private" ? Lock : channel.kind === "dm" ? User : Hash;
  const dmPeerName = useMemo(() => {
    if (channel.kind !== "dm") return null;
    const peerIds = channel.dmPeerUserIds ?? [];
    if (peerIds.length === 0) return null;
    const members = membersQuery.data ?? [];
    const names = peerIds
      .map((uid) => members.find((m) => m.userId === uid)?.name)
      .filter((n): n is string => !!n);
    return names.length > 0 ? names.join(", ") : null;
  }, [channel.kind, channel.dmPeerUserIds, membersQuery.data]);
  const title =
    channel.kind === "dm"
      ? (dmPeerName ?? channel.name ?? "Direct message")
      : (channel.name ?? "channel");

  const typingNames = useMemo(() => {
    // Only surface typing indicators from the main channel stream — thread
    // typing has its own indicator inside the thread panel.
    return Object.values(typingByUser)
      .filter((t) => t.userId !== currentUserId && !t.parentId)
      .map((t) => t.username)
      .filter((v, i, arr) => arr.indexOf(v) === i);
  }, [typingByUser, currentUserId]);

  const disabled = chatRoom.state !== "connected";

  const myMembership = useMemo(
    () => membersQuery.data?.find((m) => m.userId === currentUserId) ?? null,
    [membersQuery.data, currentUserId],
  );
  const canManage = myMembership?.role === "admin" && channel.kind !== "dm";

  return (
    <View style={styles.container}>
      <View style={styles.alphaBanner} accessibilityRole="alert">
        <FlaskConical size={12} color="#f59e0b" strokeWidth={2} />
        <Text style={styles.alphaText}>
          Messages is in <Text style={styles.alphaBold}>alpha</Text> — expect bugs and breaking
          changes.
        </Text>
      </View>
      <View style={styles.header}>
        {onToggleChannelsPane ? (
          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <Pressable
                onPress={onToggleChannelsPane}
                style={styles.toggleBtn}
                accessibilityRole="button"
                accessibilityLabel={
                  channelsPaneOpen ? "Collapse channels sidebar" : "Expand channels sidebar"
                }
              >
                <PanelLeft
                  size={15}
                  color={channelsPaneOpen ? theme.colors.foreground : theme.colors.foregroundMuted}
                />
              </Pressable>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="center" offset={8}>
              <Text style={styles.tooltipText}>
                {channelsPaneOpen ? "Collapse channels" : "Expand channels"}
              </Text>
            </TooltipContent>
          </Tooltip>
        ) : null}
        <Icon size={16} color={theme.colors.foreground} />
        <Pressable
          onPress={() => setMembersOpen(true)}
          style={styles.titleWrap}
          accessibilityRole="button"
          accessibilityLabel="Open channel members"
        >
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          {channel.topic ? (
            <Text style={styles.topic} numberOfLines={1}>
              {channel.topic}
            </Text>
          ) : null}
        </Pressable>
        {pinnedIds.size > 0 ? (
          <Pressable
            onPress={() => setPinsOpen(true)}
            style={styles.pinsBtn}
            accessibilityRole="button"
            accessibilityLabel={`${pinnedIds.size} pinned`}
          >
            <Pin size={13} color={theme.colors.foregroundMuted} />
            <Text style={styles.pinsCount}>{pinnedIds.size}</Text>
          </Pressable>
        ) : null}
        {channel.kind !== "dm" ? (
          <ChannelHeaderMembers
            // Public channels: fan out to the full org roster so the avatar
            // stack reflects actual reach, not just the creator. Private
            // channels use explicit channel_members as before.
            members={channel.kind === "public" ? orgMemberFallback : (membersQuery.data ?? [])}
            presenceByUser={presenceByUser}
            onOpenMembers={() => setMembersOpen(true)}
            onAddPeople={() => setMembersOpen(true)}
            canAdd={canManage && channel.kind === "private"}
          />
        ) : null}
      </View>
      <MessageList
        messages={messages}
        members={channel.kind === "public" ? orgMemberFallback : (membersQuery.data ?? [])}
        fallbackAuthors={orgMemberFallback}
        channels={allChannelsQuery.data ?? []}
        currentUserId={currentUserId}
        presenceByUser={presenceByUser}
        pinnedMessageIds={pinnedIds}
        replyCountsByParent={replyCountsByParent}
        replyAuthorsByParent={replyAuthorsByParent}
        highlightedMessageId={highlightedMessageId}
        onLoadMore={() => {
          if (messagesQuery.hasNextPage && !messagesQuery.isFetchingNextPage) {
            void messagesQuery.fetchNextPage();
          }
        }}
        isLoadingMore={messagesQuery.isFetchingNextPage}
        hasMore={messagesQuery.hasNextPage}
        onOpenThread={onOpenThread}
        onReply={(message) => setReplyingTo(message)}
        onToggleReaction={(messageId, emoji, op) => {
          if (op === "add") chatRoom.reactAdd({ messageId, emoji });
          else chatRoom.reactRemove({ messageId, emoji });
        }}
        onTogglePin={(messageId, nextPinned) => {
          if (nextPinned) {
            pinMutation.mutate({ channelId: channel.id, messageId });
          } else {
            unpinMutation.mutate({ channelId: channel.id, messageId });
          }
        }}
        onEdit={(messageId, content) => chatRoom.edit({ messageId, content })}
        onDelete={(messageId) => chatRoom.remove({ messageId })}
      />
      {typingNames.length > 0 ? (
        <View style={styles.typingRow}>
          <Text style={styles.typingText}>
            {typingNames.join(", ")} {typingNames.length === 1 ? "is" : "are"} typing…
          </Text>
        </View>
      ) : null}
      <Composer
        placeholder={channel.kind === "dm" ? `Message ${title}` : `Message #${title}`}
        disabled={disabled}
        onSend={(raw, attachments) => {
          const result = applySlashCommand(raw);
          if (result.suppressed) return;
          // Optimistic placeholder so the message appears instantly. The real
          // broadcast replaces it in use-org-chat-room (matched by tmp_ prefix
          // + same userId/channel/content).
          const quotedMessageId = replyingTo?.id ?? null;
          if (
            currentUserId &&
            (result.content.trim().length > 0 || (attachments?.length ?? 0) > 0)
          ) {
            const tmpId = `tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            useChatStore.getState().upsertMessage({
              id: tmpId,
              channelId: channel.id,
              userId: currentUserId,
              parentId: null,
              quotedMessageId,
              content: result.content,
              createdAt: new Date().toISOString(),
              editedAt: null,
              deletedAt: null,
              attachments: attachments ?? [],
            });
          }
          chatRoom.send({
            channelId: channel.id,
            content: result.content,
            quotedMessageId,
            attachments,
          });
          uploads.reset();
          setReplyingTo(null);
        }}
        onTyping={() => chatRoom.typing(channel.id)}
        members={channel.kind === "public" ? orgMemberFallback : (membersQuery.data ?? [])}
        channels={allChannelsQuery.data ?? []}
        pendingUploads={uploads.pending}
        onRemoveUpload={uploads.remove}
        onPickAttachment={uploads.pickImage}
        onPickFile={uploads.pickFile}
        replyingTo={
          replyingTo
            ? {
                messageId: replyingTo.id,
                authorName:
                  (channel.kind === "public" ? orgMemberFallback : (membersQuery.data ?? [])).find(
                    (m) => m.userId === replyingTo.userId,
                  )?.name ??
                  orgMemberFallback.find((m) => m.userId === replyingTo.userId)?.name ??
                  "user",
                preview: (replyingTo.content || "[attachment]").slice(0, 120),
              }
            : null
        }
        onCancelReply={() => setReplyingTo(null)}
      />
      <ChannelMembersModal
        visible={membersOpen}
        channel={channel}
        sessionToken={sessionToken}
        currentUserId={currentUserId}
        canManage={canManage}
        presenceByUser={presenceByUser}
        onClose={() => setMembersOpen(false)}
      />
      <PinsModal
        visible={pinsOpen}
        channel={channel}
        sessionToken={sessionToken}
        currentUserId={currentUserId}
        onClose={() => setPinsOpen(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  alphaBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: 6,
    // Warning / amber: works on both light and dark themes. Uses a tinted
    // background (amber-500 at ~10% alpha) with a slightly stronger border
    // so it reads as a soft caution without shouting at the user.
    backgroundColor: "rgba(245, 158, 11, 0.12)",
    borderBottomWidth: 1,
    borderBottomColor: "rgba(245, 158, 11, 0.35)",
  },
  alphaText: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
    letterSpacing: 0.1,
  },
  alphaBold: {
    color: "#f59e0b",
    fontWeight: "700",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    minHeight: 56,
  },
  toggleBtn: {
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 4,
    marginRight: 2,
    minWidth: 32,
    minHeight: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  tooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.popoverForeground,
  },
  titleWrap: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  title: {
    fontSize: 16,
    fontWeight: "700",
    color: theme.colors.foreground,
    letterSpacing: -0.2,
  },
  topic: {
    flex: 1,
    fontSize: 13,
    color: theme.colors.foregroundMuted,
  },
  pinsBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: theme.colors.surface1,
  },
  pinsCount: {
    fontSize: 11,
    color: theme.colors.foreground,
    fontWeight: "600",
  },
  typingRow: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: 4,
    backgroundColor: theme.colors.surface0,
  },
  typingText: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
    fontStyle: "italic",
  },
}));
