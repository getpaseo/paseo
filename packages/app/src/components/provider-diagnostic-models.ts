import type { AgentModelDefinition } from "@getpaseo/protocol/agent-types";
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
}: ResolveProviderDiscoveredModelsInput): ResolveProviderDiscoveredModelsResult {
  const selectableModels = filterSelectableModels(currentModels ?? null) ?? [];
  if (selectableModels.length > 0) {
    const cache = { serverId, provider, models: selectableModels };
    return { models: selectableModels, cache };
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

export interface ProviderDiscoveredModelSection {
  key: string;
  title: string | null;
  models: AgentModelDefinition[];
  totalCount: number;
}

export interface ProviderDiscoveredModelLayout {
  sections: ProviderDiscoveredModelSection[];
  hiddenCount: number;
  totalCount: number;
}

function getModelFamily(model: AgentModelDefinition): string | null {
  const family = model.metadata?.modelFamily;
  return typeof family === "string" && family.trim() ? family.trim() : null;
}

/**
 * Groups catalogs that opt into modelFamily metadata. A collapsed layout keeps one
 * representative per family so large version and context-window families stay scannable.
 * Models without family metadata never disappear behind the disclosure.
 */
export function buildProviderDiscoveredModelLayout(
  models: readonly AgentModelDefinition[],
  options: { expanded?: boolean } = {},
): ProviderDiscoveredModelLayout {
  const groups = new Map<string, { title: string | null; models: AgentModelDefinition[] }>();
  for (const model of models) {
    const family = getModelFamily(model);
    const key = family ? `family:${family}` : "ungrouped";
    const group = groups.get(key);
    if (group) {
      group.models.push(model);
    } else {
      groups.set(key, { title: family, models: [model] });
    }
  }

  let hiddenCount = 0;
  const sections = Array.from(groups, ([key, group]) => {
    const visibleModels =
      options.expanded || group.title === null ? group.models : group.models.slice(0, 1);
    hiddenCount += group.models.length - visibleModels.length;
    return {
      key,
      title: group.title,
      models: visibleModels,
      totalCount: group.models.length,
    };
  });

  return { sections, hiddenCount, totalCount: models.length };
}
