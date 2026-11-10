import type pino from "pino";
import { Readable } from "node:stream";
import { existsSync } from "node:fs";
import path from "node:path";

import type { SpeechStreamResult, TextToSpeechProvider } from "../../../speech-provider.js";
import { chunkBuffer, float32ToPcm16le } from "../../../audio.js";
import { loadSherpaOnnxNode } from "./sherpa-onnx-node-loader.js";
import { engineFiles, type LocalTtsModelId, type TtsEngine } from "./model-catalog.js";

export interface SherpaTtsConfig {
  modelId: LocalTtsModelId;
  modelDir: string;
  engine: TtsEngine;
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

// Each engine family takes its own block under sherpa's TTS model config.
function buildTtsModelConfig(
  modelDir: string,
  engine: TtsEngine,
  lengthScale: number,
): Record<string, unknown> {
  const file = (name: string) => path.join(modelDir, name);
  switch (engine.family) {
    case "kokoro":
      return {
        kokoro: {
          model: file(engine.model),
          voices: file(engine.voices),
          tokens: file(engine.tokens),
          dataDir: file(engine.dataDir),
          lexicon: (engine.lexicons ?? []).map(file).join(","),
          dictDir: engine.dictDir ? file(engine.dictDir) : "",
          lengthScale,
        },
      };
    case "kitten":
      return {
        kitten: {
          model: file(engine.model),
          voices: file(engine.voices),
          tokens: file(engine.tokens),
          dataDir: file(engine.dataDir),
          lengthScale,
        },
      };
    case "vits":
      return {
        vits: {
          model: file(engine.model),
          tokens: file(engine.tokens),
          dataDir: file(engine.dataDir),
          lengthScale,
        },
      };
  }
}

function ruleFsts(modelDir: string, engine: TtsEngine): string {
  if (engine.family !== "kokoro" || !engine.ruleFsts) return "";
  return engine.ruleFsts.map((name) => path.join(modelDir, name)).join(",");
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

    for (const name of engineFiles(config.engine)) {
      assertFileExists(path.join(config.modelDir, name), `${config.engine.family} TTS file`);
    }

    const modelConfig = {
      // The native parser reads these under model, despite the upstream JS typedef.
      numThreads: config.numThreads ?? 2,
      provider: "cpu",
      ...buildTtsModelConfig(config.modelDir, config.engine, config.lengthScale ?? 1.0),
    };

    const offlineTtsConfig = {
      model: modelConfig,
      maxNumSentences: 1,
      ruleFsts: ruleFsts(config.modelDir, config.engine),
    };

    this.tts = new (
      sherpa as unknown as { OfflineTts: new (config: unknown) => SherpaOfflineTtsNative }
    ).OfflineTts(offlineTtsConfig);
    this.logger.info(
      { modelId: config.modelId, modelDir: config.modelDir },
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
