import net, { type AddressInfo, type Server, type Socket } from "node:net";
import { getHostBrowserProxyPartition, isHostBrowserProxyPartition } from "./partition.js";
import { createOsSocketOwnerVerifier, type SocketOwnerVerifier } from "./socket-owner.js";
import {
  performSocks5Handshake,
  Socks5Error,
  Socks5ReplyCode,
  socks5ReplyForTunnelCloseReason,
  writeSocks5Reply,
} from "./socks5.js";
import { TunnelMuxClient } from "./tunnel-mux.js";
import {
  openTunnelWireConnection,
  type BrowserProxyTarget,
  type TunnelWireConnection,
} from "./tunnel-transport.js";

export type BrowserProxyStatus = "idle" | "connecting" | "ready" | "reconnecting" | "error";

export interface BrowserProxyStatusSnapshot {
  serverId: string;
  partition: string;
  status: BrowserProxyStatus;
  error: string | null;
  socksPort: number | null;
}

export interface BrowserProxySessionLike {
  setProxy(config: {
    mode: "fixed_servers";
    proxyRules: string;
    proxyBypassRules: string;
  }): Promise<void>;
  closeAllConnections(): Promise<void>;
  resolveProxy(url: string): Promise<string>;
}

export interface BrowserProxyManagerDeps {
  requestTicket: (serverId: string) => Promise<string>;
  getSessionForPartition: (partition: string) => BrowserProxySessionLike;
  verifySocketOwner?: SocketOwnerVerifier;
  openTunnelWire?: (input: {
    target: BrowserProxyTarget;
    ticket: string;
  }) => Promise<TunnelWireConnection>;
  onStatusChange?: (status: BrowserProxyStatusSnapshot) => void;
  log?: {
    info: (message: string, details?: Record<string, unknown>) => void;
    warn: (message: string, details?: Record<string, unknown>) => void;
  };
}

export interface EnsureHostProxyInput {
  serverId: string;
  target: BrowserProxyTarget;
  forceReconnect?: boolean;
}

export interface BrowserProxyManager {
  ensureHostProxy(input: EnsureHostProxyInput): Promise<BrowserProxyStatusSnapshot>;
  updateHostProxyTarget(input: { serverId: string; target: BrowserProxyTarget }): void;
  getHostProxyStatus(serverId: string): BrowserProxyStatusSnapshot | null;
  isAllowedHostPartition(partition: string): boolean;
  isProxiedSession(session: object): boolean;
  listKnownPartitions(): string[];
  releaseHostProxy(serverId: string): Promise<void>;
  disposeAll(): Promise<void>;
}

interface HostProxyEntry {
  readonly serverId: string;
  readonly partition: string;
  target: BrowserProxyTarget;
  status: BrowserProxyStatus;
  error: string | null;
  socksServer: Server | null;
  socksPort: number | null;
  session: BrowserProxySessionLike | null;
  sessionConfigured: boolean;
  mux: TunnelMuxClient | null;
  connectPromise: Promise<TunnelMuxClient> | null;
  ensurePromise: Promise<BrowserProxyStatusSnapshot> | null;
  activeSockets: Set<Socket>;
  disposed: boolean;
}

function isLoopbackRemoteAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::ffff:127.0.0.1";
}

