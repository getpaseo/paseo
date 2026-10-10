import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readPluginManifest } from "./manifest.js";

const directories: string[] = [];
const examplesDirectory = fileURLToPath(
  new URL("../../../../../plugin-examples/", import.meta.url),
);
const examples = (await readdir(examplesDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("plugin manifest", () => {
  it.each(examples)("validates the %s example manifest", async (name) => {
    await expect(readPluginManifest(path.join(examplesDirectory, name))).resolves.toMatchObject({
      id: expect.any(String),
    });
  });

  it("reads display metadata and ignores future top-level fields", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-manifest-"));
    directories.push(directory);
    const manifest = {
      id: "review",
      name: "Review tools",
      icon: "assets/icon.png",
      media: ["assets/screenshot.webp", "demo.mp4", "https://example.com/media?id=1"],
    };
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ ...manifest, futureField: { enabled: true } }),
    );
    await expect(readPluginManifest(directory)).resolves.toEqual(manifest);
  });

  it.each([
    { name: "   " },
    { name: 42 },
    { icon: "" },
    { icon: 42 },
    { icon: "icon.svg" },
    { icon: "/icon.png" },
    { icon: "../icon.png" },
    { icon: "assets/../../icon.png" },
    { icon: "https://example.com/icon.png" },
    { icon: "C:/icon.png" },
    { icon: "assets\\icon.png" },
    { icon: "icon.png?query" },
    { media: "screenshot.png" },
    { media: [42] },
    { media: [""] },
    { media: ["../demo.mp4"] },
    { media: ["/demo.mp4"] },
    { media: ["http://example.com/demo.mp4"] },
    { media: ["https://"] },
    { media: ["//example.com/demo.mp4"] },
    { media: ["file:///demo.mp4"] },
    { media: ["data:image/png;base64,abc"] },
    { media: ["."] },
    { media: ["assets/"] },
    { id: "INVALID" },
    { description: 42 },
    { requirements: { paseoo: ">=0.11.0" } },
  ])("rejects invalid known fields: %j", async (fields) => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-manifest-"));
    directories.push(directory);
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: "example", futureField: true, ...fields }),
    );
    await expect(readPluginManifest(directory)).rejects.toThrow();
  });

  it("accepts omitted metadata and empty media", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-manifest-"));
    directories.push(directory);
    for (const manifest of [{ id: "example" }, { id: "example", media: [] }]) {
      await writeFile(path.join(directory, "paseo-plugin.json"), JSON.stringify(manifest));
      await expect(readPluginManifest(directory)).resolves.toEqual(manifest);
    }
  });

  it("reads and validates requirements before any plugin code runs", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-manifest-"));
    directories.push(directory);
    const manifest = path.join(directory, "paseo-plugin.json");
    await writeFile(manifest, JSON.stringify({ id: "example", requirements: { paseo: "^0.8.0" } }));
    await expect(readPluginManifest(directory)).resolves.toEqual({
      id: "example",
      requirements: { paseo: "^0.8.0" },
    });
    for (const requirements of [
      { paseo: "latest" },
      { paseo: "" },
      { paseo: 8 },
      { node: ">=20" },
      "0.8.0",
    ]) {
      await writeFile(manifest, JSON.stringify({ id: "example", requirements }));
      await expect(readPluginManifest(directory)).rejects.toThrow();
    }
  });

  it("reads an optional description", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-manifest-"));
    directories.push(directory);
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: "described", description: "Reviews changes before merge" }),
    );

    await expect(readPluginManifest(directory)).resolves.toEqual({
      id: "described",
      description: "Reviews changes before merge",
    });

    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: "described", description: "   " }),
    );
    await expect(readPluginManifest(directory)).rejects.toThrow();
  });

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
