import net from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import {
  decodeNetworkTunnelFrame,
  encodeNetworkTunnelFrame,
  type DecodedNetworkTunnelFrame,
  type NetworkTunnelFrame,
} from "@getpaseo/protocol/network-tunnel";
import { getHostBrowserProxyPartition } from "./partition.js";
import {
  createBrowserProxyManager,
  type BrowserProxyManager,
  type BrowserProxySessionLike,
  type BrowserProxyStatusSnapshot,
} from "./proxy-manager.js";
import type { BrowserProxyTarget, TunnelWireConnection } from "./tunnel-transport.js";

function createFakeSession(resolveProxyResult?: (url: string, proxyRules: string) => string) {
  const sessionObj: BrowserProxySessionLike & {
    lastProxyConfig: Parameters<BrowserProxySessionLike["setProxy"]>[0] | null;
    closeAllConnectionsCalls: number;
    resolvedUrls: string[];
  } = {
    lastProxyConfig: null,
    closeAllConnectionsCalls: 0,
    resolvedUrls: [],
    setProxy: async (config) => {
      sessionObj.lastProxyConfig = config;
    },
    closeAllConnections: async () => {
      sessionObj.closeAllConnectionsCalls += 1;
    },
    resolveProxy: async (url) => {
      sessionObj.resolvedUrls.push(url);
      const rules = sessionObj.lastProxyConfig?.proxyRules ?? "";
      if (resolveProxyResult) {
        return resolveProxyResult(url, rules);
      }
      const match = rules.match(/^socks5:\/\/(127\.0\.0\.1:\d+)$/);
      return match ? `SOCKS5 ${match[1]}` : "DIRECT";
    },
  };
  return sessionObj;
}

function createEchoTunnelWire() {
  const binaryListeners = new Set<(bytes: Uint8Array) => void>();
  const closeListeners = new Set<(error?: Error) => void>();
  const openedTargets: Array<{ host: string; port: number }> = [];
  let closed = false;

  const emit = (frame: NetworkTunnelFrame) => {
    const encoded = encodeNetworkTunnelFrame(frame);
    for (const listener of binaryListeners) listener(encoded);
  };

  const wire: TunnelWireConnection = {
    ready: {
      maxFramePayloadBytes: 64 * 1024,
      initialStreamWindowBytes: 512 * 1024,
      initialConnectionWindowBytes: 4 * 1024 * 1024,
    },
    sendBinary: async (bytes) => {
      if (closed) throw new Error("Wire closed");
      const frame: DecodedNetworkTunnelFrame = decodeNetworkTunnelFrame(bytes);
      if (frame.type === "open") {
        openedTargets.push({ host: frame.host, port: frame.port });
        queueMicrotask(() => {
          emit({ type: "opened", streamId: frame.streamId, initialWindowBytes: 512 * 1024 });
        });
      } else if (frame.type === "data") {
        queueMicrotask(() => {
          emit({
            type: "data",
            streamId: frame.streamId,
            data: Buffer.concat([Buffer.from("ECHO:"), Buffer.from(frame.data)]),
          });
        });
      } else if (frame.type === "half_close") {
        queueMicrotask(() => {
          emit({ type: "half_close", streamId: frame.streamId });
        });
      }
    },
    onBinary: (handler) => {
      binaryListeners.add(handler);
      return () => binaryListeners.delete(handler);
    },
    onClose: (handler) => {
      closeListeners.add(handler);
      return () => closeListeners.delete(handler);
    },
    close: () => {
      if (closed) return;
      closed = true;
      for (const listener of closeListeners) listener();
    },
  };

  return {
    wire,
    openedTargets,
    drop: () => {
      if (closed) return;
      closed = true;
      for (const listener of closeListeners) listener(new Error("dropped"));
    },
  };
}

