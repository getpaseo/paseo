import type pino from "pino";
import { v4 as uuidv4 } from "uuid";
import {
  createDictationDebugChunkWriter,
  maybePersistDictationDebugAudio,
  type DictationDebugChunkWriter,
} from "../agent/dictation-debug.js";
import { isPaseoDictationDebugEnabled } from "../agent/recordings-debug.js";
import { Pcm16MonoResampler } from "../agent/pcm16-resampler.js";
import { OpenAIRealtimeTranscriptionSession } from "../agent/openai-realtime-transcription.js";

const PCM_CHANNELS = 1;
const PCM_BITS_PER_SAMPLE = 16;
const DICTATION_PCM_OUTPUT_RATE = 24000;
const DEFAULT_DICTATION_FINAL_TIMEOUT_MS = 30000;
const DICTATION_SILENCE_PEAK_THRESHOLD = Number.parseInt(
  process.env.OPENAI_REALTIME_DICTATION_SILENCE_PEAK_THRESHOLD ?? "300",
  10
);
const DICTATION_TURN_DETECTION = (
  process.env.OPENAI_REALTIME_DICTATION_TURN_DETECTION ?? "semantic_vad"
).trim();
const DICTATION_SEMANTIC_VAD_EAGERNESS = (
  process.env.OPENAI_REALTIME_DICTATION_SEMANTIC_VAD_EAGERNESS ?? "medium"
).trim();
const DICTATION_FLUSH_SILENCE_MS = Number.parseInt(
  process.env.OPENAI_REALTIME_DICTATION_FLUSH_SILENCE_MS ?? "800",
  10
);

type OpenAITurnDetection =
  | null
  | {
      type: "server_vad";
      create_response: false;
      threshold?: number;
      prefix_padding_ms?: number;
      silence_duration_ms?: number;
    }
  | { type: "semantic_vad"; create_response: false; eagerness?: "low" | "medium" | "high" };

function pcm16lePeakAbs(pcm16le: Buffer): number {
  if (pcm16le.length === 0) {
    return 0;
  }
  if (pcm16le.length % 2 !== 0) {
    throw new Error(`PCM16 chunk byteLength must be even, got ${pcm16le.length}`);
  }
  const samples = new Int16Array(
    pcm16le.buffer,
    pcm16le.byteOffset,
    pcm16le.byteLength / 2
  );
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = samples[i]!;
    const abs = v < 0 ? -v : v;
    if (abs > peak) {
      peak = abs;
      if (peak >= 32767) {
        break;
      }
    }
  }
  return peak;
}

function parseDictationTurnDetection(): OpenAITurnDetection {
  if (
    !DICTATION_TURN_DETECTION ||
    DICTATION_TURN_DETECTION === "none" ||
    DICTATION_TURN_DETECTION === "null"
  ) {
    return null;
  }
  if (DICTATION_TURN_DETECTION === "server_vad") {
    return { type: "server_vad", create_response: false };
  }
  const eagerness =
    DICTATION_SEMANTIC_VAD_EAGERNESS === "low" ||
    DICTATION_SEMANTIC_VAD_EAGERNESS === "high"
      ? (DICTATION_SEMANTIC_VAD_EAGERNESS as "low" | "high")
      : ("medium" as const);
  return { type: "semantic_vad", create_response: false, eagerness };
}

export type RealtimeTranscriptionSession = {
  connect(): Promise<void>;
  appendPcm16Base64(base64Audio: string): void;
  commit(): void;
  clear(): void;
  close(): void;
  on(
    event: "committed",
    handler: (payload: { itemId: string; previousItemId: string | null }) => void
  ): unknown;
  on(
    event: "transcript",
    handler: (payload: { itemId: string; transcript: string; isFinal: boolean }) => void
  ): unknown;
  on(event: "error", handler: (err: unknown) => void): unknown;
};

function convertPCMToWavBuffer(
  pcmBuffer: Buffer,
  sampleRate: number,
  channels: number,
  bitsPerSample: number
): Buffer {
  const headerSize = 44;
  const wavBuffer = Buffer.alloc(headerSize + pcmBuffer.length);
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;

  wavBuffer.write("RIFF", 0);
  wavBuffer.writeUInt32LE(36 + pcmBuffer.length, 4);
  wavBuffer.write("WAVE", 8);
  wavBuffer.write("fmt ", 12);
  wavBuffer.writeUInt32LE(16, 16);
  wavBuffer.writeUInt16LE(1, 20);
  wavBuffer.writeUInt16LE(channels, 22);
  wavBuffer.writeUInt32LE(sampleRate, 24);
  wavBuffer.writeUInt32LE(byteRate, 28);
  wavBuffer.writeUInt16LE(blockAlign, 32);
  wavBuffer.writeUInt16LE(bitsPerSample, 34);
  wavBuffer.write("data", 36);
  wavBuffer.writeUInt32LE(pcmBuffer.length, 40);
  pcmBuffer.copy(wavBuffer, 44);

  return wavBuffer;
}

