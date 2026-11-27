import type { ModelBrowserView } from "@/components/model-browser-view";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";

export function resolveModelSheetOpening({
  openAtProviders,
  providers,
  selectedProvider,
}: {
  /** Drafts open at the provider list; live agents open directly at their active provider. */
  openAtProviders: boolean;
  providers: ProviderSelectorProvider[];
  selectedProvider: string;
}): ModelBrowserView {
  if (openAtProviders) return { kind: "all" };

  const provider = providers.find((entry) => entry.id === selectedProvider) ?? providers[0] ?? null;
  return provider
    ? { kind: "provider", providerId: provider.id, providerLabel: provider.label }
    : { kind: "all" };
}
