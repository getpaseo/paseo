import { Platform } from 'react-native'
import { getTauri } from '@/utils/tauri'
import { invokeDesktopCommand } from '@/desktop/tauri/invoke-desktop-command'

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

export interface LocalDaemonVersionResult {
  version: string | null
  error: string | null
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

export function shouldShowDesktopUpdateSection(): boolean {
  return Platform.OS === 'web' && getTauri() !== null
}

export function parseLocalDaemonVersionResult(raw: unknown): LocalDaemonVersionResult {
  if (!isRecord(raw)) {
    return { version: null, error: 'Unexpected response from version check.' }
  }

  return {
    version: toStringOrNull(raw.version),
    error: toStringOrNull(raw.error),
  }
}

export async function getLocalDaemonVersion(): Promise<LocalDaemonVersionResult> {
  const result = await invokeDesktopCommand<unknown>('get_local_daemon_version')
  return parseLocalDaemonVersionResult(result)
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
    return '\u2014'
  }

  return value.startsWith('v') ? value : `v${value}`
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
