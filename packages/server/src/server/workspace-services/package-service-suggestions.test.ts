import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { listPackageServiceSuggestions } from "./package-service-suggestions.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

test("offers conventional scripts with the detected package manager", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-services-"));
  directories.push(directory);
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ scripts: { dev: "vite", preview: "vite preview", test: "vitest" } }),
  );
  await writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

  await expect(listPackageServiceSuggestions(directory)).resolves.toEqual([
    { scriptName: "dev", command: "pnpm run dev" },
    { scriptName: "preview", command: "pnpm run preview" },
  ]);
});

test("returns no suggestions for missing or malformed manifests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-services-"));
  directories.push(directory);
  await writeFile(join(directory, "package.json"), "not json");
  await expect(listPackageServiceSuggestions(directory)).resolves.toEqual([]);
});
