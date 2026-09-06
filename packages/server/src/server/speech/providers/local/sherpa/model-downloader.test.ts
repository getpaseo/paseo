import { afterEach, describe, expect, test, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import { ensureSherpaOnnxModel, getSherpaOnnxModelDir } from "./model-downloader.js";

const SENSE_VOICE_MODEL = "sense-voice-zh-en-ja-ko-yue-int8-2025-09-09";

function makeTmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), "paseo-speech-models-"));
}

const logger = pino({ level: "silent" });

describe("sherpa model downloader", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("getSherpaOnnxModelDir maps modelId to extractedDir", () => {
    const modelsDir = "/tmp/models";
    expect(getSherpaOnnxModelDir(modelsDir, "parakeet-tdt-0.6b-v2-int8")).toContain(
      "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
    );
    expect(getSherpaOnnxModelDir(modelsDir, "kokoro-en-v0_19")).toContain("kokoro-en-v0_19");
    expect(getSherpaOnnxModelDir(modelsDir, SENSE_VOICE_MODEL)).toContain(
      "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09",
    );
  });

  test("ensureSherpaOnnxModel succeeds without downloading when files exist", async () => {
    const modelsDir = makeTmpDir();
    const modelDir = getSherpaOnnxModelDir(modelsDir, "kokoro-en-v0_19");

    mkdirSync(path.join(modelDir, "espeak-ng-data"), { recursive: true });
    writeFileSync(path.join(modelDir, "model.onnx"), "x");
    writeFileSync(path.join(modelDir, "voices.bin"), "x");
    writeFileSync(path.join(modelDir, "tokens.txt"), "x");

    const out = await ensureSherpaOnnxModel({
      modelsDir,
      modelId: "kokoro-en-v0_19",
      logger,
    });

    expect(out).toBe(modelDir);
  });

  test("ensureSherpaOnnxModel accepts existing SenseVoice files without downloading", async () => {
    const modelsDir = makeTmpDir();
    const modelDir = getSherpaOnnxModelDir(modelsDir, SENSE_VOICE_MODEL);

    mkdirSync(modelDir, { recursive: true });
    writeFileSync(path.join(modelDir, "model.int8.onnx"), "x");
    writeFileSync(path.join(modelDir, "tokens.txt"), "x");

    const out = await ensureSherpaOnnxModel({
      modelsDir,
      modelId: SENSE_VOICE_MODEL,
      logger,
    });

    expect(out).toBe(modelDir);
  });

  test("ensureSherpaOnnxModel downloads SenseVoice direct files before archive fallback", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("model-bytes"))
      .mockResolvedValueOnce(new Response("tokens-bytes"));
    vi.stubGlobal("fetch", fetch);

    const modelsDir = makeTmpDir();
    const modelDir = getSherpaOnnxModelDir(modelsDir, SENSE_VOICE_MODEL);

    const out = await ensureSherpaOnnxModel({
      modelsDir,
      modelId: SENSE_VOICE_MODEL,
      logger,
    });

    expect(out).toBe(modelDir);
    expect(existsSync(path.join(modelsDir, ".downloads"))).toBe(false);
    expect(readFileSync(path.join(modelDir, "model.int8.onnx"), "utf8")).toBe("model-bytes");
    expect(readFileSync(path.join(modelDir, "tokens.txt"), "utf8")).toBe("tokens-bytes");
    expect(fetch).toHaveBeenCalledWith(
      "https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09/resolve/main/model.int8.onnx?download=true",
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09/resolve/main/tokens.txt?download=true",
    );
  });
});
