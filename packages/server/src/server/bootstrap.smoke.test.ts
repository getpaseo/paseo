import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { describe, expect, test } from "vitest";

import { createPaseoDaemon, type PaseoDaemonConfig } from "./bootstrap.js";

async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to acquire port")));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

describe("paseo daemon bootstrap", () => {
  test("starts and serves health endpoint", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const port = await getAvailablePort();
    const basicUsers = { test: "pass" };
    const [agentMcpUser, agentMcpPassword] =
      Object.entries(basicUsers)[0] ?? [];
    const agentMcpAuthHeader =
      agentMcpUser && agentMcpPassword
        ? `Basic ${Buffer.from(`${agentMcpUser}:${agentMcpPassword}`).toString("base64")}`
        : undefined;
    const agentMcpBearerToken =
      agentMcpUser && agentMcpPassword
        ? Buffer.from(`${agentMcpUser}:${agentMcpPassword}`).toString("base64")
        : undefined;

    const daemonConfig: PaseoDaemonConfig = {
      port,
      paseoHome,
      agentMcpRoute: "/mcp/agents",
      agentMcpAllowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
      auth: {
        basicUsers,
        agentMcpAuthHeader,
        agentMcpBearerToken,
        realm: "Voice Assistant",
      },
      staticDir,
      mcpDebug: false,
      agentClients: {},
      agentRegistryPath: path.join(paseoHome, "agents.json"),
      agentControlMcp: {
        url: `http://127.0.0.1:${port}/mcp/agents`,
        ...(agentMcpAuthHeader
          ? { headers: { Authorization: agentMcpAuthHeader } }
          : {}),
      },
    };

    const daemon = await createPaseoDaemon(daemonConfig);
    await new Promise<void>((resolve) => {
      daemon.httpServer.listen(port, () => resolve());
    });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        headers: agentMcpAuthHeader
          ? { Authorization: agentMcpAuthHeader }
          : undefined,
      });
      expect(response.ok).toBe(true);
      const payload = await response.json();
      expect(payload.status).toBe("ok");
      expect(typeof payload.timestamp).toBe("string");
    } finally {
      await daemon.close().catch(() => undefined);
      await rm(paseoHome, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
    }
  });
});
