import type { Command } from "commander";
import type { ListResult } from "../../output/index.js";
import {
  connectPluginClient,
  pluginRegistrySchema,
  toPluginCommandError,
  toPluginRegistryRow,
  type PluginCommandOptions,
  type PluginRegistryRow,
} from "./shared.js";

export interface PluginBrowseOptions extends PluginCommandOptions {
  refresh?: boolean;
}

export async function runBrowseCommand(
  options: PluginBrowseOptions,
  _command: Command,
): Promise<ListResult<PluginRegistryRow>> {
  const client = await connectPluginClient(options.host);
  try {
    const payload = await client.pluginsBrowse({ refresh: options.refresh });
    if (payload.error) {
      throw new Error(payload.error);
    }
    return {
      type: "list",
      data: payload.plugins.map(toPluginRegistryRow),
      schema: pluginRegistrySchema,
    };
  } catch (error) {
    throw toPluginCommandError("PLUGIN_BROWSE_FAILED", "browse the plugin registry", error);
  } finally {
    await client.close().catch(() => {});
  }
}
