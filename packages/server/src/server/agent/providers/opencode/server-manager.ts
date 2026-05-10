import type { ChildProcess } from "node:child_process";
import net from "node:net";
import type { Logger } from "pino";

import { findExecutable } from "../../../../utils/executable.js";
import { spawnProcess } from "../../../../utils/spawn.js";
import { terminateWithTreeKill } from "../../../../utils/tree-kill.js";
import {
  createProviderEnvSpec,
  resolveProviderCommandPrefix,
  type ProviderRuntimeSettings,
} from "../../provider-launch-config.js";

const OPENCODE_SERVER_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 5_000;
const OPENCODE_SERVER_FORCE_SHUTDOWN_TIMEOUT_MS = 1_000;

export interface OpenCodeServerAcquisition {
  server: { port: number; url: string };
  release: () => void;
}

export interface OpenCodeServerManagerLike {
  ensureRunning(): Promise<{ port: number; url: string }>;
  acquire(options: { force: boolean }): Promise<OpenCodeServerAcquisition>;
}

export interface OpenCodeServerGeneration {
  process: ChildProcess;
  port: number;
  url: string;
  refCount: number;
  retired: boolean;
}

export class OpenCodeServerManager implements OpenCodeServerManagerLike {
  private static instance: OpenCodeServerManager | null = null;
  private static exitHandlerRegistered = false;
  private currentServer: OpenCodeServerGeneration | null = null;
  private retiredServers = new Set<OpenCodeServerGeneration>();
  private startPromise: Promise<OpenCodeServerGeneration> | null = null;
  private forcedRefreshPromise: Promise<OpenCodeServerGeneration> | null = null;
  private readonly logger: Logger;
  private readonly runtimeSettings?: ProviderRuntimeSettings;
  private readonly runtimeSettingsKey: string;

  private constructor(logger: Logger, runtimeSettings?: ProviderRuntimeSettings) {
    this.logger = logger;
    this.runtimeSettings = runtimeSettings;
    this.runtimeSettingsKey = JSON.stringify(runtimeSettings ?? {});
  }

  static getInstance(
    logger: Logger,
    runtimeSettings?: ProviderRuntimeSettings,
  ): OpenCodeServerManager {
    const nextSettingsKey = JSON.stringify(runtimeSettings ?? {});
    if (!OpenCodeServerManager.instance) {
      OpenCodeServerManager.instance = new OpenCodeServerManager(logger, runtimeSettings);
      OpenCodeServerManager.registerExitHandler();
    } else if (OpenCodeServerManager.instance.runtimeSettingsKey !== nextSettingsKey) {
      logger.warn(
        {
          existingRuntimeSettings: OpenCodeServerManager.instance.runtimeSettingsKey,
          requestedRuntimeSettings: nextSettingsKey,
        },
        "OpenCode server manager already initialized with different runtime settings",
      );
    }
    return OpenCodeServerManager.instance;
  }

  private static registerExitHandler(): void {
    if (OpenCodeServerManager.exitHandlerRegistered) {
      return;
    }
    OpenCodeServerManager.exitHandlerRegistered = true;

    const cleanup = () => {
      const instance = OpenCodeServerManager.instance;
      void instance?.shutdown();
    };

    process.on("exit", cleanup);
    process.on("SIGTERM", cleanup);
    process.on("SIGINT", cleanup);
  }

  async ensureRunning(): Promise<{ port: number; url: string }> {
    const acquisition = await this.acquire({ force: false });
    acquisition.release();
    return acquisition.server;
  }

  async acquire(options: { force: boolean }): Promise<OpenCodeServerAcquisition> {
    const server = options.force
      ? await this.getForcedRefreshServer()
      : await this.getCurrentServer();
    server.refCount += 1;
    let released = false;
    return {
      server: { port: server.port, url: server.url },
      release: () => {
        if (released) {
          return;
        }
        released = true;
        server.refCount -= 1;
        this.cleanupRetiredServers();
      },
    };
  }

  private async getForcedRefreshServer(): Promise<OpenCodeServerGeneration> {
    if (this.forcedRefreshPromise) {
      return this.forcedRefreshPromise;
    }

    this.forcedRefreshPromise = Promise.resolve()
      .then(async () => {
        await this.rotateCurrentServer();
        return this.getCurrentServer();
      })
      .finally(() => {
        this.forcedRefreshPromise = null;
      });
    return this.forcedRefreshPromise;
  }

  private async getCurrentServer(): Promise<OpenCodeServerGeneration> {
    if (this.startPromise) {
      return this.startPromise;
    }

    if (this.currentServer && !this.currentServer.process.killed) {
      return this.currentServer;
    }

    this.startPromise = this.startServer();
    try {
      const result = await this.startPromise;
      if (!result.retired) {
        this.currentServer = result;
      }
      return result;
    } finally {
      this.startPromise = null;
    }
  }

  private async rotateCurrentServer(): Promise<void> {
    const existing = this.currentServer;
    if (existing) {
      existing.retired = true;
      this.retiredServers.add(existing);
      this.currentServer = null;
      this.cleanupRetiredServers();
    }
    if (this.startPromise) {
      const pending = await this.startPromise;
      pending.retired = true;
      this.retiredServers.add(pending);
      this.currentServer = null;
      this.cleanupRetiredServers();
    }
  }

