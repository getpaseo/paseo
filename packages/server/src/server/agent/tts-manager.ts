import { v4 as uuidv4 } from "uuid";
import { synthesizeSpeech } from "./tts-openai.js";
import type { SessionOutboundMessage } from "../messages.js";

interface PendingPlayback {
  resolve: () => void;
  reject: (error: Error) => void;
  pendingChunks: number;
  streamEnded: boolean;
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
    emitMessage: (msg: SessionOutboundMessage) => void,
    abortSignal: AbortSignal,
    isRealtimeMode: boolean
  ): Promise<void> {
    if (abortSignal.aborted) {
      console.log(
        `[TTS-Manager ${this.sessionId}] Aborted before generating audio`
      );
      return;
    }

    // Generate TTS audio stream
    const { stream, format } = await synthesizeSpeech(text);

    if (abortSignal.aborted) {
      console.log(
        `[TTS-Manager ${this.sessionId}] Aborted after generating audio`
      );
      return;
    }

    const audioId = uuidv4();
    let playbackResolve!: () => void;
    let playbackReject!: (error: Error) => void;

    const playbackPromise = new Promise<void>((resolve, reject) => {
      playbackResolve = resolve;
      playbackReject = reject;
    });

    const pendingPlayback: PendingPlayback = {
      resolve: playbackResolve,
      reject: playbackReject,
      pendingChunks: 0,
      streamEnded: false,
    };

    this.pendingPlaybacks.set(audioId, pendingPlayback);

    let onAbort: (() => void) | undefined;
    const destroyStream = () => {
      if (typeof stream.destroy === "function" && !stream.destroyed) {
        stream.destroy();
      }
    };

    onAbort = () => {
      console.log(
        `[TTS-Manager ${this.sessionId}] Aborted while waiting for playback`
      );
      pendingPlayback.streamEnded = true;
      pendingPlayback.pendingChunks = 0;
      this.pendingPlaybacks.delete(audioId);
      playbackResolve();
      destroyStream();
    };

    abortSignal.addEventListener("abort", onAbort, { once: true });

    try {
      const iterator = stream[Symbol.asyncIterator]();
      let chunkIndex = 0;
      let current = await iterator.next();

      if (!current.done) {
        let next = await iterator.next();

        while (true) {
          if (abortSignal.aborted) {
            console.log(
              `[TTS-Manager ${this.sessionId}] Aborted during stream emission`
            );
            break;
          }

          const chunkBuffer = Buffer.isBuffer(current.value)
            ? current.value
            : Buffer.from(current.value);

          const chunkId = `${audioId}:${chunkIndex}`;
          pendingPlayback.pendingChunks += 1;

          emitMessage({
            type: "audio_output",
            payload: {
              id: chunkId,
              groupId: audioId,
              chunkIndex,
              isLastChunk: next.done,
              audio: chunkBuffer.toString("base64"),
              format,
              isRealtimeMode,
            },
          });

          console.log(
            `[TTS-Manager ${this.sessionId}] ${new Date().toISOString()} Sent audio chunk ${chunkId}${
              next.done ? " (last)" : ""
            }`
          );

          chunkIndex += 1;

          if (next.done) {
            break;
          }

          current = next;
          next = await iterator.next();
        }
      }

      pendingPlayback.streamEnded = true;

      if (pendingPlayback.pendingChunks === 0) {
        this.pendingPlaybacks.delete(audioId);
        playbackResolve();
      }

      await playbackPromise;
    } catch (error) {
      if (abortSignal.aborted) {
        console.log(
          `[TTS-Manager ${this.sessionId}] Audio stream closed after abort`
        );
      } else {
        console.error(
          `[TTS-Manager ${this.sessionId}] Error streaming audio`,
          error
        );
        this.pendingPlaybacks.delete(audioId);
        pendingPlayback.reject(error as Error);
        throw error;
      }
    } finally {
      if (onAbort) {
        abortSignal.removeEventListener("abort", onAbort);
      }
      destroyStream();
    }

    if (abortSignal.aborted) {
      return;
    }

    console.log(
      `[TTS-Manager ${
        this.sessionId
      }] ${new Date().toISOString()} Audio ${audioId} playback confirmed`
    );
  }

  /**
   * Called when client confirms audio playback completed
   * Resolves the corresponding promise
   */
  public confirmAudioPlayed(chunkId: string): void {
    const [audioId] = chunkId.includes(":")
      ? chunkId.split(":")
      : [chunkId];
    const pending = this.pendingPlaybacks.get(audioId);

    if (!pending) {
      console.warn(
        `[TTS-Manager ${this.sessionId}] Received confirmation for unknown audio ID: ${chunkId}`
      );
      return;
    }

    pending.pendingChunks = Math.max(0, pending.pendingChunks - 1);

    if (pending.pendingChunks === 0 && pending.streamEnded) {
      pending.resolve();
      this.pendingPlaybacks.delete(audioId);
    }
  }

  /**
   * Cancel all pending playbacks (e.g., user interrupted audio)
   */
  public cancelPendingPlaybacks(reason: string): void {
    if (this.pendingPlaybacks.size === 0) {
      return;
    }

    console.log(
      `[TTS-Manager ${this.sessionId}] Cancelling ${this.pendingPlaybacks.size} pending playback(s): ${reason}`
    );

    for (const [audioId, pending] of this.pendingPlaybacks.entries()) {
      pending.resolve();
      this.pendingPlaybacks.delete(audioId);
      console.log(
        `[TTS-Manager ${this.sessionId}] Cleared pending playback ${audioId}`
      );
    }
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
