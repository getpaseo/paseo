import { cancel, intro, log, note, outro, spinner } from '@clack/prompts'
import { Command } from 'commander'
import path from 'node:path'
import {
  loadConfig,
  type CliConfigOverrides,
} from '@junction/server'
import {
  resolveLocalJunctionHome,
  resolveLocalDaemonState,
  resolveTcpHostFromListen,
  startLocalDaemonDetached,
  tailDaemonLog,
  type DaemonStartOptions,
} from './daemon/local-daemon.js'
import { tryConnectToDaemon } from '../utils/client.js'

interface OnboardOptions extends DaemonStartOptions {
  timeout?: string
}

const DEFAULT_READY_TIMEOUT_MS = 10 * 60 * 1000

const plainNoteFormat = (line: string): string => line

function renderNote(message: string, title: string): void {
  note(message, title, { format: plainNoteFormat })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function parseTimeoutMs(raw: string | undefined): number {
  if (!raw || raw.trim().length === 0) {
    return DEFAULT_READY_TIMEOUT_MS
  }

  const seconds = Number(raw)
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`Invalid timeout value: ${raw}`)
  }

  return Math.ceil(seconds * 1000)
}

function toCliOverrides(options: DaemonStartOptions): CliConfigOverrides {
  const cliOverrides: CliConfigOverrides = {}

  if (options.listen) {
    cliOverrides.listen = options.listen
  } else if (options.port) {
    cliOverrides.listen = `127.0.0.1:${options.port}`
  }

  if (options.relay === false) {
    cliOverrides.relayEnabled = false
  }

  if (options.allowedHosts) {
    const raw = options.allowedHosts.trim()
    cliOverrides.allowedHosts =
      raw.toLowerCase() === 'true'
        ? true
        : raw.split(',').map(host => host.trim()).filter(Boolean)
  }

  if (options.mcp === false) {
    cliOverrides.mcpEnabled = false
  }

  return cliOverrides
}

async function waitForDaemonReady(args: {
  home: string
  timeoutMs: number
  onStatus?: (message: string) => void
}): Promise<{ listen: string; host: string | null }> {
  const deadline = Date.now() + args.timeoutMs
  let lastStatus = ''
  let lastPrintedAt = 0

  while (Date.now() < deadline) {
    const state = resolveLocalDaemonState({ home: args.home })
    const host = resolveTcpHostFromListen(state.listen)

    if (state.running && host) {
      const client = await tryConnectToDaemon({ host, timeout: 1200 })
      if (client) {
        try {
          await client.fetchAgents()
          return { listen: state.listen, host }
        } catch {
          // Daemon process is alive but not API-ready yet.
        } finally {
          await client.close().catch(() => {})
        }
      }
    } else if (state.running && !host) {
      return { listen: state.listen, host: null }
    }

    const statusMessage = 'Waiting for daemon to become ready...'

    if (statusMessage !== lastStatus) {
      args.onStatus?.(statusMessage)
      lastStatus = statusMessage
      lastPrintedAt = Date.now()
    } else if (!args.onStatus && Date.now() - lastPrintedAt >= 3000) {
      console.log(statusMessage)
      lastPrintedAt = Date.now()
    }

    await sleep(200)
  }

  const recentLogs = tailDaemonLog(args.home, 60)
  throw new Error(
    [
      `Timed out after ${Math.ceil(args.timeoutMs / 1000)}s waiting for daemon readiness.`,
      recentLogs ? `Recent daemon logs:\n${recentLogs}` : null,
    ]
      .filter(Boolean)
      .join('\n\n')
  )
}

