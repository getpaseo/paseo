import { useMemo } from "react";
import { useSchedules } from "@/hooks/use-schedules";
import type { AggregatedSchedule } from "@/schedules/aggregated-schedules";
import { useSessionStore } from "@/stores/session-store";
import { selectAgentHeartbeatsTrack, type AgentHeartbeatsTrack } from "./select";

const EMPTY_SCHEDULES: AggregatedSchedule[] = [];

/**
 * The heartbeats track for one agent, over the schedule list the Schedules
 * screen already loads. Direct deletes update that cache optimistically;
 * heartbeats created elsewhere appear on its next refresh.
 *
 * The host capability is read here and nowhere else, so the composer only ever
 * sees a track to render.
 */
export function useAgentHeartbeatsTrack(target: {
  serverId: string;
  agentId: string;
}): AgentHeartbeatsTrack {
  const { serverId, agentId } = target;
  const { loadState, dataUpdatedAt } = useSchedules();
  const schedules = loadState.status === "loaded" ? loadState.data : EMPTY_SCHEDULES;
  // COMPAT(heartbeatWorkspaceActivity): added in v0.2.6, remove the gate after 2027-02-02 once daemon floor >= v0.2.6.
  const showsHeartbeatActivity = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.heartbeatWorkspaceActivity === true,
  );

  return useMemo(
    () =>
      selectAgentHeartbeatsTrack({
        schedules,
        target: { serverId, agentId },
        now: dataUpdatedAt || Date.now(),
        showsHeartbeatActivity,
      }),
    [schedules, serverId, agentId, dataUpdatedAt, showsHeartbeatActivity],
  );
}
