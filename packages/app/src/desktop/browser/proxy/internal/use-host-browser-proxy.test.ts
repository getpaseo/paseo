import { describe, expect, it } from "vitest";
import { resolveBrowserProxyPaneState } from "./use-host-browser-proxy";

const noop = () => {};

describe("resolveBrowserProxyPaneState", () => {
  it("fails closed while connecting or offline before a host partition has been prepared", () => {
    expect(
      resolveBrowserProxyPaneState({
        routing: { kind: "remote", support: "host_connecting" },
        effectiveRoutingMode: "host",
        localPartition: "persist:paseo-browser",
        hostLabel: "devbox",
        proxyStatusSnapshot: null,
        ensureError: null,
        onRetry: noop,
      }),
    ).toEqual({
      kind: "connecting",
      isRemoteHost: true,
      effectiveRoutingMode: "host",
      hostLabel: "devbox",
      isReconnecting: false,
    });

    expect(
      resolveBrowserProxyPaneState({
        routing: { kind: "remote", support: "host_offline" },
        effectiveRoutingMode: "host",
        localPartition: "persist:paseo-browser",
        hostLabel: "devbox",
        proxyStatusSnapshot: {
          serverId: "srv-remote",
          partition: "persist:paseo-browser-host-0123456789abcdef",
          status: "connecting",
          error: null,
          socksPort: null,
        },
        ensureError: null,
        onRetry: noop,
      }),
    ).toEqual({
      kind: "host_offline",
      isRemoteHost: true,
      effectiveRoutingMode: "host",
      hostLabel: "devbox",
    });
  });

  it("keeps the prepared host partition mounted across transient host disconnects and reconnects", () => {
    const preparedSnapshot = {
      serverId: "srv-remote",
      partition: "persist:paseo-browser-host-0123456789abcdef",
      status: "ready" as const,
      error: null,
      socksPort: 41234,
    };

    expect(
      resolveBrowserProxyPaneState({
        routing: { kind: "remote", support: "host_offline" },
        effectiveRoutingMode: "host",
        localPartition: "persist:paseo-browser",
        hostLabel: "devbox",
        proxyStatusSnapshot: preparedSnapshot,
        ensureError: null,
        onRetry: noop,
      }),
    ).toEqual({
      kind: "ready",
      partition: preparedSnapshot.partition,
      isRemoteHost: true,
      effectiveRoutingMode: "host",
      hostLabel: "devbox",
      proxyStatus: "reconnecting",
    });

    expect(
      resolveBrowserProxyPaneState({
        routing: { kind: "remote", support: "host_connecting" },
        effectiveRoutingMode: "host",
        localPartition: "persist:paseo-browser",
        hostLabel: "devbox",
        proxyStatusSnapshot: preparedSnapshot,
        ensureError: null,
        onRetry: noop,
      }),
    ).toEqual({
      kind: "ready",
      partition: preparedSnapshot.partition,
      isRemoteHost: true,
      effectiveRoutingMode: "host",
      hostLabel: "devbox",
      proxyStatus: "reconnecting",
    });
  });

  it("keeps the prepared host partition mounted when a background poll left cached status in error as host returns online", () => {
    const supportedRouting = {
      kind: "remote" as const,
      support: "supported" as const,
      target: { type: "directTcp" as const, endpoint: "10.0.0.5:6767" },
    };

    expect(
      resolveBrowserProxyPaneState({
        routing: supportedRouting,
        effectiveRoutingMode: "host",
        localPartition: "persist:paseo-browser",
        hostLabel: "devbox",
        proxyStatusSnapshot: {
          serverId: "srv-remote",
          partition: "persist:paseo-browser-host-0123456789abcdef",
          status: "error",
          error: "Host disconnected",
          socksPort: 41234,
        },
        ensureError: null,
        onRetry: noop,
      }),
    ).toEqual({
      kind: "ready",
      partition: "persist:paseo-browser-host-0123456789abcdef",
      isRemoteHost: true,
      effectiveRoutingMode: "host",
      hostLabel: "devbox",
      proxyStatus: "error",
    });

    // Once the live snapshot recovers to ready, a stale hook-local ensureError
    // must not pin the prepared pill dot to error.
    expect(
      resolveBrowserProxyPaneState({
        routing: supportedRouting,
        effectiveRoutingMode: "host",
        localPartition: "persist:paseo-browser",
        hostLabel: "devbox",
        proxyStatusSnapshot: {
          serverId: "srv-remote",
          partition: "persist:paseo-browser-host-0123456789abcdef",
          status: "ready",
          error: null,
          socksPort: 41234,
        },
        ensureError: "Unable to create ticket",
        onRetry: noop,
      }),
    ).toEqual({
      kind: "ready",
      partition: "persist:paseo-browser-host-0123456789abcdef",
      isRemoteHost: true,
      effectiveRoutingMode: "host",
      hostLabel: "devbox",
      proxyStatus: "ready",
    });

    // Unprepared partition (socksPort === null) still fails closed with proxy_error.
    expect(
      resolveBrowserProxyPaneState({
        routing: supportedRouting,
        effectiveRoutingMode: "host",
        localPartition: "persist:paseo-browser",
        hostLabel: "devbox",
        proxyStatusSnapshot: {
          serverId: "srv-remote",
          partition: "persist:paseo-browser-host-0123456789abcdef",
          status: "error",
          error: "Unable to create ticket",
          socksPort: null,
        },
        ensureError: null,
        onRetry: noop,
      }),
    ).toEqual({
      kind: "proxy_error",
      isRemoteHost: true,
      effectiveRoutingMode: "host",
      hostLabel: "devbox",
      message: "Unable to create ticket",
      retry: noop,
    });
  });
});
