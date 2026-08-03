import { afterEach, describe, expect, test } from "vitest";
import type { AddressInfo, Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";

import { boundCloseHandshake, CLOSE_HANDSHAKE_TIMEOUT_MS } from "./websocket-close.js";

/**
 * `ws` waits 30s for a close frame to be answered before it drops the socket, so a peer
 * that never answers has to be bounded well inside the test timeout to prove anything.
 */
const BOUND_MS = 50;

const servers: WebSocketServer[] = [];
const sockets: WebSocket[] = [];
const accepted: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.terminate();
  }
  // A paused server-side socket never finishes closing on its own, so drop it by hand
  // before waiting on the server.
  for (const socket of accepted.splice(0)) {
    socket.destroy();
  }
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

/** Start a daemon-shaped WebSocket server. `answersClose` false = a wedged peer. */
async function startServer(options: { answersClose: boolean }): Promise<string> {
  const server = new WebSocketServer({ port: 0 });
  servers.push(server);
  server.on("connection", (_socket, request) => {
    accepted.push(request.socket);
    if (!options.answersClose) {
      // Stop reading from the socket: the close frame is never received, so the server
      // never answers it, and the client is left in CLOSING.
      request.socket.pause();
    }
  });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function connect(url: string, timeoutMs: number): Promise<WebSocket> {
  const socket = boundCloseHandshake(new WebSocket(url), timeoutMs);
  sockets.push(socket);
  await new Promise<void>((resolve) => socket.once("open", resolve));
  return socket;
}

function whenClosed(socket: WebSocket): Promise<{ code: number }> {
  return new Promise((resolve) => socket.once("close", (code) => resolve({ code })));
}

describe("boundCloseHandshake", () => {
  test("drops the socket when the peer never answers the close frame", async () => {
    const socket = await connect(await startServer({ answersClose: false }), BOUND_MS);
    const closed = whenClosed(socket);

    socket.close(1000, "Client closed");

    // 1006 (abnormal): the handshake was bounded and the socket dropped, rather than the
    // connection lingering until `ws` gives up 30s later and holding the CLI process open.
    expect(await closed).toEqual({ code: 1006 });
  }, 5000);

  test("completes the normal close handshake untouched", async () => {
    // Exercise the production deadline here. Reusing the deliberately tiny failure-test
    // bound makes a healthy loopback handshake compete with routine CI scheduling jitter.
    const socket = await connect(
      await startServer({ answersClose: true }),
      CLOSE_HANDSHAKE_TIMEOUT_MS,
    );
    const closed = whenClosed(socket);

    socket.close(1000, "Client closed");

    expect(await closed).toEqual({ code: 1000 });
  }, 5000);
});
