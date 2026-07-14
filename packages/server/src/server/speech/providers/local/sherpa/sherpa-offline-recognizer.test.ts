import pino from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { recognizerConfigs } = vi.hoisted(() => ({
  recognizerConfigs: [] as unknown[],
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true),
}));

vi.mock("./sherpa-onnx-node-loader.js", () => ({
  loadSherpaOnnxNode: () => ({
    OfflineRecognizer: class {
      public readonly config: unknown;

      constructor(config: unknown) {
        this.config = config;
        recognizerConfigs.push(config);
      }

      createStream() {
        return {};
      }

      decode() {}

      getResult() {
        return { text: "" };
      }
    },
  }),
}));

import { SherpaOfflineRecognizerEngine } from "./sherpa-offline-recognizer.js";

describe("SherpaOfflineRecognizerEngine model configuration", () => {
  beforeEach(() => {
    recognizerConfigs.length = 0;
  });

  it("builds the SenseVoice recognizer configuration", () => {
    const engine = new SherpaOfflineRecognizerEngine(
      {
        model: {
          kind: "sense_voice",
          model: "/models/sensevoice/model.int8.onnx",
          tokens: "/models/sensevoice/tokens.txt",
        },
        numThreads: 2,
      },
      pino({ level: "silent" }),
    );

    expect(engine.sampleRate).toBe(16000);
    expect(recognizerConfigs).toEqual([
      {
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          senseVoice: {
            model: "/models/sensevoice/model.int8.onnx",
            useInverseTextNormalization: 1,
          },
          tokens: "/models/sensevoice/tokens.txt",
          numThreads: 2,
          provider: "cpu",
          debug: 0,
        },
        decodingMethod: "greedy_search",
        maxActivePaths: 4,
      },
    ]);
  });

  it("builds the Paraformer recognizer configuration", () => {
    const engine = new SherpaOfflineRecognizerEngine(
      {
        model: {
          kind: "paraformer",
          model: "/models/paraformer/model.int8.onnx",
          tokens: "/models/paraformer/tokens.txt",
        },
        sampleRate: 8000,
        debug: 1,
      },
      pino({ level: "silent" }),
    );

    expect(engine.sampleRate).toBe(8000);
    expect(recognizerConfigs).toEqual([
      {
        featConfig: { sampleRate: 8000, featureDim: 80 },
        modelConfig: {
          paraformer: {
            model: "/models/paraformer/model.int8.onnx",
          },
          tokens: "/models/paraformer/tokens.txt",
          numThreads: 1,
          provider: "cpu",
          debug: 1,
        },
        decodingMethod: "greedy_search",
        maxActivePaths: 4,
      },
    ]);
  });
});
