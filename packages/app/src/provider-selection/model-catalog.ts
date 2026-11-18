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

export function filterListedModels(
  models: readonly AgentModelDefinition[] | null,
): AgentModelDefinition[] | null {
  return models?.filter((model) => model.isSelectable !== false) ?? null;
}

// Picker visibility must not remove metadata or invalidate a saved model selection.
export function filterPickerModels(
  models: readonly AgentModelDefinition[] | null,
): AgentModelDefinition[] | null {
  return filterListedModels(models)?.filter((model) => model.pickerHidden !== true) ?? null;
}

export function resolveDefaultModel(
  models: readonly AgentModelDefinition[] | null,
): AgentModelDefinition | null {
  const choices = filterPickerModels(models);
  return choices?.find((model) => model.isDefault) ?? choices?.[0] ?? null;
}

export function resolveDefaultModelId(models: readonly AgentModelDefinition[] | null): string {
  return resolveDefaultModel(models)?.id ?? "";
}
