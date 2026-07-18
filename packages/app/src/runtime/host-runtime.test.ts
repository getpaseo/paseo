import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DaemonClient,
  ConnectionState,
  FetchAgentsEntry,
  FetchAgentsOptions,
} from "@getpaseo/client/internal/daemon-client";
import type { ConnectionOffer } from "@getpaseo/protocol/connection-offer";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import type { HostConnection, HostProfile } from "@/types/host-connection";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { normalizeAgentSnapshot } from "@/utils/agent-snapshots";
import { isAgentArchiving, setAgentArchiving } from "@/hooks/use-archive-agent";
import { queryClient } from "@/data/query-client";
import {
  HostRuntimeController,
  HostRuntimeStore,
  readInitialDaemonConnectionHint,
  type HostRuntimeControllerDeps,
  type HostRuntimeStorage,
} from "./host-runtime";
import { ReplicaCache } from "./replica-cache";

class FakeDaemonClient {
  private state: ConnectionState = { status: "idle" };
  private listeners = new Set<(status: ConnectionState) => void>();
  private error: string | null = null;
  private heartbeatRttMs: number | null = null;
  private latencyMeasurementFailure: Error | null = null;
  private latencyMeasurementsRequested: Array<{ timeoutMs?: number }> = [];
  public connectCalls = 0;
  public fetchAgentsCalls: FetchAgentsOptions[] = [];
  public fetchAgentsResponses: Array<
    Awaited<ReturnType<DaemonClient["fetchAgents"]>> | ReturnType<DaemonClient["fetchAgents"]>
  > = [];
  public sentAgentMessages: Array<Parameters<DaemonClient["sendAgentMessage"]>> = [];
  public sendAgentMessageFailures: Error[] = [];
  public sendAgentMessageResponses: Promise<void>[] = [];
  private agentUpdateListeners = new Set<
    (message: Extract<SessionOutboundMessage, { type: "agent_update" }>) => void
  >();
  private fetchWaiters = new Set<() => void>();
  private agentListenerWaiters = new Set<() => void>();
  private sentMessageWaiters = new Set<() => void>();

  on(
    type: "agent_update",
    listener: (message: Extract<SessionOutboundMessage, { type: "agent_update" }>) => void,
  ): () => void {
    if (type === "agent_update") this.agentUpdateListeners.add(listener);
    for (const waiter of this.agentListenerWaiters) waiter();
    return () => this.agentUpdateListeners.delete(listener);
  }

  async waitForAgentUpdates(): Promise<void> {
    if (this.agentUpdateListeners.size > 0) return;
    await new Promise<void>((resolve) => {
      const waiter = () => {
        if (this.agentUpdateListeners.size === 0) return;
        this.agentListenerWaiters.delete(waiter);
        resolve();
      };
      this.agentListenerWaiters.add(waiter);
    });
  }

  agentUpdate(payload: Extract<SessionOutboundMessage, { type: "agent_update" }>["payload"]): void {
    for (const listener of this.agentUpdateListeners) {
      listener({ type: "agent_update", payload });
    }
  }

  async connect(): Promise<void> {
    this.connectCalls += 1;
    this.setConnectionState({ status: "connected" });
  }

  async close(): Promise<void> {
    this.setConnectionState({ status: "disconnected", reason: "client_closed" });
  }

  async sendAgentMessage(...args: Parameters<DaemonClient["sendAgentMessage"]>): Promise<void> {
    this.sentAgentMessages.push(args);
    for (const waiter of this.sentMessageWaiters) waiter();
    const response = this.sendAgentMessageResponses.shift();
    if (response) await response;
    const failure = this.sendAgentMessageFailures.shift();
    if (failure) throw failure;
  }

  async waitForSentMessages(count: number): Promise<void> {
    if (this.sentAgentMessages.length >= count) return;
    await new Promise<void>((resolve) => {
      const waiter = () => {
        if (this.sentAgentMessages.length < count) return;
        this.sentMessageWaiters.delete(waiter);
        resolve();
      };
      this.sentMessageWaiters.add(waiter);
    });
  }

  ensureConnected(): void {
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
    for (const waiter of this.fetchWaiters) waiter();
    const queued = this.fetchAgentsResponses.shift();
    if (queued) {
      return await queued;
    }
    return makeFetchAgentsPayload({
      entries: [],
      subscriptionId: options?.subscribe?.subscriptionId ?? undefined,
    });
  }

  async waitForFetches(count: number): Promise<void> {
    if (this.fetchAgentsCalls.length >= count) return;
    await new Promise<void>((resolve) => {
      const waiter = () => {
        if (this.fetchAgentsCalls.length < count) return;
        this.fetchWaiters.delete(waiter);
        resolve();
      };
      this.fetchWaiters.add(waiter);
    });
  }

  async ping(): Promise<{ rttMs: number }> {
    return { rttMs: 0 };
  }

  async measureLatency(params?: { timeoutMs?: number }): Promise<number> {
    this.latencyMeasurementsRequested.push(params ?? {});
    if (this.latencyMeasurementFailure) {
      throw this.latencyMeasurementFailure;
    }
    const result = await this.ping();
    return result.rttMs;
  }

  setReconnectEnabled(_enabled: boolean): void {}

  getLastLivenessRttMs(): number | null {
    return this.heartbeatRttMs;
  }

  heartbeatReportsRtt(rttMs: number | null): void {
    this.heartbeatRttMs = rttMs;
  }

  latencyMeasurementsFailWith(message: string): void {
    this.latencyMeasurementFailure = new Error(message);
  }

  latencyMeasurements(): Array<{ timeoutMs?: number }> {
    return this.latencyMeasurementsRequested;
  }

  clearLatencyMeasurements(): void {
    this.latencyMeasurementsRequested = [];
  }

  isDisposed(): boolean {
    return this.state.status === "disconnected" && this.state.reason === "client_closed";
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

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as Record<string, unknown>).__PASEO_INITIAL_DAEMON_CONNECTION__;
  delete (globalThis as { window?: unknown }).window;
});

function useHostRuntimeClock(): void {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"],
  });
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

class Deferred<T> {
  readonly promise: Promise<T>;
  private resolvePromise!: (value: T) => void;
  private rejectPromise!: (error: Error) => void;

  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this.resolvePromise = resolve;
      this.rejectPromise = reject;
    });
  }

  resolve(value: T): void {
    this.resolvePromise(value);
  }

  reject(error: Error): void {
    this.rejectPromise(error);
  }
}

async function waitForDirectoryReady(store: HostRuntimeStore, serverId: string): Promise<void> {
  if (store.getSnapshot(serverId)?.agentDirectoryStatus === "ready") return;
  await new Promise<void>((resolve) => {
    const unsubscribe = store.subscribe(serverId, () => {
      if (store.getSnapshot(serverId)?.agentDirectoryStatus !== "ready") return;
      unsubscribe();
      resolve();
    });
  });
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

function replicaAgent(snapshot: FetchAgentsEntry["agent"], serverId: string): Agent {
  return { ...normalizeAgentSnapshot(snapshot, serverId), projectPlacement: null };
}

function agentPermission(id: string): AgentPermissionRequest {
  return { id, provider: "codex", name: id, kind: "tool", title: id };
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
      useTls: input?.relay?.useTls ?? false,
    },
  };
}

function encodeOfferUrl(payload: unknown): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `https://app.paseo.sh/#offer=${encoded}`;
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

function createMemoryHostRuntimeStorage(entries: Record<string, string> = {}): HostRuntimeStorage {
  const values = new Map(Object.entries(entries));
  return {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      values.set(key, value);
    },
  };
}

function onceHostListMatches(store: HostRuntimeStore, predicate: () => boolean): Promise<void> {
  if (predicate()) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let unsubscribe = (): void => {};
    unsubscribe = store.subscribeHostList(() => {
      if (!predicate()) {
        return;
      }
      unsubscribe();
      resolve();
    });
  });
}

class BrowserClientLifecycle {
  public active: Array<{ serverId: string; connectionId: string }> = [];

  mount(input: { host: HostProfile; connection: HostConnection }): () => void {
    const entry = { serverId: input.host.serverId, connectionId: input.connection.id };
    this.active.push(entry);
    return () => {
      this.active = this.active.filter((current) => current !== entry);
    };
  }
}

