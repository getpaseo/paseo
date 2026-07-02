import type { Command } from "commander";
import {
  renderTable,
  renderTableHeader,
  type CommandOptions,
  type ListResult,
  type OutputSchema,
} from "../../output/index.js";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  PaseoAgentCatalogEntry,
  RedactedPaseoAgentProviderConfig,
} from "@getpaseo/protocol/messages";
import { connectToDaemon } from "../../utils/client.js";
import { requirePaseoAgentCatalogFeature } from "./feature.js";

export interface ProviderListItem {
  name: string;
  providerType: string;
  label: string;
  auth: string;
  available: string;
  models: string;
}

interface ProviderLsClient extends Pick<
  DaemonClient,
  "waitForServerInfo" | "getPaseoAgentCatalog" | "getPaseoAgentProviders" | "close"
> {}

export interface ProviderLsDependencies {
  connectDaemon: (options: { host?: string }) => Promise<ProviderLsClient>;
}

const defaultDependencies: ProviderLsDependencies = {
  connectDaemon: connectToDaemon,
};

export const providerLsSchema: OutputSchema<ProviderListItem> = {
  idField: "name",
  columns: [
    { header: "NAME", field: "name", width: 20 },
    { header: "TYPE", field: "providerType", width: 16 },
    { header: "LABEL", field: "label", width: 22 },
    { header: "AUTH", field: "auth", width: 16 },
    { header: "AVAILABLE", field: "available", width: 10 },
    { header: "MODELS", field: "models", width: 30 },
  ],
  renderHuman: (result, options) => {
    if (result.type === "list" && result.data.length === 0) {
      return options.noHeaders ? "" : renderTableHeader(providerLsSchema, options);
    }
    return renderTable(result, options);
  },
};

export type ProviderLsResult = ListResult<ProviderListItem>;

export interface ProviderLsOptions extends CommandOptions {
  host?: string;
}

function authState(provider: RedactedPaseoAgentProviderConfig): string {
  if (!provider.auth) {
    return "not configured";
  }
  return provider.auth.configured ? "Connected" : "Needs attention";
}

function catalogLabel(catalog: PaseoAgentCatalogEntry[], providerType: string): string {
  return catalog.find((entry) => entry.id === providerType)?.label ?? providerType;
}

export async function runLsCommand(
  options: ProviderLsOptions,
  _command: Command,
  dependencies: Partial<ProviderLsDependencies> = {},
): Promise<ProviderLsResult> {
  const deps = { ...defaultDependencies, ...dependencies };
  const client = await deps.connectDaemon({ host: options.host });

  try {
    await requirePaseoAgentCatalogFeature(client);
    const catalogResult = await client.getPaseoAgentCatalog();
    if (catalogResult.error) {
      throw {
        code: "PROVIDER_CATALOG_FAILED",
        message: catalogResult.error,
      };
    }
    const providersResult = await client.getPaseoAgentProviders();
    if (providersResult.error) {
      throw {
        code: "PROVIDER_LIST_FAILED",
        message: providersResult.error,
      };
    }

    return {
      type: "list",
      data: providersResult.providers.map((provider) => ({
        name: provider.name,
        providerType: provider.providerType,
        label: catalogLabel(catalogResult.catalog, provider.providerType),
        auth: authState(provider),
        available: provider.available ? "yes" : "no",
        models: provider.models.map((model) => model.id).join(", ") || "-",
      })),
      schema: providerLsSchema,
    };
  } finally {
    await client.close().catch(() => {});
  }
}
