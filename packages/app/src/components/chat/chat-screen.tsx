import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ArrowLeft, LogIn, MessageSquare } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useAuthSession } from "@/desktop/hooks/use-auth-session";
import { useActiveOrgId } from "@/stores/active-org-store";
import {
  SIDEBAR_COLLAPSED_WIDTH,
  SIDEBAR_EXPANDED_WIDTH,
  THREAD_PANE_WIDTH,
  useIsCompactFormFactor,
} from "@/constants/layout";
import { useWindowControlsPadding } from "@/utils/desktop-window";
import { SidebarMenuToggle } from "@/components/headers/menu-header";
import {
  useChannelMembersQuery,
  useChannelsQuery,
  useDeleteChannelMutation,
  useDmsQuery,
  useMarkChannelReadMutation,
  useOpenDmMutation,
} from "@/hooks/chat/use-chat-queries";
import { useOrgMembersQuery } from "@/hooks/chat/use-org-members";
import { selectOrgPresence } from "@/stores/chat-store";
import { useOrgChatRoom } from "@/hooks/chat/use-org-chat-room";
import { useChatNotifications } from "@/hooks/chat/use-chat-notifications";
import { useChatStore } from "@/stores/chat-store";
import type { ChatMessage } from "@/api/chat";
import { ChannelSidebar, type DmEntry } from "./channel-sidebar";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ChannelMessages } from "./channel-messages";
import { ThreadPanel } from "./thread-panel";
import { CreateChannelModal } from "./create-channel-modal";
import { SearchPanel } from "./search-panel";
import { MentionsPanel } from "./mentions-panel";
import { useMyMentionsQuery } from "@/hooks/chat/use-chat-queries";
import type { SearchHit } from "@/api/chat";

