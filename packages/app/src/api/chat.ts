import { authServerFetch } from "./auth-server-fetch";

export interface ChatChannel {
  id: string;
  orgId: string;
  name: string | null;
  topic: string | null;
  kind: "public" | "private" | "dm";
  createdBy: string;
  createdAt: string;
  archivedAt: string | null;
  memberCount: number;
  isMember: boolean;
  /** Number of unread non-self messages for the viewer. Default 0 when server omits. */
  unreadCount?: number;
  /** Whether the viewer is mentioned in an unread message. */
  hasMention?: boolean;
  lastReadAt?: string | null;
  muted?: boolean;
  notifyPref?: "all" | "mentions" | "nothing";
  /**
   * For DM channels, the other participants' user ids (excludes viewer).
   * Optional for backward compat with older daemons.
   */
  dmPeerUserIds?: string[];
}

export interface ChatAttachment {
  id: string;
  url: string;
  mimeType: string;
  filename: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
}

export interface ChatMessage {
  id: string;
  channelId: string;
  userId: string;
  parentId: string | null;
  content: string;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  attachments: ChatAttachment[];
  /**
   * Number of non-deleted replies to this message. Optional for backward
   * compatibility with older daemons — assume 0 when missing.
   */
  replyCount?: number;
  /**
   * Reactions on this message, inlined by the server on initial load so the
   * client doesn't need a per-message query. Optional for backward compat.
   */
  reactions?: ChatReactionGroup[];
}

export interface ChatMember {
  userId: string;
  role: "admin" | "member";
  joinedAt: string;
  name: string;
  email: string;
  image: string | null;
}

export interface ChatReactionGroup {
  emoji: string;
  count: number;
  userIds: string[];
}

interface FetchArgs {
  sessionToken: string | null;
}

async function request<T>(path: string, init: RequestInit & FetchArgs): Promise<T> {
  const res = await authServerFetch(path, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
    };
    const err = new ChatApiError(
      res.status,
      body.code ?? "unknown",
      body.error ?? `HTTP ${res.status}`,
    );
    throw err;
  }
  return (await res.json()) as T;
}

export class ChatApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ChatApiError";
  }
}

// ─── Channels ───────────────────────────────────────────────────────────────

export async function listChannels(args: FetchArgs & { orgId: string }): Promise<ChatChannel[]> {
  const body = await request<{ channels: ChatChannel[] }>(
    `/api/orgs/${encodeURIComponent(args.orgId)}/channels`,
    { sessionToken: args.sessionToken, method: "GET" },
  );
  return body.channels;
}

export async function createChannel(
  args: FetchArgs & {
    orgId: string;
    name: string;
    kind: "public" | "private";
    topic?: string | null;
  },
): Promise<ChatChannel> {
  const body = await request<{ channel: ChatChannel }>(
    `/api/orgs/${encodeURIComponent(args.orgId)}/channels`,
    {
      sessionToken: args.sessionToken,
      method: "POST",
      body: JSON.stringify({
        name: args.name,
        kind: args.kind,
        topic: args.topic ?? null,
      }),
    },
  );
  return body.channel;
}

