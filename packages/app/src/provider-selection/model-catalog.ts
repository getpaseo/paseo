import type { AgentModelDefinition } from "@getpaseo/protocol/agent-types";

export function filterSelectableModels(
  models: AgentModelDefinition[] | null,
): AgentModelDefinition[] | null {
  return models?.filter((model) => model.isSelectable !== false) ?? null;
}
