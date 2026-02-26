import type { Command } from 'commander'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { tryConnectToDaemon } from '../../utils/client.js'
import type { CommandOptions, ListResult, OutputSchema } from '../../output/index.js'
import { resolveLocalDaemonState, resolveTcpHostFromListen } from './local-daemon.js'
import {
  formatNpmInvocation,
  resolveNpmInvocationFromNode,
  resolvePreferredNodePath,
  type NpmInvocation,
} from './runtime-toolchain.js'

interface DaemonStatus {
  status: 'running' | 'stopped' | 'unresponsive'
  home: string
  listen: string
  pid: number | null
  startedAt: string | null
  owner: string | null
  logPath: string
  runningAgents: number | null
  idleAgents: number | null
  runtimeNode: string
  runtimeNpm: string
  cliVersion: string
  latestCliVersion: string
  updateStatus: string
  note?: string
}

interface StatusRow {
  key: string
  value: string
}

type CliPackageJson = {
  version?: unknown
}

type LatestCliVersionResult = {
  version: string | null
  note?: string
}

const require = createRequire(import.meta.url)
const CLI_UPDATE_CHECK_TIMEOUT_MS = 3000

function normalizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

function shortenMessage(message: string, max = 120): string {
  const normalized = message.replace(/\s+/g, ' ').trim()
  if (normalized.length <= max) {
    return normalized
  }
  return `${normalized.slice(0, max - 3)}...`
}

function appendNote(current: string | undefined, next: string | undefined): string | undefined {
  if (!next) return current
  if (!current) return next
  return `${current}; ${next}`
}

function resolveCliVersion(): string {
  try {
    const packageJson = require('../../../package.json') as CliPackageJson
    if (typeof packageJson.version === 'string' && packageJson.version.trim().length > 0) {
      return packageJson.version.trim()
    }
  } catch {
    // Fall through.
  }
  return 'unknown'
}

function parseVersionFromNpmOutput(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) {
    return null
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (typeof parsed === 'string' && parsed.trim().length > 0) {
      return parsed.trim()
    }
  } catch {
    // Fall back to plain output.
  }

  return trimmed.replace(/^"+|"+$/g, '').trim() || null
}

function parseSemver(version: string): [number, number, number] | null {
  const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/)
  if (!match) {
    return null
  }

  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  if (![major, minor, patch].every((part) => Number.isInteger(part) && part >= 0)) {
    return null
  }

  return [major, minor, patch]
}

function compareSemver(left: string, right: string): number | null {
  const leftParts = parseSemver(left)
  const rightParts = parseSemver(right)
  if (!leftParts || !rightParts) {
    return null
  }

  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index]! < rightParts[index]!) return -1
    if (leftParts[index]! > rightParts[index]!) return 1
  }

  return 0
}

function fetchLatestCliVersion(npm: NpmInvocation): LatestCliVersionResult {
  const result = spawnSync(
    npm.command,
    [...npm.argsPrefix, 'view', '@junction/cli', 'version', '--json'],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      timeout: CLI_UPDATE_CHECK_TIMEOUT_MS,
    }
  )

  if (result.error) {
    return {
      version: null,
      note: `update check failed: ${shortenMessage(normalizeError(result.error))}`,
    }
  }

  if ((result.status ?? 1) !== 0) {
    const stderr = result.stderr?.trim()
    return {
      version: null,
      note: stderr
        ? `update check failed: ${shortenMessage(stderr)}`
        : `update check failed: npm exited with code ${result.status ?? 1}`,
    }
  }

  const version = parseVersionFromNpmOutput(result.stdout)
  if (!version) {
    return {
      version: null,
      note: 'update check failed: empty npm response',
    }
  }

  return { version }
}

function createStatusSchema(status: DaemonStatus): OutputSchema<StatusRow> {
  return {
    idField: 'key',
    columns: [
      { header: 'KEY', field: 'key' },
      {
        header: 'VALUE',
        field: 'value',
        color: (_, item) => {
          if (item.key !== 'Status') {
            return undefined
          }
          if (item.value === 'running') {
            return 'green'
          }
          if (item.value === 'unresponsive') {
            return 'yellow'
          }
          return 'red'
        },
      },
    ],
    serialize: () => status,
  }
}

