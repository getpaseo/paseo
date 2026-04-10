#!/usr/bin/env npx tsx

/**
 * Phase 2: Daemon Command Tests
 *
 * Tests daemon commands with an isolated PASEO_HOME.
 *
 * Tests:
 * - daemon --help shows subcommands
 * - daemon pair prints a local pairing link without requiring a running daemon
 * - daemon status reports stopped when daemon not running
 * - daemon status --json outputs valid JSON
 * - daemon stop handles daemon not running gracefully
 * - daemon restart starts the daemon and can be cleaned up
 */

import assert from "node:assert";
import { mkdtemp, rm } from "fs/promises";
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

  // Test 2: daemon pair works without daemon process
  {
    console.log("Test 2: daemon pair prints local pairing URL");
    const result = await daemonCommand(["pair"]);
    assert.strictEqual(result.exitCode, 0, "daemon pair should succeed");
    assert(result.stdout.includes("Scan to pair:"), "output should include scan header");
    assert(result.stdout.includes("#offer="), "output should include pairing offer fragment");
    console.log("✓ daemon pair prints local pairing URL\n");
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

  // Test 4: daemon pair --json outputs valid JSON
  {
    console.log("Test 4: daemon pair --json outputs JSON");
    const result = await daemonCommand(["pair", "--json"]);
    assert.strictEqual(result.exitCode, 0, "daemon pair --json should succeed");
    const pairing = JSON.parse(result.stdout);
    assert.strictEqual(pairing.relayEnabled, true, "pairing should report relay enabled");
    assert.match(pairing.url, /#offer=/, "pairing URL should include offer fragment");
    assert.strictEqual(typeof pairing.qr, "string", "pairing should include QR content");
    console.log("✓ daemon pair --json outputs valid JSON\n");
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
} finally {
  // Best-effort daemon cleanup in case assertions fail before explicit stop.
  await daemonCommand(["stop", "--force"]);
  // Clean up temp directory
  await rm(paseoHome, { recursive: true, force: true });
}

console.log("=== All daemon tests passed ===");
