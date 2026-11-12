import { useCallback, useState } from "react";
import type { MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";
import { ACP_PROVIDER_CATALOG, type AcpProviderCatalogEntry } from "@/data/acp-provider-catalog";
import type { HostFeatureName } from "@/runtime/host-features";

export type AcpProviderCatalogItem = AcpProviderCatalogEntry;

export function getAcpProviderCatalog(): AcpProviderCatalogItem[] {
  return ACP_PROVIDER_CATALOG;
}

export function buildAcpProviderConfigPatch(
  entry: AcpProviderCatalogItem,
  hostSupports: (feature: HostFeatureName) => boolean = () => false,
): MutableDaemonConfigPatch {
  if (entry.bundledProvider) {
    // COMPAT(hopliteProvider): added after v0.11.2, remove after 2027-04-15 once host floor includes the bundled adapter.
    // COMPAT(fxProvider): added after v0.15.3, remove after 2027-05-09 once host floor includes the bundled adapter.
    if (!hostSupports(entry.bundledProvider.hostFeature)) {
      throw new Error(`Update the host to add ${entry.title}.`);
    }
    return { providers: { [entry.id]: { enabled: true } } };
  }
  return {
    providers: {
      [entry.id]: {
        extends: "acp",
        label: entry.title,
        description: entry.description,
        command: [...entry.command],
        env: entry.env ? { ...entry.env } : {},
        ...(entry.params ? { params: { ...entry.params } } : {}),
      },
    },
  };
}

export function useAcpProviderCatalog() {
  const [entries] = useState<AcpProviderCatalogItem[]>(ACP_PROVIDER_CATALOG);

  const refetch = useCallback(async () => entries, [entries]);

  return { entries, loading: false, error: null, refetch };
}
