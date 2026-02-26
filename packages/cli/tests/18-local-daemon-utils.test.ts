#!/usr/bin/env npx tsx

/**
 * Phase 18: Local daemon utility tests.
 *
 * Tests pure helpers that do not require a running daemon.
 */

import assert from 'node:assert'
import { resolveTcpHostFromListen } from '../src/commands/daemon/local-daemon.js'

console.log('=== Local Daemon Utility Helpers ===\n')

{
  console.log('Test 1: resolves numeric listen values to localhost host:port')
  assert.strictEqual(resolveTcpHostFromListen('6767'), '127.0.0.1:6767')
  assert.strictEqual(resolveTcpHostFromListen('  7777  '), '127.0.0.1:7777')
  console.log('✓ resolves numeric listen values\n')
}

{
  console.log('Test 2: preserves explicit host:port listen values')
  assert.strictEqual(resolveTcpHostFromListen('localhost:6767'), 'localhost:6767')
  assert.strictEqual(resolveTcpHostFromListen('0.0.0.0:8080'), '0.0.0.0:8080')
  console.log('✓ preserves explicit host:port values\n')
}

{
  console.log('Test 3: rejects unix socket listen values')
  assert.strictEqual(resolveTcpHostFromListen('/tmp/junction.sock'), null)
  assert.strictEqual(resolveTcpHostFromListen('unix:///tmp/junction.sock'), null)
  console.log('✓ rejects unix socket listen values\n')
}

{
  console.log('Test 4: rejects empty and non-host listen values')
  assert.strictEqual(resolveTcpHostFromListen(''), null)
  assert.strictEqual(resolveTcpHostFromListen('   '), null)
  assert.strictEqual(resolveTcpHostFromListen('localhost'), null)
  console.log('✓ rejects empty and non-host listen values\n')
}

console.log('=== All local daemon utility tests passed ===')
