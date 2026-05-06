import { useCallback, useState } from "react";
import type { MutableDaemonConfigPatch } from "@server/shared/messages";
import { ACP_PROVIDER_CATALOG, type AcpProviderCatalogEntry } from "@/data/acp-provider-catalog";

export type AcpProviderCatalogItem = AcpProviderCatalogEntry;

export function getAcpProviderCatalog(): AcpProviderCatalogItem[] {
  return ACP_PROVIDER_CATALOG;
}

export function buildAcpProviderConfigPatch(
  entry: AcpProviderCatalogItem,
): MutableDaemonConfigPatch {
  return {
    providers: {
      [entry.id]: {
        extends: "acp",
        label: entry.title,
        description: entry.description,
        command: [...entry.command],
        env: entry.env ? { ...entry.env } : {},
      },
    },
  };
}

export function useAcpProviderCatalog() {
  const [entries] = useState<AcpProviderCatalogItem[]>(ACP_PROVIDER_CATALOG);

  const refetch = useCallback(async () => entries, [entries]);

  return { entries, loading: false, error: null, refetch };
}
