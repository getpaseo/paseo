import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import {
  addReactionHttp,
  archiveChannel as archiveChannelHttp,
  deleteChannel as deleteChannelHttp,
  addChannelMember,
  createChannel as createChannelHttp,
  deleteMessageHttp,
  editMessageHttp,
  listChannelMembers,
  listChannels,
  listDms,
  listMessages,
  listReactions,
  listReplies,
  listMyMentionsHttp,
  listPins,
  markChannelReadHttp,
  openDm,
  pinMessageHttp,
  removeChannelMember,
  removeReactionHttp,
  searchMessagesHttp,
  sendMessageHttp,
  sendReplyHttp,
  updateChannelPrefsHttp,
  unpinMessageHttp,
  type ChatChannel,
  type ChatMessage,
  type ChatReactionGroup,
  type PinnedMessage,
  type SearchHit,
} from "@/api/chat";
import { useChatStore } from "@/stores/chat-store";

const PAGE_SIZE = 50;

export const chatKeys = {
  channels: (orgId: string) => ["chat", "channels", orgId] as const,
  dms: (orgId: string | undefined) => ["chat", "dms", orgId ?? "all"] as const,
  members: (channelId: string) => ["chat", "members", channelId] as const,
  messages: (channelId: string) => ["chat", "messages", channelId] as const,
  replies: (messageId: string) => ["chat", "replies", messageId] as const,
  reactions: (messageId: string) => ["chat", "reactions", messageId] as const,
  pins: (channelId: string) => ["chat", "pins", channelId] as const,
  search: (orgId: string, query: string) => ["chat", "search", orgId, query] as const,
  myMentions: (orgId: string) => ["chat", "myMentions", orgId] as const,
};

export function useChannelsQuery(orgId: string | undefined, sessionToken: string | null) {
  const setChannels = useChatStore((s) => s.setChannelsForOrg);
  const cached = useChatStore((s) => (orgId ? s.channelsByOrg[orgId] : undefined));
  const query = useQuery<ChatChannel[]>({
    queryKey: chatKeys.channels(orgId ?? ""),
    enabled: !!orgId && sessionToken !== null,
    queryFn: async () => {
      const list = await listChannels({ orgId: orgId!, sessionToken });
      setChannels(orgId!, list);
      return list;
    },
    // Seed from persisted cache so the list paints instantly on boot; the
    // network refetch replaces it when it arrives.
    initialData: orgId ? cached : undefined,
    initialDataUpdatedAt: 0,
    staleTime: 10_000,
  });
  return query;
}

export function useDmsQuery(orgId: string | undefined, sessionToken: string | null) {
  const setDms = useChatStore((s) => s.setDmsForOrg);
  const cached = useChatStore((s) => (orgId ? s.dmsByOrg[orgId] : undefined));
  return useQuery<ChatChannel[]>({
    queryKey: chatKeys.dms(orgId),
    enabled: !!orgId && sessionToken !== null,
    queryFn: async () => {
      const list = await listDms({ orgId, sessionToken });
      if (orgId) setDms(orgId, list);
      return list;
    },
    initialData: orgId ? cached : undefined,
    initialDataUpdatedAt: 0,
    staleTime: 10_000,
  });
}

export function useChannelMembersQuery(channelId: string | undefined, sessionToken: string | null) {
  return useQuery({
    queryKey: chatKeys.members(channelId ?? ""),
    enabled: !!channelId && sessionToken !== null,
    queryFn: () => listChannelMembers({ channelId: channelId!, sessionToken }),
    staleTime: 30_000,
  });
}

/**
 * Loads a single page of channel history (newest first); feeds them into the
 * chat-store so realtime events can merge into the same source of truth.
 */
export function useChannelMessages(channelId: string | undefined, sessionToken: string | null) {
  const setMessages = useChatStore((s) => s.setMessages);
  const prependMessages = useChatStore((s) => s.prependMessages);

  const query = useInfiniteQuery<ChatMessage[]>({
    queryKey: chatKeys.messages(channelId ?? ""),
    enabled: !!channelId && sessionToken !== null,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const msgs = await listMessages({
        channelId: channelId!,
        sessionToken,
        before: pageParam as string | undefined,
        limit: PAGE_SIZE,
      });
      return msgs;
    },
    getNextPageParam: (lastPage) => (lastPage.length === PAGE_SIZE ? lastPage[0]?.id : undefined),
    staleTime: 10_000,
  });

  useEffect(() => {
    if (!channelId) return;
    const pages = query.data?.pages ?? [];
    if (pages.length === 0) return;
    const first = pages[0] ?? [];
    if (pages.length === 1) {
      setMessages(channelId, first);
      return;
    }
    const last = pages[pages.length - 1] ?? [];
    prependMessages(channelId, last);
  }, [query.data?.pages?.length, channelId, setMessages, prependMessages]);

  return query;
}

