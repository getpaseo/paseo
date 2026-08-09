import type { AgentModelDefinition } from "@getpaseo/protocol/agent-types";

export function findModelByReference(
  models: AgentModelDefinition[] | null,
  modelId: string,
): AgentModelDefinition | null {
  if (!models || models.length === 0) return null;
  const normalizedModelId = modelId.trim();
  if (!normalizedModelId) return null;
  return (
    models.find((model) => model.id === normalizedModelId) ??
    models.find((model) => model.aliases?.includes(normalizedModelId)) ??
    null
  );
}

export function filterSelectableModels(
  models: AgentModelDefinition[] | null,
): AgentModelDefinition[] | null {
  return models?.filter((model) => model.isSelectable !== false) ?? null;
}
