import type { Command } from "commander";
import type { OutputSchema, SingleResult } from "../../output/index.js";
import { connectPluginClient, toPluginCommandError, type PluginCommandOptions } from "./shared.js";

export interface PluginUninstallRow {
  id: string;
  status: string;
}

const uninstallSchema: OutputSchema<PluginUninstallRow> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id", width: 24 },
    { header: "STATUS", field: "status", width: 14 },
  ],
};

export async function runUninstallCommand(
  id: string,
  options: PluginCommandOptions,
  _command: Command,
): Promise<SingleResult<PluginUninstallRow>> {
  const client = await connectPluginClient(options.host);
  try {
    const payload = await client.pluginsUninstall({ pluginId: id });
    if (payload.error) {
      throw new Error(payload.error);
    }
    return {
      type: "single",
      data: { id: payload.pluginId, status: "uninstalled" },
      schema: uninstallSchema,
    };
  } catch (error) {
    throw toPluginCommandError("PLUGIN_UNINSTALL_FAILED", `uninstall plugin ${id}`, error);
  } finally {
    await client.close().catch(() => {});
  }
}
