import { createStore, type StoreApi } from "zustand/vanilla";
import { parseEtTransportUri } from "@getpaseo/protocol/et-transport";
import { parseSshTransportUri } from "@getpaseo/protocol/ssh-transport";

export type RemoteHostMethod = "ssh" | "et";
export type AddHostMethod = "direct" | RemoteHostMethod | "link" | "scan";

export function parseRemoteHostInput(method: RemoteHostMethod, address: string, password: string) {
  const target = address.trim();
  const credential = password === "" ? undefined : password;
  if (method === "et") {
    return { method, target: { ...parseEtTransportUri(target), password: credential } };
  }
  return { method, target: { ...parseSshTransportUri(target), password: credential } };
}
export interface AddHostOptions {
  method?: AddHostMethod;
  onAdded?: (serverId: string) => void;
}

export interface AddHostSession {
  id: number;
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
