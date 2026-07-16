import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("transcribe-local-wav CLI", () => {
  test("initializes the complete speech provider configuration", () => {
    const modelsDir = mkdtempSync(path.join(tmpdir(), "paseo-transcribe-local-"));
    tempDirs.push(modelsDir);
    const missingWav = path.join(modelsDir, "missing.wav");
    const scriptPath = fileURLToPath(new URL("./transcribe-local-wav.ts", import.meta.url));

    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", scriptPath, missingWav, "--models-dir", modelsDir],
      {
        encoding: "utf8",
        timeout: 15_000,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ENOENT");
    expect(result.stderr).toContain(missingWav);
    expect(result.stderr).not.toContain("Cannot read properties of undefined");
  });
});
