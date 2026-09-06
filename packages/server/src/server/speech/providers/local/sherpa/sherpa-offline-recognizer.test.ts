import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import pino from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  offlineRecognizerConfigs: [] as unknown[],
}));

vi.mock("./sherpa-onnx-node-loader.js", () => ({
  loadSherpaOnnxNode: () => ({
    OfflineRecognizer: class {
      public readonly config: unknown;

      constructor(config: unknown) {
        this.config = config;
        mockState.offlineRecognizerConfigs.push(config);
      }

      createStream() {
        return {};
      }

      decode() {}

      getResult() {
        return "";
      }
    },
  }),
}));

function makeTmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), "paseo-sherpa-recognizer-"));
}

function touch(filePath: string): string {
  writeFileSync(filePath, "x");
  return filePath;
}

describe("SherpaOfflineRecognizerEngine", () => {
  beforeEach(() => {
    mockState.offlineRecognizerConfigs.length = 0;
  });

  it("initializes SenseVoice recognizers with sherpa-onnx senseVoice config", async () => {
    const { SherpaOfflineRecognizerEngine } = await import("./sherpa-offline-recognizer.js");
    const dir = makeTmpDir();

    const engine = new SherpaOfflineRecognizerEngine(
      {
        model: {
          kind: "sense_voice",
          model: touch(path.join(dir, "model.int8.onnx")),
          tokens: touch(path.join(dir, "tokens.txt")),
          language: "auto",
          useInverseTextNormalization: true,
        },
        numThreads: 2,
        debug: 0,
      },
      pino({ level: "silent" }),
    );

    expect(engine.sampleRate).toBe(16000);
    expect(mockState.offlineRecognizerConfigs).toEqual([
      {
        featConfig: {
          sampleRate: 16000,
          featureDim: 80,
        },
        modelConfig: {
          senseVoice: {
            model: path.join(dir, "model.int8.onnx"),
            language: "auto",
            useInverseTextNormalization: 1,
          },
          tokens: path.join(dir, "tokens.txt"),
          numThreads: 2,
          provider: "cpu",
          debug: 0,
        },
      },
    ]);
  });
});
