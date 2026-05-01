import type { AgentModelDefinition } from "@server/server/agent/agent-sdk-types";
import type { AgentProviderDefinition } from "@server/server/agent/provider-manifest";
import { buildFavoriteModelKey, type FavoriteModelRow } from "@/hooks/use-form-preferences";

export type SelectorModelRow = FavoriteModelRow;

export function resolveProviderLabel(
  providerDefinitions: AgentProviderDefinition[],
  providerId: string,
): string {
  return (
    providerDefinitions.find((definition) => definition.id === providerId)?.label ?? providerId
  );
}

export function buildSelectedTriggerLabel(modelLabel: string): string {
  return modelLabel;
}

export function buildModelRows(
  providerDefinitions: AgentProviderDefinition[],
  allProviderModels: Map<string, AgentModelDefinition[]>,
): SelectorModelRow[] {
  const providerLabelMap = new Map(
    providerDefinitions.map((definition) => [definition.id, definition.label]),
  );
  const rows: SelectorModelRow[] = [];

  for (const definition of providerDefinitions) {
    const providerLabel = providerLabelMap.get(definition.id) ?? definition.label;
    for (const model of allProviderModels.get(definition.id) ?? []) {
      rows.push({
        favoriteKey: buildFavoriteModelKey({ provider: definition.id, modelId: model.id }),
        provider: definition.id,
        providerLabel,
        modelId: model.id,
        modelLabel: model.label,
        description: model.description,
        isDefault: model.isDefault,
      });
    }
  }

  return rows;
}

export function matchesSearch(row: SelectorModelRow, normalizedQuery: string): boolean {
  if (!normalizedQuery) {
    return true;
  }

  return [row.modelLabel, row.modelId, row.providerLabel].some((value) =>
    value.toLowerCase().includes(normalizedQuery),
  );
}

export function buildSuggestedRows({
  rows,
  selectedProvider,
  selectedModel,
  favoriteKeys,
}: {
  rows: SelectorModelRow[];
  selectedProvider: string;
  selectedModel: string;
  favoriteKeys: Set<string>;
}): SelectorModelRow[] {
  const suggestedRows: SelectorModelRow[] = [];
  const seenKeys = new Set<string>();

  for (const row of rows) {
    const isSelected = row.provider === selectedProvider && row.modelId === selectedModel;
    if ((!isSelected && !row.isDefault) || favoriteKeys.has(row.favoriteKey)) {
      continue;
    }

    if (!seenKeys.has(row.favoriteKey)) {
      suggestedRows.push(row);
      seenKeys.add(row.favoriteKey);
    }
  }

  return suggestedRows;
}
