import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ScheduleSummary } from "@getpaseo/protocol/schedule/types";
import { isNewAgentSchedule } from "@/utils/schedule-format";
import { toErrorMessage } from "@/utils/error-messages";

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

export interface ScheduleHostSection {
  serverId: string;
  serverName: string;
  isOnline: boolean;
  schedules: ScheduleSummary[];
  error: string | null;
}

export interface FetchAggregatedSchedulesInput {
  hosts: ScheduleHostInput[];
  runtime: ScheduleRuntime;
}

export interface FetchAggregatedSchedulesResult {
  sections: ScheduleHostSection[];
}

export async function fetchAggregatedSchedules(
  input: FetchAggregatedSchedulesInput,
): Promise<FetchAggregatedSchedulesResult> {
  const sections = await Promise.all(
    input.hosts.map(async (host): Promise<ScheduleHostSection> => {
      const snapshot = input.runtime.getSnapshot(host.serverId);
      const isOnline = snapshot?.connectionStatus === "online";
      const client = input.runtime.getClient(host.serverId);

      if (!client || !isOnline) {
        return {
          serverId: host.serverId,
          serverName: host.serverName,
          isOnline,
          schedules: [],
          error: null,
        };
      }

      try {
        const payload = await client.scheduleList();
        if (payload.error) {
          throw new Error(payload.error);
        }
        return {
          serverId: host.serverId,
          serverName: host.serverName,
          isOnline,
          schedules: payload.schedules.filter(isNewAgentSchedule),
          error: null,
        };
      } catch (error) {
        return {
          serverId: host.serverId,
          serverName: host.serverName,
          isOnline,
          schedules: [],
          error: toErrorMessage(error),
        };
      }
    }),
  );

  return { sections };
}
