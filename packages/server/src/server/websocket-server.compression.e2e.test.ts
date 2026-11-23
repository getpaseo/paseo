import { expect, test } from "vitest";
import { WebSocket, type RawData } from "ws";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { createTestPaseoDaemon } from "./test-utils/index.js";
import { WSOutboundMessageSchema, type WSOutboundMessage } from "./messages.js";

const TEST_TIMEOUT_MS = 30_000;
const LARGE_PAYLOAD_BYTES = 64 * 1024;

interface ConnectedClient {
  socket: WebSocket;
  upgradeHeaders: IncomingMessage["headers"];
}

test(
  "negotiates permessage-deflate with no-context-takeover and compresses large frames on the wire",
  async () => {
    const daemon = await createTestPaseoDaemon();
    let client: ConnectedClient | null = null;
    try {
      client = await connectSocket(daemon.port, "compressed-client", true);

      const negotiated = String(client.upgradeHeaders["sec-websocket-extensions"] ?? "");
      expect(negotiated).toContain("permessage-deflate");
      expect(negotiated).toContain("server_no_context_takeover");
      expect(negotiated).toContain("client_no_context_takeover");

      const rawSocket = (client.socket as unknown as { _socket: Socket })._socket;
      const bytesReadBefore = rawSocket.bytesRead;
      const largeId = `compress-probe:${"abcdef0123456789".repeat(LARGE_PAYLOAD_BYTES / 16)}`;

      const pong = await sendAndWait(
        client.socket,
        {
          type: "session",
          message: {
            type: "ping",
            requestId: largeId,
            clientSentAt: 123,
          },
        },
        (message) =>
          message.type === "session" &&
          message.message.type === "pong" &&
          message.message.payload.requestId === largeId,
      );

      expect(pong.type).toBe("session");
      const wireBytesRead = rawSocket.bytesRead - bytesReadBefore;
      expect(wireBytesRead).toBeGreaterThan(0);
      expect(wireBytesRead).toBeLessThan(largeId.length * 0.15);
    } finally {
      client?.socket.terminate();
      await daemon.close();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "remains backward-compatible when a client connects without permessage-deflate",
  async () => {
    const daemon = await createTestPaseoDaemon();
    let client: ConnectedClient | null = null;
    try {
      client = await connectSocket(daemon.port, "plain-client", false);

      const negotiated = String(client.upgradeHeaders["sec-websocket-extensions"] ?? "");
      expect(negotiated).not.toContain("permessage-deflate");

      const pong = await sendAndWait(
        client.socket,
        {
          type: "session",
          message: {
            type: "ping",
            requestId: "plain-ping-1",
            clientSentAt: 456,
          },
        },
        (message) =>
          message.type === "session" &&
          message.message.type === "pong" &&
          message.message.payload.requestId === "plain-ping-1",
      );
      expect(pong.type).toBe("session");
    } finally {
      client?.socket.terminate();
      await daemon.close();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "round-trips small frames below the compression threshold without distortion",
  async () => {
    const daemon = await createTestPaseoDaemon();
    let client: ConnectedClient | null = null;
    try {
      client = await connectSocket(daemon.port, "small-frame-client", true);

      const pong = await sendAndWait(
        client.socket,
        {
          type: "session",
          message: {
            type: "ping",
            requestId: "tiny-ping",
            clientSentAt: 789,
          },
        },
        (message) =>
          message.type === "session" &&
          message.message.type === "pong" &&
          message.message.payload.requestId === "tiny-ping",
      );
      expect(pong.type).toBe("session");
    } finally {
      client?.socket.terminate();
      await daemon.close();
    }
  },
  TEST_TIMEOUT_MS,
);

async function connectSocket(
  port: number,
  clientId: string,
  perMessageDeflate: boolean,
): Promise<ConnectedClient> {
  let upgradeHeaders: IncomingMessage["headers"] = {};
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { perMessageDeflate });
  socket.once("upgrade", (response) => {
    upgradeHeaders = response.headers;
  });
  await waitForOpen(socket);
  await sendAndWait(
    socket,
    {
      type: "hello",
      clientId,
      clientType: "browser",
      protocolVersion: 1,
    },
    (message) =>
      message.type === "session" &&
      message.message.type === "status" &&
      message.message.payload.status === "server_info",
  );
  await sendAndWait(socket, { type: "ping" }, (message) => message.type === "pong");
  return { socket, upgradeHeaders };
}

function sendAndWait(
  socket: WebSocket,
  message: unknown,
  matches: (message: WSOutboundMessage) => boolean,
): Promise<WSOutboundMessage> {
  const response = waitForMessage(socket, matches);
  socket.send(JSON.stringify(message));
  return response;
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function waitForMessage(
  socket: WebSocket,
  matches: (message: WSOutboundMessage) => boolean,
): Promise<WSOutboundMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket message"));
    }, TEST_TIMEOUT_MS);
    const onMessage = (data: RawData) => {
      const parsed = WSOutboundMessageSchema.safeParse(JSON.parse(data.toString()));
      if (!parsed.success || !matches(parsed.data)) return;
      cleanup();
      resolve(parsed.data);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("WebSocket closed before the expected message arrived"));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("close", onClose);
    };
    socket.on("message", onMessage);
    socket.on("close", onClose);
  });
}
