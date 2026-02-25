#!/usr/bin/env npx tsx

/**
 * Regression: a single SIGINT sent to a supervised daemon-runner must allow
 * graceful daemon lifecycle shutdown to complete (no early forced exit path).
 */

import assert from 'node:assert'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $ } from 'zx'
import { getAvailablePort } from './helpers/network.ts'

$.verbose = false

const pollIntervalMs = 100
const testEnv = {
  PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD: process.env.PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD ?? '0',
  PASEO_DICTATION_ENABLED: process.env.PASEO_DICTATION_ENABLED ?? '0',
  PASEO_VOICE_MODE_ENABLED: process.env.PASEO_VOICE_MODE_ENABLED ?? '0',
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

function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }

  if (process.platform === 'win32') {
    try {
      process.kill(pid, signal)
      return true
    } catch {
      return false
    }
  }

  try {
    process.kill(-pid, signal)
    return true
  } catch {
    return false
  }
}

type DaemonStatus = {
  status: string | null
  pid: number | null
}

async function readDaemonStatus(paseoHome: string): Promise<DaemonStatus> {
  const result =
    await $`PASEO_HOME=${paseoHome} PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD=${testEnv.PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD} PASEO_DICTATION_ENABLED=${testEnv.PASEO_DICTATION_ENABLED} PASEO_VOICE_MODE_ENABLED=${testEnv.PASEO_VOICE_MODE_ENABLED} npx paseo daemon status --home ${paseoHome} --json`.nothrow()
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

console.log('=== Daemon SIGINT (supervisor regression) ===\n')

const port = await getAvailablePort()
const paseoHome = await mkdtemp(join(tmpdir(), 'paseo-sigint-supervisor-'))
const cliRoot = join(import.meta.dirname, '..')

let supervisorProcess: ChildProcess | null = null
let recentSupervisorLogs = ''

try {
  console.log('Test 1: start daemon-runner in dev mode with isolated PASEO_HOME')

  supervisorProcess = spawn('npx', ['tsx', '../server/scripts/daemon-runner.ts', '--dev'], {
    cwd: cliRoot,
    env: {
      ...process.env,
      ...testEnv,
      PASEO_HOME: paseoHome,
      PASEO_LISTEN: `127.0.0.1:${port}`,
      PASEO_RELAY_ENABLED: 'false',
      CI: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })

  supervisorProcess.stdout?.on('data', (chunk) => {
    recentSupervisorLogs = (recentSupervisorLogs + chunk.toString()).slice(-8000)
  })
  supervisorProcess.stderr?.on('data', (chunk) => {
    recentSupervisorLogs = (recentSupervisorLogs + chunk.toString()).slice(-8000)
  })

  await waitFor(
    async () => {
      const status = await readDaemonStatus(paseoHome)
      return status.status === 'running' && status.pid !== null && isProcessRunning(status.pid)
    },
    120000,
    'daemon did not become running in time'
  )

  console.log('✓ supervised daemon started\n')

  console.log('Test 2: single SIGINT should shutdown gracefully without forced exit')
  const exitPromise = waitForProcessExit(supervisorProcess, 30000)
  const signaledGroup = signalProcessGroup(supervisorProcess.pid ?? -1, 'SIGINT')
  if (!signaledGroup) {
    supervisorProcess.kill('SIGINT')
  }

  const exit = await exitPromise
  assert.strictEqual(exit.signal, null, `supervisor should exit cleanly, got signal=${exit.signal}`)
  assert.strictEqual(exit.code, 0, `supervisor should exit with status 0, got code=${exit.code}`)

  await waitFor(async () => {
    const status = await readDaemonStatus(paseoHome)
    return status.status === 'stopped'
  }, 15000, 'daemon status did not transition to stopped after SIGINT')

  assert(
    !recentSupervisorLogs.includes('Forcing exit...'),
    `worker entered forced-exit path during single SIGINT:\n${recentSupervisorLogs}`
  )
  assert(
    !recentSupervisorLogs.includes("Forcing shutdown - HTTP server didn't close in time"),
    `worker hit shutdown timeout during single SIGINT:\n${recentSupervisorLogs}`
  )

  console.log('✓ single SIGINT completed graceful shutdown without forced exit\n')
} finally {
  if (supervisorProcess?.pid && isProcessRunning(supervisorProcess.pid)) {
    const signaledGroup = signalProcessGroup(supervisorProcess.pid, 'SIGTERM')
    if (!signaledGroup) {
      supervisorProcess.kill('SIGTERM')
    }
    await waitFor(() => !isProcessRunning(supervisorProcess!.pid ?? -1), 5000, 'supervisor cleanup timed out').catch(
      () => {
        const killedGroup = signalProcessGroup(supervisorProcess!.pid ?? -1, 'SIGKILL')
        if (!killedGroup) {
          supervisorProcess?.kill('SIGKILL')
        }
      }
    )
  }

  await $`PASEO_HOME=${paseoHome} PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD=${testEnv.PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD} PASEO_DICTATION_ENABLED=${testEnv.PASEO_DICTATION_ENABLED} PASEO_VOICE_MODE_ENABLED=${testEnv.PASEO_VOICE_MODE_ENABLED} npx paseo daemon stop --home ${paseoHome} --force`.nothrow()
  await rm(paseoHome, { recursive: true, force: true })
}

if (recentSupervisorLogs.trim().length === 0) {
  console.log('(no supervisor logs captured)')
}

console.log('=== Supervisor SIGINT regression test passed ===')
