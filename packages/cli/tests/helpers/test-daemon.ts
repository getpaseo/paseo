/**
 * Test Daemon Helper
 *
 * Provides utilities for launching real Paseo daemons in E2E tests.
 * Each test gets an isolated daemon on an available local port with its own PASEO_HOME.
 *
 * CRITICAL RULES (from design doc):
 * 1. Port: Use an available ephemeral local port - NEVER use 6767 (production)
 * 2. Protocol: WebSocket ONLY - daemon has no HTTP endpoints
 * 3. Temp dirs: Create temp directories for PASEO_HOME and agent --cwd
 * 4. Model: Always use claude provider with haiku model for fast, cheap tests
 * 5. Cleanup: Kill daemon and remove temp dirs after each test
 */

import { mkdtemp, rm, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ChildProcess, spawn } from 'child_process'
import { getAvailablePort } from './network.ts'

export interface TestDaemonContext {
  /** Available local port for test daemon (never 6767) */
  port: number
  /** WebSocket URL for connecting to daemon */
  wsUrl: string
  /** Temp directory for PASEO_HOME */
  paseoHome: string
  /** Temp directory for agent working directory */
  workDir: string
  /** Running daemon process */
  process: ChildProcess | null
  /** Whether the daemon is ready to accept connections */
  isReady: boolean
  /** Stop the daemon and clean up resources */
  stop: () => Promise<void>
}

const TEST_DAEMON_ENV_DEFAULTS: Record<string, string> = {
  PASEO_RELAY_ENABLED: 'false',
  PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD: process.env.PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD ?? '0',
  PASEO_DICTATION_ENABLED: process.env.PASEO_DICTATION_ENABLED ?? '0',
  PASEO_VOICE_MODE_ENABLED: process.env.PASEO_VOICE_MODE_ENABLED ?? '0',
}
const TEST_DAEMON_HOST = '127.0.0.1'

const DEFAULT_OUTPUT_CAPTURE_LIMIT = 256 * 1024
const TEST_OUTPUT_CAPTURE_LIMIT = Number.parseInt(
  process.env.PASEO_TEST_OUTPUT_CAPTURE_BYTES ?? `${DEFAULT_OUTPUT_CAPTURE_LIMIT}`,
  10
)

type OutputCapture = {
  value: string
  truncated: boolean
}

function createOutputCapture(): OutputCapture {
  return { value: '', truncated: false }
}

function appendOutputCapture(target: OutputCapture, chunk: Buffer): void {
  const next = target.value + chunk.toString()
  if (next.length <= TEST_OUTPUT_CAPTURE_LIMIT) {
    target.value = next
    return
  }
  target.truncated = true
  target.value = next.slice(next.length - TEST_OUTPUT_CAPTURE_LIMIT)
}

function formatOutputCapture(target: OutputCapture): string {
  if (!target.truncated) {
    return target.value
  }
  return `[truncated; showing last ${TEST_OUTPUT_CAPTURE_LIMIT} chars]\n${target.value}`
}

function readNodeErrnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined
  }
  return typeof (error as { code?: unknown }).code === 'string'
    ? ((error as { code: string }).code)
    : undefined
}

function signalProcessTree(pid: number, signal: NodeJS.Signals): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }

  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal)
      return true
    } catch (error) {
      const code = readNodeErrnoCode(error)
      if (code === 'ESRCH') {
        return false
      }
    }
  }

  try {
    process.kill(pid, signal)
    return true
  } catch (error) {
    const code = readNodeErrnoCode(error)
    if (code === 'ESRCH') {
      return false
    }
    throw error
  }
}

async function terminateProcessTree(processRef: ChildProcess, timeoutMs: number): Promise<void> {
  const pid = processRef.pid
  if (!Number.isInteger(pid) || pid <= 0) {
    return
  }
  if (processRef.exitCode !== null || processRef.signalCode !== null) {
    return
  }

  signalProcessTree(pid, 'SIGTERM')

  await new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeoutId)
      resolve()
    }

    const timeoutId = setTimeout(() => {
      signalProcessTree(pid, 'SIGKILL')
      finish()
    }, timeoutMs)

    processRef.once('exit', () => {
      finish()
    })
  })
}

/**
 * Generate a random port for test daemon
 * Uses range 20000-30000 to avoid conflicts
 * NEVER uses 6767 (user's running daemon)
 */
export function getRandomPort(): number {
  return 20000 + Math.floor(Math.random() * 10000)
}

/**
 * Create isolated temp directories for testing
 */
export async function createTempDirs(): Promise<{ paseoHome: string; workDir: string }> {
  const paseoHome = await mkdtemp(join(tmpdir(), 'paseo-e2e-home-'))
  const workDir = await mkdtemp(join(tmpdir(), 'paseo-e2e-work-'))

  // Create the agents directory that the daemon expects
  const agentsDir = join(paseoHome, 'agents')
  await mkdir(agentsDir, { recursive: true })

  return { paseoHome, workDir }
}

/**
 * Wait for daemon to be ready by running `paseo agent ls`
 * This connects via WebSocket and ensures the daemon is responsive
 */
