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

type ProcessingPhase = 'idle' | 'transcribing' | 'llm';

/**
 * Encapsulates all state for a single WebSocket client session
 */
class ClientSession {
  public readonly clientId: string;
  public readonly conversationId: string;
  public abortController: AbortController;
  public processingPhase: ProcessingPhase = 'idle';
  public pendingAudioSegments: Array<{audio: Buffer, format: string}> = [];
  public bufferTimeout: NodeJS.Timeout | null = null;
  public audioBuffer: { chunks: Buffer[]; format: string } | null = null;

  constructor(clientId: string, conversationId: string) {
    this.clientId = clientId;
    this.conversationId = conversationId;
    this.abortController = new AbortController();
  }

  /**
   * Create a new AbortController, aborting the previous one
   */
  public createAbortController(): AbortController {
    this.abortController.abort();
    this.abortController = new AbortController();
    return this.abortController;
  }

  /**
   * Set the processing phase for this session
   */
  public setPhase(phase: ProcessingPhase): void {
    this.processingPhase = phase;
    console.log(`[Session ${this.clientId}] Phase set to '${phase}'`);
  }

  /**
   * Clean up all session resources
   */
  public cleanup(): void {
    // Abort any ongoing operations
    this.abortController.abort();

    // Clear buffer timeout
    if (this.bufferTimeout) {
      clearTimeout(this.bufferTimeout);
      this.bufferTimeout = null;
    }

    // Clear buffers
    this.pendingAudioSegments = [];
    this.audioBuffer = null;
  }
}

export class VoiceAssistantWebSocketServer {
  private wss: WebSocketServer;
  private sessions: Map<WebSocket, ClientSession> = new Map();
  private conversationIdToWs: Map<string, WebSocket> = new Map(); // Reverse map for phase management
  private messageHandler?: (conversationId: string, message: string, abortSignal: AbortSignal) => Promise<void>;
  private audioHandler?: (conversationId: string, audio: Buffer, format: string, abortSignal: AbortSignal) => Promise<string>;
  private clientIdCounter: number = 0;

  constructor(server: HTTPServer) {
    this.wss = new WebSocketServer({ server, path: "/ws" });

    this.wss.on("connection", (ws) => {
      this.handleConnection(ws);
    });

    console.log("✓ WebSocket server initialized on /ws");
  }

  private handleConnection(ws: WebSocket): void {
    // Generate unique client ID and conversation
    const clientId = `client-${++this.clientIdCounter}`;
    const conversationId = createConversation();

    // Create session for this client
    const session = new ClientSession(clientId, conversationId);
    this.sessions.set(ws, session);
    this.conversationIdToWs.set(conversationId, ws);

    console.log(
      `[WS] Client connected: ${clientId} with conversation ${conversationId} (total: ${this.sessions.size})`
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
      const session = this.sessions.get(ws);
      if (!session) return;

      console.log(`[WS] Client disconnected: ${session.clientId} (total: ${this.sessions.size - 1})`);

      // Clean up session
      session.cleanup();
      deleteConversation(session.conversationId);

      // Remove from maps
      this.sessions.delete(ws);
      this.conversationIdToWs.delete(session.conversationId);

      console.log(`[WS] Conversation ${session.conversationId} deleted`);
    });

    ws.on("error", (error) => {
      console.error("[WS] Client error:", error);
      const session = this.sessions.get(ws);
      if (!session) return;

      // Clean up session
      session.cleanup();
      deleteConversation(session.conversationId);

      // Remove from maps
      this.sessions.delete(ws);
      this.conversationIdToWs.delete(session.conversationId);
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
          const session = this.sessions.get(ws);
          if (!session) {
            console.error("[WS] No session found for client");
            break;
          }

          // Create new abort controller for this request (aborts previous one)
          const newController = session.createAbortController();

          if (this.messageHandler) {
            await this.messageHandler(session.conversationId, payload.message, newController.signal);
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

        case "abort_request":
          // Handle abort request from client (e.g., when VAD detects new speech)
          await this.handleAbortRequest(ws);
          break;

        default:
          console.warn(`[WS] Unknown message type: ${message.type}`);
      }
    } catch (error) {
      console.error("[WS] Failed to parse message:", error);
    }
  }

  private async handleAbortRequest(ws: WebSocket): Promise<void> {
    const session = this.sessions.get(ws);
    if (!session) return;

    console.log(`[WS] Abort request received, current phase: ${session.processingPhase}`);

    if (session.processingPhase === 'llm') {
      // Already in LLM phase - abort immediately
      session.abortController.abort();
      console.log(`[WS] Aborted LLM processing`);

      // Reset phase to idle
      session.setPhase('idle');

      // Clear any pending segments and timeouts
      session.pendingAudioSegments = [];
      if (session.bufferTimeout) {
        clearTimeout(session.bufferTimeout);
        session.bufferTimeout = null;
      }
    } else if (session.processingPhase === 'transcribing') {
      // Still in STT phase - we'll buffer the next audio
      // Don't abort yet, just set a flag by keeping the current abort controller
      console.log(`[WS] Will buffer next audio segment (currently transcribing)`);
      // Phase stays as 'transcribing', handleAudioChunk will handle buffering
    }
    // If idle, nothing to do
  }

  private sendToClient(ws: WebSocket, message: WebSocketMessage): void {
    if (ws.readyState === 1) {
      // WebSocket.OPEN = 1
      ws.send(JSON.stringify(message));
    }
  }

