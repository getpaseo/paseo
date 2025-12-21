import type { Agent } from "@/stores/session-store";

export function extractAgentModel(agent?: Agent | null): string | null {
  if (!agent) return null;
  const runtimeModel = agent.runtimeInfo?.model;
  return typeof runtimeModel === "string" && runtimeModel.trim().length > 0
    ? runtimeModel.trim()
    : null;
}
