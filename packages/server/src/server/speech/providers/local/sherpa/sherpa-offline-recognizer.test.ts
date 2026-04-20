import { beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";

const offlineRecognizerCtor = vi.fn();

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true),
}));

vi.mock("./sherpa-onnx-node-loader.js", () => ({
  loadSherpaOnnxNode: () => ({
    OfflineRecognizer: class {
      public readonly config: unknown;

      constructor(config: unknown) {
        this.config = config;
        offlineRecognizerCtor(config);
      }

      createStream() {
        return {
          acceptWaveform: () => undefined,
          free: () => undefined,
        };
      }

      decode() {
        return undefined;
      }

      getResult() {
        return { text: "" };
      }

      free() {
        return undefined;
      }
    },
  }),
}));

describe("SherpaOfflineRecognizerEngine", () => {
  beforeEach(() => {
    offlineRecognizerCtor.mockReset();
  });

  it("builds the native Qwen3-ASR config expected by sherpa-onnx-node", async () => {
    const { SherpaOfflineRecognizerEngine } = await import("./sherpa-offline-recognizer.js");

    new SherpaOfflineRecognizerEngine(
      {
        model: {
          kind: "qwen3_asr",
          convFrontend: "/tmp/conv_frontend.onnx",
          encoder: "/tmp/encoder.int8.onnx",
          decoder: "/tmp/decoder.int8.onnx",
          tokenizer: "/tmp/tokenizer",
          maxTotalLen: 512,
          maxNewTokens: 512,
        },
        numThreads: 2,
        debug: 0,
      },
      pino({ level: "silent" }),
    );

    expect(offlineRecognizerCtor).toHaveBeenCalledWith({
      featConfig: {
        sampleRate: 16000,
        featureDim: 80,
      },
      modelConfig: {
        qwen3Asr: {
          convFrontend: "/tmp/conv_frontend.onnx",
          encoder: "/tmp/encoder.int8.onnx",
          decoder: "/tmp/decoder.int8.onnx",
          tokenizer: "/tmp/tokenizer",
          hotwords: "",
          maxTotalLen: 512,
          maxNewTokens: 512,
          temperature: 1e-6,
          topP: 0.8,
          seed: 42,
        },
        tokens: "",
        numThreads: 2,
        provider: "cpu",
        debug: 0,
      },
      decodingMethod: "greedy_search",
      maxActivePaths: 4,
    });
  });
});