  public broadcast(message: WebSocketMessage): void {
    const payload = JSON.stringify(message);
    this.sessions.forEach((_session, client) => {
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

  public setPhaseForConversation(conversationId: string, phase: ProcessingPhase): void {
    const ws = this.conversationIdToWs.get(conversationId);
    if (ws) {
      const session = this.sessions.get(ws);
      if (session) {
        session.setPhase(phase);
      }
    } else {
      console.warn(`[WS] Cannot set phase for unknown conversation ${conversationId}`);
    }
  }

  private async handleAudioChunk(
    ws: WebSocket,
    payload: AudioChunkPayload
  ): Promise<void> {
    try {
      const session = this.sessions.get(ws);
      if (!session) {
        console.error("[WS] No session found for WebSocket");
        return;
      }

      // Decode base64 audio data
      const audioBuffer = Buffer.from(payload.audio, "base64");

      if (!payload.isLast) {
        // Buffer the chunk
        if (!session.audioBuffer) {
          session.audioBuffer = {
            chunks: [],
            format: payload.format,
          };
        }
        session.audioBuffer.chunks.push(audioBuffer);
        console.log(
          `[WS] Buffered audio chunk (${audioBuffer.length} bytes, total chunks: ${session.audioBuffer.chunks.length})`
        );
      } else {
        // Last chunk - complete audio segment received
        const allChunks = session.audioBuffer
          ? [...session.audioBuffer.chunks, audioBuffer]
          : [audioBuffer];
        const format = session.audioBuffer?.format || payload.format;

        // Concatenate all chunks for this segment
        const currentSegmentAudio = Buffer.concat(allChunks);
        console.log(
          `[WS] Complete audio segment received (${currentSegmentAudio.length} bytes, ${allChunks.length} chunks)`
        );

        // Clear chunk buffer
        session.audioBuffer = null;

        // Decision: buffer or process?
        const shouldBuffer = session.processingPhase === 'transcribing' && session.pendingAudioSegments.length === 0;

        if (shouldBuffer) {
          // Currently transcribing first segment - buffer this one
          console.log(`[WS] Buffering audio segment (phase: ${session.processingPhase})`);
          session.pendingAudioSegments.push({ audio: currentSegmentAudio, format });

          // Set timeout to process buffer if no more audio arrives
          this.setBufferTimeout(ws, session.conversationId);
        } else if (session.pendingAudioSegments.length > 0) {
          // We have buffered segments - add this one and process all together
          session.pendingAudioSegments.push({ audio: currentSegmentAudio, format });
          console.log(`[WS] Processing ${session.pendingAudioSegments.length} buffered audio segments together`);

          // Clear pending segments and timeout
          const pendingSegments = [...session.pendingAudioSegments];
          session.pendingAudioSegments = [];
          if (session.bufferTimeout) {
            clearTimeout(session.bufferTimeout);
            session.bufferTimeout = null;
          }

          // Concatenate all segments
          const allSegmentAudios = pendingSegments.map(s => s.audio);
          const combinedAudio = Buffer.concat(allSegmentAudios);

          // Process combined audio
          await this.processAudio(ws, session.conversationId, combinedAudio, format);
        } else {
          // Normal flow - no buffering needed
          await this.processAudio(ws, session.conversationId, currentSegmentAudio, format);
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

  private async processAudio(
    ws: WebSocket,
    conversationId: string,
    audio: Buffer,
    format: string
  ): Promise<void> {
    const session = this.sessions.get(ws);
    if (!session) return;

    // Create new abort controller for this request (aborts previous one)
    const newAbortController = session.createAbortController();

    // Set phase to transcribing
    session.setPhase('transcribing');

    if (this.audioHandler) {
      this.broadcastActivityLog({
        id: Date.now().toString(),
        timestamp: new Date(),
        type: "system",
        content: "Transcribing audio...",
      });

      try {
        const transcript = await this.audioHandler(conversationId, audio, format, newAbortController.signal);

        // Send transcription result back to client
        this.sendToClient(ws, {
          type: "transcription_result",
          payload: { text: transcript },
        });

        // Phase management is now handled by the audioHandler in index.ts
        // It will set phase to 'llm' before LLM processing and 'idle' after completion
      } catch (error: any) {
        // If error occurs, reset to idle as safety net
        session.setPhase('idle');
        throw error;
      }
    } else {
      console.warn("[WS] No audio handler registered");
      session.setPhase('idle');
    }
  }

  private setBufferTimeout(ws: WebSocket, conversationId: string): void {
    const session = this.sessions.get(ws);
    if (!session) return;

    // Clear any existing timeout
    if (session.bufferTimeout) {
      clearTimeout(session.bufferTimeout);
    }

    // Set new timeout (10 seconds)
    session.bufferTimeout = setTimeout(async () => {
      console.log(`[WS] Buffer timeout reached, processing pending segments`);

      if (session.pendingAudioSegments.length > 0) {
        // Concatenate all pending segments
        const pendingSegments = [...session.pendingAudioSegments];
        const allSegmentAudios = pendingSegments.map(s => s.audio);
        const combinedAudio = Buffer.concat(allSegmentAudios);
        const format = pendingSegments[0].format;

        // Clear pending segments
        session.pendingAudioSegments = [];
        session.bufferTimeout = null;

        // Process combined audio
        await this.processAudio(ws, conversationId, combinedAudio, format);
      }
    }, 10000); // 10 second timeout
  }

  public close(): void {
    this.sessions.forEach((_session, ws) => {
      ws.close();
    });
    this.wss.close();
  }
}
