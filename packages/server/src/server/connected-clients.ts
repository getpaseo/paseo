import type {
  ConnectedClientKind,
  ConnectedClientSummary,
  ConnectedClientTransport,
  DaemonClientsSnapshot,
  DaemonPermission,
  HelloClientInfo,
  InboundDaemonSummary,
  RoutedClientSummary,
  WSHelloMessage,
} from "@getpaseo/protocol/messages";

export interface ConnectedClientIdentity {
  transport: "direct" | "relay" | "hub";
  peer: "loopback" | "local_ipc" | "external";
  userAgent?: string;
  localEndpoint?: string;
  hubDaemonId?: string;
}

export interface ConnectedClientRecord {
  sessionId: string;
  clientId: string;
  clientType: WSHelloMessage["clientType"];
  clientInfo: HelloClientInfo | null;
  appVersion: string | null;
  permissions: readonly DaemonPermission[];
  connectedAt: string;
  socketCount: number;
  isCurrentSession: boolean;
  isEphemeralPlugin: boolean;
  pluginId: string | null;
  isRouted: boolean;
  identity: ConnectedClientIdentity | null;
  hubOrigin: string | null;
  /** Routed child sessions currently multiplexed over this record's physical daemon link. */
  routedChildren: readonly ConnectedClientRecord[];
  /** True when this physical connection owns an active `DaemonLinkEndpoint`. */
  hasHostLink: boolean;
}

export interface BuildConnectedClientsOptions {
  includeInternal?: boolean;
  isTailscaleEndpoint?: (localEndpoint: string) => boolean;
}

const HOST_LINK_CLIENT_ID_PREFIX = "host-link-";

function parsePeerServerIdFromClientId(clientId: string): string | null {
  if (!clientId.startsWith(HOST_LINK_CLIENT_ID_PREFIX)) return null;
  const rest = clientId.slice(HOST_LINK_CLIENT_ID_PREFIX.length);
  const marker = rest.lastIndexOf("-hst_");
  if (marker > 0) return rest.slice(0, marker);
  return null;
}

function isInboundDaemonRecord(record: ConnectedClientRecord): boolean {
  if (record.isRouted) return false;
  if (record.clientInfo?.kind === "daemon") return true;
  if (record.hasHostLink) return true;
  return record.clientId.startsWith(HOST_LINK_CLIENT_ID_PREFIX);
}

function resolveClientKind(record: ConnectedClientRecord): ConnectedClientKind {
  if (record.isEphemeralPlugin) return "plugin";
  const infoKind = record.clientInfo?.kind;
  if (infoKind && infoKind !== "daemon") return infoKind;
  if (record.identity?.transport === "hub" || record.clientType === "hub") return "hub";
  switch (record.clientType) {
    case "mobile":
      return "mobile";
    case "browser":
      return "web";
    case "cli":
      return "cli";
    case "mcp":
      return "mcp";
    default:
      return "unknown";
  }
}

