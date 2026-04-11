#!/usr/bin/env npx tsx

/**
 * Regression: unsupervised restart request should gracefully stop and exit 0,
 * so an external owner can decide whether to respawn.
 */

import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryConnectToDaemon } from "../src/utils/client.ts";
import { getAvailablePort } from "./helpers/network.ts";

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

  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await sleep(pollIntervalMs);
  }

  throw new Error(message);
}

type ExitResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

function waitForProcessExit(processRef: ChildProcess, timeoutMs: number): Promise<ExitResult> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("timed out waiting for process exit"));
    }, timeoutMs);

    processRef.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

async function canConnectToDaemon(host: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const client = await tryConnectToDaemon({ host, timeout: 500 }).catch(() => null);
    if (client) {
      await client.close().catch(() => undefined);
      return true;
    }
    await sleep(pollIntervalMs);
  }

  return false;
}

async function readPidLockPid(paseoHome: string): Promise<number | null> {
  const pidPath = join(paseoHome, "paseo.pid");
  try {
    const content = await readFile(pidPath, "utf-8");
    const parsed = JSON.parse(content) as { pid?: unknown };
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
      return null;
    }
    return parsed.pid;
  } catch {
    return null;
  }
}

console.log("=== Daemon Restart (unsupervised regression) ===\n");

const port = await getAvailablePort();
const paseoHome = await mkdtemp(join(tmpdir(), "paseo-restart-unsupervised-"));
const cliRoot = join(import.meta.dirname, "..");
const host = `127.0.0.1:${port}`;

let daemonProcess: ChildProcess | null = null;
let recentDaemonLogs = "";

try {
  console.log("Test 1: start unsupervised daemon worker directly");

  daemonProcess = spawn(process.execPath, ["--import", "tsx", "../server/src/server/index.ts"], {
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
  });

  daemonProcess.stdout?.on("data", (chunk) => {
    recentDaemonLogs = (recentDaemonLogs + chunk.toString()).slice(-8000);
  });
  daemonProcess.stderr?.on("data", (chunk) => {
    recentDaemonLogs = (recentDaemonLogs + chunk.toString()).slice(-8000);
  });

  await waitFor(
    async () =>
      Boolean(daemonProcess?.pid && isProcessRunning(daemonProcess.pid)) &&
      (await canConnectToDaemon(host, 1000)),
    120000,
    "daemon did not become running in time",
  );

  assert(daemonProcess.pid, "unsupervised daemon process pid should exist");
  const lockPid = await readPidLockPid(paseoHome);
  assert.strictEqual(lockPid, daemonProcess.pid, "unsupervised worker should own pid lock");
  console.log(`✓ unsupervised daemon started with pid ${daemonProcess.pid}\n`);

  console.log("Test 2: restart request should gracefully stop and exit code 0");
  const client = await tryConnectToDaemon({ host, timeout: 5000 });
  assert(client, "daemon client should connect");

  const exitPromise = waitForProcessExit(daemonProcess, 30000);
  try {
    const restartAck = await client.restartServer("settings_update");
    assert.strictEqual(
      restartAck.status,
      "restart_requested",
      "restart request should be acknowledged",
    );
  } finally {
    await client?.close().catch(() => undefined);
  }

  const exit = await exitPromise;
  assert.strictEqual(exit.signal, null, `daemon should exit cleanly, got signal=${exit.signal}`);
  assert.strictEqual(
    exit.code,
    0,
    `daemon should exit with status 0, got code=${exit.code}\nRecent daemon logs:\n${recentDaemonLogs}`,
  );

  await waitFor(
    async () => (await readPidLockPid(paseoHome)) === null,
    15000,
    "pid lock was not released after unsupervised restart request",
  );

  console.log("✓ unsupervised restart exited cleanly with code 0\n");
} finally {
  if (daemonProcess?.pid && isProcessRunning(daemonProcess.pid)) {
    daemonProcess.kill("SIGTERM");
    await waitFor(
      () => !isProcessRunning(daemonProcess!.pid ?? -1),
      5000,
      "daemon cleanup timed out",
    ).catch(() => {
      daemonProcess?.kill("SIGKILL");
    });
  }

  await rm(paseoHome, { recursive: true, force: true });
}

console.log("=== Unsupervised restart regression test passed ===");
