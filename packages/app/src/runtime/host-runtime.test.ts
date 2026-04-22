import { describe, expect, it, vi } from "vitest";
import type {
  DaemonClient,
  ConnectionState,
  FetchAgentsEntry,
  FetchAgentsOptions,
} from "@server/client/daemon-client";
import type { ConnectionOffer } from "@server/shared/connection-offer";
import type { HostConnection, HostProfile } from "@/types/host-connection";
import { useSessionStore, type Agent } from "@/stores/session-store";
import {
  HostRuntimeController,
  HostRuntimeStore,
  type HostRuntimeControllerDeps,
  type HostRuntimeSnapshot,
} from "./host-runtime";

class FakeDaemonClient {
  private state: ConnectionState = { status: "idle" };
  private listeners = new Set<(status: ConnectionState) => void>();
  private error: string | null = null;
  public connectCalls = 0;
  public closeCalls = 0;
  public ensureConnectedCalls = 0;
  public fetchAgentsCalls: FetchAgentsOptions[] = [];
  public fetchAgentsResponses: Array<Awaited<ReturnType<DaemonClient["fetchAgents"]>>> = [];

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

  subscribeConnectionStatus(listener: (status: ConnectionState) => void): () => void {
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
    options?: FetchAgentsOptions,
  ): Promise<Awaited<ReturnType<DaemonClient["fetchAgents"]>>> {
    this.fetchAgentsCalls.push(options ?? {});
    const queued = this.fetchAgentsResponses.shift();
    if (queued) {
      return queued;
    }
    return makeFetchAgentsPayload({
      entries: [],
      subscriptionId: options?.subscribe?.subscriptionId ?? undefined,
    });
  }

  async ping(): Promise<{ rttMs: number }> {
    return { rttMs: 0 };
  }

