import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

export type NodePathSource = 'daemon_pid' | 'current_process'

export interface NodePathResolution {
  nodePath: string
  source: NodePathSource
  note?: string
}

export interface NodePathFromPidResult {
  nodePath: string | null
  error?: string
}

export interface NpmInvocation {
  nodePath: string
  npmPath: string
  command: string
  argsPrefix: string[]
}

function normalizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

export function resolveNodePathFromPid(pid: number): NodePathFromPidResult {
  const result = spawnSync('ps', ['-o', 'comm=', '-p', String(pid)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  if (result.error) {
    return {
      nodePath: null,
      error: `ps failed: ${normalizeError(result.error)}`,
    }
  }

  if ((result.status ?? 1) !== 0) {
    const details = result.stderr?.trim()
    return {
      nodePath: null,
      error: details ? `ps failed: ${details}` : `ps exited with code ${result.status ?? 1}`,
    }
  }

  const resolved = result.stdout.trim()
  if (!resolved) {
    return {
      nodePath: null,
      error: 'ps returned an empty command path',
    }
  }

  return { nodePath: resolved }
}

export function resolvePreferredNodePath(args: {
  daemonPid?: number | null
  fallbackNodePath?: string
}): NodePathResolution {
  const fallback = args.fallbackNodePath ?? process.execPath
  const daemonPid = args.daemonPid

  if (typeof daemonPid === 'number' && Number.isInteger(daemonPid) && daemonPid > 0) {
    const fromPid = resolveNodePathFromPid(daemonPid)
    if (fromPid.nodePath) {
      return {
        nodePath: fromPid.nodePath,
        source: 'daemon_pid',
      }
    }

    return {
      nodePath: fallback,
      source: 'current_process',
      note: `Could not resolve node from daemon PID ${daemonPid}; using current process node (${fromPid.error ?? 'unknown error'})`,
    }
  }

  return {
    nodePath: fallback,
    source: 'current_process',
  }
}

export function resolveNpmInvocationFromNode(nodePath: string): NpmInvocation {
  const binDir = path.dirname(nodePath)
  const prefix = path.dirname(binDir)
  const npmBinary = path.join(binDir, process.platform === 'win32' ? 'npm.cmd' : 'npm')

  if (existsSync(npmBinary)) {
    return {
      nodePath,
      npmPath: npmBinary,
      command: npmBinary,
      argsPrefix: [],
    }
  }

  const npmCliCandidates = [
    path.join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(prefix, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]

  for (const candidate of npmCliCandidates) {
    if (existsSync(candidate)) {
      return {
        nodePath,
        npmPath: candidate,
        command: nodePath,
        argsPrefix: [candidate],
      }
    }
  }

  throw new Error(`Unable to resolve npm for node executable: ${nodePath}`)
}

export function formatNpmInvocation(invocation: NpmInvocation): string {
  if (invocation.argsPrefix.length === 0) {
    return invocation.command
  }
  return `${invocation.command} ${invocation.argsPrefix.join(' ')}`
}
