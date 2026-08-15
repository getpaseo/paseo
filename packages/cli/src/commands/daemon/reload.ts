import type { Command } from "commander";
import { connectToDaemon } from "../../utils/client.js";
import type { CommandOptions, OutputSchema, SingleResult } from "../../output/index.js";

export interface DaemonReloadResult {
  appliedPaths: string[];
  restartRequiredPaths: string[];
  overrideControlledPaths: string[];
}

export const daemonReloadSchema: OutputSchema<DaemonReloadResult> = {
  idField: () => "daemon-config",
  columns: [],
  renderHuman(result) {
    if (result.type !== "single") return "";
    const lines = ["Configuration reloaded."];
    if (result.data.restartRequiredPaths.length > 0) {
      lines.push(
        "",
        "Warning: These changes require a daemon restart:",
        ...result.data.restartRequiredPaths.map((path) => `  ${path}`),
        "",
        "Run: paseo daemon restart",
      );
    }
    if (result.data.overrideControlledPaths.length > 0) {
      lines.push(
        "",
        "Warning: These settings are controlled by daemon launch overrides:",
        ...result.data.overrideControlledPaths.map((path) => `  ${path}`),
      );
    }
    return lines.join("\n");
  },
};

export async function runDaemonReloadCommand(
  options: CommandOptions,
  _command: Command,
): Promise<SingleResult<DaemonReloadResult>> {
  const client = await connectToDaemon({ host: options.host });
  try {
    const payload = await client.reloadDaemonConfig();
    return {
      type: "single",
      data: {
        appliedPaths: payload.appliedPaths,
        restartRequiredPaths: payload.restartRequiredPaths,
        overrideControlledPaths: payload.overrideControlledPaths,
      },
      schema: daemonReloadSchema,
    };
  } finally {
    await client.close();
  }
}
