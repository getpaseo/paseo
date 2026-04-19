import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  Hash,
  Lock,
  PanelLeft,
  PanelLeftClose,
  Pin,
  User,
} from "lucide-react-native";
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
import { usePanelStore } from "@/stores/panel-store";
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
  const allChannelsQuery = useChannelsQuery(channel.orgId, sessionToken);
  const allMessages = useChatStore(selectChannelMessages(channel.id));
  const messages = useMemo(
    () => allMessages.filter((m) => m.parentId === null),
    [allMessages],
  );
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
  const typingByUser = useChatStore(selectTyping(channel.id));
  const presenceByUser = useChatStore(selectOrgPresence(channel.orgId));

  const [membersOpen, setMembersOpen] = useState(false);
  const [pinsOpen, setPinsOpen] = useState(false);
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
      <View style={styles.header}>
        <LeftSidebarToggle />
        {onToggleChannelsPane ? (
          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <Pressable
                onPress={onToggleChannelsPane}
                style={styles.toggleBtn}
                accessibilityRole="button"
                accessibilityLabel={
                  channelsPaneOpen
                    ? "Collapse channels sidebar"
                    : "Expand channels sidebar"
                }
              >
                <PanelLeft
                  size={15}
                  color={
                    channelsPaneOpen
                      ? theme.colors.foreground
                      : theme.colors.foregroundMuted
                  }
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
            members={membersQuery.data ?? []}
            presenceByUser={presenceByUser}
            onOpenMembers={() => setMembersOpen(true)}
            onAddPeople={() => setMembersOpen(true)}
            canAdd={canManage}
          />
        ) : null}
      </View>
      <MessageList
        messages={messages}
        members={membersQuery.data ?? []}
        channels={allChannelsQuery.data ?? []}
        currentUserId={currentUserId}
        presenceByUser={presenceByUser}
        pinnedMessageIds={pinnedIds}
        replyCountsByParent={replyCountsByParent}
        highlightedMessageId={highlightedMessageId}
        onLoadMore={() => {
          if (messagesQuery.hasNextPage && !messagesQuery.isFetchingNextPage) {
            void messagesQuery.fetchNextPage();
          }
        }}
        onOpenThread={onOpenThread}
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
        placeholder={
          channel.kind === "dm" ? `Message ${title}` : `Message #${title}`
        }
        disabled={disabled}
        onSend={(raw, attachments) => {
          const result = applySlashCommand(raw);
          if (result.suppressed) return;
          chatRoom.send({
            channelId: channel.id,
            content: result.content,
            attachments,
          });
          uploads.reset();
        }}
        onTyping={() => chatRoom.typing(channel.id)}
        members={membersQuery.data ?? []}
        channels={allChannelsQuery.data ?? []}
        pendingUploads={uploads.pending}
        onRemoveUpload={uploads.remove}
        onPickAttachment={uploads.pickImage}
        onPickFile={uploads.pickFile}
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

function LeftSidebarToggle() {
  const { theme } = useUnistyles();
  const agentListOpen = usePanelStore((s) => s.desktop.agentListOpen);
  const toggleAgentList = usePanelStore((s) => s.toggleAgentList);
  const label = agentListOpen ? "Hide app sidebar" : "Show app sidebar";
  return (
    <Tooltip delayDuration={0}>
      <TooltipTrigger asChild>
        <Pressable
          onPress={toggleAgentList}
          style={styles.toggleBtn}
          accessibilityRole="button"
          accessibilityLabel={label}
        >
          <PanelLeftClose
            size={15}
            color={
              agentListOpen
                ? theme.colors.foreground
                : theme.colors.foregroundMuted
            }
          />
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="center" offset={8}>
        <Text style={styles.tooltipText}>{label}</Text>
      </TooltipContent>
    </Tooltip>
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
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  toggleBtn: {
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 4,
    marginRight: 2,
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
    fontSize: 15,
    fontWeight: "600",
    color: theme.colors.foreground,
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
