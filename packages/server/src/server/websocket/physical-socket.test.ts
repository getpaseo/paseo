import { expect, test } from "vitest";
import {
  APPLICATION_SOCKET_LEASE_MS,
  ApplicationSocketLease,
  MAX_PHYSICAL_SOCKET_BUFFERED_BYTES,
  sendBoundedPhysicalFrame,
  sendBoundedPhysicalFrameAndWait,
} from "./physical-socket.js";

test("sockets remain exempt until they send an application ping", () => {
  let now = 0;
  const lease = new ApplicationSocketLease<object>(() => now);
  const legacySocket = {};
  now = APPLICATION_SOCKET_LEASE_MS * 10;

  expect(lease.listExpired()).toEqual([]);
  lease.renew(legacySocket);
  expect(lease.listExpired()).toEqual([]);
});

test("inbound activity renews a claimed lease", () => {
  let now = 0;
  const lease = new ApplicationSocketLease<object>(() => now);
  const applicationSocket = {};
  lease.claim(applicationSocket);

  now = APPLICATION_SOCKET_LEASE_MS - 1;
  lease.renew(applicationSocket);
  now += APPLICATION_SOCKET_LEASE_MS - 1;
  expect(lease.listExpired()).toEqual([]);

  now += 1;
  expect(lease.listExpired()).toEqual([applicationSocket]);
  lease.release(applicationSocket);
  expect(lease.listExpired()).toEqual([]);
});

test("an application ping claims a socket lease", () => {
  let now = 0;
  const lease = new ApplicationSocketLease<object>(() => now);
  const rawSocket = {};

  lease.claim(rawSocket);
  now = APPLICATION_SOCKET_LEASE_MS;

  expect(lease.listExpired()).toEqual([rawSocket]);
});

test("the shared physical send boundary rejects binary above the hard bound", () => {
  const sent: Array<string | Uint8Array | ArrayBuffer> = [];
  let terminated = false;
  const socket = {
    readyState: 1,
    bufferedAmount: MAX_PHYSICAL_SOCKET_BUFFERED_BYTES - 1,
    send: (data: string | Uint8Array | ArrayBuffer) => sent.push(data),
  };

  const accepted = sendBoundedPhysicalFrame({
    socket,
    frame: new Uint8Array(2),
    onHighWater: () => {
      terminated = true;
    },
  });

  expect(accepted).toBe(false);
  expect(sent).toEqual([]);
  expect(terminated).toBe(true);
});

test("the awaitable physical send resolves only when that frame send completes", async () => {
  const sent: Array<string | Uint8Array | ArrayBuffer> = [];
  let completeSend: (() => void) | undefined;
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send: (_data: string | Uint8Array | ArrayBuffer, callback?: (error?: Error) => void) => {
      sent.push(_data);
      if (callback) completeSend = () => callback();
    },
  };
  let completed = false;

  const sending = sendBoundedPhysicalFrameAndWait({
    socket,
    frame: new Uint8Array([1, 2, 3]),
    onHighWater: () => undefined,
  }).then(() => {
    return (completed = true);
  });

  await Promise.resolve();
  expect(completed).toBe(false);
  expect(
    sendBoundedPhysicalFrame({
      socket,
      frame: "unrelated",
      onHighWater: () => undefined,
    }),
  ).toBe(true);
  expect(sent).toEqual([new Uint8Array([1, 2, 3]), "unrelated"]);
  completeSend?.();
  await sending;
  expect(completed).toBe(true);
});

test("the awaitable physical send rejects callback errors", async () => {
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send: (_data: string | Uint8Array | ArrayBuffer, callback?: (error?: Error) => void) =>
      callback?.(new Error("send failed")),
  };

  await expect(
    sendBoundedPhysicalFrameAndWait({
      socket,
      frame: new Uint8Array([1]),
      onHighWater: () => undefined,
    }),
  ).rejects.toThrow("send failed");
});

test("ordinary frames expose a paused real socket's backlog and terminate at the physical backstop", async () => {
  const { once } = await import("node:events");
  const { WebSocket, WebSocketServer } = await import("ws");
  const { ChunkedTransport } = await import("@getpaseo/protocol/chunked-transport");
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const connected = once(server, "connection");
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("Missing server address");
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
  await once(client, "open");
  const [socket] = (await connected) as [InstanceType<typeof WebSocket>];
  const tcp = (socket as unknown as { _socket: import("node:net").Socket })._socket;
  let terminated = false;
  const transport = new ChunkedTransport({
    frameBytes: 32 * 1024 * 1024,
    deliver: () => {},
    send: (frame, wait) => {
      const options = {
        socket,
        frame,
        onHighWater: () => {
          terminated = true;
          socket.terminate();
        },
      };
      if (wait) return sendBoundedPhysicalFrameAndWait(options).then(() => undefined);
      sendBoundedPhysicalFrame(options);
    },
  });
  try {
    client.pause();
    tcp.cork();
    const frame = new Uint8Array(256 * 1024);
    for (let count = 0; count < 200; count++) await transport.send(frame);
    expect(socket.bufferedAmount).toBeGreaterThan(4 * 1024 * 1024);
    expect(transport.queuedByteLength).toBe(0);
    for (let count = 0; count < 100; count++) {
      if (terminated) break;
      await transport.send(frame);
    }
    expect(terminated).toBe(true);
  } finally {
    transport.close();
    client.terminate();
    socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("an awaited framing failure terminates its real socket immediately", async () => {
  const { once } = await import("node:events");
  const { WebSocket, WebSocketServer } = await import("ws");
  const { ChunkedTransport } = await import("@getpaseo/protocol/chunked-transport");
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const connected = once(server, "connection");
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("Missing server address");
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
  await once(client, "open");
  const [socket] = (await connected) as [InstanceType<typeof WebSocket>];
  const tcp = (socket as unknown as { _socket: import("node:net").Socket })._socket;
  const transport = new ChunkedTransport({
    frameBytes: 32 * 1024 * 1024,
    deliver: () => {},
    onFailure: () => socket.terminate(),
    send: (frame) =>
      sendBoundedPhysicalFrameAndWait({
        socket,
        frame,
        onHighWater: () => socket.terminate(),
      }).then(() => undefined),
  });
  transport.enabled = true;
  try {
    client.pause();
    tcp.cork();
    const closed = once(socket, "close");
    const first = transport.send(new Uint8Array(100 * 1024 * 1024), { waitForDrain: true });
    const overflow = transport.send(new Uint8Array([1]), { waitForDrain: true });
    const settled = Promise.allSettled([first, overflow]);
    await closed;
    expect(socket.readyState).toBe(WebSocket.CLOSED);
    expect((await settled).map((result) => result.status)).toEqual(["rejected", "rejected"]);
  } finally {
    transport.close();
    client.terminate();
    socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