  private async startServer(): Promise<OpenCodeServerGeneration> {
    const port = await findAvailablePort();
    const url = `http://127.0.0.1:${port}`;
    const launchPrefix = await resolveProviderCommandPrefix(
      this.runtimeSettings?.command,
      resolveOpenCodeBinary,
    );

    return new Promise((resolve, reject) => {
      const serverProcess = spawnProcess(
        launchPrefix.command,
        [...launchPrefix.args, "serve", "--port", String(port)],
        {
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
          ...createProviderEnvSpec({ runtimeSettings: this.runtimeSettings }),
        },
      );

      let started = false;
      let stderrBuffer = "";
      let stdoutBuffer = "";
      const STARTUP_BUFFER_CAP = 8192;
      const appendCapped = (current: string, chunk: string): string => {
        if (current.length >= STARTUP_BUFFER_CAP) {
          return current;
        }
        const remaining = STARTUP_BUFFER_CAP - current.length;
        return current + chunk.slice(0, remaining);
      };
      const buildStartupErrorMessage = (headline: string): string => {
        const sections = [headline];
        const stderrTrimmed = stderrBuffer.trim();
        if (stderrTrimmed.length > 0) {
          sections.push(`stderr: ${stderrTrimmed}`);
        }
        const stdoutTrimmed = stdoutBuffer.trim();
        if (stdoutTrimmed.length > 0) {
          sections.push(`stdout: ${stdoutTrimmed}`);
        }
        return sections.join("\n");
      };
      const timeout = setTimeout(() => {
        if (!started) {
          reject(new Error(buildStartupErrorMessage("OpenCode server startup timeout")));
        }
      }, 30_000);

      serverProcess.stdout?.on("data", (data: Buffer) => {
        const output = data.toString();
        stdoutBuffer = appendCapped(stdoutBuffer, output);
        if (output.includes("listening on") && !started) {
          started = true;
          clearTimeout(timeout);
          resolve({
            process: serverProcess,
            port,
            url,
            refCount: 0,
            retired: false,
          });
        }
      });

      serverProcess.stderr?.on("data", (data: Buffer) => {
        const output = data.toString();
        stderrBuffer = appendCapped(stderrBuffer, output);
        this.logger.error({ stderr: output.trim() }, "OpenCode server stderr");
      });

      serverProcess.on("error", (error) => {
        clearTimeout(timeout);
        const headline = error instanceof Error ? error.message : String(error);
        reject(new Error(buildStartupErrorMessage(headline)));
      });

      serverProcess.on("exit", (code) => {
        if (!started) {
          clearTimeout(timeout);
          reject(new Error(buildStartupErrorMessage(`OpenCode server exited with code ${code}`)));
        }
        if (this.currentServer?.process === serverProcess) {
          this.currentServer = null;
        }
        for (const retired of Array.from(this.retiredServers)) {
          if (retired.process === serverProcess) {
            this.retiredServers.delete(retired);
          }
        }
      });
    });
  }

  async shutdown(): Promise<void> {
    const servers = [
      ...(this.currentServer ? [this.currentServer] : []),
      ...Array.from(this.retiredServers),
    ];
    await Promise.all(servers.map((server) => this.killServer(server)));
    this.currentServer = null;
    this.retiredServers.clear();
  }

  private cleanupRetiredServers(): void {
    for (const server of Array.from(this.retiredServers)) {
      if (server.refCount === 0) {
        this.retiredServers.delete(server);
        void this.killServer(server);
      }
    }
  }

  private async killServer(server: OpenCodeServerGeneration): Promise<void> {
    if (server.process.killed) {
      return;
    }
    const result = await terminateWithTreeKill(server.process, {
      gracefulTimeoutMs: OPENCODE_SERVER_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
      forceTimeoutMs: OPENCODE_SERVER_FORCE_SHUTDOWN_TIMEOUT_MS,
      onForceSignal: () => {
        this.logger.warn(
          { timeoutMs: OPENCODE_SERVER_GRACEFUL_SHUTDOWN_TIMEOUT_MS },
          "OpenCode server did not exit after SIGTERM; sending SIGKILL",
        );
      },
    });
    if (result === "kill-timeout") {
      this.logger.warn(
        { timeoutMs: OPENCODE_SERVER_FORCE_SHUTDOWN_TIMEOUT_MS },
        "OpenCode server did not report exit after SIGKILL",
      );
    }
  }
}

async function resolveOpenCodeBinary(): Promise<string> {
  const found = await findExecutable("opencode");
  if (found) {
    return found;
  }
  throw new Error(
    "OpenCode binary not found. Install OpenCode (https://github.com/opencode-ai/opencode) and ensure it is available in your shell PATH.",
  );
}

function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address) {
          resolve(address.port);
        } else {
          reject(new Error("Failed to allocate port"));
        }
      });
    });
    server.on("error", reject);
  });
}
