import type { Command } from 'commander'
import {
  runDoctorChecks,
  type DoctorCheckResult,
  type DoctorReport,
} from '@getpaseo/server'
import { getDaemonHost, resolveDaemonTarget } from '../utils/client.js'
import type { CommandOptions, ListResult, OutputSchema } from '../output/index.js'

interface DoctorRow {
  check: string
  status: string
  detail: string
}

function statusIndicator(status: DoctorCheckResult['status']): string {
  switch (status) {
    case 'ok':
      return '✓ ok'
    case 'warn':
      return '⚠ warn'
    case 'error':
      return '✗ error'
  }
}

function toDoctorRows(report: DoctorReport): DoctorRow[] {
  return report.checks.map((c) => ({
    check: c.label,
    status: statusIndicator(c.status),
    detail: c.detail,
  }))
}

function createDoctorSchema(report: DoctorReport): OutputSchema<DoctorRow> {
  return {
    idField: 'check',
    columns: [
      { header: 'CHECK', field: 'check' },
      {
        header: 'STATUS',
        field: 'status',
        color: (value) => {
          const v = typeof value === 'string' ? value : ''
          if (v.includes('ok')) return 'green'
          if (v.includes('warn')) return 'yellow'
          if (v.includes('error')) return 'red'
          return undefined
        },
      },
      { header: 'DETAIL', field: 'detail' },
    ],
    serialize: () => report,
  }
}

async function fetchRemoteReport(host: string): Promise<DoctorReport> {
  const target = resolveDaemonTarget(host)
  const baseUrl =
    target.type === 'tcp'
      ? target.url.replace(/^ws:\/\//, 'http://').replace(/\/ws$/, '')
      : null

  if (!baseUrl) {
    throw new Error('Remote doctor requires a TCP daemon target (not unix socket)')
  }

  const response = await fetch(`${baseUrl}/api/doctor`)
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Doctor endpoint returned ${response.status}: ${text}`)
  }
  return (await response.json()) as DoctorReport
}

export type DoctorResult = ListResult<DoctorRow>

export async function runDoctorCommand(
  options: CommandOptions,
  _command: Command
): Promise<DoctorResult> {
  const remote = Boolean(options.remote)

  let report: DoctorReport
  if (remote) {
    const host = getDaemonHost({ host: options.host as string | undefined })
    report = await fetchRemoteReport(host)
  } else {
    report = await runDoctorChecks()
  }

  return {
    type: 'list',
    data: toDoctorRows(report),
    schema: createDoctorSchema(report),
  }
}
