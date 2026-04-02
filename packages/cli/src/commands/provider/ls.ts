import type { Command } from "commander";
import type { CommandOptions, ListResult, OutputSchema } from "../../output/index.js";
import { AGENT_PROVIDER_DEFINITIONS } from "@getpaseo/server";

/** Provider list item for display */
export interface ProviderListItem {
  provider: string;
  status: string;
  defaultMode: string;
  modes: string;
}

/** Derive provider list from the manifest — single source of truth */
const PROVIDERS: ProviderListItem[] = AGENT_PROVIDER_DEFINITIONS.map((def) => ({
  provider: def.id,
  status: "available",
  defaultMode: def.defaultModeId ?? "default",
  modes: def.modes.map((m) => m.label).join(", "),
}));

/** Schema for provider ls output */
export const providerLsSchema: OutputSchema<ProviderListItem> = {
  idField: "provider",
  columns: [
    { header: "PROVIDER", field: "provider", width: 12 },
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
    { header: "DEFAULT MODE", field: "defaultMode", width: 14 },
    { header: "MODES", field: "modes", width: 30 },
  ],
};

export type ProviderLsResult = ListResult<ProviderListItem>;

export interface ProviderLsOptions extends CommandOptions {
  host?: string;
}

export async function runLsCommand(
  _options: ProviderLsOptions,
  _command: Command,
): Promise<ProviderLsResult> {
  // Provider data is static - no daemon connection needed
  return {
    type: "list",
    data: PROVIDERS,
    schema: providerLsSchema,
  };
}
