import type { AgentModelDefinition } from "../../agent-sdk-types.js";

export interface ModelEnvMapping {
  env: string;
  forceDefault?: boolean;
  family?: string;
  thinkingOptions?: ReadonlyArray<{ id: string; label: string }>;
}

function ensureModel(
  result: AgentModelDefinition[],
  modelId: string,
  options?: { thinkingOptions?: ReadonlyArray<{ id: string; label: string }> },
): AgentModelDefinition {
  const existing = result.find((m) => m.id === modelId);
  if (existing) return existing;
  const entry: AgentModelDefinition = {
    provider: "claude",
    id: modelId,
    label: modelId,
    ...(options?.thinkingOptions ? { thinkingOptions: [...options.thinkingOptions] } : {}),
  };
  result.push(entry);
  return entry;
}

export function applyModelEnvOverrides(
  models: AgentModelDefinition[],
  env: Record<string, string | undefined>,
  mappings: ModelEnvMapping[],
): AgentModelDefinition[] {
  const result = models.map((model) => ({ ...model }));

  for (const mapping of mappings) {
    const modelId = env[mapping.env]?.trim();
    if (!modelId) continue;
    ensureModel(result, modelId, { thinkingOptions: mapping.thinkingOptions });
  }

  // forceDefault entries always become default
  for (const mapping of mappings) {
    if (!mapping.forceDefault) continue;
    const modelId = env[mapping.env]?.trim();
    if (!modelId) continue;
    for (const m of result) {
      m.isDefault = m.id === modelId;
    }
    return result;
  }

  // Transfer isDefault to family-matched custom model
  const defaultModel = result.find((m) => m.isDefault);
  if (defaultModel) {
    for (const mapping of mappings) {
      const modelId = env[mapping.env]?.trim();
      if (!modelId || !mapping.family) continue;
      if (defaultModel.id.includes(mapping.family)) {
        for (const m of result) {
          m.isDefault = m.id === modelId;
        }
        break;
      }
    }
  }

  return result;
}
