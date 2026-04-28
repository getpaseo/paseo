import type pino from "pino";
import type { Readable } from "node:stream";
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

type TtsSegment = {
  index: number;
  text: string;
};

type PreparedTtsSegment = TtsSegment & {
  format: string;
  stream: Readable;
};

type PreparedSegmentResult =
  | { kind: "prepared"; prepared: PreparedTtsSegment }
  | { kind: "aborted" }
  | { kind: "error"; error: unknown };

const MAX_TTS_SEGMENT_CHARS = 260;
const TTS_PREFETCH_SEGMENTS = 2;
const CLOSED_AUDIO_ID_TTL_MS = 10_000;

function splitOversizedFragment(fragment: string, maxChars: number): string[] {
  const trimmed = fragment.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.length <= maxChars) {
    return [trimmed];
  }

  const clauseChunks = trimmed.split(/(?<=[,;:])\s+/);
  if (clauseChunks.length > 1) {
    const parts: string[] = [];
    let current = "";

    const pushCurrent = () => {
      const value = current.trim();
      if (value) {
        parts.push(value);
      }
      current = "";
    };

    for (const clause of clauseChunks) {
      const clauseText = clause.trim();
      if (!clauseText) {
        continue;
      }

      if (clauseText.length > maxChars) {
        pushCurrent();
        parts.push(...splitOversizedFragment(clauseText, maxChars));
        continue;
      }

      if (!current) {
        current = clauseText;
        continue;
      }

      const candidate = `${current} ${clauseText}`;
      if (candidate.length <= maxChars) {
        current = candidate;
        continue;
      }

      pushCurrent();
      current = clauseText;
    }

    pushCurrent();
    if (parts.length > 1 || parts[0] !== trimmed) {
      return parts;
    }
  }

  const parts: string[] = [];
  let remaining = trimmed;
  while (remaining.length > maxChars) {
    let idx = remaining.lastIndexOf(" ", maxChars);
    if (idx < Math.floor(maxChars * 0.5)) {
      idx = maxChars;
    }
    parts.push(remaining.slice(0, idx).trim());
    remaining = remaining.slice(idx).trim();
  }
  if (remaining.length > 0) {
    parts.push(remaining);
  }
  return parts;
}

function splitTextForTts(text: string): TtsSegment[] {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) {
    throw new Error("Cannot synthesize empty text");
  }

  const sentences = normalized.split(/(?<=[.!?])\s+/);
  const parts: TtsSegment[] = [];
  let segmentIndex = 0;

  for (const sentence of sentences) {
    const fragments = splitOversizedFragment(sentence, MAX_TTS_SEGMENT_CHARS);
    for (const fragment of fragments) {
      parts.push({ index: segmentIndex, text: fragment });
      segmentIndex += 1;
    }
  }

  return parts;
}

/**
 * Per-session TTS manager
 * Handles TTS audio generation and playback confirmation tracking
 */
export class TTSManager {
  private pendingPlaybacks: Map<string, PendingPlayback> = new Map();
  private readonly recentlyClosedAudioIds: Map<string, number> = new Map();
  private readonly logger: pino.Logger;
  private readonly resolveTts: () => TextToSpeechProvider | null;

