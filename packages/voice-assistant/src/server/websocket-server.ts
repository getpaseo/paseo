import { WebSocketServer, WebSocket } from "ws";
import { Server as HTTPServer } from "http";
import {
  WSInboundMessageSchema,
  type WSOutboundMessage,
  extractSessionMessage,
  wrapSessionMessage,
} from "./messages.js";
import { Session } from "./session.js";

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

    this.wss.on("connection", (ws) => {
      this.handleConnection(ws);
    });

    console.log("✓ WebSocket server initialized on /ws");
  }

  /**
   * Handle new WebSocket connection
   */
  private handleConnection(ws: WebSocket): void {
    // Generate unique client ID
    const clientId = `client-${++this.clientIdCounter}`;

    // Create session with message emission callback
    const session = new Session(clientId, (msg) => {
      this.sendToClient(ws, wrapSessionMessage(msg));
    });

    // Store session and reverse mapping
    this.sessions.set(ws, session);
    this.conversationIdToWs.set(session.getConversationId(), ws);

    console.log(
      `[WS] Client connected: ${clientId} with conversation ${session.getConversationId()} (total: ${this.sessions.size})`
    );

    // Send welcome message
    this.sendToClient(ws, wrapSessionMessage({
      type: "status",
      payload: {
        status: "connected",
        message: "WebSocket connection established",
      },
    }));

    // Set up message handler
    ws.on("message", (data) => {
      this.handleMessage(ws, data);
    });

    // Set up close handler
    ws.on("close", () => {
      const session = this.sessions.get(ws);
      if (!session) return;

      console.log(
        `[WS] Client disconnected: ${clientId} (total: ${this.sessions.size - 1})`
      );

      // Clean up session
      session.cleanup();

      // Remove from maps
      this.sessions.delete(ws);
      this.conversationIdToWs.delete(session.getConversationId());

      console.log(`[WS] Conversation ${session.getConversationId()} deleted`);
    });

    // Set up error handler
    ws.on("error", (error) => {
      console.error(`[WS] Client error:`, error);
      const session = this.sessions.get(ws);
      if (!session) return;

      // Clean up session
      session.cleanup();

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

      console.log(`[WS] Received message type: ${message.type}`);

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
      this.sendToClient(ws, wrapSessionMessage({
        type: "status",
        payload: {
          status: "error",
          message: `Invalid message: ${error.message}`,
        },
      }));
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
  public close(): void {
    this.sessions.forEach((session, ws) => {
      session.cleanup();
      ws.close();
    });
    this.wss.close();
  }
}
