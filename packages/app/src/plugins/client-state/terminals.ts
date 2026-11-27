import type { PluginTerminalSnapshot } from "@getpaseo/plugin";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { TerminalsChanged } from "@getpaseo/protocol/messages";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { entityRefs } from "./refs";
import type { PluginTerminalsSource } from "./source";

interface TerminalHost {
  serverId: string;
  client: DaemonClient;
  epoch: number;
}
export interface TerminalHostsSource {
  subscribe(listener: () => void): () => void;
  getSnapshot(): readonly TerminalHost[];
}
interface Observation {
  client: DaemonClient;
  epoch: number;
  items: readonly PluginTerminalSnapshot[];
  release(): void;
}

/** One owned observation per connected host, shared by every plugin surface. */
export function createPluginTerminalsSource(hosts: TerminalHostsSource): PluginTerminalsSource {
  const observations = new Map<string, Observation>();
  const listeners = new Set<() => void>();
  let snapshot: readonly PluginTerminalSnapshot[] = Object.freeze([]);
  let errors: ReadonlyMap<string, Error> = new Map();
  let releaseHosts: (() => void) | null = null;
  function publish() {
    const next = [...observations.values()].flatMap((item) => item.items);
    if (next.length !== snapshot.length || next.some((item, index) => item !== snapshot[index]))
      snapshot = Object.freeze(next);
    for (const listener of listeners) listener();
  }
  function receive(hostId: string, observation: Observation, payload: TerminalsChanged["payload"]) {
    if (observations.get(hostId) !== observation) return;
    const previous = new Map(observation.items.map((item) => [item.ref.id, item]));
    observation.items = Object.freeze(
      payload.terminals.flatMap((terminal) => {
        // Host-wide observation includes unowned legacy terminals. Sidebar navigation needs a workspace.
        if (!terminal.workspaceId) return [];
        const ref = entityRefs.terminal(hostId, terminal.id);
        const workspace = entityRefs.workspace(hostId, terminal.workspaceId);
        const title = terminal.title ?? terminal.name;
        const createdAt = terminal.createdAt ?? null;
        const isScript = terminal.isScript === true;
        const cached = previous.get(terminal.id);
        if (
          cached &&
          cached.workspace === workspace &&
          cached.title === title &&
          cached.createdAt === createdAt &&
          cached.isScript === isScript
        )
          return [cached];
        return [Object.freeze({ ref, hostId, workspace, title, createdAt, isScript })];
      }),
    );
    errors = new Map([...errors].filter(([id]) => id !== hostId));
    publish();
  }
  function reconcile() {
    const active = new Map(hosts.getSnapshot().map((host) => [host.serverId, host]));
    for (const [id, observation] of observations) {
      if (
        active.get(id)?.client !== observation.client ||
        active.get(id)?.epoch !== observation.epoch
      ) {
        observations.delete(id);
        observation.release();
      }
    }
    errors = new Map([...errors].filter(([id]) => active.has(id)));
    for (const [hostId, { client, epoch }] of active) {
      if (observations.has(hostId)) continue;
      const observation: Observation = { client, epoch, items: [], release() {} };
      observations.set(hostId, observation);
      try {
        // The SDK owns the capability gate; a failed host is reported only to terminal readers.
        const subscription = client.observeTerminals({});
        const unsubscribe = subscription.subscribe({
          snapshot: (payload) => receive(hostId, observation, payload),
          update: (message) => {
            if (message.type === "terminals_changed") receive(hostId, observation, message.payload);
          },
          error: (error) => {
            if (observations.get(hostId) !== observation) return;
            errors = new Map(errors).set(
              hostId,
              error instanceof Error ? error : new Error(String(error)),
            );
            publish();
          },
        });
        void subscription.ready.catch(() => {}); // Observer owns error delivery.
        observation.release = () => {
          unsubscribe();
          void subscription.release().catch(() => {});
        };
      } catch (error) {
        errors = new Map(errors).set(
          hostId,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
    publish();
  }
  return {
    getSnapshot: () => snapshot,
    getErrors: () => errors,
    subscribe(listener) {
      listeners.add(listener);
      if (!releaseHosts) {
        releaseHosts = hosts.subscribe(reconcile);
        reconcile();
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size && releaseHosts) {
          releaseHosts();
          releaseHosts = null;
          for (const observation of observations.values()) observation.release();
          observations.clear();
          snapshot = Object.freeze([]);
          errors = new Map();
        }
      };
    },
  };
}

export const pluginTerminals = createPluginTerminalsSource({
  getSnapshot() {
    const runtime = getHostRuntimeStore();
    return runtime.getHosts().flatMap((host) => {
      const state = runtime.getSnapshot(host.serverId);
      return state?.connectionStatus === "online" && state.client
        ? [{ serverId: host.serverId, client: state.client, epoch: state.connectionEpoch }]
        : [];
    });
  },
  subscribe(listener) {
    const runtime = getHostRuntimeStore();
    const releaseRuntime = runtime.subscribeAll(listener);
    const releaseHosts = runtime.subscribeHostList(listener);
    return () => {
      releaseRuntime();
      releaseHosts();
    };
  },
});
