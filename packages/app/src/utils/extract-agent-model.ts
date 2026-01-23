import type { Agent } from "@/stores/session-store";

export function extractAgentModel(agent?: Agent | null): string | null {
  if (!agent) return null;
  const runtimeModel = agent.runtimeInfo?.model;
  const fallbackModel = agent.model;
  if (typeof runtimeModel === "string" && runtimeModel.trim().length > 0) {
    return runtimeModel.trim();
  }
  if (typeof fallbackModel === "string" && fallbackModel.trim().length > 0) {
    return fallbackModel.trim();
  }
  return null;
}
