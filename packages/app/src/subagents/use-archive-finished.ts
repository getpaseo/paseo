import { DaemonConnectionError } from "@getpaseo/client/internal/daemon-client";
import type { AgentAddress } from "@getpaseo/protocol/addresses";
import { getParentAddressFromLabels } from "@getpaseo/protocol/agent-labels";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useArchiveAgent } from "@/hooks/use-archive-agent";
import { useSessionStore } from "@/stores/session-store";
import {
  createArchiveFinishedSubagents,
  type ArchiveFinishedOutcome,
  type ArchiveFinishedState,
  type ArchiveFinishedSubagents,
} from "./archive-finished";
import { useProviderSubagentStore } from "./provider-store";
import { hydrateSubagentActivity, type SubagentRow } from "./select";
import { getSubagentActivity, managedActivityKey } from "./activity";

const EMPTY_PENDING_ARCHIVE_KEYS = new Set<string>();

export async function hydrateArchiveFinishedActivity(parent: AgentAddress): Promise<void> {
  const sessions = useSessionStore.getState().sessions;
  // An unloaded host can contain descendants missing from the current activity graph.
  if (Object.values(sessions).some((session) => !session.hasHydratedAgents)) {
    throw new DaemonConnectionError(
      "Host agent directories are still loading; retry Archive finished",
    );
  }
  const activity = getSubagentActivity({
    sessions,
    descriptors: useProviderSubagentStore.getState().descriptors,
    hiddenFromTrack: useProviderSubagentStore.getState().hiddenFromTrack,
    pendingArchiveKeys: EMPTY_PENDING_ARCHIVE_KEYS,
  });
  await hydrateSubagentActivity(sessions, activity, parent);
}

export type { ArchiveFinishedStatus } from "./archive-finished";

export interface UseArchiveFinishedSubagentsInput {
  serverId: string;
  parentAgentId: string;
  rows: readonly SubagentRow[];
}

export interface ArchiveFinishedSubagentsCapability extends ArchiveFinishedState {
  archiveFinished: () => Promise<ArchiveFinishedOutcome>;
}

export function useArchiveFinishedSubagents({
  serverId,
  parentAgentId,
  rows,
}: UseArchiveFinishedSubagentsInput): ArchiveFinishedSubagentsCapability {
  const { archiveAgent } = useArchiveAgent();
  const archiveFinished = useMemo<ArchiveFinishedSubagents>(
    () =>
      createArchiveFinishedSubagents([], {
        parentAgentId,
        hydrateActivity: () => hydrateArchiveFinishedActivity({ serverId, agentId: parentAgentId }),
        getManagedSubagent: (address) => {
          const agent = useSessionStore
            .getState()
            .sessions[address.serverId]?.agents.get(address.agentId);
          if (!agent) return undefined;
          const parent = getParentAddressFromLabels(agent.labels, address.serverId);
          if (parent?.serverId !== serverId || parent.agentId !== parentAgentId) return undefined;
          const activity = getSubagentActivity({
            sessions: useSessionStore.getState().sessions,
            descriptors: useProviderSubagentStore.getState().descriptors,
            hiddenFromTrack: useProviderSubagentStore.getState().hiddenFromTrack,
            pendingArchiveKeys: EMPTY_PENDING_ARCHIVE_KEYS,
          });
          return {
            ...agent,
            parentAgentId: parent.agentId,
            hasActiveDescendants: activity.managed.has(managedActivityKey(address)),
          };
        },
        archiveManagedSubagent: archiveAgent,
        dismissProviderSubagents: (ids) => {
          useProviderSubagentStore.getState().hideFromTrack(serverId, parentAgentId, ids);
        },
      }),
    [archiveAgent, parentAgentId, serverId],
  );
  const state = useSyncExternalStore(
    archiveFinished.subscribe,
    archiveFinished.getState,
    archiveFinished.getState,
  );

  useEffect(() => {
    archiveFinished.setRows(rows);
  }, [archiveFinished, rows]);

  return { ...state, archiveFinished: archiveFinished.archiveFinished };
}
