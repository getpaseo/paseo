import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocket, type RawData } from "ws";
import {
  TunnelCloseReason,
  TunnelOpcode,
  decodeTunnelFrame,
  encodeTunnelFrame,
  type TunnelFrame,
  type TunnelTarget,
} from "@getpaseo/protocol/binary-frames/index";
import { CLIENT_CAPS } from "@getpaseo/protocol/client-capabilities";
import {
  TUNNEL_CONNECT_TIMEOUT_MS,
  TUNNEL_INITIAL_WINDOW_BYTES,
  TUNNEL_MAX_DATA_BYTES,
  TUNNEL_MAX_STREAMS,
} from "@getpaseo/protocol/network-tunnel/rpc-schemas";
import {
  WSOutboundMessageSchema,
  type SessionInboundMessage,
  type SessionOutboundMessage,
  type WSOutboundMessage,
} from "@getpaseo/protocol/messages";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

type SessionEnvelope = Extract<WSOutboundMessage, { type: "session" }>;
type ServerInfo = Extract<
  Extract<SessionOutboundMessage, { type: "status" }>["payload"],
  { status: "server_info" }
>;

interface Client {
  ws: WebSocket;
  readonly serverInfo: ServerInfo;
  messages: SessionOutboundMessage[];
  frames: TunnelFrame[];
  nextMessage(
    predicate: (message: SessionOutboundMessage) => boolean,
  ): Promise<SessionOutboundMessage>;
  nextFrame(predicate: (frame: TunnelFrame) => boolean): Promise<TunnelFrame>;
  send(message: SessionInboundMessage): void;
  sendFrame(frame: TunnelFrame): void;
}

const TEST_TIMEOUT_MS = 30_000;
const tunnelCapabilities = {
  [CLIENT_CAPS.ownedSubscriptions]: true,
  [CLIENT_CAPS.networkTunnel]: true,
};

let daemon: TestPaseoDaemon | undefined;
const clients: Client[] = [];
const servers: net.Server[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.ws.terminate();
  for (const server of servers.splice(0))
    await new Promise((done) => server.close(() => done(null)));
  await daemon?.close();
  daemon = undefined;
});

async function startDaemon(): Promise<TestPaseoDaemon> {
  daemon = await createTestPaseoDaemon();
  return daemon;
}

function toBuffer(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw);
}

async function connect(
  port: number,
  capabilities: Record<string, boolean>,
  clientId = `tunnel-e2e-${Math.random().toString(36).slice(2)}`,
): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const messages: SessionOutboundMessage[] = [];
  const frames: TunnelFrame[] = [];
  const messageWaiters: Array<{
    predicate: (message: SessionOutboundMessage) => boolean;
    resolve: (message: SessionOutboundMessage) => void;
  }> = [];
  const frameWaiters: Array<{
    predicate: (frame: TunnelFrame) => boolean;
    resolve: (frame: TunnelFrame) => void;
  }> = [];
  ws.on("message", (raw, isBinary) => {
    const buffer = toBuffer(raw);
    if (isBinary) {
      const frame = decodeTunnelFrame(new Uint8Array(buffer));
      if (!frame) throw new Error("Daemon sent an undecodable binary frame");
      frames.push(frame);
      for (const waiter of frameWaiters.splice(0)) {
        if (waiter.predicate(frame)) waiter.resolve(frame);
        else frameWaiters.push(waiter);
      }
      return;
    }
    const parsed = WSOutboundMessageSchema.parse(JSON.parse(buffer.toString("utf8")));
    if (parsed.type !== "session") return;
    const message = (parsed as SessionEnvelope).message;
    messages.push(message);
    for (const waiter of messageWaiters.splice(0)) {
      if (waiter.predicate(message)) waiter.resolve(message);
      else messageWaiters.push(waiter);
    }
  });
  let serverInfo: ServerInfo | undefined;
  const client: Client = {
    ws,
    get serverInfo() {
      if (!serverInfo) throw new Error("hello not completed");
      return serverInfo;
    },
    messages,
    frames,
    nextMessage: (predicate) => {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => messageWaiters.push({ predicate, resolve }));
    },
    nextFrame: (predicate) => {
      const existing = frames.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => frameWaiters.push({ predicate, resolve }));
    },
    send: (message) => ws.send(JSON.stringify({ type: "session", message })),
    sendFrame: (frame) => ws.send(encodeTunnelFrame(frame)),
  };
  clients.push(client);
  const helloReady = client.nextMessage(
    (message) => message.type === "status" && message.payload.status === "server_info",
  );
  ws.send(
    JSON.stringify({
      type: "hello",
      clientId,
      clientType: "browser",
      protocolVersion: 1,
      capabilities,
    }),
  );
  const info = await helloReady;
  if (info.type !== "status" || info.payload.status !== "server_info") throw new Error("no hello");
  serverInfo = info.payload;
  return client;
}

