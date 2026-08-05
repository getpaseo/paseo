import type { Command } from "commander";
import type { SingleResult } from "../../output/index.js";
import {
  connectPluginClient,
  pluginSchema,
  toPluginCommandError,
  toPluginRow,
  type PluginCommandOptions,
  type PluginRow,
} from "./shared.js";

export async function runInstallCommand(
  id: string,
  options: PluginCommandOptions,
  _command: Command,
): Promise<SingleResult<PluginRow>> {
  const client = await connectPluginClient(options.host);
  try {
    const payload = await client.pluginsInstall({ pluginId: id });
    if (payload.error || !payload.plugin) {
      throw new Error(payload.error ?? `Failed to install plugin: ${id}`);
    }
    return {
      type: "single",
      data: toPluginRow(payload.plugin),
      schema: pluginSchema,
    };
  } catch (error) {
    throw toPluginCommandError("PLUGIN_INSTALL_FAILED", `install plugin ${id}`, error);
  } finally {
    await client.close().catch(() => {});
  }
}
