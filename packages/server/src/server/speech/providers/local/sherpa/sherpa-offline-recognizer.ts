import { existsSync } from "node:fs";
import type pino from "pino";

import { loadSherpaOnnxNode } from "./sherpa-onnx-node-loader.js";

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
      kind: "qwen3_asr";
      convFrontend: string;
      encoder: string;
      decoder: string;
      tokenizer: string;
      hotwords?: string;
      maxTotalLen?: number;
      maxNewTokens?: number;
      temperature?: number;
      topP?: number;
      seed?: number;
    };

export type SherpaOfflineRecognizerConfig = {
  model: SherpaOfflineRecognizerModel;
  numThreads?: number;
  provider?: "cpu";
  debug?: 0 | 1;
  sampleRate?: number;
  featureDim?: number;
  decodingMethod?: "greedy_search";
  maxActivePaths?: number;
};

export class SherpaOfflineRecognizerEngine {
  public readonly recognizer: any;
  public readonly sampleRate: number;
  private readonly logger: pino.Logger;

  constructor(config: SherpaOfflineRecognizerConfig, logger: pino.Logger) {
    this.logger = logger.child({
      module: "speech",
      provider: "local",
      component: "offline-recognizer",
    });

    if (config.model.kind === "nemo_transducer") {
      assertFileExists(config.model.encoder, "offline encoder");
      assertFileExists(config.model.decoder, "offline decoder");
      assertFileExists(config.model.joiner, "offline joiner");
      assertFileExists(config.model.tokens, "tokens");
    } else {
      assertFileExists(config.model.convFrontend, "qwen3 conv frontend");
      assertFileExists(config.model.encoder, "qwen3 encoder");
      assertFileExists(config.model.decoder, "qwen3 decoder");
      assertFileExists(config.model.tokenizer, "qwen3 tokenizer");
    }

    const sherpa = loadSherpaOnnxNode();

    const recognizerConfig = {
      featConfig: {
        sampleRate: config.sampleRate ?? 16000,
        featureDim: config.featureDim ?? 80,
      },
      modelConfig: {
        ...(config.model.kind === "nemo_transducer"
          ? {
              transducer: {
                encoder: config.model.encoder,
                decoder: config.model.decoder,
                joiner: config.model.joiner,
              },
              tokens: config.model.tokens,
              modelType: "nemo_transducer",
            }
          : {
              qwen3Asr: {
                convFrontend: config.model.convFrontend,
                encoder: config.model.encoder,
                decoder: config.model.decoder,
                tokenizer: config.model.tokenizer,
                hotwords: config.model.hotwords ?? "",
                maxTotalLen: config.model.maxTotalLen ?? 512,
                maxNewTokens: config.model.maxNewTokens ?? 512,
                temperature: config.model.temperature ?? 1e-6,
                topP: config.model.topP ?? 0.8,
                seed: config.model.seed ?? 42,
              },
              tokens: "",
            }),
        numThreads: config.numThreads ?? 1,
        provider: config.provider ?? "cpu",
        debug: config.debug ?? 0,
      },
      decodingMethod: config.decodingMethod ?? "greedy_search",
      maxActivePaths: config.maxActivePaths ?? 4,
    };

    this.recognizer = new sherpa.OfflineRecognizer(recognizerConfig);
    const sr = this.recognizer?.config?.featConfig?.sampleRate;
    this.sampleRate =
      typeof sr === "number" && Number.isFinite(sr) && sr > 0
        ? sr
        : recognizerConfig.featConfig.sampleRate;

    this.logger.info(
      {
        sampleRate: this.sampleRate,
        modelKind: config.model.kind,
        numThreads: recognizerConfig.modelConfig.numThreads,
      },
      "Sherpa offline recognizer initialized",
    );
  }

  createStream(): any {
    return this.recognizer.createStream();
  }

  acceptWaveform(stream: any, sampleRate: number, samples: Float32Array): void {
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
