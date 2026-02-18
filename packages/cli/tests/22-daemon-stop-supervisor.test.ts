#!/usr/bin/env npx tsx

/**
 * Regression: `paseo daemon stop` must stop supervised dev daemons
 * without allowing daemon-runner to respawn a new worker process.
 */

import assert from 'node:assert'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $ } from 'zx'

$.verbose = false

const pollIntervalMs = 100

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

type PidLockState = {
  pid: number | null
}

async function readPidLockState(paseoHome: string): Promise<PidLockState> {
  const pidPath = join(paseoHome, 'paseo.pid')

  try {
    const content = await readFile(pidPath, 'utf-8')
    const parsed = JSON.parse(content) as { pid?: unknown }
    const pid = typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0
      ? parsed.pid
      : null
    return { pid }
  } catch {
    return { pid: null }
  }
}

function readProcessCommand(pid: number): string | null {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
  if (result.status !== 0 || result.error) {
    return null
  }
  const command = result.stdout.trim()
  return command.length > 0 ? command : null
}

type DaemonStatus = {
  status: string | null
  pid: number | null
}

async function readDaemonStatus(paseoHome: string): Promise<DaemonStatus> {
  const result =
    await $`PASEO_HOME=${paseoHome} npx paseo daemon status --home ${paseoHome} --json`.nothrow()
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

console.log('=== Daemon Stop (supervisor regression) ===\n')

const port = 10000 + Math.floor(Math.random() * 50000)
const paseoHome = await mkdtemp(join(tmpdir(), 'paseo-stop-supervisor-'))
const cliRoot = join(import.meta.dirname, '..')

let supervisorProcess: ChildProcess | null = null
let recentSupervisorLogs = ''

try {
  console.log('Test 1: start daemon-runner in dev mode with isolated PASEO_HOME')

  supervisorProcess = spawn('npx', ['tsx', '../server/scripts/daemon-runner.ts', '--dev'], {
    cwd: cliRoot,
    env: {
      ...process.env,
      PASEO_HOME: paseoHome,
      PASEO_LISTEN: `127.0.0.1:${port}`,
      PASEO_RELAY_ENABLED: 'false',
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
      const status = await readDaemonStatus(paseoHome)
      return status.status === 'running' && status.pid !== null && isProcessRunning(status.pid)
    },
    120000,
    'daemon did not become running in time'
  )

  const statusBeforeStop = await readDaemonStatus(paseoHome)
  const daemonPid = statusBeforeStop.pid
  assert.strictEqual(statusBeforeStop.status, 'running', 'daemon should be running before stop')
  assert(daemonPid !== null, 'daemon pid should exist once daemon starts')
  assert(isProcessRunning(daemonPid), 'daemon process should be running')
  const pidLockBeforeStop = await readPidLockState(paseoHome)
  assert.strictEqual(pidLockBeforeStop.pid, daemonPid, 'pid lock should match status pid')
  const command = readProcessCommand(daemonPid)
  assert(command !== null, 'pid lock pid should resolve to a running process command')
  assert(
    command.includes('daemon-runner.ts') || command.includes('daemon-runner.js'),
    `pid lock pid should be daemon-runner process, got: ${command}`
  )
  console.log(`✓ dev daemon started with daemon pid ${daemonPid}\n`)

  console.log('Test 2: `paseo daemon stop` should stop without respawn')
  const stopResult =
    await $`PASEO_HOME=${paseoHome} npx paseo daemon stop --home ${paseoHome} --json`.nothrow()
  assert.strictEqual(stopResult.exitCode, 0, `stop should succeed: ${stopResult.stderr}`)
  const stopJson = JSON.parse(stopResult.stdout) as { action?: unknown }
  assert.strictEqual(stopJson.action, 'stopped', 'stop should report stopped action')

  await waitFor(async () => {
    const status = await readDaemonStatus(paseoHome)
    return status.status === 'stopped'
  }, 15000, 'daemon status did not transition to stopped after stop')

  if (supervisorProcess.pid) {
    await waitFor(
      () => !isProcessRunning(supervisorProcess!.pid ?? -1),
      15000,
      'daemon-runner supervisor remained running after stop'
    )
  }

  await sleep(1000)

  const pidAfterStop = await readPidLockState(paseoHome)
  const respawned = pidAfterStop.pid !== null && isProcessRunning(pidAfterStop.pid)
  assert.strictEqual(
    respawned,
    false,
    `daemon respawned after stop (pid: ${pidAfterStop.pid ?? 'unknown'})`
  )

  const statusAfterStop = await readDaemonStatus(paseoHome)
  assert.strictEqual(statusAfterStop.status, 'stopped', 'daemon should remain stopped after stop command')
  console.log('✓ stop leaves supervised daemon stopped (no respawn)\n')
} finally {
  if (supervisorProcess?.pid && isProcessRunning(supervisorProcess.pid)) {
    supervisorProcess.kill('SIGTERM')
    await waitFor(() => !isProcessRunning(supervisorProcess!.pid ?? -1), 5000, 'supervisor cleanup timed out').catch(
      () => {
        supervisorProcess?.kill('SIGKILL')
      }
    )
  }

  await $`PASEO_HOME=${paseoHome} npx paseo daemon stop --home ${paseoHome} --force`.nothrow()
  await rm(paseoHome, { recursive: true, force: true })
}

if (recentSupervisorLogs.trim().length === 0) {
  // Keep output stable while still surfacing that logs were captured when needed.
  console.log('(no supervisor logs captured)')
}

console.log('=== Supervisor stop regression test passed ===')
