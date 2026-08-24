#!/usr/bin/env npx tsx

/**
 * Phase 2: Daemon Command Tests
 *
 * Tests daemon commands with an isolated PASEO_HOME.
 *
 * Tests:
 * - daemon --help shows subcommands
 * - daemon pair does not create a relay offer without explicit consent
 * - daemon status reports stopped when daemon not running
 * - daemon status --json outputs valid JSON
 * - daemon stop handles daemon not running gracefully
 * - daemon restart starts the daemon and can be cleaned up
 * - daemon status probes the live relay state over local IPC
 */

import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import YAML from "yaml";
import { runLocalPaseo } from "./helpers/local-cli.ts";

console.log("=== Daemon Commands ===\n");

// Keep restart off default 6767 to avoid collisions with any existing daemon.
const port = 10000 + Math.floor(Math.random() * 50000);
const paseoHome = await mkdtemp(join(tmpdir(), "paseo-test-home-"));
const require = createRequire(import.meta.url);

function daemonCommand(args: string[]) {
  return runLocalPaseo(["daemon", ...args], { PASEO_HOME: paseoHome });
}

async function stopChildProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const forceKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try {
    await exited;
  } finally {
    clearTimeout(forceKill);
  }
}

function resolveDaemonWorkerEntry(): string {
  let currentDir = dirname(require.resolve("@getpaseo/server"));

  while (true) {
    const packageJsonPath = join(currentDir, "package.json");
    if (existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
      if (packageJson.name === "@getpaseo/server") {
        const candidates = [
          join(currentDir, "dist", "server", "server", "daemon-worker.js"),
          join(currentDir, "src", "server", "daemon-worker.ts"),
        ];
        const workerEntry = candidates.find(existsSync);
        if (workerEntry) return workerEntry;
        throw new Error(`Daemon worker not found under ${currentDir}`);
      }
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  throw new Error("Unable to resolve @getpaseo/server package root");
}

async function tailDaemonLog(): Promise<string> {
  try {
    const log = await readFile(join(paseoHome, "daemon.log"), "utf-8");
    return log.split("\n").slice(-30).join("\n");
  } catch {
    return "<daemon log unavailable>";
  }
}

async function retryWhileWorkerRuns<T>(
  worker: ChildProcess,
  probe: () => Promise<T>,
  accepts: (result: T) => boolean,
  failureDetails: (result: T) => string | Promise<string>,
): Promise<T> {
  const deadline = Date.now() + 120_000;
  let result = await probe();

  while (!accepts(result)) {
    assert(
      worker.exitCode === null && worker.signalCode === null,
      "IPC daemon exited before the probe completed",
    );
    assert(Date.now() < deadline, await failureDetails(result));
    await new Promise((resolve) => setTimeout(resolve, 100));
    result = await probe();
  }

  return result;
}

try {
  // Test 1: daemon --help shows subcommands
  {
    console.log("Test 1: daemon --help shows subcommands");
    const result = await runLocalPaseo(["daemon", "--help"]);
    assert.strictEqual(result.exitCode, 0, "daemon --help should exit 0");
    assert(result.stdout.includes("start"), "help should mention start");
    assert(result.stdout.includes("status"), "help should mention status");
    assert(result.stdout.includes("stop"), "help should mention stop");
    assert(result.stdout.includes("restart"), "help should mention restart");
    assert(result.stdout.includes("pair"), "help should mention pair");
    console.log("✓ daemon --help shows subcommands\n");
  }

  // Test 2: non-interactive pairing keeps relay disabled by default
  {
    console.log("Test 2: daemon pair requires explicit relay consent");
    const result = await daemonCommand(["pair"]);
    assert.strictEqual(result.exitCode, 1, "daemon pair should require relay consent");
    assert(
      result.stderr.includes("Relay pairing is disabled"),
      "output should explain that relay pairing is disabled",
    );
    assert(!result.stdout.includes("#offer="), "output should not include a pairing offer");
    console.log("✓ daemon pair requires explicit relay consent\n");
  }

  // Test 3: daemon status reports stopped when daemon not running
  {
    console.log("Test 3: daemon status reports stopped when not running");
    const result = await daemonCommand(["status"]);
    assert.strictEqual(result.exitCode, 0, "status should succeed when daemon is stopped");
    const output = result.stdout.toLowerCase();
    assert(output.includes("local daemon"), "status table should include Local Daemon row");
    assert(output.includes("stopped"), "status should report stopped");
    console.log("✓ daemon status reports stopped when not running\n");
  }

  // Test 4: daemon pair --json exposes the machine-readable disabled state
  {
    console.log("Test 4: daemon pair --json reports relay disabled");
    const result = await daemonCommand(["pair", "--json"]);
    assert.strictEqual(result.exitCode, 1, "daemon pair --json should require relay consent");
    const errorLine = result.stderr.split("\n").find((line) => line.startsWith("{"));
    assert(errorLine, "stderr should include a structured error");
    const error = JSON.parse(errorLine);
    assert.strictEqual(error.code, "RELAY_DISABLED", "error should identify relay state");
    assert(!result.stdout.includes("#offer="), "output should not include a pairing offer");
    console.log("✓ daemon pair --json reports relay disabled\n");
  }

  // Test 5: daemon status --json outputs valid JSON
  {
    console.log("Test 5: daemon status --json outputs JSON");
    const result = await daemonCommand(["status", "--json"]);
    assert.strictEqual(result.exitCode, 0, "--json status should succeed");
    const status = JSON.parse(result.stdout);
    assert.strictEqual(typeof status.serverId, "string", "json status should include serverId");
    assert.strictEqual(status.localDaemon, "stopped", "json status should report stopped");
    assert.strictEqual(status.home, paseoHome, "json status should reflect the isolated home");
    assert.strictEqual(
      status.hostname,
      null,
      "json status should include hostname when unavailable",
    );
    console.log("✓ daemon status --json outputs valid JSON\n");
  }

  // Test 6: daemon stop handles daemon not running gracefully
  {
    console.log("Test 6: daemon stop handles daemon not running");
    const result = await daemonCommand(["stop"]);
    // Stop should succeed even if daemon is not running (idempotent).
    assert.strictEqual(result.exitCode, 0, "stop should succeed when daemon not running");
    const output = result.stdout + result.stderr;
    const mentionsNotRunning =
      output.toLowerCase().includes("not running") ||
      output.toLowerCase().includes("was not running");
    assert(mentionsNotRunning, "output should mention daemon was not running");
    console.log("✓ daemon stop succeeds gracefully when daemon not running\n");
  }

  // Test 7: daemon restart starts daemon and can be stopped
  {
    console.log("Test 7: daemon restart starts daemon and can be stopped");
    const result = await daemonCommand(["restart", "--port", String(port)]);
    assert.strictEqual(result.exitCode, 0, "restart should succeed even when previously stopped");
    assert(result.stdout.toLowerCase().includes("restarted"), "output should report restart");

    const cleanup = await daemonCommand(["stop", "--force"]);
    assert.strictEqual(cleanup.exitCode, 0, "cleanup stop should succeed after restart");
    console.log("✓ daemon restart starts and stop cleanup succeeds\n");
  }

  // Test 8: status uses the running daemon as relay authority over local IPC
  {
    console.log("Test 8: daemon status probes live relay state over local IPC");
    const listen =
      process.platform === "win32"
        ? `\\\\.\\pipe\\paseo-status-${process.pid}-${Date.now()}`
        : join(paseoHome, "status.sock");
    const configPath = join(paseoHome, "config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.daemon = {
      ...config.daemon,
      listen,
      relay: { ...config.daemon?.relay, enabled: false },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
    // A supervised daemon owns and heartbeats paseo.pid. Launch the worker
    // directly so this fixture naturally has a reachable daemon without a PID file.
    const workerEntry = resolveDaemonWorkerEntry();
    const workerArgs = workerEntry.endsWith(".ts")
      ? ["--import", "tsx", workerEntry, "--relay"]
      : [workerEntry, "--relay"];
    const worker = spawn(process.execPath, workerArgs, {
      cwd: join(import.meta.dirname, ".."),
      env: {
        ...process.env,
        PASEO_HOME: paseoHome,
        PASEO_LISTEN: listen,
        PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD: "0",
        PASEO_DICTATION_ENABLED: "0",
        PASEO_VOICE_MODE_ENABLED: "0",
        CI: "true",
      },
      stdio: "ignore",
    });

    try {
      const relayProbe = await retryWhileWorkerRuns(
        worker,
        async () => {
          const statusResult = await daemonCommand(["status", "--json"]);
          const statusPayload =
            statusResult.exitCode === 0 ? JSON.parse(statusResult.stdout) : null;
          const pairingResult = await daemonCommand(["pair", "--json"]);
          return { statusResult, statusPayload, pairingResult };
        },
        (result) =>
          result.statusPayload?.connectedDaemon === "reachable" &&
          result.statusPayload.relay !== "disabled" &&
          result.pairingResult.exitCode === 0,
        async (result) =>
          [
            "IPC daemon did not expose live relay state",
            `status: ${result.statusResult.stdout || result.statusResult.stderr}`,
            `pairing: ${result.pairingResult.stdout || result.pairingResult.stderr}`,
            `daemon log:\n${await tailDaemonLog()}`,
          ].join("\n"),
      );
      const { statusResult: status, statusPayload: payload, pairingResult: pairing } = relayProbe;

      assert.strictEqual(status.exitCode, 0, `IPC daemon status should succeed: ${status.stderr}`);
      assert.strictEqual(payload.connectedDaemon, "reachable", "IPC daemon should be reachable");
      assert.strictEqual(
        payload.localDaemon,
        "stopped",
        "missing PID should report stopped locally",
      );
      assert.notStrictEqual(payload.relay, "disabled", "status should use live relay state");
      assert.strictEqual(
        pairing.exitCode,
        0,
        `IPC daemon pairing should succeed: ${pairing.stderr}`,
      );
      const pairingPayload = JSON.parse(pairing.stdout);
      assert.strictEqual(pairingPayload.relayEnabled, true, "pairing should use live relay state");
      assert.match(pairingPayload.url, /#offer=/, "pairing should use the live daemon offer");

      const reloadConfig = JSON.parse(await readFile(configPath, "utf-8"));
      reloadConfig.daemon = {
        ...reloadConfig.daemon,
        listen: process.platform === "win32" ? `${listen}-changed` : `${listen}.changed`,
        browserTools: { enabled: true },
      };
      await writeFile(configPath, `${JSON.stringify(reloadConfig, null, 2)}\n`, "utf-8");
      const nestedReload = await daemonCommand(["reload", "--host", listen, "--json"]);
      assert.strictEqual(nestedReload.exitCode, 0, nestedReload.stderr);
      assert.deepStrictEqual(JSON.parse(nestedReload.stdout), {
        appliedPaths: ["daemon.browserTools.enabled"],
        restartRequiredPaths: [],
        overrideControlledPaths: ["daemon.listen"],
      });

      reloadConfig.daemon.browserTools.enabled = false;
      await writeFile(configPath, `${JSON.stringify(reloadConfig, null, 2)}\n`, "utf-8");
      const aliasReload = await runLocalPaseo(["reload", "--host", listen, "--json"], {
        PASEO_HOME: paseoHome,
      });
      assert.strictEqual(aliasReload.exitCode, 0, aliasReload.stderr);
      assert.deepStrictEqual(JSON.parse(aliasReload.stdout), {
        appliedPaths: ["daemon.browserTools.enabled"],
        restartRequiredPaths: [],
        overrideControlledPaths: [],
      });

      const yamlReload = await daemonCommand(["reload", "--host", listen, "--format", "yaml"]);
      assert.strictEqual(yamlReload.exitCode, 0, yamlReload.stderr);
      assert.deepStrictEqual(YAML.parse(yamlReload.stdout), {
        appliedPaths: [],
        restartRequiredPaths: [],
        overrideControlledPaths: [],
      });

      const humanReload = await daemonCommand(["reload", "--host", listen]);
      assert.match(humanReload.stdout, /Configuration reloaded\./);

      const foreignHome = await mkdtemp(join(tmpdir(), "paseo-test-foreign-home-"));
      try {
        await writeFile(
          join(foreignHome, "config.json"),
          `${JSON.stringify({ daemon: { listen } }, null, 2)}\n`,
          "utf-8",
        );
        const foreignPairing = await retryWhileWorkerRuns(
          worker,
          () =>
            runLocalPaseo(["daemon", "pair", "--home", foreignHome, "--json"], {
              PASEO_HOME: foreignHome,
            }),
          (result) => result.stderr.includes("different Paseo home"),
          (result) => `Pairing did not report the daemon identity mismatch: ${result.stderr}`,
        );
        assert.notStrictEqual(
          foreignPairing.exitCode,
          0,
          "pairing should reject a daemon owned by another home",
        );
        assert(
          foreignPairing.stderr.includes("different Paseo home"),
          "pairing should explain the daemon identity mismatch",
        );
        assert(
          !foreignPairing.stdout.includes("#offer="),
          "pairing should not expose another offer",
        );
      } finally {
        await rm(foreignHome, { recursive: true, force: true });
      }
    } finally {
      await stopChildProcess(worker);
    }
    console.log("✓ daemon status probes live relay state over local IPC\n");
  }

  // Test 9: --relay accepts an already-enabled persisted relay while stopped
  {
    console.log("Test 9: daemon pair --relay accepts persisted relay while stopped");
    const configPath = join(paseoHome, "config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.daemon = {
      ...config.daemon,
      relay: { ...config.daemon?.relay, enabled: true },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");

    const pairing = await daemonCommand(["pair", "--relay", "--json"]);

    assert.strictEqual(
      pairing.exitCode,
      0,
      `persisted relay pairing should succeed while stopped: ${pairing.stderr}`,
    );
    const payload = JSON.parse(pairing.stdout);
    assert.strictEqual(payload.relayEnabled, true, "pairing should preserve persisted relay state");
    assert.match(payload.url, /#offer=/, "pairing should include the offline offer");
    console.log("✓ daemon pair --relay accepts persisted relay while stopped\n");
  }
} finally {
  // Best-effort daemon cleanup in case assertions fail before explicit stop.
  await daemonCommand(["stop", "--force"]);
  // Clean up temp directory
  await rm(paseoHome, { recursive: true, force: true });
}

console.log("=== All daemon tests passed ===");
