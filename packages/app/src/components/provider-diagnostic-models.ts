import type { AgentModelDefinition } from "@getpaseo/protocol/agent-types";
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

export interface SubagentPolicyModel {
  id: string;
  label: string;
  available: boolean;
}

export function buildSubagentPolicyModels({
  discoveredModels,
  additionalModels,
  allowedModels,
  guidance,
}: {
  discoveredModels: AgentModelDefinition[];
  additionalModels: ProviderProfileModel[];
  allowedModels?: string[];
  guidance?: Record<string, string>;
}): SubagentPolicyModel[] {
  const models = new Map<string, SubagentPolicyModel>();
  for (const model of [...discoveredModels, ...additionalModels]) {
    models.set(model.id, { id: model.id, label: model.label, available: true });
  }
  for (const id of [...(allowedModels ?? []), ...Object.keys(guidance ?? {})]) {
    if (!models.has(id)) {
      models.set(id, { id, label: id, available: false });
    }
  }
  return [...models.values()];
}

export function isSubagentModelAllowed(modelId: string, allowedModels?: string[]): boolean {
  return !allowedModels?.length || allowedModels.includes(modelId);
}

export function getNextSubagentAllowedModels({
  modelId,
  allowedModels,
  availableModelIds,
  allowed,
}: {
  modelId: string;
  allowedModels?: string[];
  availableModelIds: string[];
  allowed: boolean;
}): string[] | null {
  const currentAllowed = allowedModels?.length ? [...new Set(allowedModels)] : null;
  if (allowed) {
    return currentAllowed ? [...new Set([...currentAllowed, modelId])] : null;
  }

  const nextAllowed = currentAllowed
    ? currentAllowed.filter((id) => id !== modelId)
    : availableModelIds.filter((id) => id !== modelId);
  return nextAllowed.length > 0 ? nextAllowed : null;
}