type DictationStreamState = {
  dictationId: string;
  sessionId: string;
  inputFormat: string;
  openai: RealtimeTranscriptionSession;
  inputRate: number;
  resampler: Pcm16MonoResampler | null;
  debugAudioChunks: Buffer[];
  debugRecordingPath: string | null;
  debugChunkWriter: DictationDebugChunkWriter | null;
  receivedChunks: Map<number, Buffer>;
  nextSeqToForward: number;
  ackSeq: number;
  bytesSinceCommit: number;
  peakSinceCommit: number;
  committedItemIds: string[];
  transcriptsByItemId: Map<string, string>;
  finalTranscriptItemIds: Set<string>;
  awaitingFinalCommit: boolean;
  finishRequested: boolean;
  finishSealed: boolean;
  finalSeq: number | null;
  finalTimeout: ReturnType<typeof setTimeout> | null;
};

export type DictationStreamOutboundMessage =
  | { type: "dictation_stream_ack"; payload: { dictationId: string; ackSeq: number } }
  | { type: "dictation_stream_partial"; payload: { dictationId: string; text: string } }
  | { type: "dictation_stream_final"; payload: { dictationId: string; text: string; debugRecordingPath?: string } }
  | { type: "dictation_stream_error"; payload: { dictationId: string; error: string; retryable: boolean; debugRecordingPath?: string } }
  | {
      type: "activity_log";
      payload: {
        id: string;
        timestamp: Date;
        type: "system";
        content: string;
        metadata: Record<string, unknown>;
      };
    };

export class DictationStreamManager {
  private readonly logger: pino.Logger;
  private readonly emit: (msg: DictationStreamOutboundMessage) => void;
  private readonly sessionId: string;
  private readonly openaiApiKey: string | null;
  private readonly finalTimeoutMs: number;
  private readonly streams = new Map<string, DictationStreamState>();

  constructor(params: {
    logger: pino.Logger;
    emit: (msg: DictationStreamOutboundMessage) => void;
    sessionId: string;
    openaiApiKey?: string | null;
    finalTimeoutMs?: number;
  }) {
    this.logger = params.logger.child({ component: "dictation-stream-manager" });
    this.emit = params.emit;
    this.sessionId = params.sessionId;
    this.openaiApiKey = params.openaiApiKey ?? null;
    this.finalTimeoutMs = params.finalTimeoutMs ?? DEFAULT_DICTATION_FINAL_TIMEOUT_MS;
  }

  public cleanupAll(): void {
    for (const dictationId of this.streams.keys()) {
      this.cleanupDictationStream(dictationId);
    }
  }

  public async handleStart(dictationId: string, format: string): Promise<void> {
    this.cleanupDictationStream(dictationId);

    const apiKey = this.openaiApiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      this.failDictationStream(dictationId, "OPENAI_API_KEY not set", false);
      return;
    }

    const transcriptionModel =
      process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL ?? "gpt-4o-transcribe";
    const transcriptionPrompt =
      process.env.OPENAI_REALTIME_DICTATION_TRANSCRIPTION_PROMPT ??
      "Transcribe only what the speaker says. Do not add words. Preserve punctuation and casing. If the audio is silence or non-speech noise, return an empty transcript.";

    const openai = new OpenAIRealtimeTranscriptionSession({
      apiKey,
      logger: this.logger.child({ dictationId }),
      transcriptionModel,
      language: "en",
      prompt: transcriptionPrompt,
      turnDetection: parseDictationTurnDetection(),
    });

    openai.on("committed", ({ itemId }: { itemId: string }) => {
      const state = this.streams.get(dictationId);
      if (!state) {
        return;
      }
      state.committedItemIds.push(itemId);
      state.bytesSinceCommit = 0;
      state.peakSinceCommit = 0;

      // When finishing, we require at least one commit after finish if we flushed pending audio.
      if (state.finishRequested && state.awaitingFinalCommit) {
        state.awaitingFinalCommit = false;
      }

      this.maybeFinalizeDictationStream(dictationId);
    });

