import type { ProviderHeartbeatDescriptorPayload } from "@getpaseo/protocol/messages";
import type { ScheduleSummary } from "@getpaseo/protocol/schedule/types";
import type { Agent } from "@/stores/session-store";
import { formatCadence } from "@/utils/schedule-format";
import { selectProviderHeartbeatsForParent, useProviderHeartbeatStore } from "./provider-store";

export type HeartbeatRow =
  | {
      kind: "paseo";
      id: string;
      name: string | null;
      prompt: string;
      status: "active" | "paused";
      cadenceLabel: string;
      nextRunAt: string | null;
      serverId: string;
    }
  | {
      kind: "provider";
      id: string;
      parentAgentId: string;
      provider: Agent["provider"] | string;
      prompt: string;
      mode: "recurring" | "one_shot" | "dynamic";
      scheduleLabel: string;
      nextHint: string | null;
    };

export function selectPaseoHeartbeatRows(input: {
  agentId: string;
  serverId: string;
  schedules: ScheduleSummary[];
}): Extract<HeartbeatRow, { kind: "paseo" }>[] {
  const rows: Extract<HeartbeatRow, { kind: "paseo" }>[] = [];
  for (const schedule of input.schedules) {
    if (schedule.target.type !== "agent") continue;
    if (schedule.target.agentId !== input.agentId) continue;
    if (schedule.status !== "active" && schedule.status !== "paused") continue;
    rows.push({
      kind: "paseo",
      id: schedule.id,
      name: schedule.name,
      prompt: schedule.prompt,
      status: schedule.status,
      cadenceLabel: formatCadence(schedule.cadence),
      nextRunAt: schedule.nextRunAt,
      serverId: input.serverId,
    });
  }
  return rows;
}

export function selectProviderHeartbeatRows(
  heartbeats: ProviderHeartbeatDescriptorPayload[],
): Extract<HeartbeatRow, { kind: "provider" }>[] {
  return heartbeats.map((heartbeat) => ({
    kind: "provider" as const,
    id: heartbeat.taskId,
    parentAgentId: heartbeat.parentAgentId,
    provider: heartbeat.provider,
    prompt: heartbeat.prompt,
    mode: heartbeat.mode,
    scheduleLabel: heartbeat.scheduleLabel,
    nextHint: heartbeat.nextHint,
  }));
}

export function mergeHeartbeatRows(
  paseo: HeartbeatRow[],
  provider: HeartbeatRow[],
): HeartbeatRow[] {
  return [...paseo, ...provider];
}

export function selectHeartbeatRowsForAgent(input: {
  agentId: string;
  serverId: string;
  schedules: ScheduleSummary[];
  providerHeartbeats: ProviderHeartbeatDescriptorPayload[];
}): HeartbeatRow[] {
  return mergeHeartbeatRows(
    selectPaseoHeartbeatRows({
      agentId: input.agentId,
      serverId: input.serverId,
      schedules: input.schedules,
    }),
    selectProviderHeartbeatRows(input.providerHeartbeats),
  );
}

export function useProviderHeartbeatRows(input: {
  serverId: string;
  parentAgentId: string;
}): Extract<HeartbeatRow, { kind: "provider" }>[] {
  const heartbeats = useProviderHeartbeatStore((state) => state.heartbeats);
  return selectProviderHeartbeatRows(
    selectProviderHeartbeatsForParent(heartbeats, input.serverId, input.parentAgentId),
  );
}
