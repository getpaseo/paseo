import { Room } from "@colyseus/core";
import type { Client } from "@colyseus/core";
import { nanoid } from "nanoid";
import { SharedSessionState, Participant, QueuedMessage } from "./schema.js";
import { AuthService, type ValidatedUser } from "../services/auth-service.js";
import { DaemonBridge } from "../services/daemon-bridge.js";

interface RoomCreateOptions {
  shareId: string;
  daemonSessionId: string;
  serverId: string;
  accessLevel: string;
  daemonUrl: string;
}

interface JoinOptions {
  shareToken: string;
  sessionToken: string;
}

interface AuthData extends ValidatedUser {
  shareToken: string;
  sessionToken: string;
}

interface ChatToAgentMessage {
  content: string;
}

export class SharedSessionRoom extends Room<SharedSessionState> {
  private authService!: AuthService;
  private daemonBridge!: DaemonBridge;
  private isProcessingQueue = false;
  private shareToken = "";
  private authWatcher: NodeJS.Timeout | null = null;

  onCreate(options: RoomCreateOptions): void {
    console.log(`[room] onCreate roomId=${this.roomId} options=`, options);
    this.setState(new SharedSessionState());
    this.state.shareId = options.shareId;
    this.state.accessLevel = options.accessLevel;
    this.state.agentStatus = "idle";

    this.authService = new AuthService();

    // Connect to daemon for message forwarding + status tracking (optional —
    // workspace shares don't always have a reachable daemon URL)
    if (options.daemonUrl) {
      this.daemonBridge = new DaemonBridge(options.daemonUrl, options.daemonSessionId);
      this.daemonBridge.onAgentStatus((status) => {
        this.state.agentStatus = status;
      });
      this.daemonBridge.connect();
    }

    // Register message handlers
    this.onMessage("chat_to_agent", (client, message: ChatToAgentMessage) => {
      this.handleChatToAgent(client, message);
    });

    // `chat_authored` is sent by participants when they submit a message
    // directly to the daemon (bypassing the Colyseus queue). We only need to
    // relay the author metadata so other clients can label the bubble.
    this.onMessage("chat_authored", (client, message: { content?: string }) => {
      const auth = (client as any).auth as AuthData | undefined;
      if (!auth) return;
      const content = String(message?.content ?? "").trim();
      if (!content) return;
      this.broadcast(
        "chat_message",
        {
          userId: auth.userId,
          username: auth.username,
          avatarUrl: auth.avatarUrl,
          content,
          ts: Date.now(),
        },
        { except: client },
      );
    });

    // Collaborative drawing: fire-and-forget broadcast, no state persisted.
    this.onMessage("draw_stroke", (client, message: any) => {
      const auth = (client as any).auth as AuthData | undefined;
      if (!auth) return;
      this.broadcast(
        "draw_stroke",
        {
          ...message,
          userId: auth.userId,
          username: auth.username,
          avatarUrl: auth.avatarUrl,
        },
        { except: client },
      );
    });

    this.onMessage("draw_clear", (client) => {
      const auth = (client as any).auth as AuthData | undefined;
      if (!auth) return;
      this.broadcast("draw_clear", { userId: auth.userId }, { except: client });
    });

    // Auto-dispose after 5 minutes with no clients
    this.autoDispose = true;

    // Periodically revalidate each connected client's session against the
    // auth-server. When a session expires (401/403) we push a `session_expired`
    // message over the existing WS and force-leave them — no client-side polling
    // needed.
    this.authWatcher = setInterval(() => void this.revalidateAllSessions(), 60_000);
  }

  private async revalidateAllSessions(): Promise<void> {
    for (const client of [...this.clients]) {
      const auth = (client as any).auth as AuthData | undefined;
      if (!auth?.sessionToken || !auth.shareToken) continue;
      const result = await this.authService.validateShareToken(auth.shareToken, auth.sessionToken);
      if (!result.allowed) {
        console.warn(
          `[room] session expired client=${client.sessionId} user=${auth.username} reason="${result.reason ?? "unknown"}"`,
        );
        try {
          client.send("session_expired", { reason: result.reason ?? "session expired" });
        } catch {}
        try {
          client.leave(4001, "auth-expired");
        } catch {}
      }
    }
  }

