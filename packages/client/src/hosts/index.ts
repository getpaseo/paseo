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

function encode(data: Uint8Array | ArrayBuffer): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let result = "";
  for (let start = 0; start < bytes.length; start += 8192)
    result += String.fromCharCode(...bytes.subarray(start, start + 8192));
  return globalThis.btoa(result);
}
function decode(data: string): Uint8Array {
  return Uint8Array.from(globalThis.atob(data), (char) => char.charCodeAt(0));
}

function routeTransport(
  origin: DaemonClient,
  serverId: string,
  scopeId: string,
  initialRouteId: string,
  state: { failure: Error | null },
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
      if (error instanceof Error) state.failure = Object.assign(error, { serverId });
      for (const cleanup of cleanups) cleanup();
      if (routeId) origin.closeHostRoute(routeId);
      if (error) for (const handler of errors) handler(error);
      for (const handler of closes) handler(error);
    };
    cleanups.push(
      origin.subscribeRawMessages((message) => {
        if (message.type === "hosts.route.frame" && message.payload.subscriptionId === routeId) {
          for (const handler of messages)
            handler(
              message.payload.binary ? decode(message.payload.data) : message.payload.data,
              message.payload.binary,
            );
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
      origin.subscribeConnectionStatus((connectionState) => {
        if (connectionState.status !== "connected") close();
      }),
    );
    const opening = first ? Promise.resolve(first) : origin.openHostRoute(serverId, scopeId);
    first = null;
    void opening
      .then((id) => {
        if (closed) {
          origin.closeHostRoute(id);
          return;
        }
        routeId = id;
        state.failure = null;
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
          typeof data === "string" ? data : encode(data),
          typeof data !== "string",
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
      } finally {
        owner.signal.removeEventListener("abort", cancel);
      }
      if (owner.signal.aborted) {
        origin.closeHostRoute(routeId);
        assertActive();
      }
      const state: { failure: Error | null } = { failure: null };
      const client = new DaemonClient({
        url: "ws://routed-host/ws",
        clientId: scopeId,
        transportFactory: routeTransport(origin, serverId, scopeId, routeId, state),
        routedClient: true,
        routedServerId: serverId,
        routedFailure: () => state.failure,
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
        assertActive();
        return { ...api, dispose: () => scope.release() };
      } catch (error) {
        const failure = state.failure ?? error;
        await scope.release();
        throw failure;
      }
    },
  };
}