export function useThreadRepliesQuery(messageId: string | undefined, sessionToken: string | null) {
  return useQuery<ChatMessage[]>({
    queryKey: chatKeys.replies(messageId ?? ""),
    enabled: !!messageId && sessionToken !== null,
    queryFn: () => listReplies({ messageId: messageId!, sessionToken }),
    staleTime: 5_000,
  });
}

export function useMessageReactionsQuery(
  messageId: string | undefined,
  sessionToken: string | null,
) {
  return useQuery<ChatReactionGroup[]>({
    queryKey: chatKeys.reactions(messageId ?? ""),
    enabled: !!messageId && sessionToken !== null,
    queryFn: () => listReactions({ messageId: messageId!, sessionToken }),
    staleTime: 30_000,
  });
}

// ─── Mutations ──────────────────────────────────────────────────────────────

export function useCreateChannelMutation(sessionToken: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      orgId: string;
      name: string;
      kind: "public" | "private";
      topic?: string;
    }) =>
      createChannelHttp({
        orgId: vars.orgId,
        name: vars.name,
        kind: vars.kind,
        topic: vars.topic ?? null,
        sessionToken,
      }),
    onSuccess: (chan) => {
      qc.invalidateQueries({ queryKey: chatKeys.channels(chan.orgId) });
    },
  });
}

export function useArchiveChannelMutation(sessionToken: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { channelId: string; orgId: string }) =>
      archiveChannelHttp({ channelId: vars.channelId, sessionToken }),
    onSuccess: (_void, vars) => {
      qc.invalidateQueries({ queryKey: chatKeys.channels(vars.orgId) });
    },
  });
}

export function useDeleteChannelMutation(sessionToken: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { channelId: string; orgId: string }) =>
      deleteChannelHttp({ channelId: vars.channelId, sessionToken }),
    onSuccess: (_void, vars) => {
      qc.invalidateQueries({ queryKey: chatKeys.channels(vars.orgId) });
      qc.removeQueries({ queryKey: chatKeys.messages(vars.channelId) });
      qc.removeQueries({ queryKey: chatKeys.members(vars.channelId) });
      qc.removeQueries({ queryKey: chatKeys.pins(vars.channelId) });
    },
  });
}

export function useAddChannelMemberMutation(sessionToken: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { channelId: string; userId: string; role?: "admin" | "member" }) =>
      addChannelMember({ ...vars, sessionToken }),
    onSuccess: (_void, vars) => {
      qc.invalidateQueries({ queryKey: chatKeys.members(vars.channelId) });
    },
  });
}

export function useRemoveChannelMemberMutation(sessionToken: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { channelId: string; userId: string }) =>
      removeChannelMember({ ...vars, sessionToken }),
    onSuccess: (_void, vars) => {
      qc.invalidateQueries({ queryKey: chatKeys.members(vars.channelId) });
    },
  });
}

export function useOpenDmMutation(sessionToken: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { orgId: string; userIds: string[] }) => openDm({ ...vars, sessionToken }),
    onSuccess: (chan, vars) => {
      qc.invalidateQueries({ queryKey: chatKeys.dms(vars.orgId) });
      return chan;
    },
  });
}

/**
 * HTTP-only send (fallback when no realtime connection). The realtime path
 * goes through the Colyseus room and is preferred.
 */
export function useSendMessageHttpMutation(sessionToken: string | null) {
  return useMutation({
    mutationFn: (vars: { channelId: string; content: string; parentId?: string | null }) =>
      sendMessageHttp({ ...vars, sessionToken }),
  });
}

export function useEditMessageMutation(sessionToken: string | null) {
  return useMutation({
    mutationFn: (vars: { messageId: string; content: string }) =>
      editMessageHttp({ ...vars, sessionToken }),
  });
}

export function useDeleteMessageMutation(sessionToken: string | null) {
  return useMutation({
    mutationFn: (vars: { messageId: string }) => deleteMessageHttp({ ...vars, sessionToken }),
  });
}

export function useSendReplyMutation(sessionToken: string | null) {
  return useMutation({
    mutationFn: (vars: { messageId: string; content: string }) =>
      sendReplyHttp({ ...vars, sessionToken }),
  });
}

export function useAddReactionMutation(sessionToken: string | null) {
  return useMutation({
    mutationFn: (vars: { messageId: string; emoji: string }) =>
      addReactionHttp({ ...vars, sessionToken }),
  });
}

export function useRemoveReactionMutation(sessionToken: string | null) {
  return useMutation({
    mutationFn: (vars: { messageId: string; emoji: string }) =>
      removeReactionHttp({ ...vars, sessionToken }),
  });
}

