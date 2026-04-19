import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ArrowLeft } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useAuthSession } from "@/desktop/hooks/use-auth-session";
import { useActiveOrgId } from "@/stores/active-org-store";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useWindowControlsPadding } from "@/utils/desktop-window";
import {
  useChannelMembersQuery,
  useChannelsQuery,
  useDmsQuery,
  useMarkChannelReadMutation,
  useOpenDmMutation,
} from "@/hooks/chat/use-chat-queries";
import { useOrgMembersQuery } from "@/hooks/chat/use-org-members";
import { selectOrgPresence } from "@/stores/chat-store";
import { useOrgChatRoom } from "@/hooks/chat/use-org-chat-room";
import { useChatStore } from "@/stores/chat-store";
import type { ChatMessage } from "@/api/chat";
import { ChannelSidebar, type DmEntry } from "./channel-sidebar";
import { ChannelMessages } from "./channel-messages";
import { ThreadPanel } from "./thread-panel";
import { CreateChannelModal } from "./create-channel-modal";
import { SearchPanel } from "./search-panel";
import { MentionsPanel } from "./mentions-panel";
import { useMyMentionsQuery } from "@/hooks/chat/use-chat-queries";
import type { SearchHit } from "@/api/chat";

export function ChatScreen() {
  const orgId = useActiveOrgId();
  const { session } = useAuthSession();
  const sessionToken = session?.sessionToken ?? null;
  const currentUserId = session?.user?.userId ?? null;
  const isCompact = useIsCompactFormFactor();
  const insets = useSafeAreaInsets();
  const headerPadding = useWindowControlsPadding("header");
  const topOffset = insets.top + headerPadding.top;

  const channelsQuery = useChannelsQuery(orgId ?? undefined, sessionToken);
  const dmsQuery = useDmsQuery(orgId ?? undefined, sessionToken);
  const orgMembersQuery = useOrgMembersQuery(orgId ?? undefined, sessionToken);
  const openDmMutation = useOpenDmMutation(sessionToken);
  const chatRoom = useOrgChatRoom(orgId, sessionToken, currentUserId);
  const markRead = useMarkChannelReadMutation(sessionToken);
  const setActiveChannelId = useChatStore((s) => s.setActiveChannelId);
  const presenceByUser = useChatStore(selectOrgPresence(orgId ?? ""));

  const dmEntries = useMemo<DmEntry[]>(() => {
    const dms = dmsQuery.data ?? [];
    const members = orgMembersQuery.data ?? [];
    // Map 1:1 DMs to the other participant via server-provided `dmPeerUserIds`.
    // Group DMs (2+ peers) are kept as standalone entries keyed by channel id.
    const existingByUserId = new Map<string, typeof dms[number]>();
    const groupDms: typeof dms = [];
    for (const c of dms) {
      const peers = c.dmPeerUserIds ?? [];
      if (peers.length === 1 && peers[0]) {
        existingByUserId.set(peers[0], c);
      } else if (peers.length > 1) {
        groupDms.push(c);
      }
    }
    const entries: DmEntry[] = [];
    const seenUserIds = new Set<string>();
    for (const m of members) {
      if (!m.user || m.userId === currentUserId) continue;
      seenUserIds.add(m.userId);
      entries.push({
        userId: m.userId,
        name: m.user.name,
        avatarUrl: m.user.image,
        channel: existingByUserId.get(m.userId) ?? null,
        online: !!presenceByUser[m.userId],
      });
    }
    // Fallback: surface any existing 1:1 DM whose peer didn't appear in the
    // org-members list (query still loading, 401, or member left the org).
    for (const [peerId, chan] of existingByUserId) {
      if (seenUserIds.has(peerId)) continue;
      entries.push({
        userId: peerId,
        name: chan.name ?? "Direct message",
        avatarUrl: null,
        channel: chan,
        online: !!presenceByUser[peerId],
      });
    }
    for (const c of groupDms) {
      entries.push({
        userId: c.id,
        name: c.name ?? "Group DM",
        avatarUrl: null,
        channel: c,
      });
    }
    return entries;
  }, [dmsQuery.data, orgMembersQuery.data, currentUserId, presenceByUser]);

  const handleOpenDm = async (entry: DmEntry) => {
    if (entry.channel) {
      setSelectedChannelId(entry.channel.id);
      return;
    }
    if (!orgId) return;
    try {
      const channel = await openDmMutation.mutateAsync({
        orgId,
        userIds: [entry.userId],
      });
      setSelectedChannelId(channel.id);
    } catch (e) {
      console.warn("Failed to open DM", e);
    }
  };

  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [threadParent, setThreadParent] = useState<ChatMessage | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [mentionsOpen, setMentionsOpen] = useState(false);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const [channelsPaneOpen, setChannelsPaneOpen] = useState(true);

  const mentionsQuery = useMyMentionsQuery(orgId ?? undefined, sessionToken);
  const mentionsCount = mentionsQuery.data?.length ?? 0;

  const handlePickHit = (hit: SearchHit) => {
    setSelectedChannelId(hit.channelId);
    setHighlightedMessageId(hit.messageId);
    setTimeout(() => setHighlightedMessageId(null), 2000);
  };

  // Deep linking via `/chat?channel=X&m=Y`. Select the channel, highlight the
  // target message for 2s, then strip the query params so a reload doesn't
  // re-highlight forever.
  const params = useLocalSearchParams<{ channel?: string; m?: string }>();
  const router = useRouter();
  const consumedRef = useRef<string | null>(null);
  useEffect(() => {
    const deepChannelId = typeof params.channel === "string" ? params.channel : null;
    const deepMessageId = typeof params.m === "string" ? params.m : null;
    if (!deepChannelId && !deepMessageId) return;
    const key = `${deepChannelId}|${deepMessageId}`;
    if (consumedRef.current === key) return;
    consumedRef.current = key;
    if (deepChannelId) setSelectedChannelId(deepChannelId);
    if (deepMessageId) {
      setHighlightedMessageId(deepMessageId);
      const timer = setTimeout(() => setHighlightedMessageId(null), 2000);
      router.setParams({ channel: undefined, m: undefined });
      return () => clearTimeout(timer);
    }
    router.setParams({ channel: undefined, m: undefined });
  }, [params.channel, params.m, router]);

  const selectedChannel =
    channelsQuery.data?.find((c) => c.id === selectedChannelId) ??
    dmsQuery.data?.find((c) => c.id === selectedChannelId) ??
    null;

  const membersQuery = useChannelMembersQuery(selectedChannel?.id, sessionToken);

  useEffect(() => {
    if (selectedChannelId) return;
    const firstPublic = channelsQuery.data?.find((c) => c.kind === "public");
    const firstAny = channelsQuery.data?.[0] ?? dmsQuery.data?.[0];
    setSelectedChannelId((firstPublic ?? firstAny)?.id ?? null);
  }, [channelsQuery.data, dmsQuery.data, selectedChannelId]);

  // Close the thread drawer when switching channels.
  useEffect(() => {
    setThreadParent(null);
  }, [selectedChannelId]);

  // Track the focused channel so the Colyseus hook knows when not to bump
  // unread counts locally, and mark the channel as read server-side.
  useEffect(() => {
    setActiveChannelId(selectedChannelId);
    if (selectedChannelId && orgId) {
      markRead.mutate({ channelId: selectedChannelId, orgId });
    }
    return () => setActiveChannelId(null);
    // markRead is stable via useMutation; including it in deps is noisy.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedChannelId, orgId]);

  if (!orgId) return <EmptyState label="Select an organization to chat." />;
  if (!sessionToken) return <EmptyState label="Sign in to chat." />;

  const modals = (
    <Fragment>
      <CreateChannelModal
        visible={createOpen}
        orgId={orgId}
        sessionToken={sessionToken}
        currentUserId={currentUserId}
        onClose={() => setCreateOpen(false)}
        onCreated={(id) => setSelectedChannelId(id)}
      />
      <SearchPanel
        visible={searchOpen}
        orgId={orgId}
        sessionToken={sessionToken}
        onClose={() => setSearchOpen(false)}
        onPickHit={handlePickHit}
      />
      <MentionsPanel
        visible={mentionsOpen}
        orgId={orgId}
        sessionToken={sessionToken}
        onClose={() => setMentionsOpen(false)}
        onPickHit={handlePickHit}
      />
    </Fragment>
  );
  const createModal = modals;

  if (isCompact) {
    // Mobile: 3-step stack (list → messages → thread).
    if (threadParent && selectedChannel) {
      return (
        <Fragment>
        <View style={[styles.mobileWrap, { paddingTop: topOffset }]}>
          <BackHeader onBack={() => setThreadParent(null)} label="Thread" />
          <ThreadPanel
            parent={threadParent}
            channel={selectedChannel}
            members={membersQuery.data ?? []}
            channels={channelsQuery.data ?? []}
            sessionToken={sessionToken}
            currentUserId={currentUserId}
            chatRoom={chatRoom}
            onClose={() => setThreadParent(null)}
          />
        </View>
        {createModal}
        </Fragment>
      );
    }
    if (!selectedChannel) {
      return (
        <Fragment>
        <View style={[styles.mobileWrap, { paddingTop: topOffset }]}>
          <ChannelSidebar
            channels={channelsQuery.data ?? []}
            dmEntries={dmEntries}
            selectedChannelId={null}
            mentionsCount={mentionsCount}
            onSelectChannel={setSelectedChannelId}
            onOpenDm={handleOpenDm}
            onCreateChannel={() => setCreateOpen(true)}
            onOpenSearch={() => setSearchOpen(true)}
            onOpenMentions={() => setMentionsOpen(true)}
          />
        </View>
        {createModal}
        </Fragment>
      );
    }
    return (
      <Fragment>
      <View style={[styles.mobileWrap, { paddingTop: topOffset }]}>
        <BackHeader
          onBack={() => setSelectedChannelId(null)}
          label={channelHeader(selectedChannel)}
        />
        <ChannelMessages
          channel={selectedChannel}
          sessionToken={sessionToken}
          currentUserId={currentUserId}
          chatRoom={chatRoom}
          onOpenThread={setThreadParent}
          highlightedMessageId={
            selectedChannel.id === selectedChannelId ? highlightedMessageId : null
          }
        />
      </View>
      {createModal}
      </Fragment>
    );
  }

  // Desktop/tablet: 2 or 3 panes.
  return (
    <View style={[styles.wideWrap, { paddingTop: topOffset }]}>
      <View
        style={channelsPaneOpen ? styles.sidebarPane : styles.sidebarPaneCollapsed}
      >
        <ChannelSidebar
          channels={channelsQuery.data ?? []}
          dmEntries={dmEntries}
          selectedChannelId={selectedChannelId}
          mentionsCount={mentionsCount}
          onSelectChannel={setSelectedChannelId}
          onOpenDm={handleOpenDm}
          onCreateChannel={() => setCreateOpen(true)}
          onOpenSearch={() => setSearchOpen(true)}
          onOpenMentions={() => setMentionsOpen(true)}
          collapsed={!channelsPaneOpen}
        />
      </View>
      <View style={styles.messagesPane}>
        {selectedChannel ? (
          <ChannelMessages
            channel={selectedChannel}
            sessionToken={sessionToken}
            currentUserId={currentUserId}
            chatRoom={chatRoom}
            onOpenThread={setThreadParent}
            channelsPaneOpen={channelsPaneOpen}
            onToggleChannelsPane={() => setChannelsPaneOpen((p) => !p)}
          />
        ) : (
          <EmptyState label="Select a channel to start chatting." />
        )}
      </View>
      {threadParent && selectedChannel ? (
        <View style={styles.threadPane}>
          <ThreadPanel
            parent={threadParent}
            channel={selectedChannel}
            members={membersQuery.data ?? []}
            channels={channelsQuery.data ?? []}
            sessionToken={sessionToken}
            currentUserId={currentUserId}
            chatRoom={chatRoom}
            onClose={() => setThreadParent(null)}
          />
        </View>
      ) : null}
      {createModal}
    </View>
  );
}

function BackHeader({ onBack, label }: { onBack: () => void; label: string }) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.backHeader}>
      <Pressable onPress={onBack} style={styles.backBtn} accessibilityRole="button">
        <ArrowLeft size={18} color={theme.colors.foreground} />
      </Pressable>
      <Text style={styles.backHeaderLabel} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <View style={styles.emptyWrap}>
      <Text style={styles.emptyLabel}>{label}</Text>
    </View>
  );
}

function channelHeader(c: { name: string | null; kind: string }): string {
  if (c.kind === "dm") return c.name ?? "Direct message";
  return `#${c.name ?? ""}`;
}

const styles = StyleSheet.create((theme) => ({
  wideWrap: {
    flex: 1,
    flexDirection: "row",
    backgroundColor: theme.colors.surface0,
  },
  sidebarPane: {
    width: 260,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
  sidebarPaneCollapsed: {
    width: 52,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
  messagesPane: {
    flex: 1,
  },
  threadPane: {
    width: 380,
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
  },
  mobileWrap: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  backHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  backBtn: {
    padding: 6,
    borderRadius: 4,
  },
  backHeaderLabel: {
    flex: 1,
    fontSize: 15,
    fontWeight: "600",
    color: theme.colors.foreground,
  },
  emptyWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
  },
  emptyLabel: {
    fontSize: 14,
    color: theme.colors.foregroundMuted,
  },
}));