  constructor(
    sessionId: string,
    logger: pino.Logger,
    tts: Resolvable<TextToSpeechProvider | null>,
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
    isVoiceMode: boolean,
  ): Promise<void> {
    const ttsStartMs = Date.now();
    this.logger.info(
      {
        isVoiceMode,
        textLength: text.length,
        text,
      },
      "TTS input text",
    );

    const segments = splitTextForTts(text);
    this.logger.info(
      {
        segmentCount: segments.length,
        segments: segments.map((s) => ({
          index: s.index,
          chars: s.text.length,
          text: s.text.slice(0, 80),
        })),
      },
      `TTS split into ${segments.length} segment(s)`,
    );

    const inflight = new Map<number, Promise<PreparedSegmentResult>>();
    let nextSegmentToSchedule = 0;

    const scheduleNextSegments = () => {
      while (nextSegmentToSchedule < segments.length && inflight.size < TTS_PREFETCH_SEGMENTS) {
        const segment = segments[nextSegmentToSchedule]!;
        inflight.set(segment.index, this.scheduleSegmentSynthesis(segment, abortSignal));
        nextSegmentToSchedule += 1;
      }
    };

    scheduleNextSegments();

    try {
      for (const segment of segments) {
        if (abortSignal.aborted) {
          this.logger.debug("Aborted before emitting segmented audio");
          return;
        }

        const synthWaitStart = Date.now();
        const result = await inflight.get(segment.index)!;
        const synthWaitMs = Date.now() - synthWaitStart;
        inflight.delete(segment.index);
        scheduleNextSegments();

        if (result.kind === "aborted") {
          return;
        }

        if (result.kind === "error") {
          throw result.error;
        }

        this.logger.info(
          {
            segmentIndex: segment.index,
            synthWaitMs,
            totalElapsedMs: Date.now() - ttsStartMs,
            chars: segment.text.length,
          },
          `TTS segment ${segment.index} synthesis ready (waited ${synthWaitMs}ms, total ${Date.now() - ttsStartMs}ms)`,
        );

        const emitStart = Date.now();
        await this.emitPreparedSegment({
          prepared: result.prepared,
          emitMessage,
          abortSignal,
          isVoiceMode,
        });
        this.logger.info(
          {
            segmentIndex: segment.index,
            emitAndPlayMs: Date.now() - emitStart,
            totalElapsedMs: Date.now() - ttsStartMs,
          },
          `TTS segment ${segment.index} playback confirmed (emit+play ${Date.now() - emitStart}ms, total ${Date.now() - ttsStartMs}ms)`,
        );

        scheduleNextSegments();
      }
    } finally {
      this.cleanupPrefetchedSegments(inflight);
      this.logger.info(
        { totalMs: Date.now() - ttsStartMs },
        `TTS generateAndWaitForPlayback done (${Date.now() - ttsStartMs}ms)`,
      );
    }
  }

  private async synthesizeSegment(
    segment: TtsSegment,
    abortSignal: AbortSignal,
  ): Promise<PreparedTtsSegment> {
    const resolveStart = Date.now();
    const tts = this.resolveTts();
    if (!tts) {
      throw new Error("TTS not configured");
    }
    const resolveMs = Date.now() - resolveStart;

    if (abortSignal.aborted) {
      throw new Error("TTS synthesis aborted");
    }

    const synthStart = Date.now();
    const { stream, format } = await tts.synthesizeSpeech(segment.text);
    this.logger.info(
      {
        segmentIndex: segment.index,
        resolveMs,
        synthMs: Date.now() - synthStart,
        chars: segment.text.length,
      },
      `TTS segment ${segment.index} synthesized (resolve=${resolveMs}ms, synth=${Date.now() - synthStart}ms, ${segment.text.length} chars)`,
    );

    if (abortSignal.aborted) {
      this.destroySpeechStream(stream);
      throw new Error("TTS synthesis aborted");
    }

    return {
      ...segment,
      stream,
      format,
    };
  }

  private scheduleSegmentSynthesis(
    segment: TtsSegment,
    abortSignal: AbortSignal,
  ): Promise<PreparedSegmentResult> {
    return this.synthesizeSegment(segment, abortSignal).then(
      (prepared) => {
        if (abortSignal.aborted) {
          this.destroySpeechStream(prepared.stream);
          return { kind: "aborted" };
        }
        return { kind: "prepared", prepared };
      },
      (error) => {
        if (abortSignal.aborted) {
          return { kind: "aborted" };
        }
        return { kind: "error", error };
      },
    );
  }

  private cleanupPrefetchedSegments(inflight: Map<number, Promise<PreparedSegmentResult>>): void {
    if (inflight.size === 0) {
      return;
    }

    for (const pending of inflight.values()) {
      void pending.then((result) => {
        if (result.kind === "prepared") {
          this.destroySpeechStream(result.prepared.stream);
        }
      });
    }
  }

