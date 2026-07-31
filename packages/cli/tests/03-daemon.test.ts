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
import { mkdtemp, readFile, rm, unlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { runLocalPaseo } from "./helpers/local-cli.ts";

console.log("=== Daemon Commands ===\n");

// Keep restart off default 6767 to avoid collisions with any existing daemon.
const port = 10000 + Math.floor(Math.random() * 50000);
const paseoHome = await mkdtemp(join(tmpdir(), "paseo-test-home-"));

function daemonCommand(args: string[]) {
  return runLocalPaseo(["daemon", ...args], { PASEO_HOME: paseoHome });
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
    const start = await daemonCommand(["start", "--listen", listen, "--relay"]);
    assert.strictEqual(start.exitCode, 0, `IPC daemon should start: ${start.stderr}`);

    const configPath = join(paseoHome, "config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.daemon = { ...config.daemon, listen };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
    const pidPath = join(paseoHome, "paseo.pid");
    const pidContents = await readFile(pidPath, "utf-8");
    await unlink(pidPath);
    const status = await daemonCommand(["status", "--json"]);
    const pairing = await daemonCommand(["pair", "--json"]);
    await writeFile(pidPath, pidContents, "utf-8");
    assert.strictEqual(status.exitCode, 0, `IPC daemon status should succeed: ${status.stderr}`);
    const payload = JSON.parse(status.stdout);
    assert.strictEqual(payload.connectedDaemon, "reachable", "IPC daemon should be reachable");
    assert.strictEqual(payload.localDaemon, "stopped", "missing PID should report stopped locally");
    assert.notStrictEqual(payload.relay, "disabled", "status should use live relay state");
    assert.strictEqual(pairing.exitCode, 0, `IPC daemon pairing should succeed: ${pairing.stderr}`);
    const pairingPayload = JSON.parse(pairing.stdout);
    assert.strictEqual(pairingPayload.relayEnabled, true, "pairing should use live relay state");
    assert.match(pairingPayload.url, /#offer=/, "pairing should use the live daemon offer");

    const foreignHome = await mkdtemp(join(tmpdir(), "paseo-test-foreign-home-"));
    try {
      await writeFile(
        join(foreignHome, "config.json"),
        `${JSON.stringify({ daemon: { listen } }, null, 2)}\n`,
        "utf-8",
      );
      const foreignPairing = await runLocalPaseo(
        ["daemon", "pair", "--home", foreignHome, "--json"],
        { PASEO_HOME: foreignHome },
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
      assert(!foreignPairing.stdout.includes("#offer="), "pairing should not expose another offer");
    } finally {
      await rm(foreignHome, { recursive: true, force: true });
    }

    const cleanup = await daemonCommand(["stop", "--force"]);
    assert.strictEqual(cleanup.exitCode, 0, "cleanup stop should succeed after IPC status");
    console.log("✓ daemon status probes live relay state over local IPC\n");
  }
} finally {
  // Best-effort daemon cleanup in case assertions fail before explicit stop.
  await daemonCommand(["stop", "--force"]);
  // Clean up temp directory
  await rm(paseoHome, { recursive: true, force: true });
}

console.log("=== All daemon tests passed ===");
