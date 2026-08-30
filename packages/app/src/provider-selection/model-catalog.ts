import type { AgentModelDefinition } from "@getpaseo/protocol/agent-types";

export function findModelByReference(
  models: AgentModelDefinition[] | null,
  modelId: string,
): AgentModelDefinition | null {
  if (!models || models.length === 0) return null;
  const normalizedModelId = modelId.trim();
  if (!normalizedModelId) return null;
  const exact = findExactModel(models, normalizedModelId);
  if (exact) return exact;

  const bracketIndex = normalizedModelId.indexOf("[");
  if (bracketIndex <= 0) return null;
  return findExactModel(models, normalizedModelId.slice(0, bracketIndex));
}

function findExactModel(
  models: AgentModelDefinition[],
  modelId: string,
): AgentModelDefinition | null {
  return (
    models.find((model) => model.id === modelId) ??
    models.find((model) => model.aliases?.includes(modelId)) ??
    null
  );
}

export function filterSelectableModels(
  models: AgentModelDefinition[] | null,
): AgentModelDefinition[] | null {
  return models?.filter((model) => model.isSelectable !== false) ?? null;
}
