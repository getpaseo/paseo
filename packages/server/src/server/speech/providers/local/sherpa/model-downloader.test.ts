import { describe, expect, test } from "vitest";
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
    expect(getSherpaOnnxModelDir(modelsDir, "kokoro-multi-v1_0")).toContain(
      "kokoro-multi-lang-v1_0",
    );
  });

  test("ensureSherpaOnnxModel succeeds without downloading when files exist", async () => {
    const modelsDir = makeTmpDir();
    const modelDir = getSherpaOnnxModelDir(modelsDir, "kokoro-multi-v1_0");

    mkdirSync(path.join(modelDir, "espeak-ng-data"), { recursive: true });
    writeFileSync(path.join(modelDir, "model.onnx"), "x");
    writeFileSync(path.join(modelDir, "voices.bin"), "x");
    writeFileSync(path.join(modelDir, "tokens.txt"), "x");

    const out = await ensureSherpaOnnxModel({
      modelsDir,
      modelId: "kokoro-multi-v1_0",
      logger,
    });

    expect(out).toBe(modelDir);
  });
});
