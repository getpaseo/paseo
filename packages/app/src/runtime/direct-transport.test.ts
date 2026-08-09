import { describe, expect, it } from "vitest";
import { shouldRouteDirectTcpThroughHeaderBridge } from "./direct-transport";

describe("shouldRouteDirectTcpThroughHeaderBridge", () => {
  it("stays on the renderer WebSocket for headerless direct connections", () => {
    expect(
      shouldRouteDirectTcpThroughHeaderBridge({
        headers: undefined,
        hasWebSocketTransportFactory: true,
      }),
    ).toBe(false);
  });

  it("stays on the renderer WebSocket when headers is an empty object", () => {
    expect(
      shouldRouteDirectTcpThroughHeaderBridge({
        headers: {},
        hasWebSocketTransportFactory: true,
      }),
    ).toBe(false);
  });

  it("uses the main-process bridge when custom headers are set", () => {
    expect(
      shouldRouteDirectTcpThroughHeaderBridge({
        headers: { "X-Tenant": "acme" },
        hasWebSocketTransportFactory: true,
      }),
    ).toBe(true);
  });

  it("cannot use the bridge when no bridge factory is available (e.g. non-Electron)", () => {
    expect(
      shouldRouteDirectTcpThroughHeaderBridge({
        headers: { "X-Tenant": "acme" },
        hasWebSocketTransportFactory: false,
      }),
    ).toBe(false);
  });
});
