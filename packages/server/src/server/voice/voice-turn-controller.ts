import { Buffer } from "node:buffer";
import type { Logger } from "pino";
import { v4 as uuidv4 } from "uuid";

import { Pcm16MonoResampler } from "../agent/pcm16-resampler.js";
import { parsePcmRateFromFormat } from "../speech/audio.js";
import type { TurnDetectionProvider } from "../speech/turn-detection-provider.js";
import { FixedDurationPcmRingBuffer } from "./fixed-duration-pcm-ring-buffer.js";

const PCM_CHANNELS = 1;
const PCM_BITS_PER_SAMPLE = 16;
const DEFAULT_PREFIX_DURATION_MS = 1000;

type VoiceInputState =
  | { status: "idle" }
  | { status: "listening"; rollingPrefixBytes: number }
  | {
      status: "capturing";
      utteranceId: string;
      startedAt: number;
      rollingPrefixBytes: number;
      utteranceBytes: number;
    };

export interface VoiceTurnControllerCallbacks {
  onSpeechStarted(): Promise<void>;
  onSpeechStopped(): Promise<void>;
  onError(error: Error): void;
}

export interface DetectedVoiceUtterance {
  pcm16: Buffer;
  sampleRate: number;
  format: string;
  startedAt: number;
  endedAt: number;
}

export interface VoiceUtteranceSink {
  submitUtterance(utterance: DetectedVoiceUtterance): Promise<void>;
}

export interface VoiceTurnController {
  start(): Promise<void>;
  stop(): Promise<void>;
  appendClientChunk(input: { audioBase64: string; format: string }): Promise<void>;
}

export function createVoiceTurnController(params: {
  logger: Logger;
  turnDetection: TurnDetectionProvider;
  utteranceSink: VoiceUtteranceSink;
  callbacks: VoiceTurnControllerCallbacks;
  prefixDurationMs?: number;
}): VoiceTurnController {
  const detector = params.turnDetection.createSession({
    logger: params.logger.child({ component: "turn-detection" }),
  });
  const prefixBuffer = new FixedDurationPcmRingBuffer({
    sampleRate: detector.requiredSampleRate,
    channels: PCM_CHANNELS,
    bitsPerSample: PCM_BITS_PER_SAMPLE,
    durationMs: params.prefixDurationMs ?? DEFAULT_PREFIX_DURATION_MS,
  });

  let state: VoiceInputState = { status: "idle" };
  let resampler: Pcm16MonoResampler | null = null;
  let inputRate = detector.requiredSampleRate;
  let utteranceChunks: Buffer[] = [];
  let queued = Promise.resolve();
  let submissionQueue = Promise.resolve();

  function buildVoicePcmFormat(sampleRate: number): string {
    return `audio/pcm;rate=${sampleRate};bits=16`;
  }

  function fail(error: unknown): void {
    params.callbacks.onError(error instanceof Error ? error : new Error(String(error)));
  }

  function runSerial(task: () => Promise<void>): Promise<void> {
    queued = queued.then(task).catch((error) => {
      fail(error);
    });
    return queued;
  }

  function enqueueUtteranceSubmission(utterance: DetectedVoiceUtterance): void {
    submissionQueue = submissionQueue
      .then(async () => {
        await params.utteranceSink.submitUtterance(utterance);
      })
      .catch((error) => {
        fail(error);
      });
  }

  async function handleSpeechStarted(): Promise<void> {
    if (state.status === "capturing") {
      return;
    }

    await params.callbacks.onSpeechStarted();

    const prefix = prefixBuffer.drain();
    const startedAt = Date.now();
    utteranceChunks = prefix.length > 0 ? [prefix] : [];
    state = {
      status: "capturing",
      utteranceId: uuidv4(),
      startedAt,
      rollingPrefixBytes: prefixBuffer.byteLength,
      utteranceBytes: prefix.length,
    };
    params.logger.info(
      {
        utteranceId: state.utteranceId,
        prefixBytes: prefix.length,
        rollingPrefixBytes: prefixBuffer.byteLength,
      },
      "voice_turn.speech_started",
    );
  }

  async function handleSpeechStopped(): Promise<void> {
    if (state.status !== "capturing") {
      return;
    }

    const utterance = Buffer.concat(utteranceChunks);
    const startedAt = state.startedAt;
    const endedAt = Date.now();

    utteranceChunks = [];
    state = { status: "listening", rollingPrefixBytes: prefixBuffer.byteLength };

    detector.reset();

    await params.callbacks.onSpeechStopped();

    params.logger.info(
      {
        utteranceBytes: utterance.length,
        utteranceAgeMs: Math.max(0, endedAt - startedAt),
      },
      "voice_turn.speech_stopped",
    );

    if (utterance.length === 0) {
      return;
    }

    enqueueUtteranceSubmission({
      pcm16: utterance,
      sampleRate: detector.requiredSampleRate,
      format: buildVoicePcmFormat(detector.requiredSampleRate),
      startedAt,
      endedAt,
    });
  }

  detector.on("speech_started", () => {
    void runSerial(handleSpeechStarted);
  });
  detector.on("speech_stopped", () => {
    void runSerial(handleSpeechStopped);
  });
  detector.on("error", fail);

  return {
    async start(): Promise<void> {
      await detector.connect();
      state = { status: "listening", rollingPrefixBytes: prefixBuffer.byteLength };
    },

    async stop(): Promise<void> {
      await runSerial(async () => {
        detector.close();
        prefixBuffer.clear();
        utteranceChunks = [];
        resampler?.reset();
        resampler = null;
        state = { status: "idle" };
      });
    },

    async appendClientChunk(input): Promise<void> {
      await runSerial(async () => {
        if (state.status === "idle") {
          return;
        }

        const pcm16 = Buffer.from(input.audioBase64, "base64");
        if (pcm16.length === 0) {
          return;
        }

        const parsedInputRate =
          parsePcmRateFromFormat(input.format, detector.requiredSampleRate) ??
          detector.requiredSampleRate;

        if (parsedInputRate !== inputRate) {
          inputRate = parsedInputRate;
          resampler =
            inputRate === detector.requiredSampleRate
              ? null
              : new Pcm16MonoResampler({
                  inputRate,
                  outputRate: detector.requiredSampleRate,
                });
        }

        const normalized = resampler === null ? pcm16 : resampler.processChunk(pcm16);
        if (normalized.length === 0) {
          return;
        }

        prefixBuffer.append(normalized);

        if (state.status === "listening") {
          state = {
            status: "listening",
            rollingPrefixBytes: prefixBuffer.byteLength,
          };
        } else if (state.status === "capturing") {
          utteranceChunks.push(normalized);
          state = {
            ...state,
            rollingPrefixBytes: prefixBuffer.byteLength,
            utteranceBytes: state.utteranceBytes + normalized.length,
          };
        }

        detector.appendPcm16(normalized);
      });
    },
  };
}
