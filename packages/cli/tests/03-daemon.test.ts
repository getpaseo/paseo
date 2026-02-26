#!/usr/bin/env npx tsx

/**
 * Phase 2: Daemon Command Tests
 *
 * Tests daemon commands with an isolated JUNCTION_HOME.
 *
 * Tests:
 * - daemon --help shows subcommands
 * - daemon pair prints a local pairing link without requiring a running daemon
 * - daemon status reports stopped when daemon not running
 * - daemon status --json outputs valid JSON
 * - daemon stop handles daemon not running gracefully
 * - daemon restart starts the daemon and can be cleaned up
 */

import assert from 'node:assert'
import { $ } from 'zx'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

$.verbose = false

console.log('=== Daemon Commands ===\n')

// Keep restart off default 6767 to avoid collisions with any existing daemon.
const port = 10000 + Math.floor(Math.random() * 50000)
const junctionHome = await mkdtemp(join(tmpdir(), 'junction-test-home-'))

try {
  // Test 1: daemon --help shows subcommands
  {
    console.log('Test 1: daemon --help shows subcommands')
    const result = await $`npx junction daemon --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'daemon --help should exit 0')
    assert(result.stdout.includes('start'), 'help should mention start')
    assert(result.stdout.includes('status'), 'help should mention status')
    assert(result.stdout.includes('stop'), 'help should mention stop')
    assert(result.stdout.includes('restart'), 'help should mention restart')
    assert(result.stdout.includes('pair'), 'help should mention pair')
    console.log('✓ daemon --help shows subcommands\n')
  }

  // Test 2: daemon pair works without daemon process
  {
    console.log('Test 2: daemon pair prints local pairing URL')
    const result =
      await $`JUNCTION_HOME=${junctionHome} npx junction daemon pair`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'daemon pair should succeed')
    assert(result.stdout.includes('Scan to pair:'), 'output should include scan header')
    assert(result.stdout.includes('#offer='), 'output should include pairing offer fragment')
    console.log('✓ daemon pair prints local pairing URL\n')
  }

  // Test 3: daemon status reports stopped when daemon not running
  {
    console.log('Test 3: daemon status reports stopped when not running')
    const result =
      await $`JUNCTION_HOME=${junctionHome} npx junction daemon status`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'status should succeed when daemon is stopped')
    const output = result.stdout.toLowerCase()
    assert(output.includes('status'), 'status table should include Status row')
    assert(output.includes('stopped'), 'status should report stopped')
    console.log('✓ daemon status reports stopped when not running\n')
  }

  // Test 4: daemon status --json outputs valid JSON
  {
    console.log('Test 4: daemon status --json outputs JSON')
    const result =
      await $`JUNCTION_HOME=${junctionHome} npx junction daemon status --json`.nothrow()
    assert.strictEqual(result.exitCode, 0, '--json status should succeed')
    const status = JSON.parse(result.stdout)
    assert.strictEqual(status.status, 'stopped', 'json status should report stopped')
    assert.strictEqual(status.home, junctionHome, 'json status should reflect the isolated home')
    console.log('✓ daemon status --json outputs valid JSON\n')
  }

  // Test 5: daemon stop handles daemon not running gracefully
  {
    console.log('Test 5: daemon stop handles daemon not running')
    const result =
      await $`JUNCTION_HOME=${junctionHome} npx junction daemon stop`.nothrow()
    // Stop should succeed even if daemon is not running (idempotent).
    assert.strictEqual(result.exitCode, 0, 'stop should succeed when daemon not running')
    const output = result.stdout + result.stderr
    const mentionsNotRunning =
      output.toLowerCase().includes('not running') ||
      output.toLowerCase().includes('was not running')
    assert(mentionsNotRunning, 'output should mention daemon was not running')
    console.log('✓ daemon stop succeeds gracefully when daemon not running\n')
  }

  // Test 6: daemon restart starts daemon and can be stopped
  {
    console.log('Test 6: daemon restart starts daemon and can be stopped')
    const result =
      await $`JUNCTION_HOME=${junctionHome} npx junction daemon restart --port ${String(port)}`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'restart should succeed even when previously stopped')
    assert(result.stdout.toLowerCase().includes('restarted'), 'output should report restart')

    const cleanup = await $`JUNCTION_HOME=${junctionHome} npx junction daemon stop --force`.nothrow()
    assert.strictEqual(cleanup.exitCode, 0, 'cleanup stop should succeed after restart')
    console.log('✓ daemon restart starts and stop cleanup succeeds\n')
  }
} finally {
  // Best-effort daemon cleanup in case assertions fail before explicit stop.
  await $`JUNCTION_HOME=${junctionHome} npx junction daemon stop --force`.nothrow()
  // Clean up temp directory
  await rm(junctionHome, { recursive: true, force: true })
}

console.log('=== All daemon tests passed ===')
