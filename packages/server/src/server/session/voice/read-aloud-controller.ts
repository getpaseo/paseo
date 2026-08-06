import type pino from "pino";
import type { Readable } from "node:stream";

import type { SessionOutboundMessage } from "../../messages.js";
import { toResolver, type Resolvable } from "../../speech/provider-resolver.js";
import type { TextToSpeechProvider } from "../../speech/speech-provider.js";
import { hasSpeakableContent, sanitizeTextForReadAloud } from "../../speech/read-aloud-text.js";
import { splitTextForTts, type TtsSegment } from "../../speech/tts-text-splitter.js";

/**
 * Upper bound on a single read-aloud request. Guards the daemon against a
 * "select all" that would otherwise queue minutes of synthesis work.
 */
export const MAX_READ_ALOUD_CHARS = 4000;

/** How many segments are synthesized ahead of the one currently being emitted. */
const READ_ALOUD_PREFETCH_SEGMENTS = 2;

export type ReadAloudErrorCode =
  | "empty_text"
  | "text_too_long"
  | "tts_unavailable"
  | "synth_failed";

interface ActiveRequest {
  abortController: AbortController;
}

type PreparedSegment = TtsSegment & {
  format: string;
  stream: Readable;
};

export interface ReadAloudControllerOptions {
  sessionId: string;
  logger: pino.Logger;
  tts: Resolvable<TextToSpeechProvider | null>;
  emit: (message: SessionOutboundMessage) => void;
}

/**
 * On-demand text-to-speech for client-selected text ("Read aloud").
 *
 * Deliberately separate from `TTSManager`: voice-mode audio carries an
 * `isVoiceMode` drift flag and gates an agent turn on playback confirmation,
 * neither of which applies here. Read aloud is fire-and-forget streaming —
 * segments are pushed as they finish synthesizing and the client queues them.
 */
export class ReadAloudController {
  private readonly logger: pino.Logger;
  private readonly resolveTts: () => TextToSpeechProvider | null;
  private readonly emit: (message: SessionOutboundMessage) => void;
  private readonly active = new Map<string, ActiveRequest>();

  constructor(options: ReadAloudControllerOptions) {
    this.logger = options.logger.child({
      module: "speech",
      component: "read-aloud",
      sessionId: options.sessionId,
    });
    this.resolveTts = toResolver(options.tts);
    this.emit = options.emit;
  }

