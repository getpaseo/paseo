import { useSyncExternalStore, useCallback, useMemo } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import equal from "fast-deep-equal/es6";
import {
  DaemonClient,
  type ConnectionState,
  type FetchAgentsEntry,
  type FetchAgentsOptions,
} from "@server/client/daemon-client";
import {
  connectionFromListen,
  normalizeStoredHostProfile,
  upsertHostConnectionInProfiles,
  registryHasConnection,
  type HostConnection,
  type HostProfile,
} from "@/types/host-connection";
import { decodeOfferFragmentPayload, normalizeHostPort } from "@/utils/daemon-endpoints";
import { resolveAppVersion } from "@/utils/app-version";
import { ConnectionOfferSchema, type ConnectionOffer } from "@server/shared/connection-offer";
import { shouldUseDesktopDaemon, startDesktopDaemon } from "@/desktop/daemon/desktop-daemon";
import { connectToDaemon } from "@/utils/test-daemon-connection";
import { buildDaemonWebSocketUrl, buildRelayWebSocketUrl } from "@/utils/daemon-endpoints";
import { getOrCreateClientId } from "@/utils/client-id";
import {
  selectBestConnection,
  type ConnectionCandidate,
  type ConnectionProbeState,
} from "@/utils/connection-selection";
import {
  buildLocalDaemonTransportUrl,
  createDesktopLocalDaemonTransportFactory,
} from "@/desktop/daemon/desktop-daemon-transport";
import { isDev } from "@/constants/platform";
import { replaceFetchedAgentDirectory } from "@/utils/agent-directory-sync";
import { useSessionStore } from "@/stores/session-store";

export type HostRuntimeConnectionStatus = "idle" | "connecting" | "online" | "offline" | "error";

export type HostRuntimeBootstrapResult =
  | { ok: true; listenAddress: string; serverId: string; hostname: string | null }
  | { ok: false; error: string };

export type ActiveConnection =
  | { type: "directTcp"; endpoint: string; display: string }
  | { type: "directSocket"; endpoint: string; display: "socket" }
  | { type: "directPipe"; endpoint: string; display: "pipe" }
  | { type: "relay"; endpoint: string; display: "relay" };

export type HostRuntimeAgentDirectoryStatus =
  | "idle"
  | "initial_loading"
  | "revalidating"
  | "ready"
  | "error_before_first_success"
  | "error_after_ready";

export type HostRuntimeSnapshot = {
  serverId: string;
  activeConnectionId: string | null;
  activeConnection: ActiveConnection | null;
  connectionStatus: HostRuntimeConnectionStatus;
  client: DaemonClient | null;
  lastError: string | null;
  lastOnlineAt: string | null;
  agentDirectoryStatus: HostRuntimeAgentDirectoryStatus;
  agentDirectoryError: string | null;
  hasEverLoadedAgentDirectory: boolean;
  probeByConnectionId: Map<string, ConnectionProbeState>;
  clientGeneration: number;
};

type HostRuntimeSnapshotPatch = Partial<Omit<HostRuntimeSnapshot, "serverId" | "clientGeneration">>;

function setSnapshotPatchField<Key extends keyof HostRuntimeSnapshotPatch>(
  patch: HostRuntimeSnapshotPatch,
  key: Key,
  value: HostRuntimeSnapshot[Key],
): void {
  patch[key] = value;
}

export function isHostRuntimeConnected(snapshot: HostRuntimeSnapshot | null): boolean {
  return snapshot?.connectionStatus === "online";
}

