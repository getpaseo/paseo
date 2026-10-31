import net from "node:net";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TunnelCloseReason,
  TunnelOpcode,
  decodeTunnelFrame,
  type TunnelFrame,
  type TunnelTarget,
} from "@getpaseo/protocol/binary-frames/index";
import type { NetworkTunnelLimits } from "@getpaseo/protocol/network-tunnel/rpc-schemas";
import type { SessionOutboundMessage } from "../messages.js";
import { SessionDelivery } from "../session/owned-subscriptions/index.js";
import {
  NETWORK_TUNNEL_FAMILY,
  NetworkTunnelSession,
  TunnelProtocolError,
  type NetworkTunnelSessionOptions,
  type TunnelLookup,
} from "./network-tunnel-session.js";
import { TunnelTargetError } from "./target-policy.js";

const LIMITS = {
  initialWindowBytes: 1024,
  maxDataBytes: 256,
  maxStreams: 2,
  connectTimeoutMs: 2000,
};

interface Harness {
  delivery: SessionDelivery;
  controller: NetworkTunnelSession;
  socket: object;
  messages: SessionOutboundMessage[];
  frames: TunnelFrame[];
  nextFrame(predicate: (frame: TunnelFrame) => boolean): Promise<TunnelFrame>;
  open(socket?: object, clientLimits?: NetworkTunnelLimits): Promise<string>;
  closeTunnel(subscriptionId: string, socket?: object): Promise<SessionOutboundMessage>;
  attach(): object;
  setAllowed(allowed: boolean): void;
  setCapable(capable: boolean): void;
}

interface HarnessOptions {
  limits?: Partial<NetworkTunnelSessionOptions["limits"]>;
  maxSubscriptions?: number;
  lookup?: TunnelLookup;
  dial?: NetworkTunnelSessionOptions["dial"];
  modern?: boolean;
  drainTimeoutMs?: number;
}

interface TestServer {
  port: number;
  sockets: net.Socket[];
  closed: Promise<void>[];
  close(): Promise<void>;
}

const servers: TestServer[] = [];
const harnesses: Harness[] = [];
const finishLookups: Array<() => void> = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.delivery.close();
  for (const finish of finishLookups.splice(0)) finish();
  await Promise.resolve();
  for (const server of servers.splice(0)) await server.close();
});

function createHarness(options: HarnessOptions = {}): Harness {
  const messages: SessionOutboundMessage[] = [];
  const frames: TunnelFrame[] = [];
  const waiters: Array<{
    predicate: (frame: TunnelFrame) => boolean;
    resolve: (f: TunnelFrame) => void;
  }> = [];
  let allowed = true;
  let capable = true;
  const delivery = new SessionDelivery(
    (_source, message) => {
      messages.push(message);
    },
    (_source, bytes) => {
      const frame = decodeTunnelFrame(bytes);
      if (!frame) throw new Error("Daemon emitted an undecodable tunnel frame");
      frames.push(frame);
      for (const waiter of waiters.splice(0)) {
        if (waiter.predicate(frame)) waiter.resolve(frame);
        else waiters.push(waiter);
      }
    },
  );
  const socket = {};
  delivery.attach(socket, options.modern ?? true);
  const controller = new NetworkTunnelSession({
    host: {
      emit: (message) => {
        if (!delivery.reply(message)) messages.push(message);
      },
      begin: (stop) => delivery.begin(NETWORK_TUNNEL_FAMILY, undefined, stop),
      currentSource: () => delivery.currentSource,
      isModernSource: (source) => delivery.isModern(source),
      supportsTunnel: () => capable,
      allowsNetworkProxy: () => allowed,
    },
    logger: pino({ level: "silent" }),
    limits: { ...LIMITS, ...options.limits },
    maxSubscriptions: options.maxSubscriptions,
    lookup: options.lookup,
    dial: options.dial,
    drainTimeoutMs: options.drainTimeoutMs,
  });
  let requestCounter = 0;
  const harness: Harness = {
    delivery,
    controller,
    socket,
    messages,
    frames,
    nextFrame: (predicate) => {
      const existing = frames.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => waiters.push({ predicate, resolve }));
    },
    open: async (requestSocket = socket, clientLimits) => {
      const request = {
        type: "network.tunnel.open.request" as const,
        requestId: `open-${++requestCounter}`,
        ...(clientLimits ? { limits: clientLimits } : {}),
      };
      await delivery.request(requestSocket, request, async () =>
        controller.handleOpenRequest(request),
      );
      const response = messages.find(
        (message) =>
          message.type === "network.tunnel.open.response" &&
          message.payload.requestId === request.requestId,
      );
      if (!response || response.type !== "network.tunnel.open.response") {
        throw new Error("Missing open response");
      }
      if (!response.payload.ok) {
        throw new Error(`open failed: ${response.payload.error.code}`);
      }
      return response.payload.subscriptionId;
    },
    closeTunnel: async (subscriptionId, requestSocket = socket) => {
      const request = {
        type: "network.tunnel.close.request" as const,
        requestId: `close-${++requestCounter}`,
        subscriptionId,
      };
      await delivery.request(requestSocket, request, () => controller.handleCloseRequest(request));
      const response = messages.find(
        (message) =>
          message.type === "network.tunnel.close.response" &&
          message.payload.requestId === request.requestId,
      );
      if (!response) throw new Error("Missing close response");
      return response;
    },
    attach: () => {
      const other = {};
      delivery.attach(other, true);
      return other;
    },
    setAllowed: (value) => {
      allowed = value;
    },
    setCapable: (value) => {
      capable = value;
    },
  };
  harnesses.push(harness);
  return harness;
}

