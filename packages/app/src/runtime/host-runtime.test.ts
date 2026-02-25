import { describe, expect, it, vi } from "vitest";
import type {
  DaemonClient,
  ConnectionState,
  FetchAgentsOptions,
} from "@server/client/daemon-client";
import type { HostConnection, HostProfile } from "@/contexts/daemon-registry-context";
import {
  HostRuntimeController,
  HostRuntimeStore,
  type HostRuntimeControllerDeps,
} from "./host-runtime";

class FakeDaemonClient {
  private state: ConnectionState = { status: "idle" };
  private listeners = new Set<(status: ConnectionState) => void>();
  private error: string | null = null;
  public connectCalls = 0;
  public closeCalls = 0;
  public ensureConnectedCalls = 0;
  public fetchAgentsCalls: FetchAgentsOptions[] = [];

  async connect(): Promise<void> {
    this.connectCalls += 1;
    this.setConnectionState({ status: "connected" });
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.setConnectionState({ status: "disconnected", reason: "client_closed" });
  }

  ensureConnected(): void {
    this.ensureConnectedCalls += 1;
    if (this.state.status !== "connected") {
      this.setConnectionState({ status: "connected" });
    }
  }

  getConnectionState(): ConnectionState {
    return this.state;
  }

  subscribeConnectionStatus(
    listener: (status: ConnectionState) => void
  ): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get lastError(): string | null {
    return this.error;
  }

  async fetchAgents(
    options?: FetchAgentsOptions
  ): Promise<{
    entries: [];
    pageInfo: {
      hasMoreBefore: false;
      hasMoreAfter: false;
      beforeCursor: null;
      afterCursor: null;
    };
    subscriptionId: string | null;
  }> {
    this.fetchAgentsCalls.push(options ?? {});
    return {
      entries: [],
      pageInfo: {
        hasMoreBefore: false,
        hasMoreAfter: false,
        beforeCursor: null,
        afterCursor: null,
      },
      subscriptionId: options?.subscribe?.subscriptionId ?? null,
    };
  }

  setConnectionState(next: ConnectionState): void {
    this.state = next;
    if (next.status === "disconnected") {
      this.error = next.reason ?? this.error;
    }
    for (const listener of this.listeners) {
      listener(next);
    }
  }
}

function makeHost(input?: Partial<HostProfile>): HostProfile {
  const direct: HostConnection = {
    id: "direct:lan:6767",
    type: "direct",
    endpoint: "lan:6767",
  };
  const relay: HostConnection = {
    id: "relay:relay.paseo.sh:443",
    type: "relay",
    relayEndpoint: "relay.paseo.sh:443",
    daemonPublicKeyB64: "pk_test",
  };

  return {
    serverId: input?.serverId ?? "srv_test",
    label: input?.label ?? "test host",
    connections: input?.connections ?? [direct, relay],
    preferredConnectionId: input?.preferredConnectionId ?? direct.id,
    createdAt: input?.createdAt ?? new Date(0).toISOString(),
    updatedAt: input?.updatedAt ?? new Date(0).toISOString(),
  };
}

function makeDeps(
  latencyByConnectionId: Record<string, number | Error>,
  createdClients: FakeDaemonClient[]
): HostRuntimeControllerDeps {
  return {
    createClient: () => {
      const client = new FakeDaemonClient();
      createdClients.push(client);
      return client as unknown as DaemonClient;
    },
    measureLatency: async ({ connection }) => {
      const value = latencyByConnectionId[connection.id];
      if (value instanceof Error) {
        throw value;
      }
      if (typeof value !== "number") {
        throw new Error(`missing latency for ${connection.id}`);
      }
      return value;
    },
    getClientId: async () => "cid_test_runtime",
  };
}

function createDeferred<T>() {
  let resolve: ((value: T | PromiseLike<T>) => void) | null = null;
  let reject: ((reason?: unknown) => void) | null = null;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    promise,
    resolve: (value: T | PromiseLike<T>) => resolve?.(value),
    reject: (reason?: unknown) => reject?.(reason),
  };
}