  async onAuth(client: Client, options: JoinOptions): Promise<AuthData> {
    console.log(
      `[room] onAuth attempt client=${client.sessionId} shareToken=${options.shareToken?.slice(0, 8)}...`,
    );
    const validation = await this.authService.validateShareToken(
      options.shareToken,
      options.sessionToken,
    );

    if (!validation.allowed || !validation.user) {
      console.warn(
        `[room] onAuth DENIED client=${client.sessionId} reason="${validation.reason ?? "unknown"}"`,
      );
      throw new Error(validation.reason ?? "Access denied");
    }

    console.log(
      `[room] onAuth OK client=${client.sessionId} user=${validation.user.username} isOwner=${validation.user.isOwner}`,
    );
    return {
      ...validation.user,
      shareToken: options.shareToken,
      sessionToken: options.sessionToken,
    };
  }

  onJoin(client: Client, _options: JoinOptions | undefined, auth: AuthData | undefined): void {
    if (!auth) throw new Error("onJoin called without auth — onAuth should have rejected");
    console.log(
      `[room] onJoin client=${client.sessionId} user=${auth.username} roomId=${this.roomId}`,
    );
    // Key by sessionId (unique per Colyseus connection) NOT by userId — otherwise
    // multiple tabs/reconnects from the same user would overwrite + delete each
    // other from state.participants, leaving the map empty.
    const participant = new Participant();
    participant.userId = auth.userId;
    participant.username = auth.username;
    participant.avatarUrl = auth.avatarUrl;
    participant.role = auth.isOwner
      ? "owner"
      : this.state.accessLevel === "full_access"
        ? "collaborator"
        : "viewer";
    participant.audioEnabled = false;
    participant.isOnline = true;
    participant.joinedAt = Date.now();

    this.state.participants.set(client.sessionId, participant);
    console.log(
      `[room] after set — participants.size=${this.state.participants.size} keys=${JSON.stringify(
        Array.from(this.state.participants.keys()),
      )}`,
    );

    // Store auth data on client for later use
    (client as any).auth = auth;

    // Store share token for API calls
    if (!this.shareToken) this.shareToken = auth.shareToken;

    // Track in auth-server (fire-and-forget)
    void this.authService.recordJoin(this.shareToken, auth.userId);

    // Broadcast plain-JSON snapshot as a custom message. The schema state
    // sync for nested MapSchema was not reaching clients in some environments;
    // this custom channel guarantees every client has the full participant list.
    this.broadcastParticipantsSnapshot();
  }

  async onLeave(client: Client, consented?: boolean): Promise<void> {
    const auth = (client as any).auth as AuthData | undefined;
    console.log(
      `[room] onLeave client=${client.sessionId} user=${auth?.username ?? "?"} consented=${consented} isOwner=${auth?.isOwner}`,
    );
    void consented;
    if (!auth) return;

    // Immediate delete keyed by sessionId (matches onJoin). Browser refreshes +
    // reconnects create fresh sessionIds, so there's no point keeping stale
    // entries around — client-side dedup by userId handles visual continuity.
    if (this.state.participants.has(client.sessionId)) {
      this.state.participants.delete(client.sessionId);
    }

    void this.authService.recordLeave(this.shareToken, auth.userId);

    // Owner leaving the call (clicking "Sair") does NOT end the session for
    // recipients. They stay connected and just see their own participant in
    // the bar. The room auto-disposes once the last client is gone.
    this.broadcastParticipantsSnapshot();
  }

  onDispose(): void {
    console.log(`[room] onDispose roomId=${this.roomId}`);
    if (this.authWatcher) {
      clearInterval(this.authWatcher);
      this.authWatcher = null;
    }
    this.daemonBridge?.disconnect();
  }

