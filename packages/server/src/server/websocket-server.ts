import { WebSocketServer, WebSocket } from "ws";
import { Server as HTTPServer } from "http";
import type { IncomingMessage } from "http";
import { parse as parseUrl } from "url";
import {
  WSInboundMessageSchema,
  type WSOutboundMessage,
  extractSessionMessage,
  wrapSessionMessage,
} from "./messages.js";
import { Session } from "./session.js";
import { loadConversation } from "./persistence.js";
import { AgentManager } from "./agent/agent-manager.js";
import { AgentRegistry } from "./agent/agent-registry.js";
import type { AgentProvider } from "./agent/agent-sdk-types.js";
import { DownloadTokenStore } from "./file-download/token-store.js";
import { PushTokenStore } from "./push/token-store.js";
import { PushService } from "./push/push-service.js";

type AgentMcpClientConfig = {
  agentMcpUrl: string;
  agentMcpHeaders?: Record<string, string>;
};

/**
 * WebSocket server that routes messages between clients and their sessions.
 * This is a thin transport layer with no business logic.
 */
export class VoiceAssistantWebSocketServer {
  private wss: WebSocketServer;
  private sessions: Map<WebSocket, Session> = new Map();
  private conversationIdToWs: Map<string, WebSocket> = new Map();
  private clientIdCounter: number = 0;
  private agentManager: AgentManager;
  private agentRegistry: AgentRegistry;
  private downloadTokenStore: DownloadTokenStore;
  private pushTokenStore: PushTokenStore;
  private pushService: PushService;
  private readonly agentMcpConfig: AgentMcpClientConfig;

  constructor(
    server: HTTPServer,
    agentManager: AgentManager,
    agentRegistry: AgentRegistry,
    downloadTokenStore: DownloadTokenStore,
    agentMcpConfig: AgentMcpClientConfig
  ) {
    this.agentManager = agentManager;
    this.agentRegistry = agentRegistry;
    this.downloadTokenStore = downloadTokenStore;
    this.pushTokenStore = new PushTokenStore();
    this.pushService = new PushService(this.pushTokenStore);
    this.agentMcpConfig = agentMcpConfig;
    this.wss = new WebSocketServer({ server, path: "/ws" });

    this.wss.on("connection", (ws, request) => {
      this.handleConnection(ws, request);
    });

    this.agentManager.setAgentAttentionCallback((params) => {
      this.broadcastAgentAttention(params);
    });

    console.log("✓ WebSocket server initialized on /ws");
  }

  /**
   * Handle new WebSocket connection
   */
  private async handleConnection(ws: WebSocket, request: IncomingMessage): Promise<void> {
    // Generate unique client ID
    const clientId = `client-${++this.clientIdCounter}`;

    // Extract conversation ID from URL query parameter if present
    const url = parseUrl(request.url || "", true);
    const conversationId = url.query.conversationId as string | undefined;

    // Load conversation if ID provided
    let initialMessages = null;
    if (conversationId) {
      console.log(
        `[WS] Client requesting conversation ${conversationId}`
      );
      initialMessages = await loadConversation(conversationId);

      if (initialMessages) {
        console.log(
          `[WS] Loaded conversation ${conversationId} with ${initialMessages.length} messages`
        );
      } else {
        console.log(
          `[WS] Conversation ${conversationId} not found, starting fresh`
        );
      }
    }

    // Create session with message emission callback
    const session = new Session(
      clientId,
      (msg) => {
        this.sendToClient(ws, wrapSessionMessage(msg));
      },
      this.downloadTokenStore,
      this.pushTokenStore,
      this.agentManager,
      this.agentRegistry,
      this.agentMcpConfig,
      {
        conversationId,
        initialMessages: initialMessages || undefined,
      }
    );

    // Store session and reverse mapping
    this.sessions.set(ws, session);
    this.conversationIdToWs.set(session.getConversationId(), ws);

    console.log(
      `[WS] Client connected: ${clientId} with conversation ${session.getConversationId()} (total: ${
        this.sessions.size
      })`
    );

    // Don't send initial state here - client will request it via load_conversation_request
    // This avoids race condition where message arrives before client sets up listeners

    // Set up message handler
    ws.on("message", (data) => {
      this.handleMessage(ws, data);
    });

    // Set up close handler
    ws.on("close", async () => {
      const session = this.sessions.get(ws);
      if (!session) return;

      console.log(
        `[WS] Client disconnected: ${clientId} (total: ${
          this.sessions.size - 1
        })`
      );

      // Clean up session
      await session.cleanup();

      // Remove from maps
      this.sessions.delete(ws);
      this.conversationIdToWs.delete(session.getConversationId());

      console.log(`[WS] Conversation ${session.getConversationId()} deleted`);
    });

    // Set up error handler
    ws.on("error", async (error) => {
      // Safe error logging
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      const errorStack = error instanceof Error ? error.stack : undefined;
      console.error(`[WS] Client error:`, { message: errorMessage, stack: errorStack });
      const session = this.sessions.get(ws);
      if (!session) return;

      // Clean up session
      await session.cleanup();

      // Remove from maps
      this.sessions.delete(ws);
      this.conversationIdToWs.delete(session.getConversationId());
    });
  }

