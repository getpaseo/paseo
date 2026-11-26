import { getIsElectron } from "@/constants/platform";
import {
  getDesktopHost,
  type DesktopBrowserProxyStatusSnapshot,
  type DesktopBrowserProxyTicketRequestEvent,
} from "@/desktop/host";
import { i18n } from "@/i18n/i18next";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import {
  classifyHostBrowserRouting,
  shouldOpenUrlInProxiedWorkspaceBrowser,
  type HostBrowserRouting,
} from "./classify";

const statusByServerId = new Map<string, DesktopBrowserProxyStatusSnapshot>();
const statusListenersByServerId = new Map<string, Set<() => void>>();
const trackedHostIds = new Set<string>();
const lastHostConnectionStatus = new Map<string, string>();
let bridgeInstalled = false;

function notifyStatusListeners(serverId: string): void {
  const listeners = statusListenersByServerId.get(serverId);
  if (!listeners) return;
  for (const listener of listeners) {
    listener();
  }
}

function setCachedStatus(snapshot: DesktopBrowserProxyStatusSnapshot): void {
  const existing = statusByServerId.get(snapshot.serverId);
  if (
    existing &&
    existing.status === snapshot.status &&
    existing.error === snapshot.error &&
    existing.partition === snapshot.partition &&
    existing.socksPort === snapshot.socksPort
  ) {
    return;
  }
  statusByServerId.set(snapshot.serverId, snapshot);
  notifyStatusListeners(snapshot.serverId);
}

function isStatusSnapshot(value: unknown): value is DesktopBrowserProxyStatusSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.serverId === "string" &&
    typeof record.partition === "string" &&
    typeof record.status === "string"
  );
}

function isTicketRequestEvent(value: unknown): value is DesktopBrowserProxyTicketRequestEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.requestId === "string" && typeof record.serverId === "string";
}

async function handleTicketRequest(event: DesktopBrowserProxyTicketRequestEvent): Promise<void> {
  const deliver = getDesktopHost()?.browser?.deliverProxyTicket;
  if (typeof deliver !== "function") return;

  const snapshot = getHostRuntimeStore().getSnapshot(event.serverId);
  const client = snapshot?.client ?? null;
  if (!client || snapshot?.connectionStatus !== "online") {
    await deliver({
      requestId: event.requestId,
      error: i18n.t("workspace.terminal.hostDisconnected"),
    }).catch(() => {});
    return;
  }

  try {
    const result = await client.createNetworkTunnelTicket();
    await deliver({ requestId: event.requestId, ticket: result.ticket });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deliver({ requestId: event.requestId, error: message }).catch(() => {});
  }
}

export function installBrowserProxyRendererBridge(): void {
  if (bridgeInstalled || !getIsElectron()) {
    return;
  }
  const desktop = getDesktopHost();
  if (!desktop?.events?.on || !desktop.browser?.ensureHostProxy) {
    return;
  }
  bridgeInstalled = true;

  void desktop.events.on("browser-proxy-ticket-request", (payload) => {
    if (isTicketRequestEvent(payload)) {
      void handleTicketRequest(payload);
    }
  });

  void desktop.events.on("browser-proxy-status", (payload) => {
    if (isStatusSnapshot(payload)) {
      setCachedStatus(payload);
    }
  });

  const store = getHostRuntimeStore();
  store.subscribeAll(() => {
    const currentHosts = new Set(store.getHosts().map((host) => host.serverId));
    for (const serverId of trackedHostIds) {
      if (!currentHosts.has(serverId)) {
        trackedHostIds.delete(serverId);
        lastHostConnectionStatus.delete(serverId);
        statusByServerId.delete(serverId);
        notifyStatusListeners(serverId);
        void desktop.browser?.releaseHostProxy?.(serverId).catch(() => {});
        continue;
      }
      const nextConnectionStatus = store.getSnapshot(serverId)?.connectionStatus ?? "offline";
      const prevConnectionStatus = lastHostConnectionStatus.get(serverId);
      lastHostConnectionStatus.set(serverId, nextConnectionStatus);

      const routing = readHostBrowserRouting(serverId);
      if (routing.kind === "remote" && routing.support === "supported") {
        if (prevConnectionStatus !== undefined && prevConnectionStatus !== "online") {
          // Control session just recovered after a drop; replace any half-open tunnel socket
          // immediately while keeping the fixed local SOCKS5 port and mounted webview intact.
          void ensureHostBrowserProxy({
            serverId,
            target: routing.target,
            forceReconnect: true,
          }).catch(() => {});
        } else {
          void desktop.browser
            ?.updateHostProxyTarget?.({ serverId, target: routing.target })
            .catch(() => {});
        }
      }
    }
  });
}

