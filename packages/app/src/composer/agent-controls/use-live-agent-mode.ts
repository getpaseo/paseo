import { useCallback, useMemo } from "react";
import { useShallow } from "zustand/shallow";
import { useStoreWithEqualityFn } from "zustand/traditional";
import type { AgentMode } from "@getpaseo/protocol/agent-types";
import type { AgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";
import { useSessionStore } from "@/stores/session-store";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { mergeProviderPreferences, useFormPreferences } from "@/hooks/use-form-preferences";
import { resolveProviderDefinition } from "@/utils/provider-definitions";
import { useToast } from "@/contexts/toast-context";
import { toErrorMessage } from "@/utils/error-messages";
import { showProviderNoticeToast } from "@/utils/provider-notice-toast";
import { runLiveAgentControlChange } from "./live-change";

const EMPTY_MODES: AgentMode[] = [];

function compareAvailableModes(left: AgentMode[], right: AgentMode[]): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

export interface LiveAgentModeSelection {
  provider: string | null;
  providerDefinitions: AgentProviderDefinition[];
  options: AgentMode[];
  selectedId: string | null;
  defaultModeId: string | null;
  canSelect: boolean;
  select(modeId: string): void;
}

export function useLiveAgentModeSelection(
  serverId: string,
  agentId: string,
): LiveAgentModeSelection {
  const slice = useSessionStore(
    useShallow((state) => {
      const agent = state.sessions[serverId]?.agents?.get(agentId);
      if (!agent) return null;
      return {
        provider: agent.provider,
        cwd: agent.cwd,
        currentModeId: agent.currentModeId,
      };
    }),
  );
  const options = useStoreWithEqualityFn(
    useSessionStore,
    (state) => state.sessions[serverId]?.agents?.get(agentId)?.availableModes ?? EMPTY_MODES,
    compareAvailableModes,
  );
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const { updatePreferences } = useFormPreferences();
  const toast = useToast();
  const { entries: snapshotEntries } = useProvidersSnapshot(serverId, { cwd: slice?.cwd });

  const providerDefinitions = useMemo<AgentProviderDefinition[]>(() => {
    if (!slice?.provider) return [];
    const definition = resolveProviderDefinition(slice.provider, snapshotEntries);
    return definition ? [definition] : [];
  }, [slice?.provider, snapshotEntries]);

  const select = useCallback(
    (modeId: string) => {
      if (!client || !slice?.provider) return;
      void runLiveAgentControlChange({
        apply: () => client.setAgentMode(agentId, modeId),
        onApplied: (notice) => showProviderNoticeToast(toast, notice),
        persist: () =>
          updatePreferences((current) =>
            mergeProviderPreferences({
              preferences: current,
              provider: slice.provider,
              updates: { mode: modeId || undefined },
            }),
          ),
      }).catch((error) => {
        console.warn("[AgentModeControl] set mode or persist preference failed", error);
        toast.error(toErrorMessage(error));
      });
    },
    [agentId, client, slice?.provider, toast, updatePreferences],
  );

  const provider = slice?.provider ?? null;
  const defaultModeId =
    providerDefinitions.find((definition) => definition.id === provider)?.defaultModeId ?? null;

  return {
    provider,
    providerDefinitions,
    options,
    selectedId: slice?.currentModeId ?? null,
    defaultModeId,
    canSelect: Boolean(client),
    select,
  };
}
