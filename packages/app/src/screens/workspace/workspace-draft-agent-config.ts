import type { AgentSessionConfig } from "@getpaseo/protocol/agent-types";

export function buildWorkspaceDraftAgentConfig(input: {
  provider: AgentSessionConfig["provider"];
  cwd: string;
  modeId?: string;
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