async function openTunnel(client: Client, requestId: string): Promise<string> {
  const response = client.nextMessage(
    (message) =>
      message.type === "network.tunnel.open.response" && message.payload.requestId === requestId,
  );
  client.send({ type: "network.tunnel.open.request", requestId });
  const message = await response;
  if (message.type !== "network.tunnel.open.response" || !message.payload.ok) {
    throw new Error("tunnel open failed");
  }
  return message.payload.subscriptionId;
}

function listen(server: net.Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function target(port: number): TunnelTarget {
  return { atyp: 3, address: "127.0.0.1", port };
}

function sendCredit(client: Client, subscriptionId: string, streamId: string, credit: number) {
  client.sendFrame({ opcode: TunnelOpcode.WindowUpdate, subscriptionId, streamId, credit });
}

function echoServer(): net.Server {
  return net.createServer((socket) => socket.on("data", (chunk) => socket.write(chunk)));
}

function closedPromise(socket: net.Socket): Promise<void> {
  return new Promise((done) => socket.once("close", () => done()));
}

describe("daemon E2E - network tunnel", () => {
  test(
    "advertises the feature, opens a tunnel and streams an HTTP exchange through the host",
    async () => {
      // Below the initial window, so the whole response flows without returned credit.
      const body = "0123456789".repeat(20_000);
      const port = await listen(
        http.createServer((_request, response) => {
          response.writeHead(200, {
            "Content-Type": "text/plain",
            "Content-Length": String(body.length),
            Connection: "close",
          });
          response.end(body);
        }),
      );
      const { port: daemonPort } = await startDaemon();
      const client = await connect(daemonPort, tunnelCapabilities);
      expect(client.serverInfo.features?.networkTunnel).toBe(true);
      expect(client.serverInfo.permissions).toContain("network.proxy");

      const openResponse = client.nextMessage((m) => m.type === "network.tunnel.open.response");
      client.send({ type: "network.tunnel.open.request", requestId: "open-1" });
      const opened = await openResponse;
      if (opened.type !== "network.tunnel.open.response" || !opened.payload.ok) {
        throw new Error("tunnel open failed");
      }
      expect(opened.payload).toEqual({
        requestId: "open-1",
        ok: true,
        subscriptionId: opened.payload.subscriptionId,
        initialWindowBytes: TUNNEL_INITIAL_WINDOW_BYTES,
        maxDataBytes: TUNNEL_MAX_DATA_BYTES,
        maxStreams: TUNNEL_MAX_STREAMS,
        connectTimeoutMs: TUNNEL_CONNECT_TIMEOUT_MS,
      });
      const subscriptionId = opened.payload.subscriptionId;

      const streamId = "http-1";
      client.sendFrame({
        opcode: TunnelOpcode.Open,
        subscriptionId,
        streamId,
        target: target(port),
      });
      const connected = await client.nextFrame((frame) => frame.streamId === streamId);
      expect(connected.opcode).toBe(TunnelOpcode.Connected);

      const request = new TextEncoder().encode(
        "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
      );
      client.sendFrame({ opcode: TunnelOpcode.Data, subscriptionId, streamId, payload: request });
      let credited = 0;
      const closed = await client.nextFrame(
        (frame) => frame.opcode === TunnelOpcode.Close && frame.streamId === streamId,
      );
      expect(closed.opcode === TunnelOpcode.Close && closed.reason).toBe(TunnelCloseReason.Ok);

      const chunks: Uint8Array[] = [];
      let sawClose = false;
      for (const frame of client.frames) {
        if (frame.streamId !== streamId) continue;
        if (frame.opcode === TunnelOpcode.Data) {
          expect(sawClose).toBe(false);
          expect(frame.payload.length).toBeLessThanOrEqual(TUNNEL_MAX_DATA_BYTES);
          chunks.push(frame.payload);
        }
        if (frame.opcode === TunnelOpcode.WindowUpdate) credited += frame.credit;
        if (frame.opcode === TunnelOpcode.Close) sawClose = true;
      }
      const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
      expect(text.startsWith("HTTP/1.1 200")).toBe(true);
      expect(text.slice(text.indexOf("\r\n\r\n") + 4)).toBe(body);
      expect(credited).toBe(request.length);

      const closeResponse = client.nextMessage((m) => m.type === "network.tunnel.close.response");
      client.send({ type: "network.tunnel.close.request", requestId: "close-1", subscriptionId });
      expect(await closeResponse).toEqual({
        type: "network.tunnel.close.response",
        payload: { requestId: "close-1", ok: true, subscriptionId },
      });
      expect(client.messages.filter((m) => m.type === "network.tunnel.closed")).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "credits the daemon window chunk by chunk when the response exceeds the initial window",
    async () => {
      const payload = Buffer.alloc(TUNNEL_INITIAL_WINDOW_BYTES * 2 + 17, 42);
      const port = await listen(net.createServer((socket) => socket.end(payload)));
      const { port: daemonPort } = await startDaemon();
      const client = await connect(daemonPort, tunnelCapabilities);
      const subscriptionId = await openTunnel(client, "open-window");
      const streamId = "window";
      let received = 0;
      let firstPause = 0;
      client.ws.on("message", (raw, isBinary) => {
        if (!isBinary) return;
        const frame = decodeTunnelFrame(new Uint8Array(toBuffer(raw)));
        if (frame?.opcode !== TunnelOpcode.Data || frame.streamId !== streamId) return;
        received += frame.payload.length;
        if (received === TUNNEL_INITIAL_WINDOW_BYTES && firstPause === 0) {
          firstPause = received;
          // Hold the window for a moment, then release it all at once.
          setTimeout(
            sendCredit,
            100,
            client,
            subscriptionId,
            streamId,
            TUNNEL_INITIAL_WINDOW_BYTES,
          );
          return;
        }
        if (received > TUNNEL_INITIAL_WINDOW_BYTES) {
          sendCredit(client, subscriptionId, streamId, frame.payload.length);
        }
      });
      client.sendFrame({
        opcode: TunnelOpcode.Open,
        subscriptionId,
        streamId,
        target: target(port),
      });
      const closed = await client.nextFrame(
        (frame) => frame.opcode === TunnelOpcode.Close && frame.streamId === streamId,
      );
      expect(closed.opcode === TunnelOpcode.Close && closed.reason).toBe(TunnelCloseReason.Ok);
      expect(firstPause).toBe(TUNNEL_INITIAL_WINDOW_BYTES);
      expect(received).toBe(payload.length);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "hides network.proxy from clients without the capability and refuses to open for them",
    async () => {
      const { port: daemonPort } = await startDaemon();
      const legacy = await connect(daemonPort, { [CLIENT_CAPS.ownedSubscriptions]: true });
      expect(legacy.serverInfo.features?.networkTunnel).toBe(true);
      expect(legacy.serverInfo.permissions).not.toContain("network.proxy");
      expect(legacy.serverInfo.permissions).toContain("tunnel.manage");

      const response = legacy.nextMessage((m) => m.type === "network.tunnel.open.response");
      legacy.send({ type: "network.tunnel.open.request", requestId: "open-legacy" });
      expect(await response).toEqual({
        type: "network.tunnel.open.response",
        payload: {
          requestId: "open-legacy",
          ok: false,
          error: {
            code: "unsupported_capability",
            message:
              "Network tunnels require the owned_subscriptions and network_tunnel capabilities",
          },
        },
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a credit violation closes the stream, announces the tunnel closure as JSON and drops later frames",
    async () => {
      const port = await listen(echoServer());
      const { port: daemonPort } = await startDaemon();
      const client = await connect(daemonPort, tunnelCapabilities);
      const subscriptionId = await openTunnel(client, "open-violation");
      const streamId = "too-big";
      client.sendFrame({
        opcode: TunnelOpcode.Open,
        subscriptionId,
        streamId,
        target: target(port),
      });
      await client.nextFrame((frame) => frame.opcode === TunnelOpcode.Connected);
      const closedNotice = client.nextMessage((m) => m.type === "network.tunnel.closed");
      client.sendFrame({
        opcode: TunnelOpcode.Data,
        subscriptionId,
        streamId,
        payload: new Uint8Array(TUNNEL_MAX_DATA_BYTES + 1),
      });
      const streamClose = await client.nextFrame((frame) => frame.opcode === TunnelOpcode.Close);
      expect(streamClose).toEqual({
        opcode: TunnelOpcode.Close,
        subscriptionId,
        streamId,
        reason: TunnelCloseReason.ProtocolError,
      });
      expect(await closedNotice).toEqual({
        type: "network.tunnel.closed",
        payload: { subscriptionId, reason: "protocol_error" },
      });

      // A late Open on the lost subscription is dropped instead of tripping the protocol-failure path.
      client.sendFrame({
        opcode: TunnelOpcode.Open,
        subscriptionId,
        streamId: "late",
        target: target(port),
      });
      const pong = client.nextMessage((m) => m.type === "pong");
      client.send({ type: "ping", requestId: "ping-1", clientSentAt: Date.now() });
      await pong;
      expect(
        client.messages.filter((m) => m.type === "status" && m.payload.status === "error"),
      ).toEqual([]);
      expect(client.frames.filter((frame) => frame.streamId === "late")).toEqual([]);
      expect(client.ws.readyState).toBe(WebSocket.OPEN);

      const closeResponse = client.nextMessage((m) => m.type === "network.tunnel.close.response");
      client.send({
        type: "network.tunnel.close.request",
        requestId: "close-gone",
        subscriptionId,
      });
      expect(await closeResponse).toEqual({
        type: "network.tunnel.close.response",
        payload: {
          requestId: "close-gone",
          ok: false,
          error: { code: "not_found", message: "Unknown network tunnel" },
        },
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a tunnel frame without ownership closes only the offending socket of the session",
    async () => {
      const port = await listen(echoServer());
      const { port: daemonPort } = await startDaemon();
      const owner = await connect(daemonPort, tunnelCapabilities, "shared-tunnel-client");
      const sibling = await connect(daemonPort, tunnelCapabilities, "shared-tunnel-client");
      const subscriptionId = await openTunnel(owner, "open-owner");
      owner.sendFrame({
        opcode: TunnelOpcode.Open,
        subscriptionId,
        streamId: "s",
        target: target(port),
      });
      await owner.nextFrame((frame) => frame.opcode === TunnelOpcode.Connected);

      const siblingClosed = new Promise<number>((resolve) => sibling.ws.once("close", resolve));
      sibling.sendFrame({
        opcode: TunnelOpcode.Open,
        subscriptionId,
        streamId: "x",
        target: target(port),
      });
      expect(await siblingClosed).toBe(4004);

      const payload = new TextEncoder().encode("still here");
      owner.sendFrame({ opcode: TunnelOpcode.Data, subscriptionId, streamId: "s", payload });
      const echoed = await owner.nextFrame((frame) => frame.opcode === TunnelOpcode.Data);
      expect(echoed.opcode === TunnelOpcode.Data && Buffer.from(echoed.payload).toString()).toBe(
        "still here",
      );
      expect(owner.ws.readyState).toBe(WebSocket.OPEN);
      expect(owner.messages.filter((m) => m.type === "network.tunnel.closed")).toEqual([]);

      const stranger = await connect(daemonPort, tunnelCapabilities);
      const strangerClosed = new Promise<number>((resolve) => stranger.ws.once("close", resolve));
      stranger.sendFrame({
        opcode: TunnelOpcode.Open,
        subscriptionId: "00000000-0000-4000-8000-000000000000",
        streamId: "y",
        target: target(port),
      });
      expect(await strangerClosed).toBe(4004);
      expect(owner.ws.readyState).toBe(WebSocket.OPEN);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "releasing the subscription tears down its streams without a closed notice",
    async () => {
      let remoteClosed: Promise<void> | undefined;
      const port = await listen(
        net.createServer((socket) => {
          remoteClosed = closedPromise(socket);
        }),
      );
      const { port: daemonPort } = await startDaemon();
      const client = await connect(daemonPort, tunnelCapabilities);
      const subscriptionId = await openTunnel(client, "open-release");
      client.sendFrame({
        opcode: TunnelOpcode.Open,
        subscriptionId,
        streamId: "s",
        target: target(port),
      });
      await client.nextFrame((frame) => frame.opcode === TunnelOpcode.Connected);
      const released = client.nextMessage((m) => m.type === "subscription.release.response");
      client.send({ type: "subscription.release.request", requestId: "release-1", subscriptionId });
      await released;
      if (!remoteClosed) throw new Error("destination never accepted the stream");
      await remoteClosed;
      expect(client.messages.filter((m) => m.type === "network.tunnel.closed")).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});
