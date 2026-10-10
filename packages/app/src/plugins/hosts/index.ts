import { createPaseoApi, type PaseoApi } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { PluginHostSummary, PluginRemoteSshHostInput } from "@getpaseo/plugin/client";
import { parseSshTransportUri } from "@getpaseo/protocol/ssh-transport";

export interface PluginHostsSource {
  getHosts(): readonly { serverId: string; label: string }[];
  getSnapshot(serverId: string): {
    connectionStatus: PluginHostSummary["status"];
    client: DaemonClient | null;
  } | null;
  subscribeAll(listener: () => void): () => void;
  subscribeHostList(listener: () => void): () => void;
  /** Connects first and saves the host under the daemon's server ID; saves nothing on failure. */
  probeAndUpsertRemoteSshConnection(input: {
    host: string;
    sshPort?: number;
    daemonPort?: number;
    password?: string;
    label?: string;
  }): Promise<{ serverId: string }>;
  removeHost(serverId: string): Promise<void>;
}

export interface PluginHostsOptions {
  /** The host that serves this installation. A plugin cannot remove it. */
  selfServerId?: string;
}

/** Each evaluated installation owns its borrowed APIs and registry subscriptions. */
export function createPluginHosts(
  source: PluginHostsSource,
  signal: AbortSignal,
  options: PluginHostsOptions = {},
) {
  const clients = new Map<
    string,
    { client: DaemonClient; api: PaseoApi; lifetime: AbortController }
  >();
  const listeners = new Set<() => void>();
  let snapshot: readonly PluginHostSummary[] = [];
  function readHosts(): readonly PluginHostSummary[] {
    return source.getHosts().map(({ serverId, label }) => ({
      serverId,
      label,
      status: source.getSnapshot(serverId)?.connectionStatus ?? "offline",
    }));
  }
  function requireRunning() {
    if (signal.aborted) throw new Error("Plugin has stopped");
  }
  function resolve(serverId: string): DaemonClient {
    requireRunning();
    if (!source.getHosts().some((host) => host.serverId === serverId)) {
      throw new Error(`Unknown Paseo host: ${serverId}`);
    }
    const host = source.getSnapshot(serverId);
    if (host?.connectionStatus !== "online" || !host.client) {
      throw new Error(`Paseo host is disconnected: ${serverId}`);
    }
    return host.client;
  }
  function refresh() {
    for (const [serverId, entry] of clients) {
      if (
        !source.getHosts().some((host) => host.serverId === serverId) ||
        source.getSnapshot(serverId)?.client !== entry.client
      ) {
        entry.lifetime.abort();
        clients.delete(serverId);
      }
    }
    const next = readHosts();
    if (JSON.stringify(snapshot) === JSON.stringify(next)) return;
    snapshot = next;
    for (const listener of listeners) listener();
  }
  snapshot = readHosts();
  const unsubscribeRuntime = source.subscribeAll(refresh);
  const unsubscribeHosts = source.subscribeHostList(refresh);
  function stop() {
    unsubscribeRuntime();
    unsubscribeHosts();
    listeners.clear();
    for (const entry of clients.values()) entry.lifetime.abort();
    clients.clear();
  }
  if (signal.aborted) stop();
  else signal.addEventListener("abort", stop, { once: true });
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      if (signal.aborted) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getPaseoClient(serverId: string): PaseoApi {
      const client = resolve(serverId);
      const existing = clients.get(serverId);
      if (existing?.client === client) return existing.api;
      existing?.lifetime.abort();
      const lifetime = new AbortController();
      // Guard even retained SDK handles against unload, offline calls, and replaced connections.
      // Methods keep the real receiver because DaemonClient owns private state.
      const borrowed = new Proxy(client, {
        get(target, key) {
          const value: unknown = Reflect.get(target, key, target);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            if (lifetime.signal.aborted) throw new Error(`Paseo client is released: ${serverId}`);
            if (resolve(serverId) !== client) {
              throw new Error(`Paseo connection changed; call getPaseoClient again: ${serverId}`);
            }
            return Reflect.apply(value, target, args);
          };
        },
      });
      const api = createPaseoApi(borrowed, { signal: lifetime.signal });
      const dispose = api.dispose;
      api.dispose = () => {
        if (clients.get(serverId)?.api === api) clients.delete(serverId);
        lifetime.abort();
        return dispose();
      };
      clients.set(serverId, { client, api, lifetime });
      return api;
    },
    async addRemoteSshHost(input: PluginRemoteSshHostInput): Promise<PluginHostSummary> {
      requireRunning();
      const target = parseSshTransportUri(input.target);
      const { serverId } = await source.probeAndUpsertRemoteSshConnection({
        ...target,
        ...(input.label === undefined ? {} : { label: input.label }),
        ...(input.password === undefined ? {} : { password: input.password }),
      });
      // The store has saved the host by now; report it even if the plugin stopped meanwhile,
      // so the caller can track or remove what it created.
      if (!signal.aborted) refresh();
      const saved = source.getHosts().find((host) => host.serverId === serverId);
      return {
        serverId,
        label: saved?.label ?? input.label ?? serverId,
        status: source.getSnapshot(serverId)?.connectionStatus ?? "offline",
      };
    },
    async removeHost(serverId: string): Promise<void> {
      requireRunning();
      if (serverId === options.selfServerId) {
        throw new Error(`Plugin cannot remove its own host: ${serverId}`);
      }
      if (!source.getHosts().some((host) => host.serverId === serverId)) {
        throw new Error(`Unknown Paseo host: ${serverId}`);
      }
      await source.removeHost(serverId);
    },
  };
}
