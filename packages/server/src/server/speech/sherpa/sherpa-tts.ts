import type pino from "pino";
import { Readable } from "node:stream";
import { existsSync } from "node:fs";

import type { SpeechStreamResult, TextToSpeechProvider } from "../speech-provider.js";
import { chunkBuffer, float32ToPcm16le } from "../audio.js";
import { loadSherpaOnnx } from "./sherpa-onnx-loader.js";

export type SherpaTtsPreset = "kokoro-en-v0_19" | "kitten-nano-en-v0_1-fp16";

export type SherpaTtsConfig = {
  preset: SherpaTtsPreset;
  modelDir: string;
  speakerId?: number;
  speed?: number;
  lengthScale?: number;
  numThreads?: number;
};

function assertFileExists(filePath: string, label: string): void {
  if (!existsSync(filePath)) {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
}

export class SherpaOnnxTTS implements TextToSpeechProvider {
  private readonly tts: any;
  private readonly speakerId: number;
  private readonly speed: number;
  private readonly logger: pino.Logger;

  constructor(config: SherpaTtsConfig, logger: pino.Logger) {
    if (config.preset !== "kokoro-en-v0_19" && config.preset !== "kitten-nano-en-v0_1-fp16") {
      throw new Error(`Unsupported Sherpa TTS preset: ${config.preset}`);
    }
    this.logger = logger.child({ module: "speech", provider: "sherpa-onnx", component: "tts" });
    this.speakerId = config.speakerId ?? 0;
    this.speed = config.speed ?? 1.0;

    const sherpa = loadSherpaOnnx();

    const modelFile = config.preset === "kokoro-en-v0_19" ? "model.onnx" : "model.fp16.onnx";
    const modelPath = `${config.modelDir}/${modelFile}`;
    const voicesPath = `${config.modelDir}/voices.bin`;
    const tokensPath = `${config.modelDir}/tokens.txt`;
    const dataDir = `${config.modelDir}/espeak-ng-data`;

    assertFileExists(modelPath, "TTS model");
    assertFileExists(voicesPath, "TTS voices");
    assertFileExists(tokensPath, "TTS tokens");
    assertFileExists(dataDir, "TTS espeak-ng dataDir");

    const modelConfigKey =
      config.preset === "kokoro-en-v0_19"
        ? "offlineTtsKokoroModelConfig"
        : "offlineTtsKittenModelConfig";

    const modelConfig = {
      [modelConfigKey]: {
        model: modelPath,
        voices: voicesPath,
        tokens: tokensPath,
        dataDir,
        lengthScale: config.lengthScale ?? 1.0,
      },
      numThreads: config.numThreads ?? 2,
      debug: 0,
      provider: "cpu",
    };

    const offlineTtsConfig = {
      offlineTtsModelConfig: modelConfig,
      maxNumSentences: 1,
    };

    this.tts = sherpa.createOfflineTts(offlineTtsConfig);
    this.logger.info({ preset: config.preset, modelDir: config.modelDir }, "Sherpa offline TTS initialized");
  }

  async synthesizeSpeech(text: string): Promise<SpeechStreamResult> {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("Cannot synthesize empty text");
    }

    const audio = this.tts.generate({ text: trimmed, sid: this.speakerId, speed: this.speed });
    const samples: Float32Array | null =
      audio && audio.samples instanceof Float32Array
        ? audio.samples
        : audio && Array.isArray(audio.samples)
          ? Float32Array.from(audio.samples as number[])
          : null;
    const sampleRate: number =
      audio && typeof audio.sampleRate === "number" && Number.isFinite(audio.sampleRate) && audio.sampleRate > 0
        ? audio.sampleRate
        : typeof this.tts.sampleRate === "number"
          ? this.tts.sampleRate
          : 24000;

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
    try {
      this.tts?.free?.();
    } catch {
      // ignore
    }
  }
}
