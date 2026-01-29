import { Command } from 'commander'
import chalk from 'chalk'
import {
  createPaseoDaemon,
  loadConfig,
  resolvePaseoHome,
  createRootLogger,
  loadPersistedConfig,
} from '@paseo/server'

interface StartOptions {
  port?: string
  home?: string
  foreground?: boolean
  noRelay?: boolean
  allowedHosts?: string
}

export function startCommand(): Command {
  return new Command('start')
    .description('Start the Paseo daemon')
    .option('--port <port>', 'Port to listen on (default: 6767)')
    .option('--home <path>', 'Paseo home directory (default: ~/.paseo)')
    .option('--foreground', 'Run in foreground (don\'t daemonize)')
    .option('--no-relay', 'Disable relay connection')
    .option('--allowed-hosts <hosts>', 'Comma-separated list of allowed MCP hosts (e.g., "localhost:6767,127.0.0.1:6767")')
    .action(async (options: StartOptions) => {
      await runStart(options)
    })
}

async function runStart(options: StartOptions): Promise<void> {
  // Set environment variables based on CLI options
  if (options.home) {
    process.env.PASEO_HOME = options.home
  }
  if (options.port) {
    process.env.PASEO_LISTEN = `127.0.0.1:${options.port}`
  }

  const paseoHome = resolvePaseoHome()
  const persistedConfig = loadPersistedConfig(paseoHome)
  const logger = createRootLogger(persistedConfig)
  const config = loadConfig(paseoHome)

  // Apply CLI overrides
  if (options.noRelay) {
    config.relayEnabled = false
  }

  if (options.allowedHosts) {
    config.agentMcpAllowedHosts = options.allowedHosts.split(',').map(h => h.trim())
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
