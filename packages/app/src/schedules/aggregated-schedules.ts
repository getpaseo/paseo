import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ScheduleSummary } from "@getpaseo/protocol/schedule/types";
import { toErrorMessage } from "@/utils/error-messages";

export const ALL_SCHEDULE_HOSTS_FAILED_MESSAGE = "No connected hosts could load schedules";

export interface ScheduleHostInput {
  serverId: string;
  serverName: string;
}

export interface ScheduleRuntimeSnapshot {
  connectionStatus: string;
}

export interface ScheduleRuntime {
  getClient(serverId: string): Pick<DaemonClient, "scheduleList"> | null;
  getSnapshot(serverId: string): ScheduleRuntimeSnapshot | null | undefined;
}

/** A schedule tagged with the host it came from, so the flat list can render a
 * per-row host label and scope mutations without host sections. */
export interface AggregatedSchedule extends ScheduleSummary {
  serverId: string;
  serverName: string;
}

export interface ScheduleHostError {
  serverId: string;
  serverName: string;
  message: string;
}

export interface FetchAggregatedSchedulesResult {
  schedules: AggregatedSchedule[];
  hostErrors: ScheduleHostError[];
}

export interface FetchAggregatedSchedulesInput {
  hosts: readonly ScheduleHostInput[];
  runtime: ScheduleRuntime;
}

/**
 * Fetch schedules across connected hosts and merge them into one flat list.
 * Connectivity is checked here at execution time (not pre-filtered by the hook)
 * so the query — retried as the runtime version changes — reliably picks a host
 * up the moment it comes online, including on a cold deep-link.
 *
 * Offline hosts are skipped. A connected host that fails contributes to
 * `hostErrors` (surfaced as a banner) while the rest still render; only when
 * every connected host fails do we throw so the screen shows a full error.
 */
export async function fetchAggregatedSchedules(
  input: FetchAggregatedSchedulesInput,
): Promise<FetchAggregatedSchedulesResult> {
  const schedules: AggregatedSchedule[] = [];
  const hostErrors: ScheduleHostError[] = [];
  let connectedAttempts = 0;

  await Promise.all(
    input.hosts.map(async (host) => {
      const snapshot = input.runtime.getSnapshot(host.serverId);
      const isOnline = snapshot?.connectionStatus === "online";
      const client = input.runtime.getClient(host.serverId);
      if (!client || !isOnline) {
        return;
      }
      connectedAttempts += 1;
      try {
        const payload = await client.scheduleList();
        if (payload.error) {
          throw new Error(payload.error);
        }
        for (const schedule of payload.schedules) {
          schedules.push({ ...schedule, serverId: host.serverId, serverName: host.serverName });
        }
      } catch (error) {
        hostErrors.push({
          serverId: host.serverId,
          serverName: host.serverName,
          message: toErrorMessage(error),
        });
      }
    }),
  );

  if (connectedAttempts > 0 && schedules.length === 0 && hostErrors.length === connectedAttempts) {
    throw new Error(ALL_SCHEDULE_HOSTS_FAILED_MESSAGE);
  }

  return { schedules, hostErrors };
}
