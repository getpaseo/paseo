import { stripVTControlCharacters } from "node:util";
import type { ProviderUpdateCheck } from "@getpaseo/plugin/server/provider";
import { execCommand } from "../../../../utils/spawn.js";
import type { AgentClientInstallation } from "../../agent-sdk-types.js";
import {
  createProviderEnvSpec,
  type ProviderRuntimeSettings,
} from "../../provider-launch-config.js";
import { createCliInstallation, type InstalledCli } from "../cli-installation.js";
import { updatedForNewAgents } from "../update-command.js";

const OMP_INSTALL_URL = "https://github.com/can1357/oh-my-pi#install";

/**
 * Reads the answer of `omp update --check`, which asks the release source `omp update` installs
 * from. Anything else it prints, such as an install that another tool keeps up to date, is
 * reported as is.
 */
export function readOmpUpdateCheck(output: string): ProviderUpdateCheck {
  const text = stripVTControlCharacters(output).trim();
  const available = /New version available:\s*(\S+)/.exec(text)?.[1];
  if (available) return { status: "available", versions: [available] };
  if (/Already up to date/i.test(text)) return { status: "current" };
  return { status: "unknown", message: text || "omp update --check printed nothing" };
}

async function checkOmpForUpdates(input: {
  cli: InstalledCli;
  runtimeSettings: ProviderRuntimeSettings | undefined;
  signal: AbortSignal;
}): Promise<ProviderUpdateCheck> {
  const { stdout, stderr } = await execCommand(
    input.cli.command,
    [...input.cli.args, "update", "--check"],
    {
      ...createProviderEnvSpec({ runtimeSettings: input.runtimeSettings }),
      timeout: 20_000,
      signal: input.signal,
    },
  );
  return readOmpUpdateCheck(`${stdout}\n${stderr}`);
}

export function createOmpInstallation(
  runtimeSettings: ProviderRuntimeSettings | undefined,
): AgentClientInstallation {
  return createCliInstallation({
    name: "Oh My Pi",
    defaultBinary: "omp",
    runtimeSettings,
    installUrl: OMP_INSTALL_URL,
    updateUrl: OMP_INSTALL_URL,
    // `omp --version` prints `omp/18.6.1`.
    versionLabel: (output) =>
      output
        .split("\n")[0]
        ?.trim()
        .replace(/^omp\//, "") || undefined,
    checkForUpdates: ({ cli, signal }) => checkOmpForUpdates({ cli, runtimeSettings, signal }),
    update: { args: ["update"], successMessage: updatedForNewAgents("Oh My Pi") },
  });
}
