import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { loadConfig, resolvePaseoHome } from '@getpaseo/server'

export interface DaemonStartOptions {
  port?: string
  listen?: string
  home?: string
  foreground?: boolean
  relay?: boolean
  mcp?: boolean
  allowedHosts?: string
}

export interface LocalDaemonPidInfo {
  pid: number
  startedAt?: string
  hostname?: string
  uid?: number
  sockPath?: string
}

export interface LocalDaemonState {
  home: string
  listen: string
  logPath: string
  pidPath: string
  pidInfo: LocalDaemonPidInfo | null
  running: boolean
  stalePidFile: boolean
}

export interface DetachedStartResult {
  pid: number | null
  logPath: string
}

export interface StopLocalDaemonOptions {
  home?: string
  timeoutMs?: number
  force?: boolean
}

export interface StopLocalDaemonResult {
  action: 'stopped' | 'not_running'
  home: string
  pid: number | null
  forced: boolean
  message: string
}

type ProcessExitDetails = {
  code: number | null
  signal: NodeJS.Signals | null
  error?: Error
}

type DetachedStartupResult =
  | { exitedEarly: false }
  | ({ exitedEarly: true } & ProcessExitDetails)

const DETACHED_STARTUP_GRACE_MS = 1200
const PID_POLL_INTERVAL_MS = 100
const KILL_TIMEOUT_MS = 3000
const DAEMON_LOG_FILENAME = 'daemon.log'
const DAEMON_PID_FILENAME = 'paseo.pid'

export const DEFAULT_STOP_TIMEOUT_MS = 15_000

const require = createRequire(import.meta.url)

const startupReady = (): DetachedStartupResult => ({ exitedEarly: false })

const startupExited = (details: ProcessExitDetails): DetachedStartupResult => ({
  exitedEarly: true,
  ...details,
})

function envWithHome(home?: string): NodeJS.ProcessEnv {
  if (!home) {
    return process.env
  }

  return { ...process.env, PASEO_HOME: home }
}

function buildRunnerArgs(options: DaemonStartOptions): string[] {
  const args: string[] = []
  if (options.relay === false) {
    args.push('--no-relay')
  }

  if (options.mcp === false) {
    args.push('--no-mcp')
  }

  return args
}

function resolveDaemonRunnerEntry(): string {
  const serverExportPath = require.resolve('@getpaseo/server')
  let currentDir = path.dirname(serverExportPath)

  while (true) {
    const packageJsonPath = path.join(currentDir, 'package.json')
    if (existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { name?: string }
        if (packageJson.name === '@getpaseo/server') {
          const distRunner = path.join(currentDir, 'dist', 'scripts', 'daemon-runner.js')
          if (existsSync(distRunner)) {
            return distRunner
          }
          return path.join(currentDir, 'scripts', 'daemon-runner.ts')
        }
      } catch {
        // Continue searching up if package.json exists but is invalid.
      }
    }

    const parentDir = path.dirname(currentDir)
    if (parentDir === currentDir) {
      break
    }
    currentDir = parentDir
  }

  throw new Error('Unable to resolve @getpaseo/server package root for daemon runner')
}

function pidFilePath(paseoHome: string): string {
  return path.join(paseoHome, DAEMON_PID_FILENAME)
}

function readPidFile(pidPath: string): LocalDaemonPidInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(pidPath, 'utf-8')) as Record<string, unknown>
    const pidValue = parsed.pid
    if (typeof pidValue !== 'number' || !Number.isInteger(pidValue) || pidValue <= 0) {
      return null
    }

    return {
      pid: pidValue,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : undefined,
      hostname: typeof parsed.hostname === 'string' ? parsed.hostname : undefined,
      uid: typeof parsed.uid === 'number' ? parsed.uid : undefined,
      sockPath: typeof parsed.sockPath === 'string' ? parsed.sockPath : undefined,
    }
  } catch {
    return null
  }
}

function tailFile(filePath: string, lines = 30): string | null {
  try {
    const content = readFileSync(filePath, 'utf-8')
    return content.split('\n').filter(Boolean).slice(-lines).join('\n')
  } catch {
    return null
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function readNodeErrnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined
  }

  return typeof error.code === 'string' ? error.code : undefined
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = readNodeErrnoCode(err)
    if (code === 'EPERM') {
      return true
    }
    return false
  }
}

function signalProcess(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal)
    return true
  } catch (err) {
    const code = readNodeErrnoCode(err)
    if (code === 'ESRCH') {
      return false
    }
    throw err
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      return true
    }
    await sleep(PID_POLL_INTERVAL_MS)
  }

  return !isProcessRunning(pid)
}

export function resolveLocalPaseoHome(home?: string): string {
  return resolvePaseoHome(envWithHome(home))
}

export function resolveTcpHostFromListen(listen: string): string | null {
  const normalized = listen.trim()
  if (!normalized) {
    return null
  }

  if (normalized.startsWith('/') || normalized.startsWith('unix://')) {
    return null
  }

  if (/^\d+$/.test(normalized)) {
    return `127.0.0.1:${normalized}`
  }

  if (normalized.includes(':')) {
    return normalized
  }

  return null
}

