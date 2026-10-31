export const HISTORY_START_THRESHOLD_PX = 96;

export interface HistoryStartPaginationInput {
  distanceFromHistoryStart: number;
  isUnderfilled: boolean;
  hasOlderHistory: boolean;
  isLoadingOlderHistory: boolean;
  isReady: boolean;
  progressKey: string | null;
}

export interface HistoryStartPaginationState {
  status: "dormant" | "ready" | "loading" | "settling" | "failed";
  visible: boolean;
}

export function isHistoryStartLoadingOperation(state: HistoryStartPaginationState): boolean {
  return state.status === "loading" || state.status === "settling";
}

/** Owns one pagination operation, including the initial viewport reveal. */
export function createHistoryStartPagination(input: {
  initiallyVisible: boolean;
  read: () => HistoryStartPaginationInput | null;
  load: () => Promise<boolean>;
  changed: (state: HistoryStartPaginationState) => void;
  scheduleSettle: () => void;
}) {
  let state: HistoryStartPaginationState = { status: "dormant", visible: input.initiallyVisible };
  let requestedKey: string | null = null;
  let completed = false;
  let fill = false;
  let generation = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const publish = (status: HistoryStartPaginationState["status"], visible = state.visible) => {
    if (status === state.status && visible === state.visible) return;
    state = { status, visible };
    input.changed(state);
  };
  const clear = () => {
    generation++;
    clearTimeout(timeout);
    timeout = undefined;
  };
  const finish = (status: HistoryStartPaginationState["status"]) => {
    clear();
    publish(status, true);
  };
  const fail = () => finish("failed");

  const update = () => {
    const geometry = input.read();
    if (!geometry) return;
    if (state.status === "loading") {
      if (!completed) return;
      if (geometry.progressKey !== null && geometry.progressKey !== requestedKey) {
        publish("settling");
        input.scheduleSettle();
      } else if (!geometry.hasOlderHistory) {
        finish("dormant");
      }
      return;
    }
    if (state.status === "settling" || state.status === "failed" || !geometry.isReady) return;
    const atStart = geometry.distanceFromHistoryStart <= HISTORY_START_THRESHOLD_PX;
    if (state.status === "dormant" && !geometry.isUnderfilled) {
      publish("dormant", true);
      return;
    }
    if (!atStart || (!geometry.isUnderfilled && state.status !== "ready")) return;
    if (!geometry.hasOlderHistory) {
      finish("dormant");
      return;
    }
    if (geometry.isLoadingOlderHistory || geometry.progressKey === null) return;
    fill = geometry.isUnderfilled;
    requestedKey = geometry.progressKey;
    completed = false;
    publish("loading");
    const request = ++generation;
    timeout = setTimeout(() => {
      if (request === generation) fail();
    }, 15_000);
    void input.load().then(
      (applied) => {
        if (request !== generation) return undefined;
        if (!applied) {
          fail();
          return undefined;
        }
        completed = true;
        update();
        return undefined;
      },
      () => {
        if (request === generation) fail();
      },
    );
  };
  return {
    get state() {
      return state;
    },
    update,
    settle() {
      if (state.status !== "settling") return;
      const geometry = input.read();
      if (!geometry?.isReady) return;
      clear();
      if (fill && !geometry.isUnderfilled) {
        publish("dormant", true);
      } else if (geometry.distanceFromHistoryStart > HISTORY_START_THRESHOLD_PX) {
        publish("ready", true);
      } else if (!geometry.hasOlderHistory) {
        publish("dormant", true);
      } else {
        publish("ready");
        update();
      }
    },
    rearm() {
      if (state.status === "dormant" || state.status === "failed") publish("ready", true);
      update();
    },
    reveal() {
      publish(state.status, true);
    },
    reset(visible: boolean) {
      clear();
      publish("dormant", visible);
    },
    dispose: clear,
  };
}
