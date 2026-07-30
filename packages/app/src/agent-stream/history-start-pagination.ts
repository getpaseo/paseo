export const HISTORY_START_THRESHOLD_PX = 96;

export interface HistoryStartPaginationState {
  requestedProgressKey: string | null;
}

export function createHistoryStartPaginationState(): HistoryStartPaginationState {
  return { requestedProgressKey: null };
}

export function rearmHistoryStartPagination(
  _state: HistoryStartPaginationState,
): HistoryStartPaginationState {
  return createHistoryStartPaginationState();
}

export function evaluateHistoryStartPagination(
  state: HistoryStartPaginationState,
  input: {
    distanceFromHistoryStart: number;
    hasOlderHistory: boolean;
    isLoadingOlderHistory: boolean;
    isReady: boolean;
    progressKey: string | null;
  },
): { state: HistoryStartPaginationState; shouldLoad: boolean } {
  if (input.distanceFromHistoryStart > HISTORY_START_THRESHOLD_PX) {
    return { state: createHistoryStartPaginationState(), shouldLoad: false };
  }
  if (
    !input.isReady ||
    !input.hasOlderHistory ||
    input.isLoadingOlderHistory ||
    input.progressKey === null
  ) {
    return { state, shouldLoad: false };
  }
  if (state.requestedProgressKey === input.progressKey) {
    return { state, shouldLoad: false };
  }
  return {
    state: { requestedProgressKey: input.progressKey },
    shouldLoad: true,
  };
}
