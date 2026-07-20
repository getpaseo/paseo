import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useStoreWithEqualityFn } from "zustand/traditional";
import type { AgentFeature, AgentMode, AgentSelectOption } from "@getpaseo/protocol/agent-types";
import type { AgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";
import { useSessionStore } from "@/stores/session-store";
import { mergeProviderPreferences, useFormPreferences } from "@/hooks/use-form-preferences";
import { useToast } from "@/contexts/toast-context";
import { toErrorMessage } from "@/utils/error-messages";
import { showProviderNoticeToast } from "@/utils/provider-notice-toast";
import { useCommandCenterActions } from "@/command-center/provider";
import {
  buildAgentSettingContributions,
  buildAgentSettingLabels,
  getFeatureValue,
} from "@/command-center/agent-setting-contributions";
import {
  CommandCenterFastModeIcon,
  CommandCenterPlanModeIcon,
  CommandCenterThinkingIcon,
  getCommandCenterModeIcon,
} from "@/command-center/setting-icon";

const EMPTY_MODES: AgentMode[] = [];
const EMPTY_FEATURES: AgentFeature[] = [];

interface AgentModeFeatureSlice {
  currentModeId: string | null;
  availableModes: AgentMode[];
  features: AgentFeature[];
}

// These arrive as fresh arrays on every snapshot; compare by value so the
// Command Center registration doesn't churn (mirrors mode-control.tsx).
function compareModeFeatureSlice(a: AgentModeFeatureSlice, b: AgentModeFeatureSlice): boolean {
  return (
    a.currentModeId === b.currentModeId &&
    (a.availableModes === b.availableModes ||
      JSON.stringify(a.availableModes) === JSON.stringify(b.availableModes)) &&
    (a.features === b.features || JSON.stringify(a.features) === JSON.stringify(b.features))
  );
}

interface AgentSettingActionsInput {
  serverId: string;
  agentId: string;
  isPaneFocused: boolean;
  provider: string | undefined;
  providerDefinitions: AgentProviderDefinition[];
  thinkingOptions: readonly AgentSelectOption[] | null | undefined;
  selectedThinkingId: string | null | undefined;
  onSelectThinkingOption: (thinkingOptionId: string) => void;
  onSetFeature: (featureId: string, value: unknown) => void;
}

/**
 * Registers the running agent's Thinking / Mode / Plan mode / Fast mode
 * selectors with the Command Center. Owns the mode read + `setAgentMode`
 * handler; reuses the composer's thinking/feature setters. Keeps this logic out
 * of the already-large {@link AgentControls} component.
 */
export function useAgentSettingCommandCenterActions(input: AgentSettingActionsInput): void {
  const {
    serverId,
    agentId,
    isPaneFocused,
    provider,
    providerDefinitions,
    thinkingOptions,
    selectedThinkingId,
    onSelectThinkingOption,
    onSetFeature,
  } = input;
  const { t } = useTranslation();
  const { updatePreferences } = useFormPreferences();
  const toast = useToast();
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const slice = useStoreWithEqualityFn(
    useSessionStore,
    (state): AgentModeFeatureSlice => {
      const agent = state.sessions[serverId]?.agents?.get(agentId);
      return {
        currentModeId: agent?.currentModeId ?? null,
        availableModes: agent?.availableModes ?? EMPTY_MODES,
        features: agent?.features ?? EMPTY_FEATURES,
      };
    },
    compareModeFeatureSlice,
  );

  const handleSelectMode = useCallback(
    (modeId: string) => {
      if (!client || !provider) {
        return;
      }
      void updatePreferences((current) =>
        mergeProviderPreferences({
          preferences: current,
          provider,
          updates: { mode: modeId || undefined },
        }),
      ).catch((error) => {
        console.warn("[AgentControls] persist mode preference failed", error);
      });
      void client
        .setAgentMode(agentId, modeId)
        .then((notice) => showProviderNoticeToast(toast, notice))
        .catch((error) => {
          console.warn("[AgentControls] setAgentMode failed", error);
          toast.error(toErrorMessage(error));
        });
    },
    [agentId, client, provider, toast, updatePreferences],
  );

  const defaultModeId =
    providerDefinitions.find((definition) => definition.id === provider)?.defaultModeId ?? null;
  const { availableModes, currentModeId, features } = slice;

  const actions = useMemo(() => {
    if (!provider) {
      return [];
    }
    return buildAgentSettingContributions({
      serverId,
      ownerKey: agentId,
      provider,
      labels: buildAgentSettingLabels(t),
      icons: {
        thinking: CommandCenterThinkingIcon,
        planMode: CommandCenterPlanModeIcon,
        fast: CommandCenterFastModeIcon,
        mode: (modeId) => getCommandCenterModeIcon(provider, modeId, providerDefinitions),
      },
      thinking: {
        options: thinkingOptions ?? [],
        selectedId: selectedThinkingId ?? null,
        select: onSelectThinkingOption,
      },
      modes: {
        options: availableModes,
        selectedId: currentModeId,
        defaultModeId,
        select: handleSelectMode,
      },
      features: {
        list: features,
        value: (featureId) => getFeatureValue(features, featureId),
        set: onSetFeature,
      },
    });
  }, [
    serverId,
    agentId,
    provider,
    t,
    providerDefinitions,
    thinkingOptions,
    selectedThinkingId,
    onSelectThinkingOption,
    availableModes,
    currentModeId,
    defaultModeId,
    handleSelectMode,
    features,
    onSetFeature,
  ]);

  useCommandCenterActions({
    sourceId: `agent-settings:${serverId}:${agentId}`,
    enabled: isPaneFocused && Boolean(client),
    actions,
  });
}
