import { Command } from 'commander'
import chalk from 'chalk'
import { generateLocalPairingOffer, loadConfig, resolvePaseoHome } from '@getpaseo/server'

interface PairOptions {
  home?: string
}

export function pairCommand(): Command {
  return new Command('pair')
    .description('Print the daemon pairing QR code and link')
    .option('--home <path>', 'Paseo home directory (default: ~/.paseo)')
    .action(async (options: PairOptions) => {
      await runPairCommand(options)
    })
}

export async function runPairCommand(options: PairOptions): Promise<void> {
  if (options.home) {
    process.env.PASEO_HOME = options.home
  }

  const paseoHome = resolvePaseoHome()
  const config = loadConfig(paseoHome)
  const pairing = await generateLocalPairingOffer({
    paseoHome,
    relayEnabled: config.relayEnabled,
    relayEndpoint: config.relayEndpoint,
    relayPublicEndpoint: config.relayPublicEndpoint,
    appBaseUrl: config.appBaseUrl,
    includeQr: true,
  })

  if (!pairing.relayEnabled || !pairing.url) {
    console.error(chalk.red('Relay pairing is disabled for this daemon config.'))
    console.error(chalk.yellow('Enable relay and run this command again.'))
    process.exit(1)
  }

  const qrBlock = pairing.qr ? `${pairing.qr}\n` : ''
  process.stdout.write(`\nScan to pair:\n${qrBlock}${pairing.url}\n`)
}