async function socks5ConnectAndExchange(
  socksPort: number,
  targetHost: string,
  targetPort: number,
  payload: string,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: socksPort });
    let stage: "method" | "connect" | "data" = "method";
    let buffer = Buffer.alloc(0);
    const received: Buffer[] = [];

    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write(Buffer.from([0x05, 0x01, 0x00]));
    });
    socket.on("data", (chunk: Buffer) => {
      if (stage === "data") {
        received.push(chunk);
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === "method" && buffer.length >= 2) {
        if (buffer[0] !== 0x05 || buffer[1] !== 0x00) {
          socket.destroy();
          reject(new Error(`Unexpected method reply: ${buffer.subarray(0, 2).toString("hex")}`));
          return;
        }
        buffer = buffer.subarray(2);
        stage = "connect";
        const hostBuf = Buffer.from(targetHost, "utf8");
        const portBuf = Buffer.alloc(2);
        portBuf.writeUInt16BE(targetPort, 0);
        socket.write(
          Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]), hostBuf, portBuf]),
        );
      }
      if (stage === "connect" && buffer.length >= 10) {
        if (buffer[1] !== 0x00) {
          socket.destroy();
          reject(new Error(`SOCKS5 CONNECT failed with code ${buffer[1]}`));
          return;
        }
        const extra = buffer.subarray(10);
        if (extra.length > 0) received.push(extra);
        buffer = Buffer.alloc(0);
        stage = "data";
        socket.end(Buffer.from(payload, "utf8"));
      }
    });
    socket.once("end", () => {
      resolve(Buffer.concat(received).toString("utf8"));
    });
  });
}

