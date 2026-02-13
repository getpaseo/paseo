#!/usr/bin/env npx tsx

import assert from 'node:assert'
import { getErrorMessage } from '../src/utils/errors.js'

console.log('=== Error Utils ===\n')

{
  console.log('Test 1: returns Error.message for Error instances')
  assert.strictEqual(getErrorMessage(new Error('boom')), 'boom')
  console.log('✓ returns Error.message\n')
}

{
  console.log('Test 2: stringifies non-Error values')
  assert.strictEqual(getErrorMessage('plain string'), 'plain string')
  assert.strictEqual(getErrorMessage(42), '42')
  assert.strictEqual(getErrorMessage(null), 'null')
  console.log('✓ stringifies non-Error values\n')
}

console.log('=== All error utility tests passed ===')
