import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import net from "node:net";
import express from "express";
import WebSocket, { WebSocketServer } from "ws";
import pino from "pino";
import {
  ScriptRouteStore,
  createScriptProxyMiddleware,
  createScriptProxyUpgradeHandler,
  findFreePort,
} from "./script-proxy.js";

const logger = pino({ level: "silent" });

// ---------------------------------------------------------------------------
// Helpers for cleanup
// ---------------------------------------------------------------------------

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

// ---------------------------------------------------------------------------
// ScriptRouteStore
// ---------------------------------------------------------------------------

describe("ScriptRouteStore", () => {
  it("registerRoute and findRoute with exact match", () => {
    const store = new ScriptRouteStore();
    store.registerRoute({
      hostname: "route-a.example.localhost",
      port: 3000,
      workspaceId: "/repo/.paseo/worktrees/feature-a",
      projectSlug: "repo",
      scriptName: "editor",
    });

    const route = store.findRoute("route-a.example.localhost");
    expect(route).toEqual({ hostname: "route-a.example.localhost", port: 3000 });
  });

  it("findRoute strips port from host header", () => {
    const store = new ScriptRouteStore();
    store.registerRoute({
      hostname: "route-a.example.localhost",
      port: 3000,
      workspaceId: "/repo/.paseo/worktrees/feature-a",
      projectSlug: "repo",
      scriptName: "editor",
    });

    const route = store.findRoute("route-a.example.localhost:6767");
    expect(route).toEqual({ hostname: "route-a.example.localhost", port: 3000 });
  });

  it("findRoute subdomain match", () => {
    const store = new ScriptRouteStore();
    store.registerRoute({
      hostname: "editor.example.localhost",
      port: 3000,
      workspaceId: "/repo/.paseo/worktrees/feature-a",
      projectSlug: "repo",
      scriptName: "editor",
    });

    const route = store.findRoute("tenant.editor.example.localhost");
    expect(route).toEqual({ hostname: "editor.example.localhost", port: 3000 });
  });

  it("listRoutes returns enriched entries", () => {
    const store = new ScriptRouteStore();
    store.registerRoute({
      hostname: "a.localhost",
      port: 3000,
      workspaceId: "/repo/.paseo/worktrees/feature-a",
      projectSlug: "repo",
      scriptName: "web",
    });
    store.registerRoute({
      hostname: "b.localhost",
      port: 4000,
      workspaceId: "/repo/.paseo/worktrees/feature-b",
      projectSlug: "repo",
      scriptName: "docs",
    });

    const routes = store.listRoutes();
    expect(routes).toHaveLength(2);
    expect(routes).toContainEqual({
      hostname: "a.localhost",
      port: 3000,
      workspaceId: "/repo/.paseo/worktrees/feature-a",
      projectSlug: "repo",
      scriptName: "web",
    });
    expect(routes).toContainEqual({
      hostname: "b.localhost",
      port: 4000,
      workspaceId: "/repo/.paseo/worktrees/feature-b",
      projectSlug: "repo",
      scriptName: "docs",
    });
  });

  it("listRoutesForWorkspace returns only routes for that workspace", () => {
    const store = new ScriptRouteStore();
    store.registerRoute({
      hostname: "a.localhost",
      port: 3000,
      workspaceId: "/repo/.paseo/worktrees/feature-a",
      projectSlug: "repo",
      scriptName: "web",
    });
    store.registerRoute({
      hostname: "b.localhost",
      port: 4000,
      workspaceId: "/repo/.paseo/worktrees/feature-b",
      projectSlug: "repo",
      scriptName: "docs",
    });
    store.registerRoute({
      hostname: "c.localhost",
      port: 5000,
      workspaceId: "/repo/.paseo/worktrees/feature-a",
      projectSlug: "repo",
      scriptName: "api",
    });

    expect(store.listRoutesForWorkspace("/repo/.paseo/worktrees/feature-a")).toEqual([
      {
        hostname: "a.localhost",
        port: 3000,
        workspaceId: "/repo/.paseo/worktrees/feature-a",
        projectSlug: "repo",
        scriptName: "web",
      },
      {
        hostname: "c.localhost",
        port: 5000,
        workspaceId: "/repo/.paseo/worktrees/feature-a",
        projectSlug: "repo",
        scriptName: "api",
      },
    ]);
  });

  it("removeRoute works", () => {
    const store = new ScriptRouteStore();
    store.registerRoute({
      hostname: "route-a.example.localhost",
      port: 3000,
      workspaceId: "/repo/.paseo/worktrees/feature-a",
      projectSlug: "repo",
      scriptName: "editor",
    });
    store.removeRoute("route-a.example.localhost");

    expect(store.findRoute("route-a.example.localhost")).toBeNull();
  });

  it("removeRoute cleans up workspace index", () => {
    const store = new ScriptRouteStore();
    store.registerRoute({
      hostname: "route-a.example.localhost",
      port: 3000,
      workspaceId: "/repo/.paseo/worktrees/feature-a",
      projectSlug: "repo",
      scriptName: "editor",
    });

    store.removeRoute("route-a.example.localhost");

    expect(store.listRoutesForWorkspace("/repo/.paseo/worktrees/feature-a")).toEqual([]);
  });

  it("removeRoutesForPort works", () => {
    const store = new ScriptRouteStore();
    store.registerRoute({
      hostname: "a.localhost",
      port: 3000,
      workspaceId: "/repo/.paseo/worktrees/feature-a",
      projectSlug: "repo",
      scriptName: "web",
    });
    store.registerRoute({
      hostname: "b.localhost",
      port: 3000,
      workspaceId: "/repo/.paseo/worktrees/feature-a",
      projectSlug: "repo",
      scriptName: "api",
    });
    store.registerRoute({
      hostname: "c.localhost",
      port: 4000,
      workspaceId: "/repo/.paseo/worktrees/feature-b",
      projectSlug: "repo",
      scriptName: "docs",
    });

    store.removeRoutesForPort(3000);

    expect(store.findRoute("a.localhost")).toBeNull();
    expect(store.findRoute("b.localhost")).toBeNull();
    expect(store.findRoute("c.localhost")).toEqual({
      hostname: "c.localhost",
      port: 4000,
    });
  });

  it("removeRoutesForPort cleans up workspace index", () => {
    const store = new ScriptRouteStore();
    store.registerRoute({
      hostname: "a.localhost",
      port: 3000,
      workspaceId: "/repo/.paseo/worktrees/feature-a",
      projectSlug: "repo",
      scriptName: "web",
    });
    store.registerRoute({
      hostname: "b.localhost",
      port: 3000,
      workspaceId: "/repo/.paseo/worktrees/feature-a",
      projectSlug: "repo",
      scriptName: "api",
    });

    store.removeRoutesForPort(3000);

    expect(store.listRoutesForWorkspace("/repo/.paseo/worktrees/feature-a")).toEqual([]);
  });

  it("findRoute returns null for unknown hosts", () => {
    const store = new ScriptRouteStore();
    store.registerRoute({
      hostname: "route-a.example.localhost",
      port: 3000,
      workspaceId: "/repo/.paseo/worktrees/feature-a",
      projectSlug: "repo",
      scriptName: "editor",
    });

    expect(store.findRoute("unknown.example.com")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// HTTP proxy
// ---------------------------------------------------------------------------

describe("HTTP proxy", () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.map(closeServer));
    servers.length = 0;
  });

  /** Start a real HTTP server that echoes back a known body and records received headers. */
  async function startUpstream(): Promise<{
    port: number;
    server: http.Server;
    receivedHeaders: () => http.IncomingHttpHeaders;
  }> {
    const port = await findFreePort();
    let lastHeaders: http.IncomingHttpHeaders = {};

    const server = http.createServer((req, res) => {
      lastHeaders = req.headers;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("upstream-ok");
    });

    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    servers.push(server);

    return {
      port,
      server,
      receivedHeaders: () => lastHeaders,
    };
  }

  /** Start an Express app with the service proxy middleware and an optional fallback. */
  async function startProxy(
    routeStore: ScriptRouteStore,
    opts?: { fallback?: boolean },
  ): Promise<{ port: number; server: http.Server }> {
    const port = await findFreePort();
    const app = express();
    app.use(createScriptProxyMiddleware({ routeStore, logger }));

    if (opts?.fallback) {
      app.use((_req, res) => {
        res.status(404).send("no route");
      });
    }

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    servers.push(server);

    return { port, server };
  }

  /** Simple HTTP GET helper that returns status code and body. */
  function httpGet(
    port: number,
    host: string,
    path = "/",
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.get({ hostname: "127.0.0.1", port, path, headers: { host } }, (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject);
    });
  }

  it("proxies requests to the correct upstream based on Host header", async () => {
    const upstream = await startUpstream();
    const routeStore = new ScriptRouteStore();
    routeStore.registerRoute({
      hostname: "test-service.localhost",
      port: upstream.port,
      workspaceId: "workspace-test",
      projectSlug: "test",
      scriptName: "service",
    });

    const proxy = await startProxy(routeStore);
    const res = await httpGet(proxy.port, `test-service.localhost:${proxy.port}`);

    expect(res.status).toBe(200);
    expect(res.body).toBe("upstream-ok");

    const headers = upstream.receivedHeaders();
    expect(headers["x-forwarded-for"]).toBeDefined();
    expect(headers["x-forwarded-host"]).toBe("test-service.localhost");
  });

  it("falls through when no route matches", async () => {
    const routeStore = new ScriptRouteStore();
    const proxy = await startProxy(routeStore, { fallback: true });

    const res = await httpGet(proxy.port, `unknown.localhost:${proxy.port}`);

    expect(res.status).toBe(404);
    expect(res.body).toBe("no route");
  });

  it("returns 502 when upstream is down", async () => {
    // Get a port that nothing is listening on
    const deadPort = await findFreePort();

    const routeStore = new ScriptRouteStore();
    routeStore.registerRoute({
      hostname: "dead-service.localhost",
      port: deadPort,
      workspaceId: "workspace-dead",
      projectSlug: "dead",
      scriptName: "service",
    });

    const proxy = await startProxy(routeStore);
    const res = await httpGet(proxy.port, `dead-service.localhost:${proxy.port}`);

    expect(res.status).toBe(502);
    expect(res.body).toBe("502 Bad Gateway");
  });
});

