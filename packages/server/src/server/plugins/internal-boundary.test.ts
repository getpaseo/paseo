import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { assertPluginCompatibility } from "@getpaseo/protocol/plugin-requirements";
import { INTERNAL_PLUGINS } from "../../plugins/index.js";
import { resolveDaemonVersion } from "../daemon-version.js";
import { createPluginImportReader } from "./compiler-imports.js";
import { compilePlugin, SERVER_HOST_MODULES } from "./compiler.js";
import { readPluginManifest } from "./manifest.js";

const root = fileURLToPath(new URL("../../plugins/", import.meta.url));
const fixture = fileURLToPath(new URL("./test-fixtures/internal-seam/", import.meta.url));
const hostModules: ReadonlySet<string> = new Set(SERVER_HOST_MODULES);

async function checkInternalPluginBoundary(directory: string): Promise<void> {
  const server = path.join(directory, "index.server.ts");
  const reader = createPluginImportReader(directory);
  const pending = [server];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    for (const dependency of reader.read(file)) {
      const specifier = dependency.specifier;
      if (hostModules.has(specifier) || isBuiltin(specifier)) continue;
      const resolved = reader.resolve(specifier, file, dependency.kind);
      const relative = resolved && path.relative(directory, resolved);
      const owned = relative && /^(server|shared)[\\/]/.test(relative);
      if (!specifier.startsWith(".") || !owned) {
        throw new Error(`Internal plugin import boundary: ${file} imports ${specifier}`);
      }
      pending.push(resolved);
    }
  }
  await compilePlugin({ server, client: null });
}

test("internal plugin fixture and production directories respect the compiler host-module boundary", async () => {
  await checkInternalPluginBoundary(fixture);
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) await checkInternalPluginBoundary(path.join(root, entry.name));
  }
});

test("internal plugin boundary rejects daemon imports with the file and specifier", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-internal-boundary-"));
  const server = path.join(directory, "index.server.ts");
  const daemonFile = fileURLToPath(new URL("../bootstrap.ts", import.meta.url));
  const specifier = path.relative(directory, daemonFile);
  try {
    await writeFile(
      server,
      `import ${JSON.stringify(specifier)};\nexport default () => () => {};\n`,
    );
    await expect(checkInternalPluginBoundary(directory)).rejects.toThrow(
      `Internal plugin import boundary: ${server} imports ${specifier}`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("every internal plugin manifest is compatible with the daemon that ships it", async () => {
  const version = resolveDaemonVersion(import.meta.url);
  for (const plugin of INTERNAL_PLUGINS) {
    const manifest = await readPluginManifest(plugin.directory);
    expect(() =>
      assertPluginCompatibility({ ...manifest, version, runtime: "daemon" }),
    ).not.toThrow();
  }
});
