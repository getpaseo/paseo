import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import pino from "pino";
import { createPaseoDaemon, type PaseoDaemonConfig } from "../bootstrap.js";

type TestPaseoDaemonOptions = {
  downloadTokenTtlMs?: number;
  corsAllowedOrigins?: string[];
  listen?: string;
  logger?: Parameters<typeof createPaseoDaemon>[1];
  relayEnabled?: boolean;
  relayEndpoint?: string;
};

export type TestPaseoDaemon = {
  config: PaseoDaemonConfig;
  daemon: Awaited<ReturnType<typeof createPaseoDaemon>>;
  port: number;
  paseoHome: string;
  staticDir: string;
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
      staticDir,
      mcpDebug: false,
      agentClients: {},
      agentStoragePath: path.join(paseoHome, "agents"),
      agentControlMcp: {
        url: `http://127.0.0.1:${port}/mcp/agents`,
      },
      relayEnabled: options.relayEnabled ?? false,
      relayEndpoint: options.relayEndpoint ?? "relay.paseo.sh:443",
      appBaseUrl: "https://app.paseo.sh",
      openai: openaiApiKey ? { apiKey: openaiApiKey } : undefined,
      downloadTokenTtlMs: options.downloadTokenTtlMs,
    };

    const logger = options.logger ?? pino({ level: "silent" });
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
