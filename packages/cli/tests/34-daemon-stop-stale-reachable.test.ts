#!/usr/bin/env npx tsx

/**
 * Regression: `paseo daemon stop` must stop a reachable daemon even when the
 * local pid file points at a dead supervisor owner.
 */

import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "zx";
import { getAvailablePort } from "./helpers/network.ts";

$.verbose = false;

const pollIntervalMs = 100;
const testEnv = {
  PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD: process.env.PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD ?? "0",
  PASEO_DICTATION_ENABLED: process.env.PASEO_DICTATION_ENABLED ?? "0",
  PASEO_VOICE_MODE_ENABLED: process.env.PASEO_VOICE_MODE_ENABLED ?? "0",
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  check: () => Promise<boolean> | boolean,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  async function poll(): Promise<void> {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error(message);
    await sleep(pollIntervalMs);
    return poll();
  }

  return poll();
}

interface DaemonStatus {
  localDaemon: string | null;
  connectedDaemon: string | null;
  pid: number | null;
}

async function readDaemonStatus(paseoHome: string): Promise<DaemonStatus> {
  const result =
    await $`PASEO_HOME=${paseoHome} PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD=${testEnv.PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD} PASEO_DICTATION_ENABLED=${testEnv.PASEO_DICTATION_ENABLED} PASEO_VOICE_MODE_ENABLED=${testEnv.PASEO_VOICE_MODE_ENABLED} npx paseo daemon status --home ${paseoHome} --json`.nothrow();
  if (result.exitCode !== 0) {
    return { localDaemon: null, connectedDaemon: null, pid: null };
  }

  try {
    const parsed = JSON.parse(result.stdout) as {
      localDaemon?: unknown;
      connectedDaemon?: unknown;
      pid?: unknown;
    };
    return {
      localDaemon: typeof parsed.localDaemon === "string" ? parsed.localDaemon : null,
      connectedDaemon: typeof parsed.connectedDaemon === "string" ? parsed.connectedDaemon : null,
      pid:
        typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0
          ? parsed.pid
          : null,
    };
  } catch {
    return { localDaemon: null, connectedDaemon: null, pid: null };
  }
}

function findUnusedPid(): number {
  for (let pid = 999_999; pid > 900_000; pid--) {
    if (!isProcessRunning(pid)) {
      return pid;
    }
  }
  throw new Error("Unable to find unused pid for stale pid fixture");
}

console.log("=== Daemon Stop (stale pid, reachable worker regression) ===\n");

const port = await getAvailablePort();
const paseoHome = await mkdtemp(join(tmpdir(), "paseo-stop-stale-reachable-"));
const cliRoot = join(import.meta.dirname, "..");
const host = `127.0.0.1:${port}`;
const pidPath = join(paseoHome, "paseo.pid");
const stalePid = findUnusedPid();

let workerProcess: ChildProcess | null = null;

try {
  console.log("Test 1: start daemon worker with stale supervisor pid file");

  await writeFile(
    pidPath,
    `${JSON.stringify(
      {
        pid: stalePid,
        startedAt: new Date().toISOString(),
        hostname: "stale-supervisor-fixture.local",
        uid: typeof process.getuid === "function" ? process.getuid() : undefined,
        listen: host,
      },
      null,
      2,
    )}\n`,
  );

  workerProcess = spawn(
    process.execPath,
    ["--import", "tsx", "../server/src/server/daemon-worker.ts"],
    {
      cwd: cliRoot,
      env: {
        ...process.env,
        ...testEnv,
        PASEO_HOME: paseoHome,
        PASEO_LISTEN: host,
        PASEO_RELAY_ENABLED: "false",
        CI: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  await waitFor(
    async () => {
      const status = await readDaemonStatus(paseoHome);
      return status.localDaemon === "stale_pid" && status.connectedDaemon === "reachable";
    },
    120000,
    "daemon did not enter stale_pid + reachable state in time",
  );

  const statusBeforeStop = await readDaemonStatus(paseoHome);
  assert.strictEqual(statusBeforeStop.pid, stalePid, "status should report the stale owner pid");
  assert(workerProcess.pid && isProcessRunning(workerProcess.pid), "worker should be running");
  console.log(`✓ fixture has stale pid ${stalePid} and live worker ${workerProcess.pid}\n`);

  console.log(
    "Test 2: `paseo daemon stop` should stop reachable worker instead of saying not_running",
  );
  const stopResult =
    await $`PASEO_HOME=${paseoHome} PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD=${testEnv.PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD} PASEO_DICTATION_ENABLED=${testEnv.PASEO_DICTATION_ENABLED} PASEO_VOICE_MODE_ENABLED=${testEnv.PASEO_VOICE_MODE_ENABLED} npx paseo daemon stop --home ${paseoHome} --json`.nothrow();
  assert.strictEqual(stopResult.exitCode, 0, `stop should succeed: ${stopResult.stderr}`);
  const stopJson = JSON.parse(stopResult.stdout) as {
    action?: unknown;
    pid?: unknown;
    message?: unknown;
  };
  assert.strictEqual(stopJson.action, "stopped", "stop should report stopped action");
  assert.strictEqual(
    stopJson.pid,
    String(stalePid),
    "stop should report the stale pid it recovered from",
  );
  assert.strictEqual(
    stopJson.message,
    "Daemon stopped gracefully",
    "stop should route through lifecycle shutdown",
  );

  await waitFor(
    () => !isProcessRunning(workerProcess?.pid ?? -1),
    15000,
    "worker remained running after stop",
  );
  assert.strictEqual(existsSync(pidPath), false, "stale pid file should be removed after stop");
  console.log("✓ stop recovered stale supervisor pid state\n");
} finally {
  if (workerProcess?.pid && isProcessRunning(workerProcess.pid)) {
    workerProcess.kill("SIGTERM");
    await waitFor(
      () => !isProcessRunning(workerProcess!.pid ?? -1),
      5000,
      "worker cleanup timed out",
    ).catch(() => {
      workerProcess?.kill("SIGKILL");
    });
  }

  await $`PASEO_HOME=${paseoHome} PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD=${testEnv.PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD} PASEO_DICTATION_ENABLED=${testEnv.PASEO_DICTATION_ENABLED} PASEO_VOICE_MODE_ENABLED=${testEnv.PASEO_VOICE_MODE_ENABLED} npx paseo daemon stop --home ${paseoHome} --force`.nothrow();
  await rm(paseoHome, { recursive: true, force: true });
}

console.log("=== Stale reachable stop regression test passed ===");
