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
 * Uses `paseo agent ps` which connects via WebSocket
 */
export async function waitForDaemon(port: number, timeout = 30000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try {
      const result = await $`PASEO_HOST=localhost:${port} paseo agent ps`.nothrow()
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
  const daemon = $`PASEO_HOME=${paseoHome} PASEO_PORT=${port} paseo daemon start --foreground`.nothrow()
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
    return $`PASEO_HOST=localhost:${port} paseo ${args}`.nothrow()
  }

  // Cleanup function
  const cleanup = async (): Promise<void> => {
    if (ctx.daemon) {
      ctx.daemon.kill()
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
