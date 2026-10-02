import type { AgentSessionConfig } from "@getpaseo/protocol/agent-types";

export function buildWorkspaceDraftAgentConfig(input: {
  provider: AgentSessionConfig["provider"];
  cwd: string;
  modeId?: string;
  model?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
  routingMode?: "auto" | "manual";
  isAuto?: boolean;
}): AgentSessionConfig {
  const routingMode = input.routingMode ?? (input.isAuto ? "auto" : "manual");
  return {
    provider: input.provider,
    cwd: input.cwd,
    ...(routingMode === "auto" ? { labels: { "pandaos.routing.mode": "auto" } } : {}),
    ...(input.modeId ? { modeId: input.modeId } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.thinkingOptionId ? { thinkingOptionId: input.thinkingOptionId } : {}),
    ...(input.featureValues ? { featureValues: input.featureValues } : {}),
  };
}
