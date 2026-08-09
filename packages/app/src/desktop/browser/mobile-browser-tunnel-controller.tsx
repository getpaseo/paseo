import { useEffect, useRef } from "react";
import type { TcpTunnelStream } from "@getpaseo/client/internal/daemon-client";
import { Buffer } from "buffer";
import { useAppVisible } from "@/hooks/use-app-visible";
import {
  mobileBrowserProxy,
  type MobileBrowserProxyConnectionCloseEvent,
  type MobileBrowserProxyConnectionDataEvent,
  type MobileBrowserProxyConnectionOpenEvent,
} from "@/native/mobile-browser-proxy";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import {
  setMobileBrowserTunnelFailure,
  setMobileBrowserTunnelIdle,
  setMobileBrowserTunnelNotice,
  setMobileBrowserTunnelReady,
  setMobileBrowserTunnelStarting,
  useMobileBrowserTunnelStore,
} from "./mobile-browser-tunnel-state";

interface ActiveMobileTunnel {
  sessionId: string;
  stream: TcpTunnelStream;
  disposeData: () => void;
  disposeClose: () => void;
}

function encodeBinaryToBase64(data: Uint8Array): string {
  return Buffer.from(data).toString("base64");
}

function decodeBase64ToBytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, "base64"));
}

function disposeTunnel(connectionId: string, active: ActiveMobileTunnel, reason: string): void {
  active.disposeData();
  active.disposeClose();
  active.stream.close(reason);
  mobileBrowserProxy.closeConnection(connectionId, reason);
}

function isCurrentProxySession(serverId: string, sessionId: string): boolean {
  const state = useMobileBrowserTunnelStore.getState();
  return (
    state.activeServerId === serverId &&
    state.status === "ready" &&
    state.session?.sessionId === sessionId
  );
}

