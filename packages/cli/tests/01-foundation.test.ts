#!/usr/bin/env npx zx

/**
 * Phase 1: Foundation Tests
 *
 * Tests basic CLI functionality that doesn't require a daemon:
 * - junction --version outputs version
 * - junction --help shows commands
 */

import { $ } from 'zx'

$.verbose = false

console.log('📋 Phase 1: Foundation Tests\n')

// Test 1.1: --version outputs version
console.log('  Testing junction --version...')
const versionResult = await $`junction --version`.nothrow()
if (versionResult.exitCode !== 0) {
  console.error('  ❌ junction --version failed with exit code', versionResult.exitCode)
  console.error('     stderr:', versionResult.stderr)
  process.exit(1)
}
const versionOutput = versionResult.stdout.trim()
if (!versionOutput.match(/\d+\.\d+\.\d+/)) {
  console.error('  ❌ junction --version output does not contain version number')
  console.error('     output:', versionOutput)
  process.exit(1)
}
console.log('  ✅ junction --version outputs:', versionOutput)

// Test 1.2: --help shows commands
console.log('  Testing junction --help...')
const helpResult = await $`junction --help`.nothrow()
if (helpResult.exitCode !== 0) {
  console.error('  ❌ junction --help failed with exit code', helpResult.exitCode)
  console.error('     stderr:', helpResult.stderr)
  process.exit(1)
}
const helpOutput = helpResult.stdout

// Check for expected sections in help output
const expectedTerms = ['agent', 'daemon', 'Usage', 'Options', 'Commands']
const missingTerms = expectedTerms.filter(term => !helpOutput.includes(term))
if (missingTerms.length > 0) {
  console.error('  ❌ junction --help missing expected terms:', missingTerms.join(', '))
  console.error('     output:', helpOutput)
  process.exit(1)
}
console.log('  ✅ junction --help shows commands')

console.log('\n✅ Phase 1: Foundation Tests PASSED')
