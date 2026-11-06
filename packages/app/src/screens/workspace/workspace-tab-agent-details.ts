import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { resolveAgentModelSelection } from "@/composer/agent-controls/utils";
import type { Agent } from "@/stores/session-store";
import { formatDuration } from "@/utils/time";

interface WorkspaceTabAgentDetailsInput {
  agent: Pick<Agent, "provider" | "model" | "runtimeInfo" | "thinkingOptionId" | "turn">;
  entries: Pick<ProviderSnapshotEntry, "provider" | "label" | "models">[] | undefined;
  now: number;
}

export function buildWorkspaceTabAgentDetails({
  agent,
  entries,
  now,
}: WorkspaceTabAgentDetailsInput): string {
  const provider = entries?.find((entry) => entry.provider === agent.provider);
  const parts = [provider?.label ?? agent.provider];
  const hasModel = Boolean(agent.runtimeInfo?.model?.trim() || agent.model?.trim());
  if (hasModel) {
    const models = provider?.models ?? null;
    const selection = resolveAgentModelSelection({
      models,
      runtimeModelId: agent.runtimeInfo?.model,
      configuredModelId: agent.model,
      runtimeThinkingOptionId: agent.runtimeInfo?.thinkingOptionId,
      explicitThinkingOptionId: agent.thinkingOptionId,
    });
    parts.push(selection.displayModel);
    if (selection.selectedThinkingId) parts.push(selection.displayThinking);
  }
  if (agent.turn.phase === "open" && agent.turn.startedAt !== null) {
    parts.push(formatDuration(now - agent.turn.startedAt.getTime()));
  }
  return parts.join(" · ");
}
