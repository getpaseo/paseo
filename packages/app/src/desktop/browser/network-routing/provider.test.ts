import { useNetworkRoutingStatus } from "./status";
import {
  NetworkTunnelError,
  NetworkTunnelRpcError,
  type NetworkTunnel,
  type NetworkTunnelStreamHandlers,
} from "@getpaseo/client";
import { mountNetworkTunnelProvider } from "./lifecycle";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openTunnelProvider } from "./provider";
import {
  getBrowserRoutingState,
  getRoutingOptionAvailability,
  resolveBrowserPartition,
  supportsNetworkTunnel,
  type RoutingDesktop,
} from "./contract";
import { getHostNetworkLoadError } from "./load-error";

const serverId = "host-a";
const providerId = "00000000-0000-4000-8000-000000000001";
const streamId = "00000000-0000-4000-8000-000000000002";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function settle() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}
function clientHarness() {
  let connected = true;
  let serverInfo = { features: { networkTunnel: true } };
  const statusListeners = new Set<() => void>();
  const infoListeners = new Set<() => void>();
  const client = {
    getConnectionState: () => ({ status: connected ? "connected" : "disconnected" }),
    getLastServerInfoMessage: () => serverInfo,
    subscribeConnectionStatus: (callback: () => void) => {
      statusListeners.add(callback);
      return () => {
        statusListeners.delete(callback);
      };
    },
    on: (_type: "status", callback: () => void) => {
      infoListeners.add(callback);
      return () => {
        infoListeners.delete(callback);
      };
    },
  };
  return {
    client,
    statusListeners,
    infoListeners,
    connect: (value: boolean) => {
      connected = value;
      for (const listener of statusListeners) listener();
    },
    feature: (value: boolean) => {
      serverInfo = { features: { networkTunnel: value } };
      for (const listener of infoListeners) listener();
    },
    status: () => {
      for (const listener of infoListeners) listener();
    },
  };
}

function harness() {
  const listeners = new Map<string, (payload: unknown) => void>();
  const invoke = vi.fn<RoutingDesktop["invoke"]>(async () => ({ ok: true }));
  invoke.mockImplementation(async (command) =>
    command === "network_tunnel_provider_register" ? { ok: true, providerId } : { ok: true },
  );
  const desktop: RoutingDesktop = {
    invoke,
    listen: async (event, listener) => {
      listeners.set(event, listener);
      return () => {
        listeners.delete(event);
      };
    },
  };
  let handlers: NetworkTunnelStreamHandlers;
  let closed: (() => void) | undefined;
  const stream = { streamId, write: vi.fn(), consume: vi.fn(), close: vi.fn() };
  const openStream = vi.fn<NetworkTunnel["openStream"]>((_target, callbacks) => {
    handlers = callbacks;
    return stream;
  });
  const tunnel: NetworkTunnel = {
    subscriptionId: "00000000-0000-4000-8000-000000000003",
    limits: { initialWindowBytes: 4, maxDataBytes: 4, maxStreams: 1, connectTimeoutMs: 100 },
    openStream,
    close: vi.fn(async () => {}),
    onClosed: (listener) => {
      closed = () => listener("disconnected");
      return () => {
        closed = undefined;
      };
    },
  };
  const openTunnel = vi.fn(async () => tunnel);
  const onError = vi.fn();
  function emit(operation: string, payload: Record<string, unknown> = {}) {
    listeners.get(`network_tunnel_${operation}`)?.({ serverId, providerId, streamId, ...payload });
  }
  return {
    desktop,
    invoke,
    listeners,
    stream,
    tunnel,
    openStream,
    openTunnel,
    onError,
    emit,
    callbacks: () => handlers,
    disconnect: () => closed?.(),
    start: () => openTunnelProvider({ serverId, openTunnel, desktop, onError }),
  };
}

