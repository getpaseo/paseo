import { WebSocketServer, WebSocket } from "ws";
import { Server as HTTPServer } from "http";
import type {
  WebSocketMessage,
  ActivityLogEntry,
  AudioChunkPayload,
  AudioPlayedPayload,
} from "./types.js";
import { confirmAudioPlayed } from "./agent/tts-manager.js";
import { createConversation, deleteConversation } from "./agent/orchestrator.js";

export class VoiceAssistantWebSocketServer {
  private wss: WebSocketServer;
  private clients: Map<WebSocket, string> = new Map(); // Map ws to client ID
  private conversationIds: Map<WebSocket, string> = new Map(); // Map ws to conversation ID
  private abortControllers: Map<WebSocket, AbortController> = new Map(); // Map ws to AbortController
  private messageHandler?: (conversationId: string, message: string, abortSignal: AbortSignal) => Promise<void>;
  private audioHandler?: (conversationId: string, audio: Buffer, format: string, abortSignal: AbortSignal) => Promise<string>;
  private audioBuffers: Map<string, { chunks: Buffer[]; format: string }> =
    new Map();
  private clientIdCounter: number = 0;

  constructor(server: HTTPServer) {
    this.wss = new WebSocketServer({ server, path: "/ws" });

    this.wss.on("connection", (ws) => {
      this.handleConnection(ws);
    });

    console.log("✓ WebSocket server initialized on /ws");
  }

  private handleConnection(ws: WebSocket): void {
    // Generate unique client ID
    const clientId = `client-${++this.clientIdCounter}`;
    this.clients.set(ws, clientId);

    // Create new conversation for this client
    const conversationId = createConversation();
    this.conversationIds.set(ws, conversationId);

    // Create AbortController for this client
    const abortController = new AbortController();
    this.abortControllers.set(ws, abortController);

    console.log(
      `[WS] Client connected: ${clientId} with conversation ${conversationId} (total: ${this.clients.size})`
    );

    // Send welcome message
    this.sendToClient(ws, {
      type: "status",
      payload: {
        status: "connected",
        message: "WebSocket connection established",
      },
    });

    ws.on("message", (data) => {
      this.handleMessage(ws, data);
    });

    ws.on("close", () => {
      const clientId = this.clients.get(ws);
      const conversationId = this.conversationIds.get(ws);
      const abortController = this.abortControllers.get(ws);

      // Abort any ongoing operations
      if (abortController) {
        abortController.abort();
        this.abortControllers.delete(ws);
        console.log(`[WS] Aborted operations for ${clientId}`);
      }

      if (clientId) {
        this.clients.delete(ws);
        console.log(
          `[WS] Client disconnected: ${clientId} (total: ${this.clients.size})`
        );
      }

      if (conversationId) {
        deleteConversation(conversationId);
        this.conversationIds.delete(ws);
        console.log(`[WS] Conversation ${conversationId} deleted`);
      }
    });

    ws.on("error", (error) => {
      console.error("[WS] Client error:", error);
      const clientId = this.clients.get(ws);
      const conversationId = this.conversationIds.get(ws);
      const abortController = this.abortControllers.get(ws);

      // Abort any ongoing operations
      if (abortController) {
        abortController.abort();
        this.abortControllers.delete(ws);
      }

      if (clientId) {
        this.clients.delete(ws);
      }

      if (conversationId) {
        deleteConversation(conversationId);
        this.conversationIds.delete(ws);
      }
    });
  }

  private async handleMessage(
    ws: WebSocket,
    data: Buffer | ArrayBuffer | Buffer[]
  ): Promise<void> {
    try {
      const message = JSON.parse(data.toString()) as WebSocketMessage;

      console.log(`[WS] Received message type: ${message.type}`);

      switch (message.type) {
        case "ping":
          this.sendToClient(ws, { type: "pong", payload: {} });
          break;

        case "user_message":
          // Handle user message through orchestrator
          const payload = message.payload as { message: string };
          const conversationId = this.conversationIds.get(ws);
          const abortController = this.abortControllers.get(ws);
          if (!conversationId) {
            console.error("[WS] No conversation found for client");
            break;
          }
          if (!abortController) {
            console.error("[WS] No abort controller found for client");
            break;
          }
          if (this.messageHandler) {
            await this.messageHandler(conversationId, payload.message, abortController.signal);
          } else {
            console.warn("[WS] No message handler registered");
          }
          break;

        case "audio_chunk":
          // Handle audio chunk for STT
          await this.handleAudioChunk(ws, message.payload as AudioChunkPayload);
          break;

        case "audio_played":
          // Handle audio playback confirmation
          const audioPlayedPayload = message.payload as AudioPlayedPayload;
          confirmAudioPlayed(audioPlayedPayload.id);
          break;

        default:
          console.warn(`[WS] Unknown message type: ${message.type}`);
      }
    } catch (error) {
      console.error("[WS] Failed to parse message:", error);
    }
  }

