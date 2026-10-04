import { existsSync } from "node:fs";
import path from "node:path";
import type pino from "pino";

import { loadSherpaOnnxNode } from "./sherpa-onnx-node-loader.js";
import { SHERPA_ONNX_MODEL_CATALOG, type LocalSttModelId } from "./model-catalog.js";
import { getSherpaOnnxModelDir } from "./model-downloader.js";

function assertFileExists(filePath: string, label: string): void {
  if (!existsSync(filePath)) {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
}

interface SherpaTransducerModel {
  kind: "nemo_transducer";
  encoder: string;
  decoder: string;
  joiner: string;
  tokens: string;
}

interface SherpaSenseVoiceModel {
  kind: "sense_voice";
  model: string;
  tokens: string;
}

export type SherpaOfflineRecognizerModel = SherpaTransducerModel | SherpaSenseVoiceModel;

export function getSherpaOfflineRecognizerModel(
  modelsDir: string,
  modelId: LocalSttModelId,
): SherpaOfflineRecognizerModel {
  const modelDir = getSherpaOnnxModelDir(modelsDir, modelId);
  const tokens = path.join(modelDir, "tokens.txt");
  if (SHERPA_ONNX_MODEL_CATALOG[modelId].recognizer === "sense_voice") {
    return { kind: "sense_voice", model: path.join(modelDir, "model.int8.onnx"), tokens };
  }
  return {
    kind: "nemo_transducer",
    encoder: path.join(modelDir, "encoder.int8.onnx"),
    decoder: path.join(modelDir, "decoder.int8.onnx"),
    joiner: path.join(modelDir, "joiner.int8.onnx"),
    tokens,
  };
}

function recognizerModelConfig(model: SherpaOfflineRecognizerModel) {
  assertFileExists(model.tokens, "tokens");
  if (model.kind === "sense_voice") {
    assertFileExists(model.model, "SenseVoice model");
    return {
      senseVoice: { model: model.model, language: "auto", useInverseTextNormalization: 1 },
      tokens: model.tokens,
      modelType: "sense_voice",
    };
  }
  assertFileExists(model.encoder, "offline encoder");
  assertFileExists(model.decoder, "offline decoder");
  assertFileExists(model.joiner, "offline joiner");
  return {
    transducer: { encoder: model.encoder, decoder: model.decoder, joiner: model.joiner },
    tokens: model.tokens,
    modelType: "nemo_transducer",
  };
}

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

    const modelConfig = recognizerModelConfig(config.model);

    const sherpa = loadSherpaOnnxNode();

    const recognizerConfig = {
      featConfig: {
        sampleRate: config.sampleRate ?? 16000,
        featureDim: config.featureDim ?? 80,
      },
      modelConfig: {
        ...modelConfig,
        numThreads: config.numThreads ?? 1,
        provider: config.provider ?? "cpu",
        debug: config.debug ?? 0,
      },
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
      { sampleRate: this.sampleRate, numThreads: recognizerConfig.modelConfig.numThreads },
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
