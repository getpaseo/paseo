import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { describe, expect, onTestFinished, test } from "vitest";

import {
  ensureLocalSpeechModels,
  getLocalSpeechModelDir,
  listLocalSpeechModels,
  listMissingLocalSpeechModels,
} from "./models.js";

const logger = pino({ level: "silent" });
const modelId = "parakeet-tdt-0.6b-v2-int8";
const spec = listLocalSpeechModels().find((model) => model.id === modelId)!;

function writeCompleteModel(modelDir: string): void {
  mkdirSync(modelDir, { recursive: true });
  for (const file of spec.requiredFiles) {
    writeFileSync(path.join(modelDir, file), `complete ${file}`.padEnd(64_000, "."));
  }
}

function setupModelsDirWithArchive(): { modelsDir: string; modelDir: string; archive: string } {
  const root = mkdtempSync(path.join(tmpdir(), "paseo-local-models-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  writeCompleteModel(path.join(sourceRoot, spec.extractedDir));
  const modelsDir = path.join(root, "models");
  const archive = path.join(
    modelsDir,
    ".downloads",
    path.basename(new URL(spec.archiveUrl).pathname),
  );
  mkdirSync(path.dirname(archive), { recursive: true });
  execFileSync("tar", ["cf", archive, "-C", sourceRoot, spec.extractedDir]);
  return { modelsDir, modelDir: getLocalSpeechModelDir(modelsDir, modelId), archive };
}

describe("local speech models", () => {
  test("reinstalls a model whose extraction was interrupted", async () => {
    // An interrupted extraction leaves the archive in .downloads and a truncated file in place.
    const { modelsDir, modelDir, archive } = setupModelsDirWithArchive();
    writeCompleteModel(modelDir);
    const encoder = path.join(modelDir, spec.requiredFiles[0]);
    truncateSync(encoder, 1_000);

    expect(await listMissingLocalSpeechModels({ modelsDir, modelIds: [modelId] })).toEqual([
      modelId,
    ]);

    await ensureLocalSpeechModels({ modelsDir, modelIds: [modelId], logger });

    expect(readFileSync(encoder, "utf8")).toBe(
      `complete ${spec.requiredFiles[0]}`.padEnd(64_000, "."),
    );
    expect(existsSync(archive)).toBe(false);
    expect(await listMissingLocalSpeechModels({ modelsDir, modelIds: [modelId] })).toEqual([]);
  });
});
