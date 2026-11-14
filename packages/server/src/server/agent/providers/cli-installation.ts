import type { ProviderUpdateCheck } from "@getpaseo/plugin/server/provider";
import type { AgentClientInstallation } from "../agent-sdk-types.js";
import {
  checkProviderLaunchAvailable,
  createProviderEnv,
  createProviderEnvSpec,
  resolveProviderLaunch,
  type ProviderRuntimeSettings,
} from "../provider-launch-config.js";
import { readCommandVersionOutput } from "./diagnostic-utils.js";
import { runUpdateCommand } from "./update-command.js";

/** The provider's CLI as configured, found on the provider's PATH. */
export interface InstalledCli {
  /** The resolved executable. */
  command: string;
  /** Arguments the configuration puts before any subcommand. */
  args: string[];
  env: Record<string, string> | undefined;
}

export interface CliInstallationOptions {
  /** The product name used in messages, such as "Copilot". */
  name: string;
  defaultBinary: string;
  runtimeSettings: ProviderRuntimeSettings | undefined;
  installUrl: string;
  updateUrl?: string;
  /** The version shown for the CLI's `--version` output. Defaults to its first line. */
  versionLabel?(output: string): string | undefined;
  /** Asks the source the CLI's own updater asks. Left out when that source is not known. */
  checkForUpdates?(input: {
    cli: InstalledCli;
    version: string | undefined;
    signal: AbortSignal;
  }): Promise<ProviderUpdateCheck>;
  /** The CLI's own update command. Left out when the CLI cannot update itself. */
  update?: { args: string[]; successMessage: string };
}

function firstLine(output: string): string | undefined {
  return output.split("\n")[0]?.trim() || undefined;
}

/**
 * The installation contract for a provider whose CLI reports its version with `--version` and,
 * where it can, updates itself with a subcommand.
 */
export function createCliInstallation(options: CliInstallationOptions): AgentClientInstallation {
  const { name, runtimeSettings } = options;
  const versionLabel = options.versionLabel ?? firstLine;

  async function resolveCli(): Promise<InstalledCli | null> {
    const launch = await resolveProviderLaunch({
      commandConfig: runtimeSettings?.command,
      defaultBinary: options.defaultBinary,
    });
    // The agent spawn looks the bare command up on the provider's PATH; find it the same way.
    const availability = await checkProviderLaunchAvailable({
      ...launch,
      env: createProviderEnv({ runtimeSettings }),
    });
    if (!availability.available) return null;
    return {
      command: availability.resolvedPath ?? launch.command,
      args: [...launch.args],
      env: runtimeSettings?.env,
    };
  }

  async function readVersion(cli: InstalledCli, signal: AbortSignal): Promise<string | undefined> {
    const output = await readCommandVersionOutput({
      command: cli.command,
      args: [...cli.args, "--version"],
      env: cli.env,
      signal,
    });
    return versionLabel(output);
  }

  const installation: AgentClientInstallation = {
    installUrl: options.installUrl,
    async inspect({ signal }) {
      const cli = await resolveCli();
      if (!cli) return { status: "not_installed" };
      const version = await readVersion(cli, signal);
      return version ? { status: "installed", version } : { status: "installed" };
    },
  };
  if (options.updateUrl) installation.updateUrl = options.updateUrl;

  const checkForUpdates = options.checkForUpdates;
  if (checkForUpdates) {
    installation.checkForUpdates = async ({ signal }) => {
      const cli = await resolveCli();
      if (!cli) return { status: "unknown", message: `${name} is not installed` };
      return checkForUpdates({ cli, version: await readVersion(cli, signal), signal });
    };
  }

  const update = options.update;
  if (update) {
    installation.update = async (context) => {
      const cli = await resolveCli();
      if (!cli) return { status: "failed", message: `${name} is not installed` };
      return runUpdateCommand(
        {
          command: cli.command,
          args: [...cli.args, ...update.args],
          env: createProviderEnvSpec({ runtimeSettings }),
          successMessage: update.successMessage,
        },
        context,
      );
    };
  }
  return installation;
}
