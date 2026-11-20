import { createServer as createHttpServer } from "node:http";
import { connect, createServer as createTcpServer, type AddressInfo, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { expect, test, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { HubRelationshipController } from "./relationship-controller.js";
import { DirectHubRelationshipRemote } from "./relationship-remote.js";

test("a silently lost Hub connection leaves connected state and reconnects when the path recovers", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-hub-liveness-"));
  const hub = createHttpServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const enrollment = JSON.parse(body) as { daemonId: string };
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        daemonId: enrollment.daemonId,
        permissions: ["hub.execute"],
        webSocketUrl: `ws://127.0.0.1:${proxyPort}/api/daemons/socket`,
      }),
    );
  });
  const webSockets = new WebSocketServer({ server: hub });
  const peers = new Set<WebSocket>();
  let connections = 0;
  let pongs = 0;
  webSockets.on("connection", (peer) => {
    connections += 1;
    peers.add(peer);
    peer.on("close", () => peers.delete(peer));
  });
  await listen(hub);
  const hubPort = (hub.address() as AddressInfo).port;
  const streams = new Set<Socket>();
  let dropped = false;
  const proxy = createTcpServer((client) => {
    const upstream = connect(hubPort, "127.0.0.1");
    streams.add(client);
    streams.add(upstream);
    client.on("data", (data) => {
      if (!dropped) upstream.write(data);
    });
    upstream.on("data", (data) => {
      if (!dropped) client.write(data);
    });
    client.on("end", () => {
      if (!dropped) upstream.end();
    });
    upstream.on("end", () => {
      if (!dropped) client.end();
    });
    for (const socket of [client, upstream]) {
      socket.on("error", () => socket.destroy());
      socket.on("close", () => streams.delete(socket));
    }
  });
  await listen(proxy);
  const proxyPort = (proxy.address() as AddressInfo).port;
  let retry: (() => void) | undefined;
  const controller = new HubRelationshipController({
    paseoHome: home,
    hostname: "test-daemon",
    serverId: "server-1",
    daemonPublicKey: "public-key",
    logger: pino({ level: "silent" }),
    remote: new DirectHubRelationshipRemote(),
    clock: {
      now: () => new Date(),
      schedule: (_delay, task) => {
        retry = task;
        return { cancel: () => (retry = undefined) };
      },
    },
    attachSocket: async (socket) => {
      if (!(socket instanceof WebSocket)) throw new Error("Expected a real WebSocket");
      socket.on("pong", () => (pongs += 1));
    },
    updateAttachedPermissions: () => undefined,
    createExecutionAgents: () => ({
      create: async () => {
        throw new Error("Unexpected agent creation");
      },
      subscribe: () => () => undefined,
      invalidateAuthority: async () => undefined,
    }),
  });

  try {
    // Keep TCP and WebSocket I/O real; accelerate only the keepalive interval and its clock.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    await controller.connect({
      hubUrl: `http://127.0.0.1:${proxyPort}`,
      token: "test-token",
      permissions: ["hub.execute"],
    });
    await expect.poll(() => controller.status().state).toBe("connected");
    const connectedAt = controller.status().connectedAt;

    expect(connections).toBe(1);

    // Model the reported proxy request ending without a close reaching the daemon.
    dropped = true;
    for (const peer of peers) peer.terminate();
    await expect.poll(() => peers.size).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect.poll(() => controller.status().state).toBe("reconnecting");
    expect(controller.status().lastError).toBe("Hub WebSocket heartbeat timed out");
    expect(retry).toBeTypeOf("function");

    dropped = false;
    retry?.();
    await expect.poll(() => controller.status().state).toBe("connected");
    expect(connections).toBe(2);
    expect(controller.status().connectedAt).not.toBe(connectedAt);
    expect(controller.status().lastError).toBeNull();

    // A healthy idle connection survives multiple liveness windows.
    for (let tick = 0; tick < 12; tick += 1) {
      const before = pongs;
      await vi.advanceTimersByTimeAsync(10_000);
      await expect.poll(() => pongs).toBeGreaterThan(before);
    }
    expect(controller.status().state).toBe("connected");
    expect(connections).toBe(2);

    await controller.stop();
    await expect.poll(() => peers.size).toBe(0);
    await expect.poll(() => vi.getTimerCount()).toBe(0);
  } finally {
    await controller.stop();
    vi.useRealTimers();
    for (const socket of streams) socket.destroy();
    for (const peer of peers) peer.terminate();
    webSockets.close();
    await Promise.all([close(proxy), close(hub)]);
    await rm(home, { recursive: true, force: true });
  }
});

async function listen(
  server: ReturnType<typeof createTcpServer> | ReturnType<typeof createHttpServer>,
) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function close(
  server: ReturnType<typeof createTcpServer> | ReturnType<typeof createHttpServer>,
) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
