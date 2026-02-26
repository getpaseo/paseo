/**
 * Test setup utilities for Junction CLI E2E tests
 *
 * Critical rules from design doc:
 * 1. Port: Random port via 10000 + Math.floor(Math.random() * 50000) - NEVER 6767
 * 2. Protocol: WebSocket ONLY - daemon has no HTTP endpoints
 * 3. Temp dirs: Create temp directories for JUNCTION_HOME and agent --cwd
 * 4. Model: Always --provider claude with haiku model for agent tests
 * 5. Cleanup: Kill daemon and remove temp dirs after each test
 */

import { $, ProcessPromise, sleep } from 'zx'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const TEST_ENV_DEFAULTS = {
  JUNCTION_LOCAL_SPEECH_AUTO_DOWNLOAD: process.env.JUNCTION_LOCAL_SPEECH_AUTO_DOWNLOAD ?? '0',
  JUNCTION_DICTATION_ENABLED: process.env.JUNCTION_DICTATION_ENABLED ?? '0',
  JUNCTION_VOICE_MODE_ENABLED: process.env.JUNCTION_VOICE_MODE_ENABLED ?? '0',
}

function killPidTree(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isInteger(pid) || pid <= 0) {
    return
  }

  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ESRCH') {
        return
      }
    }
  }

  try {
    process.kill(pid, signal)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ESRCH') {
      throw error
    }
  }
}

export interface TestContext {
  /** Random port for test daemon (never 6767) */
  port: number
  /** Temp directory for JUNCTION_HOME */
  junctionHome: string
  /** Temp directory for agent working directory */
  workDir: string
  /** Running daemon process */
  daemon: ProcessPromise | null
  /** Run a junction CLI command against the test daemon */
  junction: (args: string[]) => ProcessPromise
  /** Clean up all resources */
  cleanup: () => Promise<void>
}

/**
 * Generate a random port for test daemon
 * NEVER uses 6767 (user's running daemon)
 */
export function getRandomPort(): number {
  return 10000 + Math.floor(Math.random() * 50000)
}

/**
 * Create isolated temp directories for testing
 */
export async function createTempDirs(): Promise<{ junctionHome: string; workDir: string }> {
  const junctionHome = await mkdtemp(join(tmpdir(), 'junction-test-home-'))
  const workDir = await mkdtemp(join(tmpdir(), 'junction-test-work-'))
  return { junctionHome, workDir }
}

/**
 * Wait for daemon to be ready by testing WebSocket connection
 * Uses `junction agent ls` which connects via WebSocket
 */
export async function waitForDaemon(port: number, timeout = 30000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try {
      const result = await $`JUNCTION_HOST=localhost:${port} junction agent ls`.nothrow()
      if (result.exitCode === 0) return
    } catch {
      // Connection failed, keep trying
    }
    await sleep(100)
  }
  throw new Error(`Daemon failed to start on port ${port} within ${timeout}ms`)
}

/**
 * Start an isolated test daemon
 */
export async function startDaemon(
  port: number,
  junctionHome: string
): Promise<ProcessPromise> {
  $.verbose = false
  const daemon = $`JUNCTION_HOME=${junctionHome} JUNCTION_LISTEN=127.0.0.1:${port} JUNCTION_RELAY_ENABLED=false JUNCTION_LOCAL_SPEECH_AUTO_DOWNLOAD=${TEST_ENV_DEFAULTS.JUNCTION_LOCAL_SPEECH_AUTO_DOWNLOAD} JUNCTION_DICTATION_ENABLED=${TEST_ENV_DEFAULTS.JUNCTION_DICTATION_ENABLED} JUNCTION_VOICE_MODE_ENABLED=${TEST_ENV_DEFAULTS.JUNCTION_VOICE_MODE_ENABLED} CI=true junction daemon start --foreground`.nothrow()
  return daemon
}

/**
 * Create a full test context with daemon, temp dirs, and helpers
 */
export async function createTestContext(): Promise<TestContext> {
  const port = getRandomPort()
  const { junctionHome, workDir } = await createTempDirs()

  // Helper to run CLI commands against test daemon
  const junction = (args: string[]): ProcessPromise => {
    $.verbose = false
    return $`JUNCTION_HOST=localhost:${port} JUNCTION_LOCAL_SPEECH_AUTO_DOWNLOAD=${TEST_ENV_DEFAULTS.JUNCTION_LOCAL_SPEECH_AUTO_DOWNLOAD} JUNCTION_DICTATION_ENABLED=${TEST_ENV_DEFAULTS.JUNCTION_DICTATION_ENABLED} JUNCTION_VOICE_MODE_ENABLED=${TEST_ENV_DEFAULTS.JUNCTION_VOICE_MODE_ENABLED} junction ${args}`.nothrow()
  }

  // Cleanup function
  const cleanup = async (): Promise<void> => {
    if (ctx.daemon) {
      if (typeof ctx.daemon.pid === 'number') {
        killPidTree(ctx.daemon.pid, 'SIGTERM')
        await sleep(250)
        killPidTree(ctx.daemon.pid, 'SIGKILL')
      } else {
        ctx.daemon.kill()
      }
    }
    await rm(junctionHome, { recursive: true, force: true })
    await rm(workDir, { recursive: true, force: true })
  }

  const ctx: TestContext = {
    port,
    junctionHome,
    workDir,
    daemon: null,
    junction,
    cleanup,
  }

  return ctx
}

/**
 * Create a test context and start the daemon
 * Use this for tests that need a running daemon
 */
export async function createTestContextWithDaemon(): Promise<TestContext> {
  const ctx = await createTestContext()
  ctx.daemon = await startDaemon(ctx.port, ctx.junctionHome)
  await waitForDaemon(ctx.port)
  return ctx
}

/**
 * Register cleanup handlers for process exit
 */
export function registerCleanupHandlers(cleanup: () => Promise<void>): void {
  const handler = async () => {
    await cleanup()
    process.exit(0)
  }

  process.on('exit', () => {
    // Can't await in exit handler, but at least try to kill daemon
  })
  process.on('SIGINT', handler)
  process.on('SIGTERM', handler)
}
