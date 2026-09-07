import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readPluginManifest } from "./manifest.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("plugin manifest", () => {
  it("accepts only non-empty argv arrays for build commands", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-manifest-"));
    directories.push(directory);
    const manifest = path.join(directory, "paseo-plugin.json");

    await writeFile(
      manifest,
      JSON.stringify({ id: "prepared", build: [["pnpm", "install", "--frozen-lockfile"]] }),
    );
    await expect(readPluginManifest(directory)).resolves.toMatchObject({
      build: [["pnpm", "install", "--frozen-lockfile"]],
    });

    for (const build of [[], [[]], [["pnpm", ""]], [["pnpm", 1]], "pnpm install"]) {
      await writeFile(manifest, JSON.stringify({ id: "prepared", build }));
      await expect(readPluginManifest(directory)).rejects.toThrow();
    }
  });
});
