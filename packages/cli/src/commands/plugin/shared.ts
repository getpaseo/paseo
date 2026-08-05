import type { InstalledPlugin, PluginRegistryEntry } from "@getpaseo/protocol/plugin/types";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { CommandError, CommandOptions, OutputSchema } from "../../output/index.js";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";

export interface PluginCommandOptions extends CommandOptions {
  host?: string;
}

export interface PluginRow {
  id: string;
  name: string;
  version: string;
  status: string;
  source: string;
  contributes: string;
}

export interface PluginRegistryRow {
  id: string;
  name: string;
  version: string;
  author: string;
  installs: string;
  description: string;
}

export const pluginSchema: OutputSchema<PluginRow> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id", width: 24 },
    { header: "NAME", field: "name", width: 24 },
    { header: "VERSION", field: "version", width: 10 },
    {
      header: "STATUS",
      field: "status",
      width: 14,
      color: (value) => {
        if (value === "enabled") return "green";
        if (value === "unavailable") return "red";
        return undefined;
      },
    },
    { header: "SOURCE", field: "source", width: 10 },
    { header: "CONTRIBUTES", field: "contributes", width: 30 },
  ],
};

export const pluginRegistrySchema: OutputSchema<PluginRegistryRow> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id", width: 24 },
    { header: "NAME", field: "name", width: 24 },
    { header: "VERSION", field: "version", width: 10 },
    { header: "AUTHOR", field: "author", width: 18 },
    { header: "INSTALLS", field: "installs", width: 10 },
    { header: "DESCRIPTION", field: "description", width: 40 },
  ],
};

export async function connectPluginClient(host: string | undefined): Promise<DaemonClient> {
  const resolvedHost = getDaemonHost({ host });
  try {
    return await connectToDaemon({ host });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${resolvedHost}: ${message}`,
      details: "Start the daemon with: paseo daemon start",
    } satisfies CommandError;
  }
}

export function toPluginCommandError(code: string, action: string, error: unknown): CommandError {
  if (error && typeof error === "object" && "code" in error) {
    return error as CommandError;
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    code,
    message: `Failed to ${action}: ${message}`,
  };
}

function formatStatus(plugin: InstalledPlugin): string {
  if (plugin.unavailableReason) return "unavailable";
  return plugin.enabled ? "enabled" : "disabled";
}

function formatContributions(plugin: InstalledPlugin): string {
  const { filePreviews = [], sidebarPanels = [] } = plugin.manifest.contributes;
  const parts: string[] = [];
  if (filePreviews.length > 0) {
    parts.push(`previews: ${filePreviews.flatMap((preview) => preview.extensions).join(" ")}`);
  }
  if (sidebarPanels.length > 0) {
    parts.push(`panels: ${sidebarPanels.map((panel) => panel.title).join(" ")}`);
  }
  return parts.length > 0 ? parts.join(", ") : "-";
}

export function toPluginRow(plugin: InstalledPlugin): PluginRow {
  return {
    id: plugin.manifest.id,
    name: plugin.manifest.name,
    version: plugin.manifest.version,
    status: formatStatus(plugin),
    source: plugin.source.kind,
    contributes: plugin.unavailableReason ?? formatContributions(plugin),
  };
}

export function toPluginRegistryRow(entry: PluginRegistryEntry): PluginRegistryRow {
  return {
    id: entry.manifest.id,
    name: entry.manifest.name,
    version: entry.manifest.version,
    author: entry.manifest.author ?? "-",
    installs: entry.installs == null ? "-" : `${entry.installs}`,
    description: entry.manifest.description ?? "-",
  };
}
