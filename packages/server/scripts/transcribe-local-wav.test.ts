import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

const tempDirs: string[] = [];

function createPcm16MonoWav(sampleCount: number): Buffer {
  const dataLength = sampleCount * 2;
  const wav = Buffer.alloc(44 + dataLength);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataLength, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24);
  wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataLength, 40);
  for (let i = 0; i < sampleCount; i += 1) {
    wav.writeInt16LE(i % 2 === 0 ? 1_000 : -1_000, 44 + i * 2);
  }
  return wav;
}

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
    // The worker client is lazy, so reaching the missing WAV proves provider initialization completed first.
    expect(result.stderr).toContain("ENOENT");
    expect(result.stderr).toContain(missingWav);
    expect(result.stderr).not.toContain("Cannot read properties of undefined");
  });

  test("shows the model download hint when the local STT model is missing", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "paseo-transcribe-local-"));
    tempDirs.push(tempDir);
    const modelsDir = path.join(tempDir, "empty-models");
    const wavPath = path.join(tempDir, "input.wav");
    writeFileSync(wavPath, createPcm16MonoWav(16_000));
    const scriptPath = fileURLToPath(new URL("./transcribe-local-wav.ts", import.meta.url));

    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        scriptPath,
        wavPath,
        "--model",
        "parakeet-tdt-0.6b-v3-int8",
        "--models-dir",
        modelsDir,
      ],
      {
        encoding: "utf8",
        timeout: 15_000,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Local STT service is unavailable. Check model files or run `npm run speech:download -- --model parakeet-tdt-0.6b-v3-int8`.",
    );
    expect(result.stderr).not.toContain("Error: Missing offline encoder:");
    expect(result.stderr).not.toContain("at LocalSpeechWorkerClient.handleWorkerMessage");
  });
});
