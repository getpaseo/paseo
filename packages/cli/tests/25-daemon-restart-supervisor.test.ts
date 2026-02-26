#!/usr/bin/env npx tsx

/**
 * Regression: app-style restart requests must trigger supervised worker restart
 * (worker PID changes) while keeping the daemon healthy.
 */

import assert from 'node:assert'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
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

function readWorkerPid(supervisorPid: number): number | null {
  if (!Number.isInteger(supervisorPid) || supervisorPid <= 0) {
    return null
  }

  const result = spawnSync('ps', ['ax', '-o', 'pid=,ppid='], { encoding: 'utf8' })
  if (result.status !== 0 || result.error) {
    return null
  }

  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }
    const [pidToken, ppidToken] = trimmed.split(/\s+/)
    const pid = Number.parseInt(pidToken ?? '', 10)
    const ppid = Number.parseInt(ppidToken ?? '', 10)
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) {
      continue
    }
    if (ppid === supervisorPid && pid > 0) {
      return pid
    }
  }

  return null
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

console.log('=== Daemon Restart (supervisor regression) ===\n')

const port = await getAvailablePort()
const junctionHome = await mkdtemp(join(tmpdir(), 'junction-restart-supervisor-'))
const cliRoot = join(import.meta.dirname, '..')
const host = `127.0.0.1:${port}`

let supervisorProcess: ChildProcess | null = null
let recentSupervisorLogs = ''

try {
  console.log('Test 1: start daemon-runner in dev mode with isolated JUNCTION_HOME')

  supervisorProcess = spawn('npx', ['tsx', '../server/scripts/daemon-runner.ts', '--dev'], {
    cwd: cliRoot,
    env: {
      ...process.env,
      ...testEnv,
      JUNCTION_HOME: junctionHome,
      JUNCTION_LISTEN: host,
      JUNCTION_RELAY_ENABLED: 'false',
      CI: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  supervisorProcess.stdout?.on('data', (chunk) => {
    recentSupervisorLogs = (recentSupervisorLogs + chunk.toString()).slice(-8000)
  })
  supervisorProcess.stderr?.on('data', (chunk) => {
    recentSupervisorLogs = (recentSupervisorLogs + chunk.toString()).slice(-8000)
  })

  await waitFor(
    async () => {
      const status = await readDaemonStatus(junctionHome)
      return status.status === 'running' && status.pid !== null && isProcessRunning(status.pid)
    },
    120000,
    'daemon did not become running in time'
  )

  const statusBeforeRestart = await readDaemonStatus(junctionHome)
  const supervisorPid = statusBeforeRestart.pid
  assert.strictEqual(statusBeforeRestart.status, 'running', 'daemon should be running before restart')
  assert(supervisorPid !== null, 'supervisor pid should exist once daemon starts')
  assert(isProcessRunning(supervisorPid), 'supervisor process should be running')
  const workerPidBeforeRestart = readWorkerPid(supervisorPid)
  assert(workerPidBeforeRestart !== null, 'supervisor should have a worker process before restart')
  assert(isProcessRunning(workerPidBeforeRestart), 'worker process should be running before restart')
  console.log(`✓ daemon running with supervisor ${supervisorPid} and worker ${workerPidBeforeRestart}\n`)

  console.log('Test 2: app-style restart request should restart worker and keep daemon healthy')
  const client = await tryConnectToDaemon({ host, timeout: 5000 })
  assert(client, 'daemon client should connect')
  try {
    const restartAck = await client.restartServer('settings_update')
    assert.strictEqual(restartAck.status, 'restart_requested', 'restart request should be acknowledged')
  } finally {
    await client?.close().catch(() => undefined)
  }

  await waitFor(() => {
    const workerPid = readWorkerPid(supervisorPid)
    return workerPid !== null && workerPid !== workerPidBeforeRestart && isProcessRunning(workerPid)
  }, 20000, 'worker pid did not change after restart request')

  const workerPidAfterRestart = readWorkerPid(supervisorPid)
  assert(workerPidAfterRestart !== null, 'worker process should exist after restart')
  assert.notStrictEqual(
    workerPidAfterRestart,
    workerPidBeforeRestart,
    'worker pid should change after restart'
  )

  const statusAfterRestart = await readDaemonStatus(junctionHome)
  assert.strictEqual(statusAfterRestart.status, 'running', 'daemon should stay running after restart')
  assert.strictEqual(statusAfterRestart.pid, supervisorPid, 'supervisor pid should remain stable across restart')
  assert(
    recentSupervisorLogs.includes('Restart requested by worker. Stopping worker for restart...'),
    `restart should route through supervisor restart intent, logs:\n${recentSupervisorLogs}`
  )
  console.log('✓ app-style restart keeps daemon healthy and restarts worker\n')
} finally {
  if (supervisorProcess?.pid && isProcessRunning(supervisorProcess.pid)) {
    supervisorProcess.kill('SIGTERM')
    await waitFor(() => !isProcessRunning(supervisorProcess!.pid ?? -1), 5000, 'supervisor cleanup timed out').catch(
      () => {
        supervisorProcess?.kill('SIGKILL')
      }
    )
  }

  await $`JUNCTION_HOME=${junctionHome} JUNCTION_LOCAL_SPEECH_AUTO_DOWNLOAD=${testEnv.JUNCTION_LOCAL_SPEECH_AUTO_DOWNLOAD} JUNCTION_DICTATION_ENABLED=${testEnv.JUNCTION_DICTATION_ENABLED} JUNCTION_VOICE_MODE_ENABLED=${testEnv.JUNCTION_VOICE_MODE_ENABLED} npx junction daemon stop --home ${junctionHome} --force`.nothrow()
  await rm(junctionHome, { recursive: true, force: true })
}

if (recentSupervisorLogs.trim().length === 0) {
  console.log('(no supervisor logs captured)')
}

console.log('=== Supervisor restart regression test passed ===')