    openai.on(
      "transcript",
      ({
        itemId,
        transcript,
        isFinal,
      }: {
        itemId: string;
        transcript: string;
        isFinal: boolean;
      }) => {
        const state = this.streams.get(dictationId);
        if (!state) {
          return;
        }
        state.transcriptsByItemId.set(itemId, transcript);
        if (isFinal) {
          state.finalTranscriptItemIds.add(itemId);
        }

        // If we triggered a finish commit but OpenAI doesn't emit committed events (or they arrive late),
        // allow final transcripts to unblock finalization.
        if (state.finishRequested && state.awaitingFinalCommit && isFinal) {
          state.awaitingFinalCommit = false;
        }

        const orderedIds = state.committedItemIds.includes(itemId)
          ? state.committedItemIds
          : [...state.committedItemIds, itemId];
        const partialText = orderedIds
          .map((id) => state.transcriptsByItemId.get(id) ?? "")
          .join(" ")
          .trim();
        this.emitDictationPartial(dictationId, partialText);

        this.maybeSealDictationStreamFinish(dictationId);
        this.maybeFinalizeDictationStream(dictationId);
      }
    );

    openai.on("error", (err) => {
      const message = err instanceof Error ? err.message : String(err);
      void this.failAndCleanupDictationStream(dictationId, message, true);
    });

    await openai.connect();

    const rateMatch = /(?:^|[;,\s])rate\s*=\s*(\d+)(?:$|[;,\s])/i.exec(format);
    const inputRate = rateMatch ? Number.parseInt(rateMatch[1]!, 10) : 16000;
    if (!Number.isFinite(inputRate) || inputRate <= 0) {
      this.failDictationStream(dictationId, `Invalid dictation input rate in format: ${format}`, false);
      try {
        openai.close();
      } catch {
        // no-op
      }
      return;
    }

    const debugChunkWriter = createDictationDebugChunkWriter(
      { sessionId: this.sessionId, dictationId },
      this.logger
    );

    this.streams.set(dictationId, {
      dictationId,
      sessionId: this.sessionId,
      inputFormat: format,
      openai,
      inputRate,
      resampler:
        inputRate === DICTATION_PCM_OUTPUT_RATE
          ? null
          : new Pcm16MonoResampler({
              inputRate,
              outputRate: DICTATION_PCM_OUTPUT_RATE,
            }),
      debugAudioChunks: [],
      debugRecordingPath: null,
      debugChunkWriter,
      receivedChunks: new Map(),
      nextSeqToForward: 0,
      ackSeq: -1,
      bytesSinceCommit: 0,
      peakSinceCommit: 0,
      committedItemIds: [],
      transcriptsByItemId: new Map(),
      finalTranscriptItemIds: new Set(),
      awaitingFinalCommit: false,
      finishRequested: false,
      finishSealed: false,
      finalSeq: null,
      finalTimeout: null,
    });

