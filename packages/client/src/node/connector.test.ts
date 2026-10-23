import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, expect, test } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { createHostTransportFactory, HostTransportBudget } from "./index.js";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});
async function endpoint() {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(async () => {
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => server.close(() => resolve())));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  return { wss, url: `ws://127.0.0.1:${address.port}/ws` };
}
test("connector retains per-attempt headers and WebSocket subprotocols", async () => {
  const server = await endpoint();
  const connected = once(server.wss, "connection");
  const transport = createHostTransportFactory(server.url)({
    url: server.url,
    headers: { Authorization: "Bearer example" },
    protocols: ["paseo-test"],
  });
  cleanup.push(async () => transport.close());
  const [socket, request] = (await connected) as [WebSocket, import("node:http").IncomingMessage];
  expect(request.headers.authorization).toBe("Bearer example");
  expect(socket.protocol).toBe("paseo-test");
});
test("a slow consumer cannot exceed the shared byte budget and close releases reserved bytes", async () => {
  const server = await endpoint();
  const budget = new HostTransportBudget(4 * 1024 * 1024);
  const connected = once(server.wss, "connection");
  const transport = createHostTransportFactory(server.url, budget)({ url: server.url });
  cleanup.push(async () => transport.close());
  const ready = new Promise<void>((resolve) => transport.onOpen(resolve));
  const [socket] = (await connected) as [WebSocket];
  socket.pause();
  await ready;
  const frame = new Uint8Array(1024 * 1024);
  for (let index = 0; index < 4; index++) transport.send(frame);
  expect(budget.bufferedBytes).toBe(4 * 1024 * 1024);
  expect(() => transport.send(frame)).toThrow("Connected host buffer limit reached");
  expect(budget.bufferedBytes).toBeLessThanOrEqual(budget.limit);
  transport.close();
  await expect.poll(() => budget.bufferedBytes).toBe(0);
});
test("direct connector preserves 25 MiB binary frames in both directions", async () => {
  const server = await endpoint();
  const connected = once(server.wss, "connection");
  const transport = createHostTransportFactory(server.url)({ url: server.url });
  cleanup.push(async () => transport.close());
  const ready = new Promise<void>((resolve) => transport.onOpen(resolve));
  const received = new Promise<Uint8Array>((resolve, reject) => {
    transport.onMessage((bytes, binary) => binary && resolve(bytes as Uint8Array));
    transport.onError(reject);
  });
  const [socket] = (await connected) as [WebSocket];
  await ready;
  const bytes = new Uint8Array(25 * 1024 * 1024).fill(173);
  const echoed = once(socket, "message");
  transport.send(bytes);
  const [sent, binary] = await echoed;
  expect(binary).toBe(true);
  expect(Buffer.from(sent as Uint8Array).equals(bytes)).toBe(true);
  socket.send(bytes);
  expect(Buffer.from(await received).equals(bytes)).toBe(true);
});

import {
  createDaemonChannel,
  generateKeyPair,
  exportPublicKey,
  type Transport,
} from "@getpaseo/relay/e2ee";
test("encrypted connector rejects overload synchronously and preserves the physical link for sibling traffic", async () => {
  const server = await endpoint();
  const keys = generateKeyPair();
  const received: (string | ArrayBuffer)[] = [];
  let peer!: WebSocket;
  let ready!: Promise<unknown>;
  server.wss.on("connection", (socket) => {
    peer = socket;
    const wire: Transport = {
      send: (data) => socket.send(data),
      close: () => socket.close(),
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    socket.on("message", (data, isBinary) => {
      const bytes = Buffer.from(data as Buffer);
      wire.onmessage?.({
        data: isBinary
          ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
          : bytes.toString(),
        isBinary,
      });
    });
    ready = createDaemonChannel(wire, keys, {
      onmessage: (data) => {
        received.push(data);
      },
    });
  });
  const port = new URL(server.url).port;
  const budget = new HostTransportBudget(4 * 1024 * 1024);
  const transport = createHostTransportFactory(
    `relay://127.0.0.1:${port}/srv_slow?key=${encodeURIComponent(exportPublicKey(keys.publicKey))}`,
    budget,
  )({ url: server.url });
  cleanup.push(async () => transport.close());
  const errors: unknown[] = [];
  let closed = false;
  transport.onError((error) => errors.push(error));
  transport.onClose(() => {
    closed = true;
  });
  await new Promise<void>((resolve) => transport.onOpen(resolve));
  await ready;
  peer.pause();
  const frame = new Uint8Array(1024 * 1024).fill(173);
  let rejected: unknown;
  for (let index = 0; index < 8; index++) {
    try {
      transport.send(frame);
    } catch (error) {
      rejected = error;
      break;
    }
  }
  expect(rejected).toMatchObject({ code: "resource_limit" });
  expect(budget.bufferedBytes).toBeLessThanOrEqual(budget.limit);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(errors).toEqual([]);
  expect(closed).toBe(false);
  transport.send("sibling control");
  peer.resume();
  await expect.poll(() => received.includes("sibling control")).toBe(true);
  expect(received.filter((data) => data instanceof ArrayBuffer).length).toBeGreaterThan(0);
  expect(
    received
      .filter((data) => data instanceof ArrayBuffer)
      .every((data) => Buffer.from(data).equals(frame)),
  ).toBe(true);
  expect(server.wss.clients.size).toBe(1);
});

import { openDaemonSecureChannel } from "@getpaseo/relay/e2ee";
test("encrypted connector refuses legacy endpoint security on a later attempt once protected was negotiated", async () => {
  const server = await endpoint();
  const keys = generateKeyPair();
  const legacyReceived: unknown[] = [];
  let connections = 0;
  server.wss.on("connection", (socket) => {
    connections += 1;
    const wire: Transport = {
      send: (data) => socket.send(data),
      close: (code, reason) => socket.close(code, reason),
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    socket.on("message", (data, isBinary) => {
      const bytes = Buffer.from(data as Buffer);
      wire.onmessage?.({
        data: isBinary
          ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
          : bytes.toString(),
        isBinary,
      });
    });
    socket.on("close", (code, reason) => wire.onclose?.(code, reason.toString()));
    if (connections === 1) {
      void openDaemonSecureChannel(wire, { daemonKeyPair: keys }).catch(() => {});
    } else {
      // The daemon behind the relay now only speaks the legacy construction.
      void createDaemonChannel(wire, keys, {
        onmessage: (data) => legacyReceived.push(data),
      }).catch(() => {});
    }
  });
  const port = new URL(server.url).port;
  const factory = createHostTransportFactory(
    `relay://127.0.0.1:${port}/srv_latch?key=${encodeURIComponent(exportPublicKey(keys.publicKey))}`,
  );

  const first = factory({ url: server.url });
  cleanup.push(async () => first.close());
  await new Promise<void>((resolve) => first.onOpen(resolve));
  first.close();

  const second = factory({ url: server.url });
  cleanup.push(async () => second.close());
  let opened = false;
  second.onOpen(() => {
    opened = true;
  });
  const closed = await new Promise<unknown>((resolve) => second.onClose(resolve));
  expect(closed).toMatchObject({ code: 4002, reason: expect.stringContaining("legacy") });
  expect(opened).toBe(false);
  expect(legacyReceived).toEqual([]);
});
