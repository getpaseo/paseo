import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-context";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { findAgentIdForProviderSession } from "./find-agent-for-provider-session";

export interface OpenSubsessionInput {
  serverId: string;
  /** The agent that reported the subsession (owns the provider session tree). */
  agentId: string;
  /** Provider-native session id of the subsession. */
  subsessionId: string;
}

// One import per subsession at a time — double-clicks and parallel surfaces
// (sidebar, history, track) share the same pending import.
const inflightImports = new Map<string, Promise<string>>();

async function resolveSubsessionAgentId({
  serverId,
  agentId,
  subsessionId,
}: OpenSubsessionInput): Promise<string> {
  const state = useSessionStore.getState();
  const existing = findAgentIdForProviderSession(state, { serverId, sessionId: subsessionId });
  if (existing) {
    return existing;
  }

  const session = state.sessions[serverId];
  const owner = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
  if (!owner) {
    throw new Error("Owning agent not found");
  }
  const client = getHostRuntimeStore().getClient(serverId);
  if (!client) {
    throw new Error("Host disconnected");
  }

  const key = `${serverId}:${subsessionId}`;
  let pending = inflightImports.get(key);
  if (!pending) {
    pending = client
      .importAgent({
        providerId: owner.provider,
        providerHandleId: subsessionId,
        cwd: owner.cwd,
        workspaceId: owner.workspaceId,
      })
      .then((snapshot) => snapshot.id)
      .finally(() => {
        inflightImports.delete(key);
      });
    inflightImports.set(key, pending);
  }
  return pending;
}

/**
 * Open a provider subsession as a full Paseo session: navigate to the agent
 * already bound to it, or import it (attach an agent to the provider session)
 * and navigate to the result.
 */
export function useOpenSubsession(): (input: OpenSubsessionInput) => void {
  const toast = useToast();
  const { t } = useTranslation();

  return useCallback(
    (input: OpenSubsessionInput) => {
      void resolveSubsessionAgentId(input)
        .then((targetAgentId) =>
          navigateToAgent({ serverId: input.serverId, agentId: targetAgentId }),
        )
        .catch((error: unknown) => {
          toast.error(
            error instanceof Error && error.message ? error.message : t("subagents.openFailed"),
          );
        });
    },
    [toast, t],
  );
}
