import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import {
  createServer as createTcpServer,
  type AddressInfo,
  type Server as TcpServer,
} from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { buildRelayWebSocketUrl } from "@getpaseo/protocol/daemon-endpoints";
import {
  decodeNetworkTunnelFrame,
  encodeNetworkTunnelFrame,
  NetworkTunnelCloseReason,
  type DecodedNetworkTunnelFrame,
  type NetworkTunnelFrame,
} from "@getpaseo/protocol/network-tunnel";
import {
  openClientSecureChannel,
  type SecureChannel,
  type Transport as RelayClientTransport,
} from "@getpaseo/relay/e2ee";
import { loadOrCreateDaemonKeyPair } from "./daemon-keypair.js";
import {
  WSOutboundMessageSchema,
  WSTunnelHandshakeResponseSchema,
  type WSOutboundMessage,
  type WSTunnelHandshakeResponse,
} from "./messages.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "./test-utils/index.js";

const TEST_TIMEOUT_MS = 30_000;

interface TunnelClientHandle {
  ready: Extract<WSTunnelHandshakeResponse, { type: "tunnel_ready" }>;
  receivedTextAfterReady: string[];
  sendFrame: (frame: NetworkTunnelFrame) => Promise<void>;
  waitForFrame: (
    predicate: (frame: DecodedNetworkTunnelFrame) => boolean,
  ) => Promise<DecodedNetworkTunnelFrame>;
  collectStreamBytesUntilHalfClose: (streamId: number) => Promise<Buffer>;
  close: () => void;
}

let daemon: TestPaseoDaemon | undefined;
const httpServers: HttpServer[] = [];
const tcpServers: TcpServer[] = [];
const wsServers: WebSocketServer[] = [];
const openWebSockets: WebSocket[] = [];
const daemonClients: DaemonClient[] = [];

afterEach(async () => {
  for (const client of daemonClients.splice(0)) {
    await client.close().catch(() => undefined);
  }
  for (const ws of openWebSockets.splice(0)) {
    try {
      ws.terminate();
    } catch {
      // ignore
    }
  }
  await daemon?.close();
  daemon = undefined;
  await Promise.all([
    ...httpServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    ),
    ...tcpServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
    ...wsServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  ]);
});

async function startLocalHttpTarget(): Promise<{ port: number }> {
  const server = createHttpServer((req, res) => {
    if (req.url === "/hello") {
      res.writeHead(200, { "content-type": "text/plain", connection: "close" });
      res.end("hello from remote daemon target");
      return;
    }
    res.writeHead(404, { connection: "close" });
    res.end("not found");
  });
  httpServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return { port: (server.address() as AddressInfo).port };
}

async function startLocalHalfCloseTcpTarget(): Promise<{ port: number }> {
  const server = createTcpServer({ allowHalfOpen: true }, (socket) => {
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.on("end", () => {
      const full = Buffer.concat(chunks);
      // Stream response in two chunks to prove streaming + half-close ordering.
      socket.write(Buffer.from("ACK:"));
      setTimeout(() => {
        socket.end(full);
      }, 15);
    });
  });
  tcpServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return { port: (server.address() as AddressInfo).port };
}

