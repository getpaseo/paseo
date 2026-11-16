import { getHostRuntimeStore } from "@/runtime/host-runtime";
import type { PluginConnectedHostsSource } from "./source";

interface PluginHostsRuntime {
  getHosts(): readonly { serverId: string }[];
  getSnapshot(serverId: string): { connectionStatus: string } | null | undefined;
  subscribeAll(listener: () => void): () => void;
  subscribeHostList(listener: () => void): () => void;
  acquireDirectoryDemand(serverId: string): () => void;
}

export function createConnectedPluginHosts(
  getRuntime: () => PluginHostsRuntime,
): PluginConnectedHostsSource {
  let snapshot: readonly string[] = [];
  const listeners = new Set<() => void>();
  let release: (() => void) | null = null;

  const source: PluginConnectedHostsSource = {
    getSnapshot() {
      const runtime = getRuntime();
      const next = runtime
        .getHosts()
        .filter((host) => runtime.getSnapshot(host.serverId)?.connectionStatus === "online")
        .map((host) => host.serverId);
      if (next.length !== snapshot.length || next.some((id, index) => id !== snapshot[index]))
        snapshot = Object.freeze(next);
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      if (!release) {
        const runtime = getRuntime();
        const demands = new Map<string, () => void>();
        const reconcile = () => {
          const ids = new Set(source.getSnapshot());
          for (const [id, releaseDemand] of demands) {
            if (!ids.has(id)) {
              demands.delete(id);
              releaseDemand();
            }
          }
          for (const id of ids) {
            if (!demands.has(id)) demands.set(id, runtime.acquireDirectoryDemand(id));
          }
        };
        const notify = () => {
          reconcile();
          for (const subscriber of listeners) subscriber();
        };
        const releaseRuntime = runtime.subscribeAll(notify);
        const releaseHosts = runtime.subscribeHostList(notify);
        reconcile();
        release = () => {
          releaseRuntime();
          releaseHosts();
          for (const releaseDemand of demands.values()) releaseDemand();
          demands.clear();
        };
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && release) {
          release();
          release = null;
        }
      };
    },
  };
  return source;
}
export const connectedPluginHosts = createConnectedPluginHosts(getHostRuntimeStore);
