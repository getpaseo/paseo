import { TunnelCloseReason } from "@getpaseo/protocol/binary-frames/tunnel";
import {
  TUNNEL_CONNECT_TIMEOUT_MS,
  TUNNEL_INITIAL_WINDOW_BYTES,
  TUNNEL_MAX_DATA_BYTES,
  TUNNEL_MAX_STREAMS,
} from "@getpaseo/protocol/network-tunnel/rpc-schemas";
import { describe, expect, test } from "vitest";
import type { TunnelStreamSink } from "./local-proxy.js";
import { TunnelBridge, type TunnelBridgeEvent } from "./tunnel-bridge.js";

const LIMITS = {
  initialWindowBytes: 1024,
  maxDataBytes: 256,
  maxStreams: 2,
  connectTimeoutMs: 1_000,
};

interface Emitted {
  senderId: number;
  event: TunnelBridgeEvent;
}

class FakeSink implements TunnelStreamSink {
  public connected = 0;
  public readonly data: Array<{ data: Uint8Array; consumed: () => void }> = [];
  public closeReasons: number[] = [];

  public onConnected(): void {
    this.connected += 1;
  }

  public onData(data: Uint8Array, consumed: () => void): void {
    this.data.push({ data, consumed });
  }

  public onClose(reason: number): void {
    this.closeReasons.push(reason);
  }
}

