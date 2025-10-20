import { v4 as uuidv4 } from "uuid";
import { readFile } from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";
import type {
  SessionInboundMessage,
  SessionOutboundMessage,
} from "./messages.js";
import { getSystemPrompt } from "./agent/system-prompt.js";
import { streamLLM, type Message } from "./agent/llm-openai.js";
import { TTSManager } from "./agent/tts-manager.js";
import { STTManager } from "./agent/stt-manager.js";

const execAsync = promisify(exec);

type ProcessingPhase = "idle" | "transcribing" | "llm";

/**
 * Type for present_artifact tool arguments
 */
interface PresentArtifactArgs {
  type: "markdown" | "diff" | "image" | "code";
  source:
    | { type: "file"; path: string }
    | { type: "command_output"; command: string }
    | { type: "text"; text: string };
  title: string;
}

/**
 * Session represents a single client conversation session.
 * It owns all state management, orchestration logic, and message processing.
 * Session has no knowledge of WebSockets - it only emits and receives messages.
 */
export class Session {
  private readonly clientId: string;
  private readonly conversationId: string;
  private readonly onMessage: (msg: SessionOutboundMessage) => void;

  // State machine
  private abortController: AbortController;
  private processingPhase: ProcessingPhase = "idle";

  // Audio buffering for interruption handling
  private pendingAudioSegments: Array<{ audio: Buffer; format: string }> = [];
  private bufferTimeout: NodeJS.Timeout | null = null;
  private audioBuffer: { chunks: Buffer[]; format: string } | null = null;

  // Conversation history
  private messages: Message[] = [];

  // Per-session managers
  private readonly ttsManager: TTSManager;
  private readonly sttManager: STTManager;

  constructor(
    clientId: string,
    onMessage: (msg: SessionOutboundMessage) => void
  ) {
    this.clientId = clientId;
    this.conversationId = uuidv4();
    this.onMessage = onMessage;
    this.abortController = new AbortController();

    // Initialize per-session managers
    this.ttsManager = new TTSManager(this.conversationId);
    this.sttManager = new STTManager(this.conversationId);

    console.log(
      `[Session ${this.clientId}] Created with conversation ${this.conversationId}`
    );
  }

  /**
   * Get the conversation ID for this session
   */
  public getConversationId(): string {
    return this.conversationId;
  }

