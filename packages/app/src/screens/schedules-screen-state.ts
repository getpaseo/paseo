import type { AggregateLoadState, AggregatedSchedule } from "@/schedules/aggregated-schedules";

export type SchedulesScreenBodyState =
  | { kind: "loading" }
  | { kind: "load-error" }
  | { kind: "empty" }
  | { kind: "content" };

export function resolveSchedulesScreenBodyState(input: {
  loadState: AggregateLoadState<AggregatedSchedule>;
  showLoadError: boolean;
}): SchedulesScreenBodyState {
  if (input.showLoadError) {
    return { kind: "load-error" };
  }
  if (input.loadState.status === "connecting" || input.loadState.status === "loading") {
    return { kind: "loading" };
  }
  if (input.loadState.data.length === 0) {
    return { kind: "empty" };
  }
  return { kind: "content" };
}

export type SchedulesCreateIntent =
  | { kind: "none" }
  | { kind: "agent"; serverId: string; agentId: string };

/**
 * The create form only prefills a target when the route names both a host and
 * an agent on it; a half-specified link opens the ordinary create form rather
 * than a form pointed at nothing.
 */
export function resolveSchedulesCreateIntent(input: {
  serverId?: string | null;
  agentId?: string | null;
}): SchedulesCreateIntent {
  const serverId = input.serverId?.trim() ?? "";
  const agentId = input.agentId?.trim() ?? "";
  if (!serverId || !agentId) {
    return { kind: "none" };
  }
  return { kind: "agent", serverId, agentId };
}
