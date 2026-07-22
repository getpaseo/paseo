import { useSyncExternalStore, useMemo } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import equal from "fast-deep-equal/es6";
import {
  DaemonClient,
  type ConnectionState,
  type FetchAgentsOptions,
} from "@getpaseo/client/internal/daemon-client";
import {
  connectionFromListen,
  normalizeStoredHostProfile,
  upsertHostConnectionInProfiles,
  registryHasConnection,
  type HostConnection,
  type HostProfile,
} from "@/types/host-connection";
import {
  buildDaemonWebSocketUrl,
  buildRelayWebSocketUrl,
  decodeOfferFragmentPayload,
  normalizeHostPort,
  shouldUseTlsForDefaultHostedRelay,
} from "@/utils/daemon-endpoints";
import { resolveAppVersion } from "@/utils/app-version";
import { ConnectionOfferSchema, type ConnectionOffer } from "@getpaseo/protocol/connection-offer";
import { shouldUseDesktopDaemon } from "@/desktop/daemon/desktop-daemon";
import { isWeb } from "@/constants/platform";
import { connectToDaemon } from "@/utils/test-daemon-connection";
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
import { getDesktopHost } from "@/desktop/host";
import { CLIENT_CAPS } from "@getpaseo/protocol/client-capabilities";
import { BROWSER_AUTOMATION_COMMAND_NAMES } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceSetupStore } from "@/stores/workspace-setup-store";
import { invalidateCheckoutGitQueriesForServer } from "@/git/query-keys";
import { queryClient } from "@/data/query-client";
import {
  invalidateServerDataQueriesAfterReconnect,
  mountServerDataPushRouter,
} from "@/data/push-router";
import { mountBrowserAutomationDaemonClientHandler } from "@/browser-automation/handler";
import { schedulesQueryBaseKey } from "@/schedules/aggregated-schedules";
import { sendQueuedComposerMessageNow } from "@/composer/actions";
import {
  resolveComposerAttachmentSubmitFormat,
  splitComposerAttachmentsForSubmit,
} from "@/composer/attachments/submit";
import { encodeImages } from "@/utils/encode-images";
import { DirectorySync, type RefreshAgentDirectoryResult } from "@/runtime/directory-sync";
import { ReplicaCache } from "@/runtime/replica-cache";

export type HostRuntimeConnectionStatus = "idle" | "connecting" | "online" | "offline" | "error";
export type HostRegistryStatus = "loading" | "ready";

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

export interface HostRuntimeSnapshot {
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
  connectionEpoch: number;
}

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

export interface HostRuntimeControllerDeps {
  createClient: (input: {
    host: HostProfile;
    connection: HostConnection;
    clientId: string;
    runtimeGeneration: number;
  }) => DaemonClient;
  connectToDaemon: (input: {
    host: HostProfile;
    connection: HostConnection;
    timeoutMs?: number;
  }) => Promise<{
    client: DaemonClient;
    serverId: string;
    hostname: string | null;
  }>;
  getClientId: () => Promise<string>;
  readInitialConnectionHint?: () => InitialDaemonConnectionHint | null;
  mountClientHandlers?: (input: {
    client: DaemonClient;
    host: HostProfile;
    connection: HostConnection;
  }) => () => void;
}

export interface HostRuntimeStorage {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
}

export interface HostRuntimeStartOptions {
  autoProbe?: boolean;
  initialConnection?: {
    connectionId: string;
    existingClient: DaemonClient;
  };
}

const PROBE_TICK_MS = 2_000;
const PROBE_STEADY_MS = 10_000;
const PROBE_MAX_BACKOFF_MS = 30_000;
const PROBE_INACTIVE_WHILE_ONLINE_MS = 120_000;
const ADAPTIVE_SWITCH_THRESHOLD_MS = 40;
const ADAPTIVE_SWITCH_CONSECUTIVE_PROBES = 3;
const DEFAULT_AGENT_DIRECTORY_PAGE_LIMIT = 200;
const CONFIGURED_OVERRIDE_BOOTSTRAP_RETRY_MS = 1_000;

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

function extractPreviousConnectionRef(state: HostRuntimeConnectionMachineState): {
  id: string | null;
  connection: ActiveConnection | null;
} {
  if (
    state.tag === "connecting" ||
    state.tag === "online" ||
    state.tag === "offline" ||
    state.tag === "error"
  ) {
    return { id: state.activeConnectionId, connection: state.activeConnection };
  }
  return { id: null, connection: null };
}

function buildConnectionStateFromStatus(
  previousActiveConnectionId: string,
  previousActiveConnection: ActiveConnection,
  event: Extract<HostRuntimeConnectionMachineEvent, { type: "client_state" }>,
): HostRuntimeConnectionMachineState | null {
  const status = event.state.status;
  if (status === "connected") {
    return {
      tag: "online",
      activeConnectionId: previousActiveConnectionId,
      activeConnection: previousActiveConnection,
      lastOnlineAt: new Date().toISOString(),
    };
  }
  if (status === "connecting" || status === "idle") {
    return {
      tag: "connecting",
      activeConnectionId: previousActiveConnectionId,
      activeConnection: previousActiveConnection,
    };
  }
  if (status === "disposed") {
    return {
      tag: "offline",
      activeConnectionId: previousActiveConnectionId,
      activeConnection: previousActiveConnection,
    };
  }
  return null;
}

