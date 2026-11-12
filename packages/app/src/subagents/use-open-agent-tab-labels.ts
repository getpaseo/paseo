import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { getOpenAgentTabLabel } from "@getpaseo/protocol/agent-labels";
import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/shallow";
import { useSessionStore } from "@/stores/session-store";
import { getOrCreateClientId } from "@/utils/client-id";
import type { WorkspaceTab } from "@/workspace-tabs/model";
import { getAgentTabsNeedingOpenLabel, selectOpenTabAgents } from "./open-tab-labels";

function increment(value: number): number {
  return value + 1;
}

export function useOpenAgentTabLabels(input: {
  client: DaemonClient | null;
  serverId: string;
  tabs: WorkspaceTab[];
  enabled: boolean;
}): void {
  const openAgentIds = useMemo(
    () => input.tabs.flatMap((tab) => (tab.target.kind === "agent" ? [tab.target.agentId] : [])),
    [input.tabs],
  );
  // Only the agents with open tabs can need a label. Subscribing to the whole agent map would
  // re-render the workspace screen on every update to any agent on the host.
  const openAgents = useSessionStore(
    useShallow((state) =>
      selectOpenTabAgents(state, { serverId: input.serverId, agentIds: openAgentIds }),
    ),
  );
  const pendingAgentIdsRef = useRef(new Set<string>());
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [retryVersion, setRetryVersion] = useState(0);

  useEffect(
    () => () => {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    const client = input.client;
    if (!client || !input.enabled) {
      return;
    }

    const agentsById = new Map(openAgentIds.map((agentId, index) => [agentId, openAgents[index]]));
    for (const agentId of pendingAgentIdsRef.current) {
      if (!agentsById.has(agentId)) {
        pendingAgentIdsRef.current.delete(agentId);
      }
    }
    if (agentsById.size === 0) {
      return;
    }

    void (async () => {
      try {
        const clientId = await getOrCreateClientId();
        const label = getOpenAgentTabLabel(clientId);
        const agentIds = getAgentTabsNeedingOpenLabel({
          tabs: input.tabs,
          getAgent: (agentId) => agentsById.get(agentId),
          label,
          pendingAgentIds: pendingAgentIdsRef.current,
        });
        for (const agentId of agentIds) {
          pendingAgentIdsRef.current.add(agentId);
          try {
            await client.updateAgent(agentId, { labels: { [label]: "true" } });
          } catch (error) {
            console.warn("[OpenAgentTabLabels] Failed to mark open subagent tab", {
              error,
              agentId,
            });
            retryTimerRef.current ??= setTimeout(() => {
              retryTimerRef.current = null;
              setRetryVersion(increment);
            }, 2_000);
          } finally {
            pendingAgentIdsRef.current.delete(agentId);
          }
        }
      } catch (error) {
        console.warn("[OpenAgentTabLabels] Failed to resolve client ID", { error });
      }
    })();
  }, [input.client, input.enabled, input.tabs, openAgentIds, openAgents, retryVersion]);
}
