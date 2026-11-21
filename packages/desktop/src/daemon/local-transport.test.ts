import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  buildSshArgs,
  createLocalTransportManager,
  LOCAL_TRANSPORT_SETUP_TIMEOUT_MS,
  parseTransportTarget,
  resolveSshFailureDetail,
  type TransportEndpoint,
  type TransportEventPayload,
  type TransportTarget,
  type TransportWebSocket,
} from "./local-transport";

const SESSION_INPUT = {
  sessionId: "local-session-test",
  target: { transportType: "ssh", host: "build-box" },
} as const;

function createConnectingSocket(): TransportWebSocket & {
  close: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
} {
  return {
    readyState: 0,
    once: vi.fn(),
    on: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
    terminate: vi.fn(),
  } as unknown as TransportWebSocket & {
    close: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
  };
}

function createEndpoint(): TransportEndpoint & { close: ReturnType<typeof vi.fn> } {
  return {
    url: "ws://127.0.0.1:12345/ws",
    close: vi.fn(),
    failureDetail: () => null,
  };
}

interface ScheduledTimeout {
  callback: () => void;
  delayMs: number;
  cancelled: boolean;
}

function createManagerHarness(
  resolveEndpoint: () => Promise<TransportEndpoint>,
  sockets: TransportWebSocket[],
) {
  const events: TransportEventPayload[] = [];
  const scheduledTimeouts: ScheduledTimeout[] = [];
  const createWebSocket = vi.fn(() => {
    const socket = sockets.shift();
    if (!socket) {
      throw new Error("No fake WebSocket is available");
    }
    return socket;
  });
  const manager = createLocalTransportManager({
    resolveEndpoint,
    createWebSocket,
    scheduleTimeout(callback, delayMs) {
      const scheduled = { callback, delayMs, cancelled: false };
      scheduledTimeouts.push(scheduled);
      return () => {
        scheduled.cancelled = true;
      };
    },
    emitEvent: (event) => events.push(event),
  });
  return { createWebSocket, events, manager, scheduledTimeouts };
}

describe("Remote SSH desktop transport", () => {
  it("builds a batch-mode SSH stdio tunnel with optional connection settings", () => {
    expect(
      buildSshArgs({
        transportType: "ssh",
        host: "deploy@example.com",
        sshPort: 2222,
        daemonPort: 7777,
      }),
    ).toEqual([
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ClearAllForwardings=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-p",
      "2222",
      "-W",
      "127.0.0.1:7777",
      "deploy@example.com",
    ]);
  });

  it("rejects unsafe SSH targets at the IPC boundary", () => {
    expect(() =>
      parseTransportTarget({ transportType: "ssh", host: "-oProxyCommand=bad" }),
    ).toThrow("SSH host is invalid");
    expect(() =>
      parseTransportTarget({ transportType: "ssh", host: "build-box", sshPort: 0 }),
    ).toThrow("SSH port must be between 1 and 65535");
    expect(() =>
      parseTransportTarget({ transportType: "ssh", host: "build-box", daemonPort: 65536 }),
    ).toThrow("Daemon port must be between 1 and 65535");
  });

  it("surfaces SSH stderr before the child exit event settles", () => {
    expect(resolveSshFailureDetail(null, "Permission denied.\n")).toBe("Permission denied.");
    expect(resolveSshFailureDetail("ssh exited with code 255", "earlier stderr")).toBe(
      "ssh exited with code 255",
    );
  });
});

