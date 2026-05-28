import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

import { ensureLocalSpeechRuntime } from "./index.js";
import { getLocalSpeechRuntimePackageSpecs } from "./package-specs.js";
import { getLocalSpeechRuntimePackageDir } from "./paths.js";

const logger = pino({ level: "silent" });

function makePaseoHome(): string {
  return mkdtempSync(path.join(tmpdir(), "paseo-speech-runtime-"));
}

function writeRuntimePackageFiles(paseoHome: string): void {
  for (const spec of getLocalSpeechRuntimePackageSpecs()) {
    const packageDir = getLocalSpeechRuntimePackageDir(paseoHome, spec.packageName);
    for (const relPath of spec.requiredFiles) {
      const absPath = path.join(packageDir, relPath);
      mkdirSync(path.dirname(absPath), { recursive: true });
      writeFileSync(absPath, "x");
    }
    if (spec.id === "onnxruntime-node") {
      const bindingPath = path.join(
        packageDir,
        "bin",
        "napi-test",
        process.platform,
        process.arch,
        "onnxruntime_binding.node",
      );
      mkdirSync(path.dirname(bindingPath), { recursive: true });
      writeFileSync(bindingPath, "x");
    }
  }
}

describe("local speech runtime installer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("ensureLocalSpeechRuntime succeeds without downloading when packages are installed", async () => {
    const paseoHome = makePaseoHome();
    writeRuntimePackageFiles(paseoHome);
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const status = await ensureLocalSpeechRuntime({
      paseoHome,
      logger,
    });

    expect(status.missingPackageIds).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
