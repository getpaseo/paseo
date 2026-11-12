import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";

import { pcm16leToFloat32 } from "../../../audio.js";
import type { TurnDetectionSession } from "../../../turn-detection-provider.js";
import { loadSherpaOnnxNode } from "./sherpa-onnx-node-loader.js";

const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_BUFFER_SIZE_SECONDS = 60;
const DEFAULT_SILERO_THRESHOLD = 0.5;
const DEFAULT_WINDOW_SIZE = 512;

// Silero internal durations — kept low so isDetected() tracks actual sound.
// Our own state machine handles speech confirmation and end-of-speech detection.
const SILERO_MIN_SILENCE_DURATION = 0.2;
const SILERO_MIN_SPEECH_DURATION = 0.1;

// Our boundary detection thresholds (in milliseconds).
const DEFAULT_CONFIRM_MS = 800;
const DEFAULT_SILENCE_MS = 1000;

// Silero judges the shape of a sound, not its level: after a reset it reports speech on
// the residue an echo canceller leaves behind (-64 dBFS and below on an iPhone speaker,
// where a talker sits at -10 to -30 dBFS). Windows quieter than this reach it as silence.
const DEFAULT_MIN_WINDOW_DBFS = -55;

// Speech fills most of the windows while it is being confirmed; clicks and taps fill few.
const MIN_LOUD_SHARE_TO_CONFIRM = 0.5;

/** Whether enough of the windows heard while confirming speech were above the level gate. */
export function isMostlySound(loudWindows: number, windows: number): boolean {
  return windows > 0 && loudWindows >= windows * MIN_LOUD_SHARE_TO_CONFIRM;
}

/** Root-mean-square level of float samples in dB relative to full scale. */
export function windowLevelDbfs(samples: Float32Array): number {
  if (samples.length === 0) {
    return -Infinity;
  }
  let sumOfSquares = 0;
  for (const sample of samples) {
    sumOfSquares += sample * sample;
  }
  return 10 * Math.log10(sumOfSquares / samples.length);
}

interface SherpaVadHandle {
  acceptWaveform(samples: Float32Array): void;
  isDetected(): boolean;
  isEmpty(): boolean;
  flush(): void;
  reset(): void;
}

interface SherpaCircularBufferHandle {
  push(samples: Float32Array): void;
  get(startIndex: number, n: number, enableExternalBuffer?: boolean): Float32Array;
  pop(n: number): void;
  size(): number;
  head(): number;
  reset(): void;
}

interface SherpaVadModule {
  Vad: new (config: Record<string, unknown>, bufferSizeInSeconds: number) => SherpaVadHandle;
  CircularBuffer: new (capacity: number) => SherpaCircularBufferHandle;
}

export function resolveBundledSileroVadModelPath(): string {
  return fileURLToPath(new URL("./assets/silero_vad.onnx", import.meta.url));
}

export interface SherpaSileroVadSessionConfig {
  modelPath?: string;
  sampleRate?: number;
  threshold?: number;
  windowSize?: number;
  bufferSizeInSeconds?: number;
  confirmMs?: number;
  silenceMs?: number;
  /** Windows below this level are fed to the detector as silence. */
  minWindowDbfs?: number;
}

type VadPhase =
  | { state: "idle" }
  | { state: "confirming"; startedAt: number; windows: number; loudWindows: number }
  | { state: "speaking" }
  | { state: "ending"; startedAt: number };

export class SherpaSileroVadSession extends EventEmitter implements TurnDetectionSession {
  public readonly requiredSampleRate: number;

  private readonly vad: SherpaVadHandle;
  private readonly inputBuffer: SherpaCircularBufferHandle;
  private readonly windowSize: number;
  private readonly msPerWindow: number;
  private readonly confirmMs: number;
  private readonly silenceMs: number;
  private readonly minWindowDbfs: number;
  private readonly silentWindow: Float32Array;
  private connected = false;
  private phase: VadPhase = { state: "idle" };
  private windowTimestamp = 0;
  private readonly logger;

