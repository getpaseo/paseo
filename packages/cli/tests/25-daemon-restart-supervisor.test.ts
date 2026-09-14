#!/usr/bin/env npx tsx

/**
 * Regression: app-style restart requests must trigger supervised worker restart
 * (worker PID changes) while keeping the daemon healthy.
 */

import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import {
  DaemonClient,
  DaemonConnectionError,
  type WebSocketLike,
} from "@getpaseo/client/internal/daemon-client";
import { readDaemonInstance, isSameDaemonInstance } from "@getpaseo/server";
import { runLocalPaseo } from "./helpers/local-cli.ts";
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

async function readCapturedSupervisorLogs(paseoHome: string, recentLogs: string): Promise<string> {
  const durableLogs = await readFile(join(paseoHome, "daemon.log"), "utf8").catch(() => "");
  return `${recentLogs}\n${durableLogs}`;
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

console.log("=== Daemon Restart (supervisor regression) ===\n");

const port = await getAvailablePort();
const paseoHome = await mkdtemp(join(tmpdir(), "paseo-restart-supervisor-"));
const cliRoot = join(import.meta.dirname, "..");
const host = `127.0.0.1:${port}`;

let supervisorProcess: ChildProcess | null = null;
let recentSupervisorLogs = "";
let client: DaemonClient | undefined;
const availabilityLog = join(paseoHome, "availability.log");

try {
  if (process.platform !== "win32") {
    const provider = join(paseoHome, "slow-provider");
    await writeFile(
      provider,
      `#!${process.execPath}
import('node:fs').then(({appendFileSync}) => {
  appendFileSync(${JSON.stringify(availabilityLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");
  setTimeout(() => console.log('provider 1.0.0'), 1800);
});
`,
      { mode: 0o700 },
    );
    await writeFile(
      join(paseoHome, "config.json"),
      JSON.stringify({
        version: 1,
        agents: { providers: { claude: { command: { mode: "replace", argv: [provider] } } } },
      }),
    );
  }
  console.log("Test 1: start supervisor-entrypoint in dev mode with isolated PASEO_HOME");

  supervisorProcess = spawn(
    process.execPath,
    ["--import", "tsx", "../server/scripts/supervisor-entrypoint.ts", "--dev"],
    {
      cwd: cliRoot,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith("PASEO_")),
        ),
        HOME: paseoHome,
        USERPROFILE: paseoHome,
        ...testEnv,
        PASEO_HOME: paseoHome,
        PASEO_LISTEN: host,
        PASEO_RELAY_ENABLED: "false",
        CI: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  supervisorProcess.stdout?.on("data", (chunk) => {
    recentSupervisorLogs = (recentSupervisorLogs + chunk.toString()).slice(-8000);
  });
  supervisorProcess.stderr?.on("data", (chunk) => {
    recentSupervisorLogs = (recentSupervisorLogs + chunk.toString()).slice(-8000);
  });

  let supervisor = await readDaemonInstance(paseoHome);
  await waitFor(
    async () => {
      supervisor = await readDaemonInstance(paseoHome);
      return supervisor?.pid === supervisorProcess?.pid && Boolean(supervisor?.listen);
    },
    120000,
    "daemon did not publish its bound endpoint in time",
  );
  assert(supervisor?.listen, "owned supervisor should publish its bound endpoint");
  const supervisorPid = supervisor.pid;
  assert.strictEqual(supervisorPid, supervisorProcess.pid, "PID lock should identify this launch");
  assert(isProcessRunning(supervisorPid), "supervisor process should be running");

  client = new DaemonClient({
    url: `ws://${supervisor.listen}/ws`,
    clientId: "supervisor-restart-test",
    connectTimeoutMs: 5000,
    webSocketFactory: (url) => new WebSocket(url) as unknown as WebSocketLike,
  });
  await client.connect();
  // The app reads worker identity through the full RPC, not the bounded CLI observation.
  const statusBeforeRestart = await client.getDaemonStatus();
  const workerPidBeforeRestart = statusBeforeRestart.pid;
  assert(
    isProcessRunning(workerPidBeforeRestart),
    "worker process should be running before restart",
  );
  if (process.platform !== "win32") {
    assert.match(
      await readFile(availabilityLog, "utf8"),
      /\["--version"\]/,
      "the configured slow provider was actually probed",
    );
  }
  console.log(
    `✓ daemon running with supervisor ${supervisorPid} and worker ${workerPidBeforeRestart}\n`,
  );

  console.log("Test 2: app-style restart request should restart worker and keep daemon healthy");
  const restartAck = await client.restartServer("settings_update");
  assert.strictEqual(
    restartAck.status,
    "restart_requested",
    "restart request should be acknowledged",
  );

  const deadline = Date.now() + 20000;
  let statusAfterRestart = statusBeforeRestart;
  await waitFor(
    async () => {
      try {
        const observed = await client!.getDaemonStatus({
          timeout: Math.max(1, deadline - Date.now()),
        });
        if (observed.pid === workerPidBeforeRestart || !isProcessRunning(observed.pid))
          return false;
        statusAfterRestart = observed;
        return true;
      } catch (error) {
        if (error instanceof DaemonConnectionError) return false;
        throw error;
      }
    },
    20000,
    "worker pid did not change after restart request",
  );
  assert.notStrictEqual(
    statusAfterRestart.pid,
    workerPidBeforeRestart,
    "worker pid should change after restart",
  );
  assert(isProcessRunning(statusAfterRestart.pid), "replacement worker should remain running");
  const current = await readDaemonInstance(paseoHome);
  assert(current?.listen, "daemon should remain bound after restart");
  assert.strictEqual(
    current.pid,
    supervisorPid,
    "supervisor pid should remain stable across restart",
  );
  assert(
    isSameDaemonInstance(supervisor, current),
    "supervisor start time should remain stable across restart",
  );
  const capturedSupervisorLogs = await readCapturedSupervisorLogs(paseoHome, recentSupervisorLogs);
  assert(
    capturedSupervisorLogs.includes('"msg":"Worker requested restart"') &&
      capturedSupervisorLogs.includes('"reason":"settings_update"'),
    `restart should log lifecycle restart reason from daemon worker, logs:\n${capturedSupervisorLogs}`,
  );
  assert(
    capturedSupervisorLogs.includes('"msg":"Supervisor requesting graceful worker shutdown"'),
    `restart should log the graceful worker shutdown request, logs:\n${capturedSupervisorLogs}`,
  );
  assert(
    capturedSupervisorLogs.includes("Server closed"),
    `restart should run daemon cleanup before replacing the worker, logs:\n${capturedSupervisorLogs}`,
  );
  console.log("✓ app-style restart keeps daemon healthy and restarts worker\n");
} finally {
  await client?.close();
  if (supervisorProcess?.pid && isProcessRunning(supervisorProcess.pid)) {
    supervisorProcess.kill("SIGTERM");
    await waitFor(
      () => !isProcessRunning(supervisorProcess!.pid ?? -1),
      5000,
      "supervisor cleanup timed out",
    ).catch(() => {
      supervisorProcess?.kill("SIGKILL");
    });
  }

  await runLocalPaseo(["daemon", "stop", "--home", paseoHome, "--force"]);
  await rm(paseoHome, { recursive: true, force: true });
}

if (recentSupervisorLogs.trim().length === 0) {
  console.log("(no supervisor logs captured)");
}

console.log("=== Supervisor restart regression test passed ===");
