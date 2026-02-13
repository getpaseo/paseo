import type pino from "pino";
import { v4 as uuidv4 } from "uuid";
import type { TextToSpeechProvider } from "../speech/speech-provider.js";
import { toResolver, type Resolvable } from "../speech/provider-resolver.js";
import type { SessionOutboundMessage } from "../messages.js";

interface PendingPlayback {
  resolve: () => void;
  reject: (error: Error) => void;
  pendingChunks: number;
  streamEnded: boolean;
}

const MAX_TTS_SEGMENT_CHARS = 400;

function splitTextForTts(text: string, maxChars: number): string[] {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) {
    throw new Error("Cannot synthesize empty text");
  }

  if (normalized.length <= maxChars) {
    return [normalized];
  }

  const parts: string[] = [];
  const sentenceChunks = normalized.split(/(?<=[.!?])\s+/);

  let current = "";
  const pushCurrent = () => {
    const trimmed = current.trim();
    if (trimmed.length > 0) {
      parts.push(trimmed);
    }
    current = "";
  };

  const appendFragment = (fragment: string) => {
    const trimmed = fragment.trim();
    if (!trimmed) {
      return;
    }

    if (!current) {
      current = trimmed;
      return;
    }

    const candidate = `${current} ${trimmed}`;
    if (candidate.length <= maxChars) {
      current = candidate;
      return;
    }

    pushCurrent();
    current = trimmed;
  };

  const splitLargeFragment = (fragment: string): string[] => {
    const trimmed = fragment.trim();
    if (trimmed.length <= maxChars) {
      return [trimmed];
    }

    const out: string[] = [];
    let remaining = trimmed;
    while (remaining.length > maxChars) {
      let idx = remaining.lastIndexOf(" ", maxChars);
      if (idx < Math.floor(maxChars * 0.5)) {
        idx = maxChars;
      }
      out.push(remaining.slice(0, idx).trim());
      remaining = remaining.slice(idx).trim();
    }
    if (remaining.length > 0) {
      out.push(remaining);
    }
    return out;
  };

  for (const sentence of sentenceChunks) {
    const fragments = splitLargeFragment(sentence);
    for (const fragment of fragments) {
      appendFragment(fragment);
    }
  }
  pushCurrent();

  return parts;
}

/**
 * Per-session TTS manager
 * Handles TTS audio generation and playback confirmation tracking
 */
export class TTSManager {
  private pendingPlaybacks: Map<string, PendingPlayback> = new Map();
  private readonly logger: pino.Logger;
  private readonly resolveTts: () => TextToSpeechProvider | null;

  constructor(
    sessionId: string,
    logger: pino.Logger,
    tts: Resolvable<TextToSpeechProvider | null>
  ) {
    this.logger = logger.child({ module: "agent", component: "tts-manager", sessionId });
    this.resolveTts = toResolver(tts);
  }

  /**
   * Generate TTS audio, emit to client, and wait for playback confirmation
   * Returns a Promise that resolves when the client confirms playback completed
   */
  public async generateAndWaitForPlayback(
    text: string,
    emitMessage: (msg: SessionOutboundMessage) => void,
    abortSignal: AbortSignal,
    isVoiceMode: boolean
  ): Promise<void> {
    this.logger.info(
      {
        isVoiceMode,
        textLength: text.length,
        text,
      },
      "TTS input text"
    );

    const segments = splitTextForTts(text, MAX_TTS_SEGMENT_CHARS);
    for (const segment of segments) {
      if (abortSignal.aborted) {
        this.logger.debug("Aborted before generating segmented audio");
        return;
      }

      await this.generateSegmentAndWaitForPlayback(
        segment,
        emitMessage,
        abortSignal,
        isVoiceMode
      );
    }
  }

  private async generateSegmentAndWaitForPlayback(
    text: string,
    emitMessage: (msg: SessionOutboundMessage) => void,
    abortSignal: AbortSignal,
    isVoiceMode: boolean
  ): Promise<void> {
    const tts = this.resolveTts();
    if (!tts) {
      throw new Error("TTS not configured");
    }

    if (abortSignal.aborted) {
      this.logger.debug("Aborted before generating audio");
      return;
    }

    // Generate TTS audio stream
    const { stream, format } = await tts.synthesizeSpeech(text);

    if (abortSignal.aborted) {
      this.logger.debug("Aborted after generating audio");
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
      this.logger.debug("Aborted while waiting for playback");
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
            this.logger.debug("Aborted during stream emission");
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
              isVoiceMode,
            },
          });

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
        this.logger.debug("Audio stream closed after abort");
      } else {
        this.logger.error({ err: error }, "Error streaming audio");
        this.pendingPlaybacks.delete(audioId);
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

    this.logger.debug({ audioId }, "Audio playback confirmed");
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
      this.logger.warn({ chunkId }, "Received confirmation for unknown audio ID");
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

    this.logger.debug(
      { count: this.pendingPlaybacks.size, reason },
      "Cancelling pending playbacks"
    );

    for (const [audioId, pending] of this.pendingPlaybacks.entries()) {
      pending.resolve();
      this.pendingPlaybacks.delete(audioId);
      this.logger.debug({ audioId }, "Cleared pending playback");
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
