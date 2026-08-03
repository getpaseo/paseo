import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { describe, expect, test } from "vitest";
import {
  SERVICE_MANAGER_STOP_SIGNAL,
  UNAUTHORIZED_SERVICE_MANAGED_STOP_EXIT_CODE,
} from "./supervisor.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const supervisorPath = fileURLToPath(new URL("./supervisor.ts", import.meta.url));

/**
 * A v0.2.5 CLI does not understand `shutdown_rejected`. It waits out its RPC
 * timeout and then falls back to SIGTERM on the pid-lock owner, which is the
 * supervisor. These tests reproduce that signal at the supervisor boundary
 * rather than driving the current CLI, so they keep holding after the CLI
 * changes again.
 */
interface SupervisorRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  log: string;
  stderr: string;
}

async function runSupervisorFixture(options: {
  workerSource: string;
  serviceManaged: boolean;
  /** Sent once the worker reports it is up. */
  signalSupervisor?: NodeJS.Signals;
  /** Gives the worker a file to distinguish its first start from a respawn. */
  useRestartMarker?: boolean;
}): Promise<SupervisorRun> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "paseo-supervisor-managed-"));
  const logPath = path.join(tempDir, "daemon.log");
  const workerPath = path.join(tempDir, "worker.mjs");
  const runnerPath = path.join(tempDir, "runner.mjs");

  await writeFile(workerPath, options.workerSource);
  await writeFile(
    runnerPath,
    `
      import { runSupervisor } from ${JSON.stringify(pathToFileURL(supervisorPath).href)};

      runSupervisor({
        name: "TestSupervisor",
        startupMessage: "starting fixture",
        resolveWorkerEntry: () => ${JSON.stringify(workerPath)},
        workerArgs: [],
        workerEnv: process.env,
        workerExecArgv: [],
        restartOnCrash: true,
        serviceManaged: ${JSON.stringify(options.serviceManaged)},
        logFile: {
          path: ${JSON.stringify(logPath)},
          rotate: { maxSize: "1m", maxFiles: 2 },
        },
      });
    `,
  );

  const child = spawn(process.execPath, ["--import", "tsx", runnerPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...(options.useRestartMarker
        ? { PASEO_TEST_RESTART_MARKER: path.join(tempDir, "restarted") }
        : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    // The worker announces itself on stderr through the supervisor's pipe. Wait
    // for that instead of a timer so the signal always lands on a live worker.
    if (options.signalSupervisor && stderr.includes("worker-up")) {
      const signal = options.signalSupervisor;
      options.signalSupervisor = undefined;
      child.kill(signal);
    }
  });

  const { code, signal } = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`supervisor fixture timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 20000);

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode, exitSignal) => {
      clearTimeout(timeout);
      resolve({ code: exitCode, signal: exitSignal });
    });
  });

  const log = await readFile(logPath, "utf8").catch(() => "");
  return { code, signal, log, stderr };
}

/**
 * Production-shaped: the real worker traps SIGTERM and exits 0, so a supervisor
 * stop always shows up as `code: 0, signal: null`. A worker that dies from the
 * signal instead would let a broken supervisor pass on exit metadata alone.
 * Reports readiness so the test never races the spawn.
 */
const IDLE_WORKER = `
  process.on("SIGTERM", () => process.exit(0));
  process.on("disconnect", () => process.exit(0));
  process.stderr.write("worker-up\\n");
  setInterval(() => {}, 1000);
`;

/** Relays the authorized shutdown intent the session emits once the fence passes. */
const AUTHORIZED_SHUTDOWN_WORKER = `
  process.stderr.write("worker-up\\n");
  process.send?.({ type: "paseo:shutdown", reason: "client_shutdown_rpc" });
  setInterval(() => {}, 1000);
  process.on("SIGTERM", () => process.exit(0));
`;

describe("service-managed supervisor stop authorization", () => {
  test("a previous-release CLI SIGTERM on the pid-lock owner does not read as a clean stop", async () => {
    const result = await runSupervisorFixture({
      workerSource: IDLE_WORKER,
      serviceManaged: true,
      signalSupervisor: "SIGTERM",
    });

    // Exiting 0 here is what leaves a `Restart=on-failure` unit down for good.
    expect(result.code).toBe(UNAUTHORIZED_SERVICE_MANAGED_STOP_EXIT_CODE);
    expect(result.log).toContain("Unauthorized stop of a service-managed daemon");
  }, 30_000);

  test("the service manager stop signal is an intentional stop, not an unauthorized one", async () => {
    // What systemd KillSignal= and Docker STOPSIGNAL send. `systemctl stop` and
    // `docker stop` must not leave a failed unit or a 75 container exit code.
    const result = await runSupervisorFixture({
      workerSource: IDLE_WORKER,
      serviceManaged: true,
      signalSupervisor: SERVICE_MANAGER_STOP_SIGNAL,
    });

    expect(result.code).toBe(0);
    expect(result.log).toContain('"authorized":true');
    expect(result.log).not.toContain("Unauthorized stop of a service-managed daemon");
    // The worker still gets a graceful SIGTERM rather than being killed outright.
    expect(result.log).toContain('"signal":"SIGTERM"');
  }, 30_000);

  test("an authorized service maintenance shutdown still exits cleanly", async () => {
    const result = await runSupervisorFixture({
      workerSource: AUTHORIZED_SHUTDOWN_WORKER,
      serviceManaged: true,
    });

    expect(result.code).toBe(0);
    expect(result.log).toContain('"authorized":true');
    expect(result.log).not.toContain("Unauthorized stop of a service-managed daemon");
  }, 30_000);

  test("a stray SIGTERM on the worker restarts it instead of taking the daemon down", async () => {
    // treeKill signals the whole tree, so the same fallback reaches the worker.
    // The default rule reads a SIGTERM death as an intended stop and lets the
    // supervisor exit; a service-managed daemon must respawn instead.
    const result = await runSupervisorFixture({
      workerSource: `
          import { existsSync, writeFileSync } from "node:fs";
          const marker = process.env.PASEO_TEST_RESTART_MARKER;
          if (existsSync(marker)) {
            process.stderr.write("worker-up-again\\n");
            process.send?.({ type: "paseo:shutdown", reason: "client_shutdown_rpc" });
            setInterval(() => {}, 1000);
            process.on("SIGTERM", () => process.exit(0));
          } else {
            writeFileSync(marker, "1");
            process.stderr.write("worker-up\\n");
            process.kill(process.pid, "SIGTERM");
          }
        `,
      serviceManaged: true,
      useRestartMarker: true,
    });

    expect(result.stderr).toContain("worker-up-again");
    expect(result.log).toContain(
      "Restarting worker after an exit without a supervisor lifecycle request",
    );
    expect(result.code).toBe(0);
  }, 30_000);

  test("a production-shaped SIGTERM handler exit is respawned without a supervisor request", async () => {
    const result = await runSupervisorFixture({
      workerSource: `
          import { existsSync, writeFileSync } from "node:fs";
          const marker = process.env.PASEO_TEST_RESTART_MARKER;
          process.on("SIGTERM", () => process.exit(0));
          if (existsSync(marker)) {
            process.stderr.write("worker-up-again\\n");
            process.send?.({ type: "paseo:shutdown", reason: "client_shutdown_rpc" });
            setInterval(() => {}, 1000);
          } else {
            writeFileSync(marker, "1");
            process.stderr.write("worker-up\\n");
            process.kill(process.pid, "SIGTERM");
          }
        `,
      serviceManaged: true,
      useRestartMarker: true,
    });

    expect(result.stderr).toContain("worker-up-again");
    expect(result.log).toContain(
      "Restarting worker after an exit without a supervisor lifecycle request",
    );
    expect(result.log).toContain('"code":0');
    expect(result.log).toContain('"signal":null');
    expect(result.code).toBe(0);
  }, 30_000);

  test("an unmanaged daemon keeps exiting 0 on SIGTERM", async () => {
    const result = await runSupervisorFixture({
      workerSource: IDLE_WORKER,
      serviceManaged: false,
      signalSupervisor: "SIGTERM",
    });

    expect(result.code).toBe(0);
    expect(result.log).not.toContain("Unauthorized stop of a service-managed daemon");
  }, 30_000);

  test("an unmanaged supervisor preserves native SIGQUIT termination", async () => {
    const result = await runSupervisorFixture({
      workerSource: IDLE_WORKER,
      serviceManaged: false,
      signalSupervisor: SERVICE_MANAGER_STOP_SIGNAL,
    });

    expect(result.code).toBeNull();
    expect(result.signal).toBe(SERVICE_MANAGER_STOP_SIGNAL);
    expect(result.log).not.toContain("Supervisor shutdown requested");
    expect(result.log).not.toContain('"authorized":true');
  }, 30_000);
});
