import { addLocalDaemonOptions } from "../utils/command-options.js";
import { cancel, confirm, intro, isCancel, log, note, outro } from "@clack/prompts";
import { Command, Option } from "commander";
import path from "node:path";
import {
  readPersistedConfig as loadPersistedConfig,
  savePersistedConfig,
  readDaemonInstance,
  waitForDaemonReady,
  type PersistedConfig,
} from "@getpaseo/server";
import { withGlobalOptions } from "../utils/command-options.js";
import type { CommandOptions } from "../output/index.js";
import { launchLocalDaemon, parseTimeoutMs } from "./daemon/local-daemon.js";
import { connectToDaemon } from "../utils/client.js";
import { formatPairingInstructions } from "../output/pairing.js";
import {
  confirmRelayPairing,
  printDirectConnectionGuidance,
  resolveLocalPairingOffer,
} from "./daemon/pair.js";

interface OnboardOptions extends CommandOptions {
  port?: string;
  listen?: string;
  relay?: boolean;
  mcp?: boolean;
  hostnames?: string;
  timeout?: string;
  voice?: "ask" | "enable" | "disable";
}

type RawOnboardOptions = OnboardOptions & {
  allowedHosts?: string;
};

type OnboardPersistedConfig = PersistedConfig & {
  features?: PersistedConfig["features"] & {
    dictation?: PersistedConfig["features"] extends { dictation?: infer T }
      ? T & { enabled?: boolean }
      : { enabled?: boolean };
    voiceMode?: PersistedConfig["features"] extends { voiceMode?: infer T }
      ? T & { enabled?: boolean }
      : { enabled?: boolean };
  };
};

class OnboardCancelledError extends Error {}
const plainNoteFormat = (line: string): string => line;
function renderNote(message: string, title: string): void {
  note(message, title, { format: plainNoteFormat });
}

function applyVoiceSelection(
  config: OnboardPersistedConfig,
  enabled: boolean,
): OnboardPersistedConfig {
  return {
    ...config,
    features: {
      ...config.features,
      dictation: {
        ...config.features?.dictation,
        enabled,
      },
      voiceMode: {
        ...config.features?.voiceMode,
        enabled,
      },
    },
  };
}

function resolvePersistedVoiceSelection(config: OnboardPersistedConfig): boolean | null {
  const voiceModeEnabled = config.features?.voiceMode?.enabled;
  if (typeof voiceModeEnabled === "boolean") {
    return voiceModeEnabled;
  }

  const dictationEnabled = config.features?.dictation?.enabled;
  if (typeof dictationEnabled === "boolean") {
    return dictationEnabled;
  }

  return null;
}

async function resolveVoiceSelection(mode: OnboardOptions["voice"]): Promise<boolean> {
  if (mode === "enable") {
    return true;
  }
  if (mode === "disable") {
    return false;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    log.message("Non-interactive terminal detected; voice setup defaults to disabled.");
    return false;
  }

  const answer = await confirm({
    message: "Enable voice features? (downloads local STT/TTS models in background)",
    active: "Yes",
    inactive: "No",
    initialValue: false,
  });

  if (isCancel(answer)) {
    throw new OnboardCancelledError("Onboarding cancelled by user.");
  }

  return answer;
}

function printNextSteps(pairingUrl: string | null, paseoHome: string, richUi: boolean): void {
  const daemonLogPath = path.join(paseoHome, "daemon.log");
  const nextStepsLines = [
    pairingUrl
      ? "1. Open Paseo and scan the QR code above, or paste the pairing link."
      : "1. Open Paseo and connect to your daemon.",
    "2. Web app: https://app.paseo.sh",
    "3. Desktop app: https://github.com/getpaseo/paseo/releases/latest",
    "4. Docs: https://paseo.sh/docs",
    `5. Example: paseo run --home ${JSON.stringify(paseoHome)} --output-schema schema.json "extract fields"`,
  ];
  const quickReferenceLines = [
    "1. paseo --help",
    `2. paseo ls --home ${JSON.stringify(paseoHome)}`,
    `3. paseo run --home ${JSON.stringify(paseoHome)} "your prompt"`,
    `4. paseo status --home ${JSON.stringify(paseoHome)}`,
    `5. Daemon logs: ${daemonLogPath}`,
  ];

  if (!richUi) {
    console.log("");
    console.log("Next steps:");
    for (const line of nextStepsLines) {
      console.log(line);
    }
    console.log("");
    console.log("CLI quick reference:");
    for (const line of quickReferenceLines) {
      console.log(line);
    }
    return;
  }

  renderNote(nextStepsLines.join("\n"), "Next steps");
  renderNote(quickReferenceLines.join("\n"), "CLI quick reference");
}

export function onboardCommand(): Command {
  return addLocalDaemonOptions(new Command("onboard"))
    .description("Run first-time setup, start daemon, and print pairing instructions")
    .option("--listen <listen>", "Listen target (host:port, port, or unix socket path)")
    .option("--port <port>", "Port to listen on (default: 6767)")
    .option("--relay", "Enable relay connection without prompting")
    .option("--no-relay", "Disable relay connection")
    .option("--no-mcp", "Disable the Agent MCP HTTP endpoint")
    .option(
      "--hostnames <hosts>",
      'Daemon hostnames (comma-separated, e.g. "myhost,.example.com" or "true" for any)',
    )
    .addOption(new Option("--allowed-hosts <hosts>").hideHelp())
    .option("--timeout <seconds>", "Max time to wait for daemon readiness (default: 600)")
    .option("--voice <mode>", "Voice setup mode: ask, enable, disable", "ask")
    .action(
      withGlobalOptions(async (options: RawOnboardOptions, command: Command) => {
        await runOnboard({
          ...options,
          mcp: command.getOptionValueSource("mcp") === "cli" ? options.mcp : undefined,
          hostnames: options.hostnames ?? options.allowedHosts,
        });
      }),
    );
}