  setReconnectEnabled(_enabled: boolean): void {}

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

function makeFetchAgentsPayload(input: {
  entries: FetchAgentsEntry[];
  hasMore?: boolean;
  nextCursor?: string | null;
  subscriptionId?: string;
}): Awaited<ReturnType<DaemonClient["fetchAgents"]>> {
  return {
    entries: input.entries,
    pageInfo: {
      nextCursor: input.nextCursor ?? null,
      prevCursor: null,
      hasMore: input.hasMore ?? false,
    } as Awaited<ReturnType<DaemonClient["fetchAgents"]>>["pageInfo"],
    ...(input.subscriptionId ? { subscriptionId: input.subscriptionId } : {}),
    requestId: "req_test",
  };
}

function makeFetchAgentsEntry(input: {
  id: string;
  cwd: string;
  updatedAt: string;
  title?: string | null;
  requiresAttention?: boolean;
  attentionReason?: "permission" | "error" | null;
  archivedAt?: string | null;
}): FetchAgentsEntry {
  return {
    agent: {
      id: input.id,
      provider: "codex",
      status: "idle",
      createdAt: input.updatedAt,
      updatedAt: input.updatedAt,
      lastUserMessageAt: null,
      lastError: undefined,
      runtimeInfo: {
        provider: "codex",
        sessionId: null,
      },
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
      },
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      title: input.title ?? null,
      cwd: input.cwd,
      model: null,
      thinkingOptionId: null,
      requiresAttention: input.requiresAttention ?? false,
      attentionReason: input.attentionReason ?? null,
      attentionTimestamp: input.requiresAttention && input.attentionReason ? input.updatedAt : null,
      archivedAt: input.archivedAt ?? null,
      labels: {},
    },
    project: {
      projectKey: input.cwd,
      projectName: "workspace",
      checkout: {
        cwd: input.cwd,
        isGit: false,
        currentBranch: null,
        remoteUrl: null,
        worktreeRoot: null,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
    },
  };
}

function makeHost(input?: Partial<HostProfile>): HostProfile {
  const direct: HostConnection = {
    id: "direct:lan:6767",
    type: "directTcp",
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
    lifecycle: input?.lifecycle ?? {},
    connections: input?.connections ?? [direct, relay],
    preferredConnectionId: input?.preferredConnectionId ?? direct.id,
    createdAt: input?.createdAt ?? new Date(0).toISOString(),
    updatedAt: input?.updatedAt ?? new Date(0).toISOString(),
  };
}

function makeOffer(input?: Partial<ConnectionOffer>): ConnectionOffer {
  return {
    v: 2,
    serverId: input?.serverId ?? "srv_offer",
    daemonPublicKeyB64: input?.daemonPublicKeyB64 ?? "pk_test_offer",
    relay: {
      endpoint: input?.relay?.endpoint ?? "relay.paseo.sh:443",
    },
  };
}

function makeDeps(
  latencyByConnectionId: Record<string, number | Error>,
  createdClients: FakeDaemonClient[],
): HostRuntimeControllerDeps {
  return {
    createClient: () => {
      const client = new FakeDaemonClient();
      createdClients.push(client);
      return client as unknown as DaemonClient;
    },
    connectToDaemon: async ({ host, connection }) => {
      const readLatency = (): number => {
        const value = latencyByConnectionId[connection.id];
        if (value instanceof Error) {
          throw value;
        }
        if (typeof value !== "number") {
          throw new Error(`missing latency for ${connection.id}`);
        }
        return value;
      };
      readLatency();
      const client = new FakeDaemonClient();
      client.connectCalls = 1;
      client.setConnectionState({ status: "connected" });
      client.ping = async () => ({ rttMs: readLatency() });
      createdClients.push(client);
      return {
        client: client as unknown as DaemonClient,
        serverId: host.serverId,
        hostname: host.label ?? null,
      };
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

function makeConnectedProbeClient(latencyMs: number): FakeDaemonClient {
  const client = new FakeDaemonClient();
  client.connectCalls = 1;
  client.setConnectionState({ status: "connected" });
  client.ping = async () => ({ rttMs: latencyMs });
  return client;
}

function clearProbeBackoff(controller: HostRuntimeController): void {
  (
    controller as unknown as {
      connectionLastProbedAt: Map<string, number>;
    }
  ).connectionLastProbedAt.clear();
}

type HostRuntimeSnapshotPatch = Partial<Omit<HostRuntimeSnapshot, "serverId" | "clientGeneration">>;

function updateControllerSnapshot(
  controller: HostRuntimeController,
  patch: HostRuntimeSnapshotPatch,
): void {
  (
    controller as unknown as {
      updateSnapshot: (patch: HostRuntimeSnapshotPatch) => void;
    }
  ).updateSnapshot(patch);
}

function makeProbeMap(
  entries: Array<
    [string, HostRuntimeSnapshot["probeByConnectionId"] extends Map<string, infer T> ? T : never]
  >,
): HostRuntimeSnapshot["probeByConnectionId"] {
  return new Map(entries);
}

describe("HostRuntimeController", () => {
  it("keeps known hosts in connecting when a created client reports idle during connect", async () => {
    const host = makeHost({
      connections: [
        {
          id: "direct:lan:6767",
          type: "directTcp",
          endpoint: "lan:6767",
        },
      ],
    });
    const idleClient = new FakeDaemonClient();
    const deps: HostRuntimeControllerDeps = {
      createClient: () => idleClient as unknown as DaemonClient,
      connectToDaemon: async () => {
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

    await (
      controller as unknown as {
        switchToConnection: (input: { connectionId: string }) => Promise<void>;
      }
    ).switchToConnection({ connectionId: "direct:lan:6767" });

    expect(controller.getSnapshot().activeConnectionId).toBe("direct:lan:6767");
    expect(controller.getSnapshot().connectionStatus).toBe("connecting");
    expect(controller.getSnapshot().agentDirectoryStatus).toBe("initial_loading");
  });

  it("passes resolved client id into created active clients", async () => {
    const host = makeHost({
      connections: [
        {
          id: "direct:lan:6767",
          type: "directTcp",
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
        connectToDaemon: async () => {
          throw new Error("probe unavailable");
        },
        getClientId: async () => "cid_runtime_stable",
      },
    });

    await (
      controller as unknown as {
        switchToConnection: (input: { connectionId: string }) => Promise<void>;
      }
    ).switchToConnection({ connectionId: "direct:lan:6767" });

    expect(seenClientIds).toEqual(["cid_runtime_stable"]);
    expect(controller.getSnapshot().connectionStatus).toBe("online");
  });

  it("adopts the first successful probe on startup", async () => {
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
    expect(snapshot.activeConnectionId).toBe("direct:lan:6767");
    expect(snapshot.connectionStatus).toBe("online");
    expect(clients).toHaveLength(2);
    expect(snapshot.client).toBe(clients[0] as unknown as DaemonClient);
    expect(clients[0]?.connectCalls).toBe(1);
    expect(clients[1]?.closeCalls).toBe(1);
  });

  it("activates the first successful probe without waiting for slower probes", async () => {
    const host = makeHost({ preferredConnectionId: "direct:lan:6767" });
    const slowPing = createDeferred<number>();
    const clients: FakeDaemonClient[] = [];

    const controller = new HostRuntimeController({
      host,
      deps: {
        createClient: () => {
          throw new Error("should adopt the probe client");
        },
        connectToDaemon: async ({ host, connection }) => {
          const client = makeConnectedProbeClient(connection.id === "direct:lan:6767" ? 12 : 30);
          if (connection.id === "relay:relay.paseo.sh:443") {
            client.ping = async () => ({ rttMs: await slowPing.promise });
          }
          clients.push(client);
          return {
            client: client as unknown as DaemonClient,
            serverId: host.serverId,
            hostname: host.label ?? null,
          };
        },
        getClientId: async () => "cid_test_runtime",
      },
    });

    const probeCycle = controller.runProbeCycleNow();

    const timeoutAt = Date.now() + 200;
    while (Date.now() < timeoutAt) {
      const snapshot = controller.getSnapshot();
      if (
        snapshot.activeConnectionId === "direct:lan:6767" &&
        snapshot.connectionStatus === "online"
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(controller.getSnapshot().activeConnectionId).toBe("direct:lan:6767");
    expect(controller.getSnapshot().connectionStatus).toBe("online");

    slowPing.resolve(30);
    await probeCycle;
  });

  it("probes the active online connection through the existing client", async () => {
    const host = makeHost({ preferredConnectionId: "direct:lan:6767" });
    const probeAttempts: string[] = [];
    const latencies: Record<string, number | Error> = {
      "direct:lan:6767": 12,
      "relay:relay.paseo.sh:443": 65,
    };
    const controller = new HostRuntimeController({
      host,
      deps: {
        createClient: () => {
          throw new Error("should adopt probe clients");
        },
        connectToDaemon: async ({ host, connection }) => {
          probeAttempts.push(connection.id);
          const value = latencies[connection.id];
          if (value instanceof Error) {
            throw value;
          }
          if (typeof value !== "number") {
            throw new Error(`missing latency for ${connection.id}`);
          }
          return {
            client: makeConnectedProbeClient(value) as unknown as DaemonClient,
            serverId: host.serverId,
            hostname: host.label ?? null,
          };
        },
        getClientId: async () => "cid_test_runtime",
      },
    });

    await controller.start({ autoProbe: false });
    expect(controller.getSnapshot().activeConnectionId).toBe("direct:lan:6767");

    probeAttempts.length = 0;
    const activeClient = controller.getSnapshot().client as unknown as FakeDaemonClient;
    activeClient.ping = async () => ({ rttMs: 9 });
    clearProbeBackoff(controller);
    await controller.runProbeCycleNow();

    expect(probeAttempts).toEqual(["relay:relay.paseo.sh:443"]);
    expect(controller.getSnapshot().activeConnectionId).toBe("direct:lan:6767");
    expect(controller.getSnapshot().connectionStatus).toBe("online");
    expect(controller.getSnapshot().probeByConnectionId.get("direct:lan:6767")).toEqual({
      status: "available",
      latencyMs: 9,
    });
  });

  it("rejects probes that resolve to a different server id", async () => {
    const host = makeHost({
      serverId: "srv_old",
      connections: [
        {
          id: "direct:localhost:6767",
          type: "directTcp",
          endpoint: "localhost:6767",
        },
      ],
    });
    const mismatchedClient = makeConnectedProbeClient(8);
    const controller = new HostRuntimeController({
      host,
      deps: {
        createClient: () => {
          throw new Error("should not create active client");
        },
        connectToDaemon: async () => ({
          client: mismatchedClient as unknown as DaemonClient,
          serverId: "srv_current",
          hostname: "current host",
        }),
        getClientId: async () => "cid_test_runtime",
      },
    });

    await controller.start({ autoProbe: false });

    expect(controller.getSnapshot().connectionStatus).toBe("connecting");
    expect(controller.getSnapshot().activeConnectionId).toBeNull();
    expect(controller.getSnapshot().probeByConnectionId.get("direct:localhost:6767")).toEqual({
      status: "unavailable",
      latencyMs: null,
    });
    expect(mismatchedClient.closeCalls).toBe(1);
  });

  it("fails over when the active client ping fails", async () => {
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
    const initialClient = controller.getSnapshot().client;
    expect(initialClient).toBeTruthy();

    (initialClient as unknown as FakeDaemonClient).ping = async () => {
      throw new Error("active ping failed");
    };
    latencies["direct:lan:6767"] = new Error("direct unavailable");
    latencies["relay:relay.paseo.sh:443"] = 42;
    clearProbeBackoff(controller);
    await controller.runProbeCycleNow();

    const snapshot = controller.getSnapshot();
    expect(snapshot.activeConnectionId).toBe("relay:relay.paseo.sh:443");
    expect(snapshot.connectionStatus).toBe("online");
    expect(snapshot.client).not.toBe(initialClient);
    expect((initialClient as unknown as FakeDaemonClient | null)?.closeCalls).toBe(1);
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
    clearProbeBackoff(controller);
    await controller.runProbeCycleNow();
    expect(controller.getSnapshot().activeConnectionId).toBe("direct:lan:6767");

    clearProbeBackoff(controller);
    await controller.runProbeCycleNow();
    expect(controller.getSnapshot().activeConnectionId).toBe("direct:lan:6767");

    let switched = controller.getSnapshot().activeConnectionId === "relay:relay.paseo.sh:443";
    for (let index = 0; index < 6 && !switched; index += 1) {
      clearProbeBackoff(controller);
      await controller.runProbeCycleNow();
      switched = controller.getSnapshot().activeConnectionId === "relay:relay.paseo.sh:443";
    }
    expect(switched).toBe(true);
    expect(controller.getSnapshot().client).not.toBeNull();
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
    clearProbeBackoff(controller);
    await controller.runProbeCycleNow();
    expect(controller.getSnapshot().activeConnectionId).toBe("direct:lan:6767");

    latencies["direct:lan:6767"] = 20;
    latencies["relay:relay.paseo.sh:443"] = 90;
    clearProbeBackoff(controller);
    await controller.runProbeCycleNow();
    expect(controller.getSnapshot().activeConnectionId).toBe("direct:lan:6767");

    latencies["direct:lan:6767"] = 100;
    latencies["relay:relay.paseo.sh:443"] = 20;
    clearProbeBackoff(controller);
    await controller.runProbeCycleNow();
    expect(controller.getSnapshot().activeConnectionId).toBe("direct:lan:6767");

    clearProbeBackoff(controller);
    await controller.runProbeCycleNow();
    expect(controller.getSnapshot().activeConnectionId).toBe("direct:lan:6767");

    let switched = controller.getSnapshot().activeConnectionId === "relay:relay.paseo.sh:443";
    for (let index = 0; index < 6 && !switched; index += 1) {
      clearProbeBackoff(controller);
      await controller.runProbeCycleNow();
      switched = controller.getSnapshot().activeConnectionId === "relay:relay.paseo.sh:443";
    }
    expect(switched).toBe(true);
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

  it("preserves transport disconnect reasons on the runtime snapshot", async () => {
    const host = makeHost({
      connections: [
        {
          id: "direct:lan:6767",
          type: "directTcp",
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
        clients,
      ),
    });

    await controller.start({ autoProbe: false });
    clients[0]?.setConnectionState({
      status: "disconnected",
      reason: "transport closed",
    });

    expect(controller.getSnapshot()).toMatchObject({
      connectionStatus: "error",
      lastError: "transport closed",
    });
  });

  it("does not emit legacy typed reason-code transition logs", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const host = makeHost({
        connections: [
          {
            id: "direct:lan:6767",
            type: "directTcp",
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
          clients,
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
      const lastTransition = transitionPayloads[transitionPayloads.length - 1] ?? null;

      expect(lastTransition?.reasonCode).toBeUndefined();
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
          type: "directTcp",
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
      connectToDaemon: async ({ host }) => ({
        client: makeConnectedProbeClient(10) as unknown as DaemonClient,
        serverId: host.serverId,
        hostname: host.label ?? null,
      }),
      getClientId: async () => "cid_test_runtime",
    };
    const controller = new HostRuntimeController({
      host,
      deps,
    });

    const waitUntil = async (predicate: () => boolean, timeoutMs = 200): Promise<void> => {
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

  it("coalesces overlapping probe cycles instead of invalidating the in-flight result", async () => {
    const host = makeHost({
      connections: [
        {
          id: "direct:lan:6767",
          type: "directTcp",
          endpoint: "lan:6767",
        },
      ],
    });
    const slowProbe = createDeferred<number>();
    let probeCalls = 0;

    const controller = new HostRuntimeController({
      host,
      deps: {
        createClient: () => new FakeDaemonClient() as unknown as DaemonClient,
        connectToDaemon: async ({ host }) => {
          probeCalls += 1;
          const client = new FakeDaemonClient();
          client.connectCalls = 1;
          client.setConnectionState({ status: "connected" });
          client.ping = async () => {
            if (probeCalls === 1) {
              return { rttMs: await slowProbe.promise };
            }
            throw new Error("unexpected probe call");
          };
          return {
            client: client as unknown as DaemonClient,
            serverId: host.serverId,
            hostname: host.label ?? null,
          };
        },
        getClientId: async () => "cid_test_runtime",
      },
    });

    const first = controller.runProbeCycleNow();
    clearProbeBackoff(controller);
    const second = controller.runProbeCycleNow();
    expect(probeCalls).toBe(1);

    slowProbe.resolve(900);
    await Promise.all([first, second]);
    const probeAfterCycle = controller.getSnapshot().probeByConnectionId.get("direct:lan:6767");
    expect(probeAfterCycle).toEqual({
      status: "available",
      latencyMs: 900,
    });
  });

  it("keeps active client generation stable during background probe cycles", async () => {
    const host = makeHost({
      connections: [
        {
          id: "direct:lan:6767",
          type: "directTcp",
          endpoint: "lan:6767",
        },
      ],
    });
    const createdClients: FakeDaemonClient[] = [];

    const controller = new HostRuntimeController({
      host,
      deps: {
        createClient: () => {
          const client = new FakeDaemonClient();
          createdClients.push(client);
          return client as unknown as DaemonClient;
        },
        connectToDaemon: async ({ host }) => {
          const client = makeConnectedProbeClient(10);
          return {
            client: client as unknown as DaemonClient,
            serverId: host.serverId,
            hostname: host.label ?? null,
          };
        },
        getClientId: async () => "cid_test_runtime",
      },
    });

    await controller.start({ autoProbe: false });
    const activeClientBeforeProbes = controller.getSnapshot().client;
    const generationBeforeProbes = controller.getSnapshot().clientGeneration;

    clearProbeBackoff(controller);
    await controller.runProbeCycleNow();
    expect(controller.getSnapshot().client).toBe(activeClientBeforeProbes);
    expect(controller.getSnapshot().clientGeneration).toBe(generationBeforeProbes);
    expect(createdClients).toHaveLength(0);
  });

  it("does not notify or replace the snapshot for equal probe maps", () => {
    const controller = new HostRuntimeController({ host: makeHost() });
    const firstProbeMap = makeProbeMap([
      ["direct:lan:6767", { status: "available", latencyMs: 12 }],
    ]);
    const equalProbeMap = makeProbeMap([
      ["direct:lan:6767", { status: "available", latencyMs: 12 }],
    ]);

    updateControllerSnapshot(controller, { probeByConnectionId: firstProbeMap });
    const snapshotAfterFirstProbe = controller.getSnapshot();
    let notifyCount = 0;
    const unsubscribe = controller.subscribe(() => {
      notifyCount += 1;
    });

    updateControllerSnapshot(controller, { probeByConnectionId: equalProbeMap });

    expect(notifyCount).toBe(0);
    expect(controller.getSnapshot()).toBe(snapshotAfterFirstProbe);
    expect(controller.getSnapshot().probeByConnectionId).toBe(firstProbeMap);
    unsubscribe();
  });

  it("does not notify or replace the snapshot when connection status is already equal", () => {
    const controller = new HostRuntimeController({ host: makeHost() });

    updateControllerSnapshot(controller, { connectionStatus: "online" });
    const snapshotAfterOnline = controller.getSnapshot();
    let notifyCount = 0;
    const unsubscribe = controller.subscribe(() => {
      notifyCount += 1;
    });

    updateControllerSnapshot(controller, { connectionStatus: "online" });

    expect(notifyCount).toBe(0);
    expect(controller.getSnapshot()).toBe(snapshotAfterOnline);
    unsubscribe();
  });

  it("does not notify or replace the snapshot when every patched field is equal", () => {
    const controller = new HostRuntimeController({ host: makeHost() });
    const firstProbeMap = makeProbeMap([
      ["direct:lan:6767", { status: "available", latencyMs: 12 }],
    ]);
    const equalProbeMap = makeProbeMap([
      ["direct:lan:6767", { status: "available", latencyMs: 12 }],
    ]);

    updateControllerSnapshot(controller, {
      connectionStatus: "online",
      probeByConnectionId: firstProbeMap,
    });
    const snapshotAfterSetup = controller.getSnapshot();
    let notifyCount = 0;
    const unsubscribe = controller.subscribe(() => {
      notifyCount += 1;
    });

    updateControllerSnapshot(controller, {
      connectionStatus: "online",
      probeByConnectionId: equalProbeMap,
    });

    expect(notifyCount).toBe(0);
    expect(controller.getSnapshot()).toBe(snapshotAfterSetup);
    expect(controller.getSnapshot().probeByConnectionId).toBe(firstProbeMap);
    unsubscribe();
  });

  it("notifies once for a changed field while preserving equal field identity", () => {
    const controller = new HostRuntimeController({ host: makeHost() });
    const firstProbeMap = makeProbeMap([
      ["direct:lan:6767", { status: "available", latencyMs: 12 }],
    ]);
    const equalProbeMap = makeProbeMap([
      ["direct:lan:6767", { status: "available", latencyMs: 12 }],
    ]);

    updateControllerSnapshot(controller, {
      connectionStatus: "online",
      probeByConnectionId: firstProbeMap,
    });
    const snapshotBeforeChange = controller.getSnapshot();
    let notifyCount = 0;
    const unsubscribe = controller.subscribe(() => {
      notifyCount += 1;
    });

    updateControllerSnapshot(controller, {
      connectionStatus: "offline",
      probeByConnectionId: equalProbeMap,
    });

    expect(notifyCount).toBe(1);
    expect(controller.getSnapshot()).not.toBe(snapshotBeforeChange);
    expect(controller.getSnapshot().connectionStatus).toBe("offline");
    expect(controller.getSnapshot().probeByConnectionId).toBe(firstProbeMap);
    unsubscribe();
  });

  it("notifies once and replaces the probe map when probe contents change", () => {
    const controller = new HostRuntimeController({ host: makeHost() });
    const firstProbeMap = makeProbeMap([
      ["direct:lan:6767", { status: "available", latencyMs: 12 }],
    ]);
    const changedProbeMap = makeProbeMap([
      ["direct:lan:6767", { status: "available", latencyMs: 12 }],
      ["relay:relay.paseo.sh:443", { status: "unavailable", latencyMs: null }],
    ]);

    updateControllerSnapshot(controller, { probeByConnectionId: firstProbeMap });
    const snapshotBeforeChange = controller.getSnapshot();
    let notifyCount = 0;
    const unsubscribe = controller.subscribe(() => {
      notifyCount += 1;
    });

    updateControllerSnapshot(controller, { probeByConnectionId: changedProbeMap });

    expect(notifyCount).toBe(1);
    expect(controller.getSnapshot()).not.toBe(snapshotBeforeChange);
    expect(controller.getSnapshot().probeByConnectionId).toBe(changedProbeMap);
    expect(controller.getSnapshot().probeByConnectionId).not.toBe(firstProbeMap);
    unsubscribe();
  });
});

describe("HostRuntimeStore", () => {
  it("bootstraps agent directory subscription when host transitions online", async () => {
    const host = makeHost({
      connections: [
        {
          id: "direct:lan:6767",
          type: "directTcp",
          endpoint: "lan:6767",
        },
      ],
    });
    const fakeClient = new FakeDaemonClient();
    fakeClient.setConnectionState({ status: "connected" });
    const store = new HostRuntimeStore({
      deps: {
        createClient: () => fakeClient as unknown as DaemonClient,
        connectToDaemon: async ({ host }) => ({
          client: fakeClient as unknown as DaemonClient,
          serverId: host.serverId,
          hostname: host.label ?? null,
        }),
        getClientId: async () => "cid_test_runtime",
      },
    });

    useSessionStore
      .getState()
      .initializeSession(host.serverId, fakeClient as unknown as DaemonClient);
    store.syncHosts([host]);

    const timeoutAt = Date.now() + 200;
    while (fakeClient.fetchAgentsCalls.length === 0 && Date.now() < timeoutAt) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(fakeClient.fetchAgentsCalls).toHaveLength(1);
    expect(fakeClient.fetchAgentsCalls[0]).toEqual({
      scope: "active",
      sort: [{ key: "updated_at", direction: "desc" }],
      subscribe: { subscriptionId: "app:srv_test" },
      page: { limit: 200 },
    });

    const snapshot = store.getSnapshot(host.serverId);
    expect(snapshot?.agentDirectoryStatus).toBe("ready");
    expect(snapshot?.hasEverLoadedAgentDirectory).toBe(true);

    store.syncHosts([]);
    useSessionStore.getState().clearSession(host.serverId);
  });

  it("bootstraps agent directory immediately when connection goes online (no session required)", async () => {
    const host = makeHost({
      serverId: "srv_no_session",
      connections: [
        {
          id: "direct:lan:6767",
          type: "directTcp",
          endpoint: "lan:6767",
        },
      ],
    });
    const fakeClient = new FakeDaemonClient();
    fakeClient.setConnectionState({ status: "connected" });
    const store = new HostRuntimeStore({
      deps: {
        createClient: () => fakeClient as unknown as DaemonClient,
        connectToDaemon: async ({ host }) => ({
          client: fakeClient as unknown as DaemonClient,
          serverId: host.serverId,
          hostname: host.label ?? null,
        }),
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
      scope: "active",
      sort: [{ key: "updated_at", direction: "desc" }],
      subscribe: { subscriptionId: "app:srv_no_session" },
      page: { limit: 200 },
    });

    store.syncHosts([]);
  });

  it("fetches all pages during bootstrap within the active agent scope", async () => {
    const host = makeHost({
      serverId: "srv_paged",
      connections: [
        {
          id: "direct:lan:6767",
          type: "directTcp",
          endpoint: "lan:6767",
        },
      ],
    });
    const fakeClient = new FakeDaemonClient();
    fakeClient.setConnectionState({ status: "connected" });
    fakeClient.fetchAgentsResponses.push(
      makeFetchAgentsPayload({
        entries: [
          makeFetchAgentsEntry({
            id: "agent-recent",
            cwd: "/Users/moboudra/dev/paseo",
            updatedAt: "2026-03-04T12:00:00.000Z",
            title: "Recent agent",
          }),
        ],
        hasMore: true,
        nextCursor: "cursor-page-2",
        subscriptionId: "app:srv_paged",
      }),
      makeFetchAgentsPayload({
        entries: [
          makeFetchAgentsEntry({
            id: "agent-stale-attention",
            cwd: "/Users/moboudra/dev/paseo-pr67-review",
            updatedAt: "2026-02-20T08:00:00.000Z",
            title: "Needs triage",
            requiresAttention: true,
            attentionReason: "error",
          }),
        ],
        hasMore: false,
      }),
    );
    const store = new HostRuntimeStore({
      deps: {
        createClient: () => fakeClient as unknown as DaemonClient,
        connectToDaemon: async ({ host }) => ({
          client: fakeClient as unknown as DaemonClient,
          serverId: host.serverId,
          hostname: host.label ?? null,
        }),
        getClientId: async () => "cid_test_runtime",
      },
    });

    useSessionStore
      .getState()
      .initializeSession(host.serverId, fakeClient as unknown as DaemonClient);
    store.syncHosts([host]);

    const timeoutAt = Date.now() + 300;
    while (fakeClient.fetchAgentsCalls.length < 2 && Date.now() < timeoutAt) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(fakeClient.fetchAgentsCalls).toHaveLength(2);
    expect(fakeClient.fetchAgentsCalls[0]).toEqual({
      scope: "active",
      sort: [{ key: "updated_at", direction: "desc" }],
      subscribe: { subscriptionId: "app:srv_paged" },
      page: { limit: 200 },
    });
    expect(fakeClient.fetchAgentsCalls[1]).toEqual({
      scope: "active",
      sort: [{ key: "updated_at", direction: "desc" }],
      page: { limit: 200, cursor: "cursor-page-2" },
    });

    let staleAgent =
      useSessionStore.getState().sessions[host.serverId]?.agents?.get("agent-stale-attention") ??
      null;
    const staleTimeoutAt = Date.now() + 300;
    while (!staleAgent && Date.now() < staleTimeoutAt) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      staleAgent =
        useSessionStore.getState().sessions[host.serverId]?.agents?.get("agent-stale-attention") ??
        null;
    }
    expect(staleAgent?.requiresAttention).toBe(true);
    expect(staleAgent?.attentionReason).toBe("error");

    const snapshot = store.getSnapshot(host.serverId);
    expect(snapshot?.agentDirectoryStatus).toBe("ready");
    expect(snapshot?.hasEverLoadedAgentDirectory).toBe(true);

    store.syncHosts([]);
    useSessionStore.getState().clearSession(host.serverId);
  });

  it("re-subscribes agent directory updates after reconnect", async () => {
    const host = makeHost({
      serverId: "srv_resubscribe",
      connections: [
        {
          id: "direct:lan:6767",
          type: "directTcp",
          endpoint: "lan:6767",
        },
      ],
    });
    const fakeClient = new FakeDaemonClient();
    fakeClient.setConnectionState({ status: "connected" });
    const store = new HostRuntimeStore({
      deps: {
        createClient: () => fakeClient as unknown as DaemonClient,
        connectToDaemon: async ({ host }) => ({
          client: fakeClient as unknown as DaemonClient,
          serverId: host.serverId,
          hostname: host.label ?? null,
        }),
        getClientId: async () => "cid_test_runtime",
      },
    });

    useSessionStore
      .getState()
      .initializeSession(host.serverId, fakeClient as unknown as DaemonClient);
    store.syncHosts([host]);

    const initialTimeoutAt = Date.now() + 200;
    while (fakeClient.fetchAgentsCalls.length < 1 && Date.now() < initialTimeoutAt) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    fakeClient.setConnectionState({
      status: "disconnected",
      reason: "client_closed",
    });
    fakeClient.setConnectionState({ status: "connected" });

    const reconnectTimeoutAt = Date.now() + 200;
    while (fakeClient.fetchAgentsCalls.length < 2 && Date.now() < reconnectTimeoutAt) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(fakeClient.fetchAgentsCalls).toEqual([
      {
        scope: "active",
        sort: [{ key: "updated_at", direction: "desc" }],
        subscribe: { subscriptionId: "app:srv_resubscribe" },
        page: { limit: 200 },
      },
      {
        scope: "active",
        sort: [{ key: "updated_at", direction: "desc" }],
        subscribe: { subscriptionId: "app:srv_resubscribe" },
        page: { limit: 200 },
      },
    ]);

    store.syncHosts([]);
    useSessionStore.getState().clearSession(host.serverId);
  });

  it("replaces stale active session state when active bootstrap omits an agent", async () => {
    const host = makeHost({
      serverId: "srv_archived_rehydrate",
      connections: [
        {
          id: "direct:lan:6767",
          type: "directTcp",
          endpoint: "lan:6767",
        },
      ],
    });
    const fakeClient = new FakeDaemonClient();
    fakeClient.setConnectionState({ status: "connected" });
    fakeClient.fetchAgentsResponses.push(
      makeFetchAgentsPayload({
        entries: [],
        subscriptionId: "app:srv_archived_rehydrate",
      }),
    );
    const store = new HostRuntimeStore({
      deps: {
        createClient: () => fakeClient as unknown as DaemonClient,
        connectToDaemon: async ({ host }) => ({
          client: fakeClient as unknown as DaemonClient,
          serverId: host.serverId,
          hostname: host.label ?? null,
        }),
        getClientId: async () => "cid_test_runtime",
      },
    });

    useSessionStore
      .getState()
      .initializeSession(host.serverId, fakeClient as unknown as DaemonClient);
    useSessionStore.getState().setAgents(host.serverId, () => {
      const stale = makeFetchAgentsEntry({
        id: "agent-archived",
        cwd: "/Users/moboudra/dev/paseo",
        updatedAt: "2026-03-30T15:29:00.000Z",
        archivedAt: null,
        title: "Stale active copy",
      }).agent;
      const staleAgent: Agent = {
        ...stale,
        serverId: host.serverId,
        createdAt: new Date(stale.createdAt),
        updatedAt: new Date(stale.updatedAt),
        lastUserMessageAt: null,
        lastActivityAt: new Date(stale.updatedAt),
        archivedAt: stale.archivedAt ? new Date(stale.archivedAt) : null,
        attentionTimestamp: stale.attentionTimestamp ? new Date(stale.attentionTimestamp) : null,
      };
      return new Map([[stale.id, staleAgent]]);
    });

    store.syncHosts([host]);

    const timeoutAt = Date.now() + 300;
    while (
      useSessionStore.getState().sessions[host.serverId]?.agents.has("agent-archived") &&
      Date.now() < timeoutAt
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(useSessionStore.getState().sessions[host.serverId]?.agents.has("agent-archived")).toBe(
      false,
    );

    store.syncHosts([]);
    useSessionStore.getState().clearSession(host.serverId);
  });

  it("records unavailable startup probes when no connection can be established", async () => {
    const host = makeHost({
      connections: [
        {
          id: "direct:lan:6767",
          type: "directTcp",
          endpoint: "lan:6767",
        },
      ],
    });
    const store = new HostRuntimeStore({
      deps: {
        createClient: () => {
          throw new Error("create client failed");
        },
        connectToDaemon: async () => {
          throw new Error("probe unavailable");
        },
        getClientId: async () => "cid_test_runtime",
      },
    });

    store.syncHosts([host]);
    let snapshot = store.getSnapshot(host.serverId);
    const timeoutAt = Date.now() + 100;
    while (
      snapshot?.probeByConnectionId.get("direct:lan:6767")?.status !== "unavailable" &&
      Date.now() < timeoutAt
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      snapshot = store.getSnapshot(host.serverId);
    }

    expect(snapshot?.connectionStatus).toBe("connecting");
    expect(snapshot?.lastError).toBeNull();
    expect(snapshot?.probeByConnectionId.get("direct:lan:6767")).toEqual({
      status: "unavailable",
      latencyMs: null,
    });
  });

  it("renameHost updates label in memory", async () => {
    const store = new HostRuntimeStore({
      deps: {
        createClient: () => new FakeDaemonClient() as unknown as DaemonClient,
        connectToDaemon: async ({ host }) => ({
          client: makeConnectedProbeClient(5) as unknown as DaemonClient,
          serverId: host.serverId,
          hostname: host.label ?? null,
        }),
        getClientId: async () => "cid_test_runtime",
      },
    });

    // upsertDirectConnection goes through setHostsAndSync, which both sets
    // this.hosts and syncs controllers — matching the real init path.
    await store.upsertDirectConnection({
      serverId: "srv_rename",
      endpoint: "lan:6767",
      label: "old name",
    });
    expect(store.getHosts().find((h) => h.serverId === "srv_rename")?.label).toBe("old name");

    // persistHosts may throw in test env (no AsyncStorage/window), but the
    // in-memory state should still be updated by setHostsAndSync.
    await store.renameHost("srv_rename", "new name").catch(() => undefined);

    const renamed = store.getHosts().find((h) => h.serverId === "srv_rename");
    expect(renamed?.label).toBe("new name");

    store.syncHosts([]);
  });

  it("uses the advertised hostname when adding a relay host from a pairing offer", async () => {
    const store = new HostRuntimeStore({
      deps: {
        createClient: () => new FakeDaemonClient() as unknown as DaemonClient,
        connectToDaemon: async ({ host }) => ({
          client: makeConnectedProbeClient(5) as unknown as DaemonClient,
          serverId: host.serverId,
          hostname: host.label ?? null,
        }),
        getClientId: async () => "cid_test_runtime",
      },
    });

    await store.upsertConnectionFromOffer(makeOffer(), "mbp");

    const pairedHost = store.getHosts().find((host) => host.serverId === "srv_offer");
    expect(pairedHost?.label).toBe("mbp");

    store.syncHosts([]);
  });

  it("uses the latest advertised hostname when re-pairing an existing relay host", async () => {
    const store = new HostRuntimeStore({
      deps: {
        createClient: () => new FakeDaemonClient() as unknown as DaemonClient,
        connectToDaemon: async ({ host }) => ({
          client: makeConnectedProbeClient(5) as unknown as DaemonClient,
          serverId: host.serverId,
          hostname: host.label ?? null,
        }),
        getClientId: async () => "cid_test_runtime",
      },
    });

    await store.upsertRelayConnection({
      serverId: "srv_offer",
      relayEndpoint: "relay.paseo.sh:443",
      daemonPublicKeyB64: "pk_test_offer",
      label: "Custom name",
    });

    await store.upsertConnectionFromOffer(makeOffer(), "mbp");

    const pairedHost = store.getHosts().find((host) => host.serverId === "srv_offer");
    expect(pairedHost?.label).toBe("mbp");

    store.syncHosts([]);
  });
});
