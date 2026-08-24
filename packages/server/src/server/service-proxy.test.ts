import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import express from "express";
import { describe, expect, it } from "vitest";
import pino from "pino";
import {
  buildLocalServiceHostname,
  buildPublicServiceHostname,
  buildServiceProxyLabel,
  createServiceProxySubsystem,
  findFreePort,
  ServiceProxyRouteCollisionError,
  ServiceProxyRouteRegistry,
} from "./service-proxy.js";

const logger = pino({ level: "silent" });

function readServerSourceFiles(dir = path.resolve(import.meta.dirname)): string[] {
  const entries: string[] = [];
  for (const name of readdirSync(dir)) {
    const fullPath = path.join(dir, name);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      entries.push(...readServerSourceFiles(fullPath));
    } else if (fullPath.endsWith(".ts") && !fullPath.endsWith(".test.ts")) {
      entries.push(fullPath);
    }
  }
  return entries;
}

interface HttpGetOptions {
  path?: string;
  headers?: Record<string, string>;
}

function httpGet(port: number, host: string, options: HttpGetOptions = {}) {
  const { path: requestPath = "/api/health", headers: extraHeaders = {} } = options;
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.get(
      { hostname: "127.0.0.1", port, path: requestPath, headers: { host, ...extraHeaders } },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
  });
}

