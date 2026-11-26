import { createStore, type StoreApi } from "zustand/vanilla";

export type AddHostMethod = "direct" | "ssh" | "link" | "scan";
export interface AddHostOptions {
  method?: AddHostMethod;
  /** The address the Remote SSH form starts with, from an add host link. */
  sshTarget?: string;
  onAdded?: (serverId: string) => void;
}

export interface AddHostSession {
  id: number;
  sshTarget: string;
  step: StoreApi<{ method: AddHostMethod | null }>;
  choose(method: AddHostMethod | null): void;
  close(): void;
  complete(result: { serverId: string }): void;
}

export function createAddHostFlow() {
  const store = createStore<{ session: AddHostSession | null }>(() => ({ session: null }));
  let nextId = 0;
  function createSession(options: AddHostOptions) {
    const step = createStore<{ method: AddHostMethod | null }>(() => ({
      method: options.method ?? null,
    }));
    const session = {
      id: ++nextId,
      sshTarget: options.sshTarget ?? "",
      step,
      choose(method: AddHostMethod | null) {
        step.setState({ method });
      },
      close() {
        if (store.getState().session === session) store.setState({ session: null });
      },
      complete({ serverId }: { serverId: string }) {
        if (store.getState().session !== session) return;
        session.close();
        options.onAdded?.(serverId);
      },
    };
    return session;
  }
  return {
    store,
    open(options: AddHostOptions = {}) {
      store.setState({ session: createSession(options) });
    },
  };
}
