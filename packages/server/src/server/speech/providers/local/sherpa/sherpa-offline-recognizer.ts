import { existsSync } from "node:fs";
import type pino from "pino";

import { loadSherpaOnnxNode } from "./sherpa-onnx-node-loader.js";

function assertFileExists(filePath: string, label: string): void {
  if (!existsSync(filePath)) {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
}

export interface SherpaNemoTransducerModel {
  kind: "nemo_transducer";
  encoder: string;
  decoder: string;
  joiner: string;
  tokens: string;
}

export interface SherpaParaformerModel {
  kind: "paraformer";
  model: string;
  tokens: string;
}

export type SherpaOfflineRecognizerModel = SherpaNemoTransducerModel | SherpaParaformerModel;

export interface SherpaOfflineRecognizerConfig {
  model: SherpaOfflineRecognizerModel;
  numThreads?: number;
  provider?: "cpu";
  debug?: 0 | 1;
  sampleRate?: number;
  featureDim?: number;
  decodingMethod?: "greedy_search";
  maxActivePaths?: number;
}

interface SherpaOfflineModelConfigBase {
  tokens: string;
  numThreads: number;
  provider: "cpu";
  debug: 0 | 1;
}

interface SherpaNemoTransducerConfig extends SherpaOfflineModelConfigBase {
  transducer: {
    encoder: string;
    decoder: string;
    joiner: string;
  };
  modelType: "nemo_transducer";
}

interface SherpaParaformerConfig extends SherpaOfflineModelConfigBase {
  paraformer: { model: string };
  modelType: "paraformer";
}

type SherpaOfflineModelConfig = SherpaNemoTransducerConfig | SherpaParaformerConfig;

function createOfflineModelConfig(config: SherpaOfflineRecognizerConfig): SherpaOfflineModelConfig {
  const common = {
    tokens: config.model.tokens,
    numThreads: config.numThreads ?? 1,
    provider: config.provider ?? "cpu",
    debug: config.debug ?? 0,
  };

  switch (config.model.kind) {
    case "nemo_transducer":
      assertFileExists(config.model.encoder, "offline encoder");
      assertFileExists(config.model.decoder, "offline decoder");
      assertFileExists(config.model.joiner, "offline joiner");
      assertFileExists(config.model.tokens, "tokens");
      return {
        transducer: {
          encoder: config.model.encoder,
          decoder: config.model.decoder,
          joiner: config.model.joiner,
        },
        ...common,
        modelType: "nemo_transducer",
      };
    case "paraformer":
      assertFileExists(config.model.model, "Paraformer model");
      assertFileExists(config.model.tokens, "tokens");
      return {
        paraformer: { model: config.model.model },
        ...common,
        modelType: "paraformer",
      };
  }
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

    const modelConfig = createOfflineModelConfig(config);

    const sherpa = loadSherpaOnnxNode();

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
      {
        modelKind: config.model.kind,
        sampleRate: this.sampleRate,
        numThreads: modelConfig.numThreads,
      },
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
