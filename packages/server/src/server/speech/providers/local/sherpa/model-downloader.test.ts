import { describe, expect, test } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  truncateSync,
  readdirSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import { ensureSherpaOnnxModel, getSherpaOnnxModelDir } from "./model-downloader.js";
import { getSherpaOnnxModelSpec } from "./model-catalog.js";

function makeTmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), "paseo-speech-models-"));
}

const logger = pino({ level: "silent" });

describe("sherpa model downloader", () => {
  test("does not expose a partial model when tar extraction fails", async () => {
    const root = makeTmpDir();
    const modelsDir = path.join(root, "models");
    const spec = getSherpaOnnxModelSpec("kokoro-en-v0_19");
    const sourceDir = path.join(root, "source", spec.extractedDir);
    const archive = path.join(
      modelsDir,
      ".downloads",
      path.basename(new URL(spec.archiveUrl).pathname),
    );
    try {
      mkdirSync(sourceDir, { recursive: true });
      mkdirSync(path.dirname(archive), { recursive: true });
      writeFileSync(path.join(sourceDir, "model.onnx"), Buffer.alloc(32_768, 1));
      execFileSync("tar", [
        "cf",
        archive,
        "-C",
        path.dirname(sourceDir),
        `${spec.extractedDir}/model.onnx`,
      ]);
      truncateSync(archive, 1_024);
      await expect(ensureSherpaOnnxModel({ modelsDir, modelId: spec.id, logger })).rejects.toThrow(
        "tar exited",
      );
      expect(existsSync(getSherpaOnnxModelDir(modelsDir, spec.id))).toBe(false);
      expect(existsSync(archive)).toBe(true);
      expect(readdirSync(modelsDir)).toEqual([".downloads"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("repairs a partial legacy extraction when its cached archive remains", async () => {
    const root = makeTmpDir();
    const modelsDir = path.join(root, "models");
    const spec = getSherpaOnnxModelSpec("kokoro-en-v0_19");
    const sourceDir = path.join(root, "source", spec.extractedDir);
    const modelDir = getSherpaOnnxModelDir(modelsDir, spec.id);
    const archive = path.join(
      modelsDir,
      ".downloads",
      path.basename(new URL(spec.archiveUrl).pathname),
    );
    try {
      for (const dir of [sourceDir, modelDir]) {
        mkdirSync(path.join(dir, "espeak-ng-data"), { recursive: true });
        for (const filename of ["model.onnx", "voices.bin", "tokens.txt"]) {
          writeFileSync(path.join(dir, filename), "complete model data");
        }
      }
      mkdirSync(path.dirname(archive), { recursive: true });
      execFileSync("tar", ["cf", archive, "-C", path.dirname(sourceDir), spec.extractedDir]);
      writeFileSync(path.join(modelDir, "model.onnx"), "truncated");
      await ensureSherpaOnnxModel({ modelsDir, modelId: spec.id, logger });
      expect(readFileSync(path.join(modelDir, "model.onnx"), "utf8")).toBe("complete model data");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("getSherpaOnnxModelDir maps modelId to extractedDir", () => {
    const modelsDir = "/tmp/models";
    expect(getSherpaOnnxModelDir(modelsDir, "parakeet-tdt-0.6b-v2-int8")).toContain(
      "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
    );
    expect(getSherpaOnnxModelDir(modelsDir, "kokoro-en-v0_19")).toContain("kokoro-en-v0_19");
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
});
