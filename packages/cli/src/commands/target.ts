import { Command } from "commander";
import { parseConnectionOfferFromUrl } from "@getpaseo/protocol/connection-offer";
import { normalizeHostPort } from "@getpaseo/protocol/daemon-endpoints";
import { resolvePaseoHome } from "@getpaseo/server";
import {
  clearDefaultDaemonTarget,
  readDefaultDaemonTarget,
  saveDefaultDaemonTarget,
} from "../utils/client-target.js";
import { normalizeDaemonHost, resolveDaemonTarget } from "../utils/client.js";

interface TargetCommandOptions {
  home?: string;
  json?: boolean;
}

function resolveCommandHome(options: TargetCommandOptions): string {
  return resolvePaseoHome(
    options.home ? { ...process.env, PASEO_HOME: options.home } : process.env,
  );
}

function targetOptions(command: Command): TargetCommandOptions {
  return command.optsWithGlobals<TargetCommandOptions>();
}

function printTargetResult(
  result: { target: string | null; configured: boolean },
  options: TargetCommandOptions,
): void {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (result.target) {
    process.stdout.write(`${result.target}\n`);
    return;
  }

  process.stdout.write("local daemon discovery\n");
}

export function normalizeDefaultDaemonTarget(rawTarget: string): string {
  const target = rawTarget.trim();
  if (!target) {
    throw new Error("Daemon target cannot be empty");
  }

  try {
    if (parseConnectionOfferFromUrl(target)) {
      return target;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid pairing offer URL: ${message}`, { cause: error });
  }

  if (target.includes("://") && !/^(tcp|unix|pipe):\/\//.test(target)) {
    throw new Error(
      "Invalid daemon target. Use host:port, tcp://host:port, a socket path, or a pairing offer URL.",
    );
  }

  const normalized = normalizeDaemonHost(target);
  if (!normalized) {
    throw new Error(
      "Invalid daemon target. Use host:port, tcp://host:port, a socket path, or a pairing offer URL.",
    );
  }
  if (
    !normalized.startsWith("tcp://") &&
    !normalized.startsWith("unix://") &&
    !normalized.startsWith("pipe://")
  ) {
    return normalizeHostPort(normalized);
  }
  resolveDaemonTarget(normalized);
  return normalized;
}

export function createTargetCommand(): Command {
  const target = new Command("target").description(
    "Manage the default daemon target for CLI commands",
  );

  target
    .command("set")
    .description("Use one daemon by default for CLI commands")
    .argument("<target>", "host:port, tcp:// URI, socket path, or pairing offer URL")
    .option("--home <path>", "Paseo home directory (default: ~/.paseo)")
    .action((rawTarget: string, _options: TargetCommandOptions, command: Command) => {
      const options = targetOptions(command);
      const normalized = normalizeDefaultDaemonTarget(rawTarget);
      saveDefaultDaemonTarget(resolveCommandHome(options), normalized);
      printTargetResult({ target: normalized, configured: true }, options);
    });

  target
    .command("show")
    .description("Show the default CLI daemon target")
    .option("--home <path>", "Paseo home directory (default: ~/.paseo)")
    .action((_options: TargetCommandOptions, command: Command) => {
      const options = targetOptions(command);
      const configured = readDefaultDaemonTarget(resolveCommandHome(options));
      printTargetResult({ target: configured, configured: configured !== null }, options);
    });

  target
    .command("clear")
    .description("Return CLI commands to local daemon discovery")
    .option("--home <path>", "Paseo home directory (default: ~/.paseo)")
    .action((_options: TargetCommandOptions, command: Command) => {
      const options = targetOptions(command);
      clearDefaultDaemonTarget(resolveCommandHome(options));
      printTargetResult({ target: null, configured: false }, options);
    });

  return target;
}