  private sendToClient(ws: WebSocket, message: WebSocketMessage): void {
    if (ws.readyState === 1) {
      // WebSocket.OPEN = 1
      ws.send(JSON.stringify(message));
    }
  }

  public broadcast(message: WebSocketMessage): void {
    const payload = JSON.stringify(message);
    this.clients.forEach((_clientId, client) => {
      if (client.readyState === 1) {
        // WebSocket.OPEN = 1
        client.send(payload);
      }
    });
  }

  public broadcastActivityLog(entry: ActivityLogEntry): void {
    this.broadcast({
      type: "activity_log",
      payload: entry,
    });
  }

  public broadcastStatus(
    status: string,
    metadata?: Record<string, unknown>
  ): void {
    this.broadcast({
      type: "status",
      payload: { status, ...metadata },
    });
  }

  public setMessageHandler(handler: (conversationId: string, message: string, abortSignal: AbortSignal) => Promise<void>): void {
    this.messageHandler = handler;
  }

  public setAudioHandler(
    handler: (conversationId: string, audio: Buffer, format: string, abortSignal: AbortSignal) => Promise<string>
  ): void {
    this.audioHandler = handler;
  }

  private async handleAudioChunk(
    ws: WebSocket,
    payload: AudioChunkPayload
  ): Promise<void> {
    try {
      // Use client-specific key for buffering
      const clientId = this.clients.get(ws);
      if (!clientId) {
        console.error("[WS] No client ID found for WebSocket");
        return;
      }

      // Get conversation ID for this client
      const conversationId = this.conversationIds.get(ws);
      if (!conversationId) {
        console.error("[WS] No conversation found for client");
        return;
      }

      // Decode base64 audio data
      const audioBuffer = Buffer.from(payload.audio, "base64");

      if (!payload.isLast) {
        // Buffer the chunk
        if (!this.audioBuffers.has(clientId)) {
          this.audioBuffers.set(clientId, {
            chunks: [],
            format: payload.format,
          });
        }
        const buffer = this.audioBuffers.get(clientId)!;
        buffer.chunks.push(audioBuffer);
        console.log(
          `[WS] Buffered audio chunk (${audioBuffer.length} bytes, total chunks: ${buffer.chunks.length})`
        );
      } else {
        // Last chunk - process complete audio
        const buffer = this.audioBuffers.get(clientId);
        const allChunks = buffer
          ? [...buffer.chunks, audioBuffer]
          : [audioBuffer];
        const format = buffer?.format || payload.format;

        // Concatenate all chunks
        const completeAudio = Buffer.concat(allChunks);
        console.log(
          `[WS] Complete audio received (${completeAudio.length} bytes, ${allChunks.length} chunks)`
        );

        // Clear buffer
        this.audioBuffers.delete(clientId);

        // Process audio through handler (STT)
        const abortController = this.abortControllers.get(ws);
        if (!abortController) {
          console.error("[WS] No abort controller found for client");
          return;
        }

        if (this.audioHandler) {
          this.broadcastActivityLog({
            id: Date.now().toString(),
            timestamp: new Date(),
            type: "system",
            content: "Transcribing audio...",
          });

          const transcript = await this.audioHandler(conversationId, completeAudio, format, abortController.signal);

          // Send transcription result back to client
          this.sendToClient(ws, {
            type: "transcription_result",
            payload: { text: transcript },
          });
        } else {
          console.warn("[WS] No audio handler registered");
        }
      }
    } catch (error: any) {
      console.error("[WS] Audio chunk handling error:", error);
      this.broadcastActivityLog({
        id: Date.now().toString(),
        timestamp: new Date(),
        type: "error",
        content: `Audio processing error: ${error.message}`,
      });
    }
  }

  public close(): void {
    this.clients.forEach((_clientId, ws) => {
      ws.close();
    });
    this.wss.close();
  }
}
