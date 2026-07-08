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
