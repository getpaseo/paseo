import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";
import type { CommandCenterContribution, CommandCenterIcon } from "./contributions";

interface ModelChoiceInput {
  serverId: string;
  providers: readonly ProviderSelectorProvider[];
  selectedProvider: string | null;
  selectedModelId: string | null;
  groupLabel: string;
  searchKeywords: string;
  getIcon(provider: AgentProvider): CommandCenterIcon;
  select(provider: AgentProvider, modelId: string): void;
}

export function buildModelChoiceContributions(
  input: ModelChoiceInput,
): CommandCenterContribution[] {
  const contributions: CommandCenterContribution[] = [];
  let rank = 0;
  for (const provider of input.providers) {
    if (provider.modelSelection.kind !== "models") continue;
    const agentProvider = provider.id;
    const icon = input.getIcon(agentProvider);
    for (const model of provider.modelSelection.rows) {
      if (!model.modelId) continue;
      const modelId = model.modelId;
      const selected = input.selectedProvider === provider.id && input.selectedModelId === modelId;
      contributions.push({
        id: `${input.serverId}:${provider.id}:${modelId}`,
        group: "models",
        groupRank: 1,
        rank,
        keywords: [modelId, input.searchKeywords],
        visibility: "query",
        run: () => {
          if (!selected) input.select(agentProvider, modelId);
        },
        presentation: {
          kind: "choice",
          path: [input.groupLabel, provider.label, model.modelLabel],
          icon,
          selected,
          testId: `command-center-model-${input.serverId}:${provider.id}:${modelId}`,
        },
      });
      rank += 1;
    }
  }
  return contributions;
}