  public async handleRequest(params: { requestId: string; text: string }): Promise<void> {
    const { requestId } = params;

    // Only one read aloud plays at a time, so a new request supersedes whatever
    // is still synthesizing rather than competing with it for the TTS worker.
    this.cancelAll("superseded by a newer read aloud request");

    // Cap on what the user selected, before sanitizing, so the limit means the
    // same thing to them whether or not the message was full of markup.
    const rawLength = params.text.trim().length;
    const text = sanitizeTextForReadAloud(params.text);
    if (!hasSpeakableContent(text)) {
      this.emitError(requestId, "empty_text", "Nothing to read aloud");
      return;
    }

    if (rawLength > MAX_READ_ALOUD_CHARS) {
      this.emitError(
        requestId,
        "text_too_long",
        `Message is too long to read aloud (${rawLength} of ${MAX_READ_ALOUD_CHARS} characters)`,
      );
      return;
    }

    const tts = this.resolveTts();
    if (!tts) {
      this.emitError(requestId, "tts_unavailable", "Text-to-speech is not configured on this host");
      return;
    }

    const abortController = new AbortController();
    this.active.set(requestId, { abortController });
    const abortSignal = abortController.signal;

    // Re-index after dropping unspeakable fragments so `segmentIndex` stays a
    // dense 0..n-1 run and the last segment really is the last one.
    const segments: TtsSegment[] = [];
    for (const segment of splitTextForTts(text)) {
      if (hasSpeakableContent(segment.text)) {
        segments.push({ index: segments.length, text: segment.text });
      }
    }
    if (segments.length === 0) {
      this.emitError(requestId, "empty_text", "Nothing to read aloud");
      return;
    }
    const startedAtMs = Date.now();
    this.logger.debug(
      { requestId, chars: text.length, segmentCount: segments.length },
      "Read aloud started",
    );

    const inflight = new Map<number, Promise<PreparedSegment>>();
    let nextToSchedule = 0;

    const scheduleAhead = () => {
      while (
        nextToSchedule < segments.length &&
        inflight.size < READ_ALOUD_PREFETCH_SEGMENTS &&
        !abortSignal.aborted
      ) {
        const segment = segments[nextToSchedule];
        inflight.set(segment.index, this.synthesizeSegment(tts, segment));
        nextToSchedule += 1;
      }
    };

    scheduleAhead();

    try {
      for (const segment of segments) {
        const pending = inflight.get(segment.index);
        if (!pending) {
          break;
        }

        let prepared: PreparedSegment;
        try {
          prepared = await pending;
        } finally {
          inflight.delete(segment.index);
        }

        if (abortSignal.aborted) {
          destroyStream(prepared.stream);
          return;
        }

        scheduleAhead();

        const audio = await collectStream(prepared.stream);
        if (abortSignal.aborted) {
          return;
        }

        this.emit({
          type: "speech.tts.read_aloud.response",
          payload: {
            requestId,
            segmentIndex: segment.index,
            segmentCount: segments.length,
            isLast: segment.index === segments.length - 1,
            audio: audio.toString("base64"),
            format: prepared.format,
          },
        });
      }

      this.logger.debug(
        { requestId, totalMs: Date.now() - startedAtMs, segmentCount: segments.length },
        "Read aloud completed",
      );
    } catch (error) {
      if (abortSignal.aborted) {
        this.logger.debug({ requestId }, "Read aloud aborted during synthesis");
        return;
      }
      this.logger.warn({ requestId, err: error }, "Read aloud synthesis failed");
      this.emitError(
        requestId,
        "synth_failed",
        error instanceof Error ? error.message : String(error),
        { segmentIndex: segments.length, segmentCount: segments.length },
      );
    } finally {
      this.active.delete(requestId);
      discardPrefetched(inflight);
    }
  }

  public cancel(requestId: string): void {
    const request = this.active.get(requestId);
    if (!request) {
      return;
    }
    this.active.delete(requestId);
    request.abortController.abort();
    this.logger.debug({ requestId }, "Read aloud cancelled by client");
  }

  public dispose(): void {
    this.cancelAll("session closed");
  }

  private cancelAll(reason: string): void {
    if (this.active.size === 0) {
      return;
    }
    for (const [requestId, request] of this.active.entries()) {
      this.active.delete(requestId);
      request.abortController.abort();
      this.logger.debug({ requestId, reason }, "Read aloud cancelled");
    }
  }

  private synthesizeSegment(
    tts: TextToSpeechProvider,
    segment: TtsSegment,
  ): Promise<PreparedSegment> {
    return tts
      .synthesizeSpeech(segment.text)
      .then(({ stream, format }) => ({ ...segment, stream, format }));
  }

  private emitError(
    requestId: string,
    code: ReadAloudErrorCode,
    message: string,
    position?: { segmentIndex: number; segmentCount: number },
  ): void {
    this.emit({
      type: "speech.tts.read_aloud.response",
      payload: {
        requestId,
        segmentIndex: position?.segmentIndex ?? 0,
        segmentCount: position?.segmentCount ?? 0,
        isLast: true,
        error: { code, message },
      },
    });
  }
}

function destroyStream(stream: Readable): void {
  if (typeof stream.destroy === "function" && !stream.destroyed) {
    stream.destroy();
  }
}

function discardPrefetched(inflight: Map<number, Promise<PreparedSegment>>): void {
  for (const pending of inflight.values()) {
    void pending.then(
      (prepared) => destroyStream(prepared.stream),
      () => undefined,
    );
  }
  inflight.clear();
}

async function collectStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  } finally {
    destroyStream(stream);
  }
  return Buffer.concat(chunks);
}