describe("BrowserProxyManager", () => {
  const managers: BrowserProxyManager[] = [];

  afterEach(async () => {
    while (managers.length > 0) {
      await managers.pop()!.disposeAll();
    }
  });

  test("configures fixed-port SOCKS5 + session proxy, verifies resolveProxy, and keeps the same port across tunnel reconnect", async () => {
    const sessionsByPartition = new Map<string, ReturnType<typeof createFakeSession>>();
    const wires: Array<ReturnType<typeof createEchoTunnelWire>> = [];
    const requestedTickets: string[] = [];
    const statuses: BrowserProxyStatusSnapshot[] = [];

    const manager = createBrowserProxyManager({
      verifySocketOwner: async () => true,
      requestTicket: async (serverId) => {
        requestedTickets.push(serverId);
        return `ticket-${requestedTickets.length}`;
      },
      openTunnelWire: async () => {
        const created = createEchoTunnelWire();
        wires.push(created);
        return created.wire;
      },
      getSessionForPartition: (partition) => {
        let session = sessionsByPartition.get(partition);
        if (!session) {
          session = createFakeSession();
          sessionsByPartition.set(partition, session);
        }
        return session;
      },
      onStatusChange: (status) => statuses.push(status),
    });
    managers.push(manager);

    const target: BrowserProxyTarget = { type: "directTcp", endpoint: "10.0.0.5:6767" };
    const ready = await manager.ensureHostProxy({ serverId: "remote-1", target });
    const expectedPartition = getHostBrowserProxyPartition("remote-1");

    expect(ready.status).toBe("ready");
    expect(ready.partition).toBe(expectedPartition);
    expect(ready.socksPort).toBeGreaterThan(0);
    expect(manager.isAllowedHostPartition(expectedPartition)).toBe(true);
    expect(manager.isProxiedSession(sessionsByPartition.get(expectedPartition)!)).toBe(true);

    const session = sessionsByPartition.get(expectedPartition)!;
    expect(session.lastProxyConfig).toEqual({
      mode: "fixed_servers",
      proxyRules: `socks5://127.0.0.1:${ready.socksPort}`,
      proxyBypassRules: "<-loopback>",
    });
    expect(session.closeAllConnectionsCalls).toBe(1);
    expect(session.resolvedUrls).toContain("http://localhost:80/");
    expect(session.resolvedUrls).toContain("http://127.0.0.1:80/");

    // First SOCKS5 connection goes through wire 1
    const firstReply = await socks5ConnectAndExchange(ready.socksPort!, "localhost", 5173, "hello");
    expect(firstReply).toBe("ECHO:hello");
    expect(wires).toHaveLength(1);
    expect(wires[0]!.openedTargets).toEqual([{ host: "localhost", port: 5173 }]);

    // Drop wire 1 -> status becomes reconnecting, SOCKS5 port stays fixed!
    wires[0]!.drop();
    expect(manager.getHostProxyStatus("remote-1")?.status).toBe("reconnecting");
    expect(manager.getHostProxyStatus("remote-1")?.socksPort).toBe(ready.socksPort);

    // Next SOCKS5 connection on the SAME fixed port transparently reconnects with a fresh ticket!
    const secondReply = await socks5ConnectAndExchange(
      ready.socksPort!,
      "app.localhost",
      6767,
      "again",
    );
    expect(secondReply).toBe("ECHO:again");
    expect(wires).toHaveLength(2);
    expect(requestedTickets).toEqual(["remote-1", "remote-1"]);
    expect(manager.getHostProxyStatus("remote-1")?.status).toBe("ready");
    expect(manager.getHostProxyStatus("remote-1")?.socksPort).toBe(ready.socksPort);
    expect(statuses.some((s) => s.status === "reconnecting")).toBe(true);
  });

  test("rejects SOCKS5 connections from unauthorized OS socket owners before handshake", async () => {
    const wire = createEchoTunnelWire();
    const session = createFakeSession();
    const manager = createBrowserProxyManager({
      verifySocketOwner: async () => false,
      requestTicket: async () => "ticket-1",
      openTunnelWire: async () => wire.wire,
      getSessionForPartition: () => session,
    });
    managers.push(manager);

    const ready = await manager.ensureHostProxy({
      serverId: "remote-owner-check",
      target: { type: "directTcp", endpoint: "10.0.0.9:6767" },
    });

    const outcome = await new Promise<"closed_without_data" | "received_data">((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port: ready.socksPort! });
      let sawData = false;
      socket.on("data", () => {
        sawData = true;
      });
      socket.once("connect", () => {
        socket.write(Buffer.from([0x05, 0x01, 0x00]));
      });
      socket.once("close", () => {
        resolve(sawData ? "received_data" : "closed_without_data");
      });
      socket.once("error", () => {
        // ECONNRESET after server destroys socket is expected
      });
    });

    expect(outcome).toBe("closed_without_data");
    expect(wire.openedTargets).toEqual([]);
  });

  test("fails closed when session.resolveProxy does not confirm the SOCKS5 proxy for loopback", async () => {
    const wire = createEchoTunnelWire();
    const brokenSession = createFakeSession(() => "DIRECT");
    const manager = createBrowserProxyManager({
      verifySocketOwner: async () => true,
      requestTicket: async () => "ticket-1",
      openTunnelWire: async () => wire.wire,
      getSessionForPartition: () => brokenSession,
    });
    managers.push(manager);

    const result = await manager.ensureHostProxy({
      serverId: "remote-broken-proxy",
      target: { type: "directTcp", endpoint: "10.0.0.10:6767" },
    });

    expect(result.status).toBe("error");
    expect(result.socksPort).toBeNull();
    expect(result.error).toMatch(/resolveProxy|proxy/i);
    expect(manager.isAllowedHostPartition(result.partition)).toBe(false);
  });

  test("keeps socksPort null on initial tunnel failure, and preserves socksPort across later reconnect errors", async () => {
    const session = createFakeSession();
    let wireCalls = 0;
    let failTicket = true;
    const wires: Array<ReturnType<typeof createEchoTunnelWire>> = [];

    const manager = createBrowserProxyManager({
      verifySocketOwner: async () => true,
      requestTicket: async () => {
        if (failTicket) {
          throw new Error("host disconnected");
        }
        return `ticket-${wireCalls + 1}`;
      },
      openTunnelWire: async () => {
        wireCalls += 1;
        const created = createEchoTunnelWire();
        wires.push(created);
        return created.wire;
      },
      getSessionForPartition: () => session,
    });
    managers.push(manager);

    const target: BrowserProxyTarget = { type: "directTcp", endpoint: "10.0.0.11:6767" };
    const initialFail = await manager.ensureHostProxy({ serverId: "remote-flaky", target });
    expect(initialFail.status).toBe("error");
    expect(initialFail.socksPort).toBeNull();
    expect(manager.isAllowedHostPartition(initialFail.partition)).toBe(false);

    failTicket = false;
    const ready = await manager.ensureHostProxy({ serverId: "remote-flaky", target });
    expect(ready.status).toBe("ready");
    expect(ready.socksPort).toBeGreaterThan(0);

    // Simulate outage + background page poll (e.g. HMR) failing tunnel reconnect.
    failTicket = true;
    wires[0]!.drop();
    await expect(
      socks5ConnectAndExchange(ready.socksPort!, "localhost", 5173, "hmr-poll"),
    ).rejects.toThrow(/SOCKS5 CONNECT failed/);
    const afterPollError = manager.getHostProxyStatus("remote-flaky");
    expect(afterPollError?.status).toBe("error");
    expect(afterPollError?.socksPort).toBe(ready.socksPort);

    // Host recovers -> next ensureHostProxy brings the same fixed port back to ready.
    failTicket = false;
    const recovered = await manager.ensureHostProxy({
      serverId: "remote-flaky",
      target,
      forceReconnect: true,
    });
    expect(recovered.status).toBe("ready");
    expect(recovered.socksPort).toBe(ready.socksPort);
  });
});