    this.emitDictationAck(dictationId, -1);
  }

  public async handleChunk(params: {
    dictationId: string;
    seq: number;
    audioBase64: string;
    format: string;
  }): Promise<void> {
    const state = this.streams.get(params.dictationId);
    if (!state) {
      this.failDictationStream(params.dictationId, "Dictation stream not started", true);
      return;
    }

    if (params.format !== state.inputFormat) {
      void this.failAndCleanupDictationStream(
        params.dictationId,
        `Mismatched dictation stream format: ${params.format}`,
        false
      );
      return;
    }

    if (params.seq < state.nextSeqToForward) {
      this.emitDictationAck(params.dictationId, state.ackSeq);
      return;
    }

    if (!state.receivedChunks.has(params.seq)) {
      state.receivedChunks.set(params.seq, Buffer.from(params.audioBase64, "base64"));
    }

    while (state.receivedChunks.has(state.nextSeqToForward)) {
      const seq = state.nextSeqToForward;
      const pcm16 = state.receivedChunks.get(seq)!;
      state.receivedChunks.delete(seq);

      const resampled = state.resampler ? state.resampler.processChunk(pcm16) : pcm16;
      if (resampled.length > 0) {
        state.openai.appendPcm16Base64(resampled.toString("base64"));
        state.debugAudioChunks.push(resampled);
        state.bytesSinceCommit += resampled.length;
        state.peakSinceCommit = Math.max(state.peakSinceCommit, pcm16lePeakAbs(resampled));

        if (state.debugChunkWriter) {
          void state.debugChunkWriter.writeChunk(seq, resampled).catch((err) => {
            this.logger.warn({ dictationId: params.dictationId, seq, err }, "Failed to write debug chunk");
          });
        }
      }

      state.nextSeqToForward += 1;
      state.ackSeq = state.nextSeqToForward - 1;
    }

    this.emitDictationAck(params.dictationId, state.ackSeq);
    this.maybeSealDictationStreamFinish(params.dictationId);
    this.maybeFinalizeDictationStream(params.dictationId);
  }

  public async handleFinish(dictationId: string, finalSeq: number): Promise<void> {
    const state = this.streams.get(dictationId);
    if (!state) {
      this.failDictationStream(dictationId, "Dictation stream not started", true);
      return;
    }

    state.finishRequested = true;
    state.finalSeq = finalSeq;

    if (finalSeq >= 0 && state.ackSeq < 0 && state.nextSeqToForward === 0 && state.receivedChunks.size === 0) {
      this.logger.debug(
        {
          dictationId,
          finalSeq,
          ackSeq: state.ackSeq,
          nextSeqToForward: state.nextSeqToForward,
          receivedChunks: state.receivedChunks.size,
          bytesSinceCommit: state.bytesSinceCommit,
        },
        "Dictation finish: no chunks received (failing fast)"
      );
      this.failDictationStream(
        dictationId,
        `Dictation finished (finalSeq=${finalSeq}) but no audio chunks were received`,
        true
      );
      this.cleanupDictationStream(dictationId);
      return;
    }

    if (state.finalTimeout) {
      clearTimeout(state.finalTimeout);
    }
    state.finalTimeout = setTimeout(() => {
      void this.failAndCleanupDictationStream(
        dictationId,
        "Timed out waiting for final transcription",
        true
      );
    }, this.finalTimeoutMs);

    this.maybeSealDictationStreamFinish(dictationId);
    this.maybeFinalizeDictationStream(dictationId);
  }

  public handleCancel(dictationId: string): void {
    this.cleanupDictationStream(dictationId);
  }

  private emitDictationAck(dictationId: string, ackSeq: number): void {
    this.emit({ type: "dictation_stream_ack", payload: { dictationId, ackSeq } });
  }

  private emitDictationPartial(dictationId: string, text: string): void {
    this.emit({ type: "dictation_stream_partial", payload: { dictationId, text } });
  }

  private async maybePersistDictationStreamAudio(dictationId: string): Promise<string | null> {
    if (!isPaseoDictationDebugEnabled()) {
      return null;
    }

    const state = this.streams.get(dictationId);
    if (!state) {
      return null;
    }
    if (state.debugRecordingPath) {
      return state.debugRecordingPath;
    }
    if (state.debugAudioChunks.length === 0) {
      return null;
    }

    const pcmBuffer = Buffer.concat(state.debugAudioChunks);
    const wavBuffer = convertPCMToWavBuffer(
      pcmBuffer,
      DICTATION_PCM_OUTPUT_RATE,
      PCM_CHANNELS,
      PCM_BITS_PER_SAMPLE
    );
    const path = await maybePersistDictationDebugAudio(
      wavBuffer,
      { sessionId: state.sessionId, dictationId: state.dictationId, format: "audio/wav" },
      this.logger,
      state.debugChunkWriter?.folder
    );
    state.debugRecordingPath = path;
    return path;
  }

  private failDictationStream(dictationId: string, error: string, retryable: boolean): void {
    this.emit({
      type: "dictation_stream_error",
      payload: { dictationId, error, retryable },
    });
  }

  private async failAndCleanupDictationStream(
    dictationId: string,
    error: string,
    retryable: boolean
  ): Promise<void> {
    const debugRecordingPath = await this.maybePersistDictationStreamAudio(dictationId);
    this.emit({
      type: "dictation_stream_error",
      payload: {
        dictationId,
        error,
        retryable,
        ...(debugRecordingPath ? { debugRecordingPath } : {}),
      },
    });
    if (debugRecordingPath) {
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "system",
          content: `Saved dictation audio: ${debugRecordingPath}`,
          metadata: { recordingPath: debugRecordingPath, dictationId },
        },
      });
    }
    this.cleanupDictationStream(dictationId);
  }

  private cleanupDictationStream(dictationId: string): void {
    const state = this.streams.get(dictationId) ?? null;
    if (!state) {
      return;
    }
    if (state.finalTimeout) {
      clearTimeout(state.finalTimeout);
    }
    try {
      state.openai.close();
    } catch {
      // no-op
    }
    this.streams.delete(dictationId);
  }

  private maybeSealDictationStreamFinish(dictationId: string): void {
    const state = this.streams.get(dictationId);
    if (!state) {
      return;
    }
    if (!state.finishRequested || state.finalSeq === null) {
      return;
    }
    if (state.ackSeq < state.finalSeq) {
      return;
    }
    if (state.finishSealed) {
      return;
    }

    if (state.bytesSinceCommit > 0) {
      if (state.peakSinceCommit < DICTATION_SILENCE_PEAK_THRESHOLD) {
        this.logger.debug(
          {
            dictationId,
            bytesSinceCommit: state.bytesSinceCommit,
            peakSinceCommit: state.peakSinceCommit,
          },
          "Dictation finish: clearing silence-only tail (skip final commit)"
        );
        state.openai.clear();
        state.bytesSinceCommit = 0;
        state.peakSinceCommit = 0;
        state.awaitingFinalCommit = false;
      } else {
        const silenceBytes = Math.max(
          0,
          Math.round((DICTATION_PCM_OUTPUT_RATE * 2 * DICTATION_FLUSH_SILENCE_MS) / 1000)
        );
        if (silenceBytes > 0) {
          this.logger.debug(
            { dictationId, silenceMs: DICTATION_FLUSH_SILENCE_MS, silenceBytes },
            "Dictation finish: appending silence tail for semantic VAD flush"
          );
          const silence = Buffer.alloc(silenceBytes);
          state.openai.appendPcm16Base64(silence.toString("base64"));
          state.debugAudioChunks.push(silence);
          state.bytesSinceCommit += silenceBytes;
        }

        try {
          state.awaitingFinalCommit = true;
          state.openai.commit();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          void this.failAndCleanupDictationStream(dictationId, message, true);
          return;
        }
      }
    } else {
      state.awaitingFinalCommit = false;
    }

    state.finishSealed = true;
  }

  private maybeFinalizeDictationStream(dictationId: string): void {
    const state = this.streams.get(dictationId);
    if (!state) {
      return;
    }

    if (!state.finishRequested || state.finalSeq === null) {
      return;
    }
    if (state.ackSeq < state.finalSeq) {
      return;
    }
    if (state.awaitingFinalCommit) {
      return;
    }

    const committedSet = new Set(state.committedItemIds);
    const orderedItemIds: string[] = [...state.committedItemIds];
    for (const itemId of state.transcriptsByItemId.keys()) {
      if (!committedSet.has(itemId)) {
        orderedItemIds.push(itemId);
      }
    }

    if (orderedItemIds.length === 0) {
      void (async () => {
        const debugRecordingPath = await this.maybePersistDictationStreamAudio(dictationId);
        this.emit({
          type: "dictation_stream_final",
          payload: {
            dictationId,
            text: "",
            ...(debugRecordingPath ? { debugRecordingPath } : {}),
          },
        });
        if (debugRecordingPath) {
          this.emit({
            type: "activity_log",
            payload: {
              id: uuidv4(),
              timestamp: new Date(),
              type: "system",
              content: `Saved dictation audio: ${debugRecordingPath}`,
              metadata: { recordingPath: debugRecordingPath, dictationId },
            },
          });
        }
        this.cleanupDictationStream(dictationId);
      })();
      return;
    }

    const allTranscriptsReady = orderedItemIds.every((itemId) =>
      state.finalTranscriptItemIds.has(itemId)
    );
    if (!allTranscriptsReady) {
      return;
    }

    const orderedText = orderedItemIds
      .map((itemId) => state.transcriptsByItemId.get(itemId) ?? "")
      .join(" ")
      .trim();

    void (async () => {
      const debugRecordingPath = await this.maybePersistDictationStreamAudio(dictationId);
      this.emit({
        type: "dictation_stream_final",
        payload: {
          dictationId,
          text: orderedText,
          ...(debugRecordingPath ? { debugRecordingPath } : {}),
        },
      });
      if (debugRecordingPath) {
        this.emit({
          type: "activity_log",
          payload: {
            id: uuidv4(),
            timestamp: new Date(),
            type: "system",
            content: `Saved dictation audio: ${debugRecordingPath}`,
            metadata: { recordingPath: debugRecordingPath, dictationId },
          },
        });
      }
      this.cleanupDictationStream(dictationId);
    })();
  }
}