function createHarness(options: { deadSenders?: Set<number> } = {}) {
  const emitted: Emitted[] = [];
  const timers: Array<{ callback: () => void; delayMs: number; cleared: boolean }> = [];
  let nextId = 0;
  const bridge = new TunnelBridge({
    emit: (senderId, event) => {
      if (options.deadSenders?.has(senderId)) return false;
      emitted.push({ senderId, event });
      return true;
    },
    setTimeout: (callback, delayMs) => {
      const timer = { callback, delayMs, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      if (timer) (timer as { cleared: boolean }).cleared = true;
    },
    generateId: () => `id-${(nextId += 1)}`,
  });
  const eventsNamed = <T extends TunnelBridgeEvent["name"]>(name: T) =>
    emitted
      .filter((entry) => entry.event.name === name)
      .map((entry) => entry.event.payload as Extract<TunnelBridgeEvent, { name: T }>["payload"]);
  return { bridge, emitted, timers, eventsNamed };
}

function register(bridge: TunnelBridge, senderId = 1, serverId = "server-a"): string {
  const result = bridge.register(senderId, { serverId, subscriptionId: "sub-1", ...LIMITS });
  if (!result.ok) throw new Error(result.error.code);
  return result.providerId;
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("TunnelBridge providers", () => {
  test("allows one provider per host and binds it to the registering renderer", () => {
    const { bridge } = createHarness();
    const providerId = register(bridge, 1);

    const second = bridge.register(2, { serverId: "server-a", subscriptionId: "sub-2", ...LIMITS });
    expect(second).toEqual({
      ok: false,
      error: { code: "provider_exists", message: expect.any(String) },
    });

    const foreign = bridge.unregister(2, { serverId: "server-a", providerId });
    expect(foreign.ok).toBe(false);
    expect(!foreign.ok && foreign.error.code).toBe("not_owner");

    const stale = bridge.unregister(1, { serverId: "server-a", providerId: "old-provider" });
    expect(!stale.ok && stale.error.code).toBe("not_owner");

    expect(bridge.unregister(1, { serverId: "server-a", providerId })).toEqual({ ok: true });
    expect(bridge.hasProvider("server-a")).toBe(false);
    const missing = bridge.streamConnected(1, { serverId: "server-a", providerId, streamId: "x" });
    expect(!missing.ok && missing.error.code).toBe("provider_unavailable");
  });

  test("caps every registered limit at the protocol ceiling", async () => {
    const { bridge, timers, eventsNamed } = createHarness();
    const result = bridge.register(1, {
      serverId: "server-a",
      subscriptionId: "sub-1",
      initialWindowBytes: TUNNEL_INITIAL_WINDOW_BYTES * 4,
      maxDataBytes: TUNNEL_MAX_DATA_BYTES * 4,
      maxStreams: TUNNEL_MAX_STREAMS + 1,
      connectTimeoutMs: TUNNEL_CONNECT_TIMEOUT_MS * 10,
    });
    expect(result).toEqual({ ok: true, providerId: "id-1" });

    const sinks = Array.from({ length: TUNNEL_MAX_STREAMS + 1 }, () => new FakeSink());
    const handles = sinks.map((sink) =>
      bridge.openStreamFor("server-a", { host: "intranet.invalid", port: 80 }, sink),
    );
    await flushMicrotasks();
    expect(eventsNamed("network_tunnel_stream_open")).toHaveLength(TUNNEL_MAX_STREAMS);
    expect(sinks.map((sink) => sink.closeReasons)).toEqual([
      ...Array.from({ length: TUNNEL_MAX_STREAMS }, () => []),
      [TunnelCloseReason.StreamLimit],
    ]);
    expect(timers[0].delayMs).toBe(TUNNEL_CONNECT_TIMEOUT_MS + 5_000);

    const first = eventsNamed("network_tunnel_stream_open")[0];
    expect(bridge.streamConnected(1, first)).toEqual({ ok: true });
    handles[0]!.write(
      new Uint8Array(TUNNEL_INITIAL_WINDOW_BYTES + TUNNEL_MAX_DATA_BYTES).fill(1),
      () => {},
    );
    const dataSizes = eventsNamed("network_tunnel_stream_data").map((event) => event.data.length);
    expect(Math.max(...dataSizes)).toBe(TUNNEL_MAX_DATA_BYTES);
    expect(dataSizes.reduce((total, size) => total + size, 0)).toBe(TUNNEL_INITIAL_WINDOW_BYTES);
  });

  test("returns null without a provider so the proxy answers 503", () => {
    const { bridge, emitted } = createHarness();
    expect(
      bridge.openStreamFor("server-a", { host: "intranet", port: 80 }, new FakeSink()),
    ).toBeNull();
    expect(emitted).toEqual([]);
  });
});

describe("TunnelBridge streams", () => {
  test("opens a stream with the unresolved host, waits for Connected, then relays data under credit", async () => {
    const { bridge, eventsNamed, timers } = createHarness();
    const providerId = register(bridge);
    const sink = new FakeSink();

    const handle = bridge.openStreamFor("server-a", { host: "intranet.invalid", port: 8080 }, sink);
    expect(handle).not.toBeNull();
    expect(eventsNamed("network_tunnel_stream_open")).toEqual([
      { serverId: "server-a", providerId, streamId: "id-2", host: "intranet.invalid", port: 8080 },
    ]);
    expect(timers[0].delayMs).toBe(LIMITS.connectTimeoutMs + 5_000);

    // Writes before Connected stay queued: nothing is sent and the callback waits.
    let firstWriteDone = false;
    handle!.write(new Uint8Array(1500).fill(1), () => {
      firstWriteDone = true;
    });
    expect(eventsNamed("network_tunnel_stream_data")).toEqual([]);

    const ref = { serverId: "server-a", providerId, streamId: "id-2" };
    expect(bridge.streamConnected(1, ref)).toEqual({ ok: true });
    expect(sink.connected).toBe(1);
    expect(timers[0].cleared).toBe(true);

    // 1500 bytes against a 1024-byte window in 256-byte frames: four frames go out,
    // the remaining 476 bytes wait for credit.
    const frames = eventsNamed("network_tunnel_stream_data");
    expect(frames.map((frame) => frame.data.byteLength)).toEqual([256, 256, 256, 256]);
    expect(firstWriteDone).toBe(false);

    expect(bridge.streamCredit(1, ref, 476)).toEqual({ ok: true });
    expect(eventsNamed("network_tunnel_stream_data").map((frame) => frame.data.byteLength)).toEqual(
      [256, 256, 256, 256, 256, 220],
    );
    expect(firstWriteDone).toBe(true);
  });

  test("returns inbound credit only after the proxy consumed the bytes", async () => {
    const { bridge, eventsNamed } = createHarness();
    const providerId = register(bridge);
    const sink = new FakeSink();
    bridge.openStreamFor("server-a", { host: "intranet.invalid", port: 80 }, sink);
    const ref = { serverId: "server-a", providerId, streamId: "id-2" };
    bridge.streamConnected(1, ref);

    expect(bridge.streamData(1, ref, new Uint8Array(100))).toEqual({ ok: true });
    expect(bridge.streamData(1, ref, new Uint8Array(50))).toEqual({ ok: true });
    await flushMicrotasks();
    expect(eventsNamed("network_tunnel_stream_credit")).toEqual([]);

    sink.data[0].consumed();
    sink.data[0].consumed();
    sink.data[1].consumed();
    await flushMicrotasks();
    expect(eventsNamed("network_tunnel_stream_credit")).toEqual([{ ...ref, credit: 150 }]);
  });

  test("treats credit and size violations as protocol errors that close the provider", () => {
    const { bridge, eventsNamed } = createHarness();
    const providerId = register(bridge);
    const sink = new FakeSink();
    bridge.openStreamFor("server-a", { host: "intranet.invalid", port: 80 }, sink);
    const ref = { serverId: "server-a", providerId, streamId: "id-2" };
    bridge.streamConnected(1, ref);

    const oversized = bridge.streamData(1, ref, new Uint8Array(LIMITS.maxDataBytes + 1));
    expect(!oversized.ok && oversized.error.code).toBe("protocol_error");
    expect(sink.closeReasons).toEqual([TunnelCloseReason.ProtocolError]);
    expect(eventsNamed("network_tunnel_provider_closed")).toEqual([
      { serverId: "server-a", providerId, reason: "protocol_error" },
    ]);
    expect(bridge.hasProvider("server-a")).toBe(false);
  });

  test("rejects data exceeding the receive window and credit exceeding the send window", () => {
    for (const violation of ["data", "credit"] as const) {
      const { bridge } = createHarness();
      const providerId = register(bridge);
      const sink = new FakeSink();
      bridge.openStreamFor("server-a", { host: "h", port: 80 }, sink);
      const ref = { serverId: "server-a", providerId, streamId: "id-2" };
      bridge.streamConnected(1, ref);
      for (let index = 0; index < 4; index += 1) {
        expect(bridge.streamData(1, ref, new Uint8Array(256))).toEqual({ ok: true });
      }
      const result =
        violation === "data"
          ? bridge.streamData(1, ref, new Uint8Array(1))
          : bridge.streamCredit(1, ref, 1);
      expect(!result.ok && result.error.code).toBe("protocol_error");
      expect(bridge.hasProvider("server-a")).toBe(false);
    }
  });

  test("closes a stream from the daemon side without echoing the close", () => {
    const { bridge, eventsNamed } = createHarness();
    const providerId = register(bridge);
    const sink = new FakeSink();
    const handle = bridge.openStreamFor("server-a", { host: "h", port: 80 }, sink)!;
    const ref = { serverId: "server-a", providerId, streamId: "id-2" };
    const writeErrors: unknown[] = [];
    handle.write(new Uint8Array(10), (error) => writeErrors.push(error));

    expect(bridge.streamClose(1, ref, TunnelCloseReason.ConnectionRefused)).toEqual({ ok: true });
    expect(sink.closeReasons).toEqual([TunnelCloseReason.ConnectionRefused]);
    expect(writeErrors).toHaveLength(1);
    expect(eventsNamed("network_tunnel_stream_close")).toEqual([]);

    const late = bridge.streamData(1, ref, new Uint8Array(1));
    expect(!late.ok && late.error.code).toBe("unknown_stream");
    handle.close();
    expect(eventsNamed("network_tunnel_stream_close")).toEqual([]);
  });

  test("closes a stream from the proxy side by notifying the renderer once", () => {
    const { bridge, eventsNamed } = createHarness();
    const providerId = register(bridge);
    const sink = new FakeSink();
    const handle = bridge.openStreamFor("server-a", { host: "h", port: 80 }, sink)!;
    const ref = { serverId: "server-a", providerId, streamId: "id-2" };
    bridge.streamConnected(1, ref);

    handle.close(TunnelCloseReason.Ok);
    handle.close(TunnelCloseReason.Ok);
    expect(eventsNamed("network_tunnel_stream_close")).toEqual([
      { ...ref, reason: TunnelCloseReason.Ok },
    ]);
    expect(sink.closeReasons).toEqual([]);
    const result = bridge.streamClose(1, ref, TunnelCloseReason.Ok);
    expect(!result.ok && result.error.code).toBe("unknown_stream");
  });

  test("times out a stream the renderer never connects", () => {
    const { bridge, eventsNamed, timers } = createHarness();
    const providerId = register(bridge);
    const sink = new FakeSink();
    bridge.openStreamFor("server-a", { host: "h", port: 80 }, sink);

    timers[0].callback();

    expect(sink.closeReasons).toEqual([TunnelCloseReason.Timeout]);
    expect(eventsNamed("network_tunnel_stream_close")).toEqual([
      { serverId: "server-a", providerId, streamId: "id-2", reason: TunnelCloseReason.Timeout },
    ]);
  });

  test("enforces the stream limit including streams still connecting", async () => {
    const { bridge } = createHarness();
    register(bridge);
    const sinks = [new FakeSink(), new FakeSink(), new FakeSink()];
    for (const sink of sinks) {
      expect(bridge.openStreamFor("server-a", { host: "h", port: 80 }, sink)).not.toBeNull();
    }
    await flushMicrotasks();
    expect(sinks.map((sink) => sink.closeReasons)).toEqual([
      [],
      [],
      [TunnelCloseReason.StreamLimit],
    ]);
  });

  test("rejects out-of-order Connected and Data for a single stream and releases the proxy side", () => {
    const { bridge, eventsNamed, timers } = createHarness();
    const providerId = register(bridge);
    const sink = new FakeSink();
    bridge.openStreamFor("server-a", { host: "h", port: 80 }, sink);
    const ref = { serverId: "server-a", providerId, streamId: "id-2" };

    const early = bridge.streamData(1, ref, new Uint8Array(1));
    expect(!early.ok && early.error.code).toBe("protocol_error");
    expect(bridge.hasProvider("server-a")).toBe(true);
    // The proxy learns about the close too, so Chromium's socket is answered.
    expect(sink.closeReasons).toEqual([TunnelCloseReason.ProtocolError]);
    expect(eventsNamed("network_tunnel_stream_close")).toEqual([
      { ...ref, reason: TunnelCloseReason.ProtocolError },
    ]);
    expect(timers[0].cleared).toBe(true);

    const other = new FakeSink();
    bridge.openStreamFor("server-a", { host: "h", port: 80 }, other);
    const otherRef = { ...ref, streamId: "id-3" };
    bridge.streamConnected(1, otherRef);
    const twice = bridge.streamConnected(1, otherRef);
    expect(!twice.ok && twice.error.code).toBe("protocol_error");
    expect(other.closeReasons).toEqual([TunnelCloseReason.ProtocolError]);

    const third = new FakeSink();
    bridge.openStreamFor("server-a", { host: "h", port: 80 }, third);
    const earlyCredit = bridge.streamCredit(1, { ...ref, streamId: "id-4" }, 1);
    expect(!earlyCredit.ok && earlyCredit.error.code).toBe("protocol_error");
    expect(third.closeReasons).toEqual([TunnelCloseReason.ProtocolError]);
  });
});

describe("TunnelBridge cleanup", () => {
  test("closes every stream and notifies the renderer when the provider goes away", () => {
    const { bridge, eventsNamed } = createHarness();
    const providerId = register(bridge, 7);
    const sinks = [new FakeSink(), new FakeSink()];
    for (const sink of sinks) bridge.openStreamFor("server-a", { host: "h", port: 80 }, sink);
    bridge.streamConnected(7, { serverId: "server-a", providerId, streamId: "id-2" });

    bridge.closeProvidersForSender(7, "disconnected");

    expect(sinks.map((sink) => sink.closeReasons)).toEqual([
      [TunnelCloseReason.NetworkUnreachable],
      [TunnelCloseReason.NetworkUnreachable],
    ]);
    expect(eventsNamed("network_tunnel_provider_closed")).toEqual([
      { serverId: "server-a", providerId, reason: "disconnected" },
    ]);
    expect(bridge.hasProvider("server-a")).toBe(false);
  });

  test("drops the provider when its renderer no longer receives events", () => {
    const deadSenders = new Set<number>();
    const { bridge, emitted } = createHarness({ deadSenders });
    register(bridge, 3);
    deadSenders.add(3);

    const handle = bridge.openStreamFor("server-a", { host: "h", port: 80 }, new FakeSink());

    expect(handle).toBeNull();
    expect(bridge.hasProvider("server-a")).toBe(false);
    expect(
      emitted.filter((entry) => entry.event.name === "network_tunnel_provider_closed"),
    ).toEqual([]);
  });

  test("unregister does not notify the renderer that asked for it", () => {
    const { bridge, eventsNamed } = createHarness();
    const providerId = register(bridge);
    const sink = new FakeSink();
    bridge.openStreamFor("server-a", { host: "h", port: 80 }, sink);

    bridge.unregister(1, { serverId: "server-a", providerId });

    expect(sink.closeReasons).toEqual([TunnelCloseReason.NetworkUnreachable]);
    expect(eventsNamed("network_tunnel_provider_closed")).toEqual([]);
  });
});
