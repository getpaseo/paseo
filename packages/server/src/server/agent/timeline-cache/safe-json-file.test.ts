import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readJsonFileCapped } from "./safe-json-file.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("readJsonFileCapped", () => {
  it("parses a bounded file and rejects an oversized file before reading its contents", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-safe-json-"));
    directories.push(directory);
    const bounded = path.join(directory, "bounded.json");
    const oversized = path.join(directory, "oversized.json");
    await writeFile(bounded, JSON.stringify({ version: 1, value: "ok" }));
    await writeFile(oversized, JSON.stringify({ value: "x".repeat(256) }));

    await expect(readJsonFileCapped(bounded, 128)).resolves.toEqual({ version: 1, value: "ok" });
    await expect(readJsonFileCapped(oversized, 64)).rejects.toThrow(
      "JSON file exceeds the 64-byte limit",
    );
  });
});
