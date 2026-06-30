import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { getE2EDaemonPort } from "./daemon-port";
import { withDisabledE2ESpeechEnv } from "./speech-env";

/**
 * Restarts the isolated E2E daemon against the SAME PASEO_HOME and SAME port so
 * persisted state reloads and existing clients can reconnect. This exercises the
 * post-restart rehydration path (the daemon rebuilding workspace/agent links
 * from disk), which is where the worktree-branch regression lives.
 *
 * The daemon is owned by Playwright's `globalSetup`, which keeps its child
 * handle in module scope we can't reach from a spec. Instead we drive it the
 * same way an operator would: read the supervisor PID from
 * `$PASEO_HOME/paseo.pid`, SIGTERM it (the supervisor forwards the signal to its
 * worker and releases the lock), wait for the port to free, then re-spawn the
 * supervisor with the identical environment globalSetup used. The relay and
 * Metro processes are untouched, so we reuse their already-published ports.
 *
 * This NEVER targets the developer daemon: the port comes from
 * `getE2EDaemonPort()`, which refuses 6767, and PASEO_HOME is the isolated E2E
 * home globalSetup created.
 */

function getEnvOrThrow(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set (expected from Playwright globalSetup).`);
  }
  return value;
}

async function readSupervisorPid(paseoHome: string): Promise<number> {
  const pidPath = path.join(paseoHome, "paseo.pid");
  const content = await readFile(pidPath, "utf8");
  const parsed = JSON.parse(content) as { pid?: unknown };
  if (typeof parsed.pid !== "number") {
    throw new Error(`Malformed PID lock at ${pidPath}: ${content}`);
  }
  return parsed.pid;
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isPortListening(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, host, () => {
      socket.end();
      resolve(true);
    });
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(false));
  });
}

async function waitUntil(
  predicate: () => Promise<boolean> | boolean,
  options: { timeoutMs: number; label: string },
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out after ${options.timeoutMs}ms waiting for ${options.label}.`);
}

function spawnSupervisor(args: {
  paseoHome: string;
  port: string;
  relayPort: string;
  metroPort: string;
  editorRecordPath: string;
}): ChildProcess {
  const serverDir = path.resolve(__dirname, "../../../..", "packages/server");
  // Run the supervisor through the resolved tsx CLI under the current node
  // binary. Spawning the `node_modules/.bin/tsx` shim directly is unreliable
  // inside the Playwright worker (the shim is a .mjs symlink, not an executable),
  // so resolve the CLI module and load it with node.
  const tsxCli = createRequire(path.join(serverDir, "package.json")).resolve("tsx/cli");
  const env = withDisabledE2ESpeechEnv({
    ...process.env,
    PASEO_HOME: args.paseoHome,
    PASEO_E2E_EDITOR_RECORD_PATH: args.editorRecordPath,
    PASEO_SERVER_ID: "srv_e2e_test_daemon",
    PASEO_LISTEN: `0.0.0.0:${args.port}`,
    PASEO_RELAY_ENDPOINT: `127.0.0.1:${args.relayPort}`,
    PASEO_CORS_ORIGINS: `http://localhost:${args.metroPort}`,
    PASEO_NODE_ENV: "development",
    NODE_ENV: "development",
  });

  const child = spawn(process.execPath, [tsxCli, "scripts/supervisor-entrypoint.ts", "--dev"], {
    cwd: serverDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  child.stdout?.on("data", (data: Buffer) => {
    for (const line of data.toString().split("\n")) {
      if (line.trim()) console.log(`[daemon:restart] ${line.trim()}`);
    }
  });
  child.stderr?.on("data", (data: Buffer) => {
    for (const line of data.toString().split("\n")) {
      if (line.trim()) console.error(`[daemon:restart] ${line.trim()}`);
    }
  });

  // Detach our handles so the spawned supervisor outlives this spec process and
  // is reaped by globalSetup's cleanup (the original process tree), not us.
  child.unref();
  return child;
}

export async function restartTestDaemon(): Promise<void> {
  const port = getE2EDaemonPort();
  const paseoHome = getEnvOrThrow("E2E_PASEO_HOME");
  const relayPort = getEnvOrThrow("E2E_RELAY_PORT");
  const metroPort = getEnvOrThrow("E2E_METRO_PORT");
  const editorRecordPath =
    process.env.E2E_EDITOR_RECORD_PATH ?? path.join(paseoHome, "editor-open-records.jsonl");

  const pid = await readSupervisorPid(paseoHome);
  process.kill(pid, "SIGTERM");

  await waitUntil(() => !isPidRunning(pid), {
    timeoutMs: 15_000,
    label: `supervisor PID ${pid} to exit`,
  });
  await waitUntil(async () => !(await isPortListening(Number(port))), {
    timeoutMs: 15_000,
    label: `port ${port} to free`,
  });

  spawnSupervisor({ paseoHome, port, relayPort, metroPort, editorRecordPath });

  await waitUntil(async () => isPortListening(Number(port)), {
    timeoutMs: 30_000,
    label: `restarted daemon to listen on port ${port}`,
  });
}
