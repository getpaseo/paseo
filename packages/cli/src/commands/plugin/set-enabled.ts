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

async function setEnabled(
  id: string,
  enabled: boolean,
  options: PluginCommandOptions,
): Promise<SingleResult<PluginRow>> {
  const action = enabled ? "enable" : "disable";
  const client = await connectPluginClient(options.host);
  try {
    const payload = await client.pluginsSetEnabled({ pluginId: id, enabled });
    if (payload.error || !payload.plugin) {
      throw new Error(payload.error ?? `Failed to ${action} plugin: ${id}`);
    }
    return {
      type: "single",
      data: toPluginRow(payload.plugin),
      schema: pluginSchema,
    };
  } catch (error) {
    throw toPluginCommandError(
      enabled ? "PLUGIN_ENABLE_FAILED" : "PLUGIN_DISABLE_FAILED",
      `${action} plugin ${id}`,
      error,
    );
  } finally {
    await client.close().catch(() => {});
  }
}

export async function runEnableCommand(
  id: string,
  options: PluginCommandOptions,
  _command: Command,
): Promise<SingleResult<PluginRow>> {
  return setEnabled(id, true, options);
}

export async function runDisableCommand(
  id: string,
  options: PluginCommandOptions,
  _command: Command,
): Promise<SingleResult<PluginRow>> {
  return setEnabled(id, false, options);
}
