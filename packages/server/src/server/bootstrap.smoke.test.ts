import os from "node:os";
import http from "node:http";
import path from "node:path";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";

import { createPaseoDaemon, parseListenString, type PaseoDaemonConfig } from "./bootstrap.js";
import { loadConfig } from "./config.js";
import { AgentManagerShuttingDownError } from "./agent/agent-manager.js";
import { hashDaemonPassword } from "./auth.js";
import { generateLocalPairingOffer } from "./pairing-offer.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";
import { DaemonClient } from "./test-utils/daemon-client.js";
import { isPlatform } from "../test-utils/platform.js";
import { findFreePort } from "./service-proxy.js";
import {
  configureGitProcessPolicy,
  snapshotGitCommandRuntimeMetrics,
} from "../utils/run-git-command.js";
import { DEFAULT_GIT_PROCESS_POLICY } from "../utils/git-process-scheduler.js";
import type {
  HubEnrollment,
  HubEnrollmentResult,
  HubRelationshipRemote,
  HubRevocation,
  HubSocketConnection,
  HubSocketCredentials,
  HubSocketEvents,
} from "./hub/relationship-remote.js";

interface HeldAgentClose {
  started: Promise<void>;
  arm(): void;
  closeSession(): Promise<void>;
  finish(): void;
}

interface BlockedDaemonShutdown {
  probeReconnect(): Promise<WebSocketProbeResult>;
  tryCreateAgent(): Promise<"created" | "rejected">;
  finish(): Promise<void>;
}

type WebSocketProbeResult =
  | { status: "connected" }
  | { status: "rejected"; statusCode: number | null };

