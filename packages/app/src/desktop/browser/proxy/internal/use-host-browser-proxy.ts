import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { getIsElectron } from "@/constants/platform";
import { getDesktopHost, type DesktopBrowserProxyStatus } from "@/desktop/host";
import { resolveBrowserRoutingMode, type BrowserRoutingMode } from "@/desktop/browser/store";
import { useHostRuntimeSnapshot, useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { normalizeHostLabel } from "@/types/host-connection";
import {
  ensureHostBrowserProxy,
  getCachedBrowserProxyStatus,
  installBrowserProxyRendererBridge,
  subscribeBrowserProxyStatus,
} from "./bridge";
import { classifyHostBrowserRouting } from "./classify";

export type BrowserProxyPaneState =
  | {
      kind: "ready";
      partition: string;
      isRemoteHost: boolean;
      effectiveRoutingMode: BrowserRoutingMode;
      hostLabel: string;
      proxyStatus: DesktopBrowserProxyStatus | null;
    }
  | {
      kind: "connecting";
      isRemoteHost: true;
      effectiveRoutingMode: "host";
      hostLabel: string;
      isReconnecting: boolean;
    }
  | {
      kind: "daemon_update_required";
      isRemoteHost: true;
      effectiveRoutingMode: "host";
      hostLabel: string;
    }
  | {
      kind: "routed_unsupported";
      isRemoteHost: true;
      effectiveRoutingMode: "host";
      hostLabel: string;
    }
  | {
      kind: "host_offline";
      isRemoteHost: true;
      effectiveRoutingMode: "host";
      hostLabel: string;
    }
  | {
      kind: "proxy_error";
      isRemoteHost: true;
      effectiveRoutingMode: "host";
      hostLabel: string;
      message: string;
      retry: () => void;
    };

function hasPreparedHostPartition(
  snapshot: ReturnType<typeof getCachedBrowserProxyStatus>,
): snapshot is NonNullable<ReturnType<typeof getCachedBrowserProxyStatus>> & {
  partition: string;
  socksPort: number;
} {
  return Boolean(snapshot?.partition && snapshot.socksPort !== null);
}

function resolveRemoteUnavailablePaneState(
  support: Exclude<
    Extract<ReturnType<typeof classifyHostBrowserRouting>, { kind: "remote" }>["support"],
    "supported"
  >,
  hostLabel: string,
  proxyStatusSnapshot: ReturnType<typeof getCachedBrowserProxyStatus>,
): BrowserProxyPaneState {
  // Once Electron main has verified and bound this host's fixed SOCKS5 partition,
  // keep the webview mounted across transient host disconnects/reconnects so SPA
  // state, forms, scroll, and DevTools survive. Requests still fail closed at the
  // local SOCKS5 listener while the tunnel is down.
  const isTransientDisconnect = support === "host_connecting" || support === "host_offline";
  if (isTransientDisconnect && hasPreparedHostPartition(proxyStatusSnapshot)) {
    return {
      kind: "ready",
      partition: proxyStatusSnapshot.partition,
      isRemoteHost: true,
      effectiveRoutingMode: "host",
      hostLabel,
      proxyStatus: "reconnecting",
    };
  }
  if (support === "host_connecting") {
    return {
      kind: "connecting",
      isRemoteHost: true,
      effectiveRoutingMode: "host",
      hostLabel,
      isReconnecting: false,
    };
  }
  return {
    kind: support,
    isRemoteHost: true,
    effectiveRoutingMode: "host",
    hostLabel,
  };
}

function resolvePreparedHostPaneStatus(
  status: DesktopBrowserProxyStatus,
): DesktopBrowserProxyStatus {
  if (status === "ready" || status === "error") {
    return status;
  }
  return "reconnecting";
}

export function resolveBrowserProxyPaneState(input: {
  routing: ReturnType<typeof classifyHostBrowserRouting>;
  effectiveRoutingMode: BrowserRoutingMode;
  localPartition: string;
  hostLabel: string;
  proxyStatusSnapshot: ReturnType<typeof getCachedBrowserProxyStatus>;
  ensureError: string | null;
  onRetry: () => void;
}): BrowserProxyPaneState {
  const {
    routing,
    effectiveRoutingMode,
    localPartition,
    hostLabel,
    proxyStatusSnapshot,
    ensureError,
    onRetry,
  } = input;

  if (routing.kind === "local" || effectiveRoutingMode === "local") {
    return {
      kind: "ready",
      partition: localPartition,
      isRemoteHost: routing.kind === "remote",
      effectiveRoutingMode: "local",
      hostLabel,
      proxyStatus: null,
    };
  }

  if (routing.support !== "supported") {
    return resolveRemoteUnavailablePaneState(routing.support, hostLabel, proxyStatusSnapshot);
  }

  // Once the fixed-port SOCKS5 session partition is verified (socksPort !== null),
  // keep the webview mounted even if a background poll (e.g. HMR) left the cached
  // tunnel status in "error" or "reconnecting" while the host reconnects.
  if (hasPreparedHostPartition(proxyStatusSnapshot)) {
    return {
      kind: "ready",
      partition: proxyStatusSnapshot.partition,
      isRemoteHost: true,
      effectiveRoutingMode: "host",
      hostLabel,
      proxyStatus: resolvePreparedHostPaneStatus(proxyStatusSnapshot.status),
    };
  }

  const errorMessage =
    ensureError ?? (proxyStatusSnapshot?.status === "error" ? proxyStatusSnapshot.error : null);
  if (errorMessage) {
    return {
      kind: "proxy_error",
      isRemoteHost: true,
      effectiveRoutingMode: "host",
      hostLabel,
      message: errorMessage,
      retry: onRetry,
    };
  }

  return {
    kind: "connecting",
    isRemoteHost: true,
    effectiveRoutingMode: "host",
    hostLabel,
    isReconnecting: false,
  };
}

export function useHostBrowserProxy(input: {
  serverId: string;
  routingMode?: BrowserRoutingMode;
}): BrowserProxyPaneState {
  const { serverId, routingMode } = input;
  const hosts = useHosts();
  const host = useMemo(
    () => hosts.find((entry) => entry.serverId === serverId) ?? null,
    [hosts, serverId],
  );
  const hostLabel = normalizeHostLabel(host?.label, serverId);
  const runtimeSnapshot = useHostRuntimeSnapshot(serverId);
  const supportsNetworkTunnel = useSessionStore((state) => {
    const serverInfo = state.sessions[serverId]?.serverInfo ?? null;
    return serverInfo !== null ? serverInfo.features?.networkTunnel === true : null;
  });

  const proxyStatusSnapshot = useSyncExternalStore(
    useCallback((onChange) => subscribeBrowserProxyStatus(serverId, onChange), [serverId]),
    () => getCachedBrowserProxyStatus(serverId),
    () => getCachedBrowserProxyStatus(serverId),
  );

  const [retryCounter, setRetryCounter] = useState(0);
  const [ensureError, setEnsureError] = useState<string | null>(null);

  const routing = useMemo(
    () =>
      classifyHostBrowserRouting({
        serverId,
        connections: host?.connections ?? [],
        activeConnection: runtimeSnapshot?.activeConnection ?? null,
        activeConnectionId: runtimeSnapshot?.activeConnectionId ?? null,
        connectionStatus: runtimeSnapshot?.connectionStatus ?? "offline",
        supportsNetworkTunnel,
      }),
    [
      host?.connections,
      runtimeSnapshot?.activeConnection,
      runtimeSnapshot?.activeConnectionId,
      runtimeSnapshot?.connectionStatus,
      serverId,
      supportsNetworkTunnel,
    ],
  );

  const effectiveRoutingMode = resolveBrowserRoutingMode(
    { routingMode },
    routing.kind === "remote",
  );
  const supportedTarget =
    routing.kind === "remote" && routing.support === "supported" ? routing.target : null;
  const targetKey = supportedTarget ? JSON.stringify(supportedTarget) : null;

  const handleRetry = useCallback(() => {
    setEnsureError(null);
    setRetryCounter((count) => count + 1);
  }, []);

  useEffect(() => {
    if (!getIsElectron() || effectiveRoutingMode !== "host" || !supportedTarget) {
      setEnsureError(null);
      return;
    }

    let cancelled = false;
    installBrowserProxyRendererBridge();
    setEnsureError(null);

    void ensureHostBrowserProxy({
      serverId,
      target: supportedTarget,
      forceReconnect: retryCounter > 0,
    })
      .then((snapshot) => {
        if (cancelled) return undefined;
        if (!snapshot) {
          setEnsureError("Browser proxy bridge is unavailable.");
        } else if (snapshot.status === "error") {
          setEnsureError(snapshot.error ?? "Unable to connect browser proxy.");
        }
        return undefined;
      })
      .catch((error) => {
        if (cancelled) return;
        setEnsureError(error instanceof Error ? error.message : String(error));
      });

    return () => {
      cancelled = true;
    };
    // targetKey serializes supportedTarget deterministically.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveRoutingMode, retryCounter, serverId, targetKey]);

  const localPartition = getDesktopHost()?.browser?.profilePartition ?? "persist:paseo-browser";
  return resolveBrowserProxyPaneState({
    routing,
    effectiveRoutingMode,
    localPartition,
    hostLabel,
    proxyStatusSnapshot,
    ensureError,
    onRetry: handleRetry,
  });
}
