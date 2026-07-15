import { existsSync } from "node:fs";
import type pino from "pino";

import { loadSherpaOnnxNode, type SherpaOnnxNodeModule } from "./sherpa-onnx-node-loader.js";

function assertFileExists(filePath: string, label: string): void {
  if (!existsSync(filePath)) {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
}

export type SherpaOfflineRecognizerModel =
  | {
      kind: "nemo_transducer";
      encoder: string;
      decoder: string;
      joiner: string;
      tokens: string;
    }
  | {
      kind: "sense_voice";
      model: string;
      tokens: string;
      useInverseTextNormalization?: boolean;
    }
  | {
      kind: "paraformer";
      model: string;
      tokens: string;
    };

export interface SherpaOfflineRecognizerConfig {
  model: SherpaOfflineRecognizerModel;
  numThreads?: number;
  provider?: "cpu";
  debug?: 0 | 1;
  sampleRate?: number;
  featureDim?: number;
  decodingMethod?: "greedy_search";
  maxActivePaths?: number;
  /** Injectable for tests; defaults to the real native addon loader. */
  loadSherpaOnnxNode?: () => SherpaOnnxNodeModule;
}

interface SherpaOfflineRecognizerNative {
  config?: { featConfig?: { sampleRate?: number } };
  createStream: () => unknown;
  decode: (stream: unknown) => void;
  getResult: (stream: unknown) => { text?: string } | string | undefined;
  free?: () => void;
}

interface SherpaOfflineStreamNative {
  acceptWaveform: ((arg: { samples: Float32Array; sampleRate: number }) => void) &
    ((sampleRate: number, samples: Float32Array) => void);
  free?: () => void;
}

export class SherpaOfflineRecognizerEngine {
  public readonly recognizer: SherpaOfflineRecognizerNative;
  public readonly sampleRate: number;
  private readonly logger: pino.Logger;

  constructor(config: SherpaOfflineRecognizerConfig, logger: pino.Logger) {
    this.logger = logger.child({
      module: "speech",
      provider: "local",
      component: "offline-recognizer",
    });

    const model = config.model;
    let modelConfig: Record<string, unknown>;

    switch (model.kind) {
      case "nemo_transducer": {
        assertFileExists(model.encoder, "offline encoder");
        assertFileExists(model.decoder, "offline decoder");
        assertFileExists(model.joiner, "offline joiner");
        assertFileExists(model.tokens, "tokens");
        modelConfig = {
          transducer: {
            encoder: model.encoder,
            decoder: model.decoder,
            joiner: model.joiner,
          },
          tokens: model.tokens,
          modelType: "nemo_transducer",
          numThreads: config.numThreads ?? 1,
          provider: config.provider ?? "cpu",
          debug: config.debug ?? 0,
        };
        break;
      }
      case "sense_voice": {
        assertFileExists(model.model, "sense_voice model");
        assertFileExists(model.tokens, "tokens");
        modelConfig = {
          senseVoice: {
            model: model.model,
            useInverseTextNormalization: model.useInverseTextNormalization !== false ? 1 : 0,
          },
          tokens: model.tokens,
          numThreads: config.numThreads ?? 1,
          provider: config.provider ?? "cpu",
          debug: config.debug ?? 0,
        };
        break;
      }
      case "paraformer": {
        assertFileExists(model.model, "paraformer model");
        assertFileExists(model.tokens, "tokens");
        modelConfig = {
          paraformer: {
            model: model.model,
          },
          tokens: model.tokens,
          numThreads: config.numThreads ?? 1,
          provider: config.provider ?? "cpu",
          debug: config.debug ?? 0,
        };
        break;
      }
    }

    const sherpa = (config.loadSherpaOnnxNode ?? loadSherpaOnnxNode)();

    const recognizerConfig = {
      featConfig: {
        sampleRate: config.sampleRate ?? 16000,
        featureDim: config.featureDim ?? 80,
      },
      modelConfig,
      decodingMethod: config.decodingMethod ?? "greedy_search",
      maxActivePaths: config.maxActivePaths ?? 4,
    };

    this.recognizer = new (
      sherpa as unknown as {
        OfflineRecognizer: new (config: unknown) => SherpaOfflineRecognizerNative;
      }
    ).OfflineRecognizer(recognizerConfig);
    const sr = this.recognizer?.config?.featConfig?.sampleRate;
    this.sampleRate =
      typeof sr === "number" && Number.isFinite(sr) && sr > 0
        ? sr
        : recognizerConfig.featConfig.sampleRate;

    this.logger.info(
      { sampleRate: this.sampleRate, numThreads: config.numThreads ?? 1, modelKind: model.kind },
      "Sherpa offline recognizer initialized",
    );
  }

  createStream(): SherpaOfflineStreamNative {
    return this.recognizer.createStream() as SherpaOfflineStreamNative;
  }

  acceptWaveform(
    stream: SherpaOfflineStreamNative,
    sampleRate: number,
    samples: Float32Array,
  ): void {
    if (!stream || typeof stream.acceptWaveform !== "function") {
      throw new Error("Unexpected sherpa offline stream: missing acceptWaveform()");
    }

    // sherpa-onnx-node expects: acceptWaveform({ samples, sampleRate })
    // sherpa-onnx (WASM) expects: acceptWaveform(sampleRate, samples)
    if (stream.acceptWaveform.length <= 1) {
      stream.acceptWaveform({ samples, sampleRate });
    } else {
      stream.acceptWaveform(sampleRate, samples);
    }
  }

  free(): void {
    try {
      this.recognizer?.free?.();
    } catch (err) {
      this.logger.warn({ err }, "Failed to free sherpa offline recognizer");
    }
  }
}
