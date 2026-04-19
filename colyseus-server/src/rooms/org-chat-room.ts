import { Room } from "@colyseus/core";
import type { Client } from "@colyseus/core";
import { Schema, type } from "@colyseus/schema";
import { ChatApiClient, ChatApiError } from "../services/chat-api.js";

/**
 * Minimal visible state. History lives in Postgres (via auth-server); clients
 * fetch it over REST. The room only keeps presence — which users are online
 * in the org right now.
 */
export class OrgChatPresence extends Schema {
  @type("string") userId = "";
  @type("string") username = "";
  @type("string") avatarUrl = "";
  @type("number") since = 0;
}

export class OrgChatState extends Schema {
  @type("string") orgId = "";
  @type({ map: OrgChatPresence }) online = new Map<string, OrgChatPresence>();
}

interface OrgChatCreateOptions {
  orgId: string;
}

interface OrgChatJoinOptions {
  sessionToken: string;
  orgId: string;
}

interface OrgChatAuthData {
  userId: string;
  username: string;
  avatarUrl: string;
  channelIds: Set<string>;
}

type SendPayload = {
  channelId?: string;
  content?: string;
  parentId?: string | null;
  attachments?: Array<{
    url: string;
    mimeType: string;
    filename: string;
    sizeBytes: number;
    width?: number | null;
    height?: number | null;
  }>;
};

type TypingPayload = { channelId?: string; parentId?: string | null };

type EditPayload = { messageId?: string; content?: string };

type DeletePayload = { messageId?: string };

type ReactPayload = { messageId?: string; emoji?: string };

export interface OrgChatRoomDeps {
  api?: ChatApiClient;
}

export class OrgChatRoom extends Room<OrgChatState> {
  private api!: ChatApiClient;
  private membershipCache = new Map<string, Set<string>>(); // userId → channelIds
  // channelId → { userIds, fetchedAt }. Populated on first broadcast; reused
  // for every subsequent message/reaction event in that channel so we avoid a
  // REST round-trip per send. Short TTL keeps membership changes roughly fresh.
  private channelMembersCache = new Map<
    string,
    { userIds: Set<string>; fetchedAt: number }
  >();
  private static readonly CHANNEL_MEMBERS_TTL_MS = 30_000;

  static deps: OrgChatRoomDeps = {};

  onCreate(options: OrgChatCreateOptions): void {
    this.api = OrgChatRoom.deps.api ?? new ChatApiClient();
    this.setState(new OrgChatState());
    this.state.orgId = options.orgId;

    this.onMessage("send", (client, msg: SendPayload) => {
      void this.handleSend(client, msg);
    });
    this.onMessage("edit", (client, msg: EditPayload) => {
      void this.handleEdit(client, msg);
    });
    this.onMessage("delete", (client, msg: DeletePayload) => {
      void this.handleDelete(client, msg);
    });
    this.onMessage("react_add", (client, msg: ReactPayload) => {
      void this.handleReaction(client, msg, "add");
    });
    this.onMessage("react_remove", (client, msg: ReactPayload) => {
      void this.handleReaction(client, msg, "remove");
    });
    this.onMessage("typing", (client, msg: TypingPayload) => {
      this.handleTyping(client, msg);
    });
  }

  /**
   * Authenticate the connection. Returns the user data that's attached to the
   * Colyseus client (`client.auth`). Throws if auth fails.
   */
  async onAuth(_client: unknown, options: OrgChatJoinOptions): Promise<OrgChatAuthData> {
    if (!options?.sessionToken) {
      throw new Error("sessionToken required");
    }
    if (!options?.orgId || options.orgId !== this.state.orgId) {
      throw new Error("orgId mismatch");
    }
    const user = await this.api.validateSession(options.sessionToken);
    const isMember = await this.api.isOrgMember(user.id, this.state.orgId);
    if (!isMember) {
      throw new Error("Not a member of this org");
    }
    const channels = await this.api.getUserChannels(user.id);
    const channelIds = new Set(
      channels.filter((c) => c.orgId === this.state.orgId).map((c) => c.id),
    );
    this.membershipCache.set(user.id, channelIds);
    return {
      userId: user.id,
      username: user.name,
      avatarUrl: user.image ?? "",
      channelIds,
    };
  }

  onJoin(client: Client): void {
    const auth = (client as Client & { auth?: OrgChatAuthData }).auth;
    if (!auth) return;
    const presence = new OrgChatPresence();
    presence.userId = auth.userId;
    presence.username = auth.username;
    presence.avatarUrl = auth.avatarUrl;
    presence.since = Date.now();
    this.state.online.set(auth.userId, presence);
  }

  onLeave(client: Client): void {
    const auth = (client as Client & { auth?: OrgChatAuthData }).auth;
    if (!auth) return;
    // Only clear presence if no other client from the same user remains.
    const stillOnline = this.clients.some((c) => {
      if (c === client) return false;
      return (c as Client & { auth?: OrgChatAuthData }).auth?.userId === auth.userId;
    });
    if (!stillOnline) {
      this.state.online.delete(auth.userId);
    }
    this.membershipCache.delete(auth.userId);
  }

  private authOf(client: Client): OrgChatAuthData | null {
    return (client as Client & { auth?: OrgChatAuthData }).auth ?? null;
  }

