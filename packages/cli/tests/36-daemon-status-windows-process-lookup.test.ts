#!/usr/bin/env npx tsx

import assert from "node:assert";
import { runLocalPaseo } from "./helpers/local-cli.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAvailablePort } from "./helpers/network.ts";

if (process.platform !== "win32") {
  console.log("Skipping Windows daemon status process lookup regression on non-Windows.");
  process.exit(0);
}

console.log("=== Windows Daemon Status Process Lookup ===\n");

const paseoHome = await mkdtemp(join(tmpdir(), "paseo-windows-status-home-"));
const port = await getAvailablePort();
const env = {
  PASEO_HOME: paseoHome,
  PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD: "0",
  PASEO_DICTATION_ENABLED: "0",
  PASEO_VOICE_MODE_ENABLED: "0",
};

try {
  for (const [field, value] of [
    ["daemon.listen", `127.0.0.1:${port}`],
    ["daemon.relay.enabled", "false"],
    ["features.dictation.enabled", "false"],
    ["features.voiceMode.enabled", "false"],
  ]) {
    const saved = await runLocalPaseo(["daemon", "config", "set", field!, value!], env);
    assert.equal(saved.exitCode, 0, saved.stderr);
  }
  const start = await runLocalPaseo(["daemon", "start"], env);
  assert.strictEqual(
    start.exitCode,
    0,
    `daemon restart should succeed:\nstdout:\n${start.stdout}\nstderr:\n${start.stderr}`,
  );

  const statusResult = await runLocalPaseo(
    ["daemon", "status", "--home", paseoHome, "--json"],
    env,
  );
  assert.strictEqual(
    statusResult.exitCode,
    0,
    `daemon status should succeed:\nstdout:\n${statusResult.stdout}\nstderr:\n${statusResult.stderr}`,
  );

  const status = JSON.parse(statusResult.stdout) as {
    localDaemon?: string;
    daemonNode?: string;
  };
  assert.strictEqual(status.localDaemon, "running", "daemon should be running");
  assert(status.daemonNode, "daemon status should include daemonNode");
  assert(
    !status.daemonNode.startsWith("unknown ("),
    `daemonNode should resolve cleanly, got: ${status.daemonNode}`,
  );
  assert(
    !status.daemonNode.includes("Get-Process") &&
      !status.daemonNode.includes("Get-CimInstance") &&
      !status.daemonNode.includes("wmic failed"),
    `daemonNode should not contain process probe failures, got: ${status.daemonNode}`,
  );
  console.log("✓ daemon status resolves daemonNode on Windows\n");
} finally {
  await runLocalPaseo(["daemon", "stop", "--home", paseoHome, "--force"], env);
  await rm(paseoHome, { recursive: true, force: true });
}

console.log("=== Windows daemon status process lookup passed ===");
