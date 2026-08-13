import {
  filterAndRankModelRows,
  getAllProviderModelRows,
  type ProviderSelectionModelRow,
  type ProviderSelectorProvider,
} from "@/provider-selection/provider-selection";

export type ModelBrowserView =
  | { kind: "all" }
  | { kind: "provider"; providerId: string; providerLabel: string };

/** What the root view shows: the provider drill-down, or ranked cross-provider results. */
export type ModelBrowserAllView =
  | { kind: "browse" }
  | { kind: "searchResults"; rows: ProviderSelectionModelRow[] }
  | { kind: "noSearchMatches" };

export function resolveModelBrowserAllView({
  providers,
  normalizedQuery,
}: {
  providers: ProviderSelectorProvider[];
  normalizedQuery: string;
}): ModelBrowserAllView {
  if (!normalizedQuery) {
    return { kind: "browse" };
  }
  const rows = filterAndRankModelRows(getAllProviderModelRows(providers), normalizedQuery);
  if (rows.length === 0) {
    return { kind: "noSearchMatches" };
  }
  return { kind: "searchResults", rows };
}

/** Where the picker lands when it opens. A sole provider skips the redundant root view. */
export function resolveInitialModelBrowserView({
  providers,
  selectedProvider,
  selectedModel,
  hasProfiles,
}: {
  providers: ProviderSelectorProvider[];
  selectedProvider: string;
  selectedModel: string;
  hasProfiles: boolean;
}): ModelBrowserView {
  const singleProvider = providers.length === 1 ? providers[0] : undefined;
  if (singleProvider) {
    return {
      kind: "provider",
      providerId: singleProvider.id,
      providerLabel: singleProvider.label,
    };
  }

  if (hasProfiles) {
    return { kind: "all" };
  }

  if (selectedProvider.length > 0 && selectedModel.length > 0) {
    const provider = providers.find((entry) => entry.id === selectedProvider);
    if (provider) {
      return { kind: "provider", providerId: provider.id, providerLabel: provider.label };
    }
  }

  return { kind: "all" };
}
