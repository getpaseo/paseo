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
    expect(getSherpaOnnxModelDir(modelsDir, "qwen3-asr-0.6b-int8-2026-03-25")).toContain(
      "sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25",
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

    const out = await ensureSherpaOnnxModel({
      modelsDir,
      modelId: "kitten-nano-en-v0_1-fp16",
      logger,
    });

    expect(out).toBe(modelDir);
  });

  test("ensureSherpaOnnxModel accepts pre-extracted Qwen3-ASR artifacts", async () => {
    const modelsDir = makeTmpDir();
    const modelDir = getSherpaOnnxModelDir(modelsDir, "qwen3-asr-0.6b-int8-2026-03-25");

    mkdirSync(path.join(modelDir, "tokenizer"), { recursive: true });
    writeFileSync(path.join(modelDir, "conv_frontend.onnx"), "x");
    writeFileSync(path.join(modelDir, "encoder.int8.onnx"), "x");
    writeFileSync(path.join(modelDir, "decoder.int8.onnx"), "x");
    writeFileSync(path.join(modelDir, "tokenizer", "merges.txt"), "x");
    writeFileSync(path.join(modelDir, "tokenizer", "tokenizer_config.json"), "x");
    writeFileSync(path.join(modelDir, "tokenizer", "vocab.json"), "x");

    const out = await ensureSherpaOnnxModel({
      modelsDir,
      modelId: "qwen3-asr-0.6b-int8-2026-03-25",
      logger,
    });

    expect(out).toBe(modelDir);
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