export function isHostRuntimeDirectoryLoading(snapshot: HostRuntimeSnapshot | null): boolean {
  if (!snapshot) {
    return true;
  }
  if (
    snapshot.agentDirectoryStatus === "initial_loading" ||
    snapshot.agentDirectoryStatus === "revalidating"
  ) {
    return true;
  }
  return (
    !snapshot.hasEverLoadedAgentDirectory &&
    (snapshot.connectionStatus === "connecting" || snapshot.connectionStatus === "online")
  );
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hashForLog(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return `h_${Math.abs(hash).toString(16)}`;
}

export type HostRuntimeControllerDeps = {
  createClient: (input: {
    host: HostProfile;
    connection: HostConnection;
    clientId: string;
    runtimeGeneration: number;
  }) => DaemonClient;
  connectToDaemon: (input: { host: HostProfile; connection: HostConnection }) => Promise<{
    client: DaemonClient;
    serverId: string;
    hostname: string | null;
  }>;
  getClientId: () => Promise<string>;
};

export type HostRuntimeStartOptions = {
  autoProbe?: boolean;
  initialConnection?: {
    connectionId: string;
    existingClient: DaemonClient;
  };
};

const PROBE_TICK_MS = 2_000;
const PROBE_STEADY_MS = 10_000;
const PROBE_MAX_BACKOFF_MS = 30_000;
const ADAPTIVE_SWITCH_THRESHOLD_MS = 40;
const ADAPTIVE_SWITCH_CONSECUTIVE_PROBES = 3;
const DEFAULT_AGENT_DIRECTORY_PAGE_LIMIT = 200;

const DEFAULT_AGENT_DIRECTORY_SORT: NonNullable<FetchAgentsOptions["sort"]> = [
  { key: "updated_at", direction: "desc" },
];

function readFetchAgentsHasMore(
  pageInfo: Awaited<ReturnType<DaemonClient["fetchAgents"]>>["pageInfo"],
): boolean {
  const page = pageInfo as {
    hasMore?: boolean;
    hasMoreAfter?: boolean;
  };
  if (typeof page.hasMore === "boolean") {
    return page.hasMore;
  }
  if (typeof page.hasMoreAfter === "boolean") {
    return page.hasMoreAfter;
  }
  return false;
}

function readFetchAgentsNextCursor(
  pageInfo: Awaited<ReturnType<DaemonClient["fetchAgents"]>>["pageInfo"],
): string | null {
  const page = pageInfo as {
    nextCursor?: string | null;
    afterCursor?: string | null;
  };
  if (typeof page.nextCursor === "string" && page.nextCursor.length > 0) {
    return page.nextCursor;
  }
  if (typeof page.afterCursor === "string" && page.afterCursor.length > 0) {
    return page.afterCursor;
  }
  return null;
}

function toActiveConnection(connection: HostConnection): ActiveConnection {
  if (connection.type === "directSocket") {
    return {
      type: "directSocket",
      endpoint: connection.path,
      display: "socket",
    };
  }
  if (connection.type === "directPipe") {
    return {
      type: "directPipe",
      endpoint: connection.path,
      display: "pipe",
    };
  }
  if (connection.type === "directTcp") {
    return {
      type: "directTcp",
      endpoint: connection.endpoint,
      display: connection.endpoint,
    };
  }
  return {
    type: "relay",
    endpoint: connection.relayEndpoint,
    display: "relay",
  };
}

type HostRuntimeConnectionMachineState =
  | { tag: "booting" }
  | {
      tag: "connecting";
      activeConnectionId: string;
      activeConnection: ActiveConnection;
    }
  | {
      tag: "online";
      activeConnectionId: string;
      activeConnection: ActiveConnection;
      lastOnlineAt: string;
    }
  | {
      tag: "offline";
      activeConnectionId: string | null;
      activeConnection: ActiveConnection | null;
    }
  | {
      tag: "error";
      activeConnectionId: string | null;
      activeConnection: ActiveConnection | null;
      message: string;
    };

type HostRuntimeConnectionMachineEvent =
  | { type: "select_connection"; connectionId: string; connection: ActiveConnection }
  | { type: "client_state"; state: ConnectionState; lastError: string | null }
  | { type: "connect_failed"; message: string }
  | { type: "no_connections" }
  | { type: "stopped" };

function nextConnectionMachineState(input: {
  state: HostRuntimeConnectionMachineState;
  event: HostRuntimeConnectionMachineEvent;
}): HostRuntimeConnectionMachineState {
  const { state, event } = input;

  if (event.type === "select_connection") {
    return {
      tag: "connecting",
      activeConnectionId: event.connectionId,
      activeConnection: event.connection,
    };
  }

  if (event.type === "connect_failed") {
    return {
      tag: "error",
      activeConnectionId:
        state.tag === "connecting" || state.tag === "online"
          ? state.activeConnectionId
          : state.tag === "offline" || state.tag === "error"
            ? state.activeConnectionId
            : null,
      activeConnection:
        state.tag === "connecting" || state.tag === "online"
          ? state.activeConnection
          : state.tag === "offline" || state.tag === "error"
            ? state.activeConnection
            : null,
      message: event.message,
    };
  }

  if (event.type === "no_connections" || event.type === "stopped") {
    return {
      tag: "offline",
      activeConnectionId: null,
      activeConnection: null,
    };
  }

  const previousActiveConnectionId =
    state.tag === "connecting" || state.tag === "online"
      ? state.activeConnectionId
      : state.tag === "offline" || state.tag === "error"
        ? state.activeConnectionId
        : null;
  const previousActiveConnection =
    state.tag === "connecting" || state.tag === "online"
      ? state.activeConnection
      : state.tag === "offline" || state.tag === "error"
        ? state.activeConnection
        : null;

  if (!previousActiveConnectionId || !previousActiveConnection) {
    return state.tag === "booting"
      ? state
      : {
          tag: "offline",
          activeConnectionId: null,
          activeConnection: null,
        };
  }

  if (event.state.status === "connected") {
    return {
      tag: "online",
      activeConnectionId: previousActiveConnectionId,
      activeConnection: previousActiveConnection,
      lastOnlineAt: new Date().toISOString(),
    };
  }

  if (event.state.status === "connecting" || event.state.status === "idle") {
    return {
      tag: "connecting",
      activeConnectionId: previousActiveConnectionId,
      activeConnection: previousActiveConnection,
    };
  }

  if (event.state.status === "disposed") {
    return {
      tag: "offline",
      activeConnectionId: previousActiveConnectionId,
      activeConnection: previousActiveConnection,
    };
  }

  const reason = event.state.reason ?? event.lastError ?? null;
  if (!reason || reason === "client_closed") {
    return {
      tag: "offline",
      activeConnectionId: previousActiveConnectionId,
      activeConnection: previousActiveConnection,
    };
  }

  return {
    tag: "error",
    activeConnectionId: previousActiveConnectionId,
    activeConnection: previousActiveConnection,
    message: reason,
  };
}

function toSnapshotConnectionPatch(
  state: HostRuntimeConnectionMachineState,
): Pick<
  HostRuntimeSnapshot,
  "activeConnectionId" | "activeConnection" | "connectionStatus" | "lastError" | "lastOnlineAt"
> {
  if (state.tag === "booting") {
    return {
      activeConnectionId: null,
      activeConnection: null,
      connectionStatus: "connecting",
      lastError: null,
      lastOnlineAt: null,
    };
  }
  if (state.tag === "connecting") {
    return {
      activeConnectionId: state.activeConnectionId,
      activeConnection: state.activeConnection,
      connectionStatus: "connecting",
      lastError: null,
      lastOnlineAt: null,
    };
  }
  if (state.tag === "online") {
    return {
      activeConnectionId: state.activeConnectionId,
      activeConnection: state.activeConnection,
      connectionStatus: "online",
      lastError: null,
      lastOnlineAt: state.lastOnlineAt,
    };
  }
  if (state.tag === "offline") {
    return {
      activeConnectionId: state.activeConnectionId,
      activeConnection: state.activeConnection,
      connectionStatus: "offline",
      lastError: null,
      lastOnlineAt: null,
    };
  }
  return {
    activeConnectionId: state.activeConnectionId,
    activeConnection: state.activeConnection,
    connectionStatus: "error",
    lastError: state.message,
    lastOnlineAt: null,
  };
}

function buildConnectionCandidates(host: HostProfile): ConnectionCandidate[] {
  return host.connections.map((connection) => ({
    connectionId: connection.id,
    connection,
  }));
}

function findConnectionById(host: HostProfile, connectionId: string | null): HostConnection | null {
  if (!connectionId) {
    return null;
  }
  return host.connections.find((connection) => connection.id === connectionId) ?? null;
}

function probeIntervalForConnection(
  firstSeenAt: number,
  isActiveOnline: boolean,
  now: number,
): number {
  if (isActiveOnline) {
    return PROBE_STEADY_MS;
  }
  const age = now - firstSeenAt;
  if (age < 10_000) return 2_000;
  if (age < 30_000) return 5_000;
  if (age < 60_000) return PROBE_STEADY_MS;
  return PROBE_MAX_BACKOFF_MS;
}

function createDefaultDeps(): HostRuntimeControllerDeps {
  return {
    createClient: ({ host, connection, clientId, runtimeGeneration }) => {
      const localTransportFactory = createDesktopLocalDaemonTransportFactory();
      const base = {
        suppressSendErrors: true,
        clientId,
        clientType: "mobile" as const,
        appVersion: resolveAppVersion() ?? undefined,
        runtimeGeneration,
        ...(isDev ? { runtimeMetricsIntervalMs: 10_000 } : {}),
      };
      if (connection.type === "directSocket" || connection.type === "directPipe") {
        return new DaemonClient({
          ...base,
          ...(localTransportFactory ? { transportFactory: localTransportFactory } : {}),
          url: buildLocalDaemonTransportUrl({
            transportType: connection.type === "directSocket" ? "socket" : "pipe",
            transportPath: connection.path,
          }),
        });
      }
      if (connection.type === "directTcp") {
        return new DaemonClient({
          ...base,
          url: buildDaemonWebSocketUrl(connection.endpoint),
        });
      }
      return new DaemonClient({
        ...base,
        url: buildRelayWebSocketUrl({
          endpoint: connection.relayEndpoint,
          serverId: host.serverId,
        }),
        e2ee: {
          enabled: true,
          daemonPublicKeyB64: connection.daemonPublicKeyB64,
        },
      });
    },
    connectToDaemon: ({ host, connection }) =>
      connectToDaemon(connection, { serverId: host.serverId }),
    getClientId: () => getOrCreateClientId(),
  };
}

export class HostRuntimeController {
  private host: HostProfile;
  private deps: HostRuntimeControllerDeps;
  private connectionMachineState: HostRuntimeConnectionMachineState;
  private snapshot: HostRuntimeSnapshot;
  private listeners = new Set<() => void>();
  private activeClient: DaemonClient | null = null;
  private unsubscribeClientStatus: (() => void) | null = null;
  private probeIntervalHandle: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private connectionFirstSeenAt = new Map<string, number>();
  private connectionLastProbedAt = new Map<string, number>();
  private switchCandidateConnectionId: string | null = null;
  private switchCandidateHitCount = 0;
  private clientIdPromise: Promise<string> | null = null;
  private clientIdHash: string | null = null;
  private switchRequestVersion = 0;
  private probeRequestVersion = 0;
  private probeCycleInFlight: Promise<void> | null = null;

  constructor(input: {
    host: HostProfile;
    deps?: HostRuntimeControllerDeps;
  }) {
    this.host = input.host;
    this.deps = input.deps ?? createDefaultDeps();
    this.connectionMachineState = {
      tag: "booting",
    };
    this.snapshot = {
      serverId: this.host.serverId,
      ...toSnapshotConnectionPatch(this.connectionMachineState),
      client: null,
      agentDirectoryStatus: "idle",
      agentDirectoryError: null,
      hasEverLoadedAgentDirectory: false,
      probeByConnectionId: new Map(),
      clientGeneration: 0,
    };
  }

  getSnapshot(): HostRuntimeSnapshot {
    return this.snapshot;
  }

  getClient(): DaemonClient | null {
    return this.snapshot.client;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async start(options?: HostRuntimeStartOptions): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    this.trackConnectionFirstSeen();
    if (options?.initialConnection) {
      await this.switchToConnection({
        connectionId: options.initialConnection.connectionId,
        existingClient: options.initialConnection.existingClient,
      });
    }
    await this.runProbeCycleNow();
    if (options?.autoProbe !== false) {
      this.probeIntervalHandle = setInterval(() => {
        void this.runProbeCycleNow();
      }, PROBE_TICK_MS);
    }
  }

  async stop(): Promise<void> {
    this.switchRequestVersion += 1;
    this.probeRequestVersion += 1;
    this.started = false;
    if (this.probeIntervalHandle) {
      clearInterval(this.probeIntervalHandle);
      this.probeIntervalHandle = null;
    }
    if (this.unsubscribeClientStatus) {
      this.unsubscribeClientStatus();
      this.unsubscribeClientStatus = null;
    }
    if (this.activeClient) {
      const prev = this.activeClient;
      this.activeClient = null;
      await prev.close().catch(() => undefined);
    }
    this.applyConnectionEvent({ type: "stopped" });
    this.updateSnapshot({
      ...toSnapshotConnectionPatch(this.connectionMachineState),
      client: null,
    });
  }

  async updateHost(host: HostProfile): Promise<void> {
    this.host = host;
    this.trackConnectionFirstSeen();
    await this.runProbeCycleNow();
  }

  ensureConnected(): void {
    this.activeClient?.ensureConnected();
  }

  markAgentDirectorySyncLoading(): void {
    const status = this.snapshot.hasEverLoadedAgentDirectory ? "revalidating" : "initial_loading";
    this.updateSnapshot({
      agentDirectoryStatus: status,
      agentDirectoryError: null,
    });
  }

  markAgentDirectorySyncReady(): void {
    this.updateSnapshot({
      agentDirectoryStatus: "ready",
      agentDirectoryError: null,
      hasEverLoadedAgentDirectory: true,
    });
  }

  markAgentDirectorySyncError(error: string): void {
    const hasEverLoadedAgentDirectory = this.snapshot.hasEverLoadedAgentDirectory;
    this.updateSnapshot({
      agentDirectoryStatus: hasEverLoadedAgentDirectory
        ? "error_after_ready"
        : "error_before_first_success",
      agentDirectoryError: error,
      hasEverLoadedAgentDirectory,
    });
  }

  markAgentDirectorySyncIdle(): void {
    this.updateSnapshot({
      agentDirectoryStatus: this.snapshot.hasEverLoadedAgentDirectory ? "ready" : "idle",
      agentDirectoryError: null,
    });
  }

  markStartupError(message: string): void {
    this.applyConnectionEvent({ type: "connect_failed", message });
    this.updateSnapshot({
      ...toSnapshotConnectionPatch(this.connectionMachineState),
    });
  }

  async activateConnection(input: {
    connectionId: string;
    existingClient: DaemonClient;
  }): Promise<void> {
    await this.switchToConnection(input);
  }

  async runProbeCycleNow(): Promise<void> {
    if (this.probeCycleInFlight) {
      return this.probeCycleInFlight;
    }

    const cycle = this.runProbeCycle().finally(() => {
      if (this.probeCycleInFlight === cycle) {
        this.probeCycleInFlight = null;
      }
    });
    this.probeCycleInFlight = cycle;
    return cycle;
  }

  private async runProbeCycle(): Promise<void> {
    const requestVersion = ++this.probeRequestVersion;
    if (this.host.connections.length === 0) {
      if (!this.isCurrentProbeRequest(requestVersion)) {
        return;
      }
      this.applyConnectionEvent({ type: "no_connections" });
      this.updateSnapshot({
        ...toSnapshotConnectionPatch(this.connectionMachineState),
        probeByConnectionId: new Map(),
      });
      return;
    }

    const now = performance.now();
    const isOnline = this.snapshot.connectionStatus === "online";
    const activeConnectionId = this.snapshot.activeConnectionId;

    const connectionsToProbe = this.host.connections.filter((connection) => {
      const lastProbed = this.connectionLastProbedAt.get(connection.id);
      if (lastProbed == null) {
        return true;
      }
      const firstSeen = this.connectionFirstSeenAt.get(connection.id) ?? now;
      const isActiveOnline = isOnline && connection.id === activeConnectionId;
      const interval = probeIntervalForConnection(firstSeen, isActiveOnline, now);
      return now - lastProbed >= interval;
    });

    if (connectionsToProbe.length === 0) {
      return;
    }

    const probeByConnectionId = new Map(this.snapshot.probeByConnectionId);
    for (const connection of connectionsToProbe) {
      this.connectionLastProbedAt.set(connection.id, performance.now());
      const existingProbe = probeByConnectionId.get(connection.id);
      const shouldPreserveActiveLatency =
        isOnline && connection.id === activeConnectionId && existingProbe?.status === "available";
      if (!shouldPreserveActiveLatency) {
        probeByConnectionId.set(connection.id, {
          status: "pending",
          latencyMs: null,
        });
      }
    }
    this.updateSnapshot({ probeByConnectionId: new Map(probeByConnectionId) });

    let remaining = connectionsToProbe.length;
    let activationLock: Promise<void> | null = null;

    const publishProbeState = (): void => {
      if (!this.isCurrentProbeRequest(requestVersion)) {
        return;
      }
      this.updateSnapshot({ probeByConnectionId: new Map(probeByConnectionId) });
    };

    const maybeActivateFirstAvailable = async (
      connectionId: string,
      client: DaemonClient,
    ): Promise<boolean> => {
      while (!this.snapshot.activeConnectionId) {
        if (!activationLock) {
          activationLock = this.switchToConnection({
            connectionId,
            expectedProbeVersion: requestVersion,
            existingClient: client,
          }).finally(() => {
            activationLock = null;
          });
          await activationLock;
          return this.snapshot.activeConnectionId === connectionId;
        }
        await activationLock;
      }
      return false;
    };

    const finalizeProbeCycle = async (): Promise<void> => {
      if (remaining > 0 || !this.isCurrentProbeRequest(requestVersion)) {
        return;
      }

      const currentActiveConnectionId = this.snapshot.activeConnectionId;
      const activeProbe = currentActiveConnectionId
        ? probeByConnectionId.get(currentActiveConnectionId)
        : null;

      if (!currentActiveConnectionId || !findConnectionById(this.host, currentActiveConnectionId)) {
        const nextConnectionId = selectBestConnection({
          candidates: buildConnectionCandidates(this.host),
          probeByConnectionId,
        });
        if (nextConnectionId) {
          await this.switchToConnection({
            connectionId: nextConnectionId,
            expectedProbeVersion: requestVersion,
          });
        }
        return;
      }

      if (activeProbe?.status === "unavailable") {
        const nextConnectionId = selectBestConnection({
          candidates: buildConnectionCandidates(this.host),
          probeByConnectionId,
        });
        if (nextConnectionId && nextConnectionId !== currentActiveConnectionId) {
          await this.switchToConnection({
            connectionId: nextConnectionId,
            expectedProbeVersion: requestVersion,
          });
        }
        this.switchCandidateConnectionId = null;
        this.switchCandidateHitCount = 0;
        return;
      }

      if (!activeProbe || activeProbe.status !== "available") {
        return;
      }

      const available = Array.from(probeByConnectionId.entries())
        .filter(
          (entry): entry is [string, Extract<ConnectionProbeState, { status: "available" }>] =>
            entry[1].status === "available",
        )
        .map(([connectionId, probe]) => ({
          connectionId,
          latencyMs: probe.latencyMs,
        }))
        .sort((left, right) => left.latencyMs - right.latencyMs);

      const fastest = available[0] ?? null;
      if (!fastest || fastest.connectionId === currentActiveConnectionId) {
        this.switchCandidateConnectionId = null;
        this.switchCandidateHitCount = 0;
        return;
      }

      const improvement = activeProbe.latencyMs - fastest.latencyMs;
      if (improvement < ADAPTIVE_SWITCH_THRESHOLD_MS) {
        this.switchCandidateConnectionId = null;
        this.switchCandidateHitCount = 0;
        return;
      }

      if (this.switchCandidateConnectionId === fastest.connectionId) {
        this.switchCandidateHitCount += 1;
      } else {
        this.switchCandidateConnectionId = fastest.connectionId;
        this.switchCandidateHitCount = 1;
      }

      if (this.switchCandidateHitCount >= ADAPTIVE_SWITCH_CONSECUTIVE_PROBES) {
        this.switchCandidateConnectionId = null;
        this.switchCandidateHitCount = 0;
        await this.switchToConnection({
          connectionId: fastest.connectionId,
          expectedProbeVersion: requestVersion,
        });
      }
    };

    await new Promise<void>((resolve) => {
      const settleProbe = (): void => {
        remaining -= 1;
        void finalizeProbeCycle().finally(() => {
          if (remaining === 0) {
            resolve();
          }
        });
      };

      for (const connection of connectionsToProbe) {
        void (async () => {
          let connectedClient: DaemonClient | null = null;
          let shouldCloseClient = false;
          try {
            const activeClient =
              this.snapshot.connectionStatus === "online" &&
              this.snapshot.activeConnectionId === connection.id
                ? this.snapshot.client
                : null;

            if (activeClient) {
              connectedClient = activeClient;
            } else {
              const { client, serverId } = await this.deps.connectToDaemon({
                host: this.host,
                connection,
              });
              if (serverId !== this.host.serverId) {
                await client.close().catch(() => undefined);
                throw new Error(
                  `Connection resolved to ${serverId}, expected ${this.host.serverId}.`,
                );
              }
              connectedClient = client;
              shouldCloseClient = true;
            }

            if (!this.isCurrentProbeRequest(requestVersion)) {
              return;
            }

            const activated = await maybeActivateFirstAvailable(connection.id, connectedClient);
            shouldCloseClient = shouldCloseClient && !activated;

            const { rttMs } = await connectedClient.ping({ timeoutMs: 5000 });
            if (!this.isCurrentProbeRequest(requestVersion)) {
              return;
            }

            probeByConnectionId.set(connection.id, {
              status: "available",
              latencyMs: rttMs,
            });
            publishProbeState();
          } catch {
            if (this.isCurrentProbeRequest(requestVersion)) {
              probeByConnectionId.set(connection.id, {
                status: "unavailable",
                latencyMs: null,
              });
              publishProbeState();
            }
          } finally {
            if (connectedClient && shouldCloseClient) {
              await connectedClient.close().catch(() => undefined);
            }
            settleProbe();
          }
        })();
      }
    });
  }

  private updateSnapshot(patch: HostRuntimeSnapshotPatch): void {
    const preservedPatch: HostRuntimeSnapshotPatch = { ...patch };
    let hasChanged = this.host.serverId !== this.snapshot.serverId;
    for (const key of Object.keys(patch) as Array<keyof HostRuntimeSnapshotPatch>) {
      const incomingValue = patch[key];
      if (equal(this.snapshot[key], incomingValue)) {
        setSnapshotPatchField(preservedPatch, key, this.snapshot[key]);
        continue;
      }
      hasChanged = true;
    }
    if (!hasChanged) {
      return;
    }
    this.snapshot = {
      ...this.snapshot,
      ...preservedPatch,
      serverId: this.host.serverId,
    };
    for (const listener of this.listeners) {
      listener();
    }
  }

  private applyConnectionEvent(event: HostRuntimeConnectionMachineEvent): void {
    const previousState = this.connectionMachineState;
    const nextState = nextConnectionMachineState({
      state: previousState,
      event,
    });
    this.connectionMachineState = nextState;
    this.logConnectionTransition({
      from: previousState.tag,
      to: nextState.tag,
      event,
    });
  }

  private logConnectionTransition(_input: {
    from: HostRuntimeConnectionMachineState["tag"];
    to: HostRuntimeConnectionMachineState["tag"];
    event: HostRuntimeConnectionMachineEvent;
  }): void {
    // Intentionally empty - logging removed.
  }

  private trackConnectionFirstSeen(): void {
    const now = performance.now();
    const currentIds = new Set(this.host.connections.map((c) => c.id));
    for (const id of this.connectionFirstSeenAt.keys()) {
      if (!currentIds.has(id)) {
        this.connectionFirstSeenAt.delete(id);
        this.connectionLastProbedAt.delete(id);
      }
    }
    for (const connection of this.host.connections) {
      if (!this.connectionFirstSeenAt.has(connection.id)) {
        this.connectionFirstSeenAt.set(connection.id, now);
      }
    }
  }

  private isCurrentSwitchRequest(version: number): boolean {
    return version === this.switchRequestVersion;
  }

  private isCurrentProbeRequest(version: number): boolean {
    return version === this.probeRequestVersion;
  }

  private canProceedForProbe(expectedProbeVersion: number | undefined): boolean {
    if (expectedProbeVersion === undefined) {
      return true;
    }
    return this.isCurrentProbeRequest(expectedProbeVersion);
  }

  private async switchToConnection(input: {
    connectionId: string;
    expectedProbeVersion?: number;
    existingClient?: DaemonClient;
  }): Promise<void> {
    if (!this.canProceedForProbe(input.expectedProbeVersion)) {
      if (input.existingClient) {
        await input.existingClient.close().catch(() => undefined);
      }
      return;
    }
    const { connectionId, expectedProbeVersion, existingClient } = input;
    const connection = findConnectionById(this.host, connectionId);
    if (!connection) {
      if (existingClient) {
        await existingClient.close().catch(() => undefined);
      }
      return;
    }
    const requestVersion = ++this.switchRequestVersion;

    let clientId: string;
    try {
      clientId = await this.resolveClientId();
    } catch (error) {
      if (existingClient) {
        await existingClient.close().catch(() => undefined);
      }
      if (!this.isCurrentSwitchRequest(requestVersion)) {
        return;
      }
      const message = toErrorMessage(error);
      this.applyConnectionEvent({
        type: "connect_failed",
        message: `Failed to resolve client id: ${message}`,
      });
      this.updateSnapshot({
        ...toSnapshotConnectionPatch(this.connectionMachineState),
      });
      return;
    }

    if (!this.isCurrentSwitchRequest(requestVersion)) {
      if (existingClient) {
        await existingClient.close().catch(() => undefined);
      }
      return;
    }
    if (!this.canProceedForProbe(expectedProbeVersion)) {
      if (existingClient) {
        await existingClient.close().catch(() => undefined);
      }
      return;
    }

    if (this.unsubscribeClientStatus) {
      this.unsubscribeClientStatus();
      this.unsubscribeClientStatus = null;
    }
    if (this.activeClient) {
      const previousClient = this.activeClient;
      this.activeClient = null;
      await previousClient.close().catch(() => undefined);
    }
    if (!this.isCurrentSwitchRequest(requestVersion)) {
      if (existingClient) {
        await existingClient.close().catch(() => undefined);
      }
      return;
    }
    if (!this.canProceedForProbe(expectedProbeVersion)) {
      if (existingClient) {
        await existingClient.close().catch(() => undefined);
      }
      return;
    }

    const nextGeneration = this.snapshot.clientGeneration + 1;
    if (existingClient) {
      existingClient.setReconnectEnabled(true);
    }
    const client =
      existingClient ??
      this.deps.createClient({
        host: this.host,
        connection,
        clientId,
        runtimeGeneration: nextGeneration,
      });
    if (!this.isCurrentSwitchRequest(requestVersion)) {
      await client.close().catch(() => undefined);
      return;
    }
    if (!this.canProceedForProbe(expectedProbeVersion)) {
      await client.close().catch(() => undefined);
      return;
    }
    this.activeClient = client;
    this.applyConnectionEvent({
      type: "select_connection",
      connectionId: connection.id,
      connection: toActiveConnection(connection),
    });
    this.snapshot = {
      ...this.snapshot,
      serverId: this.host.serverId,
      ...toSnapshotConnectionPatch(this.connectionMachineState),
      client,
      clientGeneration: nextGeneration,
    };
    for (const listener of this.listeners) {
      listener();
    }

    this.unsubscribeClientStatus = client.subscribeConnectionStatus((state) => {
      if (!this.isCurrentSwitchRequest(requestVersion) || this.activeClient !== client) {
        return;
      }
      this.applyConnectionEvent({
        type: "client_state",
        state,
        lastError: client.lastError,
      });
      const patch: HostRuntimeSnapshotPatch = {
        ...toSnapshotConnectionPatch(this.connectionMachineState),
      };

      if (!this.snapshot.hasEverLoadedAgentDirectory) {
        if (
          this.connectionMachineState.tag === "connecting" ||
          this.connectionMachineState.tag === "online"
        ) {
          patch.agentDirectoryStatus = "initial_loading";
          patch.agentDirectoryError = null;
        } else if (this.connectionMachineState.tag === "error") {
          patch.agentDirectoryStatus = "error_before_first_success";
          patch.agentDirectoryError = this.connectionMachineState.message;
        } else {
          patch.agentDirectoryStatus = "idle";
          patch.agentDirectoryError = null;
        }
      }

      this.updateSnapshot(patch);
    });

    try {
      if (!existingClient) {
        await client.connect();
      }
    } catch (error) {
      if (!this.isCurrentSwitchRequest(requestVersion) || this.activeClient !== client) {
        return;
      }
      const message = toErrorMessage(error);
      this.applyConnectionEvent({
        type: "connect_failed",
        message,
      });
      this.updateSnapshot({
        ...toSnapshotConnectionPatch(this.connectionMachineState),
      });
    }
  }

  private resolveClientId(): Promise<string> {
    if (!this.clientIdPromise) {
      this.clientIdPromise = this.deps.getClientId().then((value) => {
        this.clientIdHash = hashForLog(value);
        return value;
      });
    }
    return this.clientIdPromise;
  }
}

const REGISTRY_STORAGE_KEY = "@paseo:daemon-registry";
const DEFAULT_LOCALHOST_ENDPOINT = process.env.EXPO_PUBLIC_LOCAL_DAEMON?.trim() || "localhost:6767";
const DEFAULT_LOCALHOST_BOOTSTRAP_TIMEOUT_MS = 2500;
const CONNECTION_ONLINE_TIMEOUT_MS = 15_000;
const E2E_STORAGE_KEY = "@paseo:e2e";

export class HostRuntimeStore {
  private controllers = new Map<string, HostRuntimeController>();
  private serverListeners = new Map<string, Set<() => void>>();
  private globalListeners = new Set<() => void>();
  private hostListListeners = new Set<() => void>();
  private version = 0;
  private hostListVersion = 0;
  private hosts: HostProfile[] = [];
  private deps: HostRuntimeControllerDeps;
  private lastConnectionStatusByServer = new Map<string, HostRuntimeConnectionStatus>();
  private agentDirectoryBootstrapInFlight = new Map<string, Promise<void>>();
  private storageLoaded = false;
  private bootstrapAttempted = false;

  constructor(input?: {
    deps?: HostRuntimeControllerDeps;
  }) {
    this.deps = input?.deps ?? createDefaultDeps();
  }

  // --- Host registry ---

  getHosts(): HostProfile[] {
    return this.hosts;
  }

  subscribeHostList(listener: () => void): () => void {
    this.hostListListeners.add(listener);
    return () => {
      this.hostListListeners.delete(listener);
    };
  }

  getHostListVersion(): number {
    return this.hostListVersion;
  }

  async loadFromStorage(): Promise<void> {
    if (this.storageLoaded) {
      return;
    }
    this.storageLoaded = true;
    try {
      const stored = await AsyncStorage.getItem(REGISTRY_STORAGE_KEY);
      if (!stored) {
        return;
      }
      const parsed = JSON.parse(stored) as unknown;
      if (!Array.isArray(parsed)) {
        return;
      }
      const profiles = parsed
        .map((entry) => normalizeStoredHostProfile(entry))
        .filter((entry): entry is HostProfile => entry !== null);
      this.hosts = profiles;
      this.syncHosts(profiles);
      this.emitHostList();
    } catch (error) {
      console.error("[HostRuntime] Failed to load host registry from storage", error);
    }
  }

  async bootstrap(options?: { manageBuiltInDaemon?: boolean }): Promise<void> {
    if (this.bootstrapAttempted) {
      return;
    }
    this.bootstrapAttempted = true;

    try {
      const isE2E = await AsyncStorage.getItem(E2E_STORAGE_KEY);
      if (isE2E) {
        return;
      }
    } catch {
      return;
    }

    if (shouldUseDesktopDaemon()) {
      if (options?.manageBuiltInDaemon ?? true) {
        await this.bootstrapDesktop();
      }
    } else {
      await this.bootstrapLocalhost();
    }
  }

  async bootstrapDesktop(): Promise<HostRuntimeBootstrapResult> {
    try {
      const daemon = await startDesktopDaemon();
      const listenAddress = daemon.listen?.trim() ?? "";
      const serverId = daemon.serverId.trim();
      if (!listenAddress) {
        return {
          ok: false,
          error: "Desktop daemon did not return a listen address.",
        };
      }
      if (!serverId) {
        return {
          ok: false,
          error: "Desktop daemon did not return a server id.",
        };
      }
      if (!connectionFromListen(listenAddress)) {
        return {
          ok: false,
          error: `Desktop daemon returned an unsupported listen address: ${listenAddress}`,
        };
      }
      return {
        ok: true,
        listenAddress,
        serverId,
        hostname: daemon.hostname,
      };
    } catch (error) {
      return {
        ok: false,
        error: toErrorMessage(error),
      };
    }
  }

  private async bootstrapLocalhost(): Promise<void> {
    try {
      const connection = connectionFromListen(DEFAULT_LOCALHOST_ENDPOINT);
      if (!connection || registryHasConnection(this.hosts, connection)) {
        return;
      }

      try {
        const { client, serverId, hostname } = await connectToDaemon(connection, {
          timeoutMs: DEFAULT_LOCALHOST_BOOTSTRAP_TIMEOUT_MS,
        });

        await this.upsertHostConnection({
          serverId,
          label: hostname ?? undefined,
          connection,
          existingClient: client,
        });
      } catch {
        // Best-effort bootstrap only
      }
    } catch (error) {
      console.warn("[HostRuntime] Failed to bootstrap host connections", error);
    }
  }

  async upsertDirectConnection(input: {
    serverId: string;
    endpoint: string;
    label?: string;
    existingClient?: DaemonClient;
  }): Promise<HostProfile> {
    const endpoint = normalizeHostPort(input.endpoint);
    return this.upsertHostConnection({
      serverId: input.serverId,
      label: input.label,
      connection: {
        id: `direct:${endpoint}`,
        type: "directTcp",
        endpoint,
      },
      existingClient: input.existingClient,
    });
  }

  async upsertRelayConnection(input: {
    serverId: string;
    relayEndpoint: string;
    daemonPublicKeyB64: string;
    label?: string;
  }): Promise<HostProfile> {
    const relayEndpoint = normalizeHostPort(input.relayEndpoint);
    const daemonPublicKeyB64 = input.daemonPublicKeyB64.trim();
    if (!daemonPublicKeyB64) {
      throw new Error("daemonPublicKeyB64 is required");
    }
    return this.upsertHostConnection({
      serverId: input.serverId,
      label: input.label,
      connection: {
        id: `relay:${relayEndpoint}`,
        type: "relay",
        relayEndpoint,
        daemonPublicKeyB64,
      },
    });
  }

  async upsertConnectionFromOffer(offer: ConnectionOffer, label?: string): Promise<HostProfile> {
    return this.upsertRelayConnection({
      serverId: offer.serverId,
      relayEndpoint: offer.relay.endpoint,
      daemonPublicKeyB64: offer.daemonPublicKeyB64,
      label,
    });
  }

  async upsertConnectionFromOfferUrl(
    offerUrlOrFragment: string,
    label?: string,
  ): Promise<HostProfile> {
    const marker = "#offer=";
    const idx = offerUrlOrFragment.indexOf(marker);
    if (idx === -1) {
      throw new Error("Missing #offer= fragment");
    }
    const encoded = offerUrlOrFragment.slice(idx + marker.length).trim();
    if (!encoded) {
      throw new Error("Offer payload is empty");
    }
    const payload = decodeOfferFragmentPayload(encoded);
    const offer = ConnectionOfferSchema.parse(payload);
    return this.upsertConnectionFromOffer(offer, label);
  }

  async addConnectionFromListenAndWaitForOnline(input: {
    listenAddress: string;
    serverId: string;
    hostname: string | null;
    timeoutMs?: number;
  }): Promise<HostProfile> {
    const normalizedListenAddress = input.listenAddress.trim();
    const serverId = input.serverId.trim();
    const connection = connectionFromListen(normalizedListenAddress);
    if (!connection) {
      throw new Error(`Unsupported listen address: ${input.listenAddress}`);
    }
    if (!serverId) {
      throw new Error("Desktop daemon did not return a server id.");
    }
    const profile = await this.upsertHostConnection({
      serverId,
      label: input.hostname ?? undefined,
      connection,
    });

    await this.waitForConnectionOnline({
      serverId,
      connectionId: connection.id,
      timeoutMs: input.timeoutMs,
    });

    return profile;
  }

  async renameHost(serverId: string, label: string): Promise<void> {
    const next = this.hosts.map((h) =>
      h.serverId === serverId ? { ...h, label, updatedAt: new Date().toISOString() } : h,
    );
    this.setHostsAndSync(next);
    await this.persistHosts();
  }

  async removeHost(serverId: string): Promise<void> {
    const remaining = this.hosts.filter((daemon) => daemon.serverId !== serverId);
    this.setHostsAndSync(remaining);
    await this.persistHosts();
  }

  async removeConnection(serverId: string, connectionId: string): Promise<void> {
    const now = new Date().toISOString();
    const next = this.hosts
      .map((daemon) => {
        if (daemon.serverId !== serverId) return daemon;
        const remaining = daemon.connections.filter((conn) => conn.id !== connectionId);
        if (remaining.length === 0) {
          return null;
        }
        const preferred =
          daemon.preferredConnectionId === connectionId
            ? (remaining[0]?.id ?? null)
            : daemon.preferredConnectionId;
        return {
          ...daemon,
          connections: remaining,
          preferredConnectionId: preferred,
          updatedAt: now,
        } satisfies HostProfile;
      })
      .filter((entry): entry is HostProfile => entry !== null);
    this.setHostsAndSync(next);
    await this.persistHosts();
  }

  private async upsertHostConnection(input: {
    serverId: string;
    label?: string;
    connection: HostConnection;
    existingClient?: DaemonClient;
  }): Promise<HostProfile> {
    const now = new Date().toISOString();
    const next = upsertHostConnectionInProfiles({
      profiles: this.hosts,
      serverId: input.serverId,
      label: input.label,
      connection: input.connection,
      now,
    });
    this.setHostsAndSync(next, {
      initialConnectionByServerId: input.existingClient
        ? new Map([
            [
              input.serverId,
              {
                connectionId: input.connection.id,
                existingClient: input.existingClient,
              },
            ],
          ])
        : undefined,
    });
    void this.persistHosts();
    return next.find((daemon) => daemon.serverId === input.serverId) as HostProfile;
  }

  private setHostsAndSync(
    hosts: HostProfile[],
    options?: {
      initialConnectionByServerId?: Map<
        string,
        { connectionId: string; existingClient: DaemonClient }
      >;
    },
  ): void {
    this.hosts = hosts;
    this.syncHosts(hosts, options);
    this.emitHostList();
  }

  private async persistHosts(): Promise<void> {
    try {
      await AsyncStorage.setItem(REGISTRY_STORAGE_KEY, JSON.stringify(this.hosts));
    } catch (error) {
      console.error("[HostRuntime] Failed to persist host registry", error);
    }
  }

  private emitHostList(): void {
    this.hostListVersion += 1;
    for (const listener of this.hostListListeners) {
      listener();
    }
  }

  syncHosts(
    hosts: HostProfile[],
    options?: {
      initialConnectionByServerId?: Map<
        string,
        { connectionId: string; existingClient: DaemonClient }
      >;
    },
  ): void {
    const nextIds = new Set(hosts.map((host) => host.serverId));
    for (const [serverId, controller] of this.controllers) {
      if (nextIds.has(serverId)) {
        continue;
      }
      this.controllers.delete(serverId);
      this.lastConnectionStatusByServer.delete(serverId);
      this.agentDirectoryBootstrapInFlight.delete(serverId);
      void controller.stop();
      this.emit(serverId);
    }

    for (const host of hosts) {
      const initialConnection = options?.initialConnectionByServerId?.get(host.serverId);
      const existing = this.controllers.get(host.serverId);
      if (existing) {
        void existing.updateHost(host);
        if (initialConnection) {
          void existing.activateConnection(initialConnection).catch(() => {
            void initialConnection.existingClient.close().catch(() => undefined);
          });
        }
        continue;
      }
      const controller = new HostRuntimeController({
        host,
        deps: this.deps,
      });
      this.controllers.set(host.serverId, controller);
      this.lastConnectionStatusByServer.set(
        host.serverId,
        controller.getSnapshot().connectionStatus,
      );
      controller.subscribe(() => {
        this.maybeAutoBootstrapAgentDirectory(host.serverId);
        this.emit(host.serverId);
      });
      void controller
        .start({
          ...(initialConnection
            ? {
                initialConnection,
              }
            : {}),
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          controller.markStartupError(message);
        });
      this.emit(host.serverId);
    }
  }

  private waitForConnectionOnline(input: {
    serverId: string;
    connectionId: string;
    timeoutMs?: number;
  }): Promise<void> {
    const { serverId, connectionId } = input;
    const timeoutMs = input.timeoutMs ?? CONNECTION_ONLINE_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
      let settled = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

      const cleanup = (unsubscribe: (() => void) | null): void => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
        unsubscribe?.();
      };

      const settle = (
        unsubscribe: (() => void) | null,
        outcome: { ok: true } | { ok: false; error: Error },
      ): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup(unsubscribe);
        if (outcome.ok) {
          resolve();
        } else {
          reject(outcome.error);
        }
      };

      const readSnapshot = (): { ok: true } | { ok: false; error: Error } | null => {
        const snapshot = this.getSnapshot(serverId);
        if (!snapshot) {
          return {
            ok: false,
            error: new Error(`Unknown host runtime for serverId ${serverId}`),
          };
        }

        if (
          snapshot.activeConnectionId === connectionId &&
          snapshot.connectionStatus === "online"
        ) {
          return { ok: true };
        }

        if (snapshot.activeConnectionId === connectionId && snapshot.connectionStatus === "error") {
          return {
            ok: false,
            error: new Error(snapshot.lastError ?? "Connection failed before coming online."),
          };
        }

        return null;
      };

      const unsubscribe = this.subscribe(serverId, () => {
        const outcome = readSnapshot();
        if (outcome) {
          settle(unsubscribe, outcome);
        }
      });

      timeoutHandle = setTimeout(() => {
        settle(unsubscribe, {
          ok: false,
          error: new Error(`Timed out waiting for connection ${connectionId} to come online.`),
        });
      }, timeoutMs);

      const initialOutcome = readSnapshot();
      if (initialOutcome) {
        settle(unsubscribe, initialOutcome);
        return;
      }

      void this.runProbeCycleNow(serverId).catch((error) => {
        settle(unsubscribe, {
          ok: false,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      });
    });
  }

  private maybeAutoBootstrapAgentDirectory(serverId: string): void {
    const controller = this.controllers.get(serverId);
    if (!controller) {
      this.lastConnectionStatusByServer.delete(serverId);
      this.agentDirectoryBootstrapInFlight.delete(serverId);
      return;
    }
    const snapshot = controller.getSnapshot();
    const previousStatus = this.lastConnectionStatusByServer.get(serverId);
    this.lastConnectionStatusByServer.set(serverId, snapshot.connectionStatus);
    const didTransitionOnline =
      snapshot.connectionStatus === "online" && previousStatus !== "online";
    if (didTransitionOnline) {
      useSessionStore.getState().bumpHistorySyncGeneration(serverId);
    }

    // Runtime owns directory bootstrap policy, including reconnect and delayed
    // session initialization races.
    if (snapshot.connectionStatus !== "online") {
      return;
    }
    if (!didTransitionOnline && snapshot.hasEverLoadedAgentDirectory) {
      return;
    }
    if (this.agentDirectoryBootstrapInFlight.has(serverId)) {
      return;
    }

    const bootstrap = Promise.resolve()
      .then(() =>
        this.refreshAgentDirectory({
          serverId,
          subscribe: { subscriptionId: `app:${serverId}` },
          page: { limit: DEFAULT_AGENT_DIRECTORY_PAGE_LIMIT },
        }),
      )
      .then(() => undefined)
      .catch((error) => {
        console.error("[HostRuntime] agent directory bootstrap failed", {
          serverId,
          error: toErrorMessage(error),
        });
      })
      .finally(() => {
        const inFlight = this.agentDirectoryBootstrapInFlight.get(serverId);
        if (inFlight === bootstrap) {
          this.agentDirectoryBootstrapInFlight.delete(serverId);
        }
      });

    this.agentDirectoryBootstrapInFlight.set(serverId, bootstrap);
  }

  getSnapshot(serverId: string): HostRuntimeSnapshot | null {
    return this.controllers.get(serverId)?.getSnapshot() ?? null;
  }

  getVersion(): number {
    return this.version;
  }

  getClient(serverId: string): DaemonClient | null {
    return this.controllers.get(serverId)?.getClient() ?? null;
  }

  subscribe(serverId: string, listener: () => void): () => void {
    const existing = this.serverListeners.get(serverId) ?? new Set<() => void>();
    existing.add(listener);
    this.serverListeners.set(serverId, existing);
    return () => {
      const set = this.serverListeners.get(serverId);
      if (!set) {
        return;
      }
      set.delete(listener);
      if (set.size === 0) {
        this.serverListeners.delete(serverId);
      }
    };
  }

  subscribeAll(listener: () => void): () => void {
    this.globalListeners.add(listener);
    return () => {
      this.globalListeners.delete(listener);
    };
  }

  waitForAnyConnectionOnline(): { promise: Promise<void>; cancel: () => void } {
    let unsubscribe: (() => void) | null = null;

    const isAnyOnline = (): boolean => {
      for (const host of this.hosts) {
        const snapshot = this.getSnapshot(host.serverId);
        if (snapshot?.connectionStatus === "online") return true;
      }
      return false;
    };

    const promise = new Promise<void>((resolve) => {
      if (isAnyOnline()) {
        resolve();
        return;
      }

      unsubscribe = this.subscribeAll(() => {
        if (isAnyOnline()) {
          unsubscribe?.();
          unsubscribe = null;
          resolve();
        }
      });
    });

    return {
      promise,
      cancel: () => {
        unsubscribe?.();
        unsubscribe = null;
      },
    };
  }

  ensureConnectedAll(): void {
    for (const controller of this.controllers.values()) {
      controller.ensureConnected();
    }
  }

  runProbeCycleNow(serverId?: string): Promise<void> {
    if (serverId) {
      return this.controllers.get(serverId)?.runProbeCycleNow() ?? Promise.resolve();
    }
    return Promise.all(
      Array.from(this.controllers.values(), (controller) => controller.runProbeCycleNow()),
    ).then(() => undefined);
  }

  async refreshAgentDirectory(input: {
    serverId: string;
    filter?: FetchAgentsOptions["filter"];
    subscribe?: FetchAgentsOptions["subscribe"];
    page?: FetchAgentsOptions["page"];
  }): Promise<{
    agents: ReturnType<typeof replaceFetchedAgentDirectory>["agents"];
    subscriptionId: string | null;
  }> {
    const controller = this.controllers.get(input.serverId);
    if (!controller) {
      throw new Error(`Unknown host runtime for serverId ${input.serverId}`);
    }
    const snapshot = controller.getSnapshot();
    const client = controller.getClient();
    if (!client || snapshot.connectionStatus !== "online") {
      throw new Error(`Host ${input.serverId} is not connected`);
    }

    controller.markAgentDirectorySyncLoading();
    try {
      const pageLimit = input.page?.limit ?? DEFAULT_AGENT_DIRECTORY_PAGE_LIMIT;
      let cursor = input.page?.cursor ?? null;
      let includeSubscribe = true;
      let subscriptionId: string | null = null;
      const allEntries: FetchAgentsEntry[] = [];

      while (true) {
        const payload = await client.fetchAgents({
          scope: input.filter ? undefined : "active",
          ...(input.filter ? { filter: input.filter } : {}),
          sort: DEFAULT_AGENT_DIRECTORY_SORT,
          ...(includeSubscribe && input.subscribe ? { subscribe: input.subscribe } : {}),
          page: cursor ? { limit: pageLimit, cursor } : { limit: pageLimit },
        });

        allEntries.push(...payload.entries);

        subscriptionId = subscriptionId ?? payload.subscriptionId ?? null;
        includeSubscribe = false;

        if (!readFetchAgentsHasMore(payload.pageInfo)) {
          break;
        }

        const nextCursor = readFetchAgentsNextCursor(payload.pageInfo);
        if (!nextCursor) {
          break;
        }
        cursor = nextCursor;
      }

      const { agents } = replaceFetchedAgentDirectory({
        serverId: input.serverId,
        entries: allEntries,
      });

      controller.markAgentDirectorySyncReady();
      return {
        agents,
        subscriptionId,
      };
    } catch (error) {
      controller.markAgentDirectorySyncError(toErrorMessage(error));
      throw error;
    }
  }

  refreshAllAgentDirectories(input?: { serverIds?: string[] }): void {
    const targetServerIds = input?.serverIds ? new Set(input.serverIds) : null;
    for (const [serverId] of this.controllers) {
      if (targetServerIds && !targetServerIds.has(serverId)) {
        continue;
      }
      void this.refreshAgentDirectory({ serverId }).catch(() => undefined);
    }
  }

  markAgentDirectorySyncLoading(serverId: string): void {
    this.controllers.get(serverId)?.markAgentDirectorySyncLoading();
  }

  markAgentDirectorySyncReady(serverId: string): void {
    this.controllers.get(serverId)?.markAgentDirectorySyncReady();
  }

  markAgentDirectorySyncError(serverId: string, error: string): void {
    this.controllers.get(serverId)?.markAgentDirectorySyncError(error);
  }

  markAgentDirectorySyncIdle(serverId: string): void {
    this.controllers.get(serverId)?.markAgentDirectorySyncIdle();
  }

  private emit(serverId: string): void {
    this.version += 1;
    const listeners = this.serverListeners.get(serverId);
    if (!listeners) {
      for (const listener of this.globalListeners) {
        listener();
      }
      return;
    }
    for (const listener of listeners) {
      listener();
    }
    for (const listener of this.globalListeners) {
      listener();
    }
  }
}