describe("HostRuntimeController", () => {
  it("keeps known hosts in connecting when client reports idle during connect", async () => {
    const host = makeHost({
      connections: [
        {
          id: "direct:lan:6767",
          type: "direct",
          endpoint: "lan:6767",
        },
      ],
    });
    const idleClient = new FakeDaemonClient();
    const deps: HostRuntimeControllerDeps = {
      createClient: () => idleClient as unknown as DaemonClient,
      measureLatency: async () => {
        throw new Error("probe unavailable");
      },
      getClientId: async () => "cid_test_runtime",
    };
    const controller = new HostRuntimeController({
      host,
      deps,
    });

    idleClient.connect = async () => {
      idleClient.connectCalls += 1;
      // Intentionally do not emit a connected state; stay in idle.
    };

    await controller.start({ autoProbe: false });

    expect(controller.getSnapshot().activeConnectionId).toBe("direct:lan:6767");
    expect(controller.getSnapshot().connectionStatus).toBe("connecting");
    expect(controller.getSnapshot().agentDirectoryStatus).toBe("initial_loading");
  });

  it("passes resolved client id into created active clients", async () => {
    const host = makeHost({
      connections: [
        {
          id: "direct:lan:6767",
          type: "direct",
          endpoint: "lan:6767",
        },
      ],
    });
    const seenClientIds: string[] = [];
    const fakeClient = new FakeDaemonClient();
    const controller = new HostRuntimeController({
      host,
      deps: {
        createClient: ({ clientId }) => {
          seenClientIds.push(clientId);
          return fakeClient as unknown as DaemonClient;
        },
        measureLatency: async () => 10,
        getClientId: async () => "cid_runtime_stable",
      },
    });

    await controller.start({ autoProbe: false });

    expect(seenClientIds).toEqual(["cid_runtime_stable"]);
    expect(controller.getSnapshot().connectionStatus).toBe("online");
  });

  it("selects the lowest-latency connection on startup", async () => {
    const host = makeHost({ preferredConnectionId: "direct:lan:6767" });
    const clients: FakeDaemonClient[] = [];
    const latencies: Record<string, number | Error> = {
      "direct:lan:6767": 82,
      "relay:relay.paseo.sh:443": 18,
    };
    const controller = new HostRuntimeController({
      host,
      deps: makeDeps(latencies, clients),
    });

    await controller.start({ autoProbe: false });

    const snapshot = controller.getSnapshot();
    expect(snapshot.activeConnectionId).toBe("relay:relay.paseo.sh:443");
    expect(snapshot.connectionStatus).toBe("online");
    expect(clients).toHaveLength(1);
    expect(clients[0]?.connectCalls).toBe(1);
  });

  it("fails over when active connection becomes unavailable", async () => {
    const host = makeHost({ preferredConnectionId: "direct:lan:6767" });
    const clients: FakeDaemonClient[] = [];
    const latencies: Record<string, number | Error> = {
      "direct:lan:6767": 15,
      "relay:relay.paseo.sh:443": 55,
    };
    const controller = new HostRuntimeController({
      host,
      deps: makeDeps(latencies, clients),
    });

    await controller.start({ autoProbe: false });
    expect(controller.getSnapshot().activeConnectionId).toBe("direct:lan:6767");
    expect(clients).toHaveLength(1);

    latencies["direct:lan:6767"] = new Error("direct unavailable");
    latencies["relay:relay.paseo.sh:443"] = 42;
    await controller.runProbeCycleNow();

    const snapshot = controller.getSnapshot();
    expect(snapshot.activeConnectionId).toBe("relay:relay.paseo.sh:443");
    expect(snapshot.connectionStatus).toBe("online");
    expect(clients).toHaveLength(2);
    expect(clients[0]?.closeCalls).toBe(1);
  });

  it("switches only after the faster alternative wins consecutive probes", async () => {
    const host = makeHost({ preferredConnectionId: "direct:lan:6767" });
    const clients: FakeDaemonClient[] = [];
    const latencies: Record<string, number | Error> = {
      "direct:lan:6767": 15,
      "relay:relay.paseo.sh:443": 60,
    };
    const controller = new HostRuntimeController({
      host,
      deps: makeDeps(latencies, clients),
    });

    await controller.start({ autoProbe: false });
    expect(controller.getSnapshot().activeConnectionId).toBe("direct:lan:6767");

    latencies["direct:lan:6767"] = 95;
    latencies["relay:relay.paseo.sh:443"] = 30;
    await controller.runProbeCycleNow();
    expect(controller.getSnapshot().activeConnectionId).toBe("direct:lan:6767");

    await controller.runProbeCycleNow();
    expect(controller.getSnapshot().activeConnectionId).toBe("direct:lan:6767");

    await controller.runProbeCycleNow();
    expect(controller.getSnapshot().activeConnectionId).toBe("relay:relay.paseo.sh:443");
    expect(clients).toHaveLength(2);
  });

  it("does not switch on a transient latency spike", async () => {
    const host = makeHost({ preferredConnectionId: "direct:lan:6767" });
    const clients: FakeDaemonClient[] = [];
    const latencies: Record<string, number | Error> = {
      "direct:lan:6767": 15,
      "relay:relay.paseo.sh:443": 80,
    };
    const controller = new HostRuntimeController({
      host,
      deps: makeDeps(latencies, clients),
    });

    await controller.start({ autoProbe: false });
    expect(controller.getSnapshot().activeConnectionId).toBe("direct:lan:6767");

    latencies["direct:lan:6767"] = 100;
    latencies["relay:relay.paseo.sh:443"] = 20;
    await controller.runProbeCycleNow();
    expect(controller.getSnapshot().activeConnectionId).toBe("direct:lan:6767");

    latencies["direct:lan:6767"] = 20;
    latencies["relay:relay.paseo.sh:443"] = 90;
    await controller.runProbeCycleNow();
    expect(controller.getSnapshot().activeConnectionId).toBe("direct:lan:6767");

    latencies["direct:lan:6767"] = 100;
    latencies["relay:relay.paseo.sh:443"] = 20;
    await controller.runProbeCycleNow();
    expect(controller.getSnapshot().activeConnectionId).toBe("direct:lan:6767");

    await controller.runProbeCycleNow();
    expect(controller.getSnapshot().activeConnectionId).toBe("direct:lan:6767");

    await controller.runProbeCycleNow();
    expect(controller.getSnapshot().activeConnectionId).toBe("relay:relay.paseo.sh:443");
  });

  it("exposes one snapshot with active connection and status from same source", async () => {
    const host = makeHost();
    const clients: FakeDaemonClient[] = [];
    const latencies: Record<string, number | Error> = {
      "direct:lan:6767": 12,
      "relay:relay.paseo.sh:443": 65,
    };
    const controller = new HostRuntimeController({
      host,
      deps: makeDeps(latencies, clients),
    });

    const observed = new Array<ReturnType<typeof controller.getSnapshot>>();
    const unsubscribe = controller.subscribe(() => {
      observed.push(controller.getSnapshot());
    });

    await controller.start({ autoProbe: false });

    clients[0]?.setConnectionState({
      status: "disconnected",
      reason: "transport closed",
    });

    const latest = observed[observed.length - 1];
    expect(latest?.activeConnectionId).toBe("direct:lan:6767");
    expect(latest?.connectionStatus).toBe("error");
    expect(latest?.lastError).toBe("transport closed");
    unsubscribe();
  });

  it("logs typed reason codes for connection transitions", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const host = makeHost({
        connections: [
          {
            id: "direct:lan:6767",
            type: "direct",
            endpoint: "lan:6767",
          },
        ],
      });
      const clients: FakeDaemonClient[] = [];
      const controller = new HostRuntimeController({
        host,
        deps: makeDeps(
          {
            "direct:lan:6767": 12,
          },
          clients
        ),
      });

      await controller.start({ autoProbe: false });
      clients[0]?.setConnectionState({
        status: "disconnected",
        reason: "transport closed",
      });

      const transitionPayloads = infoSpy.mock.calls
        .filter((call) => call[0] === "[HostRuntimeTransition]")
        .map((call) => call[1] as { reasonCode?: string | null });
      const lastTransition =
        transitionPayloads[transitionPayloads.length - 1] ?? null;

      expect(lastTransition?.reasonCode).toBe("transport_error");
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("marks directory loading on first connection before any directory sync succeeds", async () => {
    const host = makeHost();
    const clients: FakeDaemonClient[] = [];
    const latencies: Record<string, number | Error> = {
      "direct:lan:6767": 12,
      "relay:relay.paseo.sh:443": 65,
    };
    const controller = new HostRuntimeController({
      host,
      deps: makeDeps(latencies, clients),
    });

    await controller.start({ autoProbe: false });

    const snapshot = controller.getSnapshot();
    expect(snapshot.connectionStatus).toBe("online");
    expect(snapshot.hasEverLoadedAgentDirectory).toBe(false);
    expect(snapshot.agentDirectoryStatus).toBe("initial_loading");
  });

  it("keeps directory ready through reconnects after the first successful directory load", async () => {
    const host = makeHost();
    const clients: FakeDaemonClient[] = [];
    const latencies: Record<string, number | Error> = {
      "direct:lan:6767": 12,
      "relay:relay.paseo.sh:443": 65,
    };
    const controller = new HostRuntimeController({
      host,
      deps: makeDeps(latencies, clients),
    });

    await controller.start({ autoProbe: false });
    controller.markAgentDirectorySyncReady();
    expect(controller.getSnapshot().agentDirectoryStatus).toBe("ready");
    expect(controller.getSnapshot().hasEverLoadedAgentDirectory).toBe(true);

    clients[0]?.setConnectionState({
      status: "disconnected",
      reason: "client_closed",
    });
    expect(controller.getSnapshot().connectionStatus).toBe("offline");
    expect(controller.getSnapshot().agentDirectoryStatus).toBe("ready");

    clients[0]?.setConnectionState({ status: "connected" });
    expect(controller.getSnapshot().connectionStatus).toBe("online");
    expect(controller.getSnapshot().agentDirectoryStatus).toBe("ready");
  });

  it("stores directory sync errors as non-blocking after a successful directory load", async () => {
    const host = makeHost();
    const clients: FakeDaemonClient[] = [];
    const latencies: Record<string, number | Error> = {
      "direct:lan:6767": 12,
      "relay:relay.paseo.sh:443": 65,
    };
    const controller = new HostRuntimeController({
      host,
      deps: makeDeps(latencies, clients),
    });

    await controller.start({ autoProbe: false });
    controller.markAgentDirectorySyncReady();
    controller.markAgentDirectorySyncError("bootstrap failed");

    const snapshot = controller.getSnapshot();
    expect(snapshot.agentDirectoryStatus).toBe("error_after_ready");
    expect(snapshot.agentDirectoryError).toBe("bootstrap failed");
    expect(snapshot.hasEverLoadedAgentDirectory).toBe(true);
  });

  it("keeps online snapshots coupled to a live client reference", async () => {
    const host = makeHost();
    const clients: FakeDaemonClient[] = [];
    const latencies: Record<string, number | Error> = {
      "direct:lan:6767": 12,
      "relay:relay.paseo.sh:443": 65,
    };
    const controller = new HostRuntimeController({
      host,
      deps: makeDeps(latencies, clients),
    });

    const observed = new Array<ReturnType<typeof controller.getSnapshot>>();
    const unsubscribe = controller.subscribe(() => {
      observed.push(controller.getSnapshot());
    });

    await controller.start({ autoProbe: false });

    for (const snapshot of observed) {
      if (snapshot.connectionStatus === "online") {
        expect(snapshot.client).toBeTruthy();
      }
    }
    expect(controller.getSnapshot().connectionStatus).toBe("online");
    expect(controller.getSnapshot().client).toBeTruthy();
    unsubscribe();
  });

  it("ignores stale switch failures after a newer connection is already online", async () => {
    const host = makeHost({
      connections: [
        {
          id: "direct:lan:6767",
          type: "direct",
          endpoint: "lan:6767",
        },
        {
          id: "relay:relay.paseo.sh:443",
          type: "relay",
          relayEndpoint: "relay.paseo.sh:443",
          daemonPublicKeyB64: "pk_test",
        },
      ],
    });
    const firstConnectGate = createDeferred<void>();
    const createdClients: FakeDaemonClient[] = [];
    const deps: HostRuntimeControllerDeps = {
      createClient: ({ connection }) => {
        const client = new FakeDaemonClient();
        if (connection.id === "direct:lan:6767") {
          client.connect = async () => {
            client.connectCalls += 1;
            await firstConnectGate.promise;
            throw new Error("stale direct connect failed");
          };
        }
        createdClients.push(client);
        return client as unknown as DaemonClient;
      },
      measureLatency: async () => 10,
      getClientId: async () => "cid_test_runtime",
    };
    const controller = new HostRuntimeController({
      host,
      deps,
    });

    const waitUntil = async (
      predicate: () => boolean,
      timeoutMs = 200
    ): Promise<void> => {
      const timeoutAt = Date.now() + timeoutMs;
      while (!predicate()) {
        if (Date.now() >= timeoutAt) {
          throw new Error("timed out waiting for predicate");
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    };

    const switchDirect = (
      controller as unknown as {
        switchToConnection: (input: { connectionId: string }) => Promise<void>;
      }
    ).switchToConnection({ connectionId: "direct:lan:6767" });
    await waitUntil(() => {
      const snapshot = controller.getSnapshot();
      return (
        createdClients.length === 1 &&
        snapshot.activeConnectionId === "direct:lan:6767" &&
        snapshot.connectionStatus === "connecting"
      );
    });

    const switchRelay = (
      controller as unknown as {
        switchToConnection: (input: { connectionId: string }) => Promise<void>;
      }
    ).switchToConnection({ connectionId: "relay:relay.paseo.sh:443" });
    await waitUntil(() => {
      const snapshot = controller.getSnapshot();
      return (
        snapshot.activeConnectionId === "relay:relay.paseo.sh:443" &&
        snapshot.connectionStatus === "online"
      );
    });

    firstConnectGate.resolve();
    await Promise.allSettled([switchDirect, switchRelay]);

    const snapshot = controller.getSnapshot();
    expect(snapshot.activeConnectionId).toBe("relay:relay.paseo.sh:443");
    expect(snapshot.connectionStatus).toBe("online");
    expect(snapshot.lastError).toBeNull();
    expect(createdClients).toHaveLength(2);
    expect(createdClients[0]?.closeCalls).toBe(1);
  });

  it("ignores stale probe results when overlapping probe cycles finish out of order", async () => {
    const host = makeHost({
      connections: [
        {
          id: "direct:lan:6767",
          type: "direct",
          endpoint: "lan:6767",
        },
      ],
    });
    const slowProbe = createDeferred<number>();
    const fastProbe = createDeferred<number>();
    let probeCalls = 0;

    const controller = new HostRuntimeController({
      host,
      deps: {
        createClient: () => new FakeDaemonClient() as unknown as DaemonClient,
        measureLatency: async () => {
          probeCalls += 1;
          if (probeCalls === 1) {
            return await slowProbe.promise;
          }
          if (probeCalls === 2) {
            return await fastProbe.promise;
          }
          throw new Error("unexpected probe call");
        },
        getClientId: async () => "cid_test_runtime",
      },
    });

    const first = controller.runProbeCycleNow();
    const second = controller.runProbeCycleNow();

    fastProbe.resolve(12);
    await second;
    const probeAfterSecond = controller
      .getSnapshot()
      .probeByConnectionId.get("direct:lan:6767");
    expect(probeAfterSecond).toEqual({
      status: "available",
      latencyMs: 12,
    });

    slowProbe.resolve(900);
    await first;
    const probeAfterFirstSettles = controller
      .getSnapshot()
      .probeByConnectionId.get("direct:lan:6767");
    expect(probeAfterFirstSettles).toEqual({
      status: "available",
      latencyMs: 12,
    });
  });

  it("keeps active client generation stable while overlapping probes run", async () => {
    const host = makeHost({
      connections: [
        {
          id: "direct:lan:6767",
          type: "direct",
          endpoint: "lan:6767",
        },
      ],
    });
    const slowProbe = createDeferred<number>();
    const fastProbe = createDeferred<number>();
    const createdClients: FakeDaemonClient[] = [];
    let probeCalls = 0;

    const controller = new HostRuntimeController({
      host,
      deps: {
        createClient: () => {
          const client = new FakeDaemonClient();
          createdClients.push(client);
          return client as unknown as DaemonClient;
        },
        measureLatency: async () => {
          probeCalls += 1;
          if (probeCalls === 1) {
            return 10;
          }
          if (probeCalls === 2) {
            return await slowProbe.promise;
          }
          if (probeCalls === 3) {
            return await fastProbe.promise;
          }
          return 10;
        },
        getClientId: async () => "cid_test_runtime",
      },
    });

    await controller.start({ autoProbe: false });
    const activeClientBeforeProbes = controller.getSnapshot().client;
    const generationBeforeProbes = controller.getSnapshot().clientGeneration;

    const first = controller.runProbeCycleNow();
    const second = controller.runProbeCycleNow();

    fastProbe.resolve(12);
    await second;
    expect(controller.getSnapshot().client).toBe(activeClientBeforeProbes);
    expect(controller.getSnapshot().clientGeneration).toBe(
      generationBeforeProbes
    );

    slowProbe.resolve(999);
    await first;
    expect(controller.getSnapshot().client).toBe(activeClientBeforeProbes);
    expect(controller.getSnapshot().clientGeneration).toBe(
      generationBeforeProbes
    );
    expect(createdClients).toHaveLength(1);
    expect(createdClients[0]?.closeCalls).toBe(0);
  });
});

describe("HostRuntimeStore", () => {
  it("bootstraps agent directory subscription when host transitions online", async () => {
    const host = makeHost({
      connections: [
        {
          id: "direct:lan:6767",
          type: "direct",
          endpoint: "lan:6767",
        },
      ],
    });
    const fakeClient = new FakeDaemonClient();
    const store = new HostRuntimeStore({
      deps: {
        createClient: () => fakeClient as unknown as DaemonClient,
        measureLatency: async () => 5,
        getClientId: async () => "cid_test_runtime",
      },
    });

    store.syncHosts([host]);

    const timeoutAt = Date.now() + 200;
    while (fakeClient.fetchAgentsCalls.length === 0 && Date.now() < timeoutAt) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(fakeClient.fetchAgentsCalls).toHaveLength(1);
    expect(fakeClient.fetchAgentsCalls[0]).toEqual({
      filter: { labels: { ui: "true" } },
      subscribe: { subscriptionId: "app:srv_test" },
      page: { limit: 200 },
    });

    const snapshot = store.getSnapshot(host.serverId);
    expect(snapshot?.agentDirectoryStatus).toBe("ready");
    expect(snapshot?.hasEverLoadedAgentDirectory).toBe(true);

    store.syncHosts([]);
  });

  it("surfaces startup failures as error instead of leaving host idle", async () => {
    const host = makeHost({
      connections: [
        {
          id: "direct:lan:6767",
          type: "direct",
          endpoint: "lan:6767",
        },
      ],
    });
    const store = new HostRuntimeStore({
      deps: {
        createClient: () => {
          throw new Error("create client failed");
        },
        measureLatency: async () => {
          throw new Error("probe unavailable");
        },
        getClientId: async () => "cid_test_runtime",
      },
    });

    store.syncHosts([host]);
    let snapshot = store.getSnapshot(host.serverId);
    const timeoutAt = Date.now() + 100;
    while (snapshot?.connectionStatus !== "error" && Date.now() < timeoutAt) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      snapshot = store.getSnapshot(host.serverId);
    }

    expect(snapshot?.connectionStatus).toBe("error");
    expect(snapshot?.lastError).toBe("create client failed");
  });
});
