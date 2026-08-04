import type { AggregatedSchedule } from "@/schedules/aggregated-schedules";
import { deriveScheduleLifecycleState } from "@/schedules/schedule-derivation";
import { formatCadence, resolveScheduleTitle } from "@/utils/schedule-format";

/** The agent whose conversation the track is rendered above. */
export interface AgentHeartbeatTarget {
  serverId: string;
  agentId: string;
}

/** One heartbeat, reduced to what the track renders and routes with. */
export interface AgentHeartbeatRow {
  /** `${serverId}:${scheduleId}` — schedule ids are host-local, so identity is the pair. */
  key: string;
  serverId: string;
  scheduleId: string;
  title: string;
  cadence: string;
}

export interface SelectAgentHeartbeatsInput {
  schedules: readonly AggregatedSchedule[];
  target: AgentHeartbeatTarget;
  now: number;
}

/**
 * What the composer puts in the heartbeats lane: nothing, the heartbeats, or a
 * prompt to update a host that does not report heartbeat activity.
 */
export type AgentHeartbeatsTrack =
  | { kind: "none" }
  | { kind: "heartbeats"; rows: AgentHeartbeatRow[] }
  | { kind: "host-update-required" };

export interface SelectAgentHeartbeatsTrackInput extends SelectAgentHeartbeatsInput {
  /**
   * Whether the host reports heartbeat runs as workspace activity. Every host
   * runs the prompts; an older one just does not surface a run, so the track's
   * rows would sit still through every firing and read as nothing happening.
   */
  showsHeartbeatActivity: boolean;
}

const EMPTY_HEARTBEAT_ROWS: AgentHeartbeatRow[] = [];
const NO_TRACK: AgentHeartbeatsTrack = { kind: "none" };
const HOST_UPDATE_REQUIRED_TRACK: AgentHeartbeatsTrack = { kind: "host-update-required" };

export function agentHeartbeatKey(serverId: string, scheduleId: string): string {
  return `${serverId}:${scheduleId}`;
}

/**
 * The heartbeats still babysitting this agent. Paused, completed, and expired
 * heartbeats stay on the Schedules screen — they no longer represent ongoing
 * work, so they leave the track.
 */
export function selectAgentHeartbeats(input: SelectAgentHeartbeatsInput): AgentHeartbeatRow[] {
  const { schedules, target, now } = input;
  const rows = schedules
    .filter(
      (schedule) =>
        schedule.serverId === target.serverId &&
        schedule.target.type === "agent" &&
        schedule.target.agentId === target.agentId &&
        deriveScheduleLifecycleState(schedule, now) === "active",
    )
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    .map((schedule) => ({
      key: agentHeartbeatKey(schedule.serverId, schedule.id),
      serverId: schedule.serverId,
      scheduleId: schedule.id,
      title: resolveScheduleTitle(schedule),
      cadence: formatCadence(schedule.cadence),
    }));

  return rows.length > 0 ? rows : EMPTY_HEARTBEAT_ROWS;
}

/**
 * The heartbeats track for one agent, capability included. This is the only
 * place the heartbeat feature asks what the host reports, so nothing downstream
 * has to branch on host version.
 */
export function selectAgentHeartbeatsTrack(
  input: SelectAgentHeartbeatsTrackInput,
): AgentHeartbeatsTrack {
  const rows = selectAgentHeartbeats(input);
  if (rows.length === 0) {
    return NO_TRACK;
  }
  return input.showsHeartbeatActivity ? { kind: "heartbeats", rows } : HOST_UPDATE_REQUIRED_TRACK;
}