function printNextSteps(junctionHome: string, richUi: boolean): void {
  const daemonLogPath = path.join(junctionHome, 'daemon.log')
  const nextStepsLines = [
    '1. Connect to your daemon from the Junction web app.',
    '2. Docs: https://junction.dev/docs',
    '3. Example: junction run "your prompt"',
  ]
  const quickReferenceLines = [
    '1. junction --help',
    '2. junction ls',
    '3. junction run "your prompt"',
    '4. junction status',
    `5. Daemon logs: ${daemonLogPath}`,
  ]

  if (!richUi) {
    console.log('')
    console.log('Next steps:')
    for (const line of nextStepsLines) {
      console.log(line)
    }
    console.log('')
    console.log('CLI quick reference:')
    for (const line of quickReferenceLines) {
      console.log(line)
    }
    return
  }

  renderNote(nextStepsLines.join('\n'), 'Next steps')
  renderNote(quickReferenceLines.join('\n'), 'CLI quick reference')
}

export function onboardCommand(): Command {
  return new Command('onboard')
    .description('Run first-time setup and start the daemon')
    .option('--listen <listen>', 'Listen target (host:port, port, or unix socket path)')
    .option('--port <port>', 'Port to listen on (default: 6767)')
    .option('--home <path>', 'Home directory (default: ~/.junction)')
    .option('--no-relay', 'Disable relay connection')
    .option('--no-mcp', 'Disable the Agent MCP HTTP endpoint')
    .option(
      '--allowed-hosts <hosts>',
      'Comma-separated Host allowlist values (example: "localhost,.example.com" or "true")'
    )
    .option('--timeout <seconds>', 'Max time to wait for daemon readiness (default: 600)')
    .action(async (options: OnboardOptions) => {
      await runOnboard(options)
    })
}

export async function runOnboard(options: OnboardOptions): Promise<void> {
  const richUi = process.stdin.isTTY && process.stdout.isTTY
  if (richUi) {
    intro('Welcome to Junction')
  }

  if (options.listen && options.port) {
    cancel('Cannot use --listen and --port together')
    process.exit(1)
  }

  let timeoutMs = DEFAULT_READY_TIMEOUT_MS
  try {
    timeoutMs = parseTimeoutMs(options.timeout)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    cancel(message)
    process.exit(1)
  }

  const junctionHome = resolveLocalJunctionHome(options.home)
  if (richUi) {
    renderNote(junctionHome, 'Junction home')
  }

  loadConfig(junctionHome, { cli: toCliOverrides(options) })

  const stateBeforeStart = resolveLocalDaemonState({ home: options.home })
  const startSpinner = richUi ? spinner() : null

  if (!stateBeforeStart.running) {
    try {
      if (startSpinner) {
        startSpinner.start('Starting daemon...')
      } else {
        log.message('Starting daemon...')
      }
      const startup = await startLocalDaemonDetached(options)
      if (startSpinner) {
        startSpinner.stop(`Daemon started (PID ${startup.pid ?? 'unknown'})`)
      } else {
        log.message(`Daemon started (PID ${startup.pid ?? 'unknown'})`)
      }
      log.message(`Logs: ${startup.logPath}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (startSpinner) {
        startSpinner.error(message)
      } else {
        log.error(message)
      }
      process.exit(1)
    }
  } else {
    log.message(`Daemon already running (PID ${stateBeforeStart.pidInfo?.pid ?? 'unknown'}).`)
  }

  const readySpinner = richUi ? spinner() : null
  try {
    if (readySpinner) {
      readySpinner.start('Waiting for daemon to become ready...')
    } else {
      log.message('Waiting for daemon to become ready...')
    }
    const readyState = await waitForDaemonReady({
      home: options.home ?? junctionHome,
      timeoutMs,
      onStatus: readySpinner ? (message) => readySpinner.message(message) : undefined,
    })
    if (readySpinner) {
      readySpinner.stop(`Daemon ready on ${readyState.listen}`)
    } else {
      log.message(`Daemon ready on ${readyState.listen}`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (readySpinner) {
      readySpinner.error(message)
    } else {
      log.error(message)
    }
    process.exit(1)
    return
  }

  printNextSteps(junctionHome, richUi)
  if (richUi) {
    outro('Junction daemon is running.')
  }
}
