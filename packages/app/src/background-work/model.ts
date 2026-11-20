import type { PaseoAgentBackgroundWorkItem as AgentBackgroundWorkItem } from "@getpaseo/client";

interface Port {
  list(): Promise<AgentBackgroundWorkItem[]>;
  stop?(item: AgentBackgroundWorkItem): Promise<void>;
  interruptSession?(): Promise<void>;
  observe(callbacks: {
    snapshot(): void;
    disconnected(): void;
    failed(): void;
    update(items: AgentBackgroundWorkItem[]): void;
  }): () => void;
}

interface BackgroundWorkState {
  status: "loading" | "stale" | "ready" | "error";
  items: AgentBackgroundWorkItem[] | null;
  stops?: Record<string, { status: "pending" | "error"; item: AgentBackgroundWorkItem }>;
  sessionStop?: "pending" | "error";
}

export function createBackgroundWorkModel(port: Port) {
  let state: BackgroundWorkState = { status: "loading", items: null };
  let sequence = 0;
  let stopGeneration = 0;
  let stop: (() => void) | undefined;
  let observationFailed = false;
  const listeners = new Set<() => void>();
  const publish = (next: BackgroundWorkState) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };
  const refresh = async () => {
    const request = ++sequence;
    publish({ status: state.items === null ? "loading" : "stale", items: state.items });
    try {
      const items = await port.list();
      if (request === sequence) publish({ status: "ready", items });
    } catch {
      if (request === sequence) publish({ status: "error", items: state.items });
    }
  };
  const start = () => {
    observationFailed = false;
    stop = port.observe({
      snapshot: () => {
        void refresh();
      },
      disconnected: () => {
        sequence++;
        stopGeneration++;
        const stops =
          state.stops &&
          Object.fromEntries(
            Object.entries(state.stops).map(([id, entry]) => [
              id,
              { ...entry, status: "error" as const },
            ]),
          );
        publish({
          status: state.items === null ? "loading" : "stale",
          items: state.items,
          ...(stops ? { stops } : {}),
          ...(state.sessionStop === "pending" ? { sessionStop: "error" } : {}),
        });
      },
      failed: () => {
        observationFailed = true;
        sequence++;
        publish({ status: "error", items: state.items });
      },
      update: (items) => {
        sequence++;
        publish({ status: "ready", items });
      },
    });
  };
  return {
    getSnapshot: () => state,
    dismissStop: (token: string) => {
      const stops = { ...state.stops };
      delete stops[token];
      publish({ ...state, stops });
    },
    stopItem: async (item: AgentBackgroundWorkItem) => {
      const token = item.stopToken;
      if (!port.stop || !token || state.stops?.[token]?.status === "pending") return;
      if (!state.items?.some((entry) => entry.stopToken === token)) return;
      const generation = stopGeneration;
      publish({ ...state, stops: { ...state.stops, [token]: { status: "pending", item } } });
      try {
        await port.stop(item);
        if (generation !== stopGeneration) return;
        const stops = { ...state.stops };
        delete stops[token];
        publish({ ...state, stops });
      } catch {
        if (generation === stopGeneration)
          publish({ ...state, stops: { ...state.stops, [token]: { status: "error", item } } });
      }
    },
    interruptSession: async () => {
      if (!port.interruptSession || state.status !== "ready" || state.sessionStop === "pending")
        return;
      const generation = stopGeneration;
      publish({ ...state, sessionStop: "pending" });
      try {
        await port.interruptSession();
        if (generation === stopGeneration) publish({ ...state, sessionStop: undefined });
      } catch {
        if (generation === stopGeneration) publish({ ...state, sessionStop: "error" });
      }
    },
    retry: () => {
      if (observationFailed) {
        stop?.();
        stop = undefined;
        publish({ status: state.items === null ? "loading" : "stale", items: state.items });
        start();
      } else {
        void refresh();
      }
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (!stop) start();
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          sequence++;
          stop?.();
          stop = undefined;
        }
      };
    },
  };
}
