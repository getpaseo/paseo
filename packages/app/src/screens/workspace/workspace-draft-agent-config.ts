import type { AgentSessionConfig } from "@getpaseo/protocol/agent-types";

interface WorkspaceDraftModeInput {
  requestedModeId: string | null | undefined;
  modeOptionIds: readonly string[];
  selectedModeId: string;
}

export function resolveWorkspaceDraftModeId(input: WorkspaceDraftModeInput): string | null {
  const requestedModeId = input.requestedModeId || input.selectedModeId;
  if (input.modeOptionIds.length === 0) {
    return null;
  }
  // The picker displays the first available mode when stored state is stale,
  // so the submitted and optimistic modes must match that display.
  return input.modeOptionIds.includes(requestedModeId)
    ? requestedModeId
    : (input.modeOptionIds[0] ?? null);
}

export function buildWorkspaceDraftAgentConfig(input: {
  provider: AgentSessionConfig["provider"];
  cwd: string;
  modeId?: string | null;
  model?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
}): AgentSessionConfig {
  return {
    provider: input.provider,
    cwd: input.cwd,
    ...(input.modeId ? { modeId: input.modeId } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.thinkingOptionId ? { thinkingOptionId: input.thinkingOptionId } : {}),
    ...(input.featureValues ? { featureValues: input.featureValues } : {}),
  };
}