let singletonHostRuntimeStore: HostRuntimeStore | null = null;
const HOST_RUNTIME_STORE_GLOBAL_KEY = "__paseoHostRuntimeStore";

type HostRuntimeGlobal = typeof globalThis & {
  [HOST_RUNTIME_STORE_GLOBAL_KEY]?: HostRuntimeStore;
};

export function getHostRuntimeStore(): HostRuntimeStore {
  if (singletonHostRuntimeStore) {
    return singletonHostRuntimeStore;
  }

  const runtimeGlobal = globalThis as HostRuntimeGlobal;
  if (runtimeGlobal[HOST_RUNTIME_STORE_GLOBAL_KEY]) {
    singletonHostRuntimeStore = runtimeGlobal[HOST_RUNTIME_STORE_GLOBAL_KEY] ?? null;
    if (singletonHostRuntimeStore) {
      return singletonHostRuntimeStore;
    }
  }

  singletonHostRuntimeStore = new HostRuntimeStore();
  runtimeGlobal[HOST_RUNTIME_STORE_GLOBAL_KEY] = singletonHostRuntimeStore;
  return singletonHostRuntimeStore;
}

export function useHostRuntimeSnapshot(serverId: string): HostRuntimeSnapshot | null {
  const store = getHostRuntimeStore();
  return useSyncExternalStore(
    (onStoreChange) => store.subscribe(serverId, onStoreChange),
    () => store.getSnapshot(serverId),
    () => store.getSnapshot(serverId),
  );
}

