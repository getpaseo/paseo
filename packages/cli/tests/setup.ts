/**
 * Test setup utilities for Paseo CLI E2E tests
 *
 * Critical rules from design doc:
 * 1. Port: Random port via 10000 + Math.floor(Math.random() * 50000) - NEVER 6767
 * 2. Protocol: WebSocket ONLY - daemon has no HTTP endpoints
 * 3. Temp dirs: Create temp directories for PASEO_HOME and agent --cwd
 * 4. Model: Always --provider claude with haiku model for agent tests
 * 5. Cleanup: Kill daemon and remove temp dirs after each test
 */

import { $, ProcessPromise, sleep } from 'zx'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const TEST_ENV_DEFAULTS = {
  PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD: process.env.PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD ?? '0',
  PASEO_DICTATION_ENABLED: process.env.PASEO_DICTATION_ENABLED ?? '0',
  PASEO_VOICE_MODE_ENABLED: process.env.PASEO_VOICE_MODE_ENABLED ?? '0',
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
  /** Temp directory for PASEO_HOME */
  paseoHome: string
  /** Temp directory for agent working directory */
  workDir: string
  /** Running daemon process */
  daemon: ProcessPromise | null
  /** Run a paseo CLI command against the test daemon */
  paseo: (args: string[]) => ProcessPromise
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
export async function createTempDirs(): Promise<{ paseoHome: string; workDir: string }> {
  const paseoHome = await mkdtemp(join(tmpdir(), 'paseo-test-home-'))
  const workDir = await mkdtemp(join(tmpdir(), 'paseo-test-work-'))
  return { paseoHome, workDir }
}

/**
 * Wait for daemon to be ready by testing WebSocket connection
 * Uses `paseo agent ls` which connects via WebSocket
 */
export async function waitForDaemon(port: number, timeout = 30000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try {
      const result = await $`PASEO_HOST=localhost:${port} paseo agent ls`.nothrow()
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
  paseoHome: string
): Promise<ProcessPromise> {
  $.verbose = false
  const daemon = $`PASEO_HOME=${paseoHome} PASEO_LISTEN=127.0.0.1:${port} PASEO_RELAY_ENABLED=false PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD=${TEST_ENV_DEFAULTS.PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD} PASEO_DICTATION_ENABLED=${TEST_ENV_DEFAULTS.PASEO_DICTATION_ENABLED} PASEO_VOICE_MODE_ENABLED=${TEST_ENV_DEFAULTS.PASEO_VOICE_MODE_ENABLED} CI=true paseo daemon start --foreground`.nothrow()
  return daemon
}

/**
 * Create a full test context with daemon, temp dirs, and helpers
 */
export async function createTestContext(): Promise<TestContext> {
  const port = getRandomPort()
  const { paseoHome, workDir } = await createTempDirs()

  // Helper to run CLI commands against test daemon
  const paseo = (args: string[]): ProcessPromise => {
    $.verbose = false
    return $`PASEO_HOST=localhost:${port} PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD=${TEST_ENV_DEFAULTS.PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD} PASEO_DICTATION_ENABLED=${TEST_ENV_DEFAULTS.PASEO_DICTATION_ENABLED} PASEO_VOICE_MODE_ENABLED=${TEST_ENV_DEFAULTS.PASEO_VOICE_MODE_ENABLED} paseo ${args}`.nothrow()
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
    await rm(paseoHome, { recursive: true, force: true })
    await rm(workDir, { recursive: true, force: true })
  }

  const ctx: TestContext = {
    port,
    paseoHome,
    workDir,
    daemon: null,
    paseo,
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
  ctx.daemon = await startDaemon(ctx.port, ctx.paseoHome)
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
