import { expect, test } from "vitest";
import { WebSocket, type RawData } from "ws";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "./test-utils/index.js";
import { WSOutboundMessageSchema, type WSOutboundMessage } from "./messages.js";

const LARGE_REQUEST_BYTES = 512 * 1024;
const BURST_MESSAGE_COUNT = 32;
const TEST_TIMEOUT_MS = 30_000;

interface SocketClose {
  code: number;
  reason: string;
}

class ResumedPhysicalSocketSession {
  private replacement: WebSocket | null = null;

  private constructor(
    private readonly daemon: TestPaseoDaemon,
    private readonly original: WebSocket,
  ) {}

  static async launch(): Promise<ResumedPhysicalSocketSession> {
    const daemon = await createTestPaseoDaemon();
    const original = await connectSocket(daemon.port, "stale-physical-socket");
    return new ResumedPhysicalSocketSession(daemon, original);
  }

  async abandonOriginal(): Promise<void> {
    this.original.pause();
  }

  async resumeSameClient(): Promise<void> {
    this.replacement = await connectSocket(this.daemon.port, "stale-physical-socket");
  }

  async broadcastUntilOriginalCloses(): Promise<SocketClose> {
    const replacement = this.requireReplacement();
    const originalClose = waitForClose(this.original);
    const finalRequestId = largeRequestId(BURST_MESSAGE_COUNT - 1);
    const finalResponse = waitForMessage(replacement, (message) => {
      return (
        message.type === "session" &&
        message.message.type === "pong" &&
        message.message.payload.requestId === finalRequestId
      );
    });

    for (let index = 0; index < BURST_MESSAGE_COUNT; index += 1) {
      replacement.send(
        JSON.stringify({
          type: "session",
          message: {
            type: "ping",
            requestId: largeRequestId(index),
            clientSentAt: index,
          },
        }),
      );
    }

    await finalResponse;
    this.original.resume();
    return originalClose;
  }

  async replacementRoundTrip(): Promise<void> {
    const replacement = this.requireReplacement();
    const requestId = "replacement-still-active";
    await sendAndWait(
      replacement,
      {
        type: "session",
        message: { type: "ping", requestId, clientSentAt: 1 },
      },
      (message) =>
        message.type === "session" &&
        message.message.type === "pong" &&
        message.message.payload.requestId === requestId,
    );
  }

  async close(): Promise<void> {
    this.original.terminate();
    this.replacement?.terminate();
    await this.daemon.close();
  }

  private requireReplacement(): WebSocket {
    if (!this.replacement) throw new Error("Replacement socket is not connected");
    return this.replacement;
  }
}

test(
  "a resumed stale socket is bounded and removed without disrupting its replacement",
  async () => {
    const session = await ResumedPhysicalSocketSession.launch();
    try {
      await session.abandonOriginal();
      await session.resumeSameClient();

      const originalClose = await session.broadcastUntilOriginalCloses();

      expect(originalClose).toEqual({ code: 1006, reason: "" });
      await session.replacementRoundTrip();
    } finally {
      await session.close();
    }
  },
  TEST_TIMEOUT_MS,
);

async function connectSocket(port: number, clientId: string): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
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
  return socket;
}

function largeRequestId(index: number): string {
  return `${index}:`.padEnd(LARGE_REQUEST_BYTES, "x");
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

function waitForClose(socket: WebSocket): Promise<SocketClose> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("close", onClose);
      reject(new Error("Timed out waiting for WebSocket to close"));
    }, TEST_TIMEOUT_MS);
    const onClose = (code: number, reason: Buffer) => {
      clearTimeout(timeout);
      resolve({ code, reason: reason.toString() });
    };
    socket.once("close", onClose);
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
