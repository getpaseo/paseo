import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { loadConfig, resolveJunctionHome } from '@junction/server'
import { tryConnectToDaemon } from '../../utils/client.js'

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
  listen?: string
  port?: string
  all?: boolean
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
const DAEMON_PID_FILENAME = 'junction.pid'
const DAEMON_PIDS_DIR = 'pids'

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

  return { ...process.env, JUNCTION_HOME: home }
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

function buildChildEnv(options: DaemonStartOptions): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...process.env }
  if (options.home) {
    childEnv.JUNCTION_HOME = options.home
  }
  if (options.listen) {
    childEnv.JUNCTION_LISTEN = options.listen
  } else if (options.port) {
    childEnv.JUNCTION_LISTEN = `127.0.0.1:${options.port}`
  }
  if (options.allowedHosts) {
    childEnv.JUNCTION_ALLOWED_HOSTS = options.allowedHosts
  }
  return childEnv
}

function resolveDaemonRunnerEntry(): string {
  const serverExportPath = require.resolve('@junction/server')
  let currentDir = path.dirname(serverExportPath)

  while (true) {
    const packageJsonPath = path.join(currentDir, 'package.json')
    if (existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { name?: string }
        if (packageJson.name === '@junction/server') {
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

  throw new Error('Unable to resolve @junction/server package root for daemon runner')
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

function signalProcessSafely(pid: number, signal: NodeJS.Signals): boolean {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) {
    return false
  }

  try {
    return signalProcess(pid, signal)
  } catch (err) {
    const code = readNodeErrnoCode(err)
    if (code === 'EPERM') {
      return true
    }
    throw err
  }
}

function signalProcessGroupSafely(pid: number, signal: NodeJS.Signals): boolean {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) {
    return false
  }

  if (process.platform === 'win32') {
    return signalProcessSafely(pid, signal)
  }

  try {
    process.kill(-pid, signal)
    return true
  } catch (err) {
    const code = readNodeErrnoCode(err)
    if (code === 'ESRCH') {
      return signalProcessSafely(pid, signal)
    }
    if (code === 'EPERM') {
      return true
    }
    throw err
  }
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      return true
    }
    await sleep(PID_POLL_INTERVAL_MS)
  }
  return !isProcessRunning(pid)
}

