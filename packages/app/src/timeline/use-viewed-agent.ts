import { useEffect, useLayoutEffect } from "react";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

/**
 * Shows one agent from a viewer outside the workspace's panes, such as a sheet or a plugin's
 * embedded timeline: its timeline catches up and stays live while the viewer is mounted. Each
 * viewer is its own `sourceId`; the sync observes the union of every source, so a tab and any
 * number of viewers of the same agent share one daemon observation, and removing one viewer
 * leaves the others live.
 */
export function useViewedAgent({
  sourceId,
  serverId,
  agentId,
}: {
  sourceId: string;
  serverId: string;
  agentId: string | null;
}) {
  const viewedTimelineSync = useSessionStore(
    (state) => state.sessions[serverId]?.viewedTimelineSync ?? null,
  );
  useEffect(() => {
    if (!agentId) return;
    void getHostRuntimeStore()
      .prepareAgentTimeline(serverId, agentId)
      .catch(() => undefined);
  }, [agentId, serverId]);
  useLayoutEffect(() => {
    if (!agentId || !viewedTimelineSync) return;
    viewedTimelineSync.replaceVisibleAgentIds(sourceId, [agentId]);
    return () => viewedTimelineSync.replaceVisibleAgentIds(sourceId, []);
  }, [agentId, sourceId, viewedTimelineSync]);
}