describe("network tunnel renderer provider", () => {
  it("opens, registers and forwards bytes with exactly the final consumer's credit", async () => {
    const h = harness();
    const provider = await h.start();
    expect(h.openTunnel).toHaveBeenCalledOnce();
    expect(h.invoke).toHaveBeenCalledWith("network_tunnel_provider_register", {
      serverId,
      subscriptionId: h.tunnel.subscriptionId,
      ...h.tunnel.limits,
    });
    h.emit("stream_open", { host: "intranet", port: 80 });
    expect(h.openStream.mock.calls[0][0]).toEqual({ streamId, host: "intranet", port: 80 });
    expect(h.invoke).not.toHaveBeenCalledWith("network_tunnel_stream_connected", expect.anything());
    h.callbacks().onConnected();
    const data = new Uint8Array([1, 2, 3, 4]);
    h.callbacks().onData(data);
    await settle();
    expect(h.invoke.mock.calls.slice(1)).toEqual([
      ["network_tunnel_stream_connected", { serverId, providerId, streamId }],
      ["network_tunnel_stream_data", { serverId, providerId, streamId, data }],
    ]);
    expect(h.stream.consume).not.toHaveBeenCalled();
    h.emit("stream_credit", { credit: 3 });
    expect(h.stream.consume).toHaveBeenCalledExactlyOnceWith(3);
    h.emit("stream_data", { data });
    expect(h.stream.write).toHaveBeenCalledExactlyOnceWith(data);
    await settle();
    expect(h.invoke).not.toHaveBeenCalledWith("network_tunnel_stream_credit", expect.anything());
    h.callbacks().onCredit(2);
    await settle();
    expect(h.invoke).toHaveBeenCalledWith("network_tunnel_stream_credit", {
      serverId,
      providerId,
      streamId,
      credit: 2,
    });
    h.callbacks().onClose(0);
    await settle();
    expect(h.invoke).toHaveBeenCalledWith("network_tunnel_stream_close", {
      serverId,
      providerId,
      streamId,
      reason: 0,
    });
    await provider.close();
    expect(h.tunnel.close).toHaveBeenCalledOnce();
    expect(h.listeners.size).toBe(0);
  });
  it("serializes invokes even while an earlier acknowledgement is pending", async () => {
    const h = harness();
    const provider = await h.start();
    const ack = deferred<unknown>();
    h.invoke.mockImplementation((command) =>
      command === "network_tunnel_stream_connected" ? ack.promise : Promise.resolve({ ok: true }),
    );
    h.emit("stream_open", { host: "localhost", port: 3000 });
    h.callbacks().onConnected();
    h.callbacks().onData(new Uint8Array([1]));
    h.callbacks().onClose(0);
    await settle();
    expect(h.invoke.mock.calls.map(([command]) => command)).toEqual([
      "network_tunnel_provider_register",
      "network_tunnel_stream_connected",
    ]);
    ack.resolve({ ok: true });
    await settle();
    expect(h.invoke.mock.calls.map(([command]) => command)).toEqual([
      "network_tunnel_provider_register",
      "network_tunnel_stream_connected",
      "network_tunnel_stream_data",
      "network_tunnel_stream_close",
    ]);
    await provider.close();
  });
  it("rejects over-credit and closes the entire provider", async () => {
    const h = harness();
    await h.start();
    h.emit("stream_open", { host: "intranet", port: 80 });
    h.callbacks().onConnected();
    h.emit("stream_credit", { credit: 1 });
    await settle();
    expect(h.stream.consume).not.toHaveBeenCalled();
    expect(h.tunnel.close).toHaveBeenCalledOnce();
    expect(h.onError).toHaveBeenCalledOnce();
  });
  it("does not accept data before Connected", async () => {
    const h = harness();
    await h.start();
    h.emit("stream_open", { host: "intranet", port: 80 });
    h.emit("stream_data", { data: new Uint8Array([1]) });
    await settle();
    expect(h.stream.write).not.toHaveBeenCalled();
    expect(h.tunnel.close).toHaveBeenCalledOnce();
  });
  it("ignores a different owner and does not echo Close", async () => {
    const h = harness();
    const provider = await h.start();
    h.emit("stream_open", { host: "intranet", port: 80, providerId: "stale" });
    expect(h.openStream).not.toHaveBeenCalled();
    h.emit("stream_open", { host: "intranet", port: 80 });
    h.callbacks().onConnected();
    await settle();
    h.stream.close.mockImplementation(() => h.callbacks().onClose(0));
    h.emit("stream_close", { reason: 0 });
    await settle();
    expect(h.stream.close).toHaveBeenCalledExactlyOnceWith(0);
    expect(h.invoke).not.toHaveBeenCalledWith("network_tunnel_stream_close", expect.anything());
    await provider.close();
  });
  it("releases the remote subscription when another window owns the provider", async () => {
    const h = harness();
    h.invoke.mockResolvedValue({
      ok: false,
      error: { code: "provider_exists", message: "Already registered" },
    });
    await expect(h.start()).rejects.toMatchObject({ code: "provider_exists" });
    expect(h.tunnel.close).toHaveBeenCalledOnce();
    expect(h.listeners.size).toBe(0);
  });
  it("cleans up on remote disconnect and desktop provider closure", async () => {
    const h = harness();
    const provider = await h.start();
    h.disconnect();
    await settle();
    await provider.close();
    expect(h.tunnel.close).toHaveBeenCalledOnce();
    expect(h.invoke).toHaveBeenCalledWith("network_tunnel_provider_unregister", {
      serverId,
      providerId,
    });
    const next = harness();
    await next.start();
    next.emit("provider_closed", { reason: "disabled" });
    await settle();
    expect(next.tunnel.close).toHaveBeenCalledOnce();
  });
});