async function waitForDaemonReady(
  port: number,
  timeout = 30000
): Promise<void> {
  const start = Date.now()

  while (Date.now() - start < timeout) {
    try {
      const { exitCode } = await runPaseoCli(
        {
          port,
          wsUrl: `ws://${TEST_DAEMON_HOST}:${port}`,
          paseoHome: '',
          workDir: '',
          process: null,
          isReady: false,
          stop: async () => {}
        },
        ['agent', 'ls']
      )

      if (exitCode === 0) {
        return  // Daemon is ready
      }
    } catch {
      // Connection failed, keep trying
    }
    await sleep(100)
  }
  throw new Error(`Daemon failed to become ready on port ${port} within ${timeout}ms`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Start a test daemon programmatically using the server's bootstrap API
 *
 * This starts the daemon in a separate process using the CLI's daemon start command
 * with isolated PASEO_HOME and PASEO_LISTEN environment variables.
 */
export async function startTestDaemon(options?: {
  port?: number
  paseoHome?: string
  workDir?: string
  timeout?: number
}): Promise<TestDaemonContext> {
  const port = options?.port ?? await getAvailablePort()
  const { paseoHome, workDir } = options?.paseoHome && options?.workDir
    ? { paseoHome: options.paseoHome, workDir: options.workDir }
    : await createTempDirs()
  const timeout = options?.timeout ?? 30000

  const wsUrl = `ws://${TEST_DAEMON_HOST}:${port}`

  // Find the CLI entry point - use the source file directly with tsx
  const cliDir = join(import.meta.dirname, '..', '..')
  const cliSrcPath = join(cliDir, 'src', 'index.ts')

  // Start daemon process using tsx to run TypeScript directly
  const daemonProcess = spawn('npx', ['tsx', cliSrcPath, 'daemon', 'start', '--foreground'], {
    env: {
      ...process.env,
      ...TEST_DAEMON_ENV_DEFAULTS,
      PASEO_HOME: paseoHome,
      PASEO_LISTEN: `${TEST_DAEMON_HOST}:${port}`,
      // Force no TTY to prevent QR code output
      CI: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })

  const stdout = createOutputCapture()
  const stderr = createOutputCapture()

  daemonProcess.stdout?.on('data', (data) => {
    appendOutputCapture(stdout, data)
  })

  daemonProcess.stderr?.on('data', (data) => {
    appendOutputCapture(stderr, data)
  })

  const cleanup = async () => {
    if (daemonProcess) {
      await terminateProcessTree(daemonProcess, 5000)
    }

    // Clean up temp directories
    try {
      if (existsSync(paseoHome)) {
        await rm(paseoHome, { recursive: true, force: true })
      }
    } catch {
      // Ignore cleanup errors
    }

    try {
      if (existsSync(workDir)) {
        await rm(workDir, { recursive: true, force: true })
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  // Handle process errors
  daemonProcess.on('error', (err) => {
    console.error('Daemon process error:', err)
  })

  daemonProcess.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`Daemon process exited with code ${code}`)
      const stderrText = formatOutputCapture(stderr)
      if (stderrText) {
        console.error('Daemon stderr:', stderrText)
      }
    }
  })

  const ctx: TestDaemonContext = {
    port,
    wsUrl,
    paseoHome,
    workDir,
    process: daemonProcess,
    isReady: false,
    stop: cleanup,
  }

  // Wait for daemon to be ready
  try {
    await waitForDaemonReady(port, timeout)
    ctx.isReady = true
  } catch (err) {
    // Daemon failed to start - clean up and rethrow
    await cleanup()
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(
      `Failed to start test daemon: ${message}\nStdout: ${formatOutputCapture(stdout)}\nStderr: ${formatOutputCapture(stderr)}`
    )
  }

  return ctx
}

/**
 * Run a paseo CLI command against a test daemon
 *
 * This is a helper that sets the correct environment variables
 * to point at the test daemon.
 */
export async function runPaseoCli(
  ctx: TestDaemonContext,
  args: string[],
  options?: {
    timeout?: number
    cwd?: string
  }
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const timeout = options?.timeout ?? 60000
  const cwd = options?.cwd ?? ctx.workDir

  const cliDir = join(import.meta.dirname, '..', '..')
  const cliSrcPath = join(cliDir, 'src', 'index.ts')

  return new Promise((resolve, reject) => {
    const proc = spawn('npx', ['tsx', cliSrcPath, ...args], {
      env: {
        ...process.env,
        ...TEST_DAEMON_ENV_DEFAULTS,
        PASEO_HOST: `${TEST_DAEMON_HOST}:${ctx.port}`,
        PASEO_HOME: ctx.paseoHome,
      },
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })

    const stdout = createOutputCapture()
    const stderr = createOutputCapture()

    proc.stdout?.on('data', (data) => {
      appendOutputCapture(stdout, data)
    })

    proc.stderr?.on('data', (data) => {
      appendOutputCapture(stderr, data)
    })

    const timeoutId = setTimeout(() => {
      if (proc.pid) {
        signalProcessTree(proc.pid, 'SIGKILL')
      }
      reject(new Error(`CLI command timed out after ${timeout}ms: paseo ${args.join(' ')}`))
    }, timeout)

    proc.on('exit', (code) => {
      clearTimeout(timeoutId)
      resolve({
        exitCode: code ?? 1,
        stdout: formatOutputCapture(stdout),
        stderr: formatOutputCapture(stderr),
      })
    })

    proc.on('error', (err) => {
      clearTimeout(timeoutId)
      reject(err)
    })
  })
}

/**
 * Create a test context that includes a started daemon
 * and a helper to run CLI commands against it.
 *
 * This is the main entry point for E2E tests.
 */
export async function createE2ETestContext(options?: {
  timeout?: number
}): Promise<
  TestDaemonContext & {
    /** Run a paseo CLI command against this daemon */
    paseo: (args: string[], opts?: { timeout?: number; cwd?: string }) => Promise<{
      exitCode: number
      stdout: string
      stderr: string
    }>
  }
> {
  const ctx = await startTestDaemon({ timeout: options?.timeout })

  const paseo = (args: string[], opts?: { timeout?: number; cwd?: string }) =>
    runPaseoCli(ctx, args, opts)

  return {
    ...ctx,
    paseo,
  }
}