function listen(
  onConnection: (socket: net.Socket) => void,
  options: net.ServerOpts = {},
): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    const sockets: net.Socket[] = [];
    const closed: Promise<void>[] = [];
    const server = net.createServer(options, (socket) => {
      sockets.push(socket);
      closed.push(new Promise<void>((done) => socket.once("close", () => done())));
      socket.on("error", () => {});
      onConnection(socket);
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      const testServer: TestServer = {
        port: address.port,
        sockets,
        closed,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      };
      servers.push(testServer);
      resolve(testServer);
    });
  });
}

function echoServer(): Promise<TestServer> {
  return listen((socket) => socket.on("data", (chunk) => socket.write(chunk)));
}

function freedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

function domain(address: string, port: number): TunnelTarget {
  return { atyp: 3, address, port };
}

function openFrame(subscriptionId: string, streamId: string, target: TunnelTarget): TunnelFrame {
  return { opcode: TunnelOpcode.Open, subscriptionId, streamId, target };
}

function dataFrame(subscriptionId: string, streamId: string, payload: Uint8Array): TunnelFrame {
  return { opcode: TunnelOpcode.Data, subscriptionId, streamId, payload };
}

function isClose(streamId: string, reason?: number) {
  return (frame: TunnelFrame) =>
    frame.opcode === TunnelOpcode.Close &&
    frame.streamId === streamId &&
    (reason === undefined || frame.reason === reason);
}

function isConnected(streamId: string) {
  return (frame: TunnelFrame) =>
    frame.opcode === TunnelOpcode.Connected && frame.streamId === streamId;
}

function dataBytes(frames: TunnelFrame[], streamId: string): number {
  return frames
    .filter((frame) => frame.opcode === TunnelOpcode.Data && frame.streamId === streamId)
    .reduce(
      (sum, frame) => sum + (frame.opcode === TunnelOpcode.Data ? frame.payload.length : 0),
      0,
    );
}