describe("HostRuntimeController", () => {
  it("replaces the active relay client when re-pairing changes the daemon public key", async () => {
    const oldRelay: HostConnection = {
      id: "relay:wss:relay.paseo.sh:443",
      type: "relay",
      relayEndpoint: "relay.paseo.sh:443",
      useTls: true,
      daemonPublicKeyB64: "pk_old",
    };
    const newRelay: HostConnection = {
      ...oldRelay,
      daemonPublicKeyB64: "pk_new",
    };
    const createdClients: Array<{ client: FakeDaemonClient; connection: HostConnection }> = [];
    const controller = new HostRuntimeController({
      host: makeHost({
        connections: [oldRelay],
        preferredConnectionId: oldRelay.id,
      }),
      deps: {
        createClient: ({ connection }) => {
          const client = new FakeDaemonClient();
          createdClients.push({ client, connection });
          return client as unknown as DaemonClient;
        },
        connectToDaemon: async ({ host, connection }) => ({
          client: makeConnectedProbeClient(5) as unknown as DaemonClient,
          serverId: host.serverId,
          hostname: connection.id,
        }),
        getClientId: async () => "cid_test_runtime",
      },
    });

    await controller.activateConnection({ connectionId: oldRelay.id });
    expect(controller.getSnapshot().client).toBe(createdClients[0]?.client);

    await controller.updateHost(
      makeHost({
        connections: [newRelay],
        preferredConnectionId: newRelay.id,
      }),
    );

    expect(createdClients.map((entry) => entry.connection)).toEqual([oldRelay, newRelay]);
    expect(createdClients[0]?.client.isDisposed()).toBe(true);
    expect(controller.getSnapshot().client).toBe(createdClients[1]?.client);
  });

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

    await controller.activateConnection({ connectionId: "direct:lan:6767" });

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

    await controller.activateConnection({ connectionId: "direct:lan:6767" });

    expect(seenClientIds).toEqual(["cid_runtime_stable"]);
    expect(controller.getSnapshot().connectionStatus).toBe("online");
  });

  it("keeps browser client lifecycle tied to the active host runtime client", async () => {
    const host = makeHost({ preferredConnectionId: "direct:lan:6767" });
    const fakeClient = makeConnectedProbeClient(12);
    const lifecycle = new BrowserClientLifecycle();
    const controller = new HostRuntimeController({
      host,
      deps: {
        createClient: () => new FakeDaemonClient() as unknown as DaemonClient,
        connectToDaemon: async ({ host: hostProfile, connection }) => ({
          client: makeConnectedProbeClient(10) as unknown as DaemonClient,
          serverId: hostProfile.serverId,
          hostname: connection.id,
        }),
        getClientId: async () => "cid_runtime_stable",
        mountClientHandlers: (input) => lifecycle.mount(input),
      },
    });

    await controller.start({
      autoProbe: false,
      initialConnection: {
        connectionId: "direct:lan:6767",
        existingClient: fakeClient as unknown as DaemonClient,
      },
    });

    expect(lifecycle.active).toEqual([{ serverId: "srv_test", connectionId: "direct:lan:6767" }]);

    await controller.stop();

    expect(lifecycle.active).toEqual([]);
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
    expect(clients[1]?.isDisposed()).toBe(true);
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
        connectToDaemon: async ({ host: hostProfile, connection }) => {
          const client = makeConnectedProbeClient(connection.id === "direct:lan:6767" ? 12 : 30);
          if (connection.id === "relay:relay.paseo.sh:443") {
            client.ping = async () => ({ rttMs: await slowPing.promise });
          }
          clients.push(client);
          return {
            client: client as unknown as DaemonClient,
            serverId: hostProfile.serverId,
            hostname: hostProfile.label ?? null,
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

  it("ranks the live connection by its heartbeat RTT without pinging it again", async () => {
    useHostRuntimeClock();
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
        connectToDaemon: async ({ host: hostProfile, connection }) => {
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
            serverId: hostProfile.serverId,
            hostname: hostProfile.label ?? null,
          };
        },
        getClientId: async () => "cid_test_runtime",
      },
    });

    await controller.start({ autoProbe: false });
    expect(controller.getSnapshot().activeConnectionId).toBe("direct:lan:6767");

    probeAttempts.length = 0;
    const activeClient = controller.getSnapshot().client as unknown as FakeDaemonClient;
    activeClient.heartbeatReportsRtt(42);
    activeClient.clearLatencyMeasurements();
    activeClient.ping = async () => ({ rttMs: 9 });
    await vi.advanceTimersByTimeAsync(10_000);
    await controller.runProbeCycleNow();

    expect(probeAttempts).toEqual([]);
    expect(controller.getSnapshot().activeConnectionId).toBe("direct:lan:6767");
    expect(controller.getSnapshot().connectionStatus).toBe("online");
    expect(controller.getSnapshot().probeByConnectionId.get("direct:lan:6767")).toEqual({
      status: "available",
      latencyMs: 42,
    });
    expect(activeClient.latencyMeasurements()).toEqual([]);
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
    expect(mismatchedClient.isDisposed()).toBe(true);
  });

  it("keeps the live connection when one probe cycle looks slow", async () => {
    useHostRuntimeClock();
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

    const activeClient = initialClient as unknown as FakeDaemonClient;
    activeClient.heartbeatReportsRtt(200);
    activeClient.latencyMeasurementsFailWith("active measurement failed");
    latencies["relay:relay.paseo.sh:443"] = 42;
    await vi.advanceTimersByTimeAsync(120_000);
    await controller.runProbeCycleNow();

    const snapshot = controller.getSnapshot();
    expect(snapshot.activeConnectionId).toBe("direct:lan:6767");
    expect(snapshot.connectionStatus).toBe("online");
    expect(snapshot.client).toBe(initialClient);
    expect(activeClient.isDisposed()).toBe(false);
  });

  it("does not mark the live connection unavailable before its first heartbeat resolves", async () => {
    useHostRuntimeClock();
    const direct: HostConnection = {
      id: "direct:lan:6767",
      type: "directTcp",
      endpoint: "lan:6767",
    };
    const host = makeHost({
      connections: [direct],
      preferredConnectionId: direct.id,
    });
    const activeClient = new FakeDaemonClient();
    activeClient.setConnectionState({ status: "connected" });
    activeClient.latencyMeasurementsFailWith("heartbeat has not resolved");
    const controller = new HostRuntimeController({
      host,
      deps: makeDeps({ [direct.id]: 12 }, []),
    });

    await controller.start({
      autoProbe: false,
      initialConnection: {
        connectionId: direct.id,
        existingClient: activeClient as unknown as DaemonClient,
      },
    });

    const snapshot = controller.getSnapshot();
    expect(snapshot.activeConnectionId).toBe(direct.id);
    expect(snapshot.connectionStatus).toBe("online");
    expect(snapshot.probeByConnectionId.get(direct.id)).toEqual({
      status: "pending",
      latencyMs: null,
    });
  });

  it("backs off inactive connection probes while a host is online", async () => {
    useHostRuntimeClock();
    const host = makeHost({ preferredConnectionId: "direct:lan:6767" });
    const clients: FakeDaemonClient[] = [];
    const latencies: Record<string, number | Error> = {
      "direct:lan:6767": 10,
      "relay:relay.paseo.sh:443": 50,
    };
    const controller = new HostRuntimeController({
      host,
      deps: makeDeps(latencies, clients),
    });

    await controller.start({ autoProbe: false });
    expect(controller.getSnapshot().activeConnectionId).toBe("direct:lan:6767");
    const activeClient = controller.getSnapshot().client as unknown as FakeDaemonClient;
    const initialClientCount = clients.length;
    const initialRelayProbe = controller
      .getSnapshot()
      .probeByConnectionId.get("relay:relay.paseo.sh:443");

    latencies["direct:lan:6767"] = 12;
    latencies["relay:relay.paseo.sh:443"] = 25;
    activeClient.heartbeatReportsRtt(12);
    await vi.advanceTimersByTimeAsync(60_000);

    await controller.runProbeCycleNow();

    const snapshot = controller.getSnapshot();
    expect(clients.length).toBe(initialClientCount);
    expect(snapshot.probeByConnectionId.get("direct:lan:6767")).toEqual({
      status: "available",
      latencyMs: 12,
    });
    expect(snapshot.probeByConnectionId.get("relay:relay.paseo.sh:443")).toEqual(initialRelayProbe);
  });

  it("switches only after the faster alternative wins consecutive probes", async () => {
    useHostRuntimeClock();
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
    const activeClient = controller.getSnapshot().client as unknown as FakeDaemonClient;

    latencies["direct:lan:6767"] = 95;
    latencies["relay:relay.paseo.sh:443"] = 30;
    activeClient.heartbeatReportsRtt(95);
    await vi.advanceTimersByTimeAsync(120_000);
    await controller.runProbeCycleNow();
    expect(controller.getSnapshot().activeConnectionId).toBe("direct:lan:6767");

    await vi.advanceTimersByTimeAsync(120_000);
    await controller.runProbeCycleNow();
    expect(controller.getSnapshot().activeConnectionId).toBe("direct:lan:6767");

    let switched = controller.getSnapshot().activeConnectionId === "relay:relay.paseo.sh:443";
    for (let index = 0; index < 6 && !switched; index += 1) {
      await vi.advanceTimersByTimeAsync(120_000);
      await controller.runProbeCycleNow();
      switched = controller.getSnapshot().activeConnectionId === "relay:relay.paseo.sh:443";
    }
    expect(switched).toBe(true);
    expect(controller.getSnapshot().client).not.toBeNull();
  });

  it("does not switch on a transient latency spike", async () => {
    useHostRuntimeClock();
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
    const activeClient = controller.getSnapshot().client as unknown as FakeDaemonClient;

    latencies["direct:lan:6767"] = 100;
    latencies["relay:relay.paseo.sh:443"] = 20;
    activeClient.heartbeatReportsRtt(100);
    await vi.advanceTimersByTimeAsync(120_000);
    await controller.runProbeCycleNow();
    expect(controller.getSnapshot().activeConnectionId).toBe("direct:lan:6767");

    latencies["direct:lan:6767"] = 20;
    latencies["relay:relay.paseo.sh:443"] = 90;
    activeClient.heartbeatReportsRtt(20);
    await vi.advanceTimersByTimeAsync(120_000);
    await controller.runProbeCycleNow();
    expect(controller.getSnapshot().activeConnectionId).toBe("direct:lan:6767");

    latencies["direct:lan:6767"] = 100;
    latencies["relay:relay.paseo.sh:443"] = 20;
    activeClient.heartbeatReportsRtt(100);
    await vi.advanceTimersByTimeAsync(120_000);
    await controller.runProbeCycleNow();
    expect(controller.getSnapshot().activeConnectionId).toBe("direct:lan:6767");

    await vi.advanceTimersByTimeAsync(120_000);
    await controller.runProbeCycleNow();
    expect(controller.getSnapshot().activeConnectionId).toBe("direct:lan:6767");

    let switched = controller.getSnapshot().activeConnectionId === "relay:relay.paseo.sh:443";
    for (let index = 0; index < 6 && !switched; index += 1) {
      await vi.advanceTimersByTimeAsync(120_000);
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
    const firstEpoch = controller.getSnapshot().connectionEpoch;
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
    expect(controller.getSnapshot().connectionEpoch).toBe(firstEpoch + 1);
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
      connectToDaemon: async ({ host: hostProfile }) => ({
        client: makeConnectedProbeClient(10) as unknown as DaemonClient,
        serverId: hostProfile.serverId,
        hostname: hostProfile.label ?? null,
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

    const switchDirect = controller.activateConnection({ connectionId: "direct:lan:6767" });
    await waitUntil(() => {
      const snapshot = controller.getSnapshot();
      return (
        createdClients.length === 1 &&
        snapshot.activeConnectionId === "direct:lan:6767" &&
        snapshot.connectionStatus === "connecting"
      );
    });

    const switchRelay = controller.activateConnection({
      connectionId: "relay:relay.paseo.sh:443",
    });
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
    expect(createdClients[0]?.isDisposed()).toBe(true);
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
        connectToDaemon: async ({ host: hostProfile }) => {
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
            serverId: hostProfile.serverId,
            hostname: hostProfile.label ?? null,
          };
        },
        getClientId: async () => "cid_test_runtime",
      },
    });

    const first = controller.runProbeCycleNow();
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
    useHostRuntimeClock();
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
        connectToDaemon: async ({ host: hostProfile }) => {
          const client = makeConnectedProbeClient(10);
          return {
            client: client as unknown as DaemonClient,
            serverId: hostProfile.serverId,
            hostname: hostProfile.label ?? null,
          };
        },
        getClientId: async () => "cid_test_runtime",
      },
    });

    await controller.start({ autoProbe: false });
    const activeClientBeforeProbes = controller.getSnapshot().client;
    const generationBeforeProbes = controller.getSnapshot().clientGeneration;

    await vi.advanceTimersByTimeAsync(10_000);
    await controller.runProbeCycleNow();
    expect(controller.getSnapshot().client).toBe(activeClientBeforeProbes);
    expect(controller.getSnapshot().clientGeneration).toBe(generationBeforeProbes);
    expect(createdClients).toHaveLength(0);
  });
});

