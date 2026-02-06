import { existsSync } from "node:fs";
import type pino from "pino";

import { loadSherpaOnnx } from "./sherpa-onnx-loader.js";

export type SherpaOnlineRecognizerModel =
  | {
      kind: "transducer";
      encoder: string;
      decoder: string;
      joiner: string;
      tokens: string;
      modelType?: string;
    }
  | {
      kind: "paraformer";
      encoder: string;
      decoder: string;
      tokens: string;
    };

export type SherpaOnlineRecognizerConfig = {
  model: SherpaOnlineRecognizerModel;
  numThreads?: number;
  provider?: "cpu";
  debug?: 0 | 1;
  sampleRate?: number;
  featureDim?: number;
  decodingMethod?: "greedy_search";
  maxActivePaths?: number;
  enableEndpoint?: 0 | 1;
  rule1MinTrailingSilence?: number;
  rule2MinTrailingSilence?: number;
  rule3MinUtteranceLength?: number;
};

function assertFileExists(filePath: string, label: string): void {
  if (!existsSync(filePath)) {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
}

export class SherpaOnlineRecognizerEngine {
  public readonly recognizer: any;
  public readonly sampleRate: number;
  private readonly logger: pino.Logger;

  constructor(config: SherpaOnlineRecognizerConfig, logger: pino.Logger) {
    this.logger = logger.child({ module: "speech", provider: "sherpa-onnx", component: "online-recognizer" });

    const { model } = config;
    if (model.kind === "transducer") {
      assertFileExists(model.encoder, "transducer encoder");
      assertFileExists(model.decoder, "transducer decoder");
      assertFileExists(model.joiner, "transducer joiner");
      assertFileExists(model.tokens, "tokens");
    } else {
      assertFileExists(model.encoder, "paraformer encoder");
      assertFileExists(model.decoder, "paraformer decoder");
      assertFileExists(model.tokens, "tokens");
    }

    const sherpa = loadSherpaOnnx();
    const modelConfig =
      model.kind === "transducer"
        ? {
            transducer: {
              encoder: model.encoder,
              decoder: model.decoder,
              joiner: model.joiner,
            },
            tokens: model.tokens,
            modelType: model.modelType ?? "zipformer",
          }
        : {
            paraformer: {
              encoder: model.encoder,
              decoder: model.decoder,
            },
            tokens: model.tokens,
          };

    const featConfig = {
      sampleRate: config.sampleRate ?? 16000,
      featureDim: config.featureDim ?? 80,
    };

    const recognizerConfig = {
      featConfig,
      modelConfig: {
        ...modelConfig,
        // NOTE: In the WASM-backed `sherpa-onnx` npm package, online recognizers
        // error when `numThreads > 1`. Keep the default conservative.
        numThreads: config.numThreads ?? 1,
        provider: config.provider ?? "cpu",
        debug: config.debug ?? 0,
      },
      decodingMethod: config.decodingMethod ?? "greedy_search",
      maxActivePaths: config.maxActivePaths ?? 4,
      enableEndpoint: config.enableEndpoint ?? 0,
      rule1MinTrailingSilence: config.rule1MinTrailingSilence ?? 2.4,
      rule2MinTrailingSilence: config.rule2MinTrailingSilence ?? 1.2,
      rule3MinUtteranceLength: config.rule3MinUtteranceLength ?? 20,
    };

    this.recognizer = sherpa.createOnlineRecognizer(recognizerConfig);
    const sr = this.recognizer?.config?.featConfig?.sampleRate;
    this.sampleRate = typeof sr === "number" && Number.isFinite(sr) && sr > 0 ? sr : featConfig.sampleRate;

    this.logger.info(
      { sampleRate: this.sampleRate, modelKind: model.kind, numThreads: config.numThreads ?? 2 },
      "Sherpa online recognizer initialized"
    );
  }

  createStream(): any {
    return this.recognizer.createStream();
  }

  free(): void {
    try {
      this.recognizer?.free?.();
    } catch (err) {
      this.logger.warn({ err }, "Failed to free sherpa recognizer");
    }
  }
}