type LifecycleShutdownAttempt =
  | { requested: true }
  | { requested: false; reason: string }

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function resolveLocalJunctionHome(home?: string): string {
  return resolveJunctionHome(envWithHome(home))
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

function scanPidFiles(home: string): LocalDaemonState[] {
  const logPath = path.join(home, DAEMON_LOG_FILENAME)
  const states: LocalDaemonState[] = []
  const seenPids = new Set<number>()

  // Scan pids/ directory
  const pidsDir = path.join(home, DAEMON_PIDS_DIR)
  if (existsSync(pidsDir)) {
    try {
      const entries = readdirSync(pidsDir)
      for (const entry of entries) {
        if (!entry.endsWith('.pid')) continue
        const pidPath = path.join(pidsDir, entry)
        const pidInfo = readPidFile(pidPath)
        if (!pidInfo) continue
        const running = isProcessRunning(pidInfo.pid)
        seenPids.add(pidInfo.pid)
        states.push({
          home,
          listen: pidInfo.sockPath ?? 'unknown',
          logPath,
          pidPath,
          pidInfo,
          running,
          stalePidFile: !running,
        })
      }
    } catch {
      // pids dir read failed
    }
  }

  // Check legacy junction.pid
  const legacyPath = path.join(home, DAEMON_PID_FILENAME)
  if (existsSync(legacyPath)) {
    const pidInfo = readPidFile(legacyPath)
    if (pidInfo && !seenPids.has(pidInfo.pid)) {
      const running = isProcessRunning(pidInfo.pid)
      states.push({
        home,
        listen: pidInfo.sockPath ?? 'unknown',
        logPath,
        pidPath: legacyPath,
        pidInfo,
        running,
        stalePidFile: !running,
      })
    }
  }

  return states
}

export function resolveAllLocalDaemonStates(options: { home?: string } = {}): LocalDaemonState[] {
  const home = resolveLocalJunctionHome(options.home)
  return scanPidFiles(home)
}

export function resolveLocalDaemonState(
  options: { home?: string; listen?: string; port?: string } = {}
): LocalDaemonState {
  const env: NodeJS.ProcessEnv = {
    ...envWithHome(options.home),
    // Status should reflect local persisted config + pid file, not inherited daemon env overrides.
    JUNCTION_LISTEN: undefined,
    JUNCTION_ALLOWED_HOSTS: undefined,
  }
  const home = resolveJunctionHome(env)
  const config = loadConfig(home, { env })
  const logPath = path.join(home, DAEMON_LOG_FILENAME)

  // If targeting a specific listen address
  const targetListen = options.listen ?? (options.port ? `127.0.0.1:${options.port}` : undefined)
  if (targetListen) {
    const allStates = scanPidFiles(home)
    const match = allStates.find((s) => s.listen === targetListen)
    if (match) return match

    // No match found — return a "not running" state for the target
    return {
      home,
      listen: targetListen,
      logPath,
      pidPath: path.join(home, DAEMON_PIDS_DIR, 'none'),
      pidInfo: null,
      running: false,
      stalePidFile: false,
    }
  }

  // Default: scan all PID files, prefer the one matching config's default listen
  const allStates = scanPidFiles(home)

  // Try to find daemon matching config's default listen address
  const configMatch = allStates.find((s) => s.listen === config.listen && s.running)
  if (configMatch) return configMatch

  // Fall back to any running daemon
  const anyRunning = allStates.find((s) => s.running)
  if (anyRunning) return anyRunning

  // Fall back to any stale daemon
  const anyStale = allStates.find((s) => s.stalePidFile)
  if (anyStale) return anyStale

  // No daemons found at all
  return {
    home,
    listen: config.listen,
    logPath,
    pidPath: path.join(home, DAEMON_PIDS_DIR, 'none'),
    pidInfo: null,
    running: false,
    stalePidFile: false,
  }
}

export function tailDaemonLog(home?: string, lines = 30): string | null {
  const logPath = path.join(resolveLocalJunctionHome(home), DAEMON_LOG_FILENAME)
  return tailFile(logPath, lines)
}

export async function startLocalDaemonDetached(
  options: DaemonStartOptions
): Promise<DetachedStartResult> {
  if (options.listen && options.port) {
    throw new Error('Cannot use --listen and --port together')
  }

  const childEnv = buildChildEnv(options)

  const junctionHome = resolveJunctionHome(childEnv)
  const logPath = path.join(junctionHome, DAEMON_LOG_FILENAME)
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

export function startLocalDaemonForeground(options: DaemonStartOptions): number {
  if (options.listen && options.port) {
    throw new Error('Cannot use --listen and --port together')
  }

  const childEnv = buildChildEnv(options)
  const daemonRunnerEntry = resolveDaemonRunnerEntry()
  const result = spawnSync(
    process.execPath,
    [...process.execArgv, daemonRunnerEntry, ...buildRunnerArgs(options)],
    {
      env: childEnv,
      stdio: 'inherit',
    }
  )

  if (result.error) {
    throw result.error
  }

  return result.status ?? 1
}

async function requestLifecycleShutdown(
  state: LocalDaemonState,
  timeoutMs: number
): Promise<LifecycleShutdownAttempt> {
  const host = resolveTcpHostFromListen(state.listen)
  if (!host) {
    return {
      requested: false,
      reason: 'daemon listen target is not TCP, falling back to owner PID signal',
    }
  }

  const client = await tryConnectToDaemon({ host, timeout: Math.min(timeoutMs, 5000) })
  if (!client) {
    return {
      requested: false,
      reason: `daemon websocket at ${host} is not reachable, falling back to owner PID signal`,
    }
  }

  try {
    await client.shutdownServer()
    return { requested: true }
  } catch (error) {
    return {
      requested: false,
      reason: `daemon lifecycle shutdown request failed (${getErrorMessage(
        error
      )}), falling back to owner PID signal`,
    }
  } finally {
    await client.close().catch(() => undefined)
  }
}

async function stopSingleDaemon(
  state: LocalDaemonState,
  options: { timeoutMs: number; force?: boolean }
): Promise<StopLocalDaemonResult> {
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
  const shutdownAttempt = await requestLifecycleShutdown(state, options.timeoutMs)
  const lifecycleRequested = shutdownAttempt.requested
  const fallbackMessage = shutdownAttempt.requested ? null : shutdownAttempt.reason
  let forced = false
  if (!lifecycleRequested) {
    const signaled = signalProcessSafely(pid, 'SIGTERM')
    if (!signaled) {
      return {
        action: 'not_running',
        home: state.home,
        pid,
        forced: false,
        message: 'Daemon process was already stopped',
      }
    }
  }

  let stopped = await waitForPidExit(pid, options.timeoutMs)
  if (!stopped && options.force) {
    forced = true
    signalProcessGroupSafely(pid, 'SIGKILL')
    stopped = await waitForPidExit(pid, KILL_TIMEOUT_MS)
  }

  if (!stopped) {
    throw new Error(
      `Timed out waiting for daemon PID ${pid} to stop after ${Math.ceil(options.timeoutMs / 1000)}s`
    )
  }

  return {
    action: 'stopped',
    home: state.home,
    pid,
    forced,
    message: forced
      ? 'Daemon owner process was force-stopped'
      : lifecycleRequested
        ? 'Daemon stopped gracefully'
        : fallbackMessage ?? 'Daemon stopped via owner PID signal',
  }
}

export async function stopLocalDaemon(
  options: StopLocalDaemonOptions = {}
): Promise<StopLocalDaemonResult | StopLocalDaemonResult[]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS

  if (options.all) {
    const allStates = resolveAllLocalDaemonStates({ home: options.home })
    const running = allStates.filter((s) => s.running)
    if (running.length === 0) {
      return {
        action: 'not_running',
        home: resolveLocalJunctionHome(options.home),
        pid: null,
        forced: false,
        message: 'No running daemons found',
      }
    }
    const results = await Promise.all(
      running.map((state) => stopSingleDaemon(state, { timeoutMs, force: options.force }))
    )
    return results.length === 1 ? results[0]! : results
  }

  const state = resolveLocalDaemonState({
    home: options.home,
    listen: options.listen,
    port: options.port,
  })
  return stopSingleDaemon(state, { timeoutMs, force: options.force })
}
