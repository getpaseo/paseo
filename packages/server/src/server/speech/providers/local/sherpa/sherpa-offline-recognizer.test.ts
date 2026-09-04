import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SherpaOnnxNodeModule } from "./sherpa-onnx-node-loader.js";
import { SherpaOfflineRecognizerEngine } from "./sherpa-offline-recognizer.js";

const recognizerConfigs: unknown[] = [];

function fakeLoadSherpaOnnxNode(): SherpaOnnxNodeModule {
  return {
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
  } as unknown as SherpaOnnxNodeModule;
}

describe("SherpaOfflineRecognizerEngine model configuration", () => {
  let modelDir: string;

  beforeEach(() => {
    recognizerConfigs.length = 0;
    modelDir = mkdtempSync(path.join(tmpdir(), "sherpa-offline-recognizer-test-"));
  });

  afterEach(() => {
    rmSync(modelDir, { recursive: true, force: true });
  });

  it("builds the SenseVoice recognizer configuration", () => {
    const modelPath = path.join(modelDir, "model.int8.onnx");
    const tokensPath = path.join(modelDir, "tokens.txt");
    writeFileSync(modelPath, "");
    writeFileSync(tokensPath, "");

    const engine = new SherpaOfflineRecognizerEngine(
      {
        model: {
          kind: "sense_voice",
          model: modelPath,
          tokens: tokensPath,
        },
        numThreads: 2,
        loadSherpaOnnxNode: fakeLoadSherpaOnnxNode,
      },
      pino({ level: "silent" }),
    );

    expect(engine.sampleRate).toBe(16000);
    expect(recognizerConfigs).toEqual([
      {
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          senseVoice: {
            model: modelPath,
            useInverseTextNormalization: 1,
          },
          tokens: tokensPath,
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
    const modelPath = path.join(modelDir, "model.int8.onnx");
    const tokensPath = path.join(modelDir, "tokens.txt");
    writeFileSync(modelPath, "");
    writeFileSync(tokensPath, "");

    const engine = new SherpaOfflineRecognizerEngine(
      {
        model: {
          kind: "paraformer",
          model: modelPath,
          tokens: tokensPath,
        },
        sampleRate: 8000,
        debug: 1,
        loadSherpaOnnxNode: fakeLoadSherpaOnnxNode,
      },
      pino({ level: "silent" }),
    );

    expect(engine.sampleRate).toBe(8000);
    expect(recognizerConfigs).toEqual([
      {
        featConfig: { sampleRate: 8000, featureDim: 80 },
        modelConfig: {
          paraformer: {
            model: modelPath,
          },
          tokens: tokensPath,
          numThreads: 1,
          provider: "cpu",
          debug: 1,
        },
        decodingMethod: "greedy_search",
        maxActivePaths: 4,
      },
    ]);
  });

  it("throws when a required model file is missing", () => {
    const missingModelPath = path.join(modelDir, "does-not-exist.onnx");
    const tokensPath = path.join(modelDir, "tokens.txt");
    writeFileSync(tokensPath, "");

    expect(
      () =>
        new SherpaOfflineRecognizerEngine(
          {
            model: {
              kind: "paraformer",
              model: missingModelPath,
              tokens: tokensPath,
            },
            loadSherpaOnnxNode: fakeLoadSherpaOnnxNode,
          },
          pino({ level: "silent" }),
        ),
    ).toThrow(/Missing paraformer model/);
  });
});
