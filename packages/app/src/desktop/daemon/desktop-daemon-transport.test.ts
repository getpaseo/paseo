import { describe, expect, it, vi } from "vitest";
import {
  createDesktopLocalDaemonTransportFactory,
  createDesktopWebSocketTransportFactory,
} from "./desktop-daemon-transport";
import { createFakeLocalDaemonTransportRpc } from "./test-local-daemon-transport-rpc";

const LOCAL_URL = "paseo+local://socket?path=%2Ftmp%2Fpaseo.sock";

describe("desktop-daemon-transport", () => {
  it("emits open after the session resolves even if the rust open event raced earlier", async () => {
    const rpc = createFakeLocalDaemonTransportRpc();
    const transportFactory = createDesktopLocalDaemonTransportFactory(rpc);
    expect(transportFactory).not.toBeNull();

    const transport = transportFactory!({ url: LOCAL_URL });

    const onOpen = vi.fn();
    transport.onOpen(onOpen);

    rpc.emitEvent({ sessionId: "local-session-1", kind: "open" });
    expect(onOpen).not.toHaveBeenCalled();

    rpc.resolveOpen("local-session-1");
    await Promise.resolve();

    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("cleans up late async setup after the transport is closed", async () => {
    const rpc = createFakeLocalDaemonTransportRpc();
    const cleanup = vi.fn();

    const transportFactory = createDesktopLocalDaemonTransportFactory(rpc);
    expect(transportFactory).not.toBeNull();

    const transport = transportFactory!({ url: LOCAL_URL });

    transport.close();

    rpc.resolveOpen("local-session-2");
    rpc.resolveListen(cleanup);
    await Promise.resolve();
    await Promise.resolve();

    expect(rpc.closedSessions).toEqual(["local-session-2"]);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("forwards remote WebSocket headers and protocols through the desktop bridge", () => {
    const rpc = createFakeLocalDaemonTransportRpc();
    const transportFactory = createDesktopWebSocketTransportFactory(rpc);
    expect(transportFactory).not.toBeNull();

    transportFactory!({
      url: "wss://daemon.example/ws",
      headers: { "X-Tenant": "acme", Authorization: "Bearer secret" },
      protocols: ["paseo.bearer.secret"],
    });

    expect(rpc.openCalls).toEqual([
      {
        transportType: "websocket",
        url: "wss://daemon.example/ws",
        headers: { "X-Tenant": "acme", Authorization: "Bearer secret" },
        protocols: ["paseo.bearer.secret"],
      },
    ]);
  });
});
