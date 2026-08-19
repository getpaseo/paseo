import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import { WebSocketServer } from "ws";
import express from "express";
import { describe, expect, it } from "vitest";
import pino from "pino";
import { createServiceProxySubsystem, findFreePort } from "./service-proxy.js";

const logger = pino({ level: "silent" });

interface DispatcherFixture {
  daemonPort: number;
  scriptHostname: string;
  daemonConnections(): number;
  close(): Promise<void>;
}

/**
 * Reproduces how bootstrap.ts wires its single upgrade dispatcher: script
 * hosts are forwarded through the service proxy, everything else is handed to
 * the daemon WebSocket server via handleUpgrade. No other "upgrade" listener is
 * attached to the shared HTTP server, because the daemon WebSocket server runs
 * in noServer mode.
 *
 * The upstream is a bare WS endpoint that accepts any connection and echoes a
 * marker. The daemon WebSocket server counts every connection it completes, so
 * a script-bound upgrade that is ALSO completed by the daemon WebSocket server
 * (the double-handling this test guards against) would bump that count.
 */
async function startDispatcherFixture(): Promise<DispatcherFixture> {
  const upstreamPort = await findFreePort();
  const upstreamHttp = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("upstream");
  });
  const upstreamWss = new WebSocketServer({ noServer: true });
  upstreamWss.on("connection", (ws) => {
    ws.send("upstream-connected");
    ws.on("message", (data) => ws.send(data));
  });
  upstreamHttp.on("upgrade", (req, socket, head) => {
    upstreamWss.handleUpgrade(req, socket, head, (ws, request) => {
      upstreamWss.emit("connection", ws, request);
    });
  });
  await new Promise<void>((resolve) => upstreamHttp.listen(upstreamPort, "127.0.0.1", resolve));

  const serviceProxy = createServiceProxySubsystem({ logger });
  const route = serviceProxy.registerWorkspaceService({
    workspaceId: "workspace-a",
    projectSlug: "repo",
    branchName: "feature",
    scriptName: "api",
    port: upstreamPort,
  });

  const daemonPort = await findFreePort();
  const app = express();
  app.set("trust proxy", true);
  app.use(serviceProxy.middleware());
  app.use((_req, res) => {
    res.status(404).send("404 Not Found");
  });
  const daemon = http.createServer(app);

  // The daemon WebSocket server runs detached and exposes handleUpgrade.
  const wss = new WebSocketServer({ noServer: true, path: "/ws" });
  let daemonConnections = 0;
  wss.on("connection", () => {
    daemonConnections += 1;
  });

  daemon.on("upgrade", (req, socket, head) => {
    const routeMatch = serviceProxy.routeForHost(req.headers.host);
    if (routeMatch) {
      serviceProxy.upgradeHandler({ passthroughUnknown: false })(req, socket, head);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws, request) => {
      wss.emit("connection", ws, request);
    });
  });

  await new Promise<void>((resolve) => daemon.listen(daemonPort, "127.0.0.1", resolve));

  return {
    daemonPort,
    scriptHostname: route.hostname,
    daemonConnections: () => daemonConnections,
    async close() {
      wss.close();
      upstreamWss.close();
      daemon.closeAllConnections();
      await new Promise<void>((resolve) => daemon.close(() => resolve()));
      upstreamHttp.closeAllConnections();
      await new Promise<void>((resolve) => upstreamHttp.close(() => resolve()));
    },
  };
}

/**
 * Sends a raw WebSocket upgrade to the daemon listener and resolves once the
 * server has replied 101 (or rejects on a non-upgrade response / connection
 * close before the handshake completes).
 */
function openRawUpgrade(
  port: number,
  host: string,
): Promise<{ statusLine: string; responseBody: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      const lines = [
        "GET /ws HTTP/1.1",
        `Host: ${host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ];
      socket.write(lines.join("\r\n"));
    });
    let raw = "";
    let settled = false;
    function fail(reason: string) {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`${reason} (received ${raw.length} bytes)`));
    }
    socket.on("data", (chunk: Buffer) => {
      raw += chunk.toString();
      const separator = raw.indexOf("\r\n\r\n");
      if (separator === -1) return;
      settled = true;
      socket.destroy();
      const statusLine = raw.slice(0, raw.indexOf("\r\n"));
      resolve({ statusLine, responseBody: raw.slice(separator + 4) });
    });
    socket.on("close", () => fail("socket closed before the handshake completed"));
    socket.on("error", (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    });
  });
}

describe("single upgrade dispatcher", () => {
  it("forwards script-bound upgrades to the proxy and never to the daemon WebSocket server", async () => {
    const fixture = await startDispatcherFixture();
    try {
      // Script host: a clean 101 from the upstream (rather than a 400/405 or
      // corrupted frame from a competing WebSocket upgrade on the same socket)
      // proves the dispatcher handed the upgrade to the proxy alone.
      const response = await openRawUpgrade(fixture.daemonPort, fixture.scriptHostname);
      expect(response.statusLine).toContain("101 Switching Protocols");

      // The daemon WebSocket server must not have claimed the script-bound
      // socket. If it had double-handled the upgrade, it would have completed
      // a connection (or errored) alongside the proxy.
      expect(fixture.daemonConnections()).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  it("routes daemon-bound upgrades to the daemon WebSocket server", async () => {
    const fixture = await startDispatcherFixture();
    try {
      // A host that is not a script route (and does not resolve to one) must
      // reach the daemon WebSocket server. A 101 here proves handleUpgrade ran.
      const response = await openRawUpgrade(
        fixture.daemonPort,
        `daemon.localhost:${fixture.daemonPort}`,
      );

      expect(response.statusLine).toContain("101 Switching Protocols");
      expect(fixture.daemonConnections()).toBe(1);
    } finally {
      await fixture.close();
    }
  });
});
