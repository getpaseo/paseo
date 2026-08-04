import type { AggregateLoadState, AggregatedSchedule } from "@/schedules/aggregated-schedules";
import type { ScheduleFocus } from "@/utils/host-routes";

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

export type ScheduleFocusResolution =
  | { kind: "none" }
  | { kind: "pending" }
  | { kind: "missing" }
  | { kind: "found"; serverId: string; schedule: AggregatedSchedule };

/**
 * A deep link names one schedule on one host. Until the list loads there is
 * nothing to open; once it has, an unmatched link is stale and the screen just
 * shows the list.
 */
export function resolveScheduleFocus(input: {
  focus: ScheduleFocus | null;
  loadState: AggregateLoadState<AggregatedSchedule>;
}): ScheduleFocusResolution {
  if (!input.focus) {
    return { kind: "none" };
  }
  if (input.loadState.status !== "loaded") {
    return { kind: "pending" };
  }
  const schedule = input.loadState.data.find(
    (candidate) =>
      candidate.serverId === input.focus?.serverId && candidate.id === input.focus.scheduleId,
  );
  if (!schedule) {
    return { kind: "missing" };
  }
  return { kind: "found", serverId: schedule.serverId, schedule };
}
