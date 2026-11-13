import type { ProviderUpdateResult } from "@getpaseo/plugin/server/provider";
import { spawnProcess } from "../../../utils/spawn.js";
import type { AgentClientUpdateContext } from "../agent-sdk-types.js";
import type { ProviderEnvSpec } from "../provider-launch-config.js";

export interface UpdateCommand {
  command: string;
  args: string[];
  env: ProviderEnvSpec;
  /** Shown when the command exits 0. */
  successMessage: string;
}

/** The success message for a CLI that Paseo starts once per agent. */
export function updatedForNewAgents(name: string): string {
  return `${name} is updated. New agents use the new version; running agents keep theirs until restarted.`;
}

/**
 * Runs a CLI's own updater and passes its output through unchanged. Exit code 0 is success;
 * anything else is a failure. Aborting the signal kills the command.
 */
export function runUpdateCommand(
  update: UpdateCommand,
  context: AgentClientUpdateContext,
): Promise<ProviderUpdateResult> {
  const commandLine = [update.command, ...update.args].join(" ");
  context.report({ type: "message", text: `Running ${commandLine}\n` });
  return new Promise((resolve, reject) => {
    const child = spawnProcess(update.command, update.args, {
      ...update.env,
      stdio: ["ignore", "pipe", "pipe"],
      signal: context.signal,
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (text: string) => context.report({ type: "stdout", text }));
    child.stderr?.on("data", (text: string) => context.report({ type: "stderr", text }));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve({ status: "succeeded", message: update.successMessage });
      else
        resolve({
          status: "failed",
          message:
            code === null
              ? `${commandLine} stopped by ${signal}`
              : `${commandLine} exited with code ${code}`,
        });
    });
  });
}
