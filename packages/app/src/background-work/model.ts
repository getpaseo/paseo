import type { PaseoAgentBackgroundWorkItem as AgentBackgroundWorkItem } from "@getpaseo/client";

interface Port {
  list(): Promise<AgentBackgroundWorkItem[]>;
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
}

export function createBackgroundWorkModel(port: Port) {
  let state: BackgroundWorkState = { status: "loading", items: null };
  let sequence = 0;
  let stop: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: BackgroundWorkState) => {
    state = next;
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
  return {
    getSnapshot: () => state,
    retry: () => {
      void refresh();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (!stop) {
        stop = port.observe({
          snapshot: () => {
            void refresh();
          },
          disconnected: () => {
            sequence++;
            publish({ status: state.items === null ? "loading" : "stale", items: state.items });
          },
          failed: () => {
            sequence++;
            publish({ status: "error", items: state.items });
          },
          update: (items) => {
            sequence++;
            publish({ status: "ready", items });
          },
        });
      }
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
