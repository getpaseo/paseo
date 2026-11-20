#!/usr/bin/env npx tsx

/**
 * Regression: a reboot reassigns the supervisor's PID to an unrelated process. The lock
 * left behind must not make the daemon look like it is running, and must never be treated
 * as a handle on whatever now holds that PID.
 */

import assert from "node:assert";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, uptime } from "node:os";
import { join } from "node:path";
import { runLocalPaseo } from "./helpers/local-cli.ts";

console.log("=== Daemon lock left behind by a reboot ===\n");

const paseoHome = await mkdtemp(join(tmpdir(), "paseo-stale-boot-lock-"));
const env = {
  PASEO_HOME: paseoHome,
  PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD: "0",
  PASEO_DICTATION_ENABLED: "0",
  PASEO_VOICE_MODE_ENABLED: "0",
};

// Stands in for the process that inherits the supervisor's PID after a reboot. It records a
// signal rather than dying of it, so a late delivery cannot slip past the assertion.
const signalMarker = join(paseoHome, "bystander-signalled");
const bystander = spawn(
  process.execPath,
  [
    "-e",
    `process.on("SIGTERM", () => require("node:fs").writeFileSync(${JSON.stringify(signalMarker)}, "SIGTERM"));` +
      `setTimeout(() => {}, 120_000);`,
  ],
  { stdio: "ignore" },
);
let bystanderExited = false;
bystander.once("exit", () => {
  bystanderExited = true;
});
assert(bystander.pid, "bystander process should have a pid");

try {
  const beforeThisBoot = new Date(Date.now() - uptime() * 1000 - 60 * 60_000);
  await writeFile(
    join(paseoHome, "paseo.pid"),
    JSON.stringify({
      pid: bystander.pid,
      startedAt: beforeThisBoot.toISOString(),
      hostname: "before-reboot",
      uid: process.getuid?.() ?? 0,
      listen: "127.0.0.1:6767",
      desktopManaged: true,
      heartbeat: true,
    }),
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
  const status = JSON.parse(statusResult.stdout) as { localDaemon?: string; pid?: number | null };
  assert.strictEqual(
    status.localDaemon,
    "stopped",
    `daemon left behind by a reboot should read as stopped, got: ${statusResult.stdout}`,
  );
  assert.strictEqual(status.pid, null, "status should not report the reused pid as the daemon");
  console.log("✓ daemon status reports stopped\n");

  const stopResult = await runLocalPaseo(["daemon", "stop", "--home", paseoHome], env);
  assert.strictEqual(
    stopResult.exitCode,
    0,
    `daemon stop should succeed:\nstdout:\n${stopResult.stdout}\nstderr:\n${stopResult.stderr}`,
  );
  assert.strictEqual(
    existsSync(signalMarker),
    false,
    "daemon stop must not signal the process that inherited the pid",
  );
  assert.strictEqual(bystanderExited, false, "the process that inherited the pid should survive");
  console.log("✓ daemon stop leaves the process holding that pid alone\n");
} finally {
  bystander.kill("SIGKILL");
  await rm(paseoHome, { recursive: true, force: true });
}

console.log("=== Daemon lock left behind by a reboot passed ===");
