export const HISTORY_START_THRESHOLD_PX = 96;

export type HistoryStartPaginationState =
  | { status: "dormant" }
  | { status: "ready" }
  | { status: "loading"; requestedProgressKey: string; requestObserved: boolean }
  | { status: "settling"; loadedProgressKey: string }
  | { status: "latched" };

export interface HistoryStartPaginationInput {
  distanceFromHistoryStart: number;
  hasOlderHistory: boolean;
  isLoadingOlderHistory: boolean;
  isReady: boolean;
  progressKey: string | null;
  /** A native viewport cannot begin a scroll gesture if its content does not fill the screen. */
  autoFillUnscrollable?: boolean;
}

export interface HistoryStartPaginationTransition {
  state: HistoryStartPaginationState;
  shouldLoad: boolean;
}

export function isHistoryViewportUnscrollable(input: {
  viewportHeight: number;
  contentHeight: number;
}): boolean {
  return (
    Number.isFinite(input.viewportHeight) &&
    Number.isFinite(input.contentHeight) &&
    input.viewportHeight > 0 &&
    input.contentHeight > 0 &&
    input.contentHeight <= input.viewportHeight + 1
  );
}

export function createHistoryStartPaginationState(): HistoryStartPaginationState {
  return { status: "dormant" };
}

export function isHistoryStartLoadingOperation(state: HistoryStartPaginationState): boolean {
  return state.status === "loading" || state.status === "settling";
}

export function rearmHistoryStartPagination(
  state: HistoryStartPaginationState,
): HistoryStartPaginationState {
  return state.status === "dormant" || state.status === "latched" ? { status: "ready" } : state;
}

export function abandonHistoryStartPaginationRequest(
  state: HistoryStartPaginationState,
  requestedProgressKey: string,
): HistoryStartPaginationState {
  if (
    state.status !== "loading" ||
    state.requestObserved ||
    state.requestedProgressKey !== requestedProgressKey
  ) {
    return state;
  }
  return { status: "latched" };
}

function armUnscrollableHistoryStart(
  state: HistoryStartPaginationState,
  input: HistoryStartPaginationInput,
): HistoryStartPaginationState {
  if (
    state.status === "dormant" &&
    input.autoFillUnscrollable &&
    input.isReady &&
    input.hasOlderHistory &&
    !input.isLoadingOlderHistory &&
    input.progressKey !== null
  ) {
    return { status: "ready" };
  }
  return state;
}

export function evaluateHistoryStartPagination(
  state: HistoryStartPaginationState,
  input: HistoryStartPaginationInput,
): HistoryStartPaginationTransition {
  state = armUnscrollableHistoryStart(state, input);
  if (state.status === "dormant") {
    return { state, shouldLoad: false };
  }
  if (state.status === "loading") {
    if (input.progressKey !== null && input.progressKey !== state.requestedProgressKey) {
      return {
        state: { status: "settling", loadedProgressKey: input.progressKey },
        shouldLoad: false,
      };
    }
    if (input.isLoadingOlderHistory && !state.requestObserved) {
      return { state: { ...state, requestObserved: true }, shouldLoad: false };
    }
    if (!input.isLoadingOlderHistory && !input.hasOlderHistory) {
      return { state: { status: "latched" }, shouldLoad: false };
    }
    if (
      state.requestObserved &&
      !input.isLoadingOlderHistory &&
      input.progressKey === state.requestedProgressKey
    ) {
      return { state: { status: "latched" }, shouldLoad: false };
    }
    return { state, shouldLoad: false };
  }

  if (state.status === "settling") {
    return { state, shouldLoad: false };
  }

  const isAtHistoryStart = input.distanceFromHistoryStart <= HISTORY_START_THRESHOLD_PX;
  if (!isAtHistoryStart) {
    return state.status === "ready"
      ? { state, shouldLoad: false }
      : { state: { status: "ready" }, shouldLoad: false };
  }
  if (
    state.status === "latched" ||
    !input.isReady ||
    !input.hasOlderHistory ||
    input.isLoadingOlderHistory ||
    input.progressKey === null
  ) {
    return { state, shouldLoad: false };
  }
  return {
    state: {
      status: "loading",
      requestedProgressKey: input.progressKey,
      requestObserved: false,
    },
    shouldLoad: true,
  };
}

export function settleHistoryStartPagination(
  state: HistoryStartPaginationState,
  input: HistoryStartPaginationInput,
): HistoryStartPaginationTransition {
  if (state.status !== "settling") {
    return { state, shouldLoad: false };
  }
  const isAtHistoryStart = input.distanceFromHistoryStart <= HISTORY_START_THRESHOLD_PX;
  if (
    !isAtHistoryStart ||
    !input.isReady ||
    !input.hasOlderHistory ||
    input.isLoadingOlderHistory ||
    input.progressKey === null
  ) {
    return {
      state: isAtHistoryStart ? { status: "latched" } : { status: "ready" },
      shouldLoad: false,
    };
  }
  return {
    state: {
      status: "loading",
      requestedProgressKey: input.progressKey,
      requestObserved: false,
    },
    shouldLoad: true,
  };
}