async function startLocalRelayBridge(): Promise<{
  port: number;
  waitForServerControl: () => Promise<void>;
}> {
  const server = createHttpServer();
  const wss = new WebSocketServer({ server, path: "/ws" });
  httpServers.push(server);
  wsServers.push(wss);

  let controlSocket: WebSocket | null = null;
  let resolveControlReady!: () => void;
  const controlReady = new Promise<void>((resolve) => {
    resolveControlReady = resolve;
  });

  let nextConnectionSeq = 0;
  const clientSockets = new Map<string, WebSocket>();
  const pendingClientMessages = new Map<string, Array<{ data: RawData; isBinary: boolean }>>();

  wss.on("connection", (ws, req) => {
    openWebSockets.push(ws);
    const url = new URL(req.url ?? "/ws", "http://127.0.0.1");
    const role = url.searchParams.get("role");
    const connectionId = url.searchParams.get("connectionId");

    if (role === "server" && !connectionId) {
      controlSocket = ws;
      ws.send(JSON.stringify({ type: "sync", connectionIds: [] }));
      resolveControlReady();
      return;
    }

    if (role === "client") {
      const id = `conn-${++nextConnectionSeq}`;
      clientSockets.set(id, ws);
      const buffered: Array<{ data: RawData; isBinary: boolean }> = [];
      pendingClientMessages.set(id, buffered);
      ws.on("message", (data, isBinary) => {
        const queue = pendingClientMessages.get(id);
        if (queue) {
          queue.push({ data, isBinary });
        }
      });
      controlSocket?.send(JSON.stringify({ type: "connected", connectionId: id }));
      return;
    }

    if (role === "server" && connectionId) {
      const clientWs = clientSockets.get(connectionId);
      if (!clientWs) {
        ws.close(1008, "Unknown connectionId");
        return;
      }
      const queued = pendingClientMessages.get(connectionId) ?? [];
      pendingClientMessages.delete(connectionId);

      // Forward queued client messages to server data socket.
      for (const item of queued) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(item.data, { binary: item.isBinary });
        }
      }

      // Bridge live traffic transparently without decrypting (untrusted relay).
      clientWs.removeAllListeners("message");
      clientWs.on("message", (data, isBinary) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data, { binary: isBinary });
        }
      });
      ws.on("message", (data, isBinary) => {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(data, { binary: isBinary });
        }
      });
      clientWs.on("close", (code, reason) => {
        if (ws.readyState === WebSocket.OPEN) ws.close(code, reason.toString());
      });
      ws.on("close", (code, reason) => {
        if (clientWs.readyState === WebSocket.OPEN) clientWs.close(code, reason.toString());
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  return {
    port: (server.address() as AddressInfo).port,
    waitForServerControl: () => controlReady,
  };
}

async function connectDirectDaemonClient(port: number, clientId: string): Promise<DaemonClient> {
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${port}/ws`,
    clientId,
    webSocketFactory: (url) => {
      const ws = new WebSocket(url);
      openWebSockets.push(ws);
      return ws as unknown as NonNullable<
        ConstructorParameters<typeof DaemonClient>[0]["webSocketFactory"]
      > extends (u: string) => infer R
        ? R
        : never;
    },
  });
  daemonClients.push(client);
  await client.connect();
  return client;
}

async function openDirectTunnel(port: number, ticket: string): Promise<TunnelClientHandle> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  openWebSockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  const frames: DecodedNetworkTunnelFrame[] = [];
  const receivedTextAfterReady: string[] = [];
  const waiters: Array<{
    predicate: (frame: DecodedNetworkTunnelFrame) => boolean;
    resolve: (frame: DecodedNetworkTunnelFrame) => void;
  }> = [];

  let readyResolved = false;
  let resolveHandshake!: (msg: WSTunnelHandshakeResponse) => void;
  const handshakePromise = new Promise<WSTunnelHandshakeResponse>((resolve) => {
    resolveHandshake = resolve;
  });

  ws.on("message", (data, isBinary) => {
    if (!isBinary) {
      const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      if (!readyResolved) {
        readyResolved = true;
        resolveHandshake(WSTunnelHandshakeResponseSchema.parse(JSON.parse(text)));
      } else {
        receivedTextAfterReady.push(text);
      }
      return;
    }
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    const decoded = decodeNetworkTunnelFrame(
      new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
    );
    frames.push(decoded);
    for (let i = 0; i < waiters.length; i += 1) {
      const waiter = waiters[i]!;
      if (waiter.predicate(decoded)) {
        waiters.splice(i, 1);
        waiter.resolve(decoded);
        break;
      }
    }
  });

  ws.send(JSON.stringify({ type: "tunnel_hello", ticket }));
  const handshake = await handshakePromise;
  if (handshake.type !== "tunnel_ready") {
    throw new Error(`Expected tunnel_ready, got ${handshake.type}: ${handshake.code}`);
  }

  return createTunnelHandle({
    ready: handshake,
    frames,
    waiters,
    receivedTextAfterReady,
    sendBinary: async (bytes) => {
      await new Promise<void>((resolve, reject) => {
        ws.send(bytes, (err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
    },
    close: () => ws.close(),
  });
}

async function openRelayE2eeTunnel(params: {
  relayPort: number;
  serverId: string;
  daemonPublicKeyB64: string;
  ticket: string;
}): Promise<TunnelClientHandle> {
  const wsUrl = buildRelayWebSocketUrl({
    endpoint: `127.0.0.1:${params.relayPort}`,
    useTls: false,
    serverId: params.serverId,
    role: "client",
  });
  const rawWs = new WebSocket(wsUrl);
  openWebSockets.push(rawWs);
  await new Promise<void>((resolve, reject) => {
    rawWs.once("open", resolve);
    rawWs.once("error", reject);
  });

  const transport: RelayClientTransport = {
    send: (data) =>
      new Promise<void>((resolve, reject) => {
        rawWs.send(data, (err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      }),
    close: (code, reason) => rawWs.close(code, reason),
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  rawWs.on("message", (data, isBinary) => {
    if (!isBinary) {
      const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      transport.onmessage?.({ data: text, isBinary: false });
      return;
    }
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    const copy = new Uint8Array(buf.byteLength);
    copy.set(buf);
    transport.onmessage?.({ data: copy.buffer, isBinary: true });
  });
  rawWs.on("close", (code, reason) => transport.onclose?.(code, reason.toString()));
  rawWs.on("error", (err) => transport.onerror?.(err));

  const frames: DecodedNetworkTunnelFrame[] = [];
  const receivedTextAfterReady: string[] = [];
  const waiters: Array<{
    predicate: (frame: DecodedNetworkTunnelFrame) => boolean;
    resolve: (frame: DecodedNetworkTunnelFrame) => void;
  }> = [];

  let readyResolved = false;
  let resolveHandshake!: (msg: WSTunnelHandshakeResponse) => void;
  const handshakePromise = new Promise<WSTunnelHandshakeResponse>((resolve) => {
    resolveHandshake = resolve;
  });

  const channel: SecureChannel = await openClientSecureChannel(transport, {
    daemonPublicKeyB64: params.daemonPublicKeyB64,
    minimumMode: "protected",
    events: {
      onmessage: (data) => {
        if (typeof data === "string") {
          if (!readyResolved) {
            readyResolved = true;
            resolveHandshake(WSTunnelHandshakeResponseSchema.parse(JSON.parse(data)));
          } else {
            receivedTextAfterReady.push(data);
          }
          return;
        }
        const decoded = decodeNetworkTunnelFrame(new Uint8Array(data));
        frames.push(decoded);
        for (let i = 0; i < waiters.length; i += 1) {
          const waiter = waiters[i]!;
          if (waiter.predicate(decoded)) {
            waiters.splice(i, 1);
            waiter.resolve(decoded);
            break;
          }
        }
      },
    },
  });

  await channel.send(JSON.stringify({ type: "tunnel_hello", ticket: params.ticket }));
  const handshake = await handshakePromise;
  if (handshake.type !== "tunnel_ready") {
    throw new Error(`Expected tunnel_ready, got ${handshake.type}: ${handshake.code}`);
  }

  return createTunnelHandle({
    ready: handshake,
    frames,
    waiters,
    receivedTextAfterReady,
    sendBinary: async (bytes) => {
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      await channel.send(copy.buffer);
    },
    close: () => channel.close(),
  });
}

function createTunnelHandle(params: {
  ready: Extract<WSTunnelHandshakeResponse, { type: "tunnel_ready" }>;
  frames: DecodedNetworkTunnelFrame[];
  waiters: Array<{
    predicate: (frame: DecodedNetworkTunnelFrame) => boolean;
    resolve: (frame: DecodedNetworkTunnelFrame) => void;
  }>;
  receivedTextAfterReady: string[];
  sendBinary: (bytes: Uint8Array) => Promise<void>;
  close: () => void;
}): TunnelClientHandle {
  const waitForFrame = (predicate: (frame: DecodedNetworkTunnelFrame) => boolean) => {
    const existing = params.frames.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise<DecodedNetworkTunnelFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Timed out waiting for tunnel frame"));
      }, 10_000);
      params.waiters.push({
        predicate,
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
      });
    });
  };

  return {
    ready: params.ready,
    receivedTextAfterReady: params.receivedTextAfterReady,
    sendFrame: (frame) => params.sendBinary(encodeNetworkTunnelFrame(frame)),
    waitForFrame,
    collectStreamBytesUntilHalfClose: async (streamId: number) => {
      await waitForFrame(
        (frame) =>
          (frame.type === "half_close" || frame.type === "close") && frame.streamId === streamId,
      );
      return Buffer.concat(
        params.frames
          .filter(
            (frame): frame is Extract<DecodedNetworkTunnelFrame, { type: "data" }> =>
              frame.type === "data" && frame.streamId === streamId,
          )
          .map((frame) => Buffer.from(frame.data)),
      );
    },
    close: params.close,
  };
}

describe("WebSocketServer network tunnel E2E", () => {
  test(
    "direct secondary WS tunnels HTTP + streaming TCP half-close, blocks replay & SSRF, and receives zero control broadcasts",
    async () => {
      const httpTarget = await startLocalHttpTarget();
      const tcpTarget = await startLocalHalfCloseTcpTarget();
      daemon = await createTestPaseoDaemon();

      const control = await connectDirectDaemonClient(daemon.port, "tunnel-control-client");
      expect(control.getLastServerInfoMessage()?.features?.networkTunnel).toBe(true);

      const ticketResult = await control.createNetworkTunnelTicket();
      expect(ticketResult.ticket.length).toBeGreaterThanOrEqual(32);
      expect(ticketResult.expiresAtMs).toBeGreaterThan(Date.now());

      const tunnel = await openDirectTunnel(daemon.port, ticketResult.ticket);
      expect(tunnel.ready).toEqual({
        type: "tunnel_ready",
        maxFramePayloadBytes: 64 * 1024,
        initialStreamWindowBytes: 512 * 1024,
        initialConnectionWindowBytes: 4 * 1024 * 1024,
      });

      // Stream 1: real HTTP/1.1 request to local HTTP server
      await tunnel.sendFrame({
        type: "open",
        streamId: 1,
        host: "127.0.0.1",
        port: httpTarget.port,
      });
      await tunnel.waitForFrame((f) => f.type === "opened" && f.streamId === 1);
      await tunnel.sendFrame({
        type: "data",
        streamId: 1,
        data: new TextEncoder().encode(
          "GET /hello HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
        ),
      });
      const httpResponse = (await tunnel.collectStreamBytesUntilHalfClose(1)).toString("utf8");
      expect(httpResponse).toContain("HTTP/1.1 200 OK");
      expect(httpResponse).toContain("hello from remote daemon target");

      // Stream 2: streaming TCP + half-close
      await tunnel.sendFrame({
        type: "open",
        streamId: 2,
        host: "localhost",
        port: tcpTarget.port,
      });
      await tunnel.waitForFrame((f) => f.type === "opened" && f.streamId === 2);
      await tunnel.sendFrame({
        type: "data",
        streamId: 2,
        data: new TextEncoder().encode("part1-"),
      });
      await tunnel.sendFrame({
        type: "data",
        streamId: 2,
        data: new TextEncoder().encode("part2"),
      });
      await tunnel.sendFrame({ type: "half_close", streamId: 2 });
      const tcpResponse = (await tunnel.collectStreamBytesUntilHalfClose(2)).toString("utf8");
      expect(tcpResponse).toBe("ACK:part1-part2");

      // Stream 3 & 4: cloud metadata endpoints must be rejected
      await tunnel.sendFrame({ type: "open", streamId: 3, host: "169.254.169.254", port: 80 });
      const blockedIp = await tunnel.waitForFrame((f) => f.type === "close" && f.streamId === 3);
      expect(blockedIp.type === "close" && blockedIp.reason).toBe(
        NetworkTunnelCloseReason.PolicyDenied,
      );

      await tunnel.sendFrame({
        type: "open",
        streamId: 4,
        host: "metadata.google.internal",
        port: 80,
      });
      const blockedHost = await tunnel.waitForFrame((f) => f.type === "close" && f.streamId === 4);
      expect(blockedHost.type === "close" && blockedHost.reason).toBe(
        NetworkTunnelCloseReason.PolicyDenied,
      );

      // Replay of the already-used ticket must fail closed with tunnel_error + 4401
      const replayWs = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws`);
      openWebSockets.push(replayWs);
      await new Promise<void>((resolve, reject) => {
        replayWs.once("open", resolve);
        replayWs.once("error", reject);
      });
      const replayOutcome = new Promise<{ error: WSTunnelHandshakeResponse; closeCode: number }>(
        (resolve, reject) => {
          let errorMsg: WSTunnelHandshakeResponse | null = null;
          replayWs.on("message", (data, isBinary) => {
            if (isBinary) return;
            errorMsg = WSTunnelHandshakeResponseSchema.parse(JSON.parse(data.toString()));
          });
          replayWs.once("close", (code) => {
            if (!errorMsg) {
              reject(new Error(`Replay closed (${code}) without tunnel_error`));
              return;
            }
            resolve({ error: errorMsg, closeCode: code });
          });
        },
      );
      replayWs.send(JSON.stringify({ type: "tunnel_hello", ticket: ticketResult.ticket }));
      const replay = await replayOutcome;
      expect(replay.error).toEqual({
        type: "tunnel_error",
        code: "invalid_ticket",
        message: expect.any(String),
      });
      expect(replay.closeCode).toBe(4401);

      // Trigger a daemon-wide config broadcast and confirm a control observer receives it
      // while the tunnel WS receives ZERO control broadcasts.
      const broadcastObserver = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws`);
      openWebSockets.push(broadcastObserver);
      await new Promise<void>((resolve, reject) => {
        broadcastObserver.once("open", resolve);
        broadcastObserver.once("error", reject);
      });
      const observerReceivedConfigBroadcast = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Timed out waiting for daemon_config_changed broadcast")),
          5_000,
        );
        broadcastObserver.on("message", (data, isBinary) => {
          if (isBinary) return;
          const parsed = WSOutboundMessageSchema.safeParse(JSON.parse(data.toString()));
          if (
            parsed.success &&
            parsed.data.type === "session" &&
            parsed.data.message.type === "status" &&
            parsed.data.message.payload.status === "daemon_config_changed"
          ) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Timed out waiting for observer hello")),
          5_000,
        );
        const onMsg = (data: RawData, isBinary: boolean) => {
          if (isBinary) return;
          const parsed = WSOutboundMessageSchema.safeParse(JSON.parse(data.toString()));
          if (
            parsed.success &&
            parsed.data.type === "session" &&
            parsed.data.message.type === "status" &&
            parsed.data.message.payload.status === "server_info"
          ) {
            clearTimeout(timer);
            broadcastObserver.off("message", onMsg);
            resolve();
          }
        };
        broadcastObserver.on("message", onMsg);
        broadcastObserver.send(
          JSON.stringify({
            type: "hello",
            clientId: "broadcast-observer-client",
            clientType: "browser",
            protocolVersion: 1,
          }),
        );
      });

      await control.patchDaemonConfig({ resumeOnStartup: true });
      await observerReceivedConfigBroadcast;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(tunnel.receivedTextAfterReady).toEqual([]);

      tunnel.close();
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "E2EE relay secondary WS authenticates via tunnel_hello and pipes HTTP + streaming TCP over encrypted binary frames",
    async () => {
      const httpTarget = await startLocalHttpTarget();
      const tcpTarget = await startLocalHalfCloseTcpTarget();
      const relay = await startLocalRelayBridge();

      daemon = await createTestPaseoDaemon({
        relayEnabled: true,
        relayEndpoint: `127.0.0.1:${relay.port}`,
        relayUseTls: false,
        relayRequireProtectedSecurity: true,
      });
      await relay.waitForServerControl();

      const keyPair = await loadOrCreateDaemonKeyPair(daemon.paseoHome);
      const control = await connectDirectDaemonClient(daemon.port, "relay-tunnel-control");
      const { ticket } = await control.createNetworkTunnelTicket();

      const tunnel = await openRelayE2eeTunnel({
        relayPort: relay.port,
        serverId: daemon.daemon.getServerId(),
        daemonPublicKeyB64: keyPair.publicKeyB64,
        ticket,
      });
      expect(tunnel.ready.maxFramePayloadBytes).toBe(64 * 1024);

      // HTTP over E2EE relay binary tunnel
      await tunnel.sendFrame({
        type: "open",
        streamId: 1,
        host: "127.0.0.1",
        port: httpTarget.port,
      });
      await tunnel.waitForFrame((f) => f.type === "opened" && f.streamId === 1);
      await tunnel.sendFrame({
        type: "data",
        streamId: 1,
        data: new TextEncoder().encode(
          "GET /hello HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
        ),
      });
      const httpResponse = (await tunnel.collectStreamBytesUntilHalfClose(1)).toString("utf8");
      expect(httpResponse).toContain("hello from remote daemon target");

      // Streaming TCP + half-close over E2EE relay binary tunnel
      await tunnel.sendFrame({
        type: "open",
        streamId: 2,
        host: "127.0.0.1",
        port: tcpTarget.port,
      });
      await tunnel.waitForFrame((f) => f.type === "opened" && f.streamId === 2);
      await tunnel.sendFrame({
        type: "data",
        streamId: 2,
        data: new TextEncoder().encode("relay-e2ee-stream"),
      });
      await tunnel.sendFrame({ type: "half_close", streamId: 2 });
      const tcpResponse = (await tunnel.collectStreamBytesUntilHalfClose(2)).toString("utf8");
      expect(tcpResponse).toBe("ACK:relay-e2ee-stream");

      expect(tunnel.receivedTextAfterReady).toEqual([]);
      tunnel.close();
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "denies network.tunnel.create_ticket.request when principal lacks workspace.write permission",
    async () => {
      daemon = await createTestPaseoDaemon();

      const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws`);
      openWebSockets.push(ws);
      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });

      const sendAndWait = (
        payload: unknown,
        matches: (msg: WSOutboundMessage) => boolean,
      ): Promise<WSOutboundMessage> =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Timed out waiting for WS reply")),
            5_000,
          );
          const onMsg = (data: RawData, isBinary: boolean) => {
            if (isBinary) return;
            const parsed = WSOutboundMessageSchema.safeParse(JSON.parse(data.toString()));
            if (!parsed.success || !matches(parsed.data)) return;
            clearTimeout(timer);
            ws.off("message", onMsg);
            resolve(parsed.data);
          };
          ws.on("message", onMsg);
          ws.send(JSON.stringify(payload));
        });

      // Attenuate session permissions to read-only (no workspace.write).
      await sendAndWait(
        {
          type: "hello",
          clientId: "read-only-client",
          clientType: "browser",
          protocolVersion: 1,
          sessionPermissions: ["daemon.read", "workspace.read"],
        },
        (msg) =>
          msg.type === "session" &&
          msg.message.type === "status" &&
          msg.message.payload.status === "server_info",
      );

      const denied = await sendAndWait(
        {
          type: "session",
          message: {
            type: "network.tunnel.create_ticket.request",
            requestId: "req-denied-ticket",
          },
        },
        (msg) =>
          msg.type === "session" &&
          msg.message.type === "rpc_error" &&
          msg.message.payload.requestId === "req-denied-ticket",
      );

      expect(denied).toMatchObject({
        type: "session",
        message: {
          type: "rpc_error",
          payload: {
            requestId: "req-denied-ticket",
            requestType: "network.tunnel.create_ticket.request",
            code: "access_denied",
          },
        },
      });
    },
    TEST_TIMEOUT_MS,
  );
});