function settle(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeUntilClosed(socket: net.Socket, closed: Promise<void>): Promise<void> {
  const probe = setInterval(() => socket.write("probe"), 10);
  try {
    await closed;
  } finally {
    clearInterval(probe);
  }
}

const neverResolves: TunnelLookup = () =>
  new Promise((resolve) => finishLookups.push(() => resolve([])));

describe("NetworkTunnelSession", () => {
  it("keeps cancelled and expired DNS work in the daemon-wide limit until it finishes", async () => {
    const started: string[] = [];
    const finishes: Array<() => void> = [];
    const lookup: TunnelLookup = (hostname) => {
      started.push(hostname);
      return new Promise((resolve) => {
        const finish = () => resolve([]);
        finishes.push(finish);
        finishLookups.push(finish);
      });
    };
    const cancelled = createHarness({ lookup });
    const expired = createHarness({ lookup, limits: { connectTimeoutMs: 40 } });
    const waiting = createHarness({ lookup });
    const a = await cancelled.open();
    const b = await expired.open();
    const c = await waiting.open();
    await cancelled.controller.handleFrame(
      openFrame(a, "a", domain("cancelled.test", 80)),
      cancelled.socket,
    );
    await expired.controller.handleFrame(
      openFrame(b, "b", domain("expired.test", 80)),
      expired.socket,
    );
    await vi.waitFor(() => expect(started).toHaveLength(2));
    await cancelled.closeTunnel(a);
    await expired.nextFrame(isClose("b", TunnelCloseReason.Timeout));
    await waiting.controller.handleFrame(
      openFrame(c, "c", domain("waiting.test", 80)),
      waiting.socket,
    );
    await settle(10);
    expect(started).toEqual(["cancelled.test", "expired.test"]);
    finishes[0]();
    await vi.waitFor(() =>
      expect(started).toEqual(["cancelled.test", "expired.test", "waiting.test"]),
    );
  });

  it("times out waiting for a DNS slot without starting the lookup later", async () => {
    const busy = createHarness({ lookup: neverResolves });
    const id = await busy.open();
    for (const stream of ["a", "b"]) {
      await busy.controller.handleFrame(
        openFrame(id, stream, domain("busy.test", 80)),
        busy.socket,
      );
    }
    await settle(0);
    const started: string[] = [];
    const waiting = createHarness({
      lookup: async (hostname) => {
        started.push(hostname);
        return [];
      },
      limits: { connectTimeoutMs: 40 },
    });
    const other = await waiting.open();
    await waiting.controller.handleFrame(
      openFrame(other, "wait", domain("waiting.test", 80)),
      waiting.socket,
    );
    await waiting.nextFrame(isClose("wait", TunnelCloseReason.Timeout));
    expect(started).toEqual([]);
    for (const finish of finishLookups.splice(0)) finish();
    await settle(0);
    expect(started).toEqual([]);
  });

  it("removes cancelled DNS waiters and releases slots after resolver errors", async () => {
    const busy = createHarness({ lookup: neverResolves });
    const id = await busy.open();
    for (const stream of ["a", "b"]) {
      await busy.controller.handleFrame(
        openFrame(id, stream, domain("busy.test", 80)),
        busy.socket,
      );
    }
    await settle(0);
    const started: string[] = [];
    const waiting = createHarness({
      lookup: async (hostname) => {
        started.push(hostname);
        throw Object.assign(new Error("missing"), { code: "ENOTFOUND" });
      },
    });
    const other = await waiting.open();
    await waiting.controller.handleFrame(
      openFrame(other, "cancel", domain("cancel.test", 80)),
      waiting.socket,
    );
    await waiting.controller.handleFrame(
      {
        opcode: TunnelOpcode.Close,
        subscriptionId: other,
        streamId: "cancel",
        reason: TunnelCloseReason.Ok,
      },
      waiting.socket,
    );
    for (const finish of finishLookups.splice(0)) finish();
    await settle(0);
    for (const stream of ["first", "second", "third"]) {
      await waiting.controller.handleFrame(
        openFrame(other, stream, domain(`${stream}.test`, 80)),
        waiting.socket,
      );
      await waiting.nextFrame(isClose(stream, TunnelCloseReason.HostNotFound));
    }
    expect(started).toEqual(["first.test", "second.test", "third.test"]);
  });

  it("reserves time for a reachable address after the first connection times out", async () => {
    const server = await echoServer();
    const budgets: number[] = [];
    const harness = createHarness({
      limits: { connectTimeoutMs: 240 },
      lookup: async () => [
        { address: "127.0.0.2", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
      dial: async ({ address, port, deadline }) => {
        budgets.push(deadline - Date.now());
        if (address.address === "127.0.0.2") {
          await settle(Math.max(0, deadline - Date.now()));
          throw new TunnelTargetError(TunnelCloseReason.Timeout, "Connect timed out");
        }
        return new Promise((resolve, reject) => {
          const socket = net.connect({ host: address.address, port, family: address.family });
          socket.once("connect", () => resolve(socket));
          socket.once("error", reject);
        });
      },
    });
    const id = await harness.open();
    await harness.controller.handleFrame(
      openFrame(id, "fallback", domain("fallback.test", server.port)),
      harness.socket,
    );
    const result = await harness.nextFrame((frame) => frame.streamId === "fallback");
    expect(result.opcode).toBe(TunnelOpcode.Connected);
    expect(budgets).toHaveLength(2);
    expect(budgets[0]).toBeLessThanOrEqual(120);
    expect(budgets[1]).toBeGreaterThan(0);
    await vi.waitFor(() => expect(server.sockets).toHaveLength(1));
  });

  it("does not dial another address after the total deadline expires", async () => {
    const attempts: string[] = [];
    const harness = createHarness({
      limits: { connectTimeoutMs: 40 },
      lookup: async () => [
        { address: "127.0.0.2", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
      dial: async ({ address }) => {
        attempts.push(address.address);
        await settle(60);
        throw new TunnelTargetError(TunnelCloseReason.Timeout, "Connect timed out");
      },
    });
    const id = await harness.open();
    await harness.controller.handleFrame(
      openFrame(id, "expired", domain("expired.test", 80)),
      harness.socket,
    );
    await harness.nextFrame(isClose("expired", TunnelCloseReason.Timeout));
    expect(attempts).toEqual(["127.0.0.2"]);
  });

  it("does not dial another address after the stream is cancelled", async () => {
    const attempts: string[] = [];
    const harness = createHarness({
      lookup: async () => [
        { address: "127.0.0.2", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
      dial: async ({ address, signal }) => {
        attempts.push(address.address);
        return new Promise((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => reject(new TunnelTargetError(TunnelCloseReason.Ok, "Stream cancelled")),
            { once: true },
          ),
        );
      },
    });
    const id = await harness.open();
    await harness.controller.handleFrame(
      openFrame(id, "cancel", domain("cancel.test", 80)),
      harness.socket,
    );
    await vi.waitFor(() => expect(attempts).toHaveLength(1));
    await harness.closeTunnel(id);
    await settle(0);
    expect(attempts).toEqual(["127.0.0.2"]);
    expect(harness.frames).toEqual([]);
  });

  it("echoes bytes through a TCP socket dialed from the host and tears the stream down on client Close", async () => {
    const server = await echoServer();
    const harness = createHarness();
    const id = await harness.open();
    const openResponse = harness.messages.find((m) => m.type === "network.tunnel.open.response");
    expect(openResponse).toEqual({
      type: "network.tunnel.open.response",
      payload: { requestId: "open-1", ok: true, subscriptionId: id, ...LIMITS },
    });
    expect(harness.delivery.subscriptionIds(harness.socket, NETWORK_TUNNEL_FAMILY)).toEqual([id]);

    await harness.controller.handleFrame(
      openFrame(id, "s1", domain("localhost", server.port)),
      harness.socket,
    );
    await harness.nextFrame(isConnected("s1"));
    expect(harness.frames.map((frame) => frame.opcode)).toEqual([TunnelOpcode.Connected]);

    const payload = new TextEncoder().encode("hello tunnel");
    await harness.controller.handleFrame(dataFrame(id, "s1", payload), harness.socket);
    const echoed = await harness.nextFrame(
      (frame) => frame.opcode === TunnelOpcode.Data && frame.streamId === "s1",
    );
    expect(echoed.opcode === TunnelOpcode.Data && Buffer.from(echoed.payload).toString()).toBe(
      "hello tunnel",
    );
    const credit = await harness.nextFrame(
      (frame) => frame.opcode === TunnelOpcode.WindowUpdate && frame.streamId === "s1",
    );
    expect(credit.opcode === TunnelOpcode.WindowUpdate && credit.credit).toBe(payload.length);

    await harness.controller.handleFrame(
      {
        opcode: TunnelOpcode.Close,
        subscriptionId: id,
        streamId: "s1",
        reason: TunnelCloseReason.Ok,
      },
      harness.socket,
    );
    await server.closed[0];
    expect(harness.controller.streamCount(id)).toBe(0);
    expect(harness.frames.filter(isClose("s1"))).toEqual([]);
  });

  it("accepts IP literals in the domain slot", async () => {
    const server = await echoServer();
    const harness = createHarness();
    const id = await harness.open();
    await harness.controller.handleFrame(
      openFrame(id, "v4", domain("127.0.0.1", server.port)),
      harness.socket,
    );
    await harness.nextFrame(isConnected("v4"));
    await harness.controller.handleFrame(
      openFrame(id, "raw", { atyp: 1, address: new Uint8Array([127, 0, 0, 1]), port: server.port }),
      harness.socket,
    );
    await harness.nextFrame(isConnected("raw"));
    await vi.waitFor(() => expect(server.sockets).toHaveLength(2));
  });

  it("delivers remote data in order before a normal Close when the destination ends", async () => {
    const server = await listen((socket) => {
      socket.write("first");
      socket.end("second");
    });
    const harness = createHarness();
    const id = await harness.open();
    await harness.controller.handleFrame(
      openFrame(id, "s", domain("localhost", server.port)),
      harness.socket,
    );
    await harness.nextFrame(isClose("s", TunnelCloseReason.Ok));
    const text = harness.frames
      .filter((frame) => frame.opcode === TunnelOpcode.Data)
      .map((frame) =>
        frame.opcode === TunnelOpcode.Data ? Buffer.from(frame.payload).toString() : "",
      )
      .join("");
    expect(text).toBe("firstsecond");
    expect(harness.frames.at(-1)?.opcode).toBe(TunnelOpcode.Close);
    expect(harness.controller.streamCount(id)).toBe(0);
  });

  it("pauses the destination when the client's window is exhausted and resumes on WindowUpdate", async () => {
    const chunk = Buffer.alloc(4096, 7);
    const server = await listen((socket) => socket.write(chunk));
    const harness = createHarness();
    const id = await harness.open();
    await harness.controller.handleFrame(
      openFrame(id, "s", domain("localhost", server.port)),
      harness.socket,
    );
    await harness.nextFrame(isConnected("s"));

    await expect.poll(() => dataBytes(harness.frames, "s")).toBe(LIMITS.initialWindowBytes);
    await settle();
    expect(dataBytes(harness.frames, "s")).toBe(LIMITS.initialWindowBytes);
    const sizes = harness.frames
      .filter((frame) => frame.opcode === TunnelOpcode.Data)
      .map((frame) => (frame.opcode === TunnelOpcode.Data ? frame.payload.length : 0));
    expect(sizes.every((size) => size > 0 && size <= LIMITS.maxDataBytes)).toBe(true);

    await harness.controller.handleFrame(
      { opcode: TunnelOpcode.WindowUpdate, subscriptionId: id, streamId: "s", credit: 512 },
      harness.socket,
    );
    await expect.poll(() => dataBytes(harness.frames, "s")).toBe(LIMITS.initialWindowBytes + 512);
    await settle();
    expect(dataBytes(harness.frames, "s")).toBe(LIMITS.initialWindowBytes + 512);
    expect(harness.frames.filter(isClose("s"))).toEqual([]);
  });

  it("flushes queued remote bytes and then closes when the destination ended while paused", async () => {
    const chunk = Buffer.alloc(1536, 3);
    const server = await listen((socket) => socket.end(chunk));
    const harness = createHarness();
    const id = await harness.open();
    await harness.controller.handleFrame(
      openFrame(id, "s", domain("localhost", server.port)),
      harness.socket,
    );
    await expect.poll(() => dataBytes(harness.frames, "s")).toBe(LIMITS.initialWindowBytes);
    await settle();
    expect(harness.frames.filter(isClose("s"))).toEqual([]);
    await harness.controller.handleFrame(
      { opcode: TunnelOpcode.WindowUpdate, subscriptionId: id, streamId: "s", credit: 1024 },
      harness.socket,
    );
    await harness.nextFrame(isClose("s", TunnelCloseReason.Ok));
    expect(dataBytes(harness.frames, "s")).toBe(1536);
    expect(harness.frames.at(-1)?.opcode).toBe(TunnelOpcode.Close);
  });

  it("releases the whole subscription when the client sends Data beyond its credit", async () => {
    const server = await echoServer();
    const harness = createHarness();
    const id = await harness.open();
    await harness.controller.handleFrame(
      openFrame(id, "s", domain("localhost", server.port)),
      harness.socket,
    );
    await harness.nextFrame(isConnected("s"));
    await harness.controller.handleFrame(
      dataFrame(id, "s", new Uint8Array(LIMITS.maxDataBytes + 1)),
      harness.socket,
    );
    expect(harness.frames.filter(isClose("s", TunnelCloseReason.ProtocolError))).toHaveLength(1);
    expect(harness.controller.subscriptionCount).toBe(0);
    expect(harness.delivery.subscriptionIds(harness.socket, NETWORK_TUNNEL_FAMILY)).toEqual([]);
    await server.closed[0];
  });

  it("treats WindowUpdate above delivered bytes and Data before Connected as violations", async () => {
    const server = await echoServer();
    const harness = createHarness({ lookup: neverResolves });
    const id = await harness.open();
    await harness.controller.handleFrame(
      openFrame(id, "pending", domain("slow.test", 80)),
      harness.socket,
    );
    await harness.controller.handleFrame(
      dataFrame(id, "pending", new Uint8Array(1)),
      harness.socket,
    );
    expect(harness.frames.filter(isClose("pending", TunnelCloseReason.ProtocolError))).toHaveLength(
      1,
    );
    expect(harness.controller.subscriptionCount).toBe(0);

    const second = await harness.open();
    await harness.controller.handleFrame(
      openFrame(second, "s", {
        atyp: 1,
        address: new Uint8Array([127, 0, 0, 1]),
        port: server.port,
      }),
      harness.socket,
    );
    await harness.nextFrame(isConnected("s"));
    await harness.controller.handleFrame(
      { opcode: TunnelOpcode.WindowUpdate, subscriptionId: second, streamId: "s", credit: 1 },
      harness.socket,
    );
    expect(harness.frames.filter(isClose("s", TunnelCloseReason.ProtocolError))).toHaveLength(1);
    expect(harness.controller.subscriptionCount).toBe(0);
  });

  it("rejects a duplicate stream open as a violation", async () => {
    const harness = createHarness({ lookup: neverResolves });
    const id = await harness.open();
    await harness.controller.handleFrame(
      openFrame(id, "dup", domain("slow.test", 80)),
      harness.socket,
    );
    await harness.controller.handleFrame(
      openFrame(id, "dup", domain("slow.test", 80)),
      harness.socket,
    );
    expect(harness.frames.filter(isClose("dup", TunnelCloseReason.ProtocolError))).toHaveLength(1);
    expect(harness.controller.subscriptionCount).toBe(0);
  });

  it.each<[string, TunnelTarget]>([
    ["IPv4 metadata literal", { atyp: 1, address: new Uint8Array([169, 254, 169, 254]), port: 80 }],
    ["IPv4 link-local literal", { atyp: 1, address: new Uint8Array([169, 254, 1, 1]), port: 80 }],
    ["metadata address in the domain slot", domain("169.254.169.254", 80)],
    [
      "IPv6 link-local",
      {
        atyp: 4,
        address: new Uint8Array([0xfe, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
        port: 80,
      },
    ],
    [
      "EC2 IPv6 metadata",
      {
        atyp: 4,
        address: new Uint8Array([0xfd, 0, 0x0e, 0xc2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x02, 0x54]),
        port: 80,
      },
    ],
    [
      "IPv4-mapped IPv6 metadata",
      {
        atyp: 4,
        address: new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 169, 254, 169, 254]),
        port: 80,
      },
    ],
    ["IPv4-mapped literal in the domain slot", domain("::ffff:169.254.169.254", 80)],
  ])("denies %s without dialing", async (_label, target) => {
    const harness = createHarness({
      lookup: () => {
        throw new Error("DNS must not run for literals");
      },
    });
    const id = await harness.open();
    await harness.controller.handleFrame(openFrame(id, "denied", target), harness.socket);
    await harness.nextFrame(isClose("denied", TunnelCloseReason.PolicyDenied));
    expect(harness.frames).toHaveLength(1);
    expect(harness.controller.streamCount(id)).toBe(0);
    expect(harness.controller.subscriptionCount).toBe(1);
  });

  it("denies a name whose resolved answers include a denied address", async () => {
    const server = await echoServer();
    const harness = createHarness({
      lookup: async () => [
        { address: "127.0.0.1", family: 4 },
        { address: "::ffff:169.254.169.254", family: 6 },
      ],
    });
    const id = await harness.open();
    await harness.controller.handleFrame(
      openFrame(id, "mixed", domain("intranet.example", server.port)),
      harness.socket,
    );
    await harness.nextFrame(isClose("mixed", TunnelCloseReason.PolicyDenied));
    await settle();
    expect(server.sockets).toHaveLength(0);
  });

  it("connects to the resolved address instead of resolving again", async () => {
    const server = await echoServer();
    const harness = createHarness({ lookup: async () => [{ address: "127.0.0.1", family: 4 }] });
    const id = await harness.open();
    await harness.controller.handleFrame(
      openFrame(id, "s", domain("intranet.example", server.port)),
      harness.socket,
    );
    await harness.nextFrame(isConnected("s"));
    await vi.waitFor(() => expect(server.sockets).toHaveLength(1));
  });

  it("counts connecting streams against the stream limit", async () => {
    const harness = createHarness({ lookup: neverResolves, limits: { maxStreams: 1 } });
    const id = await harness.open();
    await harness.controller.handleFrame(
      openFrame(id, "first", domain("slow.test", 80)),
      harness.socket,
    );
    await harness.controller.handleFrame(
      openFrame(id, "second", domain("slow.test", 80)),
      harness.socket,
    );
    expect(harness.frames).toEqual([
      {
        opcode: TunnelOpcode.Close,
        subscriptionId: id,
        streamId: "second",
        reason: TunnelCloseReason.StreamLimit,
      },
    ]);
    expect(harness.controller.streamCount(id)).toBe(1);
    expect(harness.controller.subscriptionCount).toBe(1);
    expect(harness.messages.filter((m) => m.type === "network.tunnel.closed")).toEqual([]);
  });

  it("counts sockets still draining a graceful close against the stream limit", async () => {
    // allowHalfOpen keeps the destination reading after our FIN, so the socket stays in `closing`.
    const server = await listen(() => {}, { allowHalfOpen: true });
    const harness = createHarness({ limits: { maxStreams: 1 } });
    const id = await harness.open();
    await harness.controller.handleFrame(
      openFrame(id, "first", domain("127.0.0.1", server.port)),
      harness.socket,
    );
    await harness.nextFrame(isConnected("first"));
    await vi.waitFor(() => expect(server.sockets).toHaveLength(1));
    await harness.controller.handleFrame(
      {
        opcode: TunnelOpcode.Close,
        subscriptionId: id,
        streamId: "first",
        reason: TunnelCloseReason.Ok,
      },
      harness.socket,
    );
    expect(harness.controller.streamCount(id)).toBe(0);
    expect(harness.controller.closingSocketCount(id)).toBe(1);

    await harness.controller.handleFrame(
      openFrame(id, "second", domain("127.0.0.1", server.port)),
      harness.socket,
    );
    await harness.nextFrame(isClose("second", TunnelCloseReason.StreamLimit));

    // Once the destination finishes, the drained socket frees its slot.
    server.sockets[0].end();
    await server.closed[0];
    await vi.waitFor(() => expect(harness.controller.closingSocketCount(id)).toBe(0));
    await harness.controller.handleFrame(
      openFrame(id, "third", domain("127.0.0.1", server.port)),
      harness.socket,
    );
    await harness.nextFrame(isConnected("third"));
  });

  it("destroys a draining socket at a fixed deadline while the destination keeps sending", async () => {
    const server = await listen(() => {}, { allowHalfOpen: true });
    const harness = createHarness({ drainTimeoutMs: 200 });
    const id = await harness.open();
    await harness.controller.handleFrame(
      openFrame(id, "s", domain("127.0.0.1", server.port)),
      harness.socket,
    );
    await harness.nextFrame(isConnected("s"));
    await vi.waitFor(() => expect(server.sockets).toHaveLength(1));
    await harness.controller.handleFrame(
      {
        opcode: TunnelOpcode.Close,
        subscriptionId: id,
        streamId: "s",
        reason: TunnelCloseReason.Ok,
      },
      harness.socket,
    );
    expect(harness.controller.closingSocketCount(id)).toBe(1);

    // Traffic every 50 ms would keep restarting an idle timeout; the deadline does not move.
    const started = Date.now();
    await probeUntilClosed(server.sockets[0], server.closed[0]);
    expect(Date.now() - started).toBeLessThan(1000);
    await vi.waitFor(() => expect(harness.controller.closingSocketCount(id)).toBe(0));
  });

  it("dials localhost names on the host's loopback without asking the resolver", async () => {
    const server = await listen((socket) => socket.pipe(socket));
    const lookup = vi.fn<TunnelLookup>(async () => {
      throw new Error("localhost names must not reach the resolver");
    });
    const harness = createHarness({ lookup, limits: { maxStreams: 3 } });
    const id = await harness.open();
    for (const [streamId, name] of [
      ["plain", "localhost"],
      ["subdomain", "app.localhost"],
      ["nested", "Tenant.App.LOCALHOST."],
    ] as const) {
      await harness.controller.handleFrame(
        openFrame(id, streamId, domain(name, server.port)),
        harness.socket,
      );
      await harness.nextFrame(isConnected(streamId));
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it("answers the open request with the per-field minimum of both sides' limits", async () => {
    const server = await listen((socket) => socket.write(Buffer.alloc(600, 1)));
    const harness = createHarness();
    const clientLimits = {
      initialWindowBytes: 300,
      maxDataBytes: 100,
      maxStreams: 8,
      connectTimeoutMs: 500,
    };
    const id = await harness.open(harness.socket, clientLimits);
    const response = harness.messages.find((m) => m.type === "network.tunnel.open.response");
    expect(response?.payload).toMatchObject({
      ok: true,
      initialWindowBytes: 300,
      maxDataBytes: 100,
      maxStreams: LIMITS.maxStreams,
      connectTimeoutMs: 500,
    });

    // The daemon sends within what the client accepts, not within its own larger window.
    await harness.controller.handleFrame(
      openFrame(id, "s", domain("127.0.0.1", server.port)),
      harness.socket,
    );
    await harness.nextFrame(isConnected("s"));
    await vi.waitFor(() => expect(dataBytes(harness.frames, "s")).toBe(300));
    await settle(50);
    expect(dataBytes(harness.frames, "s")).toBe(300);
    const sizes = harness.frames
      .filter((frame) => frame.opcode === TunnelOpcode.Data)
      .map((frame) => (frame.opcode === TunnelOpcode.Data ? frame.payload.length : 0));
    expect(Math.max(...sizes)).toBeLessThanOrEqual(100);
  });

  it("destroys half-open sockets still draining a graceful close when the tunnel is released", async () => {
    // allowHalfOpen keeps the destination reading after our FIN, so only a daemon-side destroy ends it.
    const server = await listen(() => {}, { allowHalfOpen: true });
    const harness = createHarness();
    const id = await harness.open();
    await harness.controller.handleFrame(
      openFrame(id, "s", domain("127.0.0.1", server.port)),
      harness.socket,
    );
    await harness.nextFrame(isConnected("s"));
    await vi.waitFor(() => expect(server.sockets).toHaveLength(1));
    await harness.controller.handleFrame(
      {
        opcode: TunnelOpcode.Close,
        subscriptionId: id,
        streamId: "s",
        reason: TunnelCloseReason.Ok,
      },
      harness.socket,
    );
    expect(harness.controller.streamCount(id)).toBe(0);
    expect(harness.controller.closingSocketCount(id)).toBe(1);
    // The daemon side is still open for reading: writes from the destination keep landing.
    for (let probe = 0; probe < 3; probe += 1) {
      server.sockets[0].write("probe");
      await settle(20);
    }
    expect(server.sockets[0].destroyed).toBe(false);

    const started = Date.now();
    const response = await harness.closeTunnel(id);
    expect(response).toEqual({
      type: "network.tunnel.close.response",
      payload: { requestId: "close-2", ok: true, subscriptionId: id },
    });
    expect(harness.controller.subscriptionCount).toBe(0);
    // After release the daemon socket is gone; the peer learns it from the reset to its next writes.
    await probeUntilClosed(server.sockets[0], server.closed[0]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("maps a refused connection to ConnectionRefused", async () => {
    const port = await freedPort();
    const harness = createHarness();
    const id = await harness.open();
    await harness.controller.handleFrame(
      openFrame(id, "dead", domain("127.0.0.1", port)),
      harness.socket,
    );
    await harness.nextFrame(isClose("dead", TunnelCloseReason.ConnectionRefused));
    expect(harness.frames).toHaveLength(1);
  });

  it("maps DNS failures to HostNotFound and unreachable networks to NetworkUnreachable", async () => {
    const codes = new Map([
      ["missing.example", "ENOTFOUND"],
      ["unreachable.example", "ENETUNREACH"],
    ]);
    const harness = createHarness({
      lookup: async (hostname) => {
        const code = codes.get(hostname);
        if (!code) return [{ address: "127.0.0.1", family: 4 }];
        throw Object.assign(new Error(code), { code });
      },
    });
    const id = await harness.open();
    await harness.controller.handleFrame(
      openFrame(id, "missing", domain("missing.example", 80)),
      harness.socket,
    );
    await harness.controller.handleFrame(
      openFrame(id, "net", domain("unreachable.example", 80)),
      harness.socket,
    );
    await harness.nextFrame(isClose("missing", TunnelCloseReason.HostNotFound));
    await harness.nextFrame(isClose("net", TunnelCloseReason.NetworkUnreachable));
  });

  it("times out when DNS and connect exceed the deadline", async () => {
    const harness = createHarness({ lookup: neverResolves, limits: { connectTimeoutMs: 40 } });
    const id = await harness.open();
    await harness.controller.handleFrame(
      openFrame(id, "slow", domain("slow.test", 80)),
      harness.socket,
    );
    await harness.nextFrame(isClose("slow", TunnelCloseReason.Timeout));
    expect(harness.controller.streamCount(id)).toBe(0);
  });

  it("cancels a pending open when the client closes it and never reports it", async () => {
    let resolveLookup: ((value: { address: string; family: 4 | 6 }[]) => void) | undefined;
    const harness = createHarness({
      lookup: () =>
        new Promise((resolve) => {
          resolveLookup = resolve;
        }),
    });
    const id = await harness.open();
    await harness.controller.handleFrame(
      openFrame(id, "pending", domain("slow.test", 80)),
      harness.socket,
    );
    await harness.controller.handleFrame(
      {
        opcode: TunnelOpcode.Close,
        subscriptionId: id,
        streamId: "pending",
        reason: TunnelCloseReason.Ok,
      },
      harness.socket,
    );
    expect(harness.controller.streamCount(id)).toBe(0);
    resolveLookup?.([{ address: "127.0.0.1", family: 4 }]);
    await settle();
    expect(harness.frames).toEqual([]);
  });

  it("tears down streams when the connection detaches", async () => {
    const server = await echoServer();
    const harness = createHarness();
    const id = await harness.open();
    await harness.controller.handleFrame(
      openFrame(id, "s", domain("localhost", server.port)),
      harness.socket,
    );
    await harness.nextFrame(isConnected("s"));
    await harness.delivery.detach(harness.socket);
    await server.closed[0];
    expect(harness.controller.subscriptionCount).toBe(0);
  });

  it("drops every tunnel on the next frame after network.proxy is revoked", async () => {
    const server = await echoServer();
    const harness = createHarness();
    const id = await harness.open();
    await harness.controller.handleFrame(
      openFrame(id, "s", domain("localhost", server.port)),
      harness.socket,
    );
    await harness.nextFrame(isConnected("s"));
    harness.setAllowed(false);
    await harness.controller.handleFrame(dataFrame(id, "s", new Uint8Array(1)), harness.socket);
    await server.closed[0];
    expect(harness.controller.subscriptionCount).toBe(0);
    expect(harness.frames.filter((frame) => frame.opcode === TunnelOpcode.Data)).toEqual([]);
  });

  it("closes only the requesting connection's tunnel and frees its sockets", async () => {
    const server = await echoServer();
    const harness = createHarness();
    const id = await harness.open();
    await harness.controller.handleFrame(
      openFrame(id, "s", domain("localhost", server.port)),
      harness.socket,
    );
    await harness.nextFrame(isConnected("s"));

    const other = harness.attach();
    const denied = await harness.closeTunnel(id, other);
    expect(denied).toEqual({
      type: "network.tunnel.close.response",
      payload: {
        requestId: "close-2",
        ok: false,
        error: { code: "not_found", message: "Unknown network tunnel" },
      },
    });
    expect(harness.controller.subscriptionCount).toBe(1);

    const closed = await harness.closeTunnel(id);
    expect(closed).toEqual({
      type: "network.tunnel.close.response",
      payload: { requestId: "close-3", ok: true, subscriptionId: id },
    });
    await server.closed[0];
    expect(harness.controller.subscriptionCount).toBe(0);
  });

  it("limits tunnels per session", async () => {
    const harness = createHarness({ maxSubscriptions: 1 });
    await harness.open();
    await expect(harness.open()).rejects.toThrow("open failed: resource_limit");
  });

  it("refuses to open without the tunnel capability, on a legacy source, or without permission", async () => {
    const legacy = createHarness({ modern: false });
    await expect(legacy.open()).rejects.toThrow("open failed: unsupported_capability");

    const incapable = createHarness();
    incapable.setCapable(false);
    await expect(incapable.open()).rejects.toThrow("open failed: unsupported_capability");

    const forbidden = createHarness();
    forbidden.setAllowed(false);
    await expect(forbidden.open()).rejects.toThrow("open failed: permission_denied");
    expect(forbidden.controller.subscriptionCount).toBe(0);
  });

  it("rejects frames that do not belong to an owned subscription and drops late frames of a released one", async () => {
    const harness = createHarness();
    const id = await harness.open();
    const other = harness.attach();
    await expect(
      harness.controller.handleFrame(openFrame(id, "s", domain("localhost", 80)), other),
    ).rejects.toBeInstanceOf(TunnelProtocolError);
    await expect(
      harness.controller.handleFrame(
        openFrame("00000000-0000-4000-8000-000000000000", "s", domain("localhost", 80)),
        harness.socket,
      ),
    ).rejects.toBeInstanceOf(TunnelProtocolError);
    expect(harness.controller.streamCount(id)).toBe(0);

    await harness.closeTunnel(id);
    await harness.controller.handleFrame(dataFrame(id, "s", new Uint8Array(1)), harness.socket);
    expect(harness.frames).toEqual([]);
  });

  it("falls back to the next approved address when the first refuses", async () => {
    const server = await echoServer();
    const harness = createHarness({
      lookup: async () => [
        { address: "::1", family: 6 },
        { address: "127.0.0.1", family: 4 },
      ],
    });
    const id = await harness.open();
    await harness.controller.handleFrame(
      openFrame(id, "s", domain("dual.example", server.port)),
      harness.socket,
    );
    await harness.nextFrame(isConnected("s"));
    await vi.waitFor(() => expect(server.sockets).toHaveLength(1));
  });

  it("announces a daemon-initiated close as JSON before releasing, and stays silent for client closes", async () => {
    const violated = createHarness({ lookup: neverResolves });
    const id = await violated.open();
    await violated.controller.handleFrame(
      openFrame(id, "s", domain("slow.test", 80)),
      violated.socket,
    );
    await violated.controller.handleFrame(dataFrame(id, "s", new Uint8Array(1)), violated.socket);
    expect(violated.messages.filter((m) => m.type === "network.tunnel.closed")).toEqual([
      { type: "network.tunnel.closed", payload: { subscriptionId: id, reason: "protocol_error" } },
    ]);
    expect(violated.controller.subscriptionCount).toBe(0);

    const closed = createHarness();
    const closedId = await closed.open();
    await closed.closeTunnel(closedId);
    const detached = createHarness();
    await detached.open();
    await detached.delivery.detach(detached.socket);
    expect(closed.messages.filter((m) => m.type === "network.tunnel.closed")).toEqual([]);
    expect(detached.messages.filter((m) => m.type === "network.tunnel.closed")).toEqual([]);
  });

  it("announces revocation for every tunnel before releasing them", async () => {
    const server = await echoServer();
    const harness = createHarness();
    const first = await harness.open();
    const second = await harness.open();
    await harness.controller.handleFrame(
      openFrame(first, "s", domain("127.0.0.1", server.port)),
      harness.socket,
    );
    await harness.nextFrame(isConnected("s"));
    const revoked = harness.controller.revoke();
    expect(harness.messages.filter((m) => m.type === "network.tunnel.closed")).toEqual([
      { type: "network.tunnel.closed", payload: { subscriptionId: first, reason: "revoked" } },
      { type: "network.tunnel.closed", payload: { subscriptionId: second, reason: "revoked" } },
    ]);
    await revoked;
    await server.closed[0];
    expect(harness.controller.subscriptionCount).toBe(0);
    expect(harness.delivery.subscriptionIds(harness.socket, NETWORK_TUNNEL_FAMILY)).toEqual([]);
  });

  it("drops an Open on a subscription this connection recently lost, but not from another connection", async () => {
    const harness = createHarness({ lookup: neverResolves });
    const id = await harness.open();
    await harness.controller.handleFrame(
      openFrame(id, "s", domain("slow.test", 80)),
      harness.socket,
    );
    await harness.controller.handleFrame(dataFrame(id, "s", new Uint8Array(1)), harness.socket);
    expect(harness.controller.subscriptionCount).toBe(0);

    await harness.controller.handleFrame(
      openFrame(id, "late", domain("slow.test", 80)),
      harness.socket,
    );
    expect(harness.frames.filter((frame) => frame.streamId === "late")).toEqual([]);

    const other = harness.attach();
    await expect(
      harness.controller.handleFrame(openFrame(id, "late", domain("slow.test", 80)), other),
    ).rejects.toBeInstanceOf(TunnelProtocolError);
  });
});