export function useHostRuntimeClient(serverId: string): DaemonClient | null {
  const store = getHostRuntimeStore();
  return useSyncExternalStore(
    (onStoreChange) => store.subscribe(serverId, onStoreChange),
    () => store.getSnapshot(serverId)?.client ?? null,
    () => store.getSnapshot(serverId)?.client ?? null,
  );
}

export function useHostRuntimeIsConnected(serverId: string): boolean {
  const store = getHostRuntimeStore();
  return useSyncExternalStore(
    (onStoreChange) => store.subscribe(serverId, onStoreChange),
    () => isHostRuntimeConnected(store.getSnapshot(serverId)),
    () => isHostRuntimeConnected(store.getSnapshot(serverId)),
  );
}

export function useHostRuntimeConnectionStatus(serverId: string): HostRuntimeConnectionStatus {
  const store = getHostRuntimeStore();
  return useSyncExternalStore(
    (onStoreChange) => store.subscribe(serverId, onStoreChange),
    () => store.getSnapshot(serverId)?.connectionStatus ?? "connecting",
    () => store.getSnapshot(serverId)?.connectionStatus ?? "connecting",
  );
}

export function useHostRuntimeLastError(serverId: string): string | null {
  const store = getHostRuntimeStore();
  return useSyncExternalStore(
    (onStoreChange) => store.subscribe(serverId, onStoreChange),
    () => store.getSnapshot(serverId)?.lastError ?? null,
    () => store.getSnapshot(serverId)?.lastError ?? null,
  );
}