  /**
   * Main entry point for processing session messages
   */
  public async handleMessage(msg: SessionInboundMessage): Promise<void> {
    try {
      switch (msg.type) {
        case "user_text":
          await this.handleUserText(msg.text);
          break;

        case "audio_chunk":
          await this.handleAudioChunk(msg);
          break;

        case "abort_request":
          await this.handleAbort();
          break;

        case "audio_played":
          this.handleAudioPlayed(msg.id);
          break;
      }
    } catch (error: any) {
      console.error(`[Session ${this.clientId}] Error handling message:`, error);
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Error: ${error.message}`,
        },
      });
    }
  }

  /**
   * Handle text message from user
   */
  private async handleUserText(text: string): Promise<void> {
    // Create new abort controller
    this.createAbortController();

    // Emit user message activity log
    this.emit({
      type: "activity_log",
      payload: {
        id: uuidv4(),
        timestamp: new Date(),
        type: "transcript",
        content: text,
      },
    });

    // Add to conversation
    this.messages.push({ role: "user", content: text });

    // Process through LLM (TTS enabled for text input)
    await this.processWithLLM(true);
  }

  /**
   * Handle audio chunk for buffering and transcription
   */
  private async handleAudioChunk(
    msg: Extract<SessionInboundMessage, { type: "audio_chunk" }>
  ): Promise<void> {
    // Decode base64
    const audioBuffer = Buffer.from(msg.audio, "base64");

    if (!msg.isLast) {
      // Buffer the chunk
      if (!this.audioBuffer) {
        this.audioBuffer = { chunks: [], format: msg.format };
      }
      this.audioBuffer.chunks.push(audioBuffer);
      console.log(
        `[Session ${this.clientId}] Buffered audio chunk (${audioBuffer.length} bytes, total: ${this.audioBuffer.chunks.length})`
      );
    } else {
      // Complete segment received
      const allChunks = this.audioBuffer
        ? [...this.audioBuffer.chunks, audioBuffer]
        : [audioBuffer];
      const format = this.audioBuffer?.format || msg.format;
      const currentSegmentAudio = Buffer.concat(allChunks);

      console.log(
        `[Session ${this.clientId}] Complete audio segment (${currentSegmentAudio.length} bytes, ${allChunks.length} chunks)`
      );

      // Clear chunk buffer
      this.audioBuffer = null;

      // Decision: buffer or process?
      const shouldBuffer =
        this.processingPhase === "transcribing" &&
        this.pendingAudioSegments.length === 0;

      if (shouldBuffer) {
        // Currently transcribing first segment - buffer this one
        console.log(
          `[Session ${this.clientId}] Buffering audio segment (phase: ${this.processingPhase})`
        );
        this.pendingAudioSegments.push({
          audio: currentSegmentAudio,
          format,
        });
        this.setBufferTimeout();
      } else if (this.pendingAudioSegments.length > 0) {
        // We have buffered segments - add this one and process all together
        this.pendingAudioSegments.push({
          audio: currentSegmentAudio,
          format,
        });
        console.log(
          `[Session ${this.clientId}] Processing ${this.pendingAudioSegments.length} buffered segments together`
        );

        // Clear pending segments and timeout
        const pendingSegments = [...this.pendingAudioSegments];
        this.pendingAudioSegments = [];
        this.clearBufferTimeout();

        // Concatenate all segments
        const allSegmentAudios = pendingSegments.map((s) => s.audio);
        const combinedAudio = Buffer.concat(allSegmentAudios);

        await this.processAudio(combinedAudio, format);
      } else {
        // Normal flow - no buffering needed
        await this.processAudio(currentSegmentAudio, format);
      }
    }
  }

  /**
   * Process audio through STT and then LLM
   */
  private async processAudio(audio: Buffer, format: string): Promise<void> {
    this.createAbortController();
    this.setPhase("transcribing");

    this.emit({
      type: "activity_log",
      payload: {
        id: uuidv4(),
        timestamp: new Date(),
        type: "system",
        content: "Transcribing audio...",
      },
    });

    try {
      const result = await this.sttManager.transcribe(audio, format);

      const transcriptText = result.text.trim();
      if (!transcriptText) {
        console.log(
          `[Session ${this.clientId}] Empty transcription, skipping LLM`
        );
        this.setPhase("idle");
        return;
      }

      // Emit transcription result
      this.emit({
        type: "transcription_result",
        payload: {
          text: result.text,
          language: result.language,
          duration: result.duration,
        },
      });

      // Emit activity log
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "transcript",
          content: result.text,
          metadata: {
            language: result.language,
            duration: result.duration,
          },
        },
      });

      // Add to conversation
      this.messages.push({ role: "user", content: result.text });

      // Set phase to LLM and process
      this.setPhase("llm");
      await this.processWithLLM(true); // Enable TTS for voice input
      this.setPhase("idle");
    } catch (error: any) {
      this.setPhase("idle");
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Transcription error: ${error.message}`,
        },
      });
      throw error;
    }
  }

  /**
   * Process user message through LLM with streaming and tool execution
   */
  private async processWithLLM(enableTTS: boolean): Promise<void> {
    let assistantResponse = "";
    let pendingTTS: Promise<void> | null = null;

    try {
      assistantResponse = await streamLLM({
        systemPrompt: getSystemPrompt(),
        messages: this.messages,
        abortSignal: this.abortController.signal,
        onTextSegment: (segment) => {
          if (enableTTS) {
            // Create TTS promise (don't await yet)
            pendingTTS = this.ttsManager.generateAndWaitForPlayback(
              segment,
              (msg) => this.emit(msg)
            );
          }

          // Emit activity log
          this.emit({
            type: "activity_log",
            payload: {
              id: uuidv4(),
              timestamp: new Date(),
              type: "assistant",
              content: segment,
            },
          });
        },
        onChunk: async (chunk) => {
          this.emit({
            type: "assistant_chunk",
            payload: { chunk },
          });
        },
        onToolCall: async (toolCallId, toolName, args) => {
          // Wait for pending TTS before executing tool
          if (pendingTTS) {
            console.log(
              `[Session ${this.clientId}] Waiting for TTS before executing ${toolName}`
            );
            await pendingTTS;
            pendingTTS = null;
          }

          // Handle present_artifact tool specially
          if (toolName === "present_artifact") {
            await this.handlePresentArtifact(toolCallId, args as PresentArtifactArgs);
          }

          // Emit tool call activity log
          this.emit({
            type: "activity_log",
            payload: {
              id: toolCallId,
              timestamp: new Date(),
              type: "tool_call",
              content: `Calling ${toolName}`,
              metadata: { toolCallId, toolName, arguments: args },
            },
          });
        },
        onToolResult: (toolCallId, toolName, result) => {
          this.emit({
            type: "activity_log",
            payload: {
              id: toolCallId,
              timestamp: new Date(),
              type: "tool_result",
              content: `Tool ${toolName} completed`,
              metadata: { toolCallId, toolName, result },
            },
          });
        },
        onToolError: async (toolCallId, toolName, error) => {
          this.emit({
            type: "activity_log",
            payload: {
              id: toolCallId,
              timestamp: new Date(),
              type: "error",
              content: `Tool ${toolName} failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
              metadata: { toolCallId, toolName, error },
            },
          });
        },
        onError: async (error) => {
          this.emit({
            type: "activity_log",
            payload: {
              id: uuidv4(),
              timestamp: new Date(),
              type: "error",
              content: `Stream error: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          });
        },
        onFinish: async () => {
          // Don't wait for TTS here
        },
      });

      // Add assistant response to conversation IMMEDIATELY after stream completes
      this.messages.push({
        role: "assistant",
        content: assistantResponse,
      });

      // Now wait for any pending TTS, but don't fail if it times out
      if (pendingTTS) {
        try {
          await pendingTTS;
        } catch (ttsError) {
          console.error(
            `[Session ${this.clientId}] TTS playback failed (message already saved):`,
            ttsError
          );
        }
      }
    } catch (error) {
      // If stream failed or was aborted, still save any partial response
      if (assistantResponse) {
        this.messages.push({
          role: "assistant",
          content: assistantResponse,
        });
      }

      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Error: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      });
      throw error;
    }
  }

  /**
   * Handle present_artifact tool execution
   */
  private async handlePresentArtifact(
    toolCallId: string,
    args: PresentArtifactArgs
  ): Promise<void> {
    let content: string;
    let isBase64 = false;

    try {
      if (args.source.type === "file") {
        const fileBuffer = await readFile(args.source.path);
        content = fileBuffer.toString("base64");
        isBase64 = true;
      } else if (args.source.type === "command_output") {
        const { stdout } = await execAsync(args.source.command, {
          encoding: "buffer",
        });
        content = stdout.toString("base64");
        isBase64 = true;
      } else if (args.source.type === "text") {
        content = args.source.text;
        isBase64 = false;
      } else {
        content = "[Unknown source type]";
        isBase64 = false;
      }
    } catch (error) {
      console.error(
        `[Session ${this.clientId}] Failed to resolve artifact source:`,
        error
      );
      content = `[Error: ${error instanceof Error ? error.message : String(error)}]`;
      isBase64 = false;
    }

    // Emit artifact message
    this.emit({
      type: "artifact",
      payload: {
        type: args.type,
        id: toolCallId,
        title: args.title,
        content,
        isBase64,
      },
    });

    // Emit activity log for artifact
    this.emit({
      type: "activity_log",
      payload: {
        id: toolCallId,
        timestamp: new Date(),
        type: "system",
        content: `${args.type} artifact: ${args.title}`,
        metadata: { artifactId: toolCallId, artifactType: args.type },
      },
    });
  }

  /**
   * Handle abort request from client
   */
  private async handleAbort(): Promise<void> {
    console.log(
      `[Session ${this.clientId}] Abort request, phase: ${this.processingPhase}`
    );

    if (this.processingPhase === "llm") {
      // Already in LLM phase - abort immediately
      this.abortController.abort();
      console.log(`[Session ${this.clientId}] Aborted LLM processing`);

      // Reset phase to idle
      this.setPhase("idle");

      // Clear any pending segments and timeouts
      this.pendingAudioSegments = [];
      this.clearBufferTimeout();
    } else if (this.processingPhase === "transcribing") {
      // Still in STT phase - we'll buffer the next audio
      console.log(
        `[Session ${this.clientId}] Will buffer next audio (currently transcribing)`
      );
      // Phase stays as 'transcribing', handleAudioChunk will handle buffering
    }
    // If idle, nothing to do
  }

  /**
   * Handle audio playback confirmation from client
   */
  private handleAudioPlayed(id: string): void {
    this.ttsManager.confirmAudioPlayed(id);
  }

  /**
   * Create new AbortController, aborting the previous one
   */
  private createAbortController(): AbortController {
    this.abortController.abort();
    this.abortController = new AbortController();
    return this.abortController;
  }

  /**
   * Set the processing phase
   */
  private setPhase(phase: ProcessingPhase): void {
    this.processingPhase = phase;
    console.log(`[Session ${this.clientId}] Phase: ${phase}`);
  }

  /**
   * Set timeout to process buffered audio segments
   */
  private setBufferTimeout(): void {
    this.clearBufferTimeout();

    this.bufferTimeout = setTimeout(async () => {
      console.log(
        `[Session ${this.clientId}] Buffer timeout reached, processing pending segments`
      );

      if (this.pendingAudioSegments.length > 0) {
        const segments = [...this.pendingAudioSegments];
        this.pendingAudioSegments = [];
        this.bufferTimeout = null;

        const combined = Buffer.concat(segments.map((s) => s.audio));
        await this.processAudio(combined, segments[0].format);
      }
    }, 10000); // 10 second timeout
  }

  /**
   * Clear buffer timeout
   */
  private clearBufferTimeout(): void {
    if (this.bufferTimeout) {
      clearTimeout(this.bufferTimeout);
      this.bufferTimeout = null;
    }
  }

  /**
   * Emit a message to the client
   */
  private emit(msg: SessionOutboundMessage): void {
    this.onMessage(msg);
  }

  /**
   * Clean up session resources
   */
  public cleanup(): void {
    console.log(`[Session ${this.clientId}] Cleaning up`);

    // Abort any ongoing operations
    this.abortController.abort();

    // Clear timeouts
    this.clearBufferTimeout();

    // Clear buffers
    this.pendingAudioSegments = [];
    this.audioBuffer = null;

    // Cleanup managers
    this.ttsManager.cleanup();
    this.sttManager.cleanup();
  }
}