  constructor(params: {
    logger: { debug: (...args: unknown[]) => void };
    config?: SherpaSileroVadSessionConfig;
  }) {
    super();
    this.logger = params.logger;
    const config = params.config ?? {};
    this.requiredSampleRate = config.sampleRate ?? DEFAULT_SAMPLE_RATE;
    this.windowSize = config.windowSize ?? DEFAULT_WINDOW_SIZE;
    this.msPerWindow = (this.windowSize / this.requiredSampleRate) * 1000;
    this.confirmMs = config.confirmMs ?? DEFAULT_CONFIRM_MS;
    this.silenceMs = config.silenceMs ?? DEFAULT_SILENCE_MS;
    this.minWindowDbfs = config.minWindowDbfs ?? DEFAULT_MIN_WINDOW_DBFS;
    this.silentWindow = new Float32Array(this.windowSize);

    const threshold = config.threshold ?? DEFAULT_SILERO_THRESHOLD;

    this.logger.debug(
      {
        threshold,
        sileroMinSilenceDuration: SILERO_MIN_SILENCE_DURATION,
        sileroMinSpeechDuration: SILERO_MIN_SPEECH_DURATION,
        confirmMs: this.confirmMs,
        silenceMs: this.silenceMs,
        windowSize: this.windowSize,
        msPerWindow: this.msPerWindow,
        sampleRate: this.requiredSampleRate,
      },
      "[VAD] Initializing Silero VAD session",
    );

    const sherpa = loadSherpaOnnxNode() as unknown as SherpaVadModule;
    this.vad = new sherpa.Vad(
      {
        sileroVad: {
          model: config.modelPath ?? resolveBundledSileroVadModelPath(),
          threshold,
          minSilenceDuration: SILERO_MIN_SILENCE_DURATION,
          minSpeechDuration: SILERO_MIN_SPEECH_DURATION,
          windowSize: this.windowSize,
        },
        sampleRate: this.requiredSampleRate,
        numThreads: 1,
        provider: "cpu",
        debug: 0,
      },
      config.bufferSizeInSeconds ?? DEFAULT_BUFFER_SIZE_SECONDS,
    );
    this.inputBuffer = new sherpa.CircularBuffer(
      (config.bufferSizeInSeconds ?? DEFAULT_BUFFER_SIZE_SECONDS) * this.requiredSampleRate,
    );
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  appendPcm16(pcm16le: Buffer): void {
    if (!this.connected) {
      this.emit("error", new Error("Turn detection session not connected"));
      return;
    }
    if (pcm16le.length === 0) {
      return;
    }

    try {
      const samples = pcm16leToFloat32(pcm16le, 1);
      this.inputBuffer.push(samples);
      let windowsProcessed = 0;
      while (this.inputBuffer.size() > this.windowSize) {
        const window = this.inputBuffer.get(this.inputBuffer.head(), this.windowSize, false);
        this.inputBuffer.pop(this.windowSize);
        const loud = windowLevelDbfs(window) >= this.minWindowDbfs;
        this.vad.acceptWaveform(loud ? window : this.silentWindow);
        this.windowTimestamp += this.msPerWindow;
        windowsProcessed++;
        this.stepStateMachine(loud);
      }
    } catch (error) {
      this.emit("error", error instanceof Error ? error : new Error(String(error)));
    }
  }

  flush(): void {
    if (!this.connected) {
      return;
    }

    try {
      this.logger.debug({ phase: this.phase.state }, "[VAD] Flushing remaining audio");
      this.vad.flush();
      this.stepStateMachine();
      if (this.phase.state === "speaking" || this.phase.state === "ending") {
        this.logger.debug("[VAD] Forcing speech_stopped after flush");
        this.phase = { state: "idle" };
        this.emit("speech_stopped");
      } else if (this.phase.state === "confirming") {
        this.logger.debug("[VAD] Discarding unconfirmed speech on flush");
        this.phase = { state: "idle" };
      }
    } catch (error) {
      this.emit("error", error instanceof Error ? error : new Error(String(error)));
    }
  }

  reset(): void {
    try {
      this.vad.reset();
      this.inputBuffer.reset();
    } catch {
      // ignore native cleanup failures
    } finally {
      this.phase = { state: "idle" };
    }
  }

  close(): void {
    this.reset();
    this.connected = false;
    this.windowTimestamp = 0;
  }

  private stepStateMachine(loud = false): void {
    const detected = this.vad.isDetected();
    const now = this.windowTimestamp;

    switch (this.phase.state) {
      case "idle": {
        if (detected) {
          this.logger.debug({ now }, "[VAD] idle → confirming (detection started)");
          this.phase = {
            state: "confirming",
            startedAt: now,
            windows: 1,
            loudWindows: loud ? 1 : 0,
          };
        }
        break;
      }

      case "confirming": {
        if (!detected) {
          const elapsed = now - this.phase.startedAt;
          this.logger.debug(
            { elapsed, confirmMs: this.confirmMs },
            "[VAD] confirming → idle (detection dropped before confirmation)",
          );
          this.phase = { state: "idle" };
          break;
        }
        this.phase.windows += 1;
        this.phase.loudWindows += loud ? 1 : 0;
        const elapsed = now - this.phase.startedAt;
        if (
          elapsed >= this.confirmMs &&
          !isMostlySound(this.phase.loudWindows, this.phase.windows)
        ) {
          // Sparse bursts (key clicks, taps) keep the model on between them. Keep waiting
          // for a stretch that is mostly sound.
          this.phase = { state: "confirming", startedAt: now, windows: 0, loudWindows: 0 };
          break;
        }
        if (elapsed >= this.confirmMs) {
          this.logger.debug(
            { elapsed, confirmMs: this.confirmMs },
            "[VAD] confirming → speaking (speech confirmed)",
          );
          this.phase = { state: "speaking" };
          this.emit("speech_started");
        }
        break;
      }

      case "speaking": {
        if (!detected) {
          this.logger.debug({ now }, "[VAD] speaking → ending (silence started)");
          this.phase = { state: "ending", startedAt: now };
        }
        break;
      }

      case "ending": {
        if (detected) {
          this.logger.debug(
            { elapsed: now - this.phase.startedAt },
            "[VAD] ending → speaking (speech resumed)",
          );
          this.phase = { state: "speaking" };
          break;
        }
        const elapsed = now - this.phase.startedAt;
        if (elapsed >= this.silenceMs) {
          this.logger.debug(
            { elapsed, silenceMs: this.silenceMs },
            "[VAD] ending → idle (speech stopped)",
          );
          this.phase = { state: "idle" };
          this.emit("speech_stopped");
        }
        break;
      }
    }
  }
}
