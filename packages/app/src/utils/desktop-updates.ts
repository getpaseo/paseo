import { Platform } from 'react-native'
import type { HostProfile } from '@/contexts/daemon-registry-context'
import { getTauri } from '@/utils/tauri'

export interface DesktopAppUpdateCheckResult {
  hasUpdate: boolean
  currentVersion: string | null
  latestVersion: string | null
  body: string | null
  date: string | null
}

export interface DesktopAppUpdateInstallResult {
  installed: boolean
  version: string | null
  message: string
}

export interface LocalDaemonUpdateResult {
  exitCode: number
  stdout: string
  stderr: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function toStringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function toStringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function toNumberOr(defaultValue: number, value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : defaultValue
}

async function invokeDesktopCommand<T>(command: string): Promise<T> {
  const invoke = getTauri()?.core?.invoke
  if (typeof invoke !== 'function') {
    throw new Error('Tauri invoke() is unavailable in this environment.')
  }

  return (await invoke(command)) as T
}

function isLikelyLocalDirectEndpoint(endpoint: string): boolean {
  const normalized = endpoint.trim().toLowerCase()
  return (
    normalized === 'localhost' ||
    normalized.startsWith('localhost:') ||
    normalized === '127.0.0.1' ||
    normalized.startsWith('127.0.0.1:') ||
    normalized === '::1' ||
    normalized.startsWith('::1:') ||
    normalized === '[::1]' ||
    normalized.startsWith('[::1]:')
  )
}

export function shouldShowDesktopUpdateSection(): boolean {
  return Platform.OS === 'web' && getTauri() !== null
}

export async function checkDesktopAppUpdate(): Promise<DesktopAppUpdateCheckResult> {
  const result = await invokeDesktopCommand<unknown>('check_app_update')
  if (!isRecord(result)) {
    throw new Error('Unexpected response while checking desktop updates.')
  }

  return {
    hasUpdate: result.hasUpdate === true,
    currentVersion: toStringOrNull(result.currentVersion),
    latestVersion: toStringOrNull(result.latestVersion),
    body: toStringOrNull(result.body),
    date: toStringOrNull(result.date),
  }
}

export async function installDesktopAppUpdate(): Promise<DesktopAppUpdateInstallResult> {
  const result = await invokeDesktopCommand<unknown>('install_app_update')
  if (!isRecord(result)) {
    throw new Error('Unexpected response while installing desktop update.')
  }

  return {
    installed: result.installed === true,
    version: toStringOrNull(result.version),
    message: toStringOrNull(result.message) ?? 'Update completed.',
  }
}

export async function runLocalDaemonUpdate(): Promise<LocalDaemonUpdateResult> {
  const result = await invokeDesktopCommand<unknown>('run_local_daemon_update')
  if (!isRecord(result)) {
    throw new Error('Unexpected response while updating local daemon.')
  }

  return {
    exitCode: toNumberOr(1, result.exitCode),
    stdout: toStringOrEmpty(result.stdout),
    stderr: toStringOrEmpty(result.stderr),
  }
}

export function normalizeVersionForComparison(version: string | null | undefined): string | null {
  const value = version?.trim()
  if (!value) {
    return null
  }

  return value.replace(/^v/i, '')
}

export function isVersionMismatch(
  appVersion: string | null | undefined,
  daemonVersion: string | null | undefined
): boolean {
  const app = normalizeVersionForComparison(appVersion)
  const daemon = normalizeVersionForComparison(daemonVersion)

  if (!app || !daemon) {
    return false
  }

  return app !== daemon
}

export function formatVersionWithPrefix(version: string | null | undefined): string {
  const value = version?.trim()
  if (!value) {
    return 'Unavailable'
  }

  return value.startsWith('v') ? value : `v${value}`
}

export function findLikelyLocalDaemonHost(daemons: HostProfile[]): HostProfile | null {
  if (daemons.length === 0) {
    return null
  }

  const localhostDaemon = daemons.find((daemon) =>
    daemon.connections.some(
      (connection) =>
        connection.type === 'direct' && isLikelyLocalDirectEndpoint(connection.endpoint)
    )
  )

  return localhostDaemon ?? daemons[0] ?? null
}

export function buildDaemonUpdateDiagnostics(result: LocalDaemonUpdateResult): string {
  const stdout = result.stdout.length > 0 ? result.stdout : '(empty)'
  const stderr = result.stderr.length > 0 ? result.stderr : '(empty)'

  return [
    `Exit code: ${result.exitCode}`,
    '',
    'STDOUT:',
    stdout,
    '',
    'STDERR:',
    stderr,
  ].join('\n')
}
