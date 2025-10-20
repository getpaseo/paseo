import { v4 as uuidv4 } from "uuid";
import { synthesizeSpeech } from "./tts-openai.js";
import type { SessionOutboundMessage } from "../messages.js";

interface PendingPlayback {
  resolve: () => void;
  reject: (error: Error) => void;
}

/**
 * Per-session TTS manager
 * Handles TTS audio generation and playback confirmation tracking
 */
export class TTSManager {
  private pendingPlaybacks: Map<string, PendingPlayback> = new Map();
  private readonly sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /**
   * Generate TTS audio, emit to client, and wait for playback confirmation
   * Returns a Promise that resolves when the client confirms playback completed
   */
  public async generateAndWaitForPlayback(
    text: string,
    emitMessage: (msg: SessionOutboundMessage) => void
  ): Promise<void> {
    // Generate TTS audio
    const { audio, format } = await synthesizeSpeech(text);

    // Create unique ID for this audio segment
    const audioId = uuidv4();

    // Create promise that will be resolved when client confirms playback
    const playbackPromise = new Promise<void>((resolve, reject) => {
      // Store handlers (no timeout - will resolve when client confirms or connection closes)
      this.pendingPlaybacks.set(audioId, { resolve, reject });
    });

    // Emit audio output message
    emitMessage({
      type: "audio_output",
      payload: {
        id: audioId,
        audio: audio.toString("base64"),
        format,
      },
    });

    console.log(
      `[TTS-Manager ${this.sessionId}] ${new Date().toISOString()} Sent audio ${audioId}, waiting for playback...`
    );

    // Wait for playback confirmation
    await playbackPromise;

    console.log(
      `[TTS-Manager ${this.sessionId}] ${new Date().toISOString()} Audio ${audioId} playback confirmed`
    );
  }

  /**
   * Called when client confirms audio playback completed
   * Resolves the corresponding promise
   */
  public confirmAudioPlayed(audioId: string): void {
    const pending = this.pendingPlaybacks.get(audioId);

    if (!pending) {
      console.warn(
        `[TTS-Manager ${this.sessionId}] Received confirmation for unknown audio ID: ${audioId}`
      );
      return;
    }

    // Resolve promise and cleanup
    pending.resolve();
    this.pendingPlaybacks.delete(audioId);
  }

  /**
   * Cleanup all pending playbacks
   */
  public cleanup(): void {
    // Reject all pending playbacks
    for (const [audioId, pending] of this.pendingPlaybacks.entries()) {
      pending.reject(new Error("Session closed"));
      this.pendingPlaybacks.delete(audioId);
    }
  }
}