describe("host routing contract", () => {
  it("uses the shared partition only for an explicit routing_disabled result", async () => {
    const h = harness();
    h.invoke.mockResolvedValue({
      ok: false,
      error: { code: "routing_disabled", message: "disabled" },
    });
    expect(await resolveBrowserPartition(serverId, "persist:paseo-browser", h.desktop)).toBe(
      "persist:paseo-browser",
    );
    h.invoke.mockResolvedValue({ ok: true, partition: "persist:paseo-browser-via-abc" });
    expect(await resolveBrowserPartition(serverId, "persist:paseo-browser", h.desktop)).toBe(
      "persist:paseo-browser-via-abc",
    );
    h.invoke.mockResolvedValue({ ok: false, error: { code: "not_ready", message: "Preparing" } });
    await expect(
      resolveBrowserPartition(serverId, "persist:paseo-browser", h.desktop),
    ).rejects.toMatchObject({ code: "not_ready" });
    h.invoke.mockRejectedValue(new Error("IPC disconnected"));
    await expect(
      resolveBrowserPartition(serverId, "persist:paseo-browser", h.desktop),
    ).rejects.toThrow("IPC disconnected");
  });
  it("reads the actual setting and rejects unavailable IPC", async () => {
    const h = harness();
    h.invoke.mockResolvedValue({ ok: true, enabled: true });
    expect(await getBrowserRoutingState(serverId, h.desktop)).toBe(true);
    h.invoke.mockResolvedValue({ ok: false, error: { code: "not_ready", message: "Unavailable" } });
    await expect(getBrowserRoutingState(serverId, h.desktop)).rejects.toThrow("Unavailable");
  });
  it.each([
    [false, false, true, false, true],
    [true, true, true, false, true],
    [true, false, false, true, false],
    [true, false, true, true, true],
  ])(
    "gates Electron=%s local=%s supported=%s",
    (isElectron, isLocal, supported, visible, available) => {
      expect(getRoutingOptionAvailability({ isElectron, isLocal, supported })).toEqual({
        visible,
        available,
      });
    },
  );
  it("requires the host feature", () => {
    expect(supportsNetworkTunnel(undefined)).toBe(false);
    expect(supportsNetworkTunnel({ networkTunnel: false })).toBe(false);
    expect(supportsNetworkTunnel({ networkTunnel: true })).toBe(true);
  });
  it.each([-130, -111, -324, -100])(
    "explains Chromium error %s with the host network",
    (errorCode) => {
      expect(getHostNetworkLoadError({ errorCode }, "Remote Mac")).toContain(
        "network of host Remote Mac",
      );
      expect(getHostNetworkLoadError({ errorCode, isMainFrame: false }, "Remote Mac")).toBeNull();
    },
  );
});

