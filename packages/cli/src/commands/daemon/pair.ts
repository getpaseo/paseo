import { Command } from 'commander'
import chalk from 'chalk'

export function pairCommand(): Command {
  return new Command('pair')
    .description('Print the daemon pairing link (coming soon)')
    .action(async () => {
      console.error(chalk.yellow('Pairing is not yet available in Junction. Coming soon.'))
      process.exit(1)
    })
}
