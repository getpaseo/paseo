import type { AgentModelDefinition } from "@getpaseo/protocol/agent-types";

export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${Math.round(value / 1_000_000)}m`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return Math.round(value).toString();
}

function isValidContextWindowMaxTokens(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isValidContextWindowUsedTokens(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function resolveModelContextWindowMaxTokens({
  models,
  runtimeModelId,
  configuredModelId,
}: {
  models: readonly AgentModelDefinition[] | null | undefined;
  runtimeModelId: string | null | undefined;
  configuredModelId: string | null | undefined;
}): number | null {
  if (!models || models.length === 0) return null;

  const model =
    models.find((candidate) => candidate.id === runtimeModelId) ??
    models.find((candidate) => candidate.id === configuredModelId) ??
    models.find((candidate) => candidate.isDefault) ??
    models[0];
  return isValidContextWindowMaxTokens(model?.contextWindowMaxTokens)
    ? model.contextWindowMaxTokens
    : null;
}

export function resolveContextWindowValues({
  reportedMaxTokens,
  reportedUsedTokens,
  modelMaxTokens,
}: {
  reportedMaxTokens: number | null | undefined;
  reportedUsedTokens: number | null | undefined;
  modelMaxTokens: number | null | undefined;
}): { maxTokens: number | null; usedTokens: number | null } {
  let maxTokens: number | null = null;
  if (isValidContextWindowMaxTokens(reportedMaxTokens)) {
    maxTokens = reportedMaxTokens;
  } else if (isValidContextWindowMaxTokens(modelMaxTokens)) {
    maxTokens = modelMaxTokens;
  }
  if (maxTokens === null) return { maxTokens: null, usedTokens: null };
  return {
    maxTokens,
    usedTokens: isValidContextWindowUsedTokens(reportedUsedTokens) ? reportedUsedTokens : null,
  };
}
