import { createPaseoApi, type PaseoApi } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  PluginHost,
  PluginHostConnection,
  PluginHostPatch,
  PluginHostAddInput,
  PluginHostAddResult,
} from "@getpaseo/plugin/client";
import type { HostProfile } from "@/types/host-connection";
import type { HostRuntimeSnapshot } from "@/runtime/host-runtime";
import {
  parseHostPort,
  serializeConnectionUri,
  serializeRelayConnectionUri,
  shouldUseTlsForDefaultHostedRelay,
} from "@getpaseo/protocol/daemon-endpoints";
import { parseHostTarget, serializeSocketHostTarget } from "@getpaseo/protocol/host-target";
import {
  DEFAULT_SSH_DAEMON_PORT,
  serializeSshTransportUri,
} from "@getpaseo/protocol/ssh-transport";

type HostSnapshot = Pick<
  HostRuntimeSnapshot,
  | "connectionStatus"
  | "client"
  | "activeConnectionId"
  | "lastError"
  | "authFailureReason"
  | "lastOnlineAt"
>;
export interface PluginHostsSource {
  addHost(
    input: PluginHostAddInput,
    signal?: AbortSignal,
  ): Promise<
    | { status: "saved"; serverId: string }
    | { status: "password_required"; reason: "password_required" | "incorrect_password" }
    | { status: "cancelled" }
  >;
  getHosts(): readonly HostProfile[];
  getSnapshot(serverId: string): HostSnapshot | null;
  subscribeAll(listener: () => void): () => void;
  subscribeHostList(listener: () => void): () => void;
  renameHost(serverId: string, label: string): Promise<void>;
  setHostColor(serverId: string, color: PluginHost["appearance"]["color"]): Promise<void>;
  setHostBadgeDisplay(
    serverId: string,
    badge: PluginHost["appearance"]["badgeDisplay"],
  ): Promise<void>;
  removeHost(serverId: string): Promise<void>;
  removeConnection(serverId: string, connectionId: string): Promise<void>;
}
function redactSecret(message: string, secret: string | undefined): string {
  if (!secret) return message;
  for (const value of [
    secret,
    encodeURIComponent(secret),
    new URLSearchParams({ password: secret }).toString().slice(9),
  ]) {
    message = message.split(value).join("[redacted]");
  }
  return message;
}
type ProjectedHost = Omit<PluginHost, "update" | "remove" | "removeConnection" | "openSettings">;
function projectHost(profile: HostProfile, snapshot: HostSnapshot | null): ProjectedHost {
  const connections: PluginHostConnection[] = profile.connections.map((connection) => {
    switch (connection.type) {
      case "directTcp":
        return {
          id: connection.id,
          type: connection.type,
          endpoint: connection.endpoint,
          useTls: connection.useTls ?? false,
          uri: serializeConnectionUri({
            ...parseHostPort(connection.endpoint),
            useTls: connection.useTls ?? false,
          }),
        };
      case "directSocket":
        return {
          id: connection.id,
          type: connection.type,
          path: connection.path,
          uri: serializeSocketHostTarget("unix", connection.path),
        };
      case "directPipe":
        return {
          id: connection.id,
          type: connection.type,
          path: connection.path,
          uri: serializeSocketHostTarget("pipe", connection.path),
        };
      case "remoteSsh":
        return {
          id: connection.id,
          type: connection.type,
          host: connection.host,
          ...(connection.sshPort === undefined ? {} : { sshPort: connection.sshPort }),
          ...(connection.daemonPort === undefined ? {} : { daemonPort: connection.daemonPort }),
          uri: serializeSshTransportUri({
            host: connection.host,
            sshPort: connection.sshPort,
            daemonPort: connection.daemonPort ?? DEFAULT_SSH_DAEMON_PORT,
          }),
        };
      case "relay": {
        const useTls =
          connection.useTls ?? shouldUseTlsForDefaultHostedRelay(connection.relayEndpoint);
        return {
          id: connection.id,
          type: connection.type,
          relayEndpoint: connection.relayEndpoint,
          useTls,
          daemonPublicKeyB64: connection.daemonPublicKeyB64,
          ...(connection.minimumSecurityMode
            ? { minimumSecurityMode: connection.minimumSecurityMode }
            : {}),
          uri: serializeRelayConnectionUri({
            offer: {
              v: 2,
              serverId: profile.serverId,
              daemonPublicKeyB64: connection.daemonPublicKeyB64,
              relay: { endpoint: connection.relayEndpoint, useTls },
              ...(connection.minimumSecurityMode
                ? { minimumSecurityMode: connection.minimumSecurityMode }
                : {}),
            },
          }),
        };
      }
      case "routed":
        return {
          id: connection.id,
          type: connection.type,
          originServerId: connection.originServerId,
          uri: null,
        };
    }
  });
  const error = snapshot?.lastError ?? null;
  return {
    serverId: profile.serverId,
    label: profile.label,
    status: snapshot?.connectionStatus ?? "offline",
    appearance: { color: profile.appearance.color, badgeDisplay: profile.appearance.badgeDisplay },
    connections,
    activeConnectionId: snapshot?.activeConnectionId ?? null,
    error: error ? redactSecret(error, profile.password) : null,
    authFailureReason: snapshot?.authFailureReason ?? null,
    lastOnlineAt: snapshot?.lastOnlineAt ?? null,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

/** Each evaluated installation owns its borrowed APIs and registry subscriptions. */
export function createPluginHosts(
  source: PluginHostsSource,
  signal: AbortSignal,
  options: {
    openSettings(serverId: string): void;
    isManagedLocalHost(serverId: string): Promise<boolean>;
  },
) {
  const clients = new Map<
    string,
    { client: DaemonClient; api: PaseoApi; lifetime: AbortController }
  >();
  const listeners = new Set<() => void>();
  let snapshot: readonly PluginHost[] = [];
  let serialized = "";
  const entries = new Map<string, { data: ProjectedHost; handle: PluginHost }>();
  function assertHost(id: string) {
    if (signal.aborted) throw new Error("Plugin has stopped");
    if (!source.getHosts().some((host) => host.serverId === id))
      throw new Error(`Unknown Paseo host: ${id}`);
  }
  async function perform(id: string, action: () => Promise<void>): Promise<void> {
    const secret = source.getHosts().find((host) => host.serverId === id)?.password;
    try {
      await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A cause would expose the original error, including any password.
      // oxlint-disable-next-line preserve-caught-error
      throw new Error(redactSecret(message, secret));
    }
  }
  function readHosts(): { hosts: PluginHost[]; key: string } {
    const projected = source
      .getHosts()
      .map((profile) => projectHost(profile, source.getSnapshot(profile.serverId)));
    const ids = new Set(projected.map((host) => host.serverId));
    for (const id of entries.keys()) if (!ids.has(id)) entries.delete(id);
    const hosts = projected.map((data) => {
      let entry = entries.get(data.serverId);
      if (!entry) {
        const id = data.serverId;
        const read = () => entry!.data;
        const handle: PluginHost = {
          get serverId() {
            return read().serverId;
          },
          get label() {
            return read().label;
          },
          get status() {
            return read().status;
          },
          get appearance() {
            return read().appearance;
          },
          get connections() {
            return read().connections;
          },
          get activeConnectionId() {
            return read().activeConnectionId;
          },
          get error() {
            return read().error;
          },
          get authFailureReason() {
            return read().authFailureReason;
          },
          get lastOnlineAt() {
            return read().lastOnlineAt;
          },
          get createdAt() {
            return read().createdAt;
          },
          get updatedAt() {
            return read().updatedAt;
          },
          async update(patch: PluginHostPatch) {
            await perform(id, async () => {
              assertHost(id);
              if (patch.label !== undefined) await source.renameHost(id, patch.label);
              if (patch.appearance?.color !== undefined) {
                assertHost(id);
                await source.setHostColor(id, patch.appearance.color);
              }
              if (patch.appearance?.badgeDisplay !== undefined) {
                assertHost(id);
                await source.setHostBadgeDisplay(id, patch.appearance.badgeDisplay);
              }
            });
          },
          async remove() {
            await perform(id, async () => {
              assertHost(id);
              if (await options.isManagedLocalHost(id))
                throw new Error("Cannot remove the desktop daemon host");
              assertHost(id);
              await source.removeHost(id);
            });
          },
          async removeConnection(connectionId) {
            await perform(id, async () => {
              assertHost(id);
              const isManaged = await options.isManagedLocalHost(id);
              assertHost(id);
              const host = source.getHosts().find((candidate) => candidate.serverId === id)!;
              if (
                isManaged &&
                host.connections.length === 1 &&
                host.connections[0].id === connectionId
              ) {
                throw new Error("Cannot remove the desktop daemon host");
              }
              await source.removeConnection(id, connectionId);
            });
          },
          openSettings() {
            assertHost(id);
            options.openSettings(id);
          },
        };
        entry = { data, handle };
        entries.set(id, entry);
      } else entry.data = data;
      return entry.handle;
    });
    return { hosts, key: JSON.stringify(projected) };
  }
  function resolve(serverId: string): DaemonClient {
    if (signal.aborted) throw new Error("Plugin has stopped");
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
    if (serialized === next.key) return;
    serialized = next.key;
    snapshot = next.hosts;
    for (const listener of listeners) listener();
  }
  {
    const initial = readHosts();
    snapshot = initial.hosts;
    serialized = initial.key;
  }
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
    async addHost(input: PluginHostAddInput): Promise<PluginHostAddResult> {
      if (signal.aborted) throw new Error("Plugin has stopped");
      let result: Awaited<ReturnType<PluginHostsSource["addHost"]>>;
      try {
        result = await source.addHost(input, signal);
      } catch (error) {
        let secret: string | undefined;
        try {
          secret = parseHostTarget(input.connection).password;
        } catch {
          /* Invalid input has no parsed password. */
        }
        const message = redactSecret(
          error instanceof Error ? error.message : String(error),
          secret,
        );
        // The original error can contain the supplied credential.
        // oxlint-disable-next-line preserve-caught-error
        throw new Error(message);
      }
      if (result.status !== "saved") return result;
      const host = snapshot.find((item) => item.serverId === result.serverId);
      if (!host) throw new Error(`Unknown Paseo host: ${result.serverId}`);
      return { status: "saved", host };
    },
    observeHosts(listener: (hosts: readonly PluginHost[]) => void) {
      if (signal.aborted) throw new Error("Plugin has stopped");
      const notify = () => {
        try {
          listener(snapshot);
        } catch (error) {
          console.error("[Plugins] Host observer failed", error);
        }
      };
      listeners.add(notify);
      notify();
      return () => {
        listeners.delete(notify);
      };
    },
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
  };
}
