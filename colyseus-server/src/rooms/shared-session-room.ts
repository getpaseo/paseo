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
}

interface ChatToAgentMessage {
  content: string;
}

interface WebRTCSignalMessage {
  targetUserId: string;
  kind: "offer" | "answer" | "ice-candidate";
  data: unknown;
}

interface AudioToggleMessage {
  enabled: boolean;
}

export class SharedSessionRoom extends Room<SharedSessionState> {
  private authService!: AuthService;
  private daemonBridge!: DaemonBridge;
  private isProcessingQueue = false;
  private shareToken = "";

  onCreate(options: RoomCreateOptions): void {
    this.setState(new SharedSessionState());
    this.state.shareId = options.shareId;
    this.state.accessLevel = options.accessLevel;
    this.state.agentStatus = "idle";

    this.authService = new AuthService();

    // Connect to daemon for message forwarding + status tracking
    this.daemonBridge = new DaemonBridge(options.daemonUrl, options.daemonSessionId);
    this.daemonBridge.onAgentStatus((status) => {
      this.state.agentStatus = status;
    });
    this.daemonBridge.connect();

    // Register message handlers
    this.onMessage("chat_to_agent", (client, message: ChatToAgentMessage) => {
      this.handleChatToAgent(client, message);
    });

    this.onMessage("webrtc_signal", (client, signal: WebRTCSignalMessage) => {
      this.handleWebRTCSignal(client, signal);
    });

    this.onMessage("audio_toggle", (client, message: AudioToggleMessage) => {
      this.handleAudioToggle(client, message);
    });

    // Auto-dispose after 5 minutes with no clients
    this.autoDispose = true;
  }

  async onAuth(client: Client, options: JoinOptions): Promise<AuthData> {
    const validation = await this.authService.validateShareToken(
      options.shareToken,
      options.sessionToken,
    );

    if (!validation.allowed || !validation.user) {
      throw new Error(validation.reason ?? "Access denied");
    }

    return {
      ...validation.user,
      shareToken: options.shareToken,
    };
  }

  onJoin(client: Client, _options: JoinOptions, auth: AuthData): void {
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

    this.state.participants.set(auth.userId, participant);

    // Store auth data on client for later use
    (client as any).auth = auth;

    // Store share token for API calls
    if (!this.shareToken) this.shareToken = auth.shareToken;

    // Track in auth-server (fire-and-forget)
    void this.authService.recordJoin(this.shareToken, auth.userId);
  }

  async onLeave(client: Client, consented?: boolean): Promise<void> {
    const auth = (client as any).auth as AuthData | undefined;
    if (!auth) return;

    const participant = this.state.participants.get(auth.userId);

    if (!consented && participant) {
      // Allow reconnection — wait 30s
      try {
        participant.isOnline = false;
        await this.allowReconnection(client, 30);
        participant.isOnline = true;
        return;
      } catch {
        // Reconnection timed out
      }
    }

    // Remove participant
    if (participant) {
      this.state.participants.delete(auth.userId);
    }

    void this.authService.recordLeave(this.shareToken, auth.userId);
  }

  onDispose(): void {
    this.daemonBridge.disconnect();
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

    // Add to FIFO queue
    const queued = new QueuedMessage();
    queued.id = nanoid();
    queued.userId = auth.userId;
    queued.username = auth.username;
    queued.content = message.content.trim();
    queued.queuedAt = Date.now();
    queued.status = "queued";
    this.state.messageQueue.push(queued);

    void this.processQueue();
  }

  private handleWebRTCSignal(client: Client, signal: WebRTCSignalMessage): void {
    const auth = (client as any).auth as AuthData | undefined;
    if (!auth) return;

    // Find target client and relay the signal
    for (const c of this.clients) {
      const targetAuth = (c as any).auth as AuthData | undefined;
      if (targetAuth?.userId === signal.targetUserId) {
        c.send("webrtc_signal", {
          fromUserId: auth.userId,
          fromUsername: auth.username,
          kind: signal.kind,
          data: signal.data,
        });
        return;
      }
    }
  }

  private handleAudioToggle(client: Client, message: AudioToggleMessage): void {
    const auth = (client as any).auth as AuthData | undefined;
    if (!auth) return;

    const participant = this.state.participants.get(auth.userId);
    if (participant) {
      participant.audioEnabled = message.enabled;
    }
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
      if (this.state.messageQueue[i].status === "sent") {
        this.state.messageQueue.splice(i, 1);
      }
    }

    this.isProcessingQueue = false;

    // Process next in queue
    void this.processQueue();
  }
}