  /**
   * Handle incoming WebSocket message
   */
  private async handleMessage(
    ws: WebSocket,
    data: Buffer | ArrayBuffer | Buffer[]
  ): Promise<void> {
    try {
      // Parse message
      const parsed = JSON.parse(data.toString());

      // Validate with Zod
      const message = WSInboundMessageSchema.parse(parsed);

      // Safe logging that handles large objects without crashing
      const messageSummary = {
        type: message.type,
        ...(message.type === "session" && message.message ? {
          sessionMessageType: message.message.type,
        } : {}),
      };
      console.log(`[WS] Received message:`, messageSummary);

      // Handle WebSocket-level messages
      switch (message.type) {
        case "ping":
          this.sendToClient(ws, { type: "pong" });
          return;

        case "recording_state":
          console.log(`[WS] Recording state: ${message.isRecording}`);
          return;

        case "session":
          // Extract and forward session message
          const sessionMessage = extractSessionMessage(message);
          if (sessionMessage) {
            // Debug: Log create_agent_request details
            if (sessionMessage.type === "create_agent_request") {
              console.log("[WS] create_agent_request details:", {
                cwd: sessionMessage.config.cwd,
                initialMode: sessionMessage.config.modeId,
                worktreeName: sessionMessage.worktreeName,
                requestId: sessionMessage.requestId,
              });
            }
            
            const session = this.sessions.get(ws);
            if (session) {
              await session.handleMessage(sessionMessage);
            } else {
              console.error("[WS] No session found for client");
            }
          }
          return;
      }
    } catch (error) {
      // Safe error logging - avoid crashing on large/circular objects
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      const errorStack = error instanceof Error ? error.stack : undefined;
      let rawPayload: string | null = null;
      let parsedPayload: unknown = null;

      try {
        const buffer = Array.isArray(data)
          ? Buffer.concat(
              data.map((item) =>
                Buffer.isBuffer(item)
                  ? item
                  : Buffer.from(item as ArrayBuffer)
              )
            )
          : Buffer.isBuffer(data)
            ? data
            : Buffer.from(data as ArrayBuffer);
        rawPayload = buffer.toString();
        parsedPayload = JSON.parse(rawPayload);
      } catch (payloadError) {
        rawPayload = rawPayload ?? "<unreadable>";
        parsedPayload = parsedPayload ?? rawPayload;
        console.error("[WS] Failed to decode raw payload:", payloadError);
      }

      const trimmedRawPayload =
        typeof rawPayload === "string" && rawPayload.length > 2000
          ? `${rawPayload.slice(0, 2000)}... (truncated)`
          : rawPayload;

      console.error("[WS] Failed to parse/handle message:", {
        message: errorMessage,
        stack: errorStack,
        rawPayload: trimmedRawPayload,
        parsedPayload,
      });
      // Send error to client
      this.sendToClient(
        ws,
        wrapSessionMessage({
          type: "status",
          payload: {
            status: "error",
            message: `Invalid message: ${errorMessage}`,
          },
        })
      );
    }
  }

  /**
   * Send message to specific client
   */
  private sendToClient(ws: WebSocket, message: WSOutboundMessage): void {
    if (ws.readyState === 1) {
      // WebSocket.OPEN = 1
      ws.send(JSON.stringify(message));
    }
  }

  /**
   * Broadcast message to all connected clients
   */
  public broadcast(message: WSOutboundMessage): void {
    const payload = JSON.stringify(message);
    this.sessions.forEach((_session, client) => {
      if (client.readyState === 1) {
        // WebSocket.OPEN = 1
        client.send(payload);
      }
    });
  }

  /**
   * Close the WebSocket server
   */
  public async close(): Promise<void> {
    const cleanupPromises: Promise<void>[] = [];
    this.sessions.forEach((session, ws) => {
      cleanupPromises.push(session.cleanup());
      // Wait for WebSocket to actually close before resolving
      cleanupPromises.push(
        new Promise<void>((resolve) => {
          if (ws.readyState === WebSocket.CLOSED) {
            resolve();
            return;
          }
          ws.once("close", () => resolve());
          ws.close();
        })
      );
    });
    await Promise.all(cleanupPromises);
    this.wss.close();
  }

  private readonly ACTIVITY_THRESHOLD_MS = 120_000; // 2 minutes

