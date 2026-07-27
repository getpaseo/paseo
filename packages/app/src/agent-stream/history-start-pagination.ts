import type { StreamRenderSegments } from "./model";

export const HISTORY_START_THRESHOLD_PX = 96;

export interface HistoryStartPaginationState {
  requestedRevision: string | null;
}

export function createHistoryStartPaginationState(): HistoryStartPaginationState {
  return { requestedRevision: null };
}

export function getHistoryRevision(segments: StreamRenderSegments): string {
  const oldest = segments.historyVirtualized[0] ?? segments.historyMounted[0];
  return [
    oldest?.id ?? "empty",
    segments.historyVirtualized.length,
    segments.historyMounted.length,
  ].join(":");
}

export function evaluateHistoryStartPagination(
  state: HistoryStartPaginationState,
  input: {
    distanceFromHistoryStart: number;
    hasOlderHistory: boolean;
    isLoadingOlderHistory: boolean;
    isReady: boolean;
    revision: string;
  },
): { state: HistoryStartPaginationState; shouldLoad: boolean } {
  if (input.distanceFromHistoryStart > HISTORY_START_THRESHOLD_PX) {
    return { state: createHistoryStartPaginationState(), shouldLoad: false };
  }
  if (!input.isReady || !input.hasOlderHistory || input.isLoadingOlderHistory) {
    return { state, shouldLoad: false };
  }
  if (state.requestedRevision === input.revision) {
    return { state, shouldLoad: false };
  }
  return {
    state: { requestedRevision: input.revision },
    shouldLoad: true,
  };
}