/**
 * Mark the channel as read (updates last_read_at on the server + zeros the
 * unreadCount / hasMention fields in the local channels cache).
 */
export function useMarkChannelReadMutation(sessionToken: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { channelId: string; orgId: string }) =>
      markChannelReadHttp({ channelId: vars.channelId, sessionToken }),
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: chatKeys.channels(vars.orgId) });
      const prev = qc.getQueryData<ChatChannel[]>(chatKeys.channels(vars.orgId));
      if (prev) {
        qc.setQueryData<ChatChannel[]>(
          chatKeys.channels(vars.orgId),
          prev.map((c) =>
            c.id === vars.channelId ? { ...c, unreadCount: 0, hasMention: false } : c,
          ),
        );
      }
      return { prev };
    },
    onError: (_err, vars, ctx) => {
      if (ctx?.prev) {
        qc.setQueryData(chatKeys.channels(vars.orgId), ctx.prev);
      }
    },
  });
}

export function usePinsQuery(channelId: string | undefined, sessionToken: string | null) {
  return useQuery<PinnedMessage[]>({
    queryKey: chatKeys.pins(channelId ?? ""),
    enabled: !!channelId && sessionToken !== null,
    queryFn: () => listPins({ channelId: channelId!, sessionToken }),
    staleTime: 30_000,
  });
}

export function usePinMutation(sessionToken: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { channelId: string; messageId: string }) =>
      pinMessageHttp({ ...vars, sessionToken }),
    onSuccess: (_void, vars) => {
      qc.invalidateQueries({ queryKey: chatKeys.pins(vars.channelId) });
    },
  });
}

export function useUnpinMutation(sessionToken: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { channelId: string; messageId: string }) =>
      unpinMessageHttp({ ...vars, sessionToken }),
    onSuccess: (_void, vars) => {
      qc.invalidateQueries({ queryKey: chatKeys.pins(vars.channelId) });
    },
  });
}

export function useUpdateChannelPrefsMutation(sessionToken: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      channelId: string;
      orgId: string;
      pref?: "all" | "mentions" | "nothing";
      muted?: boolean;
    }) => updateChannelPrefsHttp({ ...vars, sessionToken }),
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: chatKeys.channels(vars.orgId) });
      const prev = qc.getQueryData<ChatChannel[]>(chatKeys.channels(vars.orgId));
      if (prev) {
        qc.setQueryData<ChatChannel[]>(
          chatKeys.channels(vars.orgId),
          prev.map((c) =>
            c.id === vars.channelId
              ? {
                  ...c,
                  ...(vars.pref ? { notifyPref: vars.pref } : {}),
                  ...(typeof vars.muted === "boolean" ? { muted: vars.muted } : {}),
                }
              : c,
          ),
        );
      }
      return { prev };
    },
    onError: (_err, vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(chatKeys.channels(vars.orgId), ctx.prev);
    },
  });
}

export function useSearchMessagesQuery(
  orgId: string | undefined,
  query: string,
  sessionToken: string | null,
) {
  const trimmed = query.trim();
  return useQuery<SearchHit[]>({
    queryKey: chatKeys.search(orgId ?? "", trimmed),
    enabled: !!orgId && sessionToken !== null && trimmed.length >= 2,
    queryFn: () => searchMessagesHttp({ orgId: orgId!, query: trimmed, sessionToken }),
    staleTime: 5_000,
  });
}

export function useMyMentionsQuery(orgId: string | undefined, sessionToken: string | null) {
  return useQuery<SearchHit[]>({
    queryKey: chatKeys.myMentions(orgId ?? ""),
    enabled: !!orgId && sessionToken !== null,
    queryFn: () => listMyMentionsHttp({ orgId: orgId!, sessionToken }),
    staleTime: 30_000,
  });
}

/**
 * Locally (optimistically) increment a channel's unreadCount + hasMention
 * when a realtime message arrives for a channel other than the active one.
 * Safe no-op when the channel isn't in cache.
 */
export function bumpChannelUnread(
  qc: ReturnType<typeof useQueryClient>,
  params: {
    orgId: string;
    channelId: string;
    mentioned: boolean;
  },
) {
  const prev = qc.getQueryData<ChatChannel[]>(chatKeys.channels(params.orgId));
  if (!prev) return;
  qc.setQueryData<ChatChannel[]>(
    chatKeys.channels(params.orgId),
    prev.map((c) => {
      if (c.id !== params.channelId) return c;
      const notify = c.notifyPref ?? "all";
      // "nothing" — don't even flash mentions. "mentions" — only bump when @me.
      if (notify === "nothing") return c;
      if (notify === "mentions" && !params.mentioned) return c;
      return {
        ...c,
        unreadCount: (c.unreadCount ?? 0) + 1,
        hasMention: c.hasMention || params.mentioned,
      };
    }),
  );
}
