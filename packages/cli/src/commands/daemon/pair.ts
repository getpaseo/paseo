import { Command } from "commander";
import chalk from "chalk";
import { generateLocalPairingOffer, loadConfig, resolvePaseoHome } from "@getpaseo/server";
import { addJsonOption } from "../../utils/command-options.js";

interface PairOptions {
  home?: string;
  json?: boolean;
}

export function pairCommand(): Command {
  return addJsonOption(new Command("pair").description("Print the daemon pairing QR code and link"))
    .option("--home <path>", "Paseo home directory (default: ~/.paseo)")
    .action(async (_options: PairOptions, command: Command) => {
      await runPairCommand(command.optsWithGlobals());
    });
}

export async function runPairCommand(options: PairOptions): Promise<void> {
  if (options.home) {
    process.env.PASEO_HOME = options.home;
  }

  const paseoHome = resolvePaseoHome();
  const config = loadConfig(paseoHome);
  const pairing = await generateLocalPairingOffer({
    paseoHome,
    relayEnabled: config.relayEnabled,
    relayEndpoint: config.relayEndpoint,
    relayPublicEndpoint: config.relayPublicEndpoint,
    relayUseTls: config.relayUseTls,
    appBaseUrl: config.appBaseUrl,
    includeQr: true,
  });

  if (!pairing.relayEnabled || !pairing.url) {
    console.error(chalk.red("Relay pairing is disabled for this daemon config."));
    console.error(chalk.yellow("Enable relay and run this command again."));
    process.exit(1);
  }

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          relayEnabled: pairing.relayEnabled,
          url: pairing.url,
          qr: pairing.qr,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const qrBlock = pairing.qr ? `${pairing.qr}\n` : "";
  process.stdout.write(`\nScan to pair:\n${qrBlock}${pairing.url}\n`);
}