export function ChatScreen() {
  const orgId = useActiveOrgId();
  const {
    session,
    signIn,
    isSigningIn,
    isLoading: authLoading,
    isAuthenticated,
  } = useAuthSession();
  // On web, Better Auth authenticates via cookies — `session.sessionToken` is
  // intentionally empty. Use `isAuthenticated` for "has session" gating; keep
  // `sessionToken` for passing the bearer to HTTP helpers (empty string on
  // web is correct; authServerFetch just skips the Authorization header and
  // `credentials: "include"` carries the cookie).
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
  useChatNotifications({
    room: chatRoom.room,
    currentUserId,
    orgId,
    channels: channelsQuery.data ?? [],
    dms: dmsQuery.data ?? [],
    members: orgMembersQuery.data ?? [],
  });
  const markRead = useMarkChannelReadMutation(sessionToken);
  const deleteChannelMutation = useDeleteChannelMutation(sessionToken);
  const [channelPendingDelete, setChannelPendingDelete] =
    useState<import("@/api/chat").ChatChannel | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const handleDeleteChannel = (c: import("@/api/chat").ChatChannel) => {
    if (c.kind === "dm") return;
    setDeleteError(null);
    setChannelPendingDelete(c);
  };
  const handleConfirmDeleteChannel = async () => {
    const c = channelPendingDelete;
    if (!c) return;
    try {
      await deleteChannelMutation.mutateAsync({ channelId: c.id, orgId: c.orgId });
      if (selectedChannelId === c.id) setSelectedChannelId(null);
      setChannelPendingDelete(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to delete channel";
      setDeleteError(msg);
    }
  };
  const setActiveChannelId = useChatStore((s) => s.setActiveChannelId);
  // Public channels don't populate channel-member rows, so `membersQuery`
  // returns empty. Fall back to org-member rows (name + avatar) so the thread
  // header can resolve the parent message author instead of showing "?".
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
  const presenceByUser = useChatStore(selectOrgPresence(orgId ?? ""));

  const dmEntries = useMemo<DmEntry[]>(() => {
    const dms = dmsQuery.data ?? [];
    const members = orgMembersQuery.data ?? [];
    // Map 1:1 DMs to the other participant via server-provided `dmPeerUserIds`.
    // Group DMs (2+ peers) are kept as standalone entries keyed by channel id.
    const existingByUserId = new Map<string, (typeof dms)[number]>();
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
    // On compact/mobile, the 3-step stack (list → messages → thread) relies
    // on `selectedChannelId === null` to show the channel list. Auto-selecting
    // the first channel here would immediately undo the user's Back tap.
    if (isCompact) return;
    if (selectedChannelId) return;
    const firstPublic = channelsQuery.data?.find((c) => c.kind === "public");
    const firstAny = channelsQuery.data?.[0] ?? dmsQuery.data?.[0];
    setSelectedChannelId((firstPublic ?? firstAny)?.id ?? null);
  }, [channelsQuery.data, dmsQuery.data, selectedChannelId, isCompact]);

  // Close the thread drawer when switching channels.
  useEffect(() => {
    setThreadParent(null);
  }, [selectedChannelId]);

  // Track the focused channel so the Colyseus hook knows when not to bump
  // unread counts locally, and mark the channel as read server-side. The
  // markRead call needs an auth token to avoid firing a 401 — skip when the
  // session hasn't landed yet (including briefly during boot / post-F5).
  useEffect(() => {
    setActiveChannelId(selectedChannelId);
    if (selectedChannelId && orgId && sessionToken !== null) {
      markRead.mutate({ channelId: selectedChannelId, orgId });
    }
    return () => setActiveChannelId(null);
    // markRead is stable via useMutation; including it in deps is noisy.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedChannelId, orgId, sessionToken]);

  if (!orgId) return <EmptyState label="Select an organization to chat." />;
  // Show the boot skeleton while the auth session query is still resolving
  // (F5 path: `useAuthSession` runs an async IPC call to the desktop bridge,
  // leaving `sessionToken` briefly null even for logged-in users). Avoids the
  // "Sign in to chat" CTA from flashing for ~300ms before messages load.
  if (authLoading) return <ChatBootSkeleton />;
  if (!isAuthenticated)
    return <SignInToChatEmpty onSignIn={() => signIn(undefined)} isSigningIn={isSigningIn} />;
  // Defer the chat UI until the member roster has loaded so message bubbles
  // can show real names/avatars instead of falling back to user IDs for a
  // flash on boot.
  const chatBooting =
    orgMembersQuery.isPending || (orgMembersQuery.isFetching && !orgMembersQuery.data);
  if (chatBooting) return <ChatBootSkeleton />;

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
      <ConfirmDialog
        visible={!!channelPendingDelete}
        title={
          channelPendingDelete?.name
            ? `Delete #${channelPendingDelete.name}?`
            : "Delete channel?"
        }
        description={
          deleteError ??
          "This permanently removes the channel and all of its messages. This action cannot be undone."
        }
        confirmLabel="Delete"
        destructive
        isPending={deleteChannelMutation.isPending}
        onCancel={() => {
          setChannelPendingDelete(null);
          setDeleteError(null);
        }}
        onConfirm={handleConfirmDeleteChannel}
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
            <BackHeader
              onBack={() => setThreadParent(null)}
              label={`Thread · ${channelHeader(selectedChannel)}`}
            />
            <ThreadPanel
              parent={threadParent}
              channel={selectedChannel}
              members={
                selectedChannel.kind === "public"
                  ? orgMemberFallback
                  : (membersQuery.data ?? [])
              }
              channels={channelsQuery.data ?? []}
              sessionToken={sessionToken}
              currentUserId={currentUserId}
              chatRoom={chatRoom}
              onClose={() => setThreadParent(null)}
              hideHeader
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
              onDeleteChannel={handleDeleteChannel}
              leading={<SidebarMenuToggle />}
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
      <View style={channelsPaneOpen ? styles.sidebarPane : styles.sidebarPaneCollapsed}>
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
          onDeleteChannel={handleDeleteChannel}
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
            members={
              selectedChannel.kind === "public"
                ? orgMemberFallback
                : (membersQuery.data ?? [])
            }
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
      <SidebarMenuToggle />
      <Pressable onPress={onBack} style={styles.backBtn} accessibilityRole="button">
        <ArrowLeft size={18} color={theme.colors.foreground} />
      </Pressable>
      <Text style={styles.backHeaderLabel} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

function ChatBootSkeleton() {
  const { theme } = useUnistyles();
  const pulse = useRef(new Animated.Value(0.4)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.4, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  const bar = (w: number) => (
    <Animated.View
      style={{
        height: 10,
        width: w,
        borderRadius: 4,
        backgroundColor: theme.colors.surface2,
        opacity: pulse,
        marginBottom: 6,
      }}
    />
  );
  return (
    <View style={styles.skeletonWrap}>
      <Animated.View
        style={[styles.skeletonSpinner, { opacity: pulse, borderColor: theme.colors.brandMagenta }]}
      />
      <Text style={styles.skeletonLabel}>Loading chat…</Text>
      <View style={styles.skeletonLines}>
        {bar(180)}
        {bar(140)}
        {bar(200)}
      </View>
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

function SignInToChatEmpty({
  onSignIn,
  isSigningIn,
}: {
  onSignIn: () => void;
  isSigningIn: boolean;
}) {
  return (
    <View style={styles.signInWrap}>
      <View style={styles.signInCard}>
        <View style={styles.signInIconWrap}>
          <MessageSquare size={24} color="#ffffff" strokeWidth={1.75} />
        </View>
        <Text style={styles.signInTitle}>Sign in to chat</Text>
        <Text style={styles.signInSubtitle}>
          Connect your account to message teammates, join channels, and get mention notifications.
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Sign in"
          disabled={isSigningIn}
          onPress={onSignIn}
          style={({ hovered, pressed }) => [
            styles.signInButton,
            hovered && styles.signInButtonHover,
            pressed && styles.signInButtonPressed,
            isSigningIn && styles.signInButtonDisabled,
          ]}
        >
          <LogIn size={16} color="#ffffff" strokeWidth={2} />
          <Text style={styles.signInButtonText}>
            {isSigningIn ? "Opening browser..." : "Sign in"}
          </Text>
        </Pressable>
      </View>
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
    width: SIDEBAR_EXPANDED_WIDTH,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
  sidebarPaneCollapsed: {
    width: SIDEBAR_COLLAPSED_WIDTH,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
  messagesPane: {
    flex: 1,
  },
  threadPane: {
    width: THREAD_PANE_WIDTH,
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
  signInWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
    backgroundColor: theme.colors.surface0,
  },
  signInCard: {
    maxWidth: 380,
    width: "100%",
    alignItems: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[6],
    borderRadius: 16,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  signInIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.brandMagenta,
    marginBottom: theme.spacing[1],
    shadowColor: theme.colors.brandMagenta,
    shadowOpacity: 0.35,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  signInTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: theme.colors.foreground,
    letterSpacing: -0.2,
  },
  signInSubtitle: {
    fontSize: 13,
    lineHeight: 19,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
  signInButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderRadius: 10,
    backgroundColor: theme.colors.brandMagenta,
    minWidth: 180,
    marginTop: theme.spacing[2],
  },
  signInButtonHover: {
    backgroundColor: theme.colors.brandMagentaHover,
  },
  signInButtonPressed: {
    opacity: 0.9,
  },
  signInButtonDisabled: {
    opacity: 0.7,
  },
  signInButtonText: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "600",
  },
  skeletonWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface0,
  },
  skeletonSpinner: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 2,
    borderTopColor: "transparent",
    borderRightColor: "transparent",
    marginBottom: theme.spacing[2],
  },
  skeletonLabel: {
    fontSize: 13,
    color: theme.colors.foregroundMuted,
    fontWeight: "500",
  },
  skeletonLines: {
    marginTop: theme.spacing[2],
    alignItems: "center",
  },
}));
