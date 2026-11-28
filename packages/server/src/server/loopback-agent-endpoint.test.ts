import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import {
  createAgentMcpBaseUrl,
  createLoopbackAgentEndpoint,
  createTerminalActivityUrl,
  resolvePrimaryLoopbackTarget,
  type LoopbackAgentEndpoint,
} from "./loopback-agent-endpoint.js";

const endpoints: LoopbackAgentEndpoint[] = [];

afterEach(async () => {
  await Promise.all(endpoints.splice(0).map((endpoint) => endpoint.stop()));
});

describe("resolvePrimaryLoopbackTarget", () => {
  test("reuses loopback and wildcard TCP listeners", () => {
    expect(resolvePrimaryLoopbackTarget({ type: "tcp", host: "127.0.0.1", port: 6767 })).toEqual({
      type: "tcp",
      host: "127.0.0.1",
      port: 6767,
    });
    expect(resolvePrimaryLoopbackTarget({ type: "tcp", host: "localhost", port: 6767 })).toEqual({
      type: "tcp",
      host: "localhost",
      port: 6767,
    });
    expect(resolvePrimaryLoopbackTarget({ type: "tcp", host: "::1", port: 6767 })).toEqual({
      type: "tcp",
      host: "::1",
      port: 6767,
    });
    expect(resolvePrimaryLoopbackTarget({ type: "tcp", host: "0.0.0.0", port: 6767 })).toEqual({
      type: "tcp",
      host: "127.0.0.1",
      port: 6767,
    });
    expect(resolvePrimaryLoopbackTarget({ type: "tcp", host: "::", port: 6767 })).toEqual({
      type: "tcp",
      host: "::1",
      port: 6767,
    });
  });

  test("returns null for non-loopback TCP, Unix sockets, and Windows named pipes", () => {
    expect(
      resolvePrimaryLoopbackTarget({ type: "tcp", host: "100.101.102.103", port: 6767 }),
    ).toBeNull();
    expect(
      resolvePrimaryLoopbackTarget({ type: "tcp", host: "192.168.1.5", port: 6767 }),
    ).toBeNull();
    expect(resolvePrimaryLoopbackTarget({ type: "socket", path: "/tmp/paseo.sock" })).toBeNull();
    expect(resolvePrimaryLoopbackTarget({ type: "pipe", path: "\\\\.\\pipe\\paseo" })).toBeNull();
    expect(resolvePrimaryLoopbackTarget(null)).toBeNull();
  });
});

describe("createLoopbackAgentEndpoint", () => {
  test("reuses a loopback TCP primary listener without binding a dedicated server", async () => {
    const endpoint = createLoopbackAgentEndpoint({
      handleAgentMcpRequest: (_req, res) => res.json({ ok: true }),
      handleTerminalActivityRequest: (_req, res) => res.status(204).end(),
    });
    endpoints.push(endpoint);

    const started = await endpoint.start({ type: "tcp", host: "0.0.0.0", port: 6767 });
    expect(started).toEqual({
      target: { type: "tcp", host: "127.0.0.1", port: 6767 },
      dedicated: false,
    });
    expect(endpoint.getMcpBaseUrl()).toBe("http://127.0.0.1:6767/mcp/agents");
    expect(endpoint.getTerminalActivityUrl()).toBe("http://127.0.0.1:6767/api/terminal-activity");

    await endpoint.stop();
    expect(endpoint.getTarget()).toBeNull();
    expect(endpoint.getMcpBaseUrl()).toBeNull();
    expect(endpoint.getTerminalActivityUrl()).toBeNull();
  });

  test.each([
    { name: "Unix socket", primary: { type: "socket" as const, path: "/tmp/paseo.sock" } },
    { name: "Windows pipe", primary: { type: "pipe" as const, path: "\\\\.\\pipe\\paseo" } },
    {
      name: "non-loopback TCP",
      primary: { type: "tcp" as const, host: "100.101.102.103", port: 6767 },
    },
  ])(
    "binds a dedicated 127.0.0.1 server for $name serving only agent endpoints and closes cleanly",
    async ({ primary }) => {
      const mcpBodies: unknown[] = [];
      const activityBodies: unknown[] = [];
      const endpoint = createLoopbackAgentEndpoint({
        handleAgentMcpRequest: (req, res) => {
          mcpBodies.push(req.body);
          res.status(200).json({ ok: true });
        },
        handleTerminalActivityRequest: (req, res) => {
          activityBodies.push(req.body);
          res.status(204).end();
        },
      });
      endpoints.push(endpoint);

      const started = await endpoint.start(primary);
      expect(started.dedicated).toBe(true);
      expect(started.target.host).toBe("127.0.0.1");
      expect(started.target.port).toBeGreaterThan(0);

      const mcpUrl = endpoint.getMcpBaseUrl();
      const activityUrl = endpoint.getTerminalActivityUrl();
      expect(mcpUrl).toBe(createAgentMcpBaseUrl(started.target));
      expect(activityUrl).toBe(createTerminalActivityUrl(started.target));

      const mcpResponse = await fetch(mcpUrl!, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping" }),
      });
      expect(mcpResponse.status).toBe(200);
      expect(mcpBodies).toEqual([{ jsonrpc: "2.0", method: "ping" }]);

      const activityResponse = await fetch(activityUrl!, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ terminalId: "t1", token: "tok", state: "running" }),
      });
      expect(activityResponse.status).toBe(204);
      expect(activityBodies).toEqual([{ terminalId: "t1", token: "tok", state: "running" }]);

      // Unmounted daemon routes are never served on the internal loopback server.
      const statusResponse = await fetch(`http://127.0.0.1:${started.target.port}/api/status`);
      expect(statusResponse.status).toBe(404);
      const healthResponse = await fetch(`http://127.0.0.1:${started.target.port}/api/health`);
      expect(healthResponse.status).toBe(404);

      // Non-loopback Host header is rejected to prevent DNS rebinding.
      const rejectedHostStatus = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port: started.target.port,
            path: "/mcp/agents",
            method: "POST",
            headers: {
              host: `attacker.invalid:${started.target.port}`,
              "content-type": "application/json",
            },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.once("error", reject);
        req.end("{}");
      });
      expect(rejectedHostStatus).toBe(403);

      // Clean and idempotent shutdown closes the port.
      await endpoint.stop();
      await endpoint.stop();
      await expect(
        new Promise<void>((resolve, reject) => {
          const socket = net.createConnection({ host: "127.0.0.1", port: started.target.port });
          socket.once("connect", () => {
            socket.destroy();
            resolve();
          });
          socket.once("error", reject);
        }),
      ).rejects.toThrow();
    },
  );
});
