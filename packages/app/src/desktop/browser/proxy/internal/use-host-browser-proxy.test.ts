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
});
