import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";

import pino from "pino";
import { createJunctionDaemon, type JunctionDaemonConfig } from "../bootstrap.js";
import type { AgentClient, AgentProvider } from "../agent/agent-sdk-types.js";
import { createTestAgentClients } from "./fake-agent-client.js";

type TestJunctionDaemonOptions = {
  downloadTokenTtlMs?: number;
  corsAllowedOrigins?: string[];
  listen?: string;
  logger?: Parameters<typeof createJunctionDaemon>[1];
  relayEnabled?: boolean;
  relayEndpoint?: string;
  agentClients?: Partial<Record<AgentProvider, AgentClient>>;
  junctionHomeRoot?: string;
  staticDir?: string;
  cleanup?: boolean;
};

export type TestJunctionDaemon = {
  config: JunctionDaemonConfig;
  daemon: Awaited<ReturnType<typeof createJunctionDaemon>>;
  port: number;
  junctionHome: string;
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

const TEST_DAEMON_START_TIMEOUT_MS = 20_000;

async function startDaemonWithTimeout(
  daemon: Awaited<ReturnType<typeof createJunctionDaemon>>,
  timeoutMs: number
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      const timeoutError = new Error(
        `Timed out starting test daemon after ${timeoutMs}ms`
      ) as Error & { code?: string };
      timeoutError.code = "TEST_DAEMON_START_TIMEOUT";
      reject(timeoutError);
    }, timeoutMs);

    daemon.start().then(
      () => {
        clearTimeout(timeoutHandle);
        resolve();
      },
      (error) => {
        clearTimeout(timeoutHandle);
        reject(error);
      }
    );
  });
}

export async function createTestJunctionDaemon(
  options: TestJunctionDaemonOptions = {}
): Promise<TestJunctionDaemon> {
  const maxAttempts = 8;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const junctionHomeRoot =
      options.junctionHomeRoot ?? (await mkdtemp(path.join(os.tmpdir(), "junction-home-")));
    const junctionHome = path.join(junctionHomeRoot, ".junction");
    await mkdir(junctionHome, { recursive: true });
    const staticDir = options.staticDir ?? (await mkdtemp(path.join(os.tmpdir(), "junction-static-")));
    const port = await getAvailablePort();

    const listenHost = options.listen ?? '127.0.0.1';
    const config: JunctionDaemonConfig = {
      listen: `${listenHost}:${port}`,
      junctionHome,
      corsAllowedOrigins: options.corsAllowedOrigins ?? [],
      allowedHosts: true,
      mcpEnabled: true,
      staticDir,
      mcpDebug: false,
      agentClients: options.agentClients ?? createTestAgentClients(),
      agentStoragePath: path.join(junctionHome, "agents"),
      relayEnabled: options.relayEnabled ?? false,
      relayEndpoint: options.relayEndpoint ?? "relay.junction.sh:443",
      appBaseUrl: "https://app.junction.sh",
      downloadTokenTtlMs: options.downloadTokenTtlMs,
    };

    const logger = options.logger ?? pino({ level: "silent" });
    const daemon = await createJunctionDaemon(config, logger);
    try {
      await startDaemonWithTimeout(daemon, TEST_DAEMON_START_TIMEOUT_MS);

      const close = async (): Promise<void> => {
        await daemon.stop().catch(() => undefined);
        await daemon.agentManager.flush().catch(() => undefined);
        if (options.cleanup ?? true) {
          await new Promise((r) => setTimeout(r, 50));
          await rm(junctionHomeRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
          await rm(staticDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        }
      };

      return {
        config,
        daemon,
        port,
        junctionHome,
        staticDir,
        close,
      };
    } catch (error) {
      lastError = error;
      await daemon.stop().catch(() => undefined);
      await rm(junctionHomeRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      await rm(staticDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });

      if (
        (!isAddressInUseError(error) && !isStartupTimeoutError(error)) ||
        attempt === maxAttempts - 1
      ) {
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

function isStartupTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error as { code?: string };
  return record.code === "TEST_DAEMON_START_TIMEOUT";
}
