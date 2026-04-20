import { config } from "../config.js";

export interface ChatMessage {
  id: string;
  channelId: string;
  userId: string;
  parentId: string | null;
  content: string;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  attachments: Array<{
    id: string;
    url: string;
    mimeType: string;
    filename: string;
    sizeBytes: number;
    width: number | null;
    height: number | null;
  }>;
}

export interface ChatAttachmentInput {
  url: string;
  mimeType: string;
  filename: string;
  sizeBytes: number;
  width?: number | null;
  height?: number | null;
}

export interface ChannelMembership {
  id: string;
  orgId: string;
  kind: "public" | "private" | "dm";
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
  role: string;
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

export class ChatApiClient {
  private base: string;
  private secret: string;
  private fetchFn: typeof fetch;

  constructor(opts?: { baseUrl?: string; secret?: string; fetchFn?: typeof fetch }) {
    this.base = opts?.baseUrl ?? config.authServerUrl;
    this.secret = opts?.secret ?? config.internalSecret;
    this.fetchFn = opts?.fetchFn ?? fetch;
  }

  private async request<T>(
    path: string,
    init: RequestInit & { internal?: boolean; bearer?: string } = {},
  ): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.internal) headers.set("x-internal-secret", this.secret);
    if (init.bearer) headers.set("authorization", `Bearer ${init.bearer}`);
    if (init.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    const res = await this.fetchFn(`${this.base}${path}`, {
      ...init,
      headers,
    });
    if (!res.ok) {
      let errBody: { error?: string; code?: string } = {};
      try {
        errBody = await res.json();
      } catch {
        // no body
      }
      throw new ChatApiError(
        res.status,
        errBody.code ?? "unknown",
        errBody.error ?? `HTTP ${res.status}`,
      );
    }
    return (await res.json()) as T;
  }

  async validateSession(sessionToken: string): Promise<SessionUser> {
    const body = await this.request<{ user: SessionUser }>("/api/auth/get-session", {
      method: "GET",
      bearer: sessionToken,
    });
    return body.user;
  }

  async isOrgMember(userId: string, orgId: string): Promise<boolean> {
    try {
      await this.request(
        `/api/internal/chat/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(
          userId,
        )}`,
        { method: "GET", internal: true },
      );
      return true;
    } catch (err) {
      if (err instanceof ChatApiError && err.status === 404) return false;
      throw err;
    }
  }

  async getUserChannels(userId: string): Promise<ChannelMembership[]> {
    const body = await this.request<{ channels: ChannelMembership[] }>(
      `/api/internal/chat/users/${encodeURIComponent(userId)}/channels`,
      { method: "GET", internal: true },
    );
    return body.channels;
  }

  async getChannel(channelId: string): Promise<ChannelMembership | null> {
    try {
      const body = await this.request<ChannelMembership>(
        `/api/internal/chat/channels/${encodeURIComponent(channelId)}`,
        { method: "GET", internal: true },
      );
      return body;
    } catch (err) {
      if (err instanceof ChatApiError && err.status === 404) return null;
      throw err;
    }
  }

  async getChannelMembers(channelId: string): Promise<Array<{ userId: string; role: string }>> {
    const body = await this.request<{ members: Array<{ userId: string; role: string }> }>(
      `/api/internal/chat/channels/${encodeURIComponent(channelId)}/members`,
      { method: "GET", internal: true },
    );
    return body.members;
  }

  async sendMessage(params: {
    userId: string;
    channelId: string;
    content: string;
    parentId?: string | null;
    attachments?: ChatAttachmentInput[];
  }): Promise<ChatMessage> {
    const body = await this.request<{ message: ChatMessage }>(
      `/api/internal/chat/channels/${encodeURIComponent(params.channelId)}/messages`,
      {
        method: "POST",
        internal: true,
        body: JSON.stringify({
          userId: params.userId,
          content: params.content,
          parentId: params.parentId ?? null,
          attachments: params.attachments ?? [],
        }),
      },
    );
    return body.message;
  }

  async editMessage(params: {
    userId: string;
    messageId: string;
    content: string;
  }): Promise<ChatMessage> {
    const body = await this.request<{ message: ChatMessage }>(
      `/api/internal/chat/messages/${encodeURIComponent(params.messageId)}`,
      {
        method: "PATCH",
        internal: true,
        body: JSON.stringify({ userId: params.userId, content: params.content }),
      },
    );
    return body.message;
  }

  async deleteMessage(params: { userId: string; messageId: string }): Promise<void> {
    await this.request(
      `/api/internal/chat/messages/${encodeURIComponent(
        params.messageId,
      )}?userId=${encodeURIComponent(params.userId)}`,
      { method: "DELETE", internal: true },
    );
  }

  async addReaction(params: { userId: string; messageId: string; emoji: string }): Promise<void> {
    await this.request(
      `/api/internal/chat/messages/${encodeURIComponent(params.messageId)}/reactions`,
      {
        method: "POST",
        internal: true,
        body: JSON.stringify({ userId: params.userId, emoji: params.emoji }),
      },
    );
  }

  async removeReaction(params: {
    userId: string;
    messageId: string;
    emoji: string;
  }): Promise<void> {
    const qs = new URLSearchParams({
      userId: params.userId,
      emoji: params.emoji,
    });
    await this.request(
      `/api/internal/chat/messages/${encodeURIComponent(
        params.messageId,
      )}/reactions?${qs.toString()}`,
      { method: "DELETE", internal: true },
    );
  }
}
