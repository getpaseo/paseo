import type { Command } from "commander";
import type { CommandOptions, ListResult, OutputSchema } from "../../output/index.js";
import { AGENT_PROVIDER_DEFINITIONS, type ProviderSnapshotEntry } from "@getpaseo/server";
import { tryConnectToDaemon } from "../../utils/client.js";

export interface ProviderListItem {
  provider: ProviderSnapshotEntry["provider"];
  label: string;
  status: string;
  enabled: "Enabled" | "Disabled";
  defaultMode: string;
  modes: string;
}

/** Derive provider list from the manifest — single source of truth */
const PROVIDERS: ProviderListItem[] = AGENT_PROVIDER_DEFINITIONS.map((def) => ({
  provider: def.id,
  label: def.label,
  status: "available",
  enabled: "Enabled",
  defaultMode: def.defaultModeId ?? "-",
  modes: def.modes.length > 0 ? def.modes.map((m) => m.label).join(", ") : "-",
}));

function getStaticProviders(): ProviderListItem[] {
  return PROVIDERS;
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
    { header: "ENABLED", field: "enabled", width: 10 },
    { header: "DEFAULT MODE", field: "defaultMode", width: 14 },
    { header: "MODES", field: "modes", width: 30 },
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
  const client = await tryConnectToDaemon({ host: options.host });

  if (!client) {
    return {
      type: "list",
      data: getStaticProviders(),
      schema: providerLsSchema,
    };
  }

  try {
    const snapshot = await client.getProvidersSnapshot();
    return {
      type: "list",
      data: snapshot.entries.map((entry) => ({
        provider: entry.provider,
        label: entry.label ?? entry.provider,
        status: entry.status === "ready" ? "available" : entry.status,
        enabled: !entry.enabled ? "Disabled" : "Enabled",
        defaultMode: entry.defaultModeId ?? "default",
        modes: (entry.modes ?? []).map((mode) => mode.label).join(", "),
      })),
      schema: providerLsSchema,
    };
  } catch {
    return {
      type: "list",
      data: getStaticProviders(),
      schema: providerLsSchema,
    };
  } finally {
    await client.close().catch(() => {});
  }
}
