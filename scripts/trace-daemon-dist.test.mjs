import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridgeModule = "packages/server/dist/server/server/agent/providers/opencode/bridge.js";
const claudeDist = "packages/server/dist/server/server/agent/providers/claude";
const workerThreadEntrypoints = [
  "packages/server/dist/server/server/plugins/compiler-worker.js",
  `${claudeDist}/rewind-worker.js`,
  `${claudeDist}/rewind-session-store.js`,
];

// Mirrors nix/package.nix's installPhase: copy every traced path into $out.
async function installTracedDaemon(outRoot) {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [path.join(repoRoot, "scripts/trace-daemon.mjs")],
    { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 },
  );
  const files = stdout.split("\n").filter(Boolean);
  for (const file of files) {
    await cp(path.join(repoRoot, file), path.join(outRoot, file), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }
  return files;
}

test("traced daemon closure ships the OpenCode bridge plugin for every OpenCode version", async () => {
  const outRoot = await mkdtemp(path.join(os.tmpdir(), "trace-daemon-dist-"));
  try {
    await installTracedDaemon(outRoot);
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

test("traced daemon closure ships the worker-thread entrypoints and what they load", async () => {
  const outRoot = await mkdtemp(path.join(os.tmpdir(), "trace-daemon-dist-"));
  try {
    const files = await installTracedDaemon(outRoot);
    for (const file of workerThreadEntrypoints) {
      assert.ok(files.includes(file), `${file} is missing from the traced closure`);
    }

    const { realClaudeRewindSdk } = await import(
      pathToFileURL(path.join(outRoot, claudeDist, "rewind.js")).href
    );
    const sessionId = randomUUID();
    const user = randomUUID();
    const transcriptPath = path.join(outRoot, `${sessionId}.jsonl`);
    await writeFile(
      transcriptPath,
      `${JSON.stringify({ type: "user", uuid: user, parentUuid: null, sessionId, message: { role: "user", content: "first" } })}\n`,
    );
    const fork = await realClaudeRewindSdk.forkSession(sessionId, {
      upToMessageId: user,
      transcriptPath,
    });
    const forked = await readFile(path.join(outRoot, `${fork.sessionId}.jsonl`), "utf8");
    assert.equal(JSON.parse(forked.split("\n")[0]).forkedFrom.messageUuid, user);
  } finally {
    await rm(outRoot, { recursive: true, force: true });
  }
});
