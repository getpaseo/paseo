import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { getOpenAgentTabLabel } from "@getpaseo/protocol/agent-labels";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSessionStore } from "@/stores/session-store";
import { getOrCreateClientId } from "@/utils/client-id";
import type { WorkspaceTab } from "@/workspace-tabs/model";
import { createAgentTabsNeedingOpenLabelKeySelector } from "./open-tab-labels";

function selectNoAgentTabs(): string {
  return "";
}

function increment(value: number): number {
  return value + 1;
}

export function useOpenAgentTabLabels(input: {
  client: DaemonClient | null;
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

  useEffect(() => {
    if (label) {
      return;
    }
    let cancelled = false;
    let resolving = false;
    const resolveLabel = async () => {
      if (resolving) return;
      resolving = true;
      try {
        const clientId = await getOrCreateClientId();
        if (!cancelled) setLabel(getOpenAgentTabLabel(clientId));
      } catch (error) {
        console.warn("[OpenAgentTabLabels] Failed to resolve client ID", { error });
      } finally {
        resolving = false;
      }
    };
    void resolveLabel();
    // A failed lookup is retried on the next agent map change. This listener doesn't render, so
    // the screen still doesn't subscribe to the maps.
    const unsubscribe = useSessionStore.subscribe(
      (state) => state.sessions[input.serverId]?.agents,
      () => void resolveLabel(),
    );
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [input.serverId, label]);

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