function resolveConnectionStateResult(
  previousActiveConnectionId: string,
  previousActiveConnection: ActiveConnection,
  event: Extract<HostRuntimeConnectionMachineEvent, { type: "client_state" }>,
): HostRuntimeConnectionMachineState {
  const statusResult = buildConnectionStateFromStatus(
    previousActiveConnectionId,
    previousActiveConnection,
    event,
  );
  if (statusResult) return statusResult;

  const disconnectedReason =
    event.state.status === "disconnected" ? (event.state.reason ?? null) : null;
  const reason = disconnectedReason ?? event.lastError ?? null;
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
    const failed = extractPreviousConnectionRef(state);
    return {
      tag: "error",
      activeConnectionId: failed.id,
      activeConnection: failed.connection,
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

  const previous = extractPreviousConnectionRef(state);
  if (!previous.id || !previous.connection) {
    return state.tag === "booting"
      ? state
      : {
          tag: "offline",
          activeConnectionId: null,
          activeConnection: null,
        };
  }

  return resolveConnectionStateResult(previous.id, previous.connection, event);
}

function toSnapshotConnectionPatch(
  state: HostRuntimeConnectionMachineState,
  connectionEpoch: number,
): Pick<
  HostRuntimeSnapshot,
  | "activeConnectionId"
  | "activeConnection"
  | "connectionStatus"
  | "lastError"
  | "lastOnlineAt"
  | "connectionEpoch"
> {
  if (state.tag === "booting") {
    return {
      activeConnectionId: null,
      activeConnection: null,
      connectionStatus: "connecting",
      lastError: null,
      lastOnlineAt: null,
      connectionEpoch,
    };
  }
  if (state.tag === "connecting") {
    return {
      activeConnectionId: state.activeConnectionId,
      activeConnection: state.activeConnection,
      connectionStatus: "connecting",
      lastError: null,
      lastOnlineAt: null,
      connectionEpoch,
    };
  }
  if (state.tag === "online") {
    return {
      activeConnectionId: state.activeConnectionId,
      activeConnection: state.activeConnection,
      connectionStatus: "online",
      lastError: null,
      lastOnlineAt: state.lastOnlineAt,
      connectionEpoch,
    };
  }
  if (state.tag === "offline") {
    return {
      activeConnectionId: state.activeConnectionId,
      activeConnection: state.activeConnection,
      connectionStatus: "offline",
      lastError: null,
      lastOnlineAt: null,
      connectionEpoch,
    };
  }
  return {
    activeConnectionId: state.activeConnectionId,
    activeConnection: state.activeConnection,
    connectionStatus: "error",
    lastError: state.message,
    lastOnlineAt: null,
    connectionEpoch,
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
  hasActiveOnlineConnection: boolean,
  now: number,
): number {
  if (isActiveOnline) {
    return PROBE_STEADY_MS;
  }
  if (hasActiveOnlineConnection) {
    return PROBE_INACTIVE_WHILE_ONLINE_MS;
  }
  const age = now - firstSeenAt;
  if (age < 10_000) return 2_000;
  if (age < 30_000) return 5_000;
  if (age < 60_000) return PROBE_STEADY_MS;
  return PROBE_MAX_BACKOFF_MS;
}

function createDefaultDeps(): HostRuntimeControllerDeps {
  const browserHostAvailable =
    typeof getDesktopHost()?.browser?.executeAutomationCommand === "function";
  const browserAutomationCapabilities = browserHostAvailable
    ? {
        [CLIENT_CAPS.browserHost]: {
          supportedCommands: [...BROWSER_AUTOMATION_COMMAND_NAMES],
          hostKind: "desktop app",
        },
      }
    : undefined;
  const appCapabilities = {
    [CLIENT_CAPS.selectiveAgentTimeline]: true,
    ...browserAutomationCapabilities,
  };

  return {
    createClient: ({ host, connection, clientId, runtimeGeneration }) => {
      const localTransportFactory = createDesktopLocalDaemonTransportFactory();
      const base = {
        suppressSendErrors: true,
        clientId,
        clientType: "mobile" as const,
        appVersion: resolveAppVersion() ?? undefined,
        runtimeGeneration,
        capabilities: appCapabilities,
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
          url: buildDaemonWebSocketUrl(connection.endpoint, {
            useTls: connection.useTls ?? false,
          }),
          ...(connection.password ? { password: connection.password } : {}),
        });
      }
      return new DaemonClient({
        ...base,
        url: buildRelayWebSocketUrl({
          endpoint: connection.relayEndpoint,
          useTls: connection.useTls ?? shouldUseTlsForDefaultHostedRelay(connection.relayEndpoint),
          serverId: host.serverId,
        }),
        e2ee: {
          enabled: true,
          daemonPublicKeyB64: connection.daemonPublicKeyB64,
        },
      });
    },
    connectToDaemon: ({ host, connection, timeoutMs }) =>
      connectToDaemon(connection, {
        ...(host.serverId ? { serverId: host.serverId } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        capabilities: appCapabilities,
      }),
    getClientId: () => getOrCreateClientId(),
    mountClientHandlers: ({ client, host }) => {
      const unmountServerData = mountServerDataPushRouter({
        client,
        queryClient,
        serverId: host.serverId,
      });
      if (!browserAutomationCapabilities) {
        return unmountServerData;
      }
      const unmountBrowserAutomation = mountBrowserAutomationDaemonClientHandler(client, {
        serverId: host.serverId,
      });
      return () => {
        unmountBrowserAutomation();
        unmountServerData();
      };
    },
  };
}

export class HostRuntimeController {
  private host: HostProfile;
  private deps: HostRuntimeControllerDeps;
  private onReconcileServerId: ((oldId: string, newId: string) => void) | null;
  private connectionMachineState: HostRuntimeConnectionMachineState;
  private connectionEpoch = 0;
  private snapshot: HostRuntimeSnapshot;
  private listeners = new Set<() => void>();
  private activeClient: DaemonClient | null = null;
  private unsubscribeClientStatus: (() => void) | null = null;
  private unsubscribeClientHandlers: (() => void) | null = null;
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
    onReconcileServerId?: (oldId: string, newId: string) => void;
  }) {
    this.host = input.host;
    this.deps = input.deps ?? createDefaultDeps();
    this.onReconcileServerId = input.onReconcileServerId ?? null;
    this.connectionMachineState = {
      tag: "booting",
    };
    this.snapshot = {
      serverId: this.host.serverId,
      ...toSnapshotConnectionPatch(this.connectionMachineState, this.connectionEpoch),
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
    if (this.unsubscribeClientHandlers) {
      this.unsubscribeClientHandlers();
      this.unsubscribeClientHandlers = null;
    }
    if (this.activeClient) {
      const prev = this.activeClient;
      this.activeClient = null;
      await prev.close().catch(() => undefined);
    }
    this.applyConnectionEvent({ type: "stopped" });
    this.updateSnapshot({
      ...toSnapshotConnectionPatch(this.connectionMachineState, this.connectionEpoch),
      client: null,
    });
  }

  async updateHost(host: HostProfile): Promise<void> {
    const activeConnectionId = this.snapshot.activeConnectionId;
    const previousActiveConnection = findConnectionById(this.host, activeConnectionId);
    this.host = host;
    this.trackConnectionFirstSeen();
    const nextActiveConnection = findConnectionById(this.host, activeConnectionId);
    if (
      activeConnectionId &&
      previousActiveConnection &&
      nextActiveConnection &&
      !equal(previousActiveConnection, nextActiveConnection)
    ) {
      this.connectionLastProbedAt.delete(activeConnectionId);
      await this.switchToConnection({ connectionId: activeConnectionId });
    }
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
      ...toSnapshotConnectionPatch(this.connectionMachineState, this.connectionEpoch),
    });
  }

  async activateConnection(input: {
    connectionId: string;
    existingClient?: DaemonClient;
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
        ...toSnapshotConnectionPatch(this.connectionMachineState, this.connectionEpoch),
        probeByConnectionId: new Map(),
      });
      return;
    }

    const now = performance.now();
    const isOnline = this.snapshot.connectionStatus === "online";
    const activeConnectionId = this.snapshot.activeConnectionId;
    const hasActiveOnlineConnection = isOnline && activeConnectionId !== null;

    const connectionsToProbe = this.host.connections.filter((connection) => {
      const lastProbed = this.connectionLastProbedAt.get(connection.id);
      if (lastProbed == null) {
        return true;
      }
      const firstSeen = this.connectionFirstSeenAt.get(connection.id) ?? now;
      const isActiveOnline = isOnline && connection.id === activeConnectionId;
      const interval = probeIntervalForConnection(
        firstSeen,
        isActiveOnline,
        hasActiveOnlineConnection,
        now,
      );
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
                if (isPlaceholderServerId(this.host.serverId) && this.onReconcileServerId) {
                  this.onReconcileServerId(this.host.serverId, serverId);
                } else {
                  await client.close().catch(() => undefined);
                  throw new Error(
                    `Connection resolved to ${serverId}, expected ${this.host.serverId}.`,
                  );
                }
              }
              connectedClient = client;
              shouldCloseClient = true;
            }

            if (!this.isCurrentProbeRequest(requestVersion)) {
              return;
            }

            const activated = await maybeActivateFirstAvailable(connection.id, connectedClient);
            shouldCloseClient = shouldCloseClient && !activated;

            if (activeClient) {
              const rttMs = activeClient.getLastLivenessRttMs();
              if (!this.isCurrentProbeRequest(requestVersion)) {
                return;
              }
              if (rttMs !== null) {
                probeByConnectionId.set(connection.id, {
                  status: "available",
                  latencyMs: rttMs,
                });
                publishProbeState();
              }
              return;
            }

            const rttMs = await connectedClient.measureLatency({ timeoutMs: 5000 });
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
    for (const key of Object.keys(patch) as (keyof HostRuntimeSnapshotPatch)[]) {
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
    if (previousState.tag !== "online" && nextState.tag === "online") {
      this.connectionEpoch += 1;
    }
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

  private async abortSwitchWithClient(client: DaemonClient | undefined): Promise<void> {
    if (client) {
      await client.close().catch(() => undefined);
    }
  }

  private isSwitchStillValid(requestVersion: number, expectedProbeVersion?: number): boolean {
    return (
      this.isCurrentSwitchRequest(requestVersion) && this.canProceedForProbe(expectedProbeVersion)
    );
  }

  private async resolveClientIdForSwitch(args: {
    existingClient: DaemonClient | undefined;
    requestVersion: number;
  }): Promise<string | null> {
    try {
      return await this.resolveClientId();
    } catch (error) {
      await this.abortSwitchWithClient(args.existingClient);
      if (!this.isCurrentSwitchRequest(args.requestVersion)) {
        return null;
      }
      const message = toErrorMessage(error);
      this.applyConnectionEvent({
        type: "connect_failed",
        message: `Failed to resolve client id: ${message}`,
      });
      this.updateSnapshot({
        ...toSnapshotConnectionPatch(this.connectionMachineState, this.connectionEpoch),
      });
      return null;
    }
  }

  private async disposePreviousActiveClient(): Promise<void> {
    if (this.unsubscribeClientStatus) {
      this.unsubscribeClientStatus();
      this.unsubscribeClientStatus = null;
    }
    if (this.unsubscribeClientHandlers) {
      this.unsubscribeClientHandlers();
      this.unsubscribeClientHandlers = null;
    }
    if (this.activeClient) {
      const previousClient = this.activeClient;
      this.activeClient = null;
      await previousClient.close().catch(() => undefined);
    }
  }

  private buildAgentDirectoryStatusPatch(): Partial<HostRuntimeSnapshotPatch> {
    if (this.snapshot.hasEverLoadedAgentDirectory) return {};
    const tag = this.connectionMachineState.tag;
    if (tag === "connecting" || tag === "online") {
      return { agentDirectoryStatus: "initial_loading", agentDirectoryError: null };
    }
    if (tag === "error") {
      return {
        agentDirectoryStatus: "error_before_first_success",
        agentDirectoryError: this.connectionMachineState.message,
      };
    }
    return { agentDirectoryStatus: "idle", agentDirectoryError: null };
  }

  private async switchToConnection(input: {
    connectionId: string;
    expectedProbeVersion?: number;
    existingClient?: DaemonClient;
  }): Promise<void> {
    const { connectionId, expectedProbeVersion, existingClient } = input;
    if (!this.canProceedForProbe(expectedProbeVersion)) {
      await this.abortSwitchWithClient(existingClient);
      return;
    }
    const connection = findConnectionById(this.host, connectionId);
    if (!connection) {
      await this.abortSwitchWithClient(existingClient);
      return;
    }
    const requestVersion = ++this.switchRequestVersion;

    const clientId = await this.resolveClientIdForSwitch({ existingClient, requestVersion });
    if (clientId === null) return;

    if (!this.isSwitchStillValid(requestVersion, expectedProbeVersion)) {
      await this.abortSwitchWithClient(existingClient);
      return;
    }

    await this.disposePreviousActiveClient();

    if (!this.isSwitchStillValid(requestVersion, expectedProbeVersion)) {
      await this.abortSwitchWithClient(existingClient);
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

    if (!this.isSwitchStillValid(requestVersion, expectedProbeVersion)) {
      await client.close().catch(() => undefined);
      return;
    }

    this.activeClient = client;
    this.unsubscribeClientHandlers =
      this.deps.mountClientHandlers?.({ client, host: this.host, connection }) ?? null;
    this.applyConnectionEvent({
      type: "select_connection",
      connectionId: connection.id,
      connection: toActiveConnection(connection),
    });
    this.snapshot = {
      ...this.snapshot,
      serverId: this.host.serverId,
      ...toSnapshotConnectionPatch(this.connectionMachineState, this.connectionEpoch),
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
        ...toSnapshotConnectionPatch(this.connectionMachineState, this.connectionEpoch),
        ...this.buildAgentDirectoryStatusPatch(),
      };
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
        ...toSnapshotConnectionPatch(this.connectionMachineState, this.connectionEpoch),
      });
    }
  }

  adoptReconciledServerId(newServerId: string): void {
    this.host = { ...this.host, serverId: newServerId };
    this.snapshot = { ...this.snapshot, serverId: newServerId };
    for (const listener of this.listeners) {
      listener();
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
const LOCALHOST_FALLBACK_ENDPOINT = "localhost:6767";
const DEFAULT_LOCALHOST_BOOTSTRAP_TIMEOUT_MS = 2500;
const E2E_STORAGE_KEY = "@paseo:e2e";
const INITIAL_DAEMON_CONNECTION_HINT_GLOBAL_KEY = "__PASEO_INITIAL_DAEMON_CONNECTION__";

export interface InitialDaemonConnectionHint {
  listen: string;
  useTls?: boolean;
}

function isInitialConnectionHintRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function readInitialDaemonConnectionHint(input?: {
  isWebRuntime?: boolean;
}): InitialDaemonConnectionHint | null {
  const isWebRuntime = input?.isWebRuntime ?? isWeb;
  if (!isWebRuntime || typeof globalThis === "undefined") {
    return null;
  }
  const value = (globalThis as Record<string, unknown>)[INITIAL_DAEMON_CONNECTION_HINT_GLOBAL_KEY];
  if (!isInitialConnectionHintRecord(value)) {
    return null;
  }
  const listen = typeof value.listen === "string" ? value.listen.trim() : "";
  if (!listen) {
    return null;
  }
  return {
    listen,
    useTls: value.useTls === true,
  };
}

function readConfiguredLocalDaemonOverride(): string | null {
  const value = process.env.EXPO_PUBLIC_LOCAL_DAEMON?.trim();
  return value && value.length > 0 ? value : null;
}

export function hasConfiguredLocalDaemonOverride(): boolean {
  return readConfiguredLocalDaemonOverride() !== null;
}

function isPlaceholderServerId(serverId: string): boolean {
  return serverId.startsWith("local:");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rekeyMap<V>(map: Map<string, V>, oldKey: string, newKey: string): void {
  const value = map.get(oldKey);
  if (value === undefined) {
    return;
  }
  map.delete(oldKey);
  map.set(newKey, value);
}

interface AgentDirectoryRefreshInput {
  serverId: string;
  filter?: FetchAgentsOptions["filter"];
  subscribe?: FetchAgentsOptions["subscribe"];
  page?: FetchAgentsOptions["page"];
}

export class HostRuntimeStore {
  private controllers = new Map<string, HostRuntimeController>();
  private serverListeners = new Map<string, Set<() => void>>();
  private globalListeners = new Set<() => void>();
  private hostListListeners = new Set<() => void>();
  private version = 0;
  private hostListVersion = 0;
  private hostRegistryLoaded = false;
  private hosts: HostProfile[] = [];
  private hostRegistryStatus: HostRegistryStatus = "loading";
  private deps: HostRuntimeControllerDeps;
  private lastConnectionStatusByServer = new Map<string, HostRuntimeConnectionStatus>();
  private directoryBootstrapInFlight = new Map<string, Promise<void>>();
  private queuedAgentDrainInFlight = new Set<string>();
  private directorySyncByServer = new Map<string, DirectorySync>();
  private configuredOverrideBootstrapInFlight: Promise<void> | null = null;
  private bootStarted = false;
  private storage: HostRuntimeStorage;
  private replicaCache: ReplicaCache;

  constructor(input?: { deps?: HostRuntimeControllerDeps; storage?: HostRuntimeStorage }) {
    this.deps = input?.deps ?? createDefaultDeps();
    this.storage = input?.storage ?? AsyncStorage;
    this.replicaCache = new ReplicaCache(this.storage);
  }

  // --- Host registry ---

  getHosts(): HostProfile[] {
    return this.hosts;
  }

  getHostRegistryStatus(): HostRegistryStatus {
    return this.hostRegistryStatus;
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

  isHostRegistryLoaded(): boolean {
    return this.hostRegistryLoaded;
  }

  boot(): void {
    if (this.bootStarted) {
      return;
    }
    this.bootStarted = true;
    void this.runBoot();
  }

  private async runBoot(): Promise<void> {
    const override = readConfiguredLocalDaemonOverride();
    await this.loadFromStorage();
    this.markHostRegistryLoaded();

    let isE2E: string | null = null;
    try {
      isE2E = await this.storage.getItem(E2E_STORAGE_KEY);
    } catch {
      return;
    }
    if (isE2E) {
      return;
    }

    if (shouldUseDesktopDaemon()) {
      return;
    }

    const initialHint = this.deps.readInitialConnectionHint
      ? this.deps.readInitialConnectionHint()
      : readInitialDaemonConnectionHint();
    if (initialHint) {
      const bootstrapped = await this.bootstrapInitialConnectionHint(initialHint);
      if (bootstrapped) {
        return;
      }
    }

    if (override) {
      this.bootstrapConfiguredOverride(override);
    } else {
      await this.bootstrapDefaultLocalhost();
    }
  }

  private async loadFromStorage(): Promise<void> {
    let shouldPersistHosts = false;
    let profiles: HostProfile[] = [];
    try {
      const stored = await this.storage.getItem(REGISTRY_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as unknown;
        if (Array.isArray(parsed)) {
          const normalizedProfiles = parsed
            .map((entry) => normalizeStoredHostProfile(entry))
            .filter((entry): entry is HostProfile => entry !== null);
          profiles = normalizedProfiles.filter((entry) => !isPlaceholderServerId(entry.serverId));
          if (profiles.length !== normalizedProfiles.length) {
            shouldPersistHosts = true;
          }
        }
      }
      this.hosts = profiles;
      this.replicaCache.setHosts(profiles.map((profile) => profile.serverId));
      await this.replicaCache.restore();
      this.syncHosts(profiles);
    } catch (error) {
      console.error("[HostRuntime] Failed to load host registry from storage", error);
    } finally {
      this.replicaCache.start();
      this.hostRegistryStatus = "ready";
      this.emitHostList();
      if (shouldPersistHosts) {
        void this.persistHosts();
      }
    }
  }

  private markHostRegistryLoaded(): void {
    if (this.hostRegistryLoaded) {
      return;
    }
    this.hostRegistryLoaded = true;
    this.emitHostList();
  }

  private async bootstrapDefaultLocalhost(): Promise<void> {
    const connection = connectionFromListen(LOCALHOST_FALLBACK_ENDPOINT);
    if (!connection || registryHasConnection(this.hosts, connection)) {
      return;
    }

    try {
      await this.probeAndUpsertConnection({
        connection,
        timeoutMs: DEFAULT_LOCALHOST_BOOTSTRAP_TIMEOUT_MS,
      });
    } catch (error) {
      console.warn("[HostRuntime] bootstrap probe failed", {
        endpoint: LOCALHOST_FALLBACK_ENDPOINT,
        error,
      });
    }
  }

  private bootstrapConfiguredOverride(endpoint: string): void {
    const connection = connectionFromListen(endpoint);
    if (!connection) {
      return;
    }
    if (registryHasConnection(this.hosts, connection)) {
      return;
    }
    if (this.configuredOverrideBootstrapInFlight) {
      return;
    }

    const bootstrap = this.runConfiguredOverrideBootstrap(endpoint, connection).finally(() => {
      if (this.configuredOverrideBootstrapInFlight === bootstrap) {
        this.configuredOverrideBootstrapInFlight = null;
      }
    });
    this.configuredOverrideBootstrapInFlight = bootstrap;
  }

  private async runConfiguredOverrideBootstrap(
    endpoint: string,
    connection: HostConnection,
  ): Promise<void> {
    let attempt = 0;
    while (!registryHasConnection(this.hosts, connection)) {
      attempt += 1;
      try {
        await this.probeAndUpsertConnection({
          connection,
          timeoutMs: DEFAULT_LOCALHOST_BOOTSTRAP_TIMEOUT_MS,
        });
        return;
      } catch (error) {
        if (attempt === 1 || attempt % 10 === 0) {
          console.warn("[HostRuntime] configured bootstrap probe failed", {
            endpoint,
            attempt,
            error,
          });
        }
        await delay(CONFIGURED_OVERRIDE_BOOTSTRAP_RETRY_MS);
      }
    }
  }

  private async bootstrapInitialConnectionHint(
    hint: InitialDaemonConnectionHint,
  ): Promise<boolean> {
    const connection = connectionFromListen(hint.listen);
    if (!connection) {
      return false;
    }
    const connectionWithHint: HostConnection =
      connection.type === "directTcp"
        ? { ...connection, useTls: hint.useTls ?? connection.useTls ?? false }
        : connection;
    if (registryHasConnection(this.hosts, connectionWithHint)) {
      return true;
    }

    try {
      await this.probeAndUpsertConnection({
        connection: connectionWithHint,
        timeoutMs: DEFAULT_LOCALHOST_BOOTSTRAP_TIMEOUT_MS,
      });
      return true;
    } catch (error) {
      console.warn("[HostRuntime] initial connection hint probe failed", {
        listen: hint.listen,
        useTls: hint.useTls,
        error,
      });
      return false;
    }
  }

  reconcileServerId(oldServerId: string, newServerId: string): void {
    if (oldServerId === newServerId) {
      return;
    }
    const controller = this.controllers.get(oldServerId);
    if (!controller) {
      return;
    }
    if (this.controllers.has(newServerId)) {
      return;
    }

    rekeyMap(this.controllers, oldServerId, newServerId);
    rekeyMap(this.lastConnectionStatusByServer, oldServerId, newServerId);
    rekeyMap(this.directoryBootstrapInFlight, oldServerId, newServerId);
    this.replicaCache.reconcileServerId(oldServerId, newServerId);
    this.directorySyncByServer.get(oldServerId)?.dispose();
    this.directorySyncByServer.delete(oldServerId);
    const directory = new DirectorySync(newServerId, {
      drainQueuedAgentMessage: (agentId) => this.drainQueuedAgentMessage(newServerId, agentId),
      markAgentLoading: () => controller.markAgentDirectorySyncLoading(),
      markAgentReady: () => controller.markAgentDirectorySyncReady(),
      markAgentError: (error) => controller.markAgentDirectorySyncError(error),
    });
    this.directorySyncByServer.set(newServerId, directory);
    controller.adoptReconciledServerId(newServerId);
    const snapshot = controller.getSnapshot();
    this.clearHostReplica(oldServerId);
    this.syncSessionReplica(newServerId, snapshot);
    directory.connectionChanged({
      client: snapshot.client,
      status: snapshot.connectionStatus === "online" ? "online" : "offline",
      source: {
        clientGeneration: snapshot.clientGeneration,
        connectionEpoch: snapshot.connectionEpoch,
      },
    });

    const listeners = this.serverListeners.get(oldServerId);
    if (listeners) {
      this.serverListeners.delete(oldServerId);
      const merged = this.serverListeners.get(newServerId) ?? new Set<() => void>();
      for (const listener of listeners) {
        merged.add(listener);
      }
      this.serverListeners.set(newServerId, merged);
    }

    this.hosts = this.hosts.map((host) =>
      host.serverId === oldServerId
        ? { ...host, serverId: newServerId, updatedAt: new Date().toISOString() }
        : host,
    );
    this.emitHostList();
    this.emit(newServerId);
    void this.persistHosts();
  }

  async upsertDirectConnection(input: {
    serverId: string;
    endpoint: string;
    useTls?: boolean;
    password?: string;
    label?: string;
    existingClient?: DaemonClient;
  }): Promise<HostProfile> {
    const endpoint = normalizeHostPort(input.endpoint);
    const password = input.password?.trim();
    return this.upsertHostConnection({
      serverId: input.serverId,
      label: input.label,
      connection: {
        id: `direct:${endpoint}`,
        type: "directTcp",
        endpoint,
        useTls: input.useTls ?? false,
        ...(password ? { password } : {}),
      },
      existingClient: input.existingClient,
    });
  }

  async probeAndUpsertConnection(input: {
    connection: HostConnection;
    label?: string;
    timeoutMs?: number;
  }): Promise<{ profile: HostProfile; serverId: string; hostname: string | null }> {
    if (input.connection.type === "relay") {
      throw new Error("Cannot probe a relay connection without a server id.");
    }
    const probeHost: HostProfile = {
      serverId: "",
      label: input.label ?? input.connection.id,
      lifecycle: {},
      connections: [input.connection],
      preferredConnectionId: input.connection.id,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    const { client, serverId, hostname } = await this.deps.connectToDaemon({
      host: probeHost,
      connection: input.connection,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    });
    const profile = await this.upsertHostConnection({
      serverId,
      label: input.label ?? hostname ?? undefined,
      connection: input.connection,
      existingClient: client,
    });
    return { profile, serverId, hostname };
  }

  async probeAndUpsertDirectConnection(input: {
    endpoint: string;
    useTls?: boolean;
    password?: string;
    label?: string;
  }): Promise<{ profile: HostProfile; serverId: string; hostname: string | null }> {
    const endpoint = normalizeHostPort(input.endpoint);
    const password = input.password?.trim();
    return this.probeAndUpsertConnection({
      label: input.label,
      connection: {
        id: `direct:${endpoint}`,
        type: "directTcp",
        endpoint,
        useTls: input.useTls ?? false,
        ...(password ? { password } : {}),
      },
    });
  }

  async upsertRelayConnection(input: {
    serverId: string;
    relayEndpoint: string;
    useTls?: boolean;
    daemonPublicKeyB64: string;
    label?: string;
  }): Promise<HostProfile> {
    const relayEndpoint = normalizeHostPort(input.relayEndpoint);
    const useTls = input.useTls ?? false;
    const daemonPublicKeyB64 = input.daemonPublicKeyB64.trim();
    if (!daemonPublicKeyB64) {
      throw new Error("daemonPublicKeyB64 is required");
    }
    const explicitUseTls = input.useTls !== undefined;
    return this.upsertHostConnection({
      serverId: input.serverId,
      label: input.label,
      connection: {
        id: useTls ? `relay:wss:${relayEndpoint}` : `relay:${relayEndpoint}`,
        type: "relay",
        relayEndpoint,
        ...(explicitUseTls ? { useTls } : {}),
        daemonPublicKeyB64,
      },
    });
  }

  async upsertConnectionFromOffer(offer: ConnectionOffer, label?: string): Promise<HostProfile> {
    // COMPAT(oldRelayOfferTls): added in v0.1.73, remove after 2026-11-10.
    const useTls = offer.relay.useTls ?? shouldUseTlsForDefaultHostedRelay(offer.relay.endpoint);
    return this.upsertRelayConnection({
      serverId: offer.serverId,
      relayEndpoint: offer.relay.endpoint,
      useTls,
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

  async upsertConnectionFromListen(input: {
    listenAddress: string;
    serverId: string;
    hostname: string | null;
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
    return this.upsertHostConnection({
      serverId,
      label: input.hostname ?? undefined,
      connection,
    });
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
      await this.storage.setItem(REGISTRY_STORAGE_KEY, JSON.stringify(this.hosts));
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
    this.replicaCache.setHosts(hosts.map((host) => host.serverId));
    const nextIds = new Set(hosts.map((host) => host.serverId));
    for (const [serverId, controller] of this.controllers) {
      if (nextIds.has(serverId)) {
        continue;
      }
      this.controllers.delete(serverId);
      this.lastConnectionStatusByServer.delete(serverId);
      this.directoryBootstrapInFlight.delete(serverId);
      this.directorySyncByServer.get(serverId)?.dispose();
      this.directorySyncByServer.delete(serverId);
      this.clearHostReplica(serverId);
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
        onReconcileServerId: (oldId, newId) => this.reconcileServerId(oldId, newId),
      });
      this.controllers.set(host.serverId, controller);
      this.directorySyncByServer.set(
        host.serverId,
        new DirectorySync(host.serverId, {
          drainQueuedAgentMessage: (agentId) =>
            this.drainQueuedAgentMessage(host.serverId, agentId),
          markAgentLoading: () => controller.markAgentDirectorySyncLoading(),
          markAgentReady: () => controller.markAgentDirectorySyncReady(),
          markAgentError: (error) => controller.markAgentDirectorySyncError(error),
        }),
      );
      this.lastConnectionStatusByServer.set(
        host.serverId,
        controller.getSnapshot().connectionStatus,
      );
      controller.subscribe(() => {
        const snapshot = controller.getSnapshot();
        this.syncSessionReplica(snapshot.serverId, snapshot);
        this.maybeAutoBootstrapDirectories(snapshot.serverId);
        this.emit(snapshot.serverId);
      });
      void controller
        .start(
          initialConnection
            ? {
                initialConnection,
              }
            : {},
        )
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          controller.markStartupError(message);
        });
      this.emit(host.serverId);
    }
  }

  private syncSessionReplica(serverId: string, snapshot: HostRuntimeSnapshot): void {
    if (!snapshot.client) {
      return;
    }
    const sessionStore = useSessionStore.getState();
    sessionStore.initializeSession(serverId, snapshot.client, snapshot.clientGeneration);
    sessionStore.updateSessionClient(serverId, snapshot.client, snapshot.clientGeneration);
  }

  private clearHostReplica(serverId: string): void {
    useSessionStore.getState().clearSession(serverId);
    useWorkspaceSetupStore.getState().clearServer(serverId);
  }

  private maybeAutoBootstrapDirectories(serverId: string): void {
    const controller = this.controllers.get(serverId);
    if (!controller) {
      this.lastConnectionStatusByServer.delete(serverId);
      this.directoryBootstrapInFlight.delete(serverId);
      return;
    }
    const snapshot = controller.getSnapshot();
    const directorySourceChanged =
      this.directorySyncByServer.get(serverId)?.connectionChanged({
        client: snapshot.client,
        status: snapshot.connectionStatus === "online" ? "online" : "offline",
        source: {
          clientGeneration: snapshot.clientGeneration,
          connectionEpoch: snapshot.connectionEpoch,
        },
      }) ?? false;
    const previousStatus = this.lastConnectionStatusByServer.get(serverId);
    this.lastConnectionStatusByServer.set(serverId, snapshot.connectionStatus);
    const didTransitionOnline =
      snapshot.connectionStatus === "online" && previousStatus !== "online";
    if (didTransitionOnline) {
      useSessionStore.getState().bumpHistorySyncGeneration(serverId);
      // Checkout git data is push-driven; pushes emitted while disconnected are gone for
      // good (the daemon dedupes by snapshot fingerprint). Mark the caches stale so active
      // queries refetch now and evicted ones on their next mount.
      void invalidateCheckoutGitQueriesForServer(queryClient, serverId);
      invalidateServerDataQueriesAfterReconnect({ queryClient, serverId });
      void queryClient.invalidateQueries({ queryKey: schedulesQueryBaseKey });
    }

    // Runtime owns directory bootstrap policy, including reconnect and delayed
    // session initialization races.
    if (snapshot.connectionStatus !== "online") {
      return;
    }
    if (!didTransitionOnline && snapshot.hasEverLoadedAgentDirectory) {
      return;
    }
    if (this.directoryBootstrapInFlight.has(serverId) && !directorySourceChanged) {
      return;
    }

    const bootstrap = Promise.resolve()
      .then(() =>
        Promise.all([
          this.refreshAgentDirectory({
            serverId,
            subscribe: { subscriptionId: `app:${serverId}` },
            page: { limit: DEFAULT_AGENT_DIRECTORY_PAGE_LIMIT },
          }).catch((error) => {
            console.error("[HostRuntime] agent directory bootstrap failed", {
              serverId,
              error: toErrorMessage(error),
            });
          }),
          this.refreshWorkspaceDirectory({ serverId, subscribe: true }).catch((error) => {
            console.error("[HostRuntime] workspace directory bootstrap failed", {
              serverId,
              error: toErrorMessage(error),
            });
          }),
        ]).then(() => undefined),
      )
      .finally(() => {
        const inFlight = this.directoryBootstrapInFlight.get(serverId);
        if (inFlight === bootstrap) {
          this.directoryBootstrapInFlight.delete(serverId);
        }
      });

    this.directoryBootstrapInFlight.set(serverId, bootstrap);
  }

  drainQueuedAgentMessage(serverId: string, agentId: string): void {
    const drainKey = `${serverId}:${agentId}`;
    if (this.queuedAgentDrainInFlight.has(drainKey)) return;
    const store = useSessionStore.getState();
    const session = store.sessions[serverId];
    const queue = session?.queuedMessages.get(agentId);
    const client = session?.client;
    if (!client || !queue?.length || session.initializingAgents.get(agentId) === true) {
      return;
    }
    this.queuedAgentDrainInFlight.add(drainKey);
    const next = queue[0];
    void sendQueuedComposerMessageNow({
      agentId,
      messageId: next.id,
      queue: {
        read: (queuedAgentId) =>
          useSessionStore.getState().sessions[serverId]?.queuedMessages.get(queuedAgentId) ?? [],
        write: (update) => useSessionStore.getState().setQueuedMessages(serverId, update),
      },
      submitMessage: async ({ text, attachments }) => {
        const supportsForgeAttachments =
          useSessionStore.getState().sessions[serverId]?.serverInfo?.features?.forgeSearch === true;
        const wirePayload = splitComposerAttachmentsForSubmit(attachments, {
          format: resolveComposerAttachmentSubmitFormat({ supportsForgeAttachments }),
        });
        const images = await encodeImages(wirePayload.images);
        await client.sendAgentMessage(agentId, text, {
          messageId: next.id,
          ...(images && images.length > 0 ? { images } : {}),
          attachments: wirePayload.attachments,
        });
      },
    })
      .then((result) => {
        if (result.status === "failed") {
          console.error("[HostRuntime] failed to drain queued agent message", {
            serverId,
            agentId,
            error: result.errorMessage,
          });
        }
        return result;
      })
      .finally(() => {
        this.queuedAgentDrainInFlight.delete(drainKey);
      });
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

  getEarliestOnlineHostServerId(): string | null {
    let earliestServerId: string | null = null;
    let earliestOnlineAt: string | null = null;
    for (const host of this.hosts) {
      const snapshot = this.getSnapshot(host.serverId);
      if (!isHostRuntimeConnected(snapshot) || !snapshot?.lastOnlineAt) continue;
      if (!earliestOnlineAt || snapshot.lastOnlineAt < earliestOnlineAt) {
        earliestOnlineAt = snapshot.lastOnlineAt;
        earliestServerId = host.serverId;
      }
    }
    return earliestServerId;
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

  async refreshAgentDirectory(
    input: AgentDirectoryRefreshInput,
  ): Promise<RefreshAgentDirectoryResult> {
    const directory = this.directorySyncByServer.get(input.serverId);
    if (!directory) throw new Error(`Unknown host runtime for serverId ${input.serverId}`);
    return directory.refreshAgents(input);
  }

  async refreshWorkspaceDirectory(input: { serverId: string; subscribe?: boolean }): Promise<void> {
    const directory = this.directorySyncByServer.get(input.serverId);
    if (!directory) throw new Error(`Unknown host runtime for serverId ${input.serverId}`);
    await directory.refreshWorkspaces({ subscribe: input.subscribe });
  }

  async refreshDirectories(serverId: string): Promise<void> {
    const directory = this.directorySyncByServer.get(serverId);
    if (!directory) throw new Error(`Unknown host runtime for serverId ${serverId}`);
    await directory.refreshAll();
  }

  fetchAgentTimeline(
    serverId: string,
    agentId: string,
    request: Parameters<DaemonClient["fetchAgentTimeline"]>[1],
  ): Promise<Awaited<ReturnType<DaemonClient["fetchAgentTimeline"]>>> {
    const directory = this.directorySyncByServer.get(serverId);
    if (!directory) throw new Error(`Unknown host runtime for serverId ${serverId}`);
    return directory.fetchTimeline(agentId, request);
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

export function useHostRuntimeConnectionStatuses(
  serverIds: readonly string[],
): ReadonlyMap<string, HostRuntimeConnectionStatus> {
  const store = getHostRuntimeStore();
  const version = useSyncExternalStore(
    (onStoreChange) => store.subscribeAll(onStoreChange),
    () => store.getVersion(),
    () => store.getVersion(),
  );

  return useMemo(() => {
    // The aggregate version is the reactivity trigger; re-read snapshots on every host tick.
    void version;
    return new Map(
      serverIds.map(
        (serverId) =>
          [serverId, store.getSnapshot(serverId)?.connectionStatus ?? "connecting"] as const,
      ),
    );
  }, [serverIds, store, version]);
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

export function useHostRegistryStatus(): HostRegistryStatus {
  const store = getHostRuntimeStore();
  return useSyncExternalStore(
    (onStoreChange) => store.subscribeHostList(onStoreChange),
    () => store.getHostRegistryStatus(),
    () => store.getHostRegistryStatus(),
  );
}

export function useHostRegistryLoaded(): boolean {
  const store = getHostRuntimeStore();
  return useSyncExternalStore(
    (onStoreChange) => store.subscribeHostList(onStoreChange),
    () => store.isHostRegistryLoaded(),
    () => store.isHostRegistryLoaded(),
  );
}

export interface HostMutations {
  upsertDirectConnection: (input: {
    serverId: string;
    endpoint: string;
    useTls?: boolean;
    password?: string;
    label?: string;
  }) => Promise<HostProfile>;
  probeAndUpsertDirectConnection: (input: {
    endpoint: string;
    useTls?: boolean;
    password?: string;
    label?: string;
  }) => Promise<{ profile: HostProfile; serverId: string; hostname: string | null }>;
  upsertRelayConnection: (input: {
    serverId: string;
    relayEndpoint: string;
    useTls?: boolean;
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
      probeAndUpsertDirectConnection: (input) => store.probeAndUpsertDirectConnection(input),
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
