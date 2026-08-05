import type { Command } from "commander";
import type { ListResult } from "../../output/index.js";
import {
  connectPluginClient,
  pluginSchema,
  toPluginCommandError,
  toPluginRow,
  type PluginCommandOptions,
  type PluginRow,
} from "./shared.js";

export async function runLsCommand(
  options: PluginCommandOptions,
  _command: Command,
): Promise<ListResult<PluginRow>> {
  const client = await connectPluginClient(options.host);
  try {
    const payload = await client.pluginsList();
    if (payload.error) {
      throw new Error(payload.error);
    }
    return {
      type: "list",
      data: payload.plugins.map(toPluginRow),
      schema: pluginSchema,
    };
  } catch (error) {
    throw toPluginCommandError("PLUGIN_LIST_FAILED", "list plugins", error);
  } finally {
    await client.close().catch(() => {});
  }
}