describe("HostRuntimeStore", () => {
  it("restores the display replica before declaring the host registry loaded", async () => {
    const host = makeHost();
    const storage = createMemoryHostRuntimeStorage();
    await storage.setItem("@paseo:daemon-registry", JSON.stringify([host]));
    await storage.setItem("@paseo:e2e", "1");

    const cachedAgent = replicaAgent(
      makeFetchAgentsEntry({
        id: "cached-agent",
        cwd: "/repo/paseo",
        updatedAt: "2026-07-18T08:00:00.000Z",
        title: "Cached agent",
      }).agent,
      host.serverId,
    );
    const session = useSessionStore.getState();
    session.initializeSession(host.serverId, null);
    session.setAgents(host.serverId, new Map([[cachedAgent.id, cachedAgent]]));
    session.setFocusedAgentId(host.serverId, cachedAgent.id);
    session.setAgentStreamTail(
      host.serverId,
      new Map([
        [
          cachedAgent.id,
          [
            {
              kind: "assistant_message",
              id: "cached-message",
              text: "Already painted",
              timestamp: new Date("2026-07-18T08:01:00.000Z"),
            },
          ],
        ],
      ]),
    );
    const cache = new ReplicaCache(storage);
    cache.setHosts([host.serverId]);
    await cache.flush();
    session.clearSession(host.serverId);

    const store = new HostRuntimeStore({
      storage,
      deps: {
        createClient: () => {
          throw new Error("createClient should not be called");
        },
        connectToDaemon: async () => {
          throw new Error("connectToDaemon should not be called");
        },
        getClientId: async () => "cid_test_runtime",
      },
    });
    const registryLoaded = onceHostListMatches(store, () => store.isHostRegistryLoaded());
    store.boot();
    await registryLoaded;

    const restored = useSessionStore.getState().sessions[host.serverId];
    expect(restored?.agents.get(cachedAgent.id)?.title).toBe("Cached agent");
    expect(restored?.agentStreamTail.get(cachedAgent.id)?.[0]).toMatchObject({
      text: "Already painted",
      timestamp: new Date("2026-07-18T08:01:00.000Z"),
    });
    expect(restored?.hasHydratedAgents).toBe(false);

    store.syncHosts([]);
    session.clearSession(host.serverId);
  });

  it("marks the host registry loaded after boot reads storage", async () => {
    const previousOverride = process.env.EXPO_PUBLIC_LOCAL_DAEMON;
    process.env.EXPO_PUBLIC_LOCAL_DAEMON = "not-an-endpoint";
    const store = new HostRuntimeStore({
      deps: {
        createClient: () => {
          throw new Error("createClient should not be called");
        },
        connectToDaemon: async () => {
          throw new Error("connectToDaemon should not be called");
        },
        getClientId: async () => "cid_test_runtime",
      },
    });

    try {
      let hostListNotifications = 0;
      let unsubscribeHostList = () => {};
      const registryLoaded = new Promise<void>((resolve) => {
        unsubscribeHostList = store.subscribeHostList(() => {
          hostListNotifications += 1;
          if (store.isHostRegistryLoaded()) {
            unsubscribeHostList();
            resolve();
          }
        });
      });

      store.boot();
      await registryLoaded;

      expect(store.isHostRegistryLoaded()).toBe(true);
      expect(hostListNotifications).toBe(2);
    } finally {
      if (previousOverride === undefined) {
        delete process.env.EXPO_PUBLIC_LOCAL_DAEMON;
      } else {
        process.env.EXPO_PUBLIC_LOCAL_DAEMON = previousOverride;
      }
    }
  });

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
        connectToDaemon: async ({ host: hostProfile }) => ({
          client: fakeClient as unknown as DaemonClient,
          serverId: hostProfile.serverId,
          hostname: hostProfile.label ?? null,
        }),
        getClientId: async () => "cid_test_runtime",
      },
    });

    useSessionStore
      .getState()
      .initializeSession(host.serverId, fakeClient as unknown as DaemonClient, 1);
    store.syncHosts([host]);

    await fakeClient.waitForFetches(1);
    await waitForDirectoryReady(store, host.serverId);

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

    await store.refreshAgentDirectory({ serverId: host.serverId });
    expect(fakeClient.fetchAgentsCalls[1]).toEqual({
      scope: "active",
      sort: [{ key: "updated_at", direction: "desc" }],
      page: { limit: 200 },
    });

    store.syncHosts([]);
    useSessionStore.getState().clearSession(host.serverId);
  });

  it("waits for the matching session replica before committing the connected client bootstrap", async () => {
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
        connectToDaemon: async ({ host: hostProfile }) => ({
          client: fakeClient as unknown as DaemonClient,
          serverId: hostProfile.serverId,
          hostname: hostProfile.label ?? null,
        }),
        getClientId: async () => "cid_test_runtime",
      },
    });

    store.syncHosts([host]);

    await Promise.resolve();
    expect(fakeClient.fetchAgentsCalls).toEqual([]);
    useSessionStore
      .getState()
      .initializeSession(host.serverId, fakeClient as unknown as DaemonClient, 1);

    await fakeClient.waitForFetches(1);
    await waitForDirectoryReady(store, host.serverId);

    expect(fakeClient.fetchAgentsCalls).toHaveLength(1);
    expect(fakeClient.fetchAgentsCalls[0]).toEqual({
      scope: "active",
      sort: [{ key: "updated_at", direction: "desc" }],
      subscribe: { subscriptionId: "app:srv_no_session" },
      page: { limit: 200 },
    });

    store.syncHosts([]);
    useSessionStore.getState().clearSession(host.serverId);
  });

  it("bootstraps legacy daemons from unscoped agents and creates path-backed workspaces", async () => {
    const host = makeHost({
      serverId: "srv_legacy_workspace_daemon",
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
            id: "agent-legacy",
            cwd: "/repo/legacy-app",
            updatedAt: "2026-06-18T12:00:00.000Z",
            title: "Legacy daemon agent",
          }),
        ],
        subscriptionId: "app:srv_legacy_workspace_daemon",
      }),
    );
    const store = new HostRuntimeStore({
      deps: {
        createClient: () => fakeClient as unknown as DaemonClient,
        connectToDaemon: async ({ host: hostProfile }) => ({
          client: fakeClient as unknown as DaemonClient,
          serverId: hostProfile.serverId,
          hostname: hostProfile.label ?? null,
        }),
        getClientId: async () => "cid_test_runtime",
      },
    });

    const sessionStore = useSessionStore.getState();
    sessionStore.initializeSession(host.serverId, fakeClient as unknown as DaemonClient, 1);
    sessionStore.updateSessionServerInfo(host.serverId, {
      serverId: host.serverId,
      hostname: null,
      version: "0.1.96",
    });
    store.syncHosts([host]);

    await fakeClient.waitForFetches(1);
    await waitForDirectoryReady(store, host.serverId);

    expect(fakeClient.fetchAgentsCalls).toEqual([
      {
        sort: [{ key: "updated_at", direction: "desc" }],
        subscribe: { subscriptionId: "app:srv_legacy_workspace_daemon" },
        page: { limit: 200 },
      },
    ]);
    const session = useSessionStore.getState().sessions[host.serverId];
    expect(session?.agents.get("agent-legacy")?.workspaceId).toBe("/repo/legacy-app");
    expect(Array.from(session?.workspaces.values() ?? [])).toEqual([
      expect.objectContaining({
        id: "/repo/legacy-app",
        workspaceDirectory: "/repo/legacy-app",
        name: "legacy-app",
      }),
    ]);

    store.syncHosts([]);
    useSessionStore.getState().clearSession(host.serverId);
  });

  it("drains legacy snapshot and buffered running transitions exactly once", async () => {
    const host = makeHost({
      serverId: "srv_legacy_transitions",
      connections: [{ id: "direct:lan:6767", type: "directTcp", endpoint: "lan:6767" }],
    });
    const fakeClient = new FakeDaemonClient();
    fakeClient.setConnectionState({ status: "connected" });
    const pageTwo = new Deferred<Awaited<ReturnType<DaemonClient["fetchAgents"]>>>();
    const snapshotAgent = makeFetchAgentsEntry({
      id: "legacy-snapshot",
      cwd: "/legacy/repo",
      updatedAt: "2026-07-12T10:00:00.000Z",
    });
    const bufferedAgent = makeFetchAgentsEntry({
      id: "legacy-buffered",
      cwd: "/legacy/repo",
      updatedAt: "2026-07-12T10:00:00.000Z",
    });
    fakeClient.fetchAgentsResponses.push(
      makeFetchAgentsPayload({
        entries: [
          { ...snapshotAgent, agent: { ...snapshotAgent.agent, status: "idle" } },
          { ...bufferedAgent, agent: { ...bufferedAgent.agent, status: "running" } },
        ],
        hasMore: true,
        nextCursor: "legacy-page-two",
      }),
      pageTwo.promise,
    );
    const store = new HostRuntimeStore({
      deps: {
        createClient: () => fakeClient as unknown as DaemonClient,
        connectToDaemon: async () => ({
          client: fakeClient as unknown as DaemonClient,
          serverId: host.serverId,
          hostname: null,
        }),
        getClientId: async () => "cid_legacy_transitions",
      },
    });
    const sessionStore = useSessionStore.getState();
    sessionStore.initializeSession(host.serverId, fakeClient as unknown as DaemonClient, 1);
    sessionStore.updateSessionServerInfo(host.serverId, {
      serverId: host.serverId,
      hostname: null,
      version: "0.1.96",
    });
    sessionStore.setAgents(
      host.serverId,
      new Map([
        [
          "legacy-snapshot",
          { ...replicaAgent(snapshotAgent.agent, host.serverId), status: "running" },
        ],
        [
          "legacy-buffered",
          { ...replicaAgent(bufferedAgent.agent, host.serverId), status: "running" },
        ],
      ]),
    );
    sessionStore.setQueuedMessages(
      host.serverId,
      new Map([
        ["legacy-snapshot", [{ id: "legacy-snapshot-message", text: "snapshot", attachments: [] }]],
        ["legacy-buffered", [{ id: "legacy-buffered-message", text: "buffered", attachments: [] }]],
      ]),
    );
    store.syncHosts([host]);
    await fakeClient.waitForFetches(2);
    fakeClient.agentUpdate({
      kind: "upsert",
      agent: { ...bufferedAgent.agent, status: "idle" },
      project: bufferedAgent.project,
    });
    pageTwo.resolve(makeFetchAgentsPayload({ entries: [] }));
    await waitForDirectoryReady(store, host.serverId);
    await fakeClient.waitForSentMessages(2);

    expect(fakeClient.sentAgentMessages.map(([agentId, text]) => [agentId, text])).toEqual([
      ["legacy-snapshot", "snapshot"],
      ["legacy-buffered", "buffered"],
    ]);
    expect(
      Array.from(useSessionStore.getState().sessions[host.serverId]?.agents.values() ?? []).map(
        ({ id, status, workspaceId }) => [id, status, workspaceId],
      ),
    ).toEqual([
      ["legacy-snapshot", "idle", "/legacy/repo"],
      ["legacy-buffered", "idle", "/legacy/repo"],
    ]);

    store.syncHosts([]);
    useSessionStore.getState().clearSession(host.serverId);
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
            cwd: "/workspaces/paseo",
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
            cwd: "/workspaces/paseo-pr67-review",
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
        connectToDaemon: async ({ host: hostProfile }) => ({
          client: fakeClient as unknown as DaemonClient,
          serverId: hostProfile.serverId,
          hostname: hostProfile.label ?? null,
        }),
        getClientId: async () => "cid_test_runtime",
      },
    });

    useSessionStore
      .getState()
      .initializeSession(host.serverId, fakeClient as unknown as DaemonClient, 1);
    store.syncHosts([host]);

    await fakeClient.waitForFetches(2);
    await waitForDirectoryReady(store, host.serverId);

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

    const staleAgent =
      useSessionStore.getState().sessions[host.serverId]?.agents?.get("agent-stale-attention") ??
      null;
    expect(staleAgent?.requiresAttention).toBe(true);
    expect(staleAgent?.attentionReason).toBe("error");

    const snapshot = store.getSnapshot(host.serverId);
    expect(snapshot?.agentDirectoryStatus).toBe("ready");
    expect(snapshot?.hasEverLoadedAgentDirectory).toBe(true);

    store.syncHosts([]);
    useSessionStore.getState().clearSession(host.serverId);
  });

  it("replays agent updates received while a later bootstrap page is loading", async () => {
    const host = makeHost({
      serverId: "srv_paged_delta",
      connections: [{ id: "direct:lan:6767", type: "directTcp", endpoint: "lan:6767" }],
    });
    const fakeClient = new FakeDaemonClient();
    fakeClient.setConnectionState({ status: "connected" });
    let finishPageTwo!: (payload: Awaited<ReturnType<DaemonClient["fetchAgents"]>>) => void;
    const pageTwo = new Promise<Awaited<ReturnType<DaemonClient["fetchAgents"]>>>((resolve) => {
      finishPageTwo = resolve;
    });
    const pageOneAgent = makeFetchAgentsEntry({
      id: "agent-a",
      cwd: "/repo",
      updatedAt: "2026-07-12T10:00:00.000Z",
      title: "snapshot",
    });
    const recoveredAgent = makeFetchAgentsEntry({
      id: "agent-recovered",
      cwd: "/repo",
      updatedAt: "2026-07-12T10:00:00.000Z",
      title: "before refresh",
    });
    fakeClient.fetchAgentsResponses.push(
      makeFetchAgentsPayload({
        entries: [pageOneAgent],
        hasMore: true,
        nextCursor: "page-two",
        subscriptionId: "app:srv_paged_delta",
      }),
      pageTwo,
    );
    const store = new HostRuntimeStore({
      deps: {
        createClient: () => fakeClient as unknown as DaemonClient,
        connectToDaemon: async () => ({
          client: fakeClient as unknown as DaemonClient,
          serverId: host.serverId,
          hostname: null,
        }),
        getClientId: async () => "cid_paged_delta",
      },
    });
    const sessionStore = useSessionStore.getState();
    sessionStore.initializeSession(host.serverId, fakeClient as unknown as DaemonClient, 1);
    sessionStore.setAgents(
      host.serverId,
      new Map([[recoveredAgent.agent.id, replicaAgent(recoveredAgent.agent, host.serverId)]]),
    );
    sessionStore.setAgentTimelineCursor(
      host.serverId,
      new Map([[recoveredAgent.agent.id, { epoch: "epoch", startSeq: 10, endSeq: 20 }]]),
    );
    store.syncHosts([host]);
    await fakeClient.waitForFetches(2);

    fakeClient.agentUpdate({
      kind: "upsert",
      agent: { ...pageOneAgent.agent, title: "live" },
      project: pageOneAgent.project,
    });
    fakeClient.agentUpdate({
      kind: "upsert",
      agent: { ...recoveredAgent.agent, title: "recovered by delta" },
      project: recoveredAgent.project,
    });
    finishPageTwo(
      makeFetchAgentsPayload({
        entries: [
          makeFetchAgentsEntry({
            id: "agent-b",
            cwd: "/repo",
            updatedAt: "2026-07-12T09:00:00.000Z",
          }),
        ],
      }),
    );
    await waitForDirectoryReady(store, host.serverId);

    expect(
      Array.from(useSessionStore.getState().sessions[host.serverId]?.agents.values() ?? []).map(
        (agent) => [agent.id, agent.title],
      ),
    ).toEqual([
      ["agent-a", "live"],
      ["agent-b", null],
      ["agent-recovered", "recovered by delta"],
    ]);
    expect(
      useSessionStore
        .getState()
        .sessions[host.serverId]?.agentTimelineCursor.get(recoveredAgent.agent.id),
    ).toEqual({ epoch: "epoch", startSeq: 10, endSeq: 20 });

    const agentB = makeFetchAgentsEntry({
      id: "agent-b",
      cwd: "/repo",
      updatedAt: "2026-07-12T11:00:00.000Z",
      title: "immediate",
    });
    fakeClient.agentUpdate({ kind: "upsert", agent: agentB.agent, project: agentB.project });
    expect(useSessionStore.getState().sessions[host.serverId]?.agents.get("agent-b")?.title).toBe(
      "immediate",
    );
    fakeClient.agentUpdate({ kind: "remove", agentId: "agent-b" });
    expect(useSessionStore.getState().sessions[host.serverId]?.agents.has("agent-b")).toBe(false);

    store.syncHosts([]);
    useSessionStore.getState().clearSession(host.serverId);
  });

  it("buffers updates until the matching session generation exists", async () => {
    const host = makeHost({
      serverId: "srv_pre_session",
      connections: [{ id: "direct:lan:6767", type: "directTcp", endpoint: "lan:6767" }],
    });
    const fakeClient = new FakeDaemonClient();
    fakeClient.setConnectionState({ status: "connected" });
    const snapshotEntry = makeFetchAgentsEntry({
      id: "agent-pre-session",
      cwd: "/repo",
      updatedAt: "2026-07-12T10:00:00.000Z",
      title: "snapshot",
    });
    fakeClient.fetchAgentsResponses.push(makeFetchAgentsPayload({ entries: [snapshotEntry] }));
    const store = new HostRuntimeStore({
      deps: {
        createClient: () => fakeClient as unknown as DaemonClient,
        connectToDaemon: async () => ({
          client: fakeClient as unknown as DaemonClient,
          serverId: host.serverId,
          hostname: null,
        }),
        getClientId: async () => "cid_pre_session",
      },
    });

    store.syncHosts([host]);
    await fakeClient.waitForAgentUpdates();
    fakeClient.agentUpdate({
      kind: "upsert",
      agent: { ...snapshotEntry.agent, title: "before-session" },
      project: snapshotEntry.project,
    });
    const generation = store.getSnapshot(host.serverId)?.clientGeneration ?? 0;
    useSessionStore
      .getState()
      .initializeSession(host.serverId, fakeClient as unknown as DaemonClient, generation);
    useSessionStore.getState().updateSessionServerInfo(host.serverId, {
      serverId: host.serverId,
      hostname: null,
      version: "test",
    });
    await fakeClient.waitForFetches(1);
    await waitForDirectoryReady(store, host.serverId);

    expect(
      useSessionStore.getState().sessions[host.serverId]?.agents.get("agent-pre-session")?.title,
    ).toBe("before-session");

    store.syncHosts([]);
    useSessionStore.getState().clearSession(host.serverId);
  });

  it("restarts directory bootstrap when reconnect supersedes a pending session wait", async () => {
    const host = makeHost({
      serverId: "srv_session_wait_reconnect",
      connections: [{ id: "direct:lan:6767", type: "directTcp", endpoint: "lan:6767" }],
    });
    const fakeClient = new FakeDaemonClient();
    fakeClient.setConnectionState({ status: "connected" });
    const store = new HostRuntimeStore({
      deps: {
        createClient: () => fakeClient as unknown as DaemonClient,
        connectToDaemon: async () => ({
          client: fakeClient as unknown as DaemonClient,
          serverId: host.serverId,
          hostname: null,
        }),
        getClientId: async () => "cid_session_wait_reconnect",
      },
    });

    store.syncHosts([host]);
    await fakeClient.waitForAgentUpdates();
    fakeClient.setConnectionState({ status: "disconnected", reason: "network" });
    fakeClient.setConnectionState({ status: "connected" });

    const generation = store.getSnapshot(host.serverId)?.clientGeneration ?? 0;
    const sessionStore = useSessionStore.getState();
    sessionStore.initializeSession(
      host.serverId,
      fakeClient as unknown as DaemonClient,
      generation,
    );
    sessionStore.updateSessionServerInfo(host.serverId, {
      serverId: host.serverId,
      hostname: null,
      version: "test",
    });
    await fakeClient.waitForFetches(1);
    await waitForDirectoryReady(store, host.serverId);

    expect(fakeClient.fetchAgentsCalls).toHaveLength(1);
    store.syncHosts([]);
    sessionStore.clearSession(host.serverId);
  });

  it("rejects a superseded refresh without overwriting the newer replica", async () => {
    const host = makeHost({
      serverId: "srv_overlap",
      connections: [{ id: "direct:lan:6767", type: "directTcp", endpoint: "lan:6767" }],
    });
    const fakeClient = new FakeDaemonClient();
    fakeClient.setConnectionState({ status: "connected" });
    fakeClient.fetchAgentsResponses.push(makeFetchAgentsPayload({ entries: [] }));
    const store = new HostRuntimeStore({
      deps: {
        createClient: () => fakeClient as unknown as DaemonClient,
        connectToDaemon: async () => ({
          client: fakeClient as unknown as DaemonClient,
          serverId: host.serverId,
          hostname: null,
        }),
        getClientId: async () => "cid_overlap",
      },
    });
    useSessionStore
      .getState()
      .initializeSession(host.serverId, fakeClient as unknown as DaemonClient, 1);
    store.syncHosts([host]);
    await fakeClient.waitForFetches(1);
    await waitForDirectoryReady(store, host.serverId);
    const olderPage = new Deferred<Awaited<ReturnType<DaemonClient["fetchAgents"]>>>();
    fakeClient.fetchAgentsResponses.push(olderPage.promise);
    const olderRefresh = store.refreshAgentDirectory({ serverId: host.serverId });
    await fakeClient.waitForFetches(2);
    const newerEntry = makeFetchAgentsEntry({
      id: "newer",
      cwd: "/repo",
      updatedAt: "2026-07-12T11:00:00.000Z",
    });
    fakeClient.fetchAgentsResponses.push(makeFetchAgentsPayload({ entries: [newerEntry] }));

    const newerRefresh = store.refreshAgentDirectory({ serverId: host.serverId });
    await fakeClient.waitForFetches(3);
    await newerRefresh;
    olderPage.resolve(
      makeFetchAgentsPayload({
        entries: [
          makeFetchAgentsEntry({
            id: "older",
            cwd: "/repo",
            updatedAt: "2026-07-12T09:00:00.000Z",
          }),
        ],
      }),
    );
    await expect(olderRefresh).rejects.toThrow();

    fakeClient.agentUpdate({
      kind: "upsert",
      agent: { ...newerEntry.agent, title: "after cleanup" },
      project: newerEntry.project,
    });

    expect(
      Array.from(useSessionStore.getState().sessions[host.serverId]?.agents.values() ?? []).map(
        ({ id, title }) => [id, title],
      ),
    ).toEqual([["newer", "after cleanup"]]);

    store.syncHosts([]);
    useSessionStore.getState().clearSession(host.serverId);
  });

  it("replays inherited deltas when a superseding refresh fails", async () => {
    const host = makeHost({
      serverId: "srv_overlap_failure",
      connections: [{ id: "direct:lan:6767", type: "directTcp", endpoint: "lan:6767" }],
    });
    const fakeClient = new FakeDaemonClient();
    fakeClient.setConnectionState({ status: "connected" });
    fakeClient.fetchAgentsResponses.push(makeFetchAgentsPayload({ entries: [] }));
    const store = new HostRuntimeStore({
      deps: {
        createClient: () => fakeClient as unknown as DaemonClient,
        connectToDaemon: async () => ({
          client: fakeClient as unknown as DaemonClient,
          serverId: host.serverId,
          hostname: null,
        }),
        getClientId: async () => "cid_overlap_failure",
      },
    });
    useSessionStore
      .getState()
      .initializeSession(host.serverId, fakeClient as unknown as DaemonClient, 1);
    store.syncHosts([host]);
    await fakeClient.waitForFetches(1);
    await waitForDirectoryReady(store, host.serverId);

    const olderPage = new Deferred<Awaited<ReturnType<DaemonClient["fetchAgents"]>>>();
    fakeClient.fetchAgentsResponses.push(olderPage.promise);
    const olderRefresh = store.refreshAgentDirectory({ serverId: host.serverId });
    await fakeClient.waitForFetches(2);
    const liveEntry = makeFetchAgentsEntry({
      id: "live-delta",
      cwd: "/repo",
      updatedAt: "2026-07-17T10:00:00.000Z",
      title: "preserved",
    });
    fakeClient.agentUpdate({ kind: "upsert", agent: liveEntry.agent, project: liveEntry.project });

    const newerPage = new Deferred<Awaited<ReturnType<DaemonClient["fetchAgents"]>>>();
    fakeClient.fetchAgentsResponses.push(newerPage.promise);
    const newerRefresh = store.refreshAgentDirectory({ serverId: host.serverId });
    await fakeClient.waitForFetches(3);
    newerPage.reject(new Error("newer refresh failed"));
    await expect(newerRefresh).rejects.toThrow("newer refresh failed");

    expect(
      useSessionStore.getState().sessions[host.serverId]?.agents.get("live-delta")?.title,
    ).toBe("preserved");

    olderPage.resolve(makeFetchAgentsPayload({ entries: [] }));
    await expect(olderRefresh).rejects.toThrow();
    store.syncHosts([]);
    useSessionStore.getState().clearSession(host.serverId);
  });

  it("rejects a refresh when the session generation changes before commit", async () => {
    const host = makeHost({
      serverId: "srv_stale_generation",
      connections: [{ id: "direct:lan:6767", type: "directTcp", endpoint: "lan:6767" }],
    });
    const fakeClient = new FakeDaemonClient();
    fakeClient.setConnectionState({ status: "connected" });
    const existingEntry = makeFetchAgentsEntry({
      id: "existing",
      cwd: "/repo",
      updatedAt: "2026-07-12T10:00:00.000Z",
    });
    fakeClient.fetchAgentsResponses.push(makeFetchAgentsPayload({ entries: [existingEntry] }));
    const store = new HostRuntimeStore({
      deps: {
        createClient: () => fakeClient as unknown as DaemonClient,
        connectToDaemon: async () => ({
          client: fakeClient as unknown as DaemonClient,
          serverId: host.serverId,
          hostname: null,
        }),
        getClientId: async () => "cid_stale_generation",
      },
    });
    const sessionStore = useSessionStore.getState();
    sessionStore.initializeSession(host.serverId, fakeClient as unknown as DaemonClient, 1);
    store.syncHosts([host]);
    await fakeClient.waitForFetches(1);
    await waitForDirectoryReady(store, host.serverId);
    const stalePage = new Deferred<Awaited<ReturnType<DaemonClient["fetchAgents"]>>>();
    fakeClient.fetchAgentsResponses.push(stalePage.promise);

    const refresh = store.refreshAgentDirectory({ serverId: host.serverId });
    await fakeClient.waitForFetches(2);
    sessionStore.updateSessionClient(host.serverId, fakeClient as unknown as DaemonClient, 2);
    stalePage.resolve(
      makeFetchAgentsPayload({
        entries: [
          makeFetchAgentsEntry({
            id: "stale",
            cwd: "/repo",
            updatedAt: "2026-07-12T11:00:00.000Z",
          }),
        ],
      }),
    );

    await expect(refresh).rejects.toThrow();
    expect(
      Array.from(useSessionStore.getState().sessions[host.serverId]?.agents.keys() ?? []),
    ).toEqual(["existing"]);

    store.syncHosts([]);
    useSessionStore.getState().clearSession(host.serverId);
  });

  it("drains queued messages once for snapshot and buffered running transitions", async () => {
    const host = makeHost({
      serverId: "srv_queued_transitions",
      connections: [{ id: "direct:lan:6767", type: "directTcp", endpoint: "lan:6767" }],
    });
    const fakeClient = new FakeDaemonClient();
    fakeClient.setConnectionState({ status: "connected" });
    const pageTwo = new Deferred<Awaited<ReturnType<DaemonClient["fetchAgents"]>>>();
    const snapshotAgent = makeFetchAgentsEntry({
      id: "snapshot-transition",
      cwd: "/repo",
      updatedAt: "2026-07-12T10:00:00.000Z",
    });
    const bufferedAgent = makeFetchAgentsEntry({
      id: "buffered-transition",
      cwd: "/repo",
      updatedAt: "2026-07-12T10:00:00.000Z",
    });
    fakeClient.fetchAgentsResponses.push(
      makeFetchAgentsPayload({
        entries: [
          { ...snapshotAgent, agent: { ...snapshotAgent.agent, status: "idle" } },
          { ...bufferedAgent, agent: { ...bufferedAgent.agent, status: "running" } },
        ],
        hasMore: true,
        nextCursor: "page-two",
      }),
      pageTwo.promise,
    );
    const store = new HostRuntimeStore({
      deps: {
        createClient: () => fakeClient as unknown as DaemonClient,
        connectToDaemon: async () => ({
          client: fakeClient as unknown as DaemonClient,
          serverId: host.serverId,
          hostname: null,
        }),
        getClientId: async () => "cid_queued_transitions",
      },
    });
    const sessionStore = useSessionStore.getState();
    sessionStore.initializeSession(host.serverId, fakeClient as unknown as DaemonClient, 1);
    sessionStore.setAgents(
      host.serverId,
      new Map([
        [
          "snapshot-transition",
          { ...replicaAgent(snapshotAgent.agent, host.serverId), status: "running" },
        ],
        [
          "buffered-transition",
          { ...replicaAgent(bufferedAgent.agent, host.serverId), status: "running" },
        ],
      ]),
    );
    sessionStore.setQueuedMessages(
      host.serverId,
      new Map([
        [
          "snapshot-transition",
          [{ id: "message-snapshot", text: "snapshot queued", attachments: [] }],
        ],
        [
          "buffered-transition",
          [{ id: "message-buffered", text: "buffered queued", attachments: [] }],
        ],
      ]),
    );
    store.syncHosts([host]);
    await fakeClient.waitForFetches(2);
    fakeClient.agentUpdate({
      kind: "upsert",
      agent: { ...bufferedAgent.agent, status: "idle" },
      project: bufferedAgent.project,
    });
    pageTwo.resolve(makeFetchAgentsPayload({ entries: [] }));
    await waitForDirectoryReady(store, host.serverId);
    await fakeClient.waitForSentMessages(2);

    expect(fakeClient.sentAgentMessages.map(([agentId, text]) => [agentId, text])).toEqual([
      ["snapshot-transition", "snapshot queued"],
      ["buffered-transition", "buffered queued"],
    ]);
    expect(
      Array.from(useSessionStore.getState().sessions[host.serverId]?.queuedMessages.values() ?? []),
    ).toEqual([[], []]);

    store.syncHosts([]);
    useSessionStore.getState().clearSession(host.serverId);
  });

  it("restores an automatically drained message when sending fails", async () => {
    const host = makeHost({ serverId: "srv_failed_queue_drain" });
    const fakeClient = new FakeDaemonClient();
    fakeClient.sendAgentMessageFailures.push(new Error("connection lost"));
    const store = new HostRuntimeStore({
      deps: {
        createClient: () => fakeClient as unknown as DaemonClient,
        connectToDaemon: async () => ({
          client: fakeClient as unknown as DaemonClient,
          serverId: host.serverId,
          hostname: null,
        }),
        getClientId: async () => "cid_failed_queue_drain",
      },
    });
    const sessionStore = useSessionStore.getState();
    sessionStore.initializeSession(host.serverId, fakeClient as unknown as DaemonClient, 1);
    sessionStore.setQueuedMessages(
      host.serverId,
      new Map([
        [
          "agent",
          [
            { id: "first", text: "retry me", attachments: [] },
            { id: "second", text: "keep me behind", attachments: [] },
          ],
        ],
      ]),
    );

    store.drainQueuedAgentMessage(host.serverId, "agent");

    await vi.waitFor(() => {
      expect(fakeClient.sentAgentMessages).toHaveLength(1);
      expect(
        useSessionStore.getState().sessions[host.serverId]?.queuedMessages.get("agent"),
      ).toEqual([
        { id: "first", text: "retry me", attachments: [] },
        { id: "second", text: "keep me behind", attachments: [] },
      ]);
    });

    useSessionStore.getState().clearSession(host.serverId);
  });

  it("serializes queued-message drains for the same agent", async () => {
    const host = makeHost({ serverId: "srv_serialized_queue_drain" });
    const fakeClient = new FakeDaemonClient();
    const send = new Deferred<void>();
    fakeClient.sendAgentMessageResponses.push(send.promise);
    const store = new HostRuntimeStore({
      deps: {
        createClient: () => fakeClient as unknown as DaemonClient,
        connectToDaemon: async () => ({
          client: fakeClient as unknown as DaemonClient,
          serverId: host.serverId,
          hostname: null,
        }),
        getClientId: async () => "cid_serialized_queue_drain",
      },
    });
    const sessionStore = useSessionStore.getState();
    sessionStore.initializeSession(host.serverId, fakeClient as unknown as DaemonClient, 1);
    sessionStore.setQueuedMessages(
      host.serverId,
      new Map([["agent", [{ id: "first", text: "send once", attachments: [] }]]]),
    );

    store.drainQueuedAgentMessage(host.serverId, "agent");
    store.drainQueuedAgentMessage(host.serverId, "agent");
    await fakeClient.waitForSentMessages(1);
    expect(fakeClient.sentAgentMessages).toHaveLength(1);

    send.resolve();
    await vi.waitFor(() => {
      expect(
        useSessionStore.getState().sessions[host.serverId]?.queuedMessages.get("agent"),
      ).toEqual([]);
    });
    useSessionStore.getState().clearSession(host.serverId);
  });

  it("uses legacy GitHub attachments when draining a queue for an old daemon", async () => {
    const host = makeHost({ serverId: "srv_legacy_queue_attachment" });
    const fakeClient = new FakeDaemonClient();
    const store = new HostRuntimeStore({
      deps: {
        createClient: () => fakeClient as unknown as DaemonClient,
        connectToDaemon: async () => ({
          client: fakeClient as unknown as DaemonClient,
          serverId: host.serverId,
          hostname: null,
        }),
        getClientId: async () => "cid_legacy_queue_attachment",
      },
    });
    const sessionStore = useSessionStore.getState();
    sessionStore.initializeSession(host.serverId, fakeClient as unknown as DaemonClient, 1);
    sessionStore.updateSessionServerInfo(host.serverId, {
      serverId: host.serverId,
      hostname: null,
      version: "0.1.105",
      features: { forgeSearch: false },
    });
    sessionStore.setQueuedMessages(
      host.serverId,
      new Map([
        [
          "agent",
          [
            {
              id: "queued-legacy-attachment",
              text: "review this",
              attachments: [
                {
                  kind: "github_pr" as const,
                  item: {
                    kind: "change_request" as const,
                    number: 42,
                    title: "Compatibility fix",
                    url: "https://github.com/acme/repo/pull/42",
                    state: "open" as const,
                    body: "Details",
                    labels: [],
                    baseRefName: "main",
                    headRefName: "fix",
                  },
                },
              ],
            },
          ],
        ],
      ]),
    );

    store.drainQueuedAgentMessage(host.serverId, "agent");
    await fakeClient.waitForSentMessages(1);

    expect(fakeClient.sentAgentMessages[0]?.[2]?.attachments).toEqual([
      {
        type: "github_pr",
        mimeType: "application/github-pr",
        number: 42,
        title: "Compatibility fix",
        url: "https://github.com/acme/repo/pull/42",
        body: "Details",
        baseRefName: "main",
        headRefName: "fix",
      },
    ]);
    sessionStore.clearSession(host.serverId);
  });

  it("applies buffered stale side effects from the accepted page agent", async () => {
    const host = makeHost({
      serverId: "srv_buffered_stale_side_effects",
      connections: [{ id: "direct:lan:6767", type: "directTcp", endpoint: "lan:6767" }],
    });
    const fakeClient = new FakeDaemonClient();
    fakeClient.setConnectionState({ status: "connected" });
    const pageTwo = new Deferred<Awaited<ReturnType<DaemonClient["fetchAgents"]>>>();
    const base = makeFetchAgentsEntry({
      id: "stale-side-effects",
      cwd: "/repo",
      updatedAt: "2026-07-12T12:00:00.000Z",
      title: "newer page",
    });
    const pageAgent = {
      ...base.agent,
      status: "running" as const,
      lastUsage: { inputTokens: 10, outputTokens: 5 },
      pendingPermissions: [agentPermission("current-permission")],
    };
    fakeClient.fetchAgentsResponses.push(
      makeFetchAgentsPayload({
        entries: [{ ...base, agent: pageAgent }],
        hasMore: true,
        nextCursor: "page-two",
      }),
      pageTwo.promise,
    );
    const store = new HostRuntimeStore({
      deps: {
        createClient: () => fakeClient as unknown as DaemonClient,
        connectToDaemon: async () => ({
          client: fakeClient as unknown as DaemonClient,
          serverId: host.serverId,
          hostname: null,
        }),
        getClientId: async () => "cid_buffered_stale_side_effects",
      },
    });
    const sessionStore = useSessionStore.getState();
    sessionStore.initializeSession(host.serverId, fakeClient as unknown as DaemonClient, 1);
    sessionStore.setAgents(
      host.serverId,
      new Map([
        [
          pageAgent.id,
          replicaAgent({ ...pageAgent, updatedAt: "2026-07-12T10:00:00.000Z" }, host.serverId),
        ],
      ]),
    );
    sessionStore.setAgentLastActivity(pageAgent.id, new Date("2026-07-12T12:00:00.000Z"));
    sessionStore.flushAgentLastActivity();
    setAgentArchiving({
      queryClient,
      serverId: host.serverId,
      agentId: pageAgent.id,
      isArchiving: true,
    });
    store.syncHosts([host]);
    await fakeClient.waitForFetches(2);
    fakeClient.agentUpdate({
      kind: "upsert",
      agent: {
        ...pageAgent,
        status: "idle",
        title: "stale live",
        updatedAt: "2026-07-12T11:00:00.000Z",
        lastUsage: { inputTokens: 20, outputTokens: 8 },
        pendingPermissions: [agentPermission("stale-permission")],
        archivedAt: "2026-07-12T11:00:00.000Z",
      },
      project: base.project,
    });
    pageTwo.resolve(makeFetchAgentsPayload({ entries: [] }));
    await waitForDirectoryReady(store, host.serverId);
    sessionStore.flushAgentLastActivity();

    const state = useSessionStore.getState();
    const agent = state.sessions[host.serverId]?.agents.get(pageAgent.id);
    expect({
      title: agent?.title,
      status: agent?.status,
      usage: agent?.lastUsage,
      permissions: Array.from(state.sessions[host.serverId]?.pendingPermissions.values() ?? []).map(
        ({ request }) => request.id,
      ),
      archivePending: isAgentArchiving({
        queryClient,
        serverId: host.serverId,
        agentId: pageAgent.id,
      }),
      activity: state.agentLastActivity.get(pageAgent.id)?.toISOString(),
      sentMessages: fakeClient.sentAgentMessages.length,
    }).toEqual({
      title: "newer page",
      status: "running",
      usage: { inputTokens: 20, outputTokens: 8 },
      permissions: ["current-permission"],
      archivePending: true,
      activity: "2026-07-12T12:00:00.000Z",
      sentMessages: 0,
    });

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
        connectToDaemon: async ({ host: hostProfile }) => ({
          client: fakeClient as unknown as DaemonClient,
          serverId: hostProfile.serverId,
          hostname: hostProfile.label ?? null,
        }),
        getClientId: async () => "cid_test_runtime",
      },
    });

    useSessionStore
      .getState()
      .initializeSession(host.serverId, fakeClient as unknown as DaemonClient, 1);
    store.syncHosts([host]);

    await fakeClient.waitForFetches(1);
    await waitForDirectoryReady(store, host.serverId);

    fakeClient.setConnectionState({ status: "connected" });
    await Promise.resolve();
    await Promise.resolve();
    expect(fakeClient.fetchAgentsCalls).toHaveLength(1);

    fakeClient.setConnectionState({
      status: "disconnected",
      reason: "client_closed",
    });
    fakeClient.setConnectionState({ status: "connected" });

    await fakeClient.waitForFetches(2);
    await waitForDirectoryReady(store, host.serverId);

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
        connectToDaemon: async ({ host: hostProfile }) => ({
          client: fakeClient as unknown as DaemonClient,
          serverId: hostProfile.serverId,
          hostname: hostProfile.label ?? null,
        }),
        getClientId: async () => "cid_test_runtime",
      },
    });

    useSessionStore
      .getState()
      .initializeSession(host.serverId, fakeClient as unknown as DaemonClient, 1);
    useSessionStore.getState().setAgents(host.serverId, () => {
      const stale = makeFetchAgentsEntry({
        id: "agent-archived",
        cwd: "/workspaces/paseo",
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
        parentAgentId: null,
      };
      return new Map([[stale.id, staleAgent]]);
    });

    store.syncHosts([host]);

    await fakeClient.waitForFetches(1);
    await waitForDirectoryReady(store, host.serverId);

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

  it("preserves a manual host rename when desktop status re-advertises the daemon hostname", async () => {
    const advertisedHostname = "macbook-pro.local";
    const store = new HostRuntimeStore({
      deps: {
        createClient: () => new FakeDaemonClient() as unknown as DaemonClient,
        connectToDaemon: async ({ host }) => ({
          client: makeConnectedProbeClient(5) as unknown as DaemonClient,
          serverId: host.serverId,
          hostname: advertisedHostname,
        }),
        getClientId: async () => "cid_test_runtime",
      },
      storage: createMemoryHostRuntimeStorage(),
    });

    try {
      await store.upsertConnectionFromListen({
        listenAddress: "127.0.0.1:6767",
        serverId: "srv_desktop",
        hostname: advertisedHostname,
      });
      await store.renameHost("srv_desktop", "mac-dev");

      await store.upsertConnectionFromListen({
        listenAddress: "127.0.0.1:6767",
        serverId: "srv_desktop",
        hostname: advertisedHostname,
      });

      expect(store.getHosts().find((h) => h.serverId === "srv_desktop")?.label).toBe("mac-dev");
    } finally {
      store.syncHosts([]);
    }
  });

  it("upsertDirectConnection stores SSL and password settings", async () => {
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

    await store.upsertDirectConnection({
      serverId: "srv_tls_password",
      endpoint: "example.paseo.test:7443",
      useTls: true,
      password: "shared-secret",
      label: "tls host",
    });

    const host = store.getHosts().find((entry) => entry.serverId === "srv_tls_password");
    expect(host?.connections).toEqual([
      {
        id: "direct:example.paseo.test:7443",
        type: "directTcp",
        endpoint: "example.paseo.test:7443",
        useTls: true,
        password: "shared-secret",
      },
    ]);

    store.syncHosts([]);
  });

  it("probeAndUpsertConnection learns the real server id before storing a direct host", async () => {
    const connection: HostConnection = {
      id: "direct:lan:6767",
      type: "directTcp",
      endpoint: "lan:6767",
    };
    const probeClient = makeConnectedProbeClient(5);
    const seenProbeHosts: string[] = [];
    const store = new HostRuntimeStore({
      deps: {
        createClient: () => new FakeDaemonClient() as unknown as DaemonClient,
        connectToDaemon: async ({ host, connection: probedConnection }) => {
          seenProbeHosts.push(host.serverId);
          expect(probedConnection).toEqual(connection);
          return {
            client: probeClient as unknown as DaemonClient,
            serverId: "srv_real_direct",
            hostname: "mbp",
          };
        },
        getClientId: async () => "cid_test_runtime",
      },
    });

    const result = await store.probeAndUpsertConnection({ connection });

    expect(result.serverId).toBe("srv_real_direct");
    expect(result.hostname).toBe("mbp");
    expect(seenProbeHosts).toEqual([""]);
    expect(probeClient.isDisposed()).toBe(false);
    expect(store.getHosts()).toMatchObject([
      {
        serverId: "srv_real_direct",
        label: "mbp",
        connections: [connection],
      },
    ]);

    store.syncHosts([]);
  });

  it("probeAndUpsertConnection replaces a matching placeholder host with the real server id", async () => {
    const connection: HostConnection = {
      id: "direct:lan:6767",
      type: "directTcp",
      endpoint: "lan:6767",
    };
    const store = new HostRuntimeStore({
      deps: {
        createClient: () => new FakeDaemonClient() as unknown as DaemonClient,
        connectToDaemon: async () => ({
          client: makeConnectedProbeClient(5) as unknown as DaemonClient,
          serverId: "srv_real_direct",
          hostname: "mbp",
        }),
        getClientId: async () => "cid_test_runtime",
      },
    });
    (
      store as unknown as {
        hosts: HostProfile[];
      }
    ).hosts = [
      makeHost({
        serverId: "local:lan:6767",
        label: "local:lan:6767",
        connections: [connection],
        preferredConnectionId: connection.id,
      }),
    ];

    await store.probeAndUpsertConnection({ connection });

    expect(store.getHosts().map((host) => host.serverId)).toEqual(["srv_real_direct"]);
    expect(store.getHosts()[0]?.label).toBe("mbp");

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

  it("stores relay TLS from a pairing offer", async () => {
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

    await store.upsertConnectionFromOffer(
      makeOffer({
        relay: {
          endpoint: "relay.example.com:443",
          useTls: true,
        },
      }),
      "tls relay",
    );

    const pairedHost = store.getHosts().find((host) => host.serverId === "srv_offer");
    expect(pairedHost?.connections).toEqual([
      {
        id: "relay:wss:relay.example.com:443",
        type: "relay",
        relayEndpoint: "relay.example.com:443",
        useTls: true,
        daemonPublicKeyB64: "pk_test_offer",
      },
    ]);

    store.syncHosts([]);
  });

  it("uses TLS for old pairing URLs that omit relay TLS on port 443", async () => {
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
    const oldPairingUrl = encodeOfferUrl({
      v: 2,
      serverId: "srv_offer",
      daemonPublicKeyB64: "pk_test_offer",
      relay: { endpoint: "relay.paseo.sh:443" },
    });

    await store.upsertConnectionFromOfferUrl(oldPairingUrl, "old relay");

    const pairedHost = store.getHosts().find((host) => host.serverId === "srv_offer");
    expect(pairedHost?.connections).toEqual([
      {
        id: "relay:wss:relay.paseo.sh:443",
        type: "relay",
        relayEndpoint: "relay.paseo.sh:443",
        useTls: true,
        daemonPublicKeyB64: "pk_test_offer",
      },
    ]);

    store.syncHosts([]);
  });

  it("preserves the existing host label when re-pairing an existing relay host", async () => {
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
      storage: createMemoryHostRuntimeStorage(),
    });

    await store.upsertRelayConnection({
      serverId: "srv_offer",
      relayEndpoint: "relay.paseo.sh:443",
      daemonPublicKeyB64: "pk_test_offer",
      label: "Custom name",
    });

    await store.upsertConnectionFromOffer(makeOffer(), "mbp");

    const pairedHost = store.getHosts().find((host) => host.serverId === "srv_offer");
    expect(pairedHost?.label).toBe("Custom name");

    store.syncHosts([]);
  });
});

