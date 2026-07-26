import type pino from "pino";
import { PassThrough } from "node:stream";
import { existsSync } from "node:fs";

import type { SpeechStreamResult, TextToSpeechProvider } from "../../../speech-provider.js";
import { float32ToPcm16le } from "../../../audio.js";
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
  generate: (args: {
    text: string;
    sid: number;
    speed: number;
    enableExternalBuffer: boolean;
  }) => { samples?: Float32Array | number[]; sampleRate?: number } | undefined;
  generateAsync?: (
    args: { text: string; sid: number; speed: number; enableExternalBuffer: boolean },
    onProgress: (samples: Float32Array | number[], progress: number) => number,
  ) => Promise<{ sampleRate?: number } | undefined>;
  free?: () => void;
}

export class SherpaOnnxTTS implements TextToSpeechProvider {
  private readonly tts: SherpaOfflineTtsNative;
  private readonly speakerId: number;
  private readonly speed: number;
  private readonly logger: pino.Logger;

  constructor(config: SherpaTtsConfig, logger: pino.Logger) {
    this.logger = logger.child({ module: "speech", provider: "local", component: "tts" });
    this.speakerId = config.speakerId ?? 0;
    this.speed = config.speed ?? 1.0;

    const sherpa = loadSherpaOnnxNode();
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
      numThreads: config.numThreads ?? 2,
      provider: "cpu",
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

  synthesizeSpeech(text: string): Promise<SpeechStreamResult> {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("Cannot synthesize empty text");
    }

    const sampleRate =
      typeof this.tts.sampleRate === "number" && this.tts.sampleRate > 0
        ? this.tts.sampleRate
        : 24000;

    if (this.tts.generateAsync) {
      return this.synthesizeStreaming(trimmed, sampleRate);
    }
    return this.synthesizeBatch(trimmed, sampleRate);
  }

  private synthesizeStreaming(text: string, sampleRate: number): Promise<SpeechStreamResult> {
    const passThrough = new PassThrough();

    void this.tts.generateAsync!(
      { text, sid: this.speakerId, speed: this.speed, enableExternalBuffer: false },
      (samples) => {
        // Copy to avoid "External buffers are not allowed" with native-backed arrays.
        const copied = Float32Array.from(
          samples instanceof Float32Array ? samples : Float32Array.from(samples),
        );
        passThrough.push(float32ToPcm16le(copied));
        return 1; // continue synthesis
      },
    ).then(() => {
      passThrough.end();
    }).catch((err: unknown) => {
      passThrough.destroy(err instanceof Error ? err : new Error(String(err)));
    });

    return Promise.resolve({ stream: passThrough, format: `pcm;rate=${sampleRate}` });
  }

  private async synthesizeBatch(text: string, sampleRate: number): Promise<SpeechStreamResult> {
    const audio = this.tts.generate({
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
    if (!samples) {
      throw new Error("Unexpected sherpa TTS output: missing Float32 samples");
    }
    const passThrough = new PassThrough();
    passThrough.end(float32ToPcm16le(samples));
    return { stream: passThrough, format: `pcm;rate=${sampleRate}` };
  }

  free(): void {
    try {
      this.tts?.free?.();
    } catch {
      // ignore
    }
  }
}
