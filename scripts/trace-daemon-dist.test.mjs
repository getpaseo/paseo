import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridgeModule = "packages/server/dist/server/server/agent/providers/opencode/bridge.js";
const cliEntry = "packages/cli/dist/index.js";
const terminalModule = "packages/server/dist/server/terminal/terminal.js";
const sherpaModule =
  "packages/server/dist/server/server/speech/providers/local/sherpa/sherpa-onnx-node-loader.js";
const sherpaEnvModule =
  "packages/server/dist/server/server/speech/providers/local/sherpa/sherpa-runtime-env.js";

// Mirrors nix/package.nix's installPhase: copy every traced path into $out.
async function installTracedDaemon(outRoot) {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [path.join(repoRoot, "scripts/trace-daemon.mjs")],
    { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 },
  );
  for (const file of stdout.split("\n").filter(Boolean)) {
    await cp(path.join(repoRoot, file), path.join(outRoot, file), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }
}

test("traced daemon closure ships runtime dependencies and OpenCode bridge plugins", async () => {
  const outRoot = await mkdtemp(path.join(os.tmpdir(), "trace-daemon-dist-"));
  try {
    await installTracedDaemon(outRoot);

    const { sherpaPlatformPackageName } = await import(
      pathToFileURL(path.join(outRoot, sherpaEnvModule)).href
    );
    const runtimeEdges = [
      [cliEntry, "@getpaseo/server"],
      [terminalModule, "@getpaseo/cli/bin/paseo"],
      [terminalModule, "node-pty/package.json"],
      [sherpaModule, "sherpa-onnx-node"],
      [sherpaEnvModule, `${sherpaPlatformPackageName()}/package.json`],
    ];
    for (const [importer, specifier] of runtimeEdges) {
      const resolved = createRequire(path.join(outRoot, importer)).resolve(specifier);
      assert.ok(
        resolved.startsWith(outRoot + path.sep),
        `expected ${importer} -> ${specifier} to resolve inside installed closure, got ${resolved}`,
      );
    }

    const installedBridgeUrl = pathToFileURL(path.join(outRoot, bridgeModule)).href;
    const { loadOpenCodeBridgePluginArtifact } = await import(installedBridgeUrl);

    for (const version of [1, 2]) {
      const artifact = await loadOpenCodeBridgePluginArtifact(
        installedBridgeUrl,
        undefined,
        version,
      );
      assert.ok(artifact.byteLength > 0, `OpenCode v${version} bridge plugin is empty`);
    }
  } finally {
    await rm(outRoot, { recursive: true, force: true });
  }
});
