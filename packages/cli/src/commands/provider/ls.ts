import type { Command } from "commander";
import type { CommandOptions, ListResult, OutputSchema } from "../../output/index.js";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { connectToDaemon } from "../../utils/client.js";

export interface ProviderListItem {
  provider: ProviderSnapshotEntry["provider"];
  label: string;
  status: string;
  enabled: boolean;
  defaultMode: string;
  modes: Array<{ id: string; label: string }>;
}

/** Schema for provider ls output */
export const providerLsSchema: OutputSchema<ProviderListItem> = {
  idField: "provider",
  columns: [
    { header: "PROVIDER", field: "provider", width: 12 },
    { header: "LABEL", field: "label", width: 16 },
    {
      header: "STATUS",
      field: "status",
      width: 12,
      color: (value) => {
        if (value === "available") return "green";
        if (value === "unavailable") return "red";
        return undefined;
      },
    },
    { header: "ENABLED", field: (item) => (item.enabled ? "Enabled" : "Disabled"), width: 10 },
    { header: "DEFAULT MODE", field: "defaultMode", width: 14 },
    {
      header: "MODES",
      field: (item) => item.modes.map((mode) => mode.label).join(", "),
      width: 30,
    },
  ],
};

export type ProviderLsResult = ListResult<ProviderListItem>;

export interface ProviderLsOptions extends CommandOptions {
  host?: string;
}

export async function runLsCommand(
  options: ProviderLsOptions,
  _command: Command,
): Promise<ProviderLsResult> {
  const client = await connectToDaemon({ target: options.daemonTarget });

  try {
    const snapshot = await client.getProvidersSnapshot();
    return {
      type: "list",
      data: snapshot.entries.map((entry) => ({
        provider: entry.provider,
        label: entry.label ?? entry.provider,
        status: entry.status === "ready" ? "available" : entry.status,
        enabled: entry.enabled,
        defaultMode: entry.defaultModeId ?? "default",
        modes: (entry.modes ?? []).map(({ id, label }) => ({ id, label })),
      })),
      schema: providerLsSchema,
    };
  } finally {
    await client.close().catch(() => {});
  }
}