async function resolveAndPersistVoice(
  paseoHome: string,
  options: OnboardOptions,
): Promise<boolean> {
  let persisted = loadPersistedConfig(paseoHome) as OnboardPersistedConfig;
  const persistedVoiceSelection = resolvePersistedVoiceSelection(persisted);
  const shouldPrompt = options.voice === "ask" || options.voice === undefined;
  let voiceEnabled: boolean;
  try {
    voiceEnabled =
      shouldPrompt && persistedVoiceSelection !== null
        ? persistedVoiceSelection
        : await resolveVoiceSelection(options.voice);
  } catch (error) {
    if (error instanceof OnboardCancelledError) {
      cancel("Onboarding cancelled.");
      process.exit(0);
    }
    throw error;
  }

  if (shouldPrompt && persistedVoiceSelection !== null) {
    log.message(`Using saved voice setup from config (${voiceEnabled ? "enabled" : "disabled"}).`);
  }

  persisted = applyVoiceSelection(persisted, voiceEnabled);
  savePersistedConfig(paseoHome, persisted);
  return voiceEnabled;
}

function persistSetupChoices(paseoHome: string, options: OnboardOptions): void {
  const persisted = loadPersistedConfig(paseoHome, { defaultsIfMissing: true });
  if (options.listen || options.port) {
    persisted.daemon = {
      ...persisted.daemon,
      listen: options.listen ?? `127.0.0.1:${options.port}`,
    };
  }
  if (options.relay !== undefined)
    persisted.daemon = {
      ...persisted.daemon,
      relay: { ...persisted.daemon?.relay, enabled: options.relay },
    };
  if (options.mcp !== undefined)
    persisted.daemon = {
      ...persisted.daemon,
      mcp: { ...persisted.daemon?.mcp, enabled: options.mcp },
    };
  if (options.hostnames)
    persisted.daemon = {
      ...persisted.daemon,
      hostnames: options.hostnames === "true" ? true : options.hostnames.split(","),
    };
  savePersistedConfig(paseoHome, persisted);
}

export async function runOnboard(options: OnboardOptions): Promise<void> {
  const richUi = process.stdin.isTTY && process.stdout.isTTY;
  if (richUi) {
    intro("Welcome to Paseo");
  }

  if (options.listen && options.port) {
    cancel("Cannot use --listen and --port together");
    process.exit(1);
  }

  const timeoutMs = parseTimeoutMs(options.timeout);

  if (options.daemonTarget.kind !== "instance") throw new Error("Onboarding requires a local home");
  const paseoHome = options.daemonTarget.home;
  const alreadyRunning = await readDaemonInstance(paseoHome);
  persistSetupChoices(paseoHome, options);
  if (richUi) {
    renderNote(paseoHome, "Paseo home");
  }

  const voiceEnabled = await resolveAndPersistVoice(paseoHome, options);
  log.message(
    voiceEnabled
      ? "Voice features enabled. Local speech models will be downloaded automatically if missing."
      : "Voice features disabled. Local speech models will not be downloaded.",
  );

  if (alreadyRunning) {
    log.message(`Daemon already running (PID ${alreadyRunning.pid}); retaining its supervisor.`);
    const client = await connectToDaemon({ target: options.daemonTarget, timeout: timeoutMs });
    try {
      log.message(JSON.stringify(await client.reloadDaemonConfig()));
    } finally {
      await client.close();
    }
  } else {
    await launchLocalDaemon({ home: paseoHome, timeoutMs });
  }
  const ready = await waitForDaemonReady(paseoHome, { timeoutMs });
  log.message(`Daemon ready on ${ready.listen}`);

  if (options.relay === false) {
    log.message("Relay pairing skipped because --no-relay was provided.");
    printNextSteps(null, paseoHome, richUi);
    if (richUi) outro("Paseo daemon is running.");
    return;
  }

  let pairing = await resolveLocalPairingOffer({
    paseoHome,
    enableRelay: options.relay === true,
  });

  if (!pairing.relayEnabled) {
    const shouldEnable = richUi ? await confirmRelayPairing() : false;
    if (!shouldEnable) {
      printDirectConnectionGuidance();
      printNextSteps(null, paseoHome, richUi);
      if (richUi) outro("Paseo daemon is running.");
      return;
    }
    pairing = await resolveLocalPairingOffer({ paseoHome, enableRelay: true });
    log.success("Relay enabled");
  }

  if (!pairing.url) {
    log.warn("Relay pairing URL is unavailable for this daemon configuration.");
    printNextSteps(null, paseoHome, richUi);
    if (richUi) {
      outro("Paseo daemon is running.");
    }
    return;
  }

  process.stdout.write(
    formatPairingInstructions({
      url: pairing.url,
      qr: pairing.qr,
      columns: process.stdout.columns,
    }),
  );
  printNextSteps(pairing.url, paseoHome, richUi);
  if (richUi) {
    outro("Paseo is ready!");
  }
}
