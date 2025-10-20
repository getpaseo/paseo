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

export class VoiceAssistantWebSocketServer {
  private wss: WebSocketServer;
  private clients: Map<WebSocket, string> = new Map(); // Map ws to client ID
  private conversationIds: Map<WebSocket, string> = new Map(); // Map ws to conversation ID
  private conversationIdToWs: Map<string, WebSocket> = new Map(); // Reverse map: conversation ID to ws
  private abortControllers: Map<WebSocket, AbortController> = new Map(); // Map ws to AbortController
  private messageHandler?: (conversationId: string, message: string, abortSignal: AbortSignal) => Promise<void>;
  private audioHandler?: (conversationId: string, audio: Buffer, format: string, abortSignal: AbortSignal) => Promise<string>;
  private audioBuffers: Map<string, { chunks: Buffer[]; format: string }> =
    new Map();
  private clientIdCounter: number = 0;

  // Audio buffering for interruption handling
  private processingPhases: Map<WebSocket, ProcessingPhase> = new Map();
  private pendingAudioSegments: Map<WebSocket, Array<{audio: Buffer, format: string}>> = new Map();
  private bufferTimeouts: Map<WebSocket, NodeJS.Timeout> = new Map();

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
    this.conversationIdToWs.set(conversationId, ws); // Add reverse mapping

    // Create AbortController for this client
    const abortController = new AbortController();
    this.abortControllers.set(ws, abortController);

    // Initialize processing state
    this.processingPhases.set(ws, 'idle');
    this.pendingAudioSegments.set(ws, []);

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

      // Clear buffer timeout
      const timeout = this.bufferTimeouts.get(ws);
      if (timeout) {
        clearTimeout(timeout);
        this.bufferTimeouts.delete(ws);
      }

      // Clean up state tracking
      this.processingPhases.delete(ws);
      this.pendingAudioSegments.delete(ws);

      if (clientId) {
        this.clients.delete(ws);
        console.log(
          `[WS] Client disconnected: ${clientId} (total: ${this.clients.size})`
        );
      }