describe("paseo daemon bootstrap", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("starts and serves health endpoint", async () => {
    const daemonHandle = await createTestPaseoDaemon({
      openai: { stt: { apiKey: "test-openai-api-key" }, tts: { apiKey: "test-openai-api-key" } },
      speech: {
        providers: {
          dictationStt: { provider: "openai", explicit: true },
          voiceStt: { provider: "openai", explicit: true },
          voiceTts: { provider: "openai", explicit: true },
        },
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${daemonHandle.port}/api/health`, {
        headers: daemonHandle.agentMcpAuthHeader
          ? { Authorization: daemonHandle.agentMcpAuthHeader }
          : undefined,
      });
      expect(response.ok).toBe(true);
      const payload = await response.json();
      expect(payload.status).toBe("ok");
      expect(typeof payload.timestamp).toBe("string");
    } finally {
      await daemonHandle.close();
    }
  });

  test("keeps timeline activity in memory and removes obsolete timeline files at startup", async () => {
    const paseoHomeRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-timeline-cleanup-"));
    const paseoHome = path.join(paseoHomeRoot, ".paseo");
    const obsoleteTimelineDirectory = path.join(paseoHome, "agent-timelines");
    const agentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-timeline-agent-"));
    await mkdir(obsoleteTimelineDirectory, { recursive: true });
    await writeFile(path.join(obsoleteTimelineDirectory, "obsolete.json"), "{}\n", "utf-8");

    const daemonHandle = await createTestPaseoDaemon({ paseoHomeRoot, cleanup: false });
    try {
      await expect(access(obsoleteTimelineDirectory)).rejects.toMatchObject({ code: "ENOENT" });

      const agent = await daemonHandle.daemon.agentManager.createAgent(
        { provider: "codex", cwd: agentCwd },
        undefined,
        { workspaceId: undefined },
      );
      await daemonHandle.daemon.agentManager.appendTimelineItem(agent.id, {
        type: "assistant_message",
        text: "timeline stays in memory",
      });
      await daemonHandle.daemon.agentManager.flush();

      await expect(access(obsoleteTimelineDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await daemonHandle.close();
      await Promise.all([
        rm(paseoHomeRoot, { recursive: true, force: true }),
        rm(agentCwd, { recursive: true, force: true }),
      ]);
    }
  });

  test("does not create a timeline directory for live timeline activity", async () => {
    const paseoHomeRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-timeline-memory-"));
    const agentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-timeline-agent-"));
    const daemonHandle = await createTestPaseoDaemon({ paseoHomeRoot, cleanup: false });
    const timelineDirectory = path.join(daemonHandle.paseoHome, "agent-timelines");
    try {
      const agent = await daemonHandle.daemon.agentManager.createAgent(
        { provider: "codex", cwd: agentCwd },
        undefined,
        { workspaceId: undefined },
      );
      await daemonHandle.daemon.agentManager.appendTimelineItem(agent.id, {
        type: "assistant_message",
        text: "timeline stays in memory",
      });
      await daemonHandle.daemon.agentManager.flush();

      await expect(access(timelineDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await daemonHandle.close();
      await Promise.all([
        rm(paseoHomeRoot, { recursive: true, force: true }),
        rm(agentCwd, { recursive: true, force: true }),
      ]);
    }
  });

  test("reload applies live HTTP, MCP, Git, provider, relay, and app policies", async () => {
    const paseoHomeRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-config-reload-runtime-"));
    const paseoHome = path.join(paseoHomeRoot, ".paseo");
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const agentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-config-reload-agent-"));
    await mkdir(paseoHome, { recursive: true });
    const configPath = path.join(paseoHome, "config.json");
    const initialPersisted = {
      version: 1 as const,
      daemon: {
        listen: "127.0.0.1:0",
        hostnames: ["127.0.0.1", "before.example.test"],
        cors: { allowedOrigins: ["https://before.example.test"] },
        trustedProxies: [],
        mcp: { enabled: true, injectIntoAgents: false },
        git: { maxProcessesPerSecond: 64, maxProcessConcurrency: 8 },
        relay: {
          enabled: false,
          endpoint: "127.0.0.1:9",
          publicEndpoint: "127.0.0.1:9",
          useTls: false,
          publicUseTls: false,
        },
      },
      app: { baseUrl: "https://before.example.test" },
    };
    await writeFile(configPath, `${JSON.stringify(initialPersisted, null, 2)}\n`, "utf-8");
    const config = loadConfig(paseoHome, { env: {} });
    config.staticDir = staticDir;
    config.agentClients = createTestAgentClients();
    config.agentStoragePath = path.join(paseoHome, "agents");
    config.isDev = true;
    config.speech = {
      providers: {
        dictationStt: { provider: "local", explicit: true, enabled: false },
        voiceTurnDetection: { provider: "local", explicit: true, enabled: false },
        voiceStt: { provider: "local", explicit: true, enabled: false },
        voiceTts: { provider: "local", explicit: true, enabled: false },
      },
    };
    const daemon = await createPaseoDaemon(config, pino({ level: "silent" }));
    let client: DaemonClient | null = null;
    let proxyUpstream: http.Server | null = null;

    try {
      await daemon.start();
      const target = daemon.getListenTarget();
      if (!target || target.type !== "tcp") throw new Error("Expected a TCP listener");
      client = new DaemonClient({
        url: `ws://127.0.0.1:${target.port}/ws`,
        appVersion: "0.4.0",
      });
      await client.connect();

      proxyUpstream = http.createServer((req, res) => {
        res.end(String(req.headers["x-forwarded-proto"] ?? "missing"));
      });
      await new Promise<void>((resolve) => proxyUpstream?.listen(0, "127.0.0.1", resolve));
      const proxyAddress = proxyUpstream.address();
      if (!proxyAddress || typeof proxyAddress === "string") {
        throw new Error("Expected proxy upstream TCP address");
      }
      const proxyRoute = daemon.serviceProxy.registerWorkspaceService({
        workspaceId: "workspace-config-reload",
        projectSlug: "reload",
        branchName: "main",
        scriptName: "proxy",
        port: proxyAddress.port,
      });
      const proxyHost = `${proxyRoute.hostname}:${target.port}`;

      expect(
        (await httpGetWithHost(target.port, "before.example.test", "/api/health")).status,
      ).toBe(200);
      expect((await httpGetWithHost(target.port, "after.example.test", "/api/health")).status).toBe(
        403,
      );
      const beforeCors = await fetch(`http://127.0.0.1:${target.port}/api/health`, {
        headers: { Origin: "https://before.example.test" },
      });
      expect(beforeCors.headers.get("access-control-allow-origin")).toBe(
        "https://before.example.test",
      );
      const beforeMcp = await fetch(`http://127.0.0.1:${target.port}/mcp/agents`, {
        method: "POST",
      });
      expect(beforeMcp.status).toBe(406);
      const beforeProxyReload = await httpGetWithHost(target.port, proxyHost, "/", {
        "x-forwarded-proto": "https",
      });
      expect(await beforeProxyReload.text()).toBe("http");

      const reloadedPersisted = {
        ...initialPersisted,
        daemon: {
          ...initialPersisted.daemon,
          hostnames: ["127.0.0.1", "after.example.test"],
          cors: { allowedOrigins: ["https://after.example.test"] },
          trustedProxies: true as const,
          mcp: { enabled: false, injectIntoAgents: false },
          git: { maxProcessesPerSecond: 5, maxProcessConcurrency: 1 },
          relay: { ...initialPersisted.daemon.relay, enabled: true },
        },
        app: { baseUrl: "https://after.example.test" },
        agents: {
          catalogRefreshTimeoutMs: 5_000,
          providers: { codex: { enabled: false } },
        },
      };
      await writeFile(configPath, `${JSON.stringify(reloadedPersisted, null, 2)}\n`, "utf-8");

      const result = await client.reloadDaemonConfig("runtime-policies");

      expect(result).toEqual({
        requestId: "runtime-policies",
        appliedPaths: [
          "agents.catalogRefreshTimeoutMs",
          "agents.providers",
          "app.baseUrl",
          "daemon.cors.allowedOrigins",
          "daemon.git.maxProcessConcurrency",
          "daemon.git.maxProcessesPerSecond",
          "daemon.hostnames",
          "daemon.mcp.enabled",
          "daemon.relay.enabled",
          "daemon.trustedProxies",
        ],
        restartRequiredPaths: [],
        overrideControlledPaths: [],
      });
      expect(
        (await httpGetWithHost(target.port, "before.example.test", "/api/health")).status,
      ).toBe(403);
      expect((await httpGetWithHost(target.port, "after.example.test", "/api/health")).status).toBe(
        200,
      );
      const afterCors = await fetch(`http://127.0.0.1:${target.port}/api/health`, {
        headers: { Origin: "https://after.example.test" },
      });
      expect(afterCors.headers.get("access-control-allow-origin")).toBe(
        "https://after.example.test",
      );
      const afterProxyReload = await httpGetWithHost(target.port, proxyHost, "/", {
        "x-forwarded-proto": "https",
      });
      expect(await afterProxyReload.text()).toBe("https");
      await expect(
        probeWebSocketConnection(`ws://127.0.0.1:${target.port}/ws`, {
          host: "after.example.test",
          origin: "https://after.example.test",
        }),
      ).resolves.toEqual({ status: "connected" });
      await expect(
        probeWebSocketConnection(`ws://127.0.0.1:${target.port}/ws`, {
          host: "after.example.test",
          origin: "https://before.example.test",
        }),
      ).resolves.toEqual({ status: "rejected", statusCode: 403 });
      expect(
        (
          await fetch(`http://127.0.0.1:${target.port}/mcp/agents`, {
            method: "POST",
          })
        ).status,
      ).toBe(404);
      expect(snapshotGitCommandRuntimeMetrics()).toMatchObject({
        concurrencyLimit: 1,
        maxProcessesPerSecond: 5,
      });
      await expect(
        daemon.agentManager.createAgent({ provider: "codex", cwd: agentCwd }, undefined, {
          workspaceId: undefined,
        }),
      ).rejects.toThrow(/disabled/i);
      expect((await client.getDaemonStatus()).relay?.enabled).toBe(true);
      expect((await client.getDaemonPairingOffer()).url).toContain(
        "https://after.example.test/#offer=",
      );
    } finally {
      configureGitProcessPolicy(DEFAULT_GIT_PROCESS_POLICY);
      await client?.close().catch(() => undefined);
      await daemon.stop().catch(() => undefined);
      if (proxyUpstream) {
        await new Promise<void>((resolve) => proxyUpstream?.close(() => resolve()));
      }
      await Promise.all([
        rm(paseoHomeRoot, { recursive: true, force: true }),
        rm(staticDir, { recursive: true, force: true }),
        rm(agentCwd, { recursive: true, force: true }),
      ]);
    }
  });

  function httpGetWithHost(
    port: number,
    host: string,
    requestPath: string,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return new Promise((resolve, reject) => {
      const req = http.get(
        { hostname: "127.0.0.1", port, path: requestPath, headers: { host, ...headers } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            resolve(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode ?? 0,
                headers: res.headers as HeadersInit,
              }),
            );
          });
        },
      );
      req.on("error", reject);
    });
  }

  test("proxies registered service hosts before daemon auth while daemon APIs stay protected", async () => {
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("service-ok");
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected upstream TCP address");
    }

    const daemonHandle = await createTestPaseoDaemon({
      auth: { password: hashDaemonPassword("secret") },
    });
    try {
      daemonHandle.daemon.serviceProxy.registerWorkspaceService({
        workspaceId: "workspace-service-auth",
        projectSlug: "repo",
        branchName: "main",
        scriptName: "web",
        port: address.port,
      });

      const serviceResponse = await httpGetWithHost(
        daemonHandle.port,
        `web--repo.localhost:${daemonHandle.port}`,
        "/",
      );
      expect(serviceResponse.status).toBe(200);
      expect(await serviceResponse.text()).toBe("service-ok");

      const daemonResponse = await httpGetWithHost(
        daemonHandle.port,
        `daemon.localhost:${daemonHandle.port}`,
        "/api/status",
      );
      expect(daemonResponse.status).toBe(401);
    } finally {
      await daemonHandle.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  test("configured public service namespace misses never reach daemon APIs", async () => {
    const daemonHandle = await createTestPaseoDaemon({
      serviceProxy: {
        publicBaseUrl: "https://services.example.com",
        standaloneListen: null,
      },
    });
    try {
      const response = await httpGetWithHost(
        daemonHandle.port,
        `missing.services.example.com:${daemonHandle.port}`,
        "/api/status",
      );
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("404 Not Found");
    } finally {
      await daemonHandle.close();
    }
  });

  test("rolls back daemon listener when standalone service proxy startup fails", async () => {
    const occupiedServer = http.createServer((_req, res) => {
      res.end("occupied");
    });
    await new Promise<void>((resolve) => occupiedServer.listen(0, "127.0.0.1", resolve));
    const address = occupiedServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected occupied TCP address");
    }

    const paseoHomeRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-standalone-rollback-"));
    const paseoHome = path.join(paseoHomeRoot, ".paseo");
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    await mkdir(paseoHome, { recursive: true });
    const config: PaseoDaemonConfig = {
      listen: "127.0.0.1:0",
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: false,
      staticDir,
      mcpDebug: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(paseoHome, "agents"),
      relayEnabled: false,
      appBaseUrl: "https://app.paseo.sh",
      openai: undefined,
      speech: undefined,
      serviceProxy: {
        standaloneListen: `127.0.0.1:${address.port}`,
      },
    };
    const daemon = await createPaseoDaemon(config, pino({ level: "silent" }));

    try {
      await expect(daemon.start()).rejects.toThrow();
      await expect(fetch(`http://127.0.0.1:${daemon.port}/api/health`)).rejects.toThrow();
    } finally {
      await daemon.stop().catch(() => undefined);
      await new Promise<void>((resolve) => occupiedServer.close(() => resolve()));
      await rm(paseoHomeRoot, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
    }
  });

  test("local service namespace misses never reach daemon APIs", async () => {
    const daemonHandle = await createTestPaseoDaemon({
      auth: { password: hashDaemonPassword("secret") },
    });
    try {
      const response = await httpGetWithHost(
        daemonHandle.port,
        `missing--repo.localhost:${daemonHandle.port}`,
        "/api/status",
      );
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("404 Not Found");
    } finally {
      await daemonHandle.close();
    }
  });

  test("daemon websocket still upgrades when service proxy upgrade handler is mounted", async () => {
    const daemonHandle = await createTestPaseoDaemon();
    const ws = new WebSocket(`ws://127.0.0.1:${daemonHandle.port}/ws`);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      expect(ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      ws.close();
      await daemonHandle.close();
    }
  });

  test("relay config changes during Hub enrollment reach the live runtime", async () => {
    const paseoHomeRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-relay-startup-"));
    const paseoHome = path.join(paseoHomeRoot, ".paseo");
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    await mkdir(paseoHome, { recursive: true });
    await writeFile(
      path.join(paseoHome, "hub-relationship.json"),
      `${JSON.stringify({
        version: 1,
        state: "pending",
        relationship: {
          daemonId: "daemon-startup-race",
          idempotencyKey: "enrollment-startup-race",
          hubOrigin: "https://hub.test",
          createdAt: "2026-07-31T00:00:00.000Z",
          scopes: ["hub.execution.*"],
        },
        credential: { secret: "credential" },
        enrollment: { token: "enrollment-token" },
        identity: { serverId: "server-startup-race", daemonPublicKey: "public-key" },
      })}\n`,
      "utf-8",
    );

    let markEnrollmentStarted: () => void = () => undefined;
    const enrollmentStarted = new Promise<void>((resolve) => {
      markEnrollmentStarted = resolve;
    });
    let releaseEnrollment: () => void = () => undefined;
    const enrollmentReleased = new Promise<void>((resolve) => {
      releaseEnrollment = resolve;
    });
    const remote: HubRelationshipRemote = {
      async enroll(input: HubEnrollment): Promise<HubEnrollmentResult> {
        markEnrollmentStarted();
        await enrollmentReleased;
        return {
          daemonId: input.daemonId,
          permissions: input.permissions,
          webSocketUrl: "wss://hub.test/daemon",
        };
      },
      async updatePermissions(input) {
        return { permissions: input.permissions };
      },
      async revoke(_input: HubRevocation): Promise<void> {},
      openSocket(_input: HubSocketCredentials, _events: HubSocketEvents): HubSocketConnection {
        return { close: () => undefined };
      },
    };
    const config: PaseoDaemonConfig = {
      listen: "127.0.0.1:0",
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: false,
      staticDir,
      mcpDebug: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(paseoHome, "agents"),
      relayEnabled: false,
      relayEndpoint: "127.0.0.1:9",
      relayUseTls: false,
      appBaseUrl: "https://app.paseo.sh",
      openai: undefined,
      speech: undefined,
    };
    const daemon = await createPaseoDaemon(config, pino({ level: "silent" }), {
      hubRelationshipRemote: remote,
    });
    const starting = daemon.start();
    let client: DaemonClient | null = null;

    try {
      await enrollmentStarted;
      const listenTarget = daemon.getListenTarget();
      if (!listenTarget || listenTarget.type !== "tcp") {
        throw new Error("Expected daemon TCP listener during Hub enrollment");
      }
      client = new DaemonClient({
        url: `ws://127.0.0.1:${listenTarget.port}/ws`,
        appVersion: "0.1.82",
      });
      await client.connect();
      await client.patchDaemonConfig({ relay: { enabled: true } });
      releaseEnrollment();
      await starting;

      const status = await client.getDaemonStatus();
      expect(status.relay?.enabled).toBe(true);
    } finally {
      releaseEnrollment();
      await starting.catch(() => undefined);
      await client?.close().catch(() => undefined);
      await daemon.stop().catch(() => undefined);
      await rm(paseoHomeRoot, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
    }
  });

  test("stops new connections and agent registrations before closing agents", async () => {
    const shutdown = await beginDaemonShutdownWithAgentClosing();
    try {
      await expect(
        Promise.all([shutdown.probeReconnect(), shutdown.tryCreateAgent()]),
      ).resolves.toEqual([{ status: "rejected", statusCode: 503 }, "rejected"]);
    } finally {
      await shutdown.finish();
    }
  });

  test("standalone listener exposes services only", async () => {
    const standalonePort = await findFreePort();
    const upstream = http.createServer((_req, res) => {
      res.end("service-ok");
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === "string") {
      throw new Error("Expected upstream TCP address");
    }

    const daemonHandle = await createTestPaseoDaemon({
      serviceProxy: { standaloneListen: `127.0.0.1:${standalonePort}` },
    });
    try {
      daemonHandle.daemon.serviceProxy.registerWorkspaceService({
        workspaceId: "workspace-standalone",
        projectSlug: "repo",
        branchName: "main",
        scriptName: "web",
        port: upstreamAddress.port,
      });

      const serviceResponse = await httpGetWithHost(
        standalonePort,
        `web--repo.localhost:${standalonePort}`,
        "/",
      );
      expect(serviceResponse.status).toBe(200);
      expect(await serviceResponse.text()).toBe("service-ok");

      for (const requestPath of ["/api/health", "/ws", "/mcp/agents", "/index.html", "/files/x"]) {
        const response = await httpGetWithHost(
          standalonePort,
          `daemon.localhost:${standalonePort}`,
          requestPath,
        );
        expect(response.status).toBe(404);
      }
    } finally {
      await daemonHandle.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  test("rolls back standalone listener without starting plugins when main listen fails", async () => {
    const mainPort = await findFreePort();
    const standalonePort = await findFreePort();
    const occupiedMain = http.createServer((_req, res) => {
      res.end("occupied-main");
    });
    await new Promise<void>((resolve) => occupiedMain.listen(mainPort, "127.0.0.1", resolve));

    const paseoHomeRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-main-rollback-"));
    const paseoHome = path.join(paseoHomeRoot, ".paseo");
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const pluginDirectory = path.join(paseoHomeRoot, "plugin");
    const pluginPidPath = path.join(pluginDirectory, "plugin.pid");
    await mkdir(paseoHome, { recursive: true });
    if (!isPlatform("win32")) {
      await mkdir(pluginDirectory);
      await writeFile(
        path.join(pluginDirectory, "paseo-plugin.json"),
        JSON.stringify({ id: "startup-rollback" }),
      );
      await writeFile(
        path.join(pluginDirectory, "index.tsx"),
        `import { writeFileSync } from "node:fs";
export default function contribute(plugin: unknown) {
  void plugin;
  writeFileSync(${JSON.stringify(pluginPidPath)}, String(process.pid));
}`,
      );
    }
    const config: PaseoDaemonConfig = {
      listen: `127.0.0.1:${mainPort}`,
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: false,
      staticDir,
      mcpDebug: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(paseoHome, "agents"),
      relayEnabled: false,
      appBaseUrl: "https://app.paseo.sh",
      openai: undefined,
      speech: undefined,
      serviceProxy: { standaloneListen: `127.0.0.1:${standalonePort}` },
      pluginsEnabled: !isPlatform("win32"),
      plugins: isPlatform("win32")
        ? {}
        : { "startup-rollback": { source: "directory", path: pluginDirectory } },
    };
    const daemon = await createPaseoDaemon(config, pino({ level: "silent" }));

    try {
      await expect(daemon.start()).rejects.toThrow();
      await expect(fetch(`http://127.0.0.1:${standalonePort}/api/health`)).rejects.toThrow();
      if (!isPlatform("win32")) {
        await expect(readFile(pluginPidPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      await daemon.stop().catch(() => undefined);
      await new Promise<void>((resolve) => occupiedMain.close(() => resolve()));
      await rm(paseoHomeRoot, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
    }
  });

  test("redacts Agent MCP debug request credentials and bodies", async () => {
    const logLines: string[] = [];
    const logger = pino(
      { level: "debug" },
      {
        write: (line: string) => {
          logLines.push(line);
        },
      },
    );
    const daemonHandle = await createTestPaseoDaemon({
      logger,
      mcpDebug: true,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${daemonHandle.port}/mcp/agents`, {
        method: "POST",
        headers: {
          Authorization: "Bearer secret-debug-token",
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            apiKey: "secret-body-token",
          },
        }),
      });

      await response.text();
      const logs = logLines.join("\n");
      expect(logs).toContain("Agent MCP request");
      expect(logs).toContain("[redacted]");
      expect(logs).toContain('"method":"tools/call"');
      expect(logs).toContain('"hasParams":true');
      expect(logs).not.toContain("secret-debug-token");
      expect(logs).not.toContain("secret-body-token");
      expect(logs).not.toContain("apiKey");
    } finally {
      await daemonHandle.close();
    }
  });

  test("starts when OpenAI speech provider is configured without credentials", async () => {
    const paseoHomeRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-openai-config-"));
    const paseoHome = path.join(paseoHomeRoot, ".paseo");
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    await mkdir(paseoHome, { recursive: true });

    const config: PaseoDaemonConfig = {
      listen: "127.0.0.1:0",
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: false,
      staticDir,
      mcpDebug: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(paseoHome, "agents"),
      relayEnabled: false,
      appBaseUrl: "https://app.paseo.sh",
      openai: undefined,
      speech: {
        providers: {
          dictationStt: { provider: "openai", explicit: true },
          voiceStt: { provider: "openai", explicit: true },
          voiceTts: { provider: "openai", explicit: true },
        },
      },
    };

    try {
      const daemon = await createPaseoDaemon(config, pino({ level: "silent" }));
      try {
        await daemon.start();
        expect(daemon.getListenTarget()).toBeDefined();
        // Must also stop without throwing
      } finally {
        await daemon.stop();
      }
    } finally {
      await rm(paseoHomeRoot, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
    }
  });

  test("does not block daemon start on local speech model downloads", async () => {
    const originalFetch = globalThis.fetch;
    let releaseFetch: ((value: Response) => void) | null = null;
    const fetchGate = new Promise<Response>((resolve) => {
      releaseFetch = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => fetchGate),
    );

    const daemonHandle = await createTestPaseoDaemon({
      speech: {
        providers: {
          dictationStt: { provider: "local", explicit: true, enabled: true },
          voiceTurnDetection: { provider: "local", explicit: true, enabled: false },
          voiceStt: { provider: "local", explicit: true, enabled: false },
          voiceTts: { provider: "local", explicit: true, enabled: false },
        },
        local: {
          modelsDir: path.join(os.tmpdir(), `paseo-missing-models-${Date.now()}`),
          models: {
            dictationStt: "parakeet-tdt-0.6b-v2-int8",
            voiceStt: "parakeet-tdt-0.6b-v2-int8",
            voiceTts: "kokoro-en-v0_19",
          },
        },
      },
    });

    try {
      const response = await originalFetch(`http://127.0.0.1:${daemonHandle.port}/api/health`);
      expect(response.ok).toBe(true);
    } finally {
      releaseFetch?.(
        new Response(null, {
          status: 500,
          statusText: "test cleanup",
        }),
      );
      vi.unstubAllGlobals();
      globalThis.fetch = originalFetch;
      await daemonHandle.close();
    }
  });

  test("parses whitespace-padded numeric port strings", () => {
    expect(parseListenString(" 6767 ")).toEqual({
      type: "tcp",
      host: "127.0.0.1",
      port: 6767,
    });
  });

  test("parses IPv6 listen targets correctly", () => {
    expect(parseListenString("[::1]:6767")).toEqual({
      type: "tcp",
      host: "::1",
      port: 6767,
    });
    expect(parseListenString("[::]:6767")).toEqual({
      type: "tcp",
      host: "::",
      port: 6767,
    });
  });

  test("rejects Windows absolute paths that are not named pipes", () => {
    // A Windows drive path like C:\daemon must NOT be silently parsed as TCP
    // (split(":") would yield host="C" and port="\\daemon" which is nonsensical).
    expect(() => parseListenString(String.raw`C:\daemon`)).toThrow();
    expect(() => parseListenString(String.raw`D:\Users\foo\.paseo\daemon.sock`)).toThrow();
    // Single-letter "host" with no valid port is not a valid listen string
    expect(() => parseListenString(String.raw`C:\some\path`)).toThrow();
  });

  test("parses Windows named pipes as managed IPC listen targets", () => {
    expect(parseListenString(String.raw`\\.\pipe\paseo-managed-test`)).toEqual({
      type: "pipe",
      path: String.raw`\\.\pipe\paseo-managed-test`,
    });
    expect(parseListenString(`pipe://${String.raw`\\.\pipe\paseo-managed-test`}`)).toEqual({
      type: "pipe",
      path: String.raw`\\.\pipe\paseo-managed-test`,
    });
  });

  // POSIX-only: Unix socket listen paths are invalid Windows listen targets.
  test.skipIf(isPlatform("win32"))(
    "generates a relay pairing offer for unix socket listeners",
    async () => {
      const paseoHomeRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-socket-relay-"));
      const paseoHome = path.join(paseoHomeRoot, ".paseo");
      const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
      const socketPath = path.join(paseoHomeRoot, "run", "paseo.sock");
      await mkdir(path.dirname(socketPath), { recursive: true });
      await mkdir(paseoHome, { recursive: true });
      const logger = pino({ level: "silent" });

      const config: PaseoDaemonConfig = {
        listen: socketPath,
        paseoHome,
        corsAllowedOrigins: [],
        hostnames: true,
        mcpEnabled: false,
        staticDir,
        mcpDebug: false,
        agentClients: createTestAgentClients(),
        agentStoragePath: path.join(paseoHome, "agents"),
        relayEnabled: true,
        relayEndpoint: "127.0.0.1:9",
        relayPublicEndpoint: "127.0.0.1:9",
        appBaseUrl: "https://app.paseo.sh",
        openai: undefined,
        speech: undefined,
      };

      const daemon = await createPaseoDaemon(config, logger);

      try {
        await daemon.start();
        const pairing = await generateLocalPairingOffer({
          paseoHome,
          relayEnabled: true,
          relayEndpoint: "127.0.0.1:9",
          relayPublicEndpoint: "127.0.0.1:9",
          appBaseUrl: "https://app.paseo.sh",
          includeQr: false,
        });
        expect(pairing.relayEnabled).toBe(true);
        expect(pairing.url?.startsWith("https://app.paseo.sh/#offer=")).toBe(true);
      } finally {
        await daemon.stop().catch(() => undefined);
        await daemon.agentManager.flush().catch(() => undefined);
        await rm(paseoHomeRoot, { recursive: true, force: true });
        await rm(staticDir, { recursive: true, force: true });
      }
    },
  );
});

function holdAgentClose(): HeldAgentClose {
  let armed = false;
  let markStarted = () => {};
  let finish = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return {
    started,
    arm() {
      armed = true;
    },
    async closeSession() {
      if (!armed) {
        return;
      }
      markStarted();
      await finished;
    },
    finish: () => finish(),
  };
}

async function beginDaemonShutdownWithAgentClosing(): Promise<BlockedDaemonShutdown> {
  const heldAgentClose = holdAgentClose();
  const daemonHandle = await createTestPaseoDaemon({
    cleanup: false,
    agentClients: createTestAgentClients({ closeSession: heldAgentClose.closeSession }),
  });
  const agentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-shutdown-agent-"));
  await daemonHandle.daemon.agentManager.createAgent(
    {
      provider: "codex",
      cwd: agentCwd,
    },
    undefined,
    { workspaceId: undefined },
  );

  heldAgentClose.arm();
  const stopPromise = daemonHandle.daemon.stop();
  await heldAgentClose.started;

  return {
    probeReconnect: () => probeWebSocketConnection(`ws://127.0.0.1:${daemonHandle.port}/ws`),
    async tryCreateAgent() {
      try {
        await daemonHandle.daemon.agentManager.createAgent(
          {
            provider: "codex",
            cwd: agentCwd,
          },
          undefined,
          { workspaceId: undefined },
        );
        return "created";
      } catch (error) {
        if (error instanceof AgentManagerShuttingDownError) {
          return "rejected";
        }
        throw error;
      }
    },
    async finish() {
      heldAgentClose.finish();
      await stopPromise;
      await daemonHandle.daemon.agentManager.flush().catch(() => undefined);
      await Promise.all([
        rm(path.dirname(daemonHandle.paseoHome), { recursive: true, force: true }),
        rm(daemonHandle.staticDir, { recursive: true, force: true }),
        rm(agentCwd, { recursive: true, force: true }),
      ]);
    },
  };
}

function probeWebSocketConnection(
  url: string,
  headers?: { host?: string; origin?: string },
): Promise<WebSocketProbeResult> {
  const ws = new WebSocket(url, {
    headers: {
      ...(headers?.host ? { Host: headers.host } : {}),
      ...(headers?.origin ? { Origin: headers.origin } : {}),
    },
  });
  return new Promise((resolve) => {
    ws.once("open", () => {
      ws.close();
      resolve({ status: "connected" });
    });
    ws.once("error", () => resolve({ status: "rejected", statusCode: null }));
    ws.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve({ status: "rejected", statusCode: response.statusCode ?? null });
    });
  });
}