  private async handleSend(client: Client, msg: SendPayload) {
    const auth = this.authOf(client);
    if (!auth) return;
    if (!msg.channelId || typeof msg.channelId !== "string") {
      client.send("error", { code: "bad_request", error: "channelId required" });
      return;
    }
    try {
      const message = await this.api.sendMessage({
        userId: auth.userId,
        channelId: msg.channelId,
        content: typeof msg.content === "string" ? msg.content : "",
        parentId: msg.parentId ?? null,
        attachments: Array.isArray(msg.attachments) ? msg.attachments : undefined,
      });
      await this.broadcastToChannel(message.channelId, "message", { message });
    } catch (err) {
      this.sendApiError(client, err);
    }
  }

  private async handleEdit(client: Client, msg: EditPayload) {
    const auth = this.authOf(client);
    if (!auth) return;
    if (!msg.messageId || typeof msg.content !== "string") {
      client.send("error", { code: "bad_request", error: "messageId and content required" });
      return;
    }
    try {
      const message = await this.api.editMessage({
        userId: auth.userId,
        messageId: msg.messageId,
        content: msg.content,
      });
      await this.broadcastToChannel(message.channelId, "message_edited", { message });
    } catch (err) {
      this.sendApiError(client, err);
    }
  }

  private async handleDelete(client: Client, msg: DeletePayload) {
    const auth = this.authOf(client);
    if (!auth) return;
    if (!msg.messageId) return;
    try {
      await this.api.deleteMessage({
        userId: auth.userId,
        messageId: msg.messageId,
      });
      // We don't know the channelId after deletion cheaply; broadcast to all
      // clients — they'll ignore if they don't track the message.
      this.broadcast("message_deleted", { messageId: msg.messageId });
    } catch (err) {
      this.sendApiError(client, err);
    }
  }

  private async handleReaction(
    client: Client,
    msg: ReactPayload,
    op: "add" | "remove",
  ) {
    const auth = this.authOf(client);
    if (!auth || !msg.messageId || !msg.emoji) return;
    try {
      if (op === "add") {
        await this.api.addReaction({
          userId: auth.userId,
          messageId: msg.messageId,
          emoji: msg.emoji,
        });
      } else {
        await this.api.removeReaction({
          userId: auth.userId,
          messageId: msg.messageId,
          emoji: msg.emoji,
        });
      }
      this.broadcast(op === "add" ? "reaction_added" : "reaction_removed", {
        messageId: msg.messageId,
        userId: auth.userId,
        emoji: msg.emoji,
      });
    } catch (err) {
      this.sendApiError(client, err);
    }
  }

  private handleTyping(client: Client, msg: TypingPayload) {
    const auth = this.authOf(client);
    if (!auth || !msg.channelId) return;
    if (!auth.channelIds.has(msg.channelId)) return;
    // Best-effort broadcast to channel members; no authz round-trip (it's
    // ephemeral and cheap to spoof).
    const payload = {
      channelId: msg.channelId,
      parentId: msg.parentId ?? null,
      userId: auth.userId,
      username: auth.username,
      at: Date.now(),
    };
    for (const other of this.clients) {
      if (other === client) continue;
      const otherAuth = this.authOf(other);
      if (!otherAuth) continue;
      if (otherAuth.channelIds.has(msg.channelId)) {
        other.send("typing", payload);
      }
    }
  }

  /**
   * Broadcast a payload only to clients whose membership cache includes the
   * given channel. For `public` channels we intentionally also include org
   * members that aren't explicit members (Slack semantics).
   */
  private async broadcastToChannel(
    channelId: string,
    type: string,
    payload: Record<string, unknown>,
  ) {
    const targetUserIds = await this.getChannelMemberIds(channelId);
    for (const c of this.clients) {
      const auth = this.authOf(c);
      if (!auth) continue;
      if (targetUserIds.has(auth.userId) || auth.channelIds.has(channelId)) {
        // Keep the channel membership cache in sync for this client
        auth.channelIds.add(channelId);
        c.send(type, payload);
      }
    }
  }

  private async getChannelMemberIds(channelId: string): Promise<Set<string>> {
    const cached = this.channelMembersCache.get(channelId);
    const now = Date.now();
    if (cached && now - cached.fetchedAt < OrgChatRoom.CHANNEL_MEMBERS_TTL_MS) {
      return cached.userIds;
    }
    try {
      const members = await this.api.getChannelMembers(channelId);
      const userIds = new Set(members.map((m) => m.userId));
      this.channelMembersCache.set(channelId, { userIds, fetchedAt: now });
      return userIds;
    } catch {
      // Reuse stale cache if the request fails — better to fan out to last
      // known members than to drop the event entirely.
      return cached?.userIds ?? new Set<string>();
    }
  }

  /**
   * Invalidate a channel's member cache so the next broadcast re-fetches.
   * Called when we learn about membership changes via room events.
   */
  private invalidateChannelMembers(channelId: string) {
    this.channelMembersCache.delete(channelId);
  }

  private sendApiError(client: Client, err: unknown) {
    if (err instanceof ChatApiError) {
      client.send("error", { status: err.status, code: err.code, error: err.message });
    } else {
      console.error("[org-chat] unexpected error", err);
      client.send("error", { code: "internal", error: "Internal error" });
    }
  }
}