export function readHostBrowserRouting(serverId: string): HostBrowserRouting {
  const runtimeStore = getHostRuntimeStore();
  const host = runtimeStore.getHosts().find((entry) => entry.serverId === serverId) ?? null;
  const snapshot = runtimeStore.getSnapshot(serverId);
  const serverInfo = useSessionStore.getState().sessions[serverId]?.serverInfo ?? null;
  const supportsNetworkTunnel =
    serverInfo !== null ? serverInfo.features?.networkTunnel === true : null;

  return classifyHostBrowserRouting({
    serverId,
    connections: host?.connections ?? [],
    activeConnection: snapshot?.activeConnection ?? null,
    activeConnectionId: snapshot?.activeConnectionId ?? null,
    connectionStatus: snapshot?.connectionStatus ?? "offline",
    supportsNetworkTunnel,
  });
}

export function shouldRouteWorkspaceUrlToProxiedBrowser(input: {
  serverId: string;
  url: string;
}): boolean {
  if (!getIsElectron()) {
    return false;
  }
  const routing = readHostBrowserRouting(input.serverId);
  return shouldOpenUrlInProxiedWorkspaceBrowser({
    isElectron: true,
    url: input.url,
    routing,
  });
}

export function getCachedBrowserProxyStatus(
  serverId: string,
): DesktopBrowserProxyStatusSnapshot | null {
  return statusByServerId.get(serverId) ?? null;
}

export function subscribeBrowserProxyStatus(serverId: string, listener: () => void): () => void {
  let listeners = statusListenersByServerId.get(serverId);
  if (!listeners) {
    listeners = new Set();
    statusListenersByServerId.set(serverId, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners?.delete(listener);
    if (listeners && listeners.size === 0) {
      statusListenersByServerId.delete(serverId);
    }
  };
}

export async function ensureHostBrowserProxy(input: {
  serverId: string;
  target: NonNullable<
    Extract<HostBrowserRouting, { kind: "remote"; support: "supported" }>["target"]
  >;
  forceReconnect?: boolean;
}): Promise<DesktopBrowserProxyStatusSnapshot | null> {
  installBrowserProxyRendererBridge();
  const ensureHostProxy = getDesktopHost()?.browser?.ensureHostProxy;
  if (typeof ensureHostProxy !== "function") {
    return null;
  }
  trackedHostIds.add(input.serverId);
  const currentStatus = getHostRuntimeStore().getSnapshot(input.serverId)?.connectionStatus;
  if (currentStatus) {
    lastHostConnectionStatus.set(input.serverId, currentStatus);
  }
  const snapshot = await ensureHostProxy(input);
  setCachedStatus(snapshot);
  return snapshot;
}

export type PrepareHostBrowserPartitionResult =
  | { ok: true; partition: string; isRemoteHost: boolean }
  | {
      ok: false;
      reason:
        | "daemon_update_required"
        | "routed_unsupported"
        | "host_offline"
        | "host_connecting"
        | "proxy_error";
      message: string;
    };

export async function prepareHostBrowserPartition(
  serverId: string,
  options?: { forceReconnect?: boolean },
): Promise<PrepareHostBrowserPartitionResult> {
  const desktop = getDesktopHost();
  const localPartition = desktop?.browser?.profilePartition;
  if (!localPartition) {
    return {
      ok: false,
      reason: "proxy_error",
      message: "Electron browser profile bridge is unavailable",
    };
  }

  const routing = readHostBrowserRouting(serverId);
  if (routing.kind === "local") {
    return { ok: true, partition: localPartition, isRemoteHost: false };
  }

  if (routing.support === "daemon_update_required") {
    return {
      ok: false,
      reason: "daemon_update_required",
      message: "Update this host daemon to browse through the host proxy.",
    };
  }
  if (routing.support === "routed_unsupported") {
    return {
      ok: false,
      reason: "routed_unsupported",
      message: "Browser proxying is not available for multi-hop routed hosts.",
    };
  }
  if (routing.support === "host_connecting") {
    return {
      ok: false,
      reason: "host_connecting",
      message: "Host is still connecting.",
    };
  }
  if (routing.support === "host_offline") {
    return {
      ok: false,
      reason: "host_offline",
      message: "Host is offline.",
    };
  }

  try {
    const status = await ensureHostBrowserProxy({
      serverId,
      target: routing.target,
      forceReconnect: options?.forceReconnect,
    });
    if (!status) {
      return {
        ok: false,
        reason: "proxy_error",
        message: "Browser proxy bridge is unavailable in this desktop build.",
      };
    }
    if (status.status !== "ready") {
      return {
        ok: false,
        reason: "proxy_error",
        message: status.error ?? "Unable to connect browser proxy.",
      };
    }
    return { ok: true, partition: status.partition, isRemoteHost: true };
  } catch (error) {
    return {
      ok: false,
      reason: "proxy_error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
