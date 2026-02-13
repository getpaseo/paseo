import { Command } from 'commander'
import chalk from 'chalk'
import {
  createPaseoDaemon,
  loadConfig,
  resolvePaseoHome,
  createRootLogger,
  loadPersistedConfig,
} from '@getpaseo/server'
import type { CliConfigOverrides } from '@getpaseo/server'
import {
  startLocalDaemonDetached,
  type DaemonStartOptions as StartOptions,
} from './local-daemon.js'
import { getErrorMessage } from '../../utils/errors.js'

export type { DaemonStartOptions as StartOptions } from './local-daemon.js'

export function startCommand(): Command {
  return new Command('start')
    .description('Start the local Paseo daemon')
    .option('--listen <listen>', 'Listen target (host:port, port, or unix socket path)')
    .option('--port <port>', 'Port to listen on (default: 6767)')
    .option('--home <path>', 'Paseo home directory (default: ~/.paseo)')
    .option('--foreground', 'Run in foreground (don\'t daemonize)')
    .option('--no-relay', 'Disable relay connection')
    .option('--no-mcp', 'Disable the Agent MCP HTTP endpoint')
    .option(
      '--allowed-hosts <hosts>',
      'Comma-separated Host allowlist values (example: "localhost,.example.com" or "true")'
    )
    .action(async (options: StartOptions) => {
      await runStart(options)
    })
}

function toCliOverrides(options: StartOptions): CliConfigOverrides {
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
        : raw.split(',').map(h => h.trim()).filter(Boolean)
  }

  if (options.mcp === false) {
    cliOverrides.mcpEnabled = false
  }

  return cliOverrides
}

export async function runStart(options: StartOptions): Promise<void> {
  if (options.listen && options.port) {
    console.error(chalk.red('Cannot use --listen and --port together'))
    process.exit(1)
  }

  if (!options.foreground) {
    try {
      const startup = await startLocalDaemonDetached(options)
      console.log(chalk.green(`Daemon starting in background (PID ${startup.pid ?? 'unknown'}).`))
      console.log(chalk.dim(`Logs: ${startup.logPath}`))
    } catch (err) {
      exitWithError(getErrorMessage(err))
    }
    return
  }

  if (options.home) {
    process.env.PASEO_HOME = options.home
  }

  let paseoHome: string
  let logger: ReturnType<typeof createRootLogger>
  let config: ReturnType<typeof loadConfig>

  try {
    paseoHome = resolvePaseoHome()
    const persistedConfig = loadPersistedConfig(paseoHome)
    logger = createRootLogger(persistedConfig)
    config = loadConfig(paseoHome, { cli: toCliOverrides(options) })
  } catch (err) {
    exitWithError(getErrorMessage(err))
  }

  let daemon: Awaited<ReturnType<typeof createPaseoDaemon>>
  try {
    daemon = await createPaseoDaemon(config, logger)
  } catch (err) {
    const message = getErrorMessage(err)
    exitWithError(`Failed to initialize daemon: ${message}`)
  }

  let shuttingDown = false
  const handleShutdown = async (signal: string) => {
    if (shuttingDown) {
      logger.info('Forcing exit...')
      process.exit(1)
    }
    shuttingDown = true
    logger.info(`${signal} received, shutting down gracefully... (press Ctrl+C again to force exit)`)

    const forceExit = setTimeout(() => {
      logger.warn('Forcing shutdown - HTTP server didn\'t close in time')
      process.exit(1)
    }, 10000)

    try {
      await daemon.stop()
      clearTimeout(forceExit)
      logger.info('Server closed')
      process.exit(0)
    } catch (err) {
      clearTimeout(forceExit)
      logger.error({ err }, 'Shutdown failed')
      process.exit(1)
    }
  }

  process.on('SIGTERM', () => handleShutdown('SIGTERM'))
  process.on('SIGINT', () => handleShutdown('SIGINT'))

  try {
    await daemon.start()
  } catch (err) {
    const message = getErrorMessage(err)
    exitWithError(`Failed to start daemon: ${message}`)
  }
}

function exitWithError(message: string): never {
  console.error(chalk.red(message))
  process.exit(1)
}