describe("service proxy subsystem shape", () => {
  it("keeps production imports behind the service-proxy entrypoint", () => {
    const offenders: string[] = [];
    for (const filePath of readServerSourceFiles()) {
      if (filePath.endsWith("service-proxy.ts") || filePath.endsWith("script-proxy.ts")) {
        continue;
      }
      const source = readFileSync(filePath, "utf8");
      for (const needle of ["./script-proxy.js", "../utils/script-hostname.js"]) {
        if (source.includes(needle)) {
          offenders.push(`${path.relative(import.meta.dirname, filePath)} imports ${needle}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("classifies the configured public namespace before any route exists", async () => {
    const serviceProxy = createServiceProxySubsystem({
      logger,
      publicBaseUrl: "https://services.example.com",
    });
    const port = await findFreePort();
    const app = express();
    app.use(serviceProxy.middleware());
    app.use((_req, res) => {
      res.status(200).send("daemon-api");
    });
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    try {
      await expect(httpGet(port, `missing.services.example.com:${port}`)).resolves.toEqual({
        status: 404,
        body: "404 Not Found",
      });
      await expect(httpGet(port, `daemon.localhost:${port}`)).resolves.toEqual({
        status: 200,
        body: "daemon-api",
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("keeps configured public namespace classified after the last public route is removed", async () => {
    const serviceProxy = createServiceProxySubsystem({
      logger,
      publicBaseUrl: "https://services.example.com",
    });
    serviceProxy.registerWorkspaceService({
      workspaceId: "workspace-a",
      projectSlug: "repo",
      branchName: "main",
      scriptName: "api",
      port: 3000,
      publicBaseUrl: "https://services.example.com",
    });
    serviceProxy.removeWorkspaceService({ workspaceId: "workspace-a", scriptName: "api" });

    const port = await findFreePort();
    const app = express();
    app.use(serviceProxy.middleware());
    app.use((_req, res) => {
      res.status(200).send("daemon-api");
    });
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    try {
      await expect(httpGet(port, `missing.services.example.com:${port}`)).resolves.toEqual({
        status: 404,
        body: "404 Not Found",
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("uses the same hash-truncated service label for local and public hostnames", () => {
    const input = {
      projectSlug: "project-".repeat(10),
      branchName: "branch-".repeat(10),
      scriptName: "script-".repeat(10),
    };
    const label = buildServiceProxyLabel(input);

    expect(label.length).toBeLessThanOrEqual(63);
    expect(label.endsWith("-")).toBe(false);
    expect(buildLocalServiceHostname(input)).toBe(`${label}.localhost`);
    expect(
      buildPublicServiceHostname({ ...input, publicBaseUrl: "https://services.example.com" }),
    ).toBe(`${label}.services.example.com`);
    expect(buildServiceProxyLabel(input)).toBe(label);
    expect(
      buildServiceProxyLabel({ ...input, scriptName: `different-${input.scriptName}` }),
    ).not.toBe(label);
  });

  it("gives long labels with the same prefix different hash suffixes", () => {
    const sharedPrefix = "service-".repeat(12);
    const first = buildServiceProxyLabel({
      projectSlug: "repo",
      branchName: "feature/shared-prefix",
      scriptName: `${sharedPrefix}alpha`,
    });
    const second = buildServiceProxyLabel({
      projectSlug: "repo",
      branchName: "feature/shared-prefix",
      scriptName: `${sharedPrefix}beta`,
    });

    expect(first).not.toBe(second);
    expect(first.slice(0, -10)).toBe(second.slice(0, -10));
    expect(first.split("--").at(-1)).not.toBe(second.split("--").at(-1));
  });

  it("rejects cross-service collisions without deleting the existing route", () => {
    const serviceProxy = createServiceProxySubsystem({ logger });
    serviceProxy.registerWorkspaceService({
      workspaceId: "workspace-a",
      projectSlug: "repo",
      branchName: "main",
      scriptName: "api",
      port: 3000,
    });

    expect(() =>
      serviceProxy.registerWorkspaceService({
        workspaceId: "workspace-b",
        projectSlug: "repo",
        branchName: "main",
        scriptName: "api",
        port: 4000,
      }),
    ).toThrow(ServiceProxyRouteCollisionError);

    expect(serviceProxy.getHealthTargetForHostname("api--repo.localhost")).toMatchObject({
      workspaceId: "workspace-a",
      port: 3000,
    });
  });

  it("rejects public alias collisions without deleting the existing route", () => {
    const serviceProxy = createServiceProxySubsystem({ logger });
    serviceProxy.registerWorkspaceService({
      workspaceId: "workspace-a",
      projectSlug: "repo",
      branchName: "main",
      scriptName: "api",
      port: 3000,
      publicBaseUrl: "https://services.example.com",
    });

    expect(() =>
      serviceProxy.registerWorkspaceService({
        workspaceId: "workspace-b",
        projectSlug: "repo",
        branchName: "main",
        scriptName: "api",
        port: 4000,
        publicBaseUrl: "https://services.example.com",
      }),
    ).toThrow(ServiceProxyRouteCollisionError);

    expect(serviceProxy.getHealthTargetForHostname("api--repo.services.example.com")).toMatchObject(
      {
        workspaceId: "workspace-a",
        port: 3000,
      },
    );
  });

  it("rejects public alias collisions even when canonical hostnames differ", () => {
    const serviceProxy = new ServiceProxyRouteRegistry();
    serviceProxy.registerRoute({
      hostname: "api--repo-a.localhost",
      publicHostname: "api.services.example.com",
      publicBaseUrl: "https://services.example.com",
      port: 3000,
      workspaceId: "workspace-a",
      projectSlug: "repo-a",
      scriptName: "api",
    });

    expect(() =>
      serviceProxy.registerRoute({
        hostname: "api--repo-b.localhost",
        publicHostname: "api.services.example.com",
        publicBaseUrl: "https://services.example.com",
        port: 4000,
        workspaceId: "workspace-b",
        projectSlug: "repo-b",
        scriptName: "api",
      }),
    ).toThrow(ServiceProxyRouteCollisionError);

    expect(serviceProxy.getRouteEntry("api--repo-a.localhost")).toMatchObject({ port: 3000 });
    expect(serviceProxy.getRouteEntry("api--repo-b.localhost")).toBeNull();
  });

  it("rejects canonical-to-public-alias collisions", () => {
    const serviceProxy = new ServiceProxyRouteRegistry();
    serviceProxy.registerRoute({
      hostname: "api--repo.localhost",
      publicHostname: "api.services.example.com",
      publicBaseUrl: "https://services.example.com",
      port: 3000,
      workspaceId: "workspace-a",
      projectSlug: "repo",
      scriptName: "api",
    });

    expect(() =>
      serviceProxy.registerRoute({
        hostname: "api.services.example.com",
        port: 4000,
        workspaceId: "workspace-b",
        projectSlug: "other",
        scriptName: "api",
      }),
    ).toThrow(ServiceProxyRouteCollisionError);

    expect(serviceProxy.getRouteEntry("api--repo.localhost")).toMatchObject({ port: 3000 });
    expect(serviceProxy.getRouteEntry("api.services.example.com")).toMatchObject({ port: 3000 });
  });

  it("allows same workspace/script replacement", () => {
    const serviceProxy = createServiceProxySubsystem({ logger });
    serviceProxy.registerWorkspaceService({
      workspaceId: "workspace-a",
      projectSlug: "repo",
      branchName: "main",
      scriptName: "api",
      port: 3000,
    });
    serviceProxy.registerWorkspaceService({
      workspaceId: "workspace-a",
      projectSlug: "repo",
      branchName: "main",
      scriptName: "api",
      port: 4000,
    });

    expect(serviceProxy.getHealthTargetForHostname("api--repo.localhost")).toMatchObject({
      port: 4000,
    });
  });
});

interface ForwardedFixture {
  daemonPort: number;
  hostname: string;
  close(): Promise<void>;
}

/**
 * Runs a real workspace service behind a real daemon listener. The upstream
 * echoes the headers it received so tests can assert what actually crossed the
 * proxy, not what a helper returned.
 */
async function startForwardedHeadersFixture(): Promise<ForwardedFixture> {
  const upstreamPort = await findFreePort();
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.headers));
  });
  const upgradeSockets: net.Socket[] = [];
  upstream.on("upgrade", (req, socket) => {
    upgradeSockets.push(socket);
    // The client resets this connection once it has the echo, so the reset
    // reaches us as an 'error'. A raw upgrade socket has no default handler —
    // without this the event goes unhandled and takes down the test process.
    socket.on("error", () => socket.destroy());
    const payload = JSON.stringify(req.headers);
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Echo-Length: ${payload.length}\r\n\r\n${payload}`,
    );
  });
  await new Promise<void>((resolve) => upstream.listen(upstreamPort, "127.0.0.1", resolve));

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
  daemon.on("upgrade", serviceProxy.upgradeHandler({ passthroughUnknown: false }));
  await new Promise<void>((resolve) => daemon.listen(daemonPort, "127.0.0.1", resolve));

  return {
    daemonPort,
    hostname: route.hostname,
    async close() {
      // Upgraded sockets keep the server alive; close() alone would hang.
      for (const socket of upgradeSockets) socket.destroy();
      daemon.closeAllConnections();
      await new Promise<void>((resolve) => daemon.close(() => resolve()));
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    },
  };
}

function upgradeThroughProxy(
  port: number,
  host: string,
  extraHeaders: Record<string, string> = {},
): Promise<Record<string, string | undefined>> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      const lines = [
        "GET /ws HTTP/1.1",
        `Host: ${host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        ...Object.entries(extraHeaders).map(([key, value]) => `${key}: ${value}`),
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
      const body = raw.slice(separator + 4);
      const lengthMatch = /x-echo-length: (\d+)/i.exec(raw.slice(0, separator));
      if (!lengthMatch || body.length < Number(lengthMatch[1])) return;
      settled = true;
      socket.destroy();
      resolve(JSON.parse(body) as Record<string, string | undefined>);
    });
    // Without these the promise stays pending forever when the proxy drops the
    // upgrade, and the test reports a timeout instead of the real failure.
    socket.on("close", () => fail("upgrade closed before the echo arrived"));
    socket.on("error", (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    });
  });
}

describe("service proxy forwarded headers", () => {
  it("forwards the client authority with its port so services build reachable URLs", async () => {
    const fixture = await startForwardedHeadersFixture();
    try {
      const response = await httpGet(
        fixture.daemonPort,
        `${fixture.hostname}:${fixture.daemonPort}`,
        { path: "/" },
      );
      const headers = JSON.parse(response.body) as Record<string, string | undefined>;

      expect(headers.host).toBe(`${fixture.hostname}:${fixture.daemonPort}`);
      expect(headers["x-forwarded-host"]).toBe(`${fixture.hostname}:${fixture.daemonPort}`);
      expect(headers["x-forwarded-port"]).toBe(String(fixture.daemonPort));
      expect(headers["x-forwarded-proto"]).toBe("http");
    } finally {
      await fixture.close();
    }
  });

  it("does not invent a port when the client authority has none", async () => {
    const fixture = await startForwardedHeadersFixture();
    try {
      const response = await httpGet(fixture.daemonPort, fixture.hostname, {
        path: "/",
        headers: { "x-forwarded-proto": "https" },
      });
      const headers = JSON.parse(response.body) as Record<string, string | undefined>;

      expect(headers["x-forwarded-host"]).toBe(fixture.hostname);
      expect(headers["x-forwarded-port"]).toBeUndefined();
      expect(headers["x-forwarded-proto"]).toBe("https");
    } finally {
      await fixture.close();
    }
  });

  it("keeps a port an upstream proxy already reported", async () => {
    const fixture = await startForwardedHeadersFixture();
    try {
      const response = await httpGet(fixture.daemonPort, fixture.hostname, {
        path: "/",
        headers: { "x-forwarded-proto": "https", "x-forwarded-port": "8443" },
      });
      const headers = JSON.parse(response.body) as Record<string, string | undefined>;

      expect(headers["x-forwarded-port"]).toBe("8443");
    } finally {
      await fixture.close();
    }
  });

  it("overrides a client-supplied forwarded port with the observed authority port", async () => {
    const fixture = await startForwardedHeadersFixture();
    try {
      const response = await httpGet(
        fixture.daemonPort,
        `${fixture.hostname}:${fixture.daemonPort}`,
        { path: "/", headers: { "x-forwarded-port": "443" } },
      );
      const headers = JSON.parse(response.body) as Record<string, string | undefined>;

      expect(headers["x-forwarded-port"]).toBe(String(fixture.daemonPort));
    } finally {
      await fixture.close();
    }
  });

  it("reports the real port when a client sends an empty forwarded port", async () => {
    const fixture = await startForwardedHeadersFixture();
    try {
      const response = await httpGet(
        fixture.daemonPort,
        `${fixture.hostname}:${fixture.daemonPort}`,
        { path: "/", headers: { "x-forwarded-port": "" } },
      );
      const headers = JSON.parse(response.body) as Record<string, string | undefined>;

      expect(headers["x-forwarded-port"]).toBe(String(fixture.daemonPort));
    } finally {
      await fixture.close();
    }
  });

  it("ignores an out-of-range port in the client authority", async () => {
    const fixture = await startForwardedHeadersFixture();
    try {
      const response = await httpGet(fixture.daemonPort, `${fixture.hostname}:99999999`, {
        path: "/",
      });
      const headers = JSON.parse(response.body) as Record<string, string | undefined>;

      expect(headers["x-forwarded-host"]).toBe(`${fixture.hostname}:99999999`);
      expect(headers["x-forwarded-port"]).toBeUndefined();
    } finally {
      await fixture.close();
    }
  });

  it("overwrites a client-supplied forwarded host with the real authority", async () => {
    const fixture = await startForwardedHeadersFixture();
    try {
      const response = await httpGet(
        fixture.daemonPort,
        `${fixture.hostname}:${fixture.daemonPort}`,
        { path: "/", headers: { "x-forwarded-host": "attacker.example.com" } },
      );
      const headers = JSON.parse(response.body) as Record<string, string | undefined>;

      expect(headers["x-forwarded-host"]).toBe(`${fixture.hostname}:${fixture.daemonPort}`);
    } finally {
      await fixture.close();
    }
  });

  it("applies the same forwarded-header rules to WebSocket upgrades", async () => {
    const fixture = await startForwardedHeadersFixture();
    try {
      const withPort = await upgradeThroughProxy(
        fixture.daemonPort,
        `${fixture.hostname}:${fixture.daemonPort}`,
      );
      expect(withPort["x-forwarded-host"]).toBe(`${fixture.hostname}:${fixture.daemonPort}`);
      expect(withPort["x-forwarded-port"]).toBe(String(fixture.daemonPort));

      const behindTls = await upgradeThroughProxy(fixture.daemonPort, fixture.hostname, {
        "X-Forwarded-Proto": "https",
        "X-Forwarded-Port": "443",
      });
      expect(behindTls["x-forwarded-host"]).toBe(fixture.hostname);
      expect(behindTls["x-forwarded-port"]).toBe("443");
      // Known limitation, tracked separately: the upgrade path hardcodes the
      // scheme, so an HTTPS proxy's "https" is replaced with "http" even though
      // its port survives. Asserted rather than hidden so the day it is fixed
      // this test fails loudly instead of silently passing.
      expect(behindTls["x-forwarded-proto"]).toBe("http");
    } finally {
      await fixture.close();
    }
  });
});