describe("readInitialDaemonConnectionHint", () => {
  it("returns null when no hint is present", () => {
    expect(readInitialDaemonConnectionHint({ isWebRuntime: true })).toBeNull();
  });

  it("parses a valid listen-only hint", () => {
    (globalThis as Record<string, unknown>).__PASEO_INITIAL_DAEMON_CONNECTION__ = {
      listen: "localhost:6767",
    };
    expect(readInitialDaemonConnectionHint({ isWebRuntime: true })).toEqual({
      listen: "localhost:6767",
      useTls: false,
    });
  });

  it("preserves useTls when explicitly true", () => {
    (globalThis as Record<string, unknown>).__PASEO_INITIAL_DAEMON_CONNECTION__ = {
      listen: "paseo.example.com:443",
      useTls: true,
    };
    expect(readInitialDaemonConnectionHint({ isWebRuntime: true })).toEqual({
      listen: "paseo.example.com:443",
      useTls: true,
    });
  });

  it("ignores invalid shapes", () => {
    (globalThis as Record<string, unknown>).__PASEO_INITIAL_DAEMON_CONNECTION__ = "localhost:6767";
    expect(readInitialDaemonConnectionHint({ isWebRuntime: true })).toBeNull();

    (globalThis as Record<string, unknown>).__PASEO_INITIAL_DAEMON_CONNECTION__ = {
      useTls: true,
    };
    expect(readInitialDaemonConnectionHint({ isWebRuntime: true })).toBeNull();
  });
});

