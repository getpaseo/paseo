#!/usr/bin/env npx zx

/**
 * Test runner for Paseo CLI E2E tests
 *
 * Runs all test phases in sequence and reports results.
 * Each test is a separate .ts file that can also be run independently.
 */

import { $ } from 'zx'
import { readdir, writeFile } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const testEnvDefaults = {
  PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD: process.env.PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD ?? '0',
  PASEO_DICTATION_ENABLED: process.env.PASEO_DICTATION_ENABLED ?? '0',
  PASEO_VOICE_MODE_ENABLED: process.env.PASEO_VOICE_MODE_ENABLED ?? '0',
}

let jsonOutputPath: string | null = null
for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '--json-output') {
    const value = args[i + 1]
    if (!value) {
      throw new Error('--json-output requires a file path')
    }
    jsonOutputPath = value
    i++
    continue
  }
}

$.verbose = false

console.log('🧪 Paseo CLI E2E Test Runner\n')
console.log('='.repeat(50))

// Discover all test files
const files = await readdir(__dirname)
const testFiles = files
  .filter(f => f.match(/^\d{2}-.*\.test\.ts$/))
  .sort()

if (testFiles.length === 0) {
  console.log('❌ No test files found')
  if (jsonOutputPath) {
    await writeFile(
      jsonOutputPath,
      JSON.stringify(
        {
          suite: 'cli-local',
          command: 'npm run test:local --workspace=@getpaseo/cli',
          counts: {
            passed: 0,
            failed: 0,
            skipped: 0,
          },
          skippedTests: [],
          failures: [],
          error: 'No test files found',
        },
        null,
        2
      ) + '\n'
    )
  }
  process.exit(1)
}

console.log(`Found ${testFiles.length} test file(s):\n`)
for (const file of testFiles) {
  console.log(`  - ${file}`)
}
console.log()

let passed = 0
let failed = 0
const failures: { test: string; error: string }[] = []

for (const testFile of testFiles) {
  const testPath = join(__dirname, testFile)
  const testName = testFile.replace(/\.test\.ts$/, '')

  console.log(`\n${'─'.repeat(50)}`)
  console.log(`📋 Running ${testName}...`)
  console.log('─'.repeat(50))

  try {
    const result = await $`PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD=${testEnvDefaults.PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD} PASEO_DICTATION_ENABLED=${testEnvDefaults.PASEO_DICTATION_ENABLED} PASEO_VOICE_MODE_ENABLED=${testEnvDefaults.PASEO_VOICE_MODE_ENABLED} npx tsx ${testPath}`.nothrow()
    if (result.exitCode === 0) {
      console.log(`\n✅ ${testName} PASSED`)
      passed++
    } else {
      console.log(`\n❌ ${testName} FAILED (exit code: ${result.exitCode})`)
      if (result.stderr) {
        console.log('stderr:', result.stderr)
      }
      failed++
      failures.push({ test: testName, error: result.stderr || `Exit code: ${result.exitCode}` })
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    console.log(`\n❌ ${testName} FAILED`)
    console.log('Error:', error)
    failed++
    failures.push({ test: testName, error })
  }
}

// Summary
console.log('\n' + '='.repeat(50))
console.log('📊 Test Results')
console.log('='.repeat(50))
console.log(`  ✅ Passed: ${passed}`)
console.log(`  ❌ Failed: ${failed}`)
console.log(`  📝 Total:  ${passed + failed}`)

if (failures.length > 0) {
  console.log('\n❌ Failed tests:')
  for (const { test, error } of failures) {
    console.log(`  - ${test}`)
    if (error) {
      console.log(`    ${error.split('\n')[0]}`)
    }
  }
}

console.log()

if (jsonOutputPath) {
  await writeFile(
    jsonOutputPath,
    JSON.stringify(
      {
        suite: 'cli-local',
        command: 'npm run test:local --workspace=@getpaseo/cli',
        counts: {
          passed,
          failed,
          skipped: 0,
        },
        skippedTests: [],
        failures: failures.map(({ test, error }) => ({
          test,
          error: error.split('\n')[0] ?? '',
        })),
      },
      null,
      2
    ) + '\n'
  )
}

process.exit(failed > 0 ? 1 : 0)
