import type { AgentMode, AgentModelDefinition } from "@getpaseo/protocol/agent-types";
import { AGENT_TEAM_ROLE_LABEL } from "@getpaseo/protocol/agent-labels";
import { useShallow } from "zustand/shallow";
import { formatAgentModeLabel } from "@/agent-controls/labels";
import { formatTokenCount } from "@/components/context-window-meter.utils";
import { resolveAgentModelSelection } from "@/composer/agent-controls/utils";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useSessionStore } from "@/stores/session-store";

export interface AgentFactsInput {
  models: AgentModelDefinition[] | null;
  runtimeModelId: string | null | undefined;
  configuredModelId: string | null | undefined;
  runtimeThinkingOptionId: string | null | undefined;
  explicitThinkingOptionId: string | null | undefined;
  availableModes: AgentMode[];
  currentModeId: string | null | undefined;
  contextWindowUsedTokens: number | null | undefined;
  contextWindowMaxTokens: number | null | undefined;
  /** The `paseo.team-role` label a team chat set on this helper. */
  teamRole?: string | null;
}

/**
 * What the composer's controls and context meter show about a Paseo agent, as one line: team
 * role, model, thinking, mode, and context usage, each resolved exactly as its control resolves
 * it. The role leads because it is what tells two helpers on the same model apart. Null until the
 * agent has a role or a model.
 */
export function buildAgentFactsLine(input: AgentFactsInput): string | null {
  const role = input.teamRole?.trim() || null;
  const hasModel = Boolean(input.runtimeModelId?.trim() || input.configuredModelId?.trim());
  if (!hasModel) return role;
  const selection = resolveAgentModelSelection(input);
  const parts = role ? [role, selection.displayModel] : [selection.displayModel];
  if (selection.selectedThinkingId) parts.push(selection.displayThinking);
  const mode = resolveModeLabel(input.availableModes, input.currentModeId);
  if (mode) parts.push(mode);
  const context = formatContextUsage(input.contextWindowUsedTokens, input.contextWindowMaxTokens);
  if (context) parts.push(context);
  return parts.join(" · ");
}

/** The facts line for a Paseo agent in the session store, kept current as the agent reports. */
export function useAgentFactsLine(serverId: string, agentId: string): string | null {
  const agent = useSessionStore(
    useShallow((state) => {
      const current = state.sessions[serverId]?.agents.get(agentId);
      return current
        ? {
            provider: current.provider,
            cwd: current.cwd,
            runtimeModelId: current.runtimeInfo?.model ?? null,
            configuredModelId: current.model ?? null,
            runtimeThinkingOptionId: current.runtimeInfo?.thinkingOptionId ?? null,
            explicitThinkingOptionId: current.thinkingOptionId ?? null,
            availableModes: current.availableModes,
            currentModeId: current.currentModeId,
            contextWindowUsedTokens: current.lastUsage?.contextWindowUsedTokens ?? null,
            contextWindowMaxTokens: current.lastUsage?.contextWindowMaxTokens ?? null,
            teamRole: current.labels[AGENT_TEAM_ROLE_LABEL] ?? null,
          }
        : null;
    }),
  );
  const { entries } = useProvidersSnapshot(serverId, { cwd: agent?.cwd });
  const models = entries?.find((entry) => entry.provider === agent?.provider)?.models ?? null;
  return agent ? buildAgentFactsLine({ ...agent, models }) : null;
}

/** The mode control shows the current mode, or the provider's first one until the agent reports. */
function resolveModeLabel(modes: AgentMode[], currentModeId: string | null | undefined) {
  const mode = modes.find((candidate) => candidate.id === currentModeId) ?? modes[0];
  return mode ? formatAgentModeLabel(mode) : null;
}

/** The context meter's numbers: used of max, with the share it draws as the ring. */
function formatContextUsage(
  usedTokens: number | null | undefined,
  maxTokens: number | null | undefined,
): string | null {
  if (
    typeof usedTokens !== "number" ||
    typeof maxTokens !== "number" ||
    !Number.isFinite(usedTokens) ||
    !Number.isFinite(maxTokens) ||
    usedTokens < 0 ||
    maxTokens <= 0
  ) {
    return null;
  }
  const percentage = Math.round(Math.min(100, (usedTokens / maxTokens) * 100));
  return `${formatTokenCount(usedTokens)} / ${formatTokenCount(maxTokens)} tokens (${percentage}%)`;
}