describe("HostRuntimeStore initial connection hint bootstrap", () => {
  it("attempts the explicit initial connection hint before default localhost bootstrap", async () => {
    const seenProbes: { endpoint: string; useTls?: boolean }[] = [];
    const store = new HostRuntimeStore({
      deps: {
        createClient: () => new FakeDaemonClient() as unknown as DaemonClient,
        connectToDaemon: async ({ connection }) => {
          if (connection.type === "directTcp") {
            seenProbes.push({ endpoint: connection.endpoint, useTls: connection.useTls });
          }
          return {
            client: makeConnectedProbeClient(5) as unknown as DaemonClient,
            serverId: "srv_hint",
            hostname: "hint host",
          };
        },
        getClientId: async () => "cid_test_runtime",
        readInitialConnectionHint: () => ({
          listen: "daemon-origin:6767",
          useTls: true,
        }),
      },
      storage: createMemoryHostRuntimeStorage(),
    });

    const hostAdded = onceHostListMatches(store, () => store.getHosts().length > 0);
    store.boot();
    await hostAdded;

    expect(seenProbes).toContainEqual({ endpoint: "daemon-origin:6767", useTls: true });
    const host = store.getHosts()[0];
    expect(host?.serverId).toBe("srv_hint");
    expect(host?.connections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ endpoint: "daemon-origin:6767", useTls: true }),
      ]),
    );

    store.syncHosts([]);
  });

  it("does not infer window.location.host when no explicit hint is present", async () => {
    const seenProbes: { endpoint: string; useTls?: boolean }[] = [];
    const firstProbe = createDeferred<void>();
    const store = new HostRuntimeStore({
      deps: {
        createClient: () => new FakeDaemonClient() as unknown as DaemonClient,
        connectToDaemon: async ({ connection }) => {
          if (connection.type === "directTcp") {
            seenProbes.push({ endpoint: connection.endpoint, useTls: connection.useTls });
          }
          firstProbe.resolve();
          throw new Error("probe unavailable");
        },
        getClientId: async () => "cid_test_runtime",
        readInitialConnectionHint: () => null,
      },
      storage: createMemoryHostRuntimeStorage(),
    });

    (globalThis as { window?: unknown }).window = {
      location: { host: "metro-host:8081", protocol: "http:" },
    };
    store.boot();
    await firstProbe.promise;

    expect(seenProbes).not.toContainEqual(expect.objectContaining({ endpoint: "metro-host:8081" }));
    expect(store.getHosts()).toHaveLength(0);
  });
});
