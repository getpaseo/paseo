#!/usr/bin/env npx tsx

/**
 * Regression: unsupervised restart request should gracefully stop and exit 0,
 * so an external owner can decide whether to respawn.
 */

import assert from 'node:assert'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $ } from 'zx'
import { tryConnectToDaemon } from '../src/utils/client.ts'
import { getAvailablePort } from './helpers/network.ts'

$.verbose = false

const pollIntervalMs = 100
const testEnv = {
  JUNCTION_LOCAL_SPEECH_AUTO_DOWNLOAD: process.env.JUNCTION_LOCAL_SPEECH_AUTO_DOWNLOAD ?? '0',
  JUNCTION_DICTATION_ENABLED: process.env.JUNCTION_DICTATION_ENABLED ?? '0',
  JUNCTION_VOICE_MODE_ENABLED: process.env.JUNCTION_VOICE_MODE_ENABLED ?? '0',
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }

  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

type DaemonStatus = {
  status: string | null
  pid: number | null
}

async function readDaemonStatus(junctionHome: string): Promise<DaemonStatus> {
  const result =
    await $`JUNCTION_HOME=${junctionHome} JUNCTION_LOCAL_SPEECH_AUTO_DOWNLOAD=${testEnv.JUNCTION_LOCAL_SPEECH_AUTO_DOWNLOAD} JUNCTION_DICTATION_ENABLED=${testEnv.JUNCTION_DICTATION_ENABLED} JUNCTION_VOICE_MODE_ENABLED=${testEnv.JUNCTION_VOICE_MODE_ENABLED} npx junction daemon status --home ${junctionHome} --json`.nothrow()
  if (result.exitCode !== 0) {
    return { status: null, pid: null }
  }

  try {
    const parsed = JSON.parse(result.stdout) as { status?: unknown; pid?: unknown }
    const status = typeof parsed.status === 'string' ? parsed.status : null
    const pid = typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0
      ? parsed.pid
      : null
    return { status, pid }
  } catch {
    return { status: null, pid: null }
  }
}

async function waitFor(
  check: () => Promise<boolean> | boolean,
  timeoutMs: number,
  message: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (await check()) {
      return
    }
    await sleep(pollIntervalMs)
  }

  throw new Error(message)
}

type ExitResult = {
  code: number | null
  signal: NodeJS.Signals | null
}

function waitForProcessExit(processRef: ChildProcess, timeoutMs: number): Promise<ExitResult> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('timed out waiting for process exit'))
    }, timeoutMs)

    processRef.once('exit', (code, signal) => {
      clearTimeout(timeout)
      resolve({ code, signal })
    })
  })
}

async function readPidLockPid(junctionHome: string): Promise<number | null> {
  const pidPath = join(junctionHome, 'junction.pid')
  try {
    const content = await readFile(pidPath, 'utf-8')
    const parsed = JSON.parse(content) as { pid?: unknown }
    if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
      return null
    }
    return parsed.pid
  } catch {
    return null
  }
}

console.log('=== Daemon Restart (unsupervised regression) ===\n')

const port = await getAvailablePort()
const junctionHome = await mkdtemp(join(tmpdir(), 'junction-restart-unsupervised-'))
const cliRoot = join(import.meta.dirname, '..')
const host = `127.0.0.1:${port}`

let daemonProcess: ChildProcess | null = null

try {
  console.log('Test 1: start unsupervised daemon worker directly')

  daemonProcess = spawn(
    process.execPath,
    [...process.execArgv, '--import', 'tsx', '../server/src/server/index.ts'],
    {
    cwd: cliRoot,
    env: {
      ...process.env,
      ...testEnv,
      // This test validates direct unsupervised worker ownership semantics.
      // Agent-orchestrated shells may export JUNCTION_PID_LOCK_MODE=external,
      // which would delegate lock ownership away from this process and make
      // daemon status checks fail to observe a running owner PID.
      JUNCTION_PID_LOCK_MODE: 'self',
      JUNCTION_HOME: junctionHome,
      JUNCTION_LISTEN: host,
      JUNCTION_RELAY_ENABLED: 'false',
      CI: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    }
  )

  await waitFor(
    async () => {
      const status = await readDaemonStatus(junctionHome)
      return status.status === 'running' && status.pid !== null && isProcessRunning(status.pid)
    },
    120000,
    'daemon did not become running in time'
  )

  const statusBeforeRestart = await readDaemonStatus(junctionHome)
  assert.strictEqual(statusBeforeRestart.status, 'running', 'daemon should be running before restart')
  assert(daemonProcess.pid, 'unsupervised daemon process pid should exist')
  assert.strictEqual(statusBeforeRestart.pid, daemonProcess.pid, 'status pid should match daemon process pid')
  const lockPid = await readPidLockPid(junctionHome)
  assert.strictEqual(lockPid, daemonProcess.pid, 'unsupervised worker should own pid lock')
  console.log(`✓ unsupervised daemon started with pid ${daemonProcess.pid}\n`)

  console.log('Test 2: restart request should gracefully stop and exit code 0')
  const client = await tryConnectToDaemon({ host, timeout: 5000 })
  assert(client, 'daemon client should connect')

  const exitPromise = waitForProcessExit(daemonProcess, 30000)
  try {
    const restartAck = await client.restartServer('settings_update')
    assert.strictEqual(restartAck.status, 'restart_requested', 'restart request should be acknowledged')
  } finally {
    await client?.close().catch(() => undefined)
  }

  const exit = await exitPromise
  assert.strictEqual(exit.signal, null, `daemon should exit cleanly, got signal=${exit.signal}`)
  assert.strictEqual(exit.code, 0, `daemon should exit with status 0, got code=${exit.code}`)

  await waitFor(async () => {
    const status = await readDaemonStatus(junctionHome)
    return status.status === 'stopped'
  }, 15000, 'daemon status did not transition to stopped after unsupervised restart request')

  console.log('✓ unsupervised restart exited cleanly with code 0\n')
} finally {
  if (daemonProcess?.pid && isProcessRunning(daemonProcess.pid)) {
    daemonProcess.kill('SIGTERM')
    await waitFor(() => !isProcessRunning(daemonProcess!.pid ?? -1), 5000, 'daemon cleanup timed out').catch(
      () => {
        daemonProcess?.kill('SIGKILL')
      }
    )
  }

  await rm(junctionHome, { recursive: true, force: true })
}

console.log('=== Unsupervised restart regression test passed ===')