async function openMobileBrowserTunnel(input: {
  activeTunnels: Map<string, ActiveMobileTunnel>;
  canceledOpenConnections: Set<string>;
  request: MobileBrowserProxyConnectionOpenEvent;
  serverId: string;
}): Promise<void> {
  const { activeTunnels, canceledOpenConnections, request, serverId } = input;
  const client = getHostRuntimeStore().getSnapshot(serverId)?.client ?? null;
  if (!client?.isConnected) {
    mobileBrowserProxy.rejectConnection(
      request.connectionId,
      502,
      "Workspace host is not connected.",
    );
    return;
  }
  if (client.getLastServerInfoMessage()?.features?.tcpTunnel !== true) {
    mobileBrowserProxy.rejectConnection(
      request.connectionId,
      426,
      "Update the host to use Browser.",
    );
    return;
  }

  try {
    const stream = await client.openTcpTunnel(request.port, { host: request.host });
    if (
      canceledOpenConnections.delete(request.connectionId) ||
      !isCurrentProxySession(serverId, request.sessionId)
    ) {
      stream.close("Android Browser tunnel open was canceled.");
      mobileBrowserProxy.closeConnection(
        request.connectionId,
        "The selected workspace host changed.",
      );
      return;
    }

    const disposeData = stream.onData((data) => {
      mobileBrowserProxy.writeConnection(request.connectionId, encodeBinaryToBase64(data));
    });
    const disposeClose = stream.onClose((reason) => {
      activeTunnels.delete(request.connectionId);
      mobileBrowserProxy.closeConnection(request.connectionId, reason);
    });
    activeTunnels.set(request.connectionId, {
      sessionId: request.sessionId,
      stream,
      disposeData,
      disposeClose,
    });
    try {
      stream.write(decodeBase64ToBytes(request.initialDataBase64));
      mobileBrowserProxy.acceptConnection(request.connectionId);
    } catch (error: unknown) {
      activeTunnels.delete(request.connectionId);
      disposeData();
      disposeClose();
      stream.close("Android Browser tunnel initialization failed.");
      throw error;
    }
  } catch (error: unknown) {
    if (
      canceledOpenConnections.delete(request.connectionId) ||
      !isCurrentProxySession(serverId, request.sessionId)
    ) {
      return;
    }
    mobileBrowserProxy.rejectConnection(
      request.connectionId,
      502,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function startMobileBrowserProxyRoute(
  serverId: string,
  isCanceled: () => boolean,
): Promise<void> {
  try {
    const session = await mobileBrowserProxy.startProxy();
    if (!isCanceled()) {
      setMobileBrowserTunnelReady(serverId, session);
    }
  } catch (error: unknown) {
    if (!isCanceled()) {
      setMobileBrowserTunnelFailure(
        serverId,
        "error",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

export function MobileBrowserTunnelController() {
  const activeServerId = useMobileBrowserTunnelStore((state) => state.activeServerId);
  const isAppVisible = useAppVisible();
  const activeTunnelsRef = useRef(new Map<string, ActiveMobileTunnel>());
  const pendingOpenConnectionsRef = useRef(new Set<string>());
  const canceledOpenConnectionsRef = useRef(new Set<string>());

  useEffect(() => {
    if (!mobileBrowserProxy.isAvailable) {
      return;
    }

    const activeTunnels = activeTunnelsRef.current;
    const pendingOpenConnections = pendingOpenConnectionsRef.current;
    const canceledOpenConnections = canceledOpenConnectionsRef.current;

    const openSubscription = mobileBrowserProxy.addConnectionOpenListener(
      (request: MobileBrowserProxyConnectionOpenEvent) => {
        const state = useMobileBrowserTunnelStore.getState();
        const serverId = state.activeServerId;
        if (!serverId || state.session?.sessionId !== request.sessionId) {
          mobileBrowserProxy.rejectConnection(
            request.connectionId,
            502,
            "The selected workspace host changed.",
          );
          return;
        }

        canceledOpenConnections.delete(request.connectionId);
        pendingOpenConnections.add(request.connectionId);
        void openMobileBrowserTunnel({
          activeTunnels,
          canceledOpenConnections,
          request,
          serverId,
        }).finally(() => pendingOpenConnections.delete(request.connectionId));
      },
    );

    const dataSubscription = mobileBrowserProxy.addConnectionDataListener(
      (event: MobileBrowserProxyConnectionDataEvent) => {
        const active = activeTunnels.get(event.connectionId);
        if (!active || active.sessionId !== event.sessionId) {
          return;
        }
        try {
          active.stream.write(decodeBase64ToBytes(event.binaryBase64));
        } catch (error: unknown) {
          activeTunnels.delete(event.connectionId);
          disposeTunnel(
            event.connectionId,
            active,
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    );

    const closeSubscription = mobileBrowserProxy.addConnectionCloseListener(
      (event: MobileBrowserProxyConnectionCloseEvent) => {
        const active = activeTunnels.get(event.connectionId);
        if (!active) {
          const currentSessionId = useMobileBrowserTunnelStore.getState().session?.sessionId;
          if (
            currentSessionId === event.sessionId &&
            pendingOpenConnections.has(event.connectionId)
          ) {
            canceledOpenConnections.add(event.connectionId);
          }
          return;
        }
        if (active.sessionId !== event.sessionId) {
          return;
        }
        activeTunnels.delete(event.connectionId);
        active.disposeData();
        active.disposeClose();
        active.stream.close(event.reason ?? "Android Browser proxy connection closed.");
      },
    );

    const errorSubscription = mobileBrowserProxy.addConnectionErrorListener((event) => {
      console.warn("[mobile-browser-proxy]", event.message);
      const state = useMobileBrowserTunnelStore.getState();
      if (state.activeServerId && state.session?.sessionId === event.sessionId) {
        setMobileBrowserTunnelNotice(state.activeServerId, event.message);
      }
    });

    return () => {
      openSubscription.remove();
      dataSubscription.remove();
      closeSubscription.remove();
      errorSubscription.remove();
      for (const [connectionId, active] of activeTunnels) {
        disposeTunnel(connectionId, active, "Android Browser controller stopped.");
      }
      activeTunnels.clear();
      pendingOpenConnections.clear();
      canceledOpenConnections.clear();
    };
  }, []);

  useEffect(() => {
    for (const [connectionId, active] of activeTunnelsRef.current) {
      disposeTunnel(connectionId, active, "Workspace host changed.");
    }
    activeTunnelsRef.current.clear();
    pendingOpenConnectionsRef.current.clear();
    canceledOpenConnectionsRef.current.clear();

    if (!activeServerId) {
      void mobileBrowserProxy.stopProxy();
      return;
    }

    const serverId = activeServerId;
    let canceled = false;

    if (!mobileBrowserProxy.isAvailable) {
      setMobileBrowserTunnelFailure(
        serverId,
        "unsupported",
        "Update the Android app to use the workspace Browser.",
      );
      return;
    }
    if (!isAppVisible) {
      setMobileBrowserTunnelIdle(serverId);
      void mobileBrowserProxy.stopProxy();
      return;
    }

    const support = mobileBrowserProxy.getSupportStatus();
    if (!support.proxyOverride || !support.reverseBypass) {
      setMobileBrowserTunnelFailure(
        serverId,
        "unsupported",
        "Update Android System WebView to use Browser.",
      );
      return;
    }

    setMobileBrowserTunnelStarting(serverId);
    void startMobileBrowserProxyRoute(serverId, () => canceled);

    return () => {
      canceled = true;
      void mobileBrowserProxy.stopProxy();
    };
  }, [activeServerId, isAppVisible]);

  return null;
}
