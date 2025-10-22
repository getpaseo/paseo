import { WebSocketServer, WebSocket } from "ws";
import { Server as HTTPServer } from "http";
import { parse as parseUrl } from "url";
import {
  WSInboundMessageSchema,
  type WSOutboundMessage,
  extractSessionMessage,
  wrapSessionMessage,
} from "./messages.js";
import { Session } from "./session.js";
import { loadConversation } from "./persistence.js";

/**
 * WebSocket server that routes messages between clients and their sessions.
 * This is a thin transport layer with no business logic.
 */
export class VoiceAssistantWebSocketServer {
  private wss: WebSocketServer;
  private sessions: Map<WebSocket, Session> = new Map();
  private conversationIdToWs: Map<string, WebSocket> = new Map();
  private clientIdCounter: number = 0;

  constructor(server: HTTPServer) {
    this.wss = new WebSocketServer({ server, path: "/ws" });

    this.wss.on("connection", (ws, request) => {
      this.handleConnection(ws, request);
    });

    console.log("✓ WebSocket server initialized on /ws");
  }

  /**
   * Handle new WebSocket connection
   */
  private async handleConnection(ws: WebSocket, request: any): Promise<void> {
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
      console.error(`[WS] Client error:`, error);
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

      console.log(`[WS] Received message type: ${message.type}`, message);

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
            const session = this.sessions.get(ws);
            if (session) {
              await session.handleMessage(sessionMessage);
            } else {
              console.error("[WS] No session found for client");
            }
          }
          return;
      }
    } catch (error: any) {
      console.error("[WS] Failed to parse/handle message:", error);
      // Send error to client
      this.sendToClient(
        ws,
        wrapSessionMessage({
          type: "status",
          payload: {
            status: "error",
            message: `Invalid message: ${error.message}`,
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
      ws.close();
    });
    await Promise.all(cleanupPromises);
    this.wss.close();
  }
}
