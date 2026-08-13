import type { AgentModelDefinition, AgentProvider } from "@getpaseo/protocol/agent-types";
import type { ProviderProfileModel } from "@getpaseo/protocol/provider-config";
import { filterSelectableModels } from "@/provider-selection/model-catalog";

export interface ProviderDiscoveredModelsCache {
  serverId: string;
  provider: string;
  models: AgentModelDefinition[];
}

export interface ResolveProviderDiscoveredModelsInput {
  serverId: string;
  provider: string;
  currentModels: AgentModelDefinition[] | undefined;
  providerSnapshotRefreshing: boolean;
  previousCache: ProviderDiscoveredModelsCache | null;
  configuredModels?: ProviderProfileModel[];
}

export interface ResolveProviderDiscoveredModelsResult {
  models: AgentModelDefinition[];
  cache: ProviderDiscoveredModelsCache | null;
}

export function resolveProviderDiscoveredModels({
  serverId,
  provider,
  currentModels,
  providerSnapshotRefreshing,
  previousCache,
  configuredModels = [],
}: ResolveProviderDiscoveredModelsInput): ResolveProviderDiscoveredModelsResult {
  const selectableModels = filterSelectableModels(currentModels ?? null) ?? [];
  const mergedById = new Map(selectableModels.map((model) => [model.id, model]));
  for (const model of configuredModels) {
    const existing = mergedById.get(model.id);
    mergedById.set(model.id, {
      ...(existing ?? { provider: provider as AgentProvider }),
      ...model,
      provider: existing?.provider ?? (provider as AgentProvider),
    });
  }
  const mergedModels = [...mergedById.values()];
  if (mergedModels.length > 0) {
    const cache = { serverId, provider, models: mergedModels };
    return { models: mergedModels, cache };
  }

  if (
    providerSnapshotRefreshing &&
    previousCache?.serverId === serverId &&
    previousCache.provider === provider
  ) {
    return { models: previousCache.models, cache: previousCache };
  }

  return { models: [], cache: previousCache };
}