describe("local transport session lifecycle", () => {
  it.each<TransportTarget>([
    SESSION_INPUT.target,
    { transportType: "socket", transportPath: "/tmp/paseo-test.sock" },
    { transportType: "pipe", transportPath: "\\\\.\\pipe\\paseo-test" },
  ])(
    "preserves real WebSocket text and binary frames for $transportType sessions",
    async (target) => {
      const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      await once(server, "listening");
      const address = server.address();
      if (typeof address === "string" || address === null) {
        throw new Error("Expected a TCP WebSocket address");
      }
      const events: TransportEventPayload[] = [];
      let receiveMessage: (() => void) | undefined;
      const manager = createLocalTransportManager({
        resolveEndpoint: async () => ({
          url: `ws://127.0.0.1:${address.port}/ws`,
          close: () => undefined,
          failureDetail: () => null,
        }),
        createWebSocket: (url) => new WebSocket(url),
        scheduleTimeout: () => () => undefined,
        emitEvent: (event) => {
          events.push(event);
          receiveMessage?.();
        },
      });
      try {
        const connected = once(server, "connection");
        const opened = new Promise<void>((resolve) => {
          receiveMessage = resolve;
        });
        manager.open({ ...SESSION_INPUT, target });
        const [peer] = await connected;
        await opened;
        for (const text of ['{"sessions":[]}', "导入会话 🐈 café", ""]) {
          const received = new Promise<void>((resolve) => {
            receiveMessage = resolve;
          });
          peer.send(text);
          await received;
          expect(events.at(-1)).toEqual({
            sessionId: SESSION_INPUT.sessionId,
            kind: "message",
            text,
          });
        }
        for (const bytes of [Buffer.from([0, 255, 128, 1]), Buffer.from("会话"), Buffer.alloc(0)]) {
          const received = new Promise<void>((resolve) => {
            receiveMessage = resolve;
          });
          peer.send(bytes);
          await received;
          expect(events.at(-1)).toEqual({
            sessionId: SESSION_INPUT.sessionId,
            kind: "message",
            binaryBase64: bytes.toString("base64"),
          });
        }
        const textReceived = once(peer, "message");
        await manager.send({ sessionId: SESSION_INPUT.sessionId, text: "发往 daemon" });
        const [textBytes, textIsBinary] = await textReceived;
        expect([textBytes.toString(), textIsBinary]).toEqual(["发往 daemon", false]);

        const binaryReceived = once(peer, "message");
        await manager.send({ sessionId: SESSION_INPUT.sessionId, binaryBase64: "AP+A" });
        const [binaryBytes, binaryIsBinary] = await binaryReceived;
        expect([binaryBytes, binaryIsBinary]).toEqual([Buffer.from([0, 255, 128]), true]);
      } finally {
        manager.closeAll();
        for (const client of server.clients) client.terminate();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it("releases an opening transport when its setup deadline expires", async () => {
    const firstEndpoint = createEndpoint();
    const secondEndpoint = createEndpoint();
    const firstSocket = createConnectingSocket();
    const secondSocket = createConnectingSocket();
    const endpoints = [firstEndpoint, secondEndpoint];
    const { events, manager, scheduledTimeouts } = createManagerHarness(
      async () => endpoints.shift() ?? createEndpoint(),
      [firstSocket, secondSocket],
    );

    manager.open(SESSION_INPUT);
    await Promise.resolve();

    expect(scheduledTimeouts[0]?.delayMs).toBe(LOCAL_TRANSPORT_SETUP_TIMEOUT_MS);
    scheduledTimeouts[0]?.callback();

    expect(firstSocket.terminate).toHaveBeenCalledTimes(1);
    expect(firstEndpoint.close).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      {
        sessionId: SESSION_INPUT.sessionId,
        kind: "error",
        error: "Connection to Remote SSH host build-box timed out during setup.",
      },
    ]);

    manager.close(SESSION_INPUT.sessionId);
    expect(firstSocket.terminate).toHaveBeenCalledTimes(1);
    expect(firstEndpoint.close).toHaveBeenCalledTimes(1);

    expect(() => manager.open(SESSION_INPUT)).not.toThrow();
    await Promise.resolve();
    manager.close(SESSION_INPUT.sessionId);
    expect(secondSocket.terminate).toHaveBeenCalledTimes(1);
    expect(secondEndpoint.close).toHaveBeenCalledTimes(1);
  });

  it("releases a connecting transport when the caller closes it", async () => {
    const endpoint = createEndpoint();
    const socket = createConnectingSocket();
    const { events, manager, scheduledTimeouts } = createManagerHarness(
      async () => endpoint,
      [socket],
    );

    manager.open(SESSION_INPUT);
    await Promise.resolve();
    manager.close(SESSION_INPUT.sessionId);
    manager.close(SESSION_INPUT.sessionId);

    expect(socket.terminate).toHaveBeenCalledTimes(1);
    expect(endpoint.close).toHaveBeenCalledTimes(1);
    expect(scheduledTimeouts[0]?.cancelled).toBe(true);
    expect(events).toEqual([]);
  });

  it("closes an endpoint that resolves after the caller cancels setup", async () => {
    const endpoint = createEndpoint();
    let resolveEndpoint: ((endpoint: TransportEndpoint) => void) | null = null;
    const endpointPromise = new Promise<TransportEndpoint>((resolve) => {
      resolveEndpoint = resolve;
    });
    const socket = createConnectingSocket();
    const { createWebSocket, events, manager } = createManagerHarness(
      () => endpointPromise,
      [socket],
    );

    manager.open(SESSION_INPUT);
    manager.close(SESSION_INPUT.sessionId);
    resolveEndpoint?.(endpoint);
    await Promise.resolve();
    await Promise.resolve();

    expect(endpoint.close).toHaveBeenCalledTimes(1);
    expect(createWebSocket).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });
});
