import { getIsElectron } from "@/constants/platform";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { NetworkTunnelRpcError } from "@getpaseo/client";
import {
  getBrowserRoutingState,
  RoutingIpcError,
  routingChangedSchema,
  routingDesktop,
  supportsNetworkTunnel,
  type NetworkTunnelOpener,
  type RoutingDesktop,
} from "./contract";
import { openTunnelProvider, type TunnelProvider } from "./provider";
import { useNetworkRoutingStatus, type NetworkRoutingStatus } from "./status";
import { reloadFailedHostBrowserWebviews } from "../resident-webviews";

// Main announces a renderer handoff through the routing event. Keep one five-minute
// probe as a fallback; if still occupied, wait for routing or connection changes.
const PROVIDER_EXISTS_PROBE_DELAY_MS = 5 * 60 * 1000;

interface NetworkRoutingClient {
  getConnectionState(): { status: string };
  getLastServerInfoMessage(): { features?: { networkTunnel?: boolean } } | null;
  subscribeConnectionStatus(listener: () => void): () => void;
  on(type: "status", listener: () => void): () => void;
}
export function mountNetworkTunnelProvider(input: {
  serverId: string;
  client: NetworkRoutingClient;
  openTunnel: NetworkTunnelOpener;
  desktop?: RoutingDesktop;
  onError?: (error: unknown) => void;
  onReady?: () => void;
}): () => void {
  const desktop = input.desktop ?? routingDesktop;
  const disposers: Array<() => void> = [];
  let enabled = false;
  let disposed = false;
  let revision = 0;
  let generation = 0;
  let active = false;
  let provider: TunnelProvider | null = null;
  let unsubscribeProvider: (() => void) | null = null;
  let transition = Promise.resolve();
  let preparation: AbortController | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let retryAttempt = 0;
  let permissionDenied = false;
  let providerExists = false;
  let ownershipProbeUsed = false;
  let connectionStatus = input.client.getConnectionState().status;
  let serverInfo = input.client.getLastServerInfoMessage();
  const setStatus = (status: NetworkRoutingStatus) =>
    useNetworkRoutingStatus.getState().setStatus(input.serverId, status);
  function wanted() {
    return (
      !disposed &&
      enabled &&
      input.client.getConnectionState().status === "connected" &&
      supportsNetworkTunnel(input.client.getLastServerInfoMessage()?.features)
    );
  }
  function report(error: unknown) {
    if (
      error instanceof NetworkTunnelRpcError &&
      error.operation === "open" &&
      (error.code === "permission_denied" || error.code === "access_denied")
    ) {
      permissionDenied = true;
      setStatus("permission_denied");
      return;
    }
    if (error instanceof RoutingIpcError && error.code === "provider_exists") {
      providerExists = true;
      // Another window is healthy, so this window is waiting rather than connecting.
      setStatus("idle");
      return;
    }
    input.onError?.(error);
  }
  function scheduleRetry(current: number) {
    if (current !== generation || !wanted() || retry !== null) return;
    active = false;
    if (permissionDenied) return;
    let delay = Math.min(1000 * 2 ** Math.min(retryAttempt++, 5), 30000);
    if (providerExists) {
      if (ownershipProbeUsed) return;
      ownershipProbeUsed = true;
      delay = PROVIDER_EXISTS_PROBE_DELAY_MS;
    }
    retry = setTimeout(() => {
      retry = null;
      providerExists = false;
      reconcile();
    }, delay);
  }
  function resetOwnershipWait() {
    if (providerExists && retry !== null) {
      clearTimeout(retry);
      retry = null;
    }
    providerExists = false;
    ownershipProbeUsed = false;
  }
  function reconcile() {
    const shouldOpen = wanted();
    if (!shouldOpen) {
      if (retry !== null) clearTimeout(retry);
      retry = null;
      retryAttempt = 0;
      setStatus("idle");
    }
    if (shouldOpen && (active || retry !== null || permissionDenied || providerExists)) return;
    if (!shouldOpen && !active && !provider && !preparation) return;
    active = shouldOpen;
    const current = ++generation;
    unsubscribeProvider?.();
    unsubscribeProvider = null;
    preparation?.abort();
    const controller = new AbortController();
    preparation = shouldOpen ? controller : null;
    transition = transition
      .then(async () => {
        const previous = provider;
        provider = null;
        try {
          await previous?.close();
        } catch (error) {
          report(error);
        }
        if (!shouldOpen || current !== generation) return;
        if (
          useNetworkRoutingStatus.getState().hosts[input.serverId]?.status !== "permission_denied"
        )
          setStatus("connecting");
        try {
          const opened = await openTunnelProvider({
            serverId: input.serverId,
            openTunnel: input.openTunnel,
            desktop,
            onError: report,
            signal: controller.signal,
          });
          if (current !== generation) {
            try {
              await opened.close();
            } catch (error) {
              report(error);
            }
            return;
          }
          provider = opened;
          unsubscribeProvider = opened.onClosed(() => {
            if (current !== generation) return;
            if (
              useNetworkRoutingStatus.getState().hosts[input.serverId]?.status !==
              "permission_denied"
            )
              setStatus("connecting");
            scheduleRetry(current);
          });
          if (!active) return;
          retryAttempt = 0;
          resetOwnershipWait();
          setStatus("ready");
          input.onReady?.();
        } catch (error) {
          if (current !== generation) return;
          report(error);
          scheduleRetry(current);
        }
        return;
      })
      .catch((error) => {
        report(error);
        scheduleRetry(current);
      });
  }
  disposers.push(
    input.client.subscribeConnectionStatus(() => {
      const nextStatus = input.client.getConnectionState().status;
      const changed = nextStatus !== connectionStatus;
      if (changed) {
        permissionDenied = false;
        resetOwnershipWait();
      }
      connectionStatus = nextStatus;
      if (!changed && permissionDenied) return;
      reconcile();
    }),
  );
  disposers.push(
    input.client.on("status", () => {
      const nextServerInfo = input.client.getLastServerInfoMessage();
      if (nextServerInfo === serverInfo) return;
      serverInfo = nextServerInfo;
      permissionDenied = false;
      reconcile();
    }),
  );
  void (async () => {
    const unlisten = await desktop.listen("browser_routing_changed", (raw) => {
      const event = routingChangedSchema.parse(raw);
      if (event.serverId !== input.serverId || disposed) return;
      revision++;
      // Main re-emits the current value when the owning renderer releases the provider
      // (closed, crashed or disconnected). The same `enabled` value is a handoff signal.
      resetOwnershipWait();
      const changed = event.enabled !== enabled;
      if (changed) permissionDenied = false;
      enabled = event.enabled;
      if (!changed && permissionDenied) return;
      reconcile();
    });
    if (disposed) {
      unlisten();
      return;
    }
    disposers.push(unlisten);
    const requestedRevision = revision;
    const state = await getBrowserRoutingState(input.serverId, desktop);
    if (disposed || requestedRevision !== revision) return;
    enabled = state;
    reconcile();
  })().catch(report);
  return () => {
    disposed = true;
    for (const dispose of disposers) dispose();
    reconcile();
  };
}
export function mountClientNetworkRouting(client: DaemonClient, serverId: string): () => void {
  if (!getIsElectron()) return () => {};
  return mountNetworkTunnelProvider({
    client,
    serverId,
    openTunnel: () => client.openNetworkTunnel(),
    // Registration readiness reloads -130/-111/-324/-100/503 once per provider generation.
    // A site's own 503 intentionally qualifies for that single reload.
    onReady: () => reloadFailedHostBrowserWebviews(serverId),
    onError: (error) => console.error("[browser-routing] provider failed", error),
  });
}