describe("provider connection lifecycle", () => {
  it("starts only when enabled, connected and supported; closes on disable and unmount", async () => {
    const h = harness();
    const c = clientHarness();
    h.invoke.mockImplementation(async (command) => {
      if (command === "browser_routing_get_state") return { ok: true, enabled: false };
      if (command === "network_tunnel_provider_register") return { ok: true, providerId };
      return { ok: true };
    });
    const unmount = mountNetworkTunnelProvider({
      serverId,
      client: c.client,
      openTunnel: h.openTunnel,
      desktop: h.desktop,
      onError: h.onError,
    });
    await settle();
    expect(h.openTunnel).not.toHaveBeenCalled();
    c.connect(false);
    h.listeners.get("browser_routing_changed")?.({ serverId, enabled: true });
    await settle();
    expect(h.openTunnel).not.toHaveBeenCalled();
    c.feature(false);
    c.connect(true);
    await settle();
    expect(h.openTunnel).not.toHaveBeenCalled();
    c.feature(true);
    await settle();
    expect(h.openTunnel).toHaveBeenCalledOnce();
    h.listeners.get("browser_routing_changed")?.({ serverId, enabled: false });
    await settle();
    expect(h.tunnel.close).toHaveBeenCalledOnce();
    unmount();
    expect(h.listeners.size).toBe(0);
    expect(c.statusListeners.size).toBe(0);
    expect(c.infoListeners.size).toBe(0);
  });
  it("cancels an opening subscription before registering a replacement on reconnect", async () => {
    const h = harness();
    const c = clientHarness();
    const opening = deferred<NetworkTunnel>();
    h.openTunnel.mockReturnValueOnce(opening.promise);
    h.invoke.mockImplementation(async (command) => {
      if (command === "browser_routing_get_state") return { ok: true, enabled: true };
      if (command === "network_tunnel_provider_register") return { ok: true, providerId };
      return { ok: true };
    });
    const unmount = mountNetworkTunnelProvider({
      serverId,
      client: c.client,
      openTunnel: h.openTunnel,
      desktop: h.desktop,
    });
    await settle();
    expect(h.openTunnel).toHaveBeenCalledOnce();
    c.connect(false);
    c.connect(true);
    await settle();
    expect(h.openTunnel).toHaveBeenCalledOnce();
    opening.resolve(h.tunnel);
    await settle();
    await settle();
    expect(h.openTunnel).toHaveBeenCalledTimes(2);
    expect(h.invoke.mock.calls.map(([command]) => command)).toEqual([
      "browser_routing_get_state",
      "network_tunnel_provider_register",
    ]);
    unmount();
    await settle();
    expect(h.tunnel.close).toHaveBeenCalledTimes(2);
  });
  it("closes a late opening result after unmount", async () => {
    const h = harness();
    const c = clientHarness();
    const opening = deferred<NetworkTunnel>();
    h.openTunnel.mockReturnValue(opening.promise);
    h.invoke.mockImplementation(async (command) => {
      if (command === "browser_routing_get_state") return { ok: true, enabled: true };
      if (command === "network_tunnel_provider_register") return { ok: true, providerId };
      return { ok: true };
    });
    const unmount = mountNetworkTunnelProvider({
      serverId,
      client: c.client,
      openTunnel: h.openTunnel,
      desktop: h.desktop,
    });
    await settle();
    unmount();
    opening.resolve(h.tunnel);
    await settle();
    await settle();
    expect(h.tunnel.close).toHaveBeenCalledOnce();
    expect(h.listeners.size).toBe(0);
  });
});

it("releases listeners if the tunnel closes while desktop listeners are being installed", async () => {
  const h = harness();
  const listening = deferred<() => void>();
  const dispose = vi.fn();
  h.desktop.listen = () => listening.promise;
  const opening = h.start();
  await settle();
  h.disconnect();
  listening.resolve(dispose);
  const provider = await opening;
  await provider.close();
  expect(dispose).toHaveBeenCalledOnce();
  expect(h.tunnel.close).toHaveBeenCalledOnce();
  expect(h.invoke).not.toHaveBeenCalled();
});
it("unregisters a late registration after cancellation", async () => {
  const h = harness();
  const registered = deferred<unknown>();
  const controller = new AbortController();
  h.invoke.mockImplementation((command) =>
    command === "network_tunnel_provider_register"
      ? registered.promise
      : Promise.resolve({ ok: true }),
  );
  const opening = openTunnelProvider({
    serverId,
    desktop: h.desktop,
    openTunnel: h.openTunnel,
    signal: controller.signal,
  });
  await settle();
  controller.abort();
  await settle();
  expect(h.tunnel.close).toHaveBeenCalledOnce();
  registered.resolve({ ok: true, providerId });
  await opening;
  expect(h.invoke).toHaveBeenCalledWith("network_tunnel_provider_unregister", {
    serverId,
    providerId,
  });
  expect(h.listeners.size).toBe(0);
});
it("preserves the host network explanation when loadURL rejects with a Chromium message", () => {
  expect(
    getHostNetworkLoadError(new Error("net::ERR_TUNNEL_CONNECTION_FAILED (-111)"), "Remote Mac"),
  ).toContain("network of host Remote Mac");
});

