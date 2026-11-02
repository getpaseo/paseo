import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { writeFileAtomic, writeJsonFileAtomic } from "./atomic-file.js";

let directory: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-atomic-file-"));
});
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

it.each(["EPERM", "EACCES", "EBUSY"])(
  "commits a completed receipt after transient Windows %s replace failures",
  async (code) => {
    const file = path.join(directory, "receipt.json");
    await writeJsonFileAtomic(file, { state: "pending" });
    let failures = 3;
    let elapsed = 0;
    await writeJsonFileAtomic(
      file,
      { state: "completed" },
      {
        platform: "win32",
        now: () => elapsed,
        sleep: async (milliseconds) => {
          elapsed += milliseconds;
        },
        rename: async (source, destination) => {
          if (failures-- > 0) {
            expect(JSON.parse(await fs.readFile(destination, "utf8"))).toEqual({
              state: "pending",
            });
            expect(JSON.parse(await fs.readFile(source, "utf8"))).toEqual({ state: "completed" });
            throw Object.assign(new Error("destination held open"), { code });
          }
          await fs.rename(source, destination);
        },
      },
    );
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ state: "completed" });
    expect(await fs.readdir(directory)).toEqual(["receipt.json"]);
    expect(elapsed).toBeGreaterThan(0);
  },
);

it.each(["EPERM", "EACCES", "EBUSY"])(
  "preserves the previous file and removes the temp file when Windows %s persists",
  async (code) => {
    const file = path.join(directory, "receipt.json");
    await writeJsonFileAtomic(file, { state: "pending" });
    const error = Object.assign(new Error("destination held open"), { code });
    const waits: number[] = [];
    let elapsed = 0;
    const attempts: number[] = [];
    await expect(
      writeJsonFileAtomic(
        file,
        { state: "completed" },
        {
          platform: "win32",
          now: () => elapsed,
          sleep: async (milliseconds) => {
            waits.push(milliseconds);
            elapsed += milliseconds;
          },
          rename: async () => {
            attempts.push(elapsed);
            throw error;
          },
        },
      ),
    ).rejects.toBe(error);
    expect(elapsed).toBe(1000);
    expect(waits.slice(0, 5)).toEqual([10, 20, 40, 80, 100]);
    expect(Math.max(...waits)).toBe(100);
    expect(attempts.every((time) => time < 1000)).toBe(true);
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ state: "pending" });
    expect(await fs.readdir(directory)).toEqual(["receipt.json"]);
  },
);

it.each([
  ["linux", "EPERM"],
  ["darwin", "EACCES"],
  ["linux", "EBUSY"],
  ["win32", "ENOENT"],
  ["win32", "ENOSPC"],
  ["win32", "EXDEV"],
] as const)("does not retry %s %s failures", async (platform, code) => {
  const file = path.join(directory, "receipt.json");
  await writeJsonFileAtomic(file, { state: "pending" });
  const error = Object.assign(new Error("rename failed"), { code });
  let attempts = 0;
  const waits: number[] = [];
  await expect(
    writeFileAtomic(file, "replacement", {
      platform,
      now: () => 0,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
      rename: async () => {
        attempts++;
        throw error;
      },
    }),
  ).rejects.toBe(error);
  expect(attempts).toBe(1);
  expect(waits).toEqual([]);
  expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ state: "pending" });
  expect(await fs.readdir(directory)).toEqual(["receipt.json"]);
});

it("does not retry after a rename consumes the Windows retry budget", async () => {
  const file = path.join(directory, "receipt.json");
  const error = Object.assign(new Error("slow rename failed"), { code: "EPERM" });
  let elapsed = 0;
  const waits: number[] = [];
  await expect(
    writeFileAtomic(file, "replacement", {
      platform: "win32",
      now: () => elapsed,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
      rename: async () => {
        elapsed += 1000;
        throw error;
      },
    }),
  ).rejects.toBe(error);
  expect(waits).toEqual([]);
  expect(await fs.readdir(directory)).toEqual([]);
});

it("creates parent directories and replaces binary and JSON files through the default runtime", async () => {
  const file = path.join(directory, "nested", "file");
  const bytes = Buffer.from([0, 255, 128, 1]);
  await writeFileAtomic(file, bytes);
  expect(await fs.readFile(file)).toEqual(bytes);
  await writeJsonFileAtomic(file, { state: "completed" });
  expect(await fs.readFile(file, "utf8")).toBe('{\n  "state": "completed"\n}');
  expect(await fs.readdir(path.dirname(file))).toEqual(["file"]);
});
