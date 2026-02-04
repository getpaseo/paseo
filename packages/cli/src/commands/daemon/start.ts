import { Command } from 'commander'
import chalk from 'chalk'
import {
  createPaseoDaemon,
  loadConfig,
  resolvePaseoHome,
  createRootLogger,
  loadPersistedConfig,
} from '@paseo/server'
import type { CliConfigOverrides } from '@paseo/server'

interface StartOptions {
  port?: string
  home?: string
  foreground?: boolean
  noRelay?: boolean
  noMcp?: boolean
  allowedHosts?: string
}

export function startCommand(): Command {
  return new Command('start')
    .description('Start the Paseo daemon')
    .option('--port <port>', 'Port to listen on (default: 6767)')
    .option('--home <path>', 'Paseo home directory (default: ~/.paseo)')
    .option('--foreground', 'Run in foreground (don\'t daemonize)')
    .option('--no-relay', 'Disable relay connection')
    .option('--no-mcp', 'Disable the Agent MCP HTTP endpoint')
    .option(
      '--allowed-hosts <hosts>',
      'Comma-separated list of allowed Host header values (Vite-style; e.g., "localhost,.example.com" or "true")'
    )
    .action(async (options: StartOptions) => {
      await runStart(options)
    })
}

async function runStart(options: StartOptions): Promise<void> {
  // Set environment variables based on CLI options
  if (options.home) {
    process.env.PASEO_HOME = options.home
  }

  let paseoHome: string
  let logger: ReturnType<typeof createRootLogger>
  let config: ReturnType<typeof loadConfig>
  const cliOverrides: CliConfigOverrides = {}

  if (options.port) {
    cliOverrides.listen = `127.0.0.1:${options.port}`
  }

  if (options.noRelay) {
    cliOverrides.relayEnabled = false
  }

  if (options.allowedHosts) {
    const raw = options.allowedHosts.trim()
    cliOverrides.allowedHosts =
      raw.toLowerCase() === 'true'
        ? true
        : raw.split(',').map(h => h.trim()).filter(Boolean)
  }

  if (options.noMcp) {
    cliOverrides.mcpEnabled = false
  }

  try {
    paseoHome = resolvePaseoHome()
    const persistedConfig = loadPersistedConfig(paseoHome)
    logger = createRootLogger(persistedConfig)
    config = loadConfig(paseoHome, { cli: cliOverrides })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(chalk.red(message))
    process.exit(1)
  }

  // For now, only foreground mode is supported
  // TODO: Implement daemonization in a future phase
  if (!options.foreground) {
    console.log(chalk.yellow('Note: Background daemon mode not yet implemented. Running in foreground.'))
  }

  const daemon = await createPaseoDaemon(config, logger)

  // Handle graceful shutdown
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
    const message = err instanceof Error ? err.message : String(err)
    console.error(chalk.red(`Failed to start daemon: ${message}`))
    process.exit(1)
  }
}
