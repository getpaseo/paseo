#!/usr/bin/env npx tsx

import assert from 'node:assert'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $ } from 'zx'

$.verbose = false

function randomPort(): number {
  return 10000 + Math.floor(Math.random() * 50000)
}

console.log('=== Onboarding Command ===\n')

const paseoHome = await mkdtemp(join(tmpdir(), 'paseo-onboard-home-'))
const port = randomPort()

try {
  console.log('Test 1: `paseo` runs blocking onboarding and prints pairing info')
  const onboard =
    await $`PASEO_HOME=${paseoHome} PASEO_LISTEN=127.0.0.1:${port} PASEO_PAIRING_QR=0 npm run -s cli --`.nothrow()

  assert.strictEqual(onboard.exitCode, 0, `onboard should succeed: ${onboard.stderr}`)
  assert(onboard.stdout.includes('Scan to pair'), 'onboard output should include scan header')
  assert(onboard.stdout.includes('Pairing link'), 'onboard output should include pairing link header')
  assert(onboard.stdout.includes('#offer='), 'onboard output should include pairing offer URL')
  assert(onboard.stdout.includes('CLI quick reference'), 'onboard output should include CLI quick reference')
  assert(onboard.stdout.includes('paseo --help'), 'onboard output should include --help shortcut')
  assert(onboard.stdout.includes('paseo ls'), 'onboard output should include ls shortcut')
  assert(onboard.stdout.includes('paseo run "your prompt"'), 'onboard output should include run shortcut')
  assert(onboard.stdout.includes('paseo status'), 'onboard output should include status shortcut')
  assert(onboard.stdout.includes(join(paseoHome, 'daemon.log')), 'onboard output should include daemon log path')

  const status =
    await $`PASEO_HOME=${paseoHome} npm run -s cli -- daemon status --home ${paseoHome}`.nothrow()
  assert.strictEqual(status.exitCode, 0, `daemon status should succeed: ${status.stderr}`)
  assert(status.stdout.includes('running'), 'daemon should be running when onboarding exits')
  console.log('✓ onboarding prints pairing info and waits for daemon readiness\n')

  console.log('Test 2: non-interactive onboarding persists voice disabled config')
  const configRaw = await readFile(join(paseoHome, 'config.json'), 'utf-8')
  const config = JSON.parse(configRaw) as {
    features?: {
      dictation?: { enabled?: boolean }
      voiceMode?: { enabled?: boolean }
    }
    providers?: {
      local?: { autoDownload?: boolean }
    }
  }

  assert.strictEqual(config.features?.dictation?.enabled, false, 'dictation.enabled should be false')
  assert.strictEqual(config.features?.voiceMode?.enabled, false, 'voiceMode.enabled should be false')
  assert.strictEqual(config.providers?.local?.autoDownload, false, 'local.autoDownload should be false')
  const daemonLog = await readFile(join(paseoHome, 'daemon.log'), 'utf-8')
  assert(
    !daemonLog.includes('Ensuring local speech models'),
    'daemon should not attempt local speech model setup when voice is disabled'
  )
  console.log('✓ non-interactive run persisted voice disabled choices\n')
} finally {
  await $`PASEO_HOME=${paseoHome} npm run -s cli -- daemon stop --home ${paseoHome} --force`.nothrow()
  await rm(paseoHome, { recursive: true, force: true })
}

console.log('=== Onboarding tests passed ===')