export function resolveLocalDaemonState(options: { home?: string } = {}): LocalDaemonState {
  const env: NodeJS.ProcessEnv = {
    ...envWithHome(options.home),
    // Status should reflect local persisted config + pid file, not inherited daemon env overrides.
    PASEO_LISTEN: undefined,
    PASEO_ALLOWED_HOSTS: undefined,
  }
  const home = resolvePaseoHome(env)
  const config = loadConfig(home, { env })
  const pidPath = pidFilePath(home)
  const logPath = path.join(home, DAEMON_LOG_FILENAME)
  const pidInfo = existsSync(pidPath) ? readPidFile(pidPath) : null
  const running = pidInfo ? isProcessRunning(pidInfo.pid) : false
  const listen = pidInfo?.sockPath ?? config.listen

  return {
    home,
    listen,
    logPath,
    pidPath,
    pidInfo,
    running,
    stalePidFile: Boolean(pidInfo) && !running,
  }
}

export function tailDaemonLog(home?: string, lines = 30): string | null {
  const logPath = path.join(resolveLocalPaseoHome(home), DAEMON_LOG_FILENAME)
  return tailFile(logPath, lines)
}

export async function startLocalDaemonDetached(
  options: DaemonStartOptions
): Promise<DetachedStartResult> {
  if (options.listen && options.port) {
    throw new Error('Cannot use --listen and --port together')
  }

  const childEnv: NodeJS.ProcessEnv = { ...process.env }
  if (options.home) {
    childEnv.PASEO_HOME = options.home
  }
  if (options.listen) {
    childEnv.PASEO_LISTEN = options.listen
  } else if (options.port) {
    childEnv.PASEO_LISTEN = `127.0.0.1:${options.port}`
  }
  if (options.allowedHosts) {
    childEnv.PASEO_ALLOWED_HOSTS = options.allowedHosts
  }

  const paseoHome = resolvePaseoHome(childEnv)
  const logPath = path.join(paseoHome, DAEMON_LOG_FILENAME)
  const daemonRunnerEntry = resolveDaemonRunnerEntry()
  const logFd = openSync(logPath, 'a')

  try {
    const child = spawn(
      process.execPath,
      [...process.execArgv, daemonRunnerEntry, ...buildRunnerArgs(options)],
      {
        detached: true,
        env: childEnv,
        stdio: ['ignore', logFd, logFd],
      }
    )

    child.unref()

    const startup = await new Promise<DetachedStartupResult>((resolve) => {
      let settled = false

      const finish = (value: DetachedStartupResult) => {
        if (settled) return
        settled = true
        resolve(value)
      }

      const timer = setTimeout(() => finish(startupReady()), DETACHED_STARTUP_GRACE_MS)

      child.once('error', (error) => {
        clearTimeout(timer)
        finish(startupExited({ code: null, signal: null, error }))
      })

      child.once('exit', (code, signal) => {
        clearTimeout(timer)
        finish(startupExited({ code, signal }))
      })
    })

    if (startup.exitedEarly) {
      const reason = startup.error
        ? startup.error.message
        : `exit code ${startup.code ?? 'unknown'}${startup.signal ? ` (${startup.signal})` : ''}`
      const recentLogs = tailFile(logPath)
      throw new Error(
        [
          `Daemon failed to start in background (${reason}).`,
          recentLogs ? `Recent daemon logs:\n${recentLogs}` : null,
        ]
          .filter(Boolean)
          .join('\n\n')
      )
    }

    return {
      pid: child.pid ?? null,
      logPath,
    }
  } finally {
    closeSync(logFd)
  }
}

export async function stopLocalDaemon(
  options: StopLocalDaemonOptions = {}
): Promise<StopLocalDaemonResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS
  const state = resolveLocalDaemonState({ home: options.home })

  if (!state.pidInfo || !state.running) {
    const staleSuffix =
      state.stalePidFile && state.pidInfo
        ? ` (stale PID file for ${state.pidInfo.pid})`
        : ''
    return {
      action: 'not_running',
      home: state.home,
      pid: state.pidInfo?.pid ?? null,
      forced: false,
      message: `Daemon is not running${staleSuffix}`,
    }
  }

  const pid = state.pidInfo.pid
  const signaled = signalProcess(pid, 'SIGTERM')
  if (!signaled) {
    return {
      action: 'not_running',
      home: state.home,
      pid,
      forced: false,
      message: 'Daemon process was already stopped',
    }
  }

  let forced = false
  let stopped = await waitForExit(pid, timeoutMs)

  if (!stopped && options.force) {
    forced = true
    const killSent = signalProcess(pid, 'SIGKILL')
    if (killSent) {
      stopped = await waitForExit(pid, KILL_TIMEOUT_MS)
    } else {
      stopped = true
    }
  }

  if (!stopped) {
    throw new Error(
      `Timed out waiting for daemon PID ${pid} to stop after ${Math.ceil(timeoutMs / 1000)}s`
    )
  }

  rmSync(state.pidPath, { force: true })

  return {
    action: 'stopped',
    home: state.home,
    pid,
    forced,
    message: forced ? 'Daemon was force-stopped' : 'Daemon stopped gracefully',
  }
}
