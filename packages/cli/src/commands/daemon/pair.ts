import { confirm, isCancel, log } from "@clack/prompts";
import { Command } from "commander";
import chalk from "chalk";
import { generateLocalPairingOffer, loadConfig, resolvePaseoHome } from "@getpaseo/server";
import { tryConnectToDaemon } from "../../utils/client.js";
import { resolveLocalDaemonState } from "./local-daemon.js";
import { addJsonOption } from "../../utils/command-options.js";
import { formatPairingInstructions } from "../../output/pairing.js";

interface PairOptions {
  home?: string;
  json?: boolean;
  relay?: boolean;
}

export interface PairCommandDependencies {
  resolveOffer: typeof resolveLocalPairingOffer;
  confirmRelay: typeof confirmRelayPairing;
  printDirectGuidance: typeof printDirectConnectionGuidance;
  isInteractive: () => boolean;
}

export interface PairingOffer {
  relayEnabled: boolean;
  url: string | null;
  qr: string | null;
}

const PAIRING_DAEMON_RPC_TIMEOUT_MS = 1500;
const RELAY_DOCS_URL = "https://paseo.sh/docs/security";

export function pairCommand(): Command {
  return addJsonOption(new Command("pair").description("Print the daemon pairing QR code and link"))
    .option("--home <path>", "Paseo home directory (default: ~/.paseo)")
    .option("--relay", "Enable relay without prompting")
    .action(async (_options: PairOptions, command: Command) => {
      await runPairCommand(command.optsWithGlobals());
    });
}

export async function resolveLocalPairingOffer(options: {
  paseoHome: string;
  enableRelay?: boolean;
}): Promise<PairingOffer> {
  const state = resolveLocalDaemonState({ home: options.paseoHome });
  if (state.running) {
    const runningOffer = await resolveRunningDaemonPairingOffer(state.listen, options.enableRelay);
    if (runningOffer) return runningOffer;
    throw new Error(
      "The running daemon did not provide a pairing offer. Check daemon connectivity or update the daemon.",
    );
  }

  if (options.enableRelay) {
    throw new Error("Start the daemon before enabling relay for pairing.");
  }

  const config = loadConfig(options.paseoHome);
  return generateLocalPairingOffer({
    paseoHome: options.paseoHome,
    relayEnabled: config.relayEnabled,
    relayEndpoint: config.relayEndpoint,
    relayPublicEndpoint: config.relayPublicEndpoint,
    relayUseTls: config.relayUseTls,
    relayPublicUseTls: config.relayPublicUseTls,
    appBaseUrl: config.appBaseUrl,
    includeQr: true,
  });
}

async function resolveRunningDaemonPairingOffer(
  listen: string,
  enableRelay: boolean | undefined,
): Promise<PairingOffer | null> {
  const client = await tryConnectToDaemon({
    host: listen,
    timeout: PAIRING_DAEMON_RPC_TIMEOUT_MS,
  });
  if (!client) return null;

  try {
    const serverInfo = client.getLastServerInfoMessage();
    if (serverInfo?.features?.daemonStatusRpc !== true) return null;

    let offer = await client.getDaemonPairingOffer({
      timeout: PAIRING_DAEMON_RPC_TIMEOUT_MS,
    });
    if (!offer.relayEnabled && enableRelay) {
      if (serverInfo.features.relayConfig !== true) {
        throw new Error("Update the Paseo daemon before enabling relay from this command.");
      }
      await client.patchDaemonConfig({ relay: { enabled: true } });
      offer = await client.getDaemonPairingOffer({
        timeout: PAIRING_DAEMON_RPC_TIMEOUT_MS,
      });
    }
    return {
      relayEnabled: offer.relayEnabled,
      url: offer.url || null,
      qr: offer.qr ?? null,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function confirmRelayPairing(): Promise<boolean> {
  log.message("Your connection is end-to-end encrypted. Paseo cannot read your code or messages.");
  log.message(`Learn how it works: ${RELAY_DOCS_URL}`);
  const answer = await confirm({
    message: "Enable relay to pair a device?",
    initialValue: false,
  });
  return !isCancel(answer) && answer;
}

export function printDirectConnectionGuidance(): void {
  console.log("Daemon is running with relay off.");
  console.log(
    "To connect another device directly, use the daemon's TCP address over your LAN, Tailscale, or another VPN.",
  );
  console.log(`Learn more: ${RELAY_DOCS_URL}#direct-connections`);
}

export async function runPairCommand(
  options: PairOptions,
  dependencyOverrides: Partial<PairCommandDependencies> = {},
): Promise<void> {
  if (options.home) process.env.PASEO_HOME = options.home;
  const dependencies: PairCommandDependencies = {
    resolveOffer: resolveLocalPairingOffer,
    confirmRelay: confirmRelayPairing,
    printDirectGuidance: printDirectConnectionGuidance,
    isInteractive: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
    ...dependencyOverrides,
  };

  const paseoHome = resolvePaseoHome();
  let pairing = await dependencies.resolveOffer({
    paseoHome,
    enableRelay: options.relay === true,
  });

  const canPrompt = dependencies.isInteractive() && options.json !== true;
  if (!pairing.relayEnabled && canPrompt) {
    const shouldEnable = await dependencies.confirmRelay();
    if (!shouldEnable) {
      dependencies.printDirectGuidance();
      console.error(chalk.yellow("No pairing QR was created."));
      process.exitCode = 1;
      return;
    }
    pairing = await dependencies.resolveOffer({ paseoHome, enableRelay: true });
    log.success("Relay enabled");
  }

  outputPairingResult(pairing, options);
}

function outputPairingResult(pairing: PairingOffer, options: PairOptions): void {
  if (!pairing.relayEnabled || !pairing.url) {
    if (options.json) {
      process.stderr.write(
        `${JSON.stringify({
          code: "RELAY_DISABLED",
          message: "Relay pairing is disabled for this daemon.",
          action: "Run paseo daemon pair --relay --json to enable it explicitly.",
        })}\n`,
      );
    } else {
      console.error(chalk.red("Relay pairing is disabled for this daemon."));
      console.error(chalk.yellow("Run paseo daemon pair --relay to enable it."));
    }
    process.exitCode = 1;
    return;
  }

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        { relayEnabled: pairing.relayEnabled, url: pairing.url, qr: pairing.qr },
        null,
        2,
      )}\n`,
    );
    return;
  }

  process.stdout.write(
    formatPairingInstructions({
      url: pairing.url,
      qr: pairing.qr,
      columns: process.stdout.columns,
    }),
  );
}
