import { Command } from "commander";
import chalk from "chalk";
import { generateLocalPairingOffer, loadConfig, resolvePaseoHome } from "@getpaseo/server";
import { tryConnectToDaemon } from "../../utils/client.js";
import { resolveLocalDaemonState, resolveTcpHostFromListen } from "./local-daemon.js";
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
  const state = resolveLocalDaemonState({ home: paseoHome });
  const host = resolveTcpHostFromListen(state.listen);

  // Try to get the pairing offer from the running daemon first.
  if (host) {
    const client = await tryConnectToDaemon({ host, timeout: 1500 });
    if (client) {
      const supportsDaemonStatusRpc =
        client.getLastServerInfoMessage()?.features?.daemonStatusRpc === true;
      if (supportsDaemonStatusRpc) {
        try {
          const offer = await client.getDaemonPairingOffer();
          await client.close().catch(() => {});
          outputPairingResult(
            { relayEnabled: offer.relayEnabled, url: offer.url, qr: offer.qr ?? null },
            options,
          );
          return;
        } catch {
          // COMPAT(daemon-rpc-rollout): fall back to CLI-side pairing generation while
          // old daemons lack daemonStatusRpc. Remove once the daemon floor is past
          // v0.1.76; pairing should come from daemon.get_pairing_offer.
        }
      }
      await client.close().catch(() => {});
    }
  }

  // Fall back to local pairing offer generation.
  const config = loadConfig(paseoHome);
  const pairing = await generateLocalPairingOffer({
    paseoHome,
    relayEnabled: config.relayEnabled,
    relayEndpoint: config.relayEndpoint,
    relayPublicEndpoint: config.relayPublicEndpoint,
    relayUseTls: config.relayUseTls,
    relayPublicUseTls: config.relayPublicUseTls,
    appBaseUrl: config.appBaseUrl,
    includeQr: true,
  });

  outputPairingResult(pairing, options);
}

function outputPairingResult(
  pairing: { relayEnabled: boolean; url: string | null; qr: string | null },
  options: PairOptions,
): void {
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
