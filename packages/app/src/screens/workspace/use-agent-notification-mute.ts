import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useCallback, useMemo } from "react";
import { useMutation, useMutationState, useQueryClient } from "@tanstack/react-query";
import { useShallow } from "zustand/react/shallow";
import {
  AGENT_NOTIFICATIONS_MUTED_LABEL,
  areAgentNotificationsMuted,
} from "@getpaseo/protocol/agent-labels";
import { useSessionStore } from "@/stores/session-store";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { i18n } from "@/i18n/i18next";
import type { WorkspaceTabDescriptor } from "./workspace-tabs-types";
import type { WorkspaceTabNotificationMute } from "./workspace-tab-menu";

function mutationAgentId(variables: unknown): string | null {
  return variables &&
    typeof variables === "object" &&
    "agentId" in variables &&
    typeof variables.agentId === "string"
    ? variables.agentId
    : null;
}

interface UpdateAgentNotificationMuteInput {
  client: Pick<DaemonClient, "updateAgent">;
  serverId: string;
  agentId: string;
  muted: boolean;
  publicationTimeoutMs?: number;
}

export async function updateAgentNotificationMute({
  client,
  serverId,
  agentId,
  muted,
  publicationTimeoutMs = 10_000,
}: UpdateAgentNotificationMuteInput): Promise<void> {
  await client.updateAgent(agentId, {
    labels: { [AGENT_NOTIFICATIONS_MUTED_LABEL]: String(muted) },
  });
  // An acknowledgement can precede directory publication. Let the normal projection own
  // timestamps, permission prompts, and queued messages before enabling the opposite action.
  await new Promise<void>((resolve, reject) => {
    const check = () => {
      const agent = useSessionStore.getState().sessions[serverId]?.agents.get(agentId);
      if (!agent || areAgentNotificationsMuted(agent) !== muted) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    };
    const unsubscribe = useSessionStore.subscribe(check);
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for the saved agent notification setting"));
    }, publicationTimeoutMs);
    check();
  });
}

// Collection owners share one subscription and pass actions to their rows. Mutation keys also
// guard the same agent when it is open in multiple panes or both tab-menu presentations.
export function useAgentNotificationMute(serverId: string) {
  const queryClient = useQueryClient();
  const mutationKey = useMemo(() => ["agent-notification-mute", serverId], [serverId]);
  const { agents, supported } = useSessionStore(
    useShallow((state) => ({
      agents: state.sessions[serverId]?.agents,
      // COMPAT(agentNotificationMute): added in v0.12.0, remove after 2027-04-16 once
      // the supported daemon floor includes per-agent muting.
      supported: state.sessions[serverId]?.serverInfo?.features?.agentNotificationMute === true,
    })),
  );
  const mutation = useMutation({
    mutationKey,
    mutationFn: async ({ agentId, muted }: { agentId: string; muted: boolean }) => {
      const client = getHostRuntimeStore().getClient(serverId);
      if (!client) throw new Error(i18n.t("workspace.terminal.hostDisconnected"));
      await updateAgentNotificationMute({ client, serverId, agentId, muted });
    },
  });
  const mutate = mutation.mutate;
  const mutations = useMutationState({
    filters: { mutationKey, exact: true },
    select: (entry) => ({
      agentId: mutationAgentId(entry.state.variables),
      status: entry.state.status,
    }),
  });
  const statusByAgent = useMemo(() => {
    const statuses = new Map<string, (typeof mutations)[number]["status"]>();
    for (const entry of mutations) {
      if (entry.agentId) statuses.set(entry.agentId, entry.status);
    }
    return statuses;
  }, [mutations]);

  const toggle = useCallback(
    (agentId: string) => {
      // isMutating reads the cache synchronously, before React can render the disabled item.
      if (
        queryClient.isMutating({
          mutationKey,
          exact: true,
          predicate: (entry) => mutationAgentId(entry.state.variables) === agentId,
        }) > 0
      ) {
        return;
      }
      const session = useSessionStore.getState().sessions[serverId];
      const agent = session?.agents.get(agentId);
      if (agent && !agent.archivedAt) {
        mutate({ agentId, muted: !areAgentNotificationsMuted(agent) });
      }
    },
    [mutate, mutationKey, queryClient, serverId],
  );

  return useCallback(
    (tab: WorkspaceTabDescriptor): WorkspaceTabNotificationMute | undefined => {
      if (!supported || tab.target.kind !== "agent") return undefined;
      const { agentId } = tab.target;
      const agent = agents?.get(agentId);
      // Archived/history-only agents do not send alerts; restore them before changing mute.
      if (!agent || agent.archivedAt) return undefined;
      const status = statusByAgent.get(agentId);
      return {
        muted: areAgentNotificationsMuted(agent),
        status: status ?? "idle",
        onToggle: () => toggle(agentId),
      };
    },
    [agents, statusByAgent, supported, toggle],
  );
}