function parseBrowserName(userAgent: string | undefined): string | null {
  if (!userAgent) return null;
  if (/Edg\//.test(userAgent)) return "Edge";
  if (/Firefox\//.test(userAgent)) return "Firefox";
  if (/Chrome\//.test(userAgent) && !/Edg\//.test(userAgent)) return "Chrome";
  if (/Safari\//.test(userAgent) && !/Chrome\//.test(userAgent)) return "Safari";
  return null;
}

function resolveClientName(
  record: ConnectedClientRecord,
  kind: ConnectedClientKind,
): string | null {
  const explicit = record.clientInfo?.name?.trim();
  if (explicit) return explicit;
  if (record.pluginId) return record.pluginId;
  if (kind === "hub") return "Paseo Hub";
  if (kind === "web") return parseBrowserName(record.identity?.userAgent);
  return null;
}

function resolveTransport(
  identity: ConnectedClientIdentity | null,
  isTailscaleEndpoint?: (localEndpoint: string) => boolean,
): ConnectedClientTransport {
  if (!identity) return "direct";
  if (identity.transport === "relay") return "relay";
  if (identity.transport === "hub") return "hub";
  if (identity.peer === "local_ipc") return "local_ipc";
  if (identity.peer === "loopback") return "local";
  if (identity.localEndpoint && isTailscaleEndpoint?.(identity.localEndpoint)) {
    return "tailscale";
  }
  return "direct";
}

function isInternalClient(record: ConnectedClientRecord, kind: ConnectedClientKind): boolean {
  if (record.isEphemeralPlugin || kind === "plugin") return true;
  return kind === "cli" || kind === "mcp";
}

function toRoutedSummary(record: ConnectedClientRecord): RoutedClientSummary {
  const kind = resolveClientKind(record);
  return {
    sessionId: record.sessionId,
    name: resolveClientName(record, kind),
    kind,
    permissions: [...record.permissions],
  };
}

function toInboundDaemonSummary(
  record: ConnectedClientRecord,
  isTailscaleEndpoint?: (localEndpoint: string) => boolean,
): InboundDaemonSummary {
  const transport = resolveTransport(record.identity, isTailscaleEndpoint);
  const peerServerId =
    record.clientInfo?.peerServerId?.trim() ||
    parsePeerServerIdFromClientId(record.clientId) ||
    null;
  const routedSessions = [...record.routedChildren]
    .sort((a, b) => a.connectedAt.localeCompare(b.connectedAt))
    .map(toRoutedSummary);
  return {
    sessionId: record.sessionId,
    peerServerId,
    name: record.clientInfo?.name?.trim() || null,
    appVersion: record.appVersion,
    transport,
    permissions: [...record.permissions],
    connectedAt: record.connectedAt,
    socketCount: record.socketCount,
    routedSessions,
  };
}

function toConnectedClientSummary(
  record: ConnectedClientRecord,
  kind: ConnectedClientKind,
  isTailscaleEndpoint?: (localEndpoint: string) => boolean,
): ConnectedClientSummary {
  const transport = resolveTransport(record.identity, isTailscaleEndpoint);
  return {
    sessionId: record.sessionId,
    isCurrentSession: record.isCurrentSession,
    kind,
    name: resolveClientName(record, kind),
    platform: record.clientInfo?.platform ?? null,
    appVersion: record.appVersion,
    transport,
    ...(transport === "hub" && record.hubOrigin ? { hubOrigin: record.hubOrigin } : {}),
    permissions: [...record.permissions],
    connectedAt: record.connectedAt,
    socketCount: record.socketCount,
  };
}

function compareByLiveThenTime(
  a: { socketCount: number; connectedAt: string },
  b: { socketCount: number; connectedAt: string },
): number {
  const aLive = a.socketCount > 0 ? 1 : 0;
  const bLive = b.socketCount > 0 ? 1 : 0;
  if (aLive !== bLive) return bLive - aLive;
  return a.connectedAt.localeCompare(b.connectedAt);
}

export function buildConnectedClientsSnapshot(
  records: readonly ConnectedClientRecord[],
  options: BuildConnectedClientsOptions = {},
): DaemonClientsSnapshot {
  const includeInternal = options.includeInternal === true;
  const clients: ConnectedClientSummary[] = [];
  const inboundDaemons: InboundDaemonSummary[] = [];

  for (const record of records) {
    if (record.isRouted) continue;

    if (isInboundDaemonRecord(record)) {
      inboundDaemons.push(toInboundDaemonSummary(record, options.isTailscaleEndpoint));
      continue;
    }

    const kind = resolveClientKind(record);
    if (!includeInternal && !record.isCurrentSession && isInternalClient(record, kind)) {
      continue;
    }

    clients.push(toConnectedClientSummary(record, kind, options.isTailscaleEndpoint));
  }

  clients.sort((a, b) => {
    if (a.isCurrentSession !== b.isCurrentSession) return a.isCurrentSession ? -1 : 1;
    return compareByLiveThenTime(a, b);
  });

  inboundDaemons.sort(compareByLiveThenTime);

  return { clients, inboundDaemons };
}

export function createConnectedClientsNotifier(debounceMs = 100): {
  observe(listener: () => void): () => void;
  notify(): void;
  close(): void;
} {
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  return {
    observe(listener) {
      if (closed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    notify() {
      if (closed || listeners.size === 0) return;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        if (closed) return;
        for (const listener of listeners) {
          listener();
        }
      }, debounceMs);
      timer.unref?.();
    },
    close() {
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      listeners.clear();
    },
  };
}
