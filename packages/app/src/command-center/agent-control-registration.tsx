import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type {
  AgentFeature,
  AgentMode,
  AgentProvider,
  AgentSelectOption,
} from "@getpaseo/protocol/agent-types";
import type { AgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";
import {
  getAgentFeatureIcon,
  getAgentModeIcon,
  PlanModeIcon,
  ThinkingIcon,
} from "@/agent-controls/icons";
import { getProviderIcon } from "@/components/provider-icons";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";
import {
  buildAgentControlContributions,
  buildAgentControlContributionLabels,
} from "./agent-control-contributions";
import { getCommandCenterIcon } from "./icon";
import { useCommandCenterActions } from "./provider";

export interface AgentControlCommandCenterSource {
  serverId: string;
  ownerKey: string;
  provider: string | null | undefined;
  providerDefinitions: AgentProviderDefinition[];
  models: {
    providers: readonly ProviderSelectorProvider[];
    selectedProvider: string | null | undefined;
    selectedModelId: string | null | undefined;
    select(provider: AgentProvider, modelId: string): void | Promise<void>;
  };
  thinking: {
    options: readonly AgentSelectOption[] | null | undefined;
    selectedId: string | null | undefined;
    select(optionId: string): void | Promise<void>;
  };
  modes: {
    options: readonly AgentMode[];
    selectedId: string | null | undefined;
    select(modeId: string): void | Promise<void>;
  };
  features: {
    list: readonly AgentFeature[] | undefined;
    set?: (featureId: string, value: unknown) => void | Promise<void>;
  };
}

function ignoreAgentFeatureChange(): void {
  return;
}

function resolveDefaultModeId(
  provider: string | null | undefined,
  providerDefinitions: AgentProviderDefinition[],
): string | null {
  return (
    providerDefinitions.find((definition) => definition.id === provider)?.defaultModeId ?? null
  );
}

export function useAgentControlCommandCenterActions(input: {
  sourceId: string;
  enabled: boolean;
  controls: AgentControlCommandCenterSource;
}): void {
  const { t } = useTranslation();
  const { controls } = input;
  const { features, models, modes, thinking } = controls;
  const actions = useMemo(
    () =>
      buildAgentControlContributions({
        serverId: controls.serverId,
        ownerKey: controls.ownerKey,
        provider: controls.provider ?? null,
        labels: buildAgentControlContributionLabels(t),
        icons: {
          provider: (provider) => getCommandCenterIcon(getProviderIcon(provider)),
          thinking: getCommandCenterIcon(ThinkingIcon),
          planMode: getCommandCenterIcon(PlanModeIcon),
          mode: (modeId) =>
            getCommandCenterIcon(
              getAgentModeIcon(controls.provider ?? "", modeId, controls.providerDefinitions),
            ),
          feature: (feature) => getCommandCenterIcon(getAgentFeatureIcon(feature.icon)),
        },
        models: {
          providers: models.providers,
          selectedProvider: models.selectedProvider ?? null,
          selectedModelId: models.selectedModelId ?? null,
          select: models.select,
        },
        thinking: {
          options: thinking.options ?? [],
          selectedId: thinking.selectedId ?? null,
          select: thinking.select,
        },
        modes: {
          options: modes.options,
          selectedId: modes.selectedId ?? null,
          defaultModeId: resolveDefaultModeId(controls.provider, controls.providerDefinitions),
          select: modes.select,
        },
        features: {
          list: features.set ? (features.list ?? []) : [],
          set: features.set ?? ignoreAgentFeatureChange,
        },
      }),
    [
      controls.ownerKey,
      controls.provider,
      controls.providerDefinitions,
      controls.serverId,
      features.list,
      features.set,
      models.providers,
      models.select,
      models.selectedModelId,
      models.selectedProvider,
      modes.options,
      modes.select,
      modes.selectedId,
      thinking.options,
      thinking.select,
      thinking.selectedId,
      t,
    ],
  );

  useCommandCenterActions({
    sourceId: input.sourceId,
    enabled: input.enabled,
    actions,
  });
}
