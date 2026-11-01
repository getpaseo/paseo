import type pino from "pino";
import type { Readable } from "node:stream";
import { v4 as uuidv4 } from "uuid";
import type { TextToSpeechProvider } from "../speech/speech-provider.js";
import { parsePcmRateFromFormat } from "../speech/audio.js";
import { toResolver, type Resolvable } from "../speech/provider-resolver.js";
import type { SessionOutboundMessage } from "../messages.js";

interface PendingPlayback {
  resolve: () => void;
  reject: (error: Error) => void;
  pendingChunks: number;
  streamEnded: boolean;
  /** True once the client confirmed playback of at least one chunk. */
  confirmed: boolean;
}

/**
 * Outcome of a speak request. The speak tool must never report success when
 * nothing was heard: callers treat {@link TtsPlaybackResult.segmentsEmitted}
 * === 0 as failure (generateAndWaitForPlayback throws in that case).
 */
export interface TtsPlaybackResult {
  segmentsEmitted: number;
  segmentsConfirmed: number;
  aborted: boolean;
}

export interface TtsManagerOptions {
  /**
   * Override for the per-segment playback-confirmation timeout.
   * Production uses a duration-derived value; tests set a small one.
   */
  playbackConfirmTimeoutMs?: number;
}

interface TtsSegment {
  index: number;
  text: string;
}

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
  private readonly options: TtsManagerOptions;

  constructor(
    sessionId: string,
    logger: pino.Logger,
    tts: Resolvable<TextToSpeechProvider | null>,
    options?: TtsManagerOptions,
  ) {
    this.logger = logger.child({ module: "agent", component: "tts-manager", sessionId });
    this.resolveTts = toResolver(tts);
    this.options = options ?? {};
  }

  /**
   * Generate TTS audio, emit to client, and wait for playback confirmation.
   * Resolves with playback counts once every segment was emitted and
   * confirmed (or the request was aborted mid-playback after emitting).
   * Rejects when zero audio was emitted or a segment was emitted but the
   * client never confirmed playback — the caller must surface that as a
   * speak failure, never as playback success.
   */
  public async generateAndWaitForPlayback(
    text: string,
    emitMessage: (msg: SessionOutboundMessage) => void,
    abortSignal: AbortSignal,
    isVoiceMode: boolean,
  ): Promise<TtsPlaybackResult> {
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
        const segment = segments[nextSegmentToSchedule];
        inflight.set(segment.index, this.scheduleSegmentSynthesis(segment, abortSignal));
        nextSegmentToSchedule += 1;
      }
    };

    scheduleNextSegments();

    const result: TtsPlaybackResult = {
      segmentsEmitted: 0,
      segmentsConfirmed: 0,
      aborted: false,
    };

    try {
      for (const segment of segments) {
        if (abortSignal.aborted) {
          result.aborted = true;
          this.logger.warn(
            {
              segmentIndex: segment.index,
              segmentCount: segments.length,
              segmentsEmitted: result.segmentsEmitted,
            },
            "TTS aborted before emitting: speak produced no further audio",
          );
          break;
        }

        const synthWaitStart = Date.now();
        const synthResult = await inflight.get(segment.index)!;
        const synthWaitMs = Date.now() - synthWaitStart;
        inflight.delete(segment.index);
        scheduleNextSegments();

        if (synthResult.kind === "aborted") {
          result.aborted = true;
          break;
        }

        if (synthResult.kind === "error") {
          throw synthResult.error;
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
        const segmentOutcome = await this.emitPreparedSegment({
          prepared: synthResult.prepared,
          emitMessage,
          abortSignal,
          isVoiceMode,
        });
        if (segmentOutcome.emitted) {
          result.segmentsEmitted += 1;
          if (segmentOutcome.confirmed) {
            result.segmentsConfirmed += 1;
          }
        } else if (abortSignal.aborted) {
          result.aborted = true;
          break;
        }
        this.logger.info(
          {
            segmentIndex: segment.index,
            emitAndPlayMs: Date.now() - emitStart,
            totalElapsedMs: Date.now() - ttsStartMs,
            emitted: segmentOutcome.emitted,
            confirmed: segmentOutcome.confirmed,
          },
          `TTS segment ${segment.index} playback confirmed (emit+play ${Date.now() - emitStart}ms, total ${Date.now() - ttsStartMs}ms)`,
        );

        scheduleNextSegments();
      }
    } finally {
      this.cleanupPrefetchedSegments(inflight);
      this.logger.info(
        {
          totalMs: Date.now() - ttsStartMs,
          segmentsEmitted: result.segmentsEmitted,
          segmentsConfirmed: result.segmentsConfirmed,
          segmentCount: segments.length,
          aborted: result.aborted,
        },
        `TTS generateAndWaitForPlayback done (${Date.now() - ttsStartMs}ms)`,
      );
    }

    if (abortSignal.aborted) {
      result.aborted = true;
    }

    if (result.segmentsEmitted === 0) {
      throw new Error(
        result.aborted
          ? `TTS speak produced no audio: aborted before any of the ${segments.length} segment(s) could be emitted (0 confirmed). Report this speak call as failed — nothing was heard.`
          : `TTS speak produced no audio: all ${segments.length} segment(s) synthesized to 0 bytes (0 emitted, 0 confirmed). Report this speak call as failed — nothing was heard.`,
      );
    }

    return result;
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
        return;
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
  }): Promise<{ emitted: boolean; confirmed: boolean }> {
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
      confirmed: false,
    };

    this.pendingPlaybacks.set(audioId, pendingPlayback);

    let onAbort: (() => void) | undefined;
    let confirmTimer: ReturnType<typeof setTimeout> | undefined;

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

      const totalBytes = buffers.reduce((sum, buffer) => sum + buffer.length, 0);
      if (abortSignal.aborted || totalBytes === 0) {
        if (!abortSignal.aborted) {
          this.logger.warn(
            {
              audioId,
              segmentIndex: prepared.index,
              chars: text.length,
            },
            "TTS synthesis produced 0 bytes of audio: skipping segment (no audio to play)",
          );
        }
        pendingPlayback.streamEnded = true;
        pendingPlayback.pendingChunks = 0;
        this.pendingPlaybacks.delete(audioId);
        this.rememberClosedAudioId(audioId);
        playbackResolve();
        return { emitted: false, confirmed: false };
      }

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

      pendingPlayback.streamEnded = true;

      if (pendingPlayback.pendingChunks === 0) {
        // The client confirmed synchronously inside emitMessage.
        this.pendingPlaybacks.delete(audioId);
        this.rememberClosedAudioId(audioId);
        playbackResolve();
      }

      const confirmTimeoutMs = this.playbackConfirmTimeoutMs(fullBuffer.length, format);
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        confirmTimer = setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          this.pendingPlaybacks.delete(audioId);
          this.rememberClosedAudioId(audioId);
          reject(
            new Error(
              `TTS segment ${prepared.index} playback not confirmed by the client within ${confirmTimeoutMs}ms ` +
                `(${fullBuffer.length} bytes emitted, 0 confirmed). No audible output verified — ` +
                `the client may have no audio sink. Report this speak call as failed.`,
            ),
          );
        }, confirmTimeoutMs);
        void playbackPromise.then(
          () => {
            if (!settled) {
              settled = true;
              resolve();
            }
          },
          (error) => {
            if (!settled) {
              settled = true;
              reject(error);
            }
          },
        );
      });

      return { emitted: true, confirmed: pendingPlayback.confirmed };
    } catch (error) {
      if (abortSignal.aborted) {
        this.logger.debug("Audio stream closed after abort");
        return { emitted: false, confirmed: pendingPlayback.confirmed };
      }
      this.logger.error({ err: error }, "Error streaming audio");
      this.pendingPlaybacks.delete(audioId);
      throw error;
    } finally {
      if (confirmTimer) {
        clearTimeout(confirmTimer);
      }
      if (onAbort) {
        abortSignal.removeEventListener("abort", onAbort);
      }
      this.destroySpeechStream(stream);
    }
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

    pending.confirmed = true;
    pending.pendingChunks = Math.max(0, pending.pendingChunks - 1);

    if (pending.pendingChunks === 0 && pending.streamEnded) {
      pending.resolve();
      this.pendingPlaybacks.delete(audioId);
      this.rememberClosedAudioId(audioId);
    }
  }

  /**
   * How long to wait for the client to confirm it actually played an
   * emitted segment before treating the speak as failed. Derived from the
   * audio duration (PCM16 mono assumed when the rate is parseable) with a
   * generous floor; unknown formats fall back to a fixed bound so a client
   * with no audio sink can never wedge a speak call forever.
   */
  private playbackConfirmTimeoutMs(byteLength: number, format: string): number {
    if (this.options.playbackConfirmTimeoutMs !== undefined) {
      return this.options.playbackConfirmTimeoutMs;
    }
    const rate = parsePcmRateFromFormat(format, null);
    if (rate === null) {
      return 60_000;
    }
    const estimatedAudioMs = Math.round((byteLength / 2 / rate) * 1000);
    return Math.max(30_000, estimatedAudioMs * 2 + 15_000);
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