  private broadcastParticipantsSnapshot(): void {
    // Prune stale entries whose sessionId is no longer among the actively
    // connected clients. Browser refreshes or abrupt closes can leave ghost
    // sessions if onLeave didn't fire cleanly, so we reconcile on every
    // snapshot to guarantee the client-visible list matches reality.
    const liveSessionIds = new Set(this.clients.map((c) => c.sessionId));
    const staleKeys: string[] = [];
    this.state.participants.forEach((_, key) => {
      if (!liveSessionIds.has(key)) staleKeys.push(key);
    });
    for (const key of staleKeys) {
      this.state.participants.delete(key);
    }
    if (staleKeys.length > 0) {
      console.log(
        `[room] pruned ${staleKeys.length} stale participant entries: ${staleKeys.join(",")}`,
      );
    }

    // Dedupe by userId so each real user is represented once even if they
    // have multiple tabs open. Pick the most recent session per user.
    const byUserId = new Map<
      string,
      {
        sessionId: string;
        userId: string;
        username: string;
        avatarUrl: string;
        role: string;
        audioEnabled: boolean;
        isOnline: boolean;
        joinedAt: number;
      }
    >();
    this.state.participants.forEach((p, key) => {
      const existing = byUserId.get(p.userId);
      if (existing && existing.joinedAt >= p.joinedAt) return;
      byUserId.set(p.userId, {
        sessionId: key,
        userId: p.userId,
        username: p.username,
        avatarUrl: p.avatarUrl,
        role: p.role,
        audioEnabled: p.audioEnabled,
        isOnline: p.isOnline,
        joinedAt: p.joinedAt,
      });
    });
    const list = Array.from(byUserId.values());
    console.log(
      `[room] broadcasting participants_list — userCount=${list.length} rawSessions=${this.state.participants.size}`,
    );
    this.broadcast("participants_list", { participants: list });
  }

  // ---------------------------------------------------------------------------
  // Message handlers
  // ---------------------------------------------------------------------------

  private handleChatToAgent(client: Client, message: ChatToAgentMessage): void {
    const auth = (client as any).auth as AuthData | undefined;
    if (!auth) return;

    const participant = this.state.participants.get(auth.userId);

    // Permission check
    if (this.state.accessLevel === "read_only" && participant?.role !== "owner") {
      client.send("error", { message: "This session is read-only" });
      return;
    }

    if (!message.content?.trim()) return;
    const content = message.content.trim();

    // Broadcast author info so every connected client (host + other recipients)
    // can label the resulting agent user-message with the sender's name +
    // avatar. Fire-and-forget; no state persisted.
    this.broadcast("chat_message", {
      userId: auth.userId,
      username: auth.username,
      avatarUrl: auth.avatarUrl,
      content,
      ts: Date.now(),
    });

    // Add to FIFO queue
    const queued = new QueuedMessage();
    queued.id = nanoid();
    queued.userId = auth.userId;
    queued.username = auth.username;
    queued.content = content;
    queued.queuedAt = Date.now();
    queued.status = "queued";
    this.state.messageQueue.push(queued);

    void this.processQueue();
  }

  // ---------------------------------------------------------------------------
  // FIFO queue processing
  // ---------------------------------------------------------------------------

  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue) return;

    const next = this.state.messageQueue.find((m: QueuedMessage) => m.status === "queued");
    if (!next) return;

    this.isProcessingQueue = true;
    next.status = "processing";

    try {
      await this.daemonBridge.sendMessage(next.content, next.userId);
      next.status = "sent";
    } catch {
      // Retry on next cycle
      next.status = "queued";
    }

    // Remove sent messages
    for (let i = this.state.messageQueue.length - 1; i >= 0; i--) {
      if (this.state.messageQueue[i]?.status === "sent") {
        this.state.messageQueue.splice(i, 1);
      }
    }

    this.isProcessingQueue = false;

    // Process next in queue
    void this.processQueue();
  }
}