  /**
   * Get client activity state with computed staleness
   */
  private getClientActivityState(session: Session): {
    deviceType: "web" | "mobile" | null;
    focusedAgentId: string | null;
    isStale: boolean;
    appVisible: boolean;
  } {
    const activity = session.getClientActivity();
    if (!activity) {
      console.log("[WS] getClientActivityState: no activity for session");
      return { deviceType: null, focusedAgentId: null, isStale: true, appVisible: false };
    }
    const now = Date.now();
    const ageMs = now - activity.lastActivityAt.getTime();
    const isStale = ageMs >= this.ACTIVITY_THRESHOLD_MS;
    console.log("[WS] getClientActivityState", {
      deviceType: activity.deviceType,
      focusedAgentId: activity.focusedAgentId,
      lastActivityAt: activity.lastActivityAt.toISOString(),
      ageMs,
      isStale,
      appVisible: activity.appVisible,
    });
    return {
      deviceType: activity.deviceType,
      focusedAgentId: activity.focusedAgentId,
      isStale,
      appVisible: activity.appVisible,
    };
  }

  /**
   * Compute shouldNotify for a specific client given all clients' states
   *
   * UX Rules:
   * 1. If ANY client is actively watching the agent (focused + visible + not stale) → no notifications
   * 2. If THIS client is not stale and focused elsewhere → notify THIS client (user is at computer)
   * 3. If THIS client is stale → only notify if mobile, or if no mobile available
   * 4. Don't notify non-stale clients that aren't focused on anything (just switched tabs)
   */
  private computeShouldNotifyForClient(
    clientState: {
      deviceType: "web" | "mobile" | null;
      focusedAgentId: string | null;
      isStale: boolean;
      appVisible: boolean;
    },
    allClientStates: Array<{
      deviceType: "web" | "mobile" | null;
      focusedAgentId: string | null;
      isStale: boolean;
      appVisible: boolean;
    }>,
    agentId: string
  ): boolean {
    // Rule 1: If any client is actively watching the agent, no one needs notification
    const isAnyoneActiveOnAgent = allClientStates.some(
      (state) =>
        state.focusedAgentId === agentId &&
        state.appVisible &&
        !state.isStale
    );
    if (isAnyoneActiveOnAgent) {
      return false;
    }

    // No heartbeat (legacy client or just connected) → notify
    if (clientState.deviceType === null) {
      return true;
    }

    // Rule 2: If THIS client is not stale and actively looking at a different agent → notify them
    if (!clientState.isStale && clientState.appVisible && clientState.focusedAgentId !== null) {
      return true;
    }

    // Rule 3: If THIS client is not stale but just switched tabs (not focused on anything) → no notification
    // User is present at the computer, they'll come back
    if (!clientState.isStale) {
      return false;
    }

    // Rule 4: THIS client is stale - check if another client will handle it
    const hasActiveWebClient = allClientStates.some(
      (state) => state.deviceType === "web" && !state.isStale
    );

    if (clientState.deviceType === "mobile") {
      // Mobile only notifies if web is also stale (user truly away)
      // If web is active, they'll see it there
      return !hasActiveWebClient;
    }

    if (clientState.deviceType === "web") {
      // Stale web: notify only if no other client can handle it
      // Other client = mobile or unknown (no heartbeat)
      const hasOtherClient = allClientStates.some(
        (state) => state !== clientState && (state.deviceType === "mobile" || state.deviceType === null)
      );
      return !hasOtherClient;
    }

    // Fallback: notify
    return true;
  }

  /**
   * Broadcast an attention_required event to all clients with per-client shouldNotify
   */
  private broadcastAgentAttention(params: {
    agentId: string;
    provider: AgentProvider;
    reason: "finished" | "error" | "permission";
  }): void {
    // Collect all client states first
    const clientEntries: Array<{
      ws: WebSocket;
      state: {
        deviceType: "web" | "mobile" | null;
        focusedAgentId: string | null;
        isStale: boolean;
        appVisible: boolean;
      };
    }> = [];

    for (const [ws, session] of this.sessions) {
      clientEntries.push({
        ws,
        state: this.getClientActivityState(session),
      });
    }

    const allStates = clientEntries.map((e) => e.state);

    console.log("[WS] broadcastAgentAttention", {
      agentId: params.agentId,
      reason: params.reason,
      clientCount: clientEntries.length,
      allStates,
    });

    // Check if all clients are stale - if so, send push notification
    const allClientsStale = allStates.every((state) => state.isStale);
    console.log("[WS] allClientsStale:", allClientsStale);
    if (allClientsStale) {
      const tokens = this.pushTokenStore.getAllTokens();
      console.log("[WS] Sending push notification, tokens:", tokens.length);
      if (tokens.length > 0) {
        void this.pushService.sendPush(tokens, {
          title: "Agent needs attention",
          body: `Reason: ${params.reason}`,
          data: { agentId: params.agentId },
        });
      }
    }

    // Send to each client with their specific shouldNotify value
    for (const { ws, state } of clientEntries) {
      const shouldNotify = this.computeShouldNotifyForClient(
        state,
        allStates,
        params.agentId
      );

      const message = wrapSessionMessage({
        type: "agent_stream",
        payload: {
          agentId: params.agentId,
          event: {
            type: "attention_required",
            provider: params.provider,
            reason: params.reason,
            timestamp: new Date().toISOString(),
            shouldNotify,
          },
          timestamp: new Date().toISOString(),
        },
      });

      this.sendToClient(ws, message);
    }
  }
}