function targetsEqual(left: BrowserProxyTarget, right: BrowserProxyTarget): boolean {
  if (left.type !== right.type) return false;
  if (left.type === "directTcp" && right.type === "directTcp") {
    return left.endpoint === right.endpoint && (left.useTls ?? false) === (right.useTls ?? false);
  }
  if (left.type === "remoteSsh" && right.type === "remoteSsh") {
    return (
      left.host === right.host &&
      left.sshPort === right.sshPort &&
      left.daemonPort === right.daemonPort
    );
  }
  if (left.type === "relay" && right.type === "relay") {
    return (
      left.serverId === right.serverId &&
      left.relayEndpoint === right.relayEndpoint &&
      (left.useTls ?? false) === (right.useTls ?? false) &&
      left.daemonPublicKeyB64 === right.daemonPublicKeyB64 &&
      left.minimumSecurityMode === right.minimumSecurityMode
    );
  }
  return false;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isExpectedResolvedProxy(resolved: string, socksPort: number): boolean {
  const normalized = resolved.trim().toUpperCase();
  const expected = `SOCKS5 127.0.0.1:${socksPort}`;
  return normalized.includes(expected);
}

export function createBrowserProxyManager(deps: BrowserProxyManagerDeps): BrowserProxyManager {
  const verifySocketOwner = deps.verifySocketOwner ?? createOsSocketOwnerVerifier();
  const openTunnelWire =
    deps.openTunnelWire ??
    ((input) => openTunnelWireConnection({ target: input.target, ticket: input.ticket }));

  const entriesByServerId = new Map<string, HostProxyEntry>();
  const allowedPartitions = new Set<string>();
  const knownPartitions = new Set<string>();
  const proxiedSessions = new WeakSet<object>();

  function snapshotOf(entry: HostProxyEntry): BrowserProxyStatusSnapshot {
    return {
      serverId: entry.serverId,
      partition: entry.partition,
      status: entry.status,
      error: entry.error,
      // Only expose socksPort once Chromium's session proxy has been configured and
      // verified via resolveProxy so renderers never mount an unverified partition.
      socksPort: entry.sessionConfigured ? entry.socksPort : null,
    };
  }

  function setEntryStatus(
    entry: HostProxyEntry,
    status: BrowserProxyStatus,
    error: string | null = null,
  ): void {
    if (entry.status === status && entry.error === error) {
      return;
    }
    entry.status = status;
    entry.error = error;
    deps.onStatusChange?.(snapshotOf(entry));
  }

  async function ensureSocksServer(entry: HostProxyEntry): Promise<number> {
    if (entry.socksServer && entry.socksPort !== null) {
      return entry.socksPort;
    }

    const server = net.createServer((socket) => {
      void handleAcceptedSocksSocket(entry, socket);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });

    const address = server.address() as AddressInfo | null;
    if (!address || typeof address === "string" || address.port <= 0) {
      server.close();
      throw new Error("Failed to bind local loopback SOCKS5 port");
    }

    entry.socksServer = server;
    entry.socksPort = address.port;
    server.on("error", (error) => {
      deps.log?.warn("[browser-proxy] socks5 server error", {
        serverId: entry.serverId,
        error: formatError(error),
      });
    });

    return address.port;
  }

  async function ensureSessionConfigured(entry: HostProxyEntry, socksPort: number): Promise<void> {
    if (entry.sessionConfigured && entry.session) {
      return;
    }

    const hostSession = deps.getSessionForPartition(entry.partition);
    await hostSession.setProxy({
      mode: "fixed_servers",
      proxyRules: `socks5://127.0.0.1:${socksPort}`,
      proxyBypassRules: "<-loopback>",
    });
    await hostSession.closeAllConnections();

    // Verify that both hostname loopback and IP loopback actually resolve to our SOCKS5 proxy.
    const [resolvedLocalhost, resolvedLoopbackIp] = await Promise.all([
      hostSession.resolveProxy("http://localhost:80/"),
      hostSession.resolveProxy("http://127.0.0.1:80/"),
    ]);

    if (
      !isExpectedResolvedProxy(resolvedLocalhost, socksPort) ||
      !isExpectedResolvedProxy(resolvedLoopbackIp, socksPort)
    ) {
      throw new Error(
        `Session resolveProxy verification failed (localhost="${resolvedLocalhost}", 127.0.0.1="${resolvedLoopbackIp}")`,
      );
    }

    entry.session = hostSession;
    entry.sessionConfigured = true;
    allowedPartitions.add(entry.partition);
    knownPartitions.add(entry.partition);
    proxiedSessions.add(hostSession);
  }

  async function ensureTunnelConnected(entry: HostProxyEntry): Promise<TunnelMuxClient> {
    if (entry.disposed) {
      throw new Error("Host browser proxy was disposed");
    }
    if (entry.mux && !entry.mux.isClosed()) {
      return entry.mux;
    }
    if (entry.connectPromise) {
      return await entry.connectPromise;
    }

    const nextStatus: BrowserProxyStatus =
      entry.sessionConfigured || entry.status === "ready" || entry.status === "reconnecting"
        ? "reconnecting"
        : "connecting";
    setEntryStatus(entry, nextStatus, null);

    const connectTask = (async () => {
      const ticket = await deps.requestTicket(entry.serverId);
      if (entry.disposed) {
        throw new Error("Host browser proxy was disposed");
      }
      const wire = await openTunnelWire({
        target: entry.target,
        ticket,
      });
      if (entry.disposed) {
        wire.close();
        throw new Error("Host browser proxy was disposed");
      }

      const mux = new TunnelMuxClient(wire);
      entry.mux = mux;
      mux.onClose(() => {
        if (entry.mux === mux) {
          entry.mux = null;
          if (!entry.disposed && entry.sessionConfigured) {
            setEntryStatus(entry, "reconnecting", null);
          }
        }
      });

      if (entry.sessionConfigured) {
        setEntryStatus(entry, "ready", null);
      }
      return mux;
    })();

    entry.connectPromise = connectTask;
    try {
      return await connectTask;
    } catch (error) {
      if (!entry.disposed) {
        setEntryStatus(entry, "error", formatError(error));
      }
      throw error;
    } finally {
      if (entry.connectPromise === connectTask) {
        entry.connectPromise = null;
      }
    }
  }

  async function handleAcceptedSocksSocket(entry: HostProxyEntry, socket: Socket): Promise<void> {
    socket.pause();
    entry.activeSockets.add(socket);
    socket.once("close", () => {
      entry.activeSockets.delete(socket);
    });
    socket.on("error", () => {
      // Handled by stream/close cleanup.
    });

    if (entry.disposed || entry.socksPort === null) {
      socket.destroy();
      return;
    }

    const clientPort = socket.remotePort;
    if (!isLoopbackRemoteAddress(socket.remoteAddress) || !clientPort) {
      socket.destroy();
      return;
    }

    let ownerAllowed = false;
    try {
      ownerAllowed = await verifySocketOwner({
        clientPort,
        serverPort: entry.socksPort,
      });
    } catch {
      ownerAllowed = false;
    }

    if (!ownerAllowed || socket.destroyed || entry.disposed) {
      deps.log?.warn("[browser-proxy] rejected unauthorized local SOCKS5 connection", {
        serverId: entry.serverId,
        remoteAddress: socket.remoteAddress,
        clientPort,
      });
      socket.destroy();
      return;
    }

    socket.resume();

    let request: { host: string; port: number; leftover: Buffer };
    try {
      request = await performSocks5Handshake(socket);
    } catch (error) {
      if (!(error instanceof Socks5Error) || error.replyCode === null) {
        socket.destroy();
      } else {
        socket.end();
      }
      return;
    }

    let mux: TunnelMuxClient;
    try {
      mux = await ensureTunnelConnected(entry);
    } catch {
      writeSocks5Reply(socket, Socks5ReplyCode.NetworkUnreachable);
      socket.end();
      return;
    }

    const result = await mux.openStream({
      host: request.host,
      port: request.port,
      socket,
      initialData: request.leftover,
      onOpened: () => {
        writeSocks5Reply(socket, Socks5ReplyCode.Succeeded);
      },
    });

    if (!result.ok) {
      writeSocks5Reply(socket, socks5ReplyForTunnelCloseReason(result.reason));
      socket.end();
    }
  }

  function getOrCreateEntry(serverId: string, target: BrowserProxyTarget): HostProxyEntry {
    const existing = entriesByServerId.get(serverId);
    if (existing && !existing.disposed) {
      if (!targetsEqual(existing.target, target)) {
        existing.target = target;
        // Close existing tunnel so the next connect uses the updated target
        // while keeping the fixed local SOCKS5 port intact!
        existing.mux?.close();
        existing.mux = null;
      }
      return existing;
    }

    const partition = getHostBrowserProxyPartition(serverId);
    knownPartitions.add(partition);
    const entry: HostProxyEntry = {
      serverId,
      partition,
      target,
      status: "idle",
      error: null,
      socksServer: null,
      socksPort: null,
      session: null,
      sessionConfigured: false,
      mux: null,
      connectPromise: null,
      ensurePromise: null,
      activeSockets: new Set(),
      disposed: false,
    };
    entriesByServerId.set(serverId, entry);
    return entry;
  }

  async function ensureHostProxy(input: EnsureHostProxyInput): Promise<BrowserProxyStatusSnapshot> {
    const serverId = input.serverId.trim();
    if (!serverId) {
      throw new Error("Host serverId is required");
    }

    const entry = getOrCreateEntry(serverId, input.target);
    if (input.forceReconnect && entry.mux) {
      entry.mux.close();
      entry.mux = null;
    }

    if (entry.ensurePromise) {
      return await entry.ensurePromise;
    }

    const ensureTask = (async (): Promise<BrowserProxyStatusSnapshot> => {
      try {
        if (entry.status !== "ready") {
          setEntryStatus(entry, entry.sessionConfigured ? "reconnecting" : "connecting", null);
        }
        const socksPort = await ensureSocksServer(entry);
        await ensureTunnelConnected(entry);
        await ensureSessionConfigured(entry, socksPort);
        setEntryStatus(entry, "ready", null);
        return snapshotOf(entry);
      } catch (error) {
        const message = formatError(error);
        if (!entry.disposed) {
          setEntryStatus(entry, "error", message);
        }
        return snapshotOf(entry);
      }
    })();

    entry.ensurePromise = ensureTask;
    try {
      return await ensureTask;
    } finally {
      if (entry.ensurePromise === ensureTask) {
        entry.ensurePromise = null;
      }
    }
  }

  function updateHostProxyTarget(input: { serverId: string; target: BrowserProxyTarget }): void {
    const entry = entriesByServerId.get(input.serverId.trim());
    if (!entry || entry.disposed) return;
    if (!targetsEqual(entry.target, input.target)) {
      entry.target = input.target;
      entry.mux?.close();
      entry.mux = null;
      if (entry.sessionConfigured) {
        setEntryStatus(entry, "reconnecting", null);
      }
    }
  }

  function getHostProxyStatus(serverId: string): BrowserProxyStatusSnapshot | null {
    const entry = entriesByServerId.get(serverId.trim());
    return entry && !entry.disposed ? snapshotOf(entry) : null;
  }

  function isAllowedHostPartition(partition: string): boolean {
    return isHostBrowserProxyPartition(partition) && allowedPartitions.has(partition);
  }

  function isProxiedSession(session: object): boolean {
    return proxiedSessions.has(session);
  }

  function listKnownPartitions(): string[] {
    return [...knownPartitions];
  }

  async function disposeEntry(entry: HostProxyEntry): Promise<void> {
    if (entry.disposed) return;
    entry.disposed = true;
    entriesByServerId.delete(entry.serverId);
    allowedPartitions.delete(entry.partition);

    entry.mux?.close();
    entry.mux = null;

    for (const socket of entry.activeSockets) {
      socket.destroy();
    }
    entry.activeSockets.clear();

    const server = entry.socksServer;
    entry.socksServer = null;
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }

  async function releaseHostProxy(serverId: string): Promise<void> {
    const entry = entriesByServerId.get(serverId.trim());
    if (!entry) return;
    await disposeEntry(entry);
  }

  async function disposeAll(): Promise<void> {
    const entries = [...entriesByServerId.values()];
    await Promise.all(entries.map((entry) => disposeEntry(entry)));
    verifySocketOwner.dispose?.();
  }

  return {
    ensureHostProxy,
    updateHostProxyTarget,
    getHostProxyStatus,
    isAllowedHostPartition,
    isProxiedSession,
    listKnownPartitions,
    releaseHostProxy,
    disposeAll,
  };
}