  private destroySpeechStream(stream: Readable): void {
    if (typeof stream.destroy === "function" && !stream.destroyed) {
      stream.destroy();
    }
  }

  private pruneRecentlyClosedAudioIds(now: number): void {
    for (const [audioId, expiresAt] of this.recentlyClosedAudioIds.entries()) {
      if (expiresAt <= now) {
        this.recentlyClosedAudioIds.delete(audioId);
      }
    }
  }

  private rememberClosedAudioId(audioId: string): void {
    const now = Date.now();
    this.pruneRecentlyClosedAudioIds(now);
    this.recentlyClosedAudioIds.set(audioId, now + CLOSED_AUDIO_ID_TTL_MS);
  }

  private async emitPreparedSegment(params: {
    prepared: PreparedTtsSegment;
    emitMessage: (msg: SessionOutboundMessage) => void;
    abortSignal: AbortSignal;
    isVoiceMode: boolean;
  }): Promise<void> {
    const { prepared, emitMessage, abortSignal, isVoiceMode } = params;
    const { stream, format, text } = prepared;

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

    onAbort = () => {
      this.logger.debug("Aborted while waiting for playback");
      pendingPlayback.streamEnded = true;
      pendingPlayback.pendingChunks = 0;
      this.pendingPlaybacks.delete(audioId);
      this.rememberClosedAudioId(audioId);
      playbackResolve();
      this.destroySpeechStream(stream);
    };

    abortSignal.addEventListener("abort", onAbort, { once: true });

    try {
      const buffers: Buffer[] = [];
      for await (const chunk of stream) {
        if (abortSignal.aborted) {
          this.logger.debug("Aborted during stream collection");
          break;
        }
        buffers.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }

      if (!abortSignal.aborted && buffers.length > 0) {
        const fullBuffer = Buffer.concat(buffers);
        const chunkId = `${audioId}:0`;
        pendingPlayback.pendingChunks = 1;

        emitMessage({
          type: "audio_output",
          payload: {
            id: chunkId,
            groupId: audioId,
            chunkIndex: 0,
            isLastChunk: true,
            audio: fullBuffer.toString("base64"),
            format,
            isVoiceMode,
          },
        });
      }

      pendingPlayback.streamEnded = true;

      if (pendingPlayback.pendingChunks === 0) {
        this.pendingPlaybacks.delete(audioId);
        this.rememberClosedAudioId(audioId);
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
      this.destroySpeechStream(stream);
    }

    if (abortSignal.aborted) {
      return;
    }

    this.logger.debug({ audioId, textLength: text.length }, "Audio playback confirmed");
  }

  /**
   * Called when client confirms audio playback completed
   * Resolves the corresponding promise
   */
  public confirmAudioPlayed(chunkId: string): void {
    const [audioId] = chunkId.includes(":") ? chunkId.split(":") : [chunkId];
    const pending = this.pendingPlaybacks.get(audioId);

    if (!pending) {
      const now = Date.now();
      this.pruneRecentlyClosedAudioIds(now);
      const expiresAt = this.recentlyClosedAudioIds.get(audioId);
      if (expiresAt && expiresAt > now) {
        this.logger.debug({ chunkId }, "Ignoring late confirmation for recently closed audio ID");
        return;
      }
      this.logger.warn({ chunkId }, "Received confirmation for unknown audio ID");
      return;
    }

    pending.pendingChunks = Math.max(0, pending.pendingChunks - 1);

    if (pending.pendingChunks === 0 && pending.streamEnded) {
      pending.resolve();
      this.pendingPlaybacks.delete(audioId);
      this.rememberClosedAudioId(audioId);
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
      "Cancelling pending playbacks",
    );

    for (const [audioId, pending] of this.pendingPlaybacks.entries()) {
      pending.resolve();
      this.pendingPlaybacks.delete(audioId);
      this.rememberClosedAudioId(audioId);
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
      this.rememberClosedAudioId(audioId);
    }
  }
}