it("ignores an unknown_stream ACK after the main has already closed the stream", async () => {
  const h = harness();
  const provider = await h.start();
  const ack = deferred<unknown>();
  h.invoke.mockImplementation((command) =>
    command === "network_tunnel_stream_data" ? ack.promise : Promise.resolve({ ok: true }),
  );
  h.emit("stream_open", { host: "intranet", port: 80 });
  h.callbacks().onConnected();
  await settle();
  h.callbacks().onData(new Uint8Array([1]));
  await settle();
  h.emit("stream_close", { reason: 0 });
  ack.resolve({ ok: false, error: { code: "unknown_stream", message: "closed" } });
  await settle();
  expect(h.stream.close).toHaveBeenCalledExactlyOnceWith(0);
  expect(h.tunnel.close).not.toHaveBeenCalled();
  expect(h.onError).not.toHaveBeenCalled();
  h.emit("stream_open", {
    streamId: "00000000-0000-4000-8000-000000000004",
    host: "intranet",
    port: 80,
  });
  h.callbacks().onConnected();
  await settle();
  expect(h.openStream).toHaveBeenCalledTimes(2);
  await provider.close();
});
it.each([
  ["unknown_stream", 0],
  ["protocol_error", 8],
] as const)("isolates the stream ACK %s", async (code, reason) => {
  const h = harness();
  const provider = await h.start();
  h.invoke.mockResolvedValue({ ok: false, error: { code, message: code } });
  h.emit("stream_open", { host: "intranet", port: 80 });
  h.callbacks().onConnected();
  await settle();
  expect(h.stream.close).toHaveBeenCalledExactlyOnceWith(reason);
  expect(h.tunnel.close).not.toHaveBeenCalled();
  await provider.close();
});
it.each(["not_owner", "provider_unavailable", "invalid_payload"])(
  "fails the provider for %s",
  async (code) => {
    const h = harness();
    await h.start();
    h.invoke.mockResolvedValue({ ok: false, error: { code, message: code } });
    h.emit("stream_open", { host: "intranet", port: 80 });
    h.callbacks().onConnected();
    await settle();
    expect(h.tunnel.close).toHaveBeenCalledOnce();
  },
);
it.each([
  [new NetworkTunnelError("stream_limit", "full"), 7],
  [new NetworkTunnelError("duplicate_stream", "duplicate"), 1],
  [new RangeError("bad host"), 1],
] as const)("closes only the failed open: %s", async (error, reason) => {
  const h = harness();
  const provider = await h.start();
  h.openStream.mockImplementationOnce(() => {
    throw error;
  });
  h.emit("stream_open", { host: "intranet", port: 80 });
  await settle();
  expect(h.invoke).toHaveBeenCalledWith("network_tunnel_stream_close", {
    serverId,
    providerId,
    streamId,
    reason,
  });
  expect(h.tunnel.close).not.toHaveBeenCalled();
  h.emit("stream_open", {
    streamId: "00000000-0000-4000-8000-000000000004",
    host: "localhost",
    port: 80,
  });
  expect(h.openStream).toHaveBeenCalledTimes(2);
  await provider.close();
});
it("reports reason 7 when the renderer's maxStreams is reached", async () => {
  const h = harness();
  const provider = await h.start();
  h.emit("stream_open", { host: "intranet", port: 80 });
  const nextId = "00000000-0000-4000-8000-000000000004";
  h.emit("stream_open", { streamId: nextId, host: "intranet", port: 80 });
  await settle();
  expect(h.openStream).toHaveBeenCalledOnce();
  expect(h.invoke).toHaveBeenCalledWith("network_tunnel_stream_close", {
    serverId,
    providerId,
    streamId: nextId,
    reason: 7,
  });
  expect(h.stream.close).not.toHaveBeenCalled();
  expect(h.tunnel.close).not.toHaveBeenCalled();
  await provider.close();
});

