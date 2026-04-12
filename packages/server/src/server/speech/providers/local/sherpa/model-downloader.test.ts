import { describe, expect, test, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import { ensureSherpaOnnxModel, getSherpaOnnxModelDir } from "./model-downloader.js";

function makeTmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), "paseo-speech-models-"));
}

const logger = pino({ level: "silent" });

describe("sherpa model downloader", () => {
  test("getSherpaOnnxModelDir maps modelId to extractedDir", () => {
    const modelsDir = "/tmp/models";
    expect(getSherpaOnnxModelDir(modelsDir, "parakeet-tdt-0.6b-v3-int8")).toContain(
      "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
    );
    expect(getSherpaOnnxModelDir(modelsDir, "pocket-tts-onnx-int8")).toContain(
      "pocket-tts-onnx-int8",
    );
  });

  test("ensureSherpaOnnxModel succeeds without downloading when files exist", async () => {
    const modelsDir = makeTmpDir();
    const modelDir = getSherpaOnnxModelDir(modelsDir, "kitten-nano-en-v0_1-fp16");

    mkdirSync(path.join(modelDir, "espeak-ng-data"), { recursive: true });
    writeFileSync(path.join(modelDir, "model.fp16.onnx"), "x");
    writeFileSync(path.join(modelDir, "voices.bin"), "x");
    writeFileSync(path.join(modelDir, "tokens.txt"), "x");
    writeFileSync(path.join(modelDir, ".paseo-model-ready"), "ready\n");

    const out = await ensureSherpaOnnxModel({
      modelsDir,
      modelId: "kitten-nano-en-v0_1-fp16",
      logger,
    });

    expect(out).toBe(modelDir);
  });

  test("ensureSherpaOnnxModel re-downloads when files exist without a ready marker", async () => {
    const modelsDir = makeTmpDir();
    const modelDir = getSherpaOnnxModelDir(modelsDir, "pocket-tts-onnx-int8");

    mkdirSync(path.join(modelDir, "onnx"), { recursive: true });
    writeFileSync(path.join(modelDir, "onnx/mimi_encoder.onnx"), "stale");
    writeFileSync(path.join(modelDir, "onnx/text_conditioner.onnx"), "stale");
    writeFileSync(path.join(modelDir, "onnx/flow_lm_main_int8.onnx"), "stale");
    writeFileSync(path.join(modelDir, "onnx/flow_lm_flow_int8.onnx"), "stale");
    writeFileSync(path.join(modelDir, "onnx/mimi_decoder_int8.onnx"), "stale");
    writeFileSync(path.join(modelDir, "tokenizer.model"), "stale");
    writeFileSync(path.join(modelDir, "reference_sample.wav"), "stale");

    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (_url: string | URL | Request) => {
      return new Response(Buffer.from("fresh"), { status: 200 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      const out = await ensureSherpaOnnxModel({
        modelsDir,
        modelId: "pocket-tts-onnx-int8",
        logger,
      });

      expect(out).toBe(modelDir);
      expect(fetchMock).toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("ensureSherpaOnnxModel logs lifecycle events without progress spam", async () => {
    const modelsDir = makeTmpDir();
    const infoMessages: string[] = [];

    const loggerWithSpy = {
      child: () => loggerWithSpy,
      info: (_obj?: unknown, msg?: string) => {
        if (typeof msg === "string") {
          infoMessages.push(msg);
        }
      },
      error: () => undefined,
    } as unknown as pino.Logger;

    const originalFetch = globalThis.fetch;
    const payload = Buffer.alloc(128 * 1024, 7);
    const fetchMock = vi.fn(async () => {
      return new Response(payload, {
        status: 200,
        headers: { "content-length": String(payload.length) },
      });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      await ensureSherpaOnnxModel({
        modelsDir,
        modelId: "pocket-tts-onnx-int8",
        logger: loggerWithSpy,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchMock).toHaveBeenCalled();
    expect(infoMessages).toContain("Starting model download");
    expect(infoMessages).toContain("Model download completed");
    expect(infoMessages).not.toContain("Downloading model artifact");
  });
});
