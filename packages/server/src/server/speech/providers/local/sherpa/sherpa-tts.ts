import type pino from "pino";
import { Readable } from "node:stream";
import { existsSync } from "node:fs";

import type { SpeechStreamResult, TextToSpeechProvider } from "../../../speech-provider.js";
import { chunkBuffer, float32ToPcm16le } from "../../../audio.js";
import { loadSherpaOnnxNode } from "./sherpa-onnx-node-loader.js";

export type SherpaTtsPreset = "kokoro-en-v0_19";

export interface SherpaTtsConfig {
  preset: SherpaTtsPreset;
  modelDir: string;
  speakerId?: number;
  speed?: number;
  lengthScale?: number;
  numThreads?: number;
}

function assertFileExists(filePath: string, label: string): void {
  if (!existsSync(filePath)) {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
}

interface SherpaOfflineTtsNative {
  sampleRate?: number;
  generateAsync: (args: {
    text: string;
    sid: number;
    speed: number;
    enableExternalBuffer: boolean;
  }) => Promise<{ samples?: Float32Array | number[]; sampleRate?: number } | undefined>;
  free?: () => void;
}

export class SherpaOnnxTTS implements TextToSpeechProvider {
  private readonly tts: SherpaOfflineTtsNative;
  private readonly speakerId: number;
  private readonly speed: number;
  private readonly logger: pino.Logger;
  private synthesisQueue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    config: SherpaTtsConfig,
    logger: pino.Logger,
    loadNative: () => Pick<
      ReturnType<typeof loadSherpaOnnxNode>,
      "OfflineTts"
    > = loadSherpaOnnxNode,
  ) {
    this.logger = logger.child({ module: "speech", provider: "local", component: "tts" });
    this.speakerId = config.speakerId ?? 0;
    this.speed = config.speed ?? 1.0;

    const sherpa = loadNative();
    if (typeof sherpa.OfflineTts !== "function") {
      throw new Error("sherpa-onnx-node OfflineTts is unavailable");
    }

    const modelPath = `${config.modelDir}/model.onnx`;
    const voicesPath = `${config.modelDir}/voices.bin`;
    const tokensPath = `${config.modelDir}/tokens.txt`;
    const dataDir = `${config.modelDir}/espeak-ng-data`;

    assertFileExists(modelPath, "TTS model");
    assertFileExists(voicesPath, "TTS voices");
    assertFileExists(tokensPath, "TTS tokens");
    assertFileExists(dataDir, "TTS espeak-ng dataDir");

    const modelConfig = {
      // The native parser reads these under model, despite the upstream JS typedef.
      numThreads: config.numThreads ?? 2,
      provider: "cpu",
      kokoro: {
        model: modelPath,
        voices: voicesPath,
        tokens: tokensPath,
        dataDir,
        lengthScale: config.lengthScale ?? 1.0,
      },
    };

    const offlineTtsConfig = {
      model: modelConfig,
      maxNumSentences: 1,
    };

    this.tts = new (
      sherpa as unknown as { OfflineTts: new (config: unknown) => SherpaOfflineTtsNative }
    ).OfflineTts(offlineTtsConfig);
    this.logger.info(
      { preset: config.preset, modelDir: config.modelDir },
      "Sherpa offline TTS initialized",
    );
  }

  async synthesizeSpeech(text: string): Promise<SpeechStreamResult> {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("Cannot synthesize empty text");
    }

    // The native handle is not reentrant. Keep prefetch off the worker event loop
    // while allowing only one generation at a time on this model.
    const result = this.synthesisQueue.then(() => this.generateSpeech(trimmed));
    this.synthesisQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async generateSpeech(text: string): Promise<SpeechStreamResult> {
    if (this.closed) {
      throw new Error("TTS provider closed");
    }
    const audio = await this.tts.generateAsync({
      text,
      sid: this.speakerId,
      speed: this.speed,
      // Electron rejects native external-backed typed arrays. Request a copied buffer
      // from sherpa itself instead of trying to clone after generate() returns.
      enableExternalBuffer: false,
    });
    let rawSamples: Float32Array | null = null;
    if (audio && audio.samples instanceof Float32Array) {
      rawSamples = audio.samples;
    } else if (audio && Array.isArray(audio.samples)) {
      rawSamples = Float32Array.from(audio.samples);
    }
    // Copy to avoid "External buffers are not allowed" when sherpa-onnx
    // returns a Float32Array backed by native memory.
    const samples = rawSamples ? Float32Array.from(rawSamples) : null;
    let sampleRate: number;
    if (
      audio &&
      typeof audio.sampleRate === "number" &&
      Number.isFinite(audio.sampleRate) &&
      audio.sampleRate > 0
    ) {
      sampleRate = audio.sampleRate;
    } else if (typeof this.tts.sampleRate === "number") {
      sampleRate = this.tts.sampleRate;
    } else {
      sampleRate = 24000;
    }

    if (!samples) {
      throw new Error("Unexpected sherpa TTS output: missing Float32 samples");
    }

    const pcm16 = float32ToPcm16le(samples);
    const chunkBytes = Math.max(2, Math.round(sampleRate * 0.05) * 2); // ~50ms
    const chunks = chunkBuffer(pcm16, chunkBytes);

    return {
      stream: Readable.from(chunks),
      format: `pcm;rate=${sampleRate}`,
    };
  }

  free(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    // Let the active native call finish before releasing its handle. Queued
    // calls observe closed and never enter native code.
    void this.synthesisQueue.then(() => {
      try {
        this.tts.free?.();
      } catch {
        // ignore
      }
      return undefined;
    });
  }
}