describe("provider recovery", () => {
  afterEach(() => {
    vi.useRealTimers();
    useNetworkRoutingStatus.setState({ hosts: {} });
  });
  function recoveryHarness() {
    vi.useFakeTimers();
    const h = harness();
    const c = clientHarness();
    const onReady = vi.fn();
    h.invoke.mockImplementation(async (command) => {
      if (command === "browser_routing_get_state") return { ok: true, enabled: true };
      if (command === "network_tunnel_provider_register") return { ok: true, providerId };
      return { ok: true };
    });
    return {
      ...h,
      c,
      onReady,
      mount: () =>
        mountNetworkTunnelProvider({
          serverId,
          client: c.client,
          openTunnel: h.openTunnel,
          desktop: h.desktop,
          onError: h.onError,
          onReady,
        }),
    };
  }
  it.each(["daemon", "main", "ipc"])("reopens after %s closes the provider", async (source) => {
    const h = recoveryHarness();
    const unmount = h.mount();
    await settle();
    if (source === "daemon") h.disconnect();
    if (source === "main") h.emit("provider_closed", { reason: "protocol_error" });
    if (source === "ipc") {
      h.invoke.mockRejectedValueOnce(new Error("IPC failure"));
      h.emit("stream_open", { host: "intranet", port: 80 });
      h.callbacks().onConnected();
    }
    await settle();
    expect(h.openTunnel).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(h.openTunnel).toHaveBeenCalledTimes(2);
    expect(h.onReady).toHaveBeenCalledTimes(2);
    unmount();
    await settle();
    expect(vi.getTimerCount()).toBe(0);
  });
  function occupiedWindow() {
    const h = recoveryHarness();
    let occupied = true;
    h.invoke.mockImplementation(async (command) => {
      if (command === "browser_routing_get_state") return { ok: true, enabled: true };
      if (command === "network_tunnel_provider_register") {
        if (occupied)
          return { ok: false, error: { code: "provider_exists", message: "Another window" } };
        return { ok: true, providerId };
      }
      return { ok: true };
    });
    return {
      ...h,
      release: () => {
        occupied = false;
      },
    };
  }
  it("tries once after five minutes so a waiting window can take over", async () => {
    const h = occupiedWindow();
    const unmount = h.mount();
    await settle();
    expect(h.tunnel.close).toHaveBeenCalledOnce();
    expect(h.listeners.size).toBe(1);
    h.c.connect(true);
    h.c.feature(true);
    h.release();
    await vi.advanceTimersByTimeAsync(299999);
    expect(h.openTunnel).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.openTunnel).toHaveBeenCalledTimes(2);
    expect(h.onReady).toHaveBeenCalledOnce();
    expect(h.onError).not.toHaveBeenCalled();
    unmount();
    await settle();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("stays terminal after the single slow attempt also finds another provider", async () => {
    const h = occupiedWindow();
    const unmount = h.mount();
    await settle();
    await vi.advanceTimersByTimeAsync(300000);
    expect(h.openTunnel).toHaveBeenCalledTimes(2);
    expect(h.tunnel.close).toHaveBeenCalledTimes(2);
    h.c.connect(true);
    h.c.feature(true);
    h.listeners.get("browser_routing_changed")!({ serverId: "other-host", enabled: true });
    await vi.advanceTimersByTimeAsync(3600000);
    expect(h.openTunnel).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    unmount();
    await settle();
  });
  it("retries immediately on a connection change while occupied", async () => {
    const h = occupiedWindow();
    const unmount = h.mount();
    await settle();
    h.release();
    h.c.connect(false);
    h.c.connect(true);
    await settle();
    expect(h.openTunnel).toHaveBeenCalledTimes(2);
    expect(h.onReady).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(300000);
    expect(h.openTunnel).toHaveBeenCalledTimes(2);
    unmount();
    await settle();
  });
  it("leaves connecting and retries when the same enabled event announces a handoff", async () => {
    const h = occupiedWindow();
    const unmount = h.mount();
    await settle();
    expect(useNetworkRoutingStatus.getState().hosts[serverId].status).toBe("idle");
    h.release();

    h.listeners.get("browser_routing_changed")!({ serverId, enabled: true });

    await settle();
    expect(h.openTunnel).toHaveBeenCalledTimes(2);
    expect(h.onReady).toHaveBeenCalledOnce();
    expect(useNetworkRoutingStatus.getState().hosts[serverId].status).toBe("ready");
    await vi.advanceTimersByTimeAsync(300000);
    expect(h.openTunnel).toHaveBeenCalledTimes(2);
    unmount();
    await settle();
  });
  it.each(["disable", "unmount"])("cancels the slow ownership probe on %s", async (source) => {
    const h = occupiedWindow();
    const unmount = h.mount();
    await settle();
    if (source === "disable")
      h.listeners.get("browser_routing_changed")!({ serverId, enabled: false });
    else unmount();
    await vi.advanceTimersByTimeAsync(300000);
    expect(h.openTunnel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    unmount();
    await settle();
  });
  it("still opens the replacement when closing the previous provider rejects", async () => {
    const h = recoveryHarness();
    const unmount = h.mount();
    await settle();
    vi.mocked(h.tunnel.close).mockRejectedValueOnce(new Error("Close RPC failed"));
    h.disconnect();
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(h.openTunnel).toHaveBeenCalledTimes(2);
    expect(h.onReady).toHaveBeenCalledTimes(2);
    unmount();
    await settle();
  });
  it.each(["permission_denied", "access_denied"])("stops retrying after %s", async (code) => {
    const h = recoveryHarness();
    h.openTunnel.mockRejectedValue(new NetworkTunnelRpcError("open", code, "Denied"));
    const unmount = h.mount();
    await settle();
    expect(useNetworkRoutingStatus.getState().hosts[serverId].status).toBe("permission_denied");
    h.c.connect(true);
    h.c.status();
    h.listeners.get("browser_routing_changed")!({ serverId, enabled: true });
    await vi.advanceTimersByTimeAsync(120000);
    await settle();
    expect(h.openTunnel).toHaveBeenCalledOnce();
    expect(useNetworkRoutingStatus.getState().hosts[serverId].status).toBe("permission_denied");
    unmount();
    await settle();
  });
  it.each(["reconnect", "routing option", "server info"])(
    "retries a denied open after %s changes",
    async (change) => {
      const h = recoveryHarness();
      h.openTunnel.mockRejectedValueOnce(
        new NetworkTunnelRpcError("open", "permission_denied", "Denied"),
      );
      const unmount = h.mount();
      await settle();
      expect(h.openTunnel).toHaveBeenCalledOnce();
      if (change === "reconnect") {
        h.c.connect(false);
        h.c.connect(true);
      }
      if (change === "routing option") {
        h.listeners.get("browser_routing_changed")!({ serverId, enabled: false });
        h.listeners.get("browser_routing_changed")!({ serverId, enabled: true });
      }
      if (change === "server info") h.c.feature(true);
      await settle();
      expect(h.openTunnel).toHaveBeenCalledTimes(2);
      expect(useNetworkRoutingStatus.getState().hosts[serverId].status).toBe("ready");
      unmount();
      await settle();
    },
  );
  it("keeps exponential backoff for other open failures", async () => {
    const h = recoveryHarness();
    h.openTunnel.mockRejectedValue(new Error("Unavailable"));
    const unmount = h.mount();
    await settle();
    await vi.advanceTimersByTimeAsync(999);
    expect(h.openTunnel).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(h.openTunnel).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(h.openTunnel).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(h.openTunnel).toHaveBeenCalledTimes(3);
    unmount();
    await settle();
  });
  it.each(["disable", "disconnect", "feature", "unmount"])(
    "cancels retry on %s",
    async (action) => {
      const h = recoveryHarness();
      h.openTunnel.mockRejectedValue(new Error("Unavailable"));
      const unmount = h.mount();
      await settle();
      if (action === "disable")
        h.listeners.get("browser_routing_changed")!({ serverId, enabled: false });
      if (action === "disconnect") h.c.connect(false);
      if (action === "feature") h.c.feature(false);
      if (action === "unmount") unmount();
      await vi.advanceTimersByTimeAsync(60000);
      expect(h.openTunnel).toHaveBeenCalledOnce();
      unmount();
      await settle();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