// ---------------------------------------------------------------------------
// WebSocket proxy
// ---------------------------------------------------------------------------

describe("WebSocket proxy", () => {
  const httpServers: http.Server[] = [];
  const wsServers: WebSocketServer[] = [];
  const wsClients: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of wsClients) {
      if (ws.readyState === WebSocket.OPEN) ws.close();
    }
    wsClients.length = 0;

    for (const wss of wsServers) {
      wss.close();
    }
    wsServers.length = 0;

    await Promise.all(httpServers.map(closeServer));
    httpServers.length = 0;
  });

  it("proxies WebSocket connections to the correct upstream", async () => {
    // 1. Start a real WebSocket echo server
    const upstreamPort = await findFreePort();
    const upstreamServer = http.createServer();
    const wss = new WebSocketServer({ server: upstreamServer });
    wsServers.push(wss);

    wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        ws.send(`echo: ${data.toString()}`);
      });
    });

    await new Promise<void>((resolve) => upstreamServer.listen(upstreamPort, "127.0.0.1", resolve));
    httpServers.push(upstreamServer);

    // 2. Create the proxy server with the upgrade handler
    const routeStore = new ScriptRouteStore();
    routeStore.registerRoute({
      hostname: "ws-service.localhost",
      port: upstreamPort,
      workspaceId: "workspace-ws",
      projectSlug: "ws",
      scriptName: "service",
    });

    const proxyPort = await findFreePort();
    const proxyServer = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });

    const upgradeHandler = createScriptProxyUpgradeHandler({
      routeStore,
      logger,
    });
    proxyServer.on("upgrade", upgradeHandler);

    await new Promise<void>((resolve) => proxyServer.listen(proxyPort, "127.0.0.1", resolve));
    httpServers.push(proxyServer);

    // 3. Connect a WebSocket client through the proxy
    const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}`, {
      headers: { host: `ws-service.localhost:${proxyPort}` },
    });
    wsClients.push(ws);

    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });

    // 4. Send a message and verify echo
    const reply = await new Promise<string>((resolve, reject) => {
      ws.on("message", (data) => resolve(data.toString()));
      ws.on("error", reject);
      ws.send("hello proxy");
    });

    expect(reply).toBe("echo: hello proxy");
  });
});

// ---------------------------------------------------------------------------
// findFreePort
// ---------------------------------------------------------------------------

describe("findFreePort", () => {
  it("returns a number", async () => {
    const port = await findFreePort();
    expect(typeof port).toBe("number");
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
  });

  it("returns a port that is actually available", async () => {
    const port = await findFreePort();

    // Verify we can bind a server to it
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.listen(port, "127.0.0.1", () => resolve());
      server.on("error", reject);
    });

    const addr = server.address();
    expect(addr).not.toBeNull();
    expect(typeof addr === "object" && addr !== null ? addr.port : -1).toBe(port);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
