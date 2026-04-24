import net from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { createNodeRelayServer, type NodeRelayServer } from "./node-adapter.js";

type SocketHarness = {
  ws: WebSocket;
  nextMessage(label: string): Promise<string | Buffer>;
  nextClose(label: string): Promise<{ code: number; reason: string }>;
};

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to acquire port")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

function waitForOpen(ws: WebSocket, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out opening ${label} websocket`)),
      10_000,
    );
    ws.once("open", () => {
      clearTimeout(timeout);
      resolve();
    });
    ws.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function connect(url: string, label: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  await waitForOpen(ws, label);
  return ws;
}

async function connectHarness(url: string, label: string): Promise<SocketHarness> {
  const ws = new WebSocket(url);
  const queuedMessages: Array<string | Buffer> = [];
  const waitingMessages: Array<(data: string | Buffer) => void> = [];
  const queuedCloses: Array<{ code: number; reason: string }> = [];
  const waitingCloses: Array<(close: { code: number; reason: string }) => void> = [];

  ws.on("message", (data) => {
    const message = data as string | Buffer;
    const waiter = waitingMessages.shift();
    if (waiter) {
      waiter(message);
      return;
    }
    queuedMessages.push(message);
  });

  ws.on("close", (code, reason) => {
    const close = { code, reason: reason.toString() };
    const waiter = waitingCloses.shift();
    if (waiter) {
      waiter(close);
      return;
    }
    queuedCloses.push(close);
  });

  await waitForOpen(ws, label);

  return {
    ws,
    nextMessage(messageLabel: string) {
      return new Promise((resolve, reject) => {
        if (queuedMessages.length > 0) {
          resolve(queuedMessages.shift()!);
          return;
        }
        const timeout = setTimeout(
          () => reject(new Error(`Timed out waiting for ${messageLabel}`)),
          10_000,
        );
        waitingMessages.push((message) => {
          clearTimeout(timeout);
          resolve(message);
        });
        ws.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });
    },
    nextClose(closeLabel: string) {
      return new Promise((resolve, reject) => {
        if (queuedCloses.length > 0) {
          resolve(queuedCloses.shift()!);
          return;
        }
        const timeout = setTimeout(
          () => reject(new Error(`Timed out waiting for ${closeLabel}`)),
          10_000,
        );
        waitingCloses.push((close) => {
          clearTimeout(timeout);
          resolve(close);
        });
        ws.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });
    },
  };
}

describe("Node relay adapter", () => {
  let relay: NodeRelayServer | null = null;

  afterEach(async () => {
    if (relay) {
      await relay.close();
      relay = null;
    }
  });

  test("serves /health", async () => {
    relay = await createNodeRelayServer({ host: "127.0.0.1", port: await getAvailablePort() });

    const response = await fetch(`http://127.0.0.1:${relay.port}/health`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  test("forwards v1 traffic in both directions", async () => {
    relay = await createNodeRelayServer({ host: "127.0.0.1", port: await getAvailablePort() });
    const serverId = `srv-v1-${Date.now()}`;

    const server = await connectHarness(
      `ws://127.0.0.1:${relay.port}/ws?serverId=${serverId}&role=server&v=1`,
      "v1 server",
    );
    const client = await connectHarness(
      `ws://127.0.0.1:${relay.port}/ws?serverId=${serverId}&role=client&v=1`,
      "v1 client",
    );

    try {
      client.ws.send("hello-server");
      const firstMessage = await server.nextMessage("v1 server message");
      expect(firstMessage.toString()).toBe("hello-server");

      server.ws.send("hello-client");
      const secondMessage = await client.nextMessage("v1 client message");
      expect(secondMessage.toString()).toBe("hello-client");
    } finally {
      server.ws.close();
      client.ws.close();
    }
  });

  test("assigns a connectionId for a v2 client without one and notifies control", async () => {
    relay = await createNodeRelayServer({ host: "127.0.0.1", port: await getAvailablePort() });
    const serverId = `srv-v2-${Date.now()}`;

    const control = await connectHarness(
      `ws://127.0.0.1:${relay.port}/ws?serverId=${serverId}&role=server&v=2`,
      "v2 control",
    );

    try {
      const syncRaw = await control.nextMessage("initial sync");
      expect(JSON.parse(syncRaw.toString())).toEqual({ type: "sync", connectionIds: [] });

      const client = await connectHarness(
        `ws://127.0.0.1:${relay.port}/ws?serverId=${serverId}&role=client&v=2`,
        "v2 client",
      );

      try {
        const connectedRaw = await control.nextMessage("connected");
        const connected = JSON.parse(connectedRaw.toString()) as {
          type: string;
          connectionId?: string;
        };
        expect(connected.type).toBe("connected");
        expect(connected.connectionId).toMatch(/^conn_/);
      } finally {
        client.ws.close();
      }
    } finally {
      control.ws.close();
    }
  });

  test("does not rely on global crypto when assigning a v2 connectionId", async () => {
    relay = await createNodeRelayServer({ host: "127.0.0.1", port: await getAvailablePort() });
    const serverId = `srv-v2-noglobal-${Date.now()}`;

    const originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      value: undefined,
      configurable: true,
      writable: true,
    });

    const control = await connectHarness(
      `ws://127.0.0.1:${relay.port}/ws?serverId=${serverId}&role=server&v=2`,
      "v2 control without global crypto",
    );

    try {
      const syncRaw = await control.nextMessage("initial sync without global crypto");
      expect(JSON.parse(syncRaw.toString())).toEqual({ type: "sync", connectionIds: [] });

      const client = await connectHarness(
        `ws://127.0.0.1:${relay.port}/ws?serverId=${serverId}&role=client&v=2`,
        "v2 client without global crypto",
      );

      try {
        const connectedRaw = await control.nextMessage("connected without global crypto");
        const connected = JSON.parse(connectedRaw.toString()) as {
          type: string;
          connectionId?: string;
        };
        expect(connected.type).toBe("connected");
        expect(connected.connectionId).toMatch(/^conn_/);
      } finally {
        client.ws.close();
      }
    } finally {
      if (originalCrypto === undefined) {
        Reflect.deleteProperty(globalThis, "crypto");
      } else {
        Object.defineProperty(globalThis, "crypto", {
          value: originalCrypto,
          configurable: true,
          writable: true,
        });
      }
      control.ws.close();
    }
  });

  test("keeps the relay alive when attaching a client socket fails", async () => {
    let shouldFailConnectionId = true;
    relay = await createNodeRelayServer({
      host: "127.0.0.1",
      port: await getAvailablePort(),
      createConnectionId() {
        if (shouldFailConnectionId) {
          shouldFailConnectionId = false;
          throw new Error("boom");
        }
        return `conn_recovered_${Date.now()}`;
      },
    });
    const serverId = `srv-v2-attach-failure-${Date.now()}`;

    const control = await connectHarness(
      `ws://127.0.0.1:${relay.port}/ws?serverId=${serverId}&role=server&v=2`,
      "v2 control for attach failure",
    );

    try {
      const syncRaw = await control.nextMessage("initial sync for attach failure");
      expect(JSON.parse(syncRaw.toString())).toEqual({ type: "sync", connectionIds: [] });

      const failingClient = await connectHarness(
        `ws://127.0.0.1:${relay.port}/ws?serverId=${serverId}&role=client&v=2`,
        "failing v2 client",
      );

      try {
        const close = await failingClient.nextClose("failing client close");
        expect(close.code).toBe(1011);
        expect(close.reason).toBe("Relay attach failed");
      } finally {
        failingClient.ws.close();
      }

      const response = await fetch(`http://127.0.0.1:${relay.port}/health`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ status: "ok" });

      const workingClient = await connectHarness(
        `ws://127.0.0.1:${relay.port}/ws?serverId=${serverId}&role=client&v=2`,
        "working v2 client after attach failure",
      );

      try {
        const connectedRaw = await control.nextMessage("connected after attach failure");
        const connected = JSON.parse(connectedRaw.toString()) as {
          type: string;
          connectionId?: string;
        };
        expect(connected.type).toBe("connected");
        expect(connected.connectionId).toMatch(/^conn_/);
      } finally {
        workingClient.ws.close();
      }
    } finally {
      control.ws.close();
    }
  });

  test("buffers client frames until the server data socket connects", async () => {
    relay = await createNodeRelayServer({ host: "127.0.0.1", port: await getAvailablePort() });
    const serverId = `srv-buffer-${Date.now()}`;
    const connectionId = `conn_buffer_${Date.now()}`;

    const control = await connectHarness(
      `ws://127.0.0.1:${relay.port}/ws?serverId=${serverId}&role=server&v=2`,
      "buffer control",
    );

    try {
      await control.nextMessage("initial sync");

      const client = await connectHarness(
        `ws://127.0.0.1:${relay.port}/ws?serverId=${serverId}&role=client&connectionId=${connectionId}&v=2`,
        "buffer client",
      );

      try {
        await control.nextMessage("connected");
        client.ws.send("buffered-payload");

        const dataServer = await connectHarness(
          `ws://127.0.0.1:${relay.port}/ws?serverId=${serverId}&role=server&connectionId=${connectionId}&v=2`,
          "buffer data server",
        );

        try {
          const bufferedPayload = await dataServer.nextMessage("buffered payload");
          expect(bufferedPayload.toString()).toBe("buffered-payload");
        } finally {
          dataServer.ws.close();
        }
      } finally {
        client.ws.close();
      }
    } finally {
      control.ws.close();
    }
  });

  test("closes server-data and notifies control when the last client disconnects", async () => {
    relay = await createNodeRelayServer({ host: "127.0.0.1", port: await getAvailablePort() });
    const serverId = `srv-disconnect-${Date.now()}`;
    const connectionId = `conn_disconnect_${Date.now()}`;

    const control = await connectHarness(
      `ws://127.0.0.1:${relay.port}/ws?serverId=${serverId}&role=server&v=2`,
      "disconnect control",
    );

    try {
      await control.nextMessage("initial sync");

      const client = await connectHarness(
        `ws://127.0.0.1:${relay.port}/ws?serverId=${serverId}&role=client&connectionId=${connectionId}&v=2`,
        "disconnect client",
      );
      const dataServer = await connectHarness(
        `ws://127.0.0.1:${relay.port}/ws?serverId=${serverId}&role=server&connectionId=${connectionId}&v=2`,
        "disconnect data server",
      );

      try {
        await control.nextMessage("connected");

        const closePromise = dataServer.nextClose("server data close");
        client.ws.close();

        await expect(closePromise).resolves.toMatchObject({
          code: 1001,
          reason: "Client disconnected",
        });

        const disconnectedRaw = await control.nextMessage("disconnected");
        expect(JSON.parse(disconnectedRaw.toString())).toEqual({
          type: "disconnected",
          connectionId,
        });
      } finally {
        if (client.ws.readyState === WebSocket.OPEN) client.ws.close();
        if (dataServer.ws.readyState === WebSocket.OPEN) dataServer.ws.close();
      }
    } finally {
      control.ws.close();
    }
  });
});
