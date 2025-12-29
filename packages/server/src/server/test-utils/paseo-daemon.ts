import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { createPaseoDaemon, type PaseoDaemonConfig } from "../bootstrap.js";

type TestPaseoDaemonOptions = {
  basicUsers?: Record<string, string>;
  downloadTokenTtlMs?: number;
};

export type TestPaseoDaemon = {
  config: PaseoDaemonConfig;
  daemon: Awaited<ReturnType<typeof createPaseoDaemon>>;
  port: number;
  paseoHome: string;
  staticDir: string;
  agentMcpAuthHeader?: string;
  agentMcpBearerToken?: string;
  close: () => Promise<void>;
};

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
      server.close(() => resolve(address.port));
    });
  });
}

export async function createTestPaseoDaemon(
  options: TestPaseoDaemonOptions = {}
): Promise<TestPaseoDaemon> {
  const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-"));
  const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
  const port = await getAvailablePort();
  const basicUsers = options.basicUsers ?? { test: "pass" };
  const [agentMcpUser, agentMcpPassword] = Object.entries(basicUsers)[0] ?? [];
  const agentMcpAuthHeader =
    agentMcpUser && agentMcpPassword
      ? `Basic ${Buffer.from(`${agentMcpUser}:${agentMcpPassword}`).toString("base64")}`
      : undefined;
  const agentMcpBearerToken =
    agentMcpUser && agentMcpPassword
      ? Buffer.from(`${agentMcpUser}:${agentMcpPassword}`).toString("base64")
      : undefined;

  const config: PaseoDaemonConfig = {
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
    downloadTokenTtlMs: options.downloadTokenTtlMs,
  };

  const daemon = await createPaseoDaemon(config);
  await new Promise<void>((resolve) => {
    daemon.httpServer.listen(port, () => resolve());
  });

  const close = async (): Promise<void> => {
    await daemon.close().catch(() => undefined);
    await rm(paseoHome, { recursive: true, force: true });
    await rm(staticDir, { recursive: true, force: true });
  };

  return {
    config,
    daemon,
    port,
    paseoHome,
    staticDir,
    agentMcpAuthHeader,
    agentMcpBearerToken,
    close,
  };
}
