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
      openai: openaiApiKey ? { apiKey: openaiApiKey } : undefined,
      downloadTokenTtlMs: options.downloadTokenTtlMs,
    };

    const daemon = await createPaseoDaemon(config);
    try {
      await listenOnPort(daemon.httpServer, port);

      const close = async (): Promise<void> => {
        await daemon.close().catch(() => undefined);
        // Wait a bit for file handles to release
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
      await daemon.close().catch(() => undefined);
      await rm(paseoHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      await rm(staticDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });

      if (!isAddressInUseError(error) || attempt === maxAttempts - 1) {
        throw error;
      }
    }
  }

  throw lastError ?? new Error("Failed to start test daemon");
}

async function listenOnPort(server: net.Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);

    try {
      server.listen(port);
    } catch (error) {
      server.off("error", onError);
      server.off("listening", onListening);
      reject(error instanceof Error ? error : new Error("Failed to listen"));
    }
  });
}

function isAddressInUseError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error as { code?: string };
  return record.code === "EADDRINUSE";
}
