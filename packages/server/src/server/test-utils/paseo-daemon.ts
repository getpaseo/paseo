import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import pino from "pino";
import { createPaseoDaemon, type PaseoDaemonConfig } from "../bootstrap.js";

type TestPaseoDaemonOptions = {
  basicUsers?: Record<string, string>;
  downloadTokenTtlMs?: number;
  corsAllowedOrigins?: string[];
  listen?: string;
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
  const openaiApiKey = process.env.OPENAI_API_KEY;
  const maxAttempts = 5;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const port = await getAvailablePort();

    const listenHost = options.listen ?? '127.0.0.1';
    const config: PaseoDaemonConfig = {
      listen: `${listenHost}:${port}`,
      paseoHome,
      corsAllowedOrigins: options.corsAllowedOrigins ?? [],
      agentMcpRoute: "/mcp/agents",
      agentMcpAllowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`, `${listenHost}:${port}`],
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
      openai: openaiApiKey ? { apiKey: openaiApiKey } : undefined,
      downloadTokenTtlMs: options.downloadTokenTtlMs,
    };

    const logger = pino({ level: "silent" });
    const daemon = await createPaseoDaemon(config, logger);
    try {
      await daemon.start();

      const close = async (): Promise<void> => {
        await daemon.stop().catch(() => undefined);
        await new Promise((r) => setTimeout(r, 200));
        await rm(paseoHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        await rm(staticDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
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
    } catch (error) {
      lastError = error;
      await daemon.stop().catch(() => undefined);
      await rm(paseoHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      await rm(staticDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });

      if (!isAddressInUseError(error) || attempt === maxAttempts - 1) {
        throw error;
      }
    }
  }

  throw lastError ?? new Error("Failed to start test daemon");
}

function isAddressInUseError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error as { code?: string };
  return record.code === "EADDRINUSE";
}
