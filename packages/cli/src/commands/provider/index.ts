import { Command } from 'commander'
import { runLsCommand } from './ls.js'
import { runModelsCommand } from './models.js'
import { withOutput } from '../../output/index.js'

export function createProviderCommand(): Command {
  const provider = new Command('provider').description('Manage agent providers')

  provider
    .command('ls')
    .description('List available providers and status')
    .option('--json', 'Output in JSON format')
    .option('--host <host>', 'Daemon host:port (default: localhost:6767)')
    .action((options, command) => {
      if (options.json) {
        command.parent.parent.opts().format = 'json'
      }
      return withOutput(runLsCommand)(options, command)
    })

  provider
    .command('models')
    .description('List models for a provider')
    .argument('<provider>', 'Provider name (claude, codex, opencode)')
    .option('--json', 'Output in JSON format')
    .option('--host <host>', 'Daemon host:port (default: localhost:6767)')
    .action((provider, options, command) => {
      if (options.json) {
        command.parent.parent.opts().format = 'json'
      }
      return withOutput(runModelsCommand)(provider, options, command)
    })

  return provider
}
