import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";

export type ModelBrowserView =
  | { kind: "all" }
  | { kind: "provider"; providerId: string; providerLabel: string };

export function resolveInitialModelBrowserView({
  providers,
  selectedProvider,
  selectedModel,
  favoriteKeys,
}: {
  providers: ProviderSelectorProvider[];
  selectedProvider: string;
  selectedModel: string;
  favoriteKeys: Set<string>;
}): ModelBrowserView {
  const singleProvider = providers.length === 1 ? providers[0] : undefined;
  if (singleProvider) {
    return {
      kind: "provider",
      providerId: singleProvider.id,
      providerLabel: singleProvider.label,
    };
  }

  const selectedFavoriteKey = `${selectedProvider}:${selectedModel}`;
  const shouldOpenSelectedProvider =
    selectedProvider.length > 0 &&
    selectedModel.length > 0 &&
    !favoriteKeys.has(selectedFavoriteKey);
  if (shouldOpenSelectedProvider) {
    const provider = providers.find((entry) => entry.id === selectedProvider);
    if (provider) {
      return { kind: "provider", providerId: provider.id, providerLabel: provider.label };
    }
  }

  return { kind: "all" };
}