export async function archiveChannel(args: FetchArgs & { channelId: string }): Promise<void> {
  await request(`/api/channels/${encodeURIComponent(args.channelId)}/archive`, {
    sessionToken: args.sessionToken,
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function deleteChannel(args: FetchArgs & { channelId: string }): Promise<void> {
  await request(`/api/channels/${encodeURIComponent(args.channelId)}`, {
    sessionToken: args.sessionToken,
    method: "DELETE",
  });
}

export async function listChannelMembers(
  args: FetchArgs & { channelId: string },
): Promise<ChatMember[]> {
  const body = await request<{ members: ChatMember[] }>(
    `/api/channels/${encodeURIComponent(args.channelId)}/members`,
    { sessionToken: args.sessionToken, method: "GET" },
  );
  return body.members;
}

export async function addChannelMember(
  args: FetchArgs & { channelId: string; userId: string; role?: "admin" | "member" },
): Promise<void> {
  await request(`/api/channels/${encodeURIComponent(args.channelId)}/members`, {
    sessionToken: args.sessionToken,
    method: "POST",
    body: JSON.stringify({ userId: args.userId, role: args.role ?? "member" }),
  });
}

export async function removeChannelMember(
  args: FetchArgs & { channelId: string; userId: string },
): Promise<void> {
  await request(
    `/api/channels/${encodeURIComponent(args.channelId)}/members/${encodeURIComponent(
      args.userId,
    )}`,
    { sessionToken: args.sessionToken, method: "DELETE" },
  );
}

// ─── DMs ────────────────────────────────────────────────────────────────────

export async function listDms(args: FetchArgs & { orgId?: string }): Promise<ChatChannel[]> {
  const qs = args.orgId ? `?orgId=${encodeURIComponent(args.orgId)}` : "";
  const body = await request<{ channels: ChatChannel[] }>(`/api/dms${qs}`, {
    sessionToken: args.sessionToken,
    method: "GET",
  });
  return body.channels;
}

export async function openDm(
  args: FetchArgs & { orgId: string; userIds: string[] },
): Promise<ChatChannel> {
  const body = await request<{ channel: ChatChannel }>(`/api/dms`, {
    sessionToken: args.sessionToken,
    method: "POST",
    body: JSON.stringify({ orgId: args.orgId, userIds: args.userIds }),
  });
  return body.channel;
}

// ─── Messages ───────────────────────────────────────────────────────────────

export async function listMessages(
  args: FetchArgs & {
    channelId: string;
    before?: string;
    after?: string;
    limit?: number;
  },
): Promise<ChatMessage[]> {
  const qs = new URLSearchParams();
  if (args.before) qs.set("before", args.before);
  if (args.after) qs.set("after", args.after);
  if (args.limit) qs.set("limit", String(args.limit));
  const body = await request<{ messages: ChatMessage[] }>(
    `/api/channels/${encodeURIComponent(args.channelId)}/messages${qs.toString() ? `?${qs}` : ""}`,
    { sessionToken: args.sessionToken, method: "GET" },
  );
  return body.messages;
}

export async function sendMessageHttp(
  args: FetchArgs & {
    channelId: string;
    content: string;
    parentId?: string | null;
    attachments?: ChatAttachment[];
  },
): Promise<ChatMessage> {
  const body = await request<{ message: ChatMessage }>(
    `/api/channels/${encodeURIComponent(args.channelId)}/messages`,
    {
      sessionToken: args.sessionToken,
      method: "POST",
      body: JSON.stringify({
        content: args.content,
        parentId: args.parentId ?? null,
        attachments: args.attachments ?? [],
      }),
    },
  );
  return body.message;
}

export async function editMessageHttp(
  args: FetchArgs & { messageId: string; content: string },
): Promise<ChatMessage> {
  const body = await request<{ message: ChatMessage }>(
    `/api/messages/${encodeURIComponent(args.messageId)}`,
    {
      sessionToken: args.sessionToken,
      method: "PATCH",
      body: JSON.stringify({ content: args.content }),
    },
  );
  return body.message;
}

export async function deleteMessageHttp(args: FetchArgs & { messageId: string }): Promise<void> {
  await request(`/api/messages/${encodeURIComponent(args.messageId)}`, {
    sessionToken: args.sessionToken,
    method: "DELETE",
  });
}

export async function listReplies(args: FetchArgs & { messageId: string }): Promise<ChatMessage[]> {
  const body = await request<{ messages: ChatMessage[] }>(
    `/api/messages/${encodeURIComponent(args.messageId)}/replies`,
    { sessionToken: args.sessionToken, method: "GET" },
  );
  return body.messages;
}

export async function sendReplyHttp(
  args: FetchArgs & { messageId: string; content: string; attachments?: ChatAttachment[] },
): Promise<ChatMessage> {
  const body = await request<{ message: ChatMessage }>(
    `/api/messages/${encodeURIComponent(args.messageId)}/replies`,
    {
      sessionToken: args.sessionToken,
      method: "POST",
      body: JSON.stringify({
        content: args.content,
        attachments: args.attachments ?? [],
      }),
    },
  );
  return body.message;
}

// ─── Reactions ──────────────────────────────────────────────────────────────

export async function listReactions(
  args: FetchArgs & { messageId: string },
): Promise<ChatReactionGroup[]> {
  const body = await request<{ reactions: ChatReactionGroup[] }>(
    `/api/messages/${encodeURIComponent(args.messageId)}/reactions`,
    { sessionToken: args.sessionToken, method: "GET" },
  );
  return body.reactions;
}

export async function addReactionHttp(
  args: FetchArgs & { messageId: string; emoji: string },
): Promise<void> {
  await request(`/api/messages/${encodeURIComponent(args.messageId)}/reactions`, {
    sessionToken: args.sessionToken,
    method: "POST",
    body: JSON.stringify({ emoji: args.emoji }),
  });
}

export async function removeReactionHttp(
  args: FetchArgs & { messageId: string; emoji: string },
): Promise<void> {
  await request(
    `/api/messages/${encodeURIComponent(args.messageId)}/reactions/${encodeURIComponent(
      args.emoji,
    )}`,
    { sessionToken: args.sessionToken, method: "DELETE" },
  );
}

export async function markChannelReadHttp(args: FetchArgs & { channelId: string }): Promise<void> {
  await request(`/api/channels/${encodeURIComponent(args.channelId)}/read`, {
    sessionToken: args.sessionToken,
    method: "POST",
    body: JSON.stringify({}),
  });
}

// ─── Pins ───────────────────────────────────────────────────────────────────

export interface PinnedMessage {
  messageId: string;
  channelId: string;
  pinnedBy: string;
  pinnedAt: string;
  message: {
    id: string;
    userId: string;
    authorName: string;
    content: string;
    createdAt: string;
  };
}

export async function listPins(args: FetchArgs & { channelId: string }): Promise<PinnedMessage[]> {
  const body = await request<{ pins: PinnedMessage[] }>(
    `/api/channels/${encodeURIComponent(args.channelId)}/pins`,
    { sessionToken: args.sessionToken, method: "GET" },
  );
  return body.pins;
}

export async function pinMessageHttp(
  args: FetchArgs & { channelId: string; messageId: string },
): Promise<void> {
  await request(`/api/channels/${encodeURIComponent(args.channelId)}/pins`, {
    sessionToken: args.sessionToken,
    method: "POST",
    body: JSON.stringify({ messageId: args.messageId }),
  });
}

export async function unpinMessageHttp(
  args: FetchArgs & { channelId: string; messageId: string },
): Promise<void> {
  await request(
    `/api/channels/${encodeURIComponent(args.channelId)}/pins/${encodeURIComponent(
      args.messageId,
    )}`,
    { sessionToken: args.sessionToken, method: "DELETE" },
  );
}

// ─── Search & mentions feed ─────────────────────────────────────────────────

export interface SearchHit {
  messageId: string;
  channelId: string;
  channelName: string | null;
  channelKind: "public" | "private" | "dm";
  userId: string;
  authorName: string;
  content: string;
  createdAt: string;
}

export async function searchMessagesHttp(
  args: FetchArgs & { orgId: string; query: string; channelId?: string; limit?: number },
): Promise<SearchHit[]> {
  const qs = new URLSearchParams({ q: args.query });
  if (args.channelId) qs.set("channelId", args.channelId);
  if (args.limit) qs.set("limit", String(args.limit));
  const body = await request<{ hits: SearchHit[] }>(
    `/api/orgs/${encodeURIComponent(args.orgId)}/search?${qs}`,
    { sessionToken: args.sessionToken, method: "GET" },
  );
  return body.hits;
}

export async function updateChannelPrefsHttp(
  args: FetchArgs & {
    channelId: string;
    pref?: "all" | "mentions" | "nothing";
    muted?: boolean;
  },
): Promise<void> {
  const body: Record<string, unknown> = {};
  if (args.pref) body.pref = args.pref;
  if (typeof args.muted === "boolean") body.muted = args.muted;
  await request(`/api/channels/${encodeURIComponent(args.channelId)}/prefs`, {
    sessionToken: args.sessionToken,
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export async function listMyMentionsHttp(
  args: FetchArgs & { orgId: string; limit?: number },
): Promise<SearchHit[]> {
  const qs = new URLSearchParams({ orgId: args.orgId });
  if (args.limit) qs.set("limit", String(args.limit));
  const body = await request<{ hits: SearchHit[] }>(`/api/users/me/mentions?${qs}`, {
    sessionToken: args.sessionToken,
    method: "GET",
  });
  return body.hits;
}

// ─── Uploads ────────────────────────────────────────────────────────────────

export interface PresignResponse {
  key: string;
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  publicUrl: string;
  expiresAt: string;
}

export async function presignUpload(
  args: FetchArgs & {
    orgId: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
  },
): Promise<PresignResponse> {
  return request<PresignResponse>(`/api/uploads/presign`, {
    sessionToken: args.sessionToken,
    method: "POST",
    body: JSON.stringify({
      orgId: args.orgId,
      filename: args.filename,
      mimeType: args.mimeType,
      sizeBytes: args.sizeBytes,
    }),
  });
}
