import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { getOpenAgentTabLabel } from "@getpaseo/protocol/agent-labels";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSessionStore } from "@/stores/session-store";
import { getOrCreateClientId } from "@/utils/client-id";
import type { WorkspaceTab } from "@/workspace-tabs/model";
import { createClientIdLookup } from "./client-id-lookup";
import { createAgentTabsNeedingOpenLabelKeySelector } from "./open-tab-labels";

function selectNoAgentTabs(): string {
  return "";
}

function increment(value: number): number {
  return value + 1;
}

export function useOpenAgentTabLabels(input: {
  client: Pick<DaemonClient, "updateAgent"> | null;
  serverId: string;
  tabs: WorkspaceTab[];
  enabled: boolean;
}): void {
  const [label, setLabel] = useState<string | null>(null);
  // The workspace screen calls this hook, so it subscribes to the open tabs that still need a
  // label rather than to the agent maps, which change on every agent update on the host.
  const selectNeededKey = useMemo(
    () =>
      label
        ? createAgentTabsNeedingOpenLabelKeySelector({
            serverId: input.serverId,
            tabs: input.tabs,
            label,
          })
        : selectNoAgentTabs,
    [input.serverId, input.tabs, label],
  );
  const neededKey = useSessionStore(selectNeededKey);
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

  // Until the client id resolves, retry the lookup on the same changes that re-ran labelling
  // before: the client, enabled flag, tabs, and either agent map. The map listeners don't render.
  useEffect(() => {
    if (label || !input.client || !input.enabled) {
      return;
    }
    const lookup = createClientIdLookup({
      getClientId: getOrCreateClientId,
      onResolved: (clientId) => setLabel(getOpenAgentTabLabel(clientId)),
      onError: (error) =>
        console.warn("[OpenAgentTabLabels] Failed to resolve client ID", { error }),
    });
    void lookup.resolve();
    const unsubscribeAgents = useSessionStore.subscribe(
      (state) => state.sessions[input.serverId]?.agents,
      () => void lookup.resolve(),
    );
    const unsubscribeAgentDetails = useSessionStore.subscribe(
      (state) => state.sessions[input.serverId]?.agentDetails,
      () => void lookup.resolve(),
    );
    return () => {
      lookup.dispose();
      unsubscribeAgents();
      unsubscribeAgentDetails();
    };
  }, [input.client, input.enabled, input.serverId, input.tabs, label]);

  useEffect(() => {
    const client = input.client;
    if (!client || !input.enabled) {
      return;
    }

    const openAgentIds = new Set(
      input.tabs.flatMap((tab) => (tab.target.kind === "agent" ? [tab.target.agentId] : [])),
    );
    for (const agentId of pendingAgentIdsRef.current) {
      if (!openAgentIds.has(agentId)) {
        pendingAgentIdsRef.current.delete(agentId);
      }
    }
    if (!label || neededKey === "") {
      return;
    }

    const agentIds = neededKey
      .split("\n")
      .filter((agentId) => !pendingAgentIdsRef.current.has(agentId));
    void (async () => {
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
    })();
  }, [input.client, input.enabled, input.tabs, label, neededKey, retryVersion]);
}