      if (conversationId) {
        deleteConversation(conversationId);
        this.conversationIds.delete(ws);
        this.conversationIdToWs.delete(conversationId); // Clean up reverse mapping
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

      // Clear buffer timeout
      const timeout = this.bufferTimeouts.get(ws);
      if (timeout) {
        clearTimeout(timeout);
        this.bufferTimeouts.delete(ws);
      }

      // Clean up state tracking
      this.processingPhases.delete(ws);
      this.pendingAudioSegments.delete(ws);

      if (clientId) {
        this.clients.delete(ws);
      }

      if (conversationId) {
        deleteConversation(conversationId);
        this.conversationIds.delete(ws);
        this.conversationIdToWs.delete(conversationId); // Clean up reverse mapping
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
          if (!conversationId) {
            console.error("[WS] No conversation found for client");
            break;
          }

          // Abort any ongoing request
          const oldController = this.abortControllers.get(ws);
          if (oldController) {
            oldController.abort();
          }

          // Create new abort controller for this request
          const newController = new AbortController();
          this.abortControllers.set(ws, newController);

          if (this.messageHandler) {
            await this.messageHandler(conversationId, payload.message, newController.signal);
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
    const phase = this.processingPhases.get(ws);
    const abortController = this.abortControllers.get(ws);

    console.log(`[WS] Abort request received, current phase: ${phase}`);

    if (phase === 'llm') {
      // Already in LLM phase - abort immediately
      if (abortController) {
        abortController.abort();
        console.log(`[WS] Aborted LLM processing`);
      }

      // Reset phase to idle
      this.processingPhases.set(ws, 'idle');

      // Clear any pending segments from previous interruptions
      this.pendingAudioSegments.set(ws, []);

      // Clear any pending timeout
      const timeout = this.bufferTimeouts.get(ws);
      if (timeout) {
        clearTimeout(timeout);
        this.bufferTimeouts.delete(ws);
      }
    } else if (phase === 'transcribing') {
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

  public setPhaseForConversation(conversationId: string, phase: ProcessingPhase): void {
    const ws = this.conversationIdToWs.get(conversationId);
    if (ws) {
      this.processingPhases.set(ws, phase);
      console.log(`[WS] Phase set to '${phase}' for conversation ${conversationId}`);
    } else {
      console.warn(`[WS] Cannot set phase for unknown conversation ${conversationId}`);
    }
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
        // Last chunk - complete audio segment received
        const buffer = this.audioBuffers.get(clientId);
        const allChunks = buffer
          ? [...buffer.chunks, audioBuffer]
          : [audioBuffer];
        const format = buffer?.format || payload.format;

        // Concatenate all chunks for this segment
        const currentSegmentAudio = Buffer.concat(allChunks);
        console.log(
          `[WS] Complete audio segment received (${currentSegmentAudio.length} bytes, ${allChunks.length} chunks)`
        );

        // Clear chunk buffer
        this.audioBuffers.delete(clientId);

        // Get current phase and pending segments
        const currentPhase = this.processingPhases.get(ws) || 'idle';
        const pendingSegments = this.pendingAudioSegments.get(ws) || [];

        // Decision: buffer or process?
        const shouldBuffer = currentPhase === 'transcribing' && pendingSegments.length === 0;

        if (shouldBuffer) {
          // Currently transcribing first segment - buffer this one
          console.log(`[WS] Buffering audio segment (phase: ${currentPhase})`);
          pendingSegments.push({ audio: currentSegmentAudio, format });
          this.pendingAudioSegments.set(ws, pendingSegments);

          // Set timeout to process buffer if no more audio arrives
          this.setBufferTimeout(ws, conversationId);
        } else if (pendingSegments.length > 0) {
          // We have buffered segments - add this one and process all together
          pendingSegments.push({ audio: currentSegmentAudio, format });
          console.log(`[WS] Processing ${pendingSegments.length} buffered audio segments together`);

          // Clear pending segments and timeout
          this.pendingAudioSegments.set(ws, []);
          const timeout = this.bufferTimeouts.get(ws);
          if (timeout) {
            clearTimeout(timeout);
            this.bufferTimeouts.delete(ws);
          }

          // Concatenate all segments
          const allSegmentAudios = pendingSegments.map(s => s.audio);
          const combinedAudio = Buffer.concat(allSegmentAudios);

          // Process combined audio
          await this.processAudio(ws, conversationId, combinedAudio, format);
        } else {
          // Normal flow - no buffering needed
          await this.processAudio(ws, conversationId, currentSegmentAudio, format);
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
    // Abort any ongoing request
    const oldAbortController = this.abortControllers.get(ws);
    if (oldAbortController) {
      oldAbortController.abort();
    }

    // Create new abort controller for this request
    const newAbortController = new AbortController();
    this.abortControllers.set(ws, newAbortController);

    // Set phase to transcribing
    this.processingPhases.set(ws, 'transcribing');

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
        this.processingPhases.set(ws, 'idle');
        throw error;
      }
    } else {
      console.warn("[WS] No audio handler registered");
      this.processingPhases.set(ws, 'idle');
    }
  }

  private setBufferTimeout(ws: WebSocket, conversationId: string): void {
    // Clear any existing timeout
    const existingTimeout = this.bufferTimeouts.get(ws);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    // Set new timeout (10 seconds)
    const timeout = setTimeout(async () => {
      console.log(`[WS] Buffer timeout reached, processing pending segments`);

      const pendingSegments = this.pendingAudioSegments.get(ws) || [];
      if (pendingSegments.length > 0) {
        // Concatenate all pending segments
        const allSegmentAudios = pendingSegments.map(s => s.audio);
        const combinedAudio = Buffer.concat(allSegmentAudios);
        const format = pendingSegments[0].format;

        // Clear pending segments
        this.pendingAudioSegments.set(ws, []);
        this.bufferTimeouts.delete(ws);

        // Process combined audio
        await this.processAudio(ws, conversationId, combinedAudio, format);
      }
    }, 10000); // 10 second timeout

    this.bufferTimeouts.set(ws, timeout);
  }

  public close(): void {
    this.clients.forEach((_clientId, ws) => {
      ws.close();
    });
    this.wss.close();
  }
}