export function useHostRuntimeAgentDirectoryStatus(
  serverId: string,
): HostRuntimeAgentDirectoryStatus {
  const store = getHostRuntimeStore();
  return useSyncExternalStore(
    (onStoreChange) => store.subscribe(serverId, onStoreChange),
    () => store.getSnapshot(serverId)?.agentDirectoryStatus ?? "idle",
    () => store.getSnapshot(serverId)?.agentDirectoryStatus ?? "idle",
  );
}

export function useHostRuntimeIsDirectoryLoading(serverId: string): boolean {
  const store = getHostRuntimeStore();
  return useSyncExternalStore(
    (onStoreChange) => store.subscribe(serverId, onStoreChange),
    () => isHostRuntimeDirectoryLoading(store.getSnapshot(serverId)),
    () => isHostRuntimeDirectoryLoading(store.getSnapshot(serverId)),
  );
}

export function useHosts(): HostProfile[] {
  const store = getHostRuntimeStore();
  return useSyncExternalStore(
    (onStoreChange) => store.subscribeHostList(onStoreChange),
    () => store.getHosts(),
    () => store.getHosts(),
  );
}

export interface HostMutations {
  upsertDirectConnection: (input: {
    serverId: string;
    endpoint: string;
    label?: string;
  }) => Promise<HostProfile>;
  upsertRelayConnection: (input: {
    serverId: string;
    relayEndpoint: string;
    daemonPublicKeyB64: string;
    label?: string;
  }) => Promise<HostProfile>;
  upsertConnectionFromOffer: (offer: ConnectionOffer, label?: string) => Promise<HostProfile>;
  upsertConnectionFromOfferUrl: (
    offerUrlOrFragment: string,
    label?: string,
  ) => Promise<HostProfile>;
  renameHost: (serverId: string, label: string) => Promise<void>;
  removeHost: (serverId: string) => Promise<void>;
  removeConnection: (serverId: string, connectionId: string) => Promise<void>;
}

export function useHostMutations(): HostMutations {
  const store = getHostRuntimeStore();
  return useMemo(
    () => ({
      upsertDirectConnection: (input) => store.upsertDirectConnection(input),
      upsertRelayConnection: (input) => store.upsertRelayConnection(input),
      upsertConnectionFromOffer: (offer, label) => store.upsertConnectionFromOffer(offer, label),
      upsertConnectionFromOfferUrl: (url, label) => store.upsertConnectionFromOfferUrl(url, label),
      renameHost: (serverId, label) => store.renameHost(serverId, label),
      removeHost: (serverId) => store.removeHost(serverId),
      removeConnection: (serverId, connectionId) => store.removeConnection(serverId, connectionId),
    }),
    [store],
  );
}
