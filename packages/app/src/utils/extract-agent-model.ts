import type { Agent } from "@/stores/session-store";

export function extractAgentModel(agent?: Agent | null): string | null {
  if (!agent) return null;
  const runtimeModel = agent.runtimeInfo?.model;
  const fallbackModel = agent.model;
  if (typeof runtimeModel === "string") {
    const normalized = runtimeModel.trim();
    if (normalized.length > 0 && normalized.toLowerCase() !== "default") {
      return normalized;
    }
  }
  if (typeof fallbackModel === "string") {
    const normalized = fallbackModel.trim();
    if (normalized.length > 0 && normalized.toLowerCase() !== "default") {
      return normalized;
    }
  }
  return null;
}
