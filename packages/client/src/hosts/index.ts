import { safeRandomId } from "../daemon-client-transport-utils.js";
import { DaemonClient } from "../daemon-client.js";
import type { DaemonTransportFactory } from "../daemon-client-transport-types.js";
import type { OwnedSubscription } from "../connection/index.js";
import type { PaseoApi, createPaseoApi } from "../index.js";
import type { HostAdd, HostUpdate, HostSummary, HostDirectory } from "@getpaseo/protocol/hosts";

export interface PaseoHostActions {
  list(): Promise<HostDirectory>;
  observe(): OwnedSubscription<HostDirectory>;
  add(input: HostAdd): Promise<HostSummary>;
  update(registrationId: string, patch: HostUpdate): Promise<HostSummary>;
  remove(registrationId: string): Promise<void>;
  client(serverId: string): Promise<PaseoApi>;
}

export function createHostChannelTransport(
  origin: DaemonClient,
  serverId: string,
  scopeId: string,
  initialRouteId: string | null,
  link = false,
): DaemonTransportFactory {
  let first: string | null = initialRouteId;
  return () => {
    const opens = new Set<() => void>();
    const closes = new Set<(event?: unknown) => void>();
    const messages = new Set<(data: unknown, binary: boolean) => void>();
    const errors = new Set<(error: unknown) => void>();
    let routeId: string | null = null;
    let closed = false;
    const cleanups: (() => void)[] = [];
    const close = (error?: unknown) => {
      if (closed) return;
      closed = true;
      if (error instanceof Error) Object.assign(error, { serverId });
      for (const cleanup of cleanups) cleanup();
      try {
        if (routeId) origin.closeHostRoute(routeId);
        else origin.cancelHostRoute(scopeId);
      } catch {
        /* Transport already closed. */
      }
      if (error) for (const handler of errors) handler(error);
      for (const handler of closes) handler(error);
    };
    cleanups.push(
      origin.subscribeRawMessages((message) => {
        if (message.type === "hosts.route.frame" && message.payload.subscriptionId === routeId) {
          for (const handler of messages) handler(message.payload.data, false);
        }
        if (message.type === "hosts.route.closed" && message.payload.subscriptionId === routeId)
          close(
            Object.assign(new Error(message.payload.message), {
              code: message.payload.code,
              serverId,
            }),
          );
      }),
    );
    cleanups.push(
      origin.subscribeHostFrames((frame) => {
        if (frame.routeId === routeId) for (const handler of messages) handler(frame.payload, true);
      }),
    );
    cleanups.push(
      origin.subscribeConnectionStatus((connectionState) => {
        if (connectionState.status !== "connected") close();
      }),
    );
    let opening: Promise<string>;
    if (first) opening = Promise.resolve(first);
    else opening = link ? origin.openHostLink(scopeId) : origin.openHostRoute(serverId, scopeId);
    first = null;
    void opening
      .then((id) => {
        if (closed) {
          origin.closeHostRoute(id);
          return;
        }
        routeId = id;
        for (const handler of opens) handler();
        return undefined;
      })
      .catch(close);
    return {
      send(data) {
        if (closed || !routeId)
          throw Object.assign(new Error(`Host ${serverId} is offline`), {
            code: "host_offline",
            serverId,
          });
        origin.sendHostFrame(
          routeId,
          typeof data === "string" || data instanceof Uint8Array ? data : new Uint8Array(data),
        );
      },
      close: () => close(),
      onOpen(handler) {
        opens.add(handler);
        return () => opens.delete(handler);
      },
      onClose(handler) {
        closes.add(handler);
        return () => closes.delete(handler);
      },
      onError(handler) {
        errors.add(handler);
        return () => errors.delete(handler);
      },
      onMessage(handler) {
        messages.add(handler);
        return () => messages.delete(handler);
      },
    };
  };
}

export function createHostActions(
  origin: DaemonClient,
  owner: {
    own<T extends { release(): Promise<void> }>(create: () => T): T;
    signal: AbortSignal;
    api: typeof createPaseoApi;
  },
): PaseoHostActions {
  const assertActive = () => {
    if (owner.signal.aborted) throw new Error("Paseo API is disposed");
  };
  return {
    list: () => {
      assertActive();
      return origin.listHosts();
    },
    observe: () => owner.own(() => origin.observeHosts()),
    add: (input) => {
      assertActive();
      return origin.addHost(input);
    },
    update: (id, patch) => {
      assertActive();
      return origin.updateHost(id, patch);
    },
    remove: (id) => {
      assertActive();
      return origin.removeHost(id);
    },
    async client(serverId) {
      assertActive();
      origin.requireConnectedHosts();
      if (origin.getLastServerInfoMessage()?.serverId === serverId) {
        const api = owner.api(origin, { signal: owner.signal });
        const scope = owner.own(() => ({ release: () => api.dispose() }));
        return { ...api, dispose: () => scope.release() };
      }
      const scopeId = safeRandomId();
      const cancel = () => origin.cancelHostRoute(scopeId);
      owner.signal.addEventListener("abort", cancel, { once: true });
      let routeId: string;
      try {
        routeId = await origin.openHostRoute(serverId, scopeId);
      } catch (error) {
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
          serverId,
        });
      } finally {
        owner.signal.removeEventListener("abort", cancel);
      }
      if (owner.signal.aborted) {
        origin.closeHostRoute(routeId);
        assertActive();
      }
      const client = new DaemonClient({
        url: "ws://routed-host/ws",
        clientId: scopeId,
        transportFactory: createHostChannelTransport(origin, serverId, scopeId, routeId),
        // Initial acquisition has a deadline; established scopes restore demand on loss.
        reconnect: { enabled: false },
      });
      const api = owner.api(client, { signal: owner.signal });
      const scope = owner.own(() => ({
        release: async () => {
          try {
            await api.dispose();
          } finally {
            await client.close();
          }
        },
      }));
      try {
        await client.connect();
        client.setReconnectEnabled(true);
        assertActive();
        return { ...api, dispose: () => scope.release() };
      } catch (error) {
        const failure = Object.assign(
          error instanceof Error ? error : new Error("Host handshake failed"),
          {
            code: error instanceof Error && "code" in error ? error.code : "host_offline",
            serverId,
          },
        );
        await scope.release();
        throw failure;
      }
    },
  };
}