function toStatusRows(status: DaemonStatus): StatusRow[] {
  const rows: StatusRow[] = [
    { key: 'Status', value: status.status },
    { key: 'Home', value: status.home },
    { key: 'Listen', value: status.listen },
    { key: 'PID', value: status.pid === null ? '-' : String(status.pid) },
    { key: 'Started', value: status.startedAt ?? '-' },
    { key: 'Owner', value: status.owner ?? '-' },
    { key: 'Logs', value: status.logPath },
    { key: 'Node', value: status.runtimeNode },
    { key: 'npm', value: status.runtimeNpm },
    { key: 'CLI', value: status.cliVersion },
    { key: 'Latest CLI', value: status.latestCliVersion },
    { key: 'Update', value: status.updateStatus },
  ]

  if (status.runningAgents !== null && status.idleAgents !== null) {
    rows.push({
      key: 'Agents',
      value: `${status.runningAgents} running, ${status.idleAgents} idle`,
    })
  } else {
    rows.push({
      key: 'Agents',
      value: 'Unavailable (daemon API not reachable)',
    })
  }

  if (status.note) {
    rows.push({ key: 'Note', value: status.note })
  }

  return rows
}

function resolveOwnerLabel(uid: number | undefined, hostname: string | undefined): string | null {
  if (uid === undefined && !hostname) {
    return null
  }
  const uidPart = uid === undefined ? '?' : String(uid)
  const hostPart = hostname ?? 'unknown-host'
  return `${uidPart}@${hostPart}`
}

export type StatusResult = ListResult<StatusRow>

export async function runStatusCommand(
  options: CommandOptions,
  _command: Command
): Promise<StatusResult> {
  const home = typeof options.home === 'string' ? options.home : undefined
  const state = resolveLocalDaemonState({ home })

  const owner = resolveOwnerLabel(state.pidInfo?.uid, state.pidInfo?.hostname)
  const resolvedNode = resolvePreferredNodePath({
    daemonPid: state.running ? state.pidInfo?.pid : null,
    fallbackNodePath: process.execPath,
  })
  let status: DaemonStatus['status'] = state.running ? 'running' : 'stopped'
  let runningAgents: number | null = null
  let idleAgents: number | null = null
  let note: string | undefined
  let runtimeNpm = '-'
  let latestCliVersion = 'unknown'
  let updateStatus = 'unknown'

  if (!state.running && state.stalePidFile && state.pidInfo) {
    note = `Stale PID file found for PID ${state.pidInfo.pid}`
  }
  note = appendNote(note, resolvedNode.note)

  if (state.running) {
    const host = resolveTcpHostFromListen(state.listen)
    if (host) {
      const client = await tryConnectToDaemon({ host, timeout: 1500 })
      if (client) {
        try {
          const agentsPayload = await client.fetchAgents({ filter: { includeArchived: true } })
          const agents = agentsPayload.entries.map((entry) => entry.agent)
          runningAgents = agents.filter(a => a.status === 'running').length
          idleAgents = agents.filter(a => a.status === 'idle').length
        } catch {
          status = 'unresponsive'
          note = appendNote(note, `Daemon PID is running but API requests to ${host} failed`)
        } finally {
          await client.close().catch(() => {})
        }
      } else {
        status = 'unresponsive'
        note = appendNote(note, `Daemon PID is running but websocket at ${host} is not reachable`)
      }
    } else {
      note = appendNote(note, 'Daemon is configured for unix socket listen; API probe skipped')
    }
  }

  let npmInvocation: NpmInvocation | null = null
  try {
    npmInvocation = resolveNpmInvocationFromNode(resolvedNode.nodePath)
    runtimeNpm = formatNpmInvocation(npmInvocation)
  } catch (err) {
    runtimeNpm = `unresolved (${shortenMessage(normalizeError(err))})`
  }

  const cliVersion = resolveCliVersion()
  if (npmInvocation) {
    const latest = fetchLatestCliVersion(npmInvocation)
    if (latest.version) {
      latestCliVersion = latest.version
      if (cliVersion === 'unknown') {
        updateStatus = 'unknown (local CLI version unavailable)'
      } else {
        const comparison = compareSemver(cliVersion, latest.version)
        if (comparison === null) {
          updateStatus = 'unknown (version format not comparable)'
        } else if (comparison < 0) {
          updateStatus = `update available (${cliVersion} -> ${latest.version})`
        } else {
          updateStatus = 'up to date'
        }
      }
    } else {
      latestCliVersion = 'unknown'
      updateStatus = latest.note ?? 'unknown'
    }
  } else {
    updateStatus = 'unknown (npm unresolved)'
  }

  const daemonStatus: DaemonStatus = {
    status,
    home: state.home,
    listen: state.listen,
    pid: state.pidInfo?.pid ?? null,
    startedAt: state.pidInfo?.startedAt ?? null,
    owner,
    logPath: state.logPath,
    runningAgents,
    idleAgents,
    runtimeNode: `${resolvedNode.nodePath} (${resolvedNode.source})`,
    runtimeNpm,
    cliVersion,
    latestCliVersion,
    updateStatus,
    note,
  }

  return {
    type: 'list',
    data: toStatusRows(daemonStatus),
    schema: createStatusSchema(daemonStatus),
  }
}
