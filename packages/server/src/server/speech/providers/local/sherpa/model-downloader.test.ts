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
      "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8"
    );
    expect(getSherpaOnnxModelDir(modelsDir, "pocket-tts-onnx-int8")).toContain(
      "pocket-tts-onnx-int8"
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
      autoDownload: false,
      logger,
    });

    expect(out).toBe(modelDir);
  });

  test("ensureSherpaOnnxModel throws when missing and autoDownload is false", async () => {
    const modelsDir = makeTmpDir();
    await expect(
      ensureSherpaOnnxModel({
        modelsDir,
        modelId: "zipformer-bilingual-zh-en-2023-02-20",
        autoDownload: false,
        logger,
      })
    ).rejects.toThrow(/auto-download/i);
  });

  test("ensureSherpaOnnxModel logs artifact download progress", async () => {
    const modelsDir = makeTmpDir();
    const progressLogs: Array<Record<string, unknown>> = [];

    const loggerWithSpy = {
      child: () => loggerWithSpy,
      info: (obj?: unknown, msg?: string) => {
        if (msg === "Downloading model artifact" && obj && typeof obj === "object") {
          progressLogs.push(obj as Record<string, unknown>);
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
        autoDownload: true,
        logger: loggerWithSpy,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchMock).toHaveBeenCalled();
    expect(progressLogs.length).toBeGreaterThan(0);
    const final = progressLogs.at(-1);
    expect(final?.modelId).toBe("pocket-tts-onnx-int8");
    expect(final?.pct).toBe(100);
  });
});
