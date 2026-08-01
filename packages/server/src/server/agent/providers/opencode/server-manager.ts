import type { ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { Logger } from "pino";

import { findExecutable } from "../../../../executable-resolution/executable-resolution.js";
import { awaitWithAbort } from "../../../../utils/abort.js";
import { spawnProcess, type SpawnProcessOptions } from "../../../../utils/spawn.js";
import { terminateWithTreeKill, type ProcessTerminator } from "../../../../utils/tree-kill.js";
import type { ManagedProcessRegistry } from "../../../managed-processes/managed-processes.js";
import {
  createProviderEnvSpec,
  resolveProviderCommandPrefix,
  type ProviderRuntimeSettings,
} from "../../provider-launch-config.js";
import { resolveOpenCodeHomeDir } from "./paths.js";

const OPENCODE_SERVER_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 5_000;
const OPENCODE_SERVER_FORCE_SHUTDOWN_TIMEOUT_MS = 1_000;

export interface OpenCodeServerAcquisition {
  server: { port: number; url: string };
  release: () => Promise<void>;
}

export interface OpenCodeServerManagerLike {
  acquireCurrent(options?: { signal?: AbortSignal }): Promise<OpenCodeServerAcquisition>;
  acquireNew(options?: { signal?: AbortSignal }): Promise<OpenCodeServerAcquisition>;
  acquireDedicated(env: Record<string, string>): Promise<OpenCodeServerAcquisition>;
  acquireExisting(url: string): OpenCodeServerAcquisition | null;
  shutdown(): Promise<void>;
}

export interface OpenCodeServerGeneration {
  process: ChildProcess;
  port: number;
  url: string;
  refCount: number;
  retired: boolean;
  ready: Promise<void>;
  managedProcessId?: string;
  managedProcessRecord?: Promise<{ id: string } | null>;
}

export type OpenCodePortAllocator = () => Promise<number>;
export type OpenCodeCommandPrefixResolver = () => Promise<{ command: string; args: string[] }>;
export type OpenCodeServerProcessSpawner = (
  command: string,
  args: string[],
  options: SpawnProcessOptions,
) => ChildProcess;

export interface OpenCodeServerManagerOptions {
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
  managedProcesses?: ManagedProcessRegistry;
  terminateProcess?: ProcessTerminator;
  portAllocator?: OpenCodePortAllocator;
  resolveCommandPrefix?: OpenCodeCommandPrefixResolver;
  resolveHomeDir?: () => string;
  spawnServerProcess?: OpenCodeServerProcessSpawner;
}

export class OpenCodeServerManager implements OpenCodeServerManagerLike {
  private static instance: OpenCodeServerManager | null = null;
  private static exitHandlerRegistered = false;
  private currentServer: OpenCodeServerGeneration | null = null;
  private retiredServers = new Set<OpenCodeServerGeneration>();
  private startPromise: Promise<OpenCodeServerGeneration> | null = null;
  private startController: AbortController | null = null;
  private readonly startWaiters = new WeakMap<Promise<OpenCodeServerGeneration>, number>();
  private newServerPromise: Promise<OpenCodeServerGeneration> | null = null;
  private newServerController: AbortController | null = null;
  private readonly newServerWaiters = new WeakMap<Promise<OpenCodeServerGeneration>, number>();
  private readonly dedicatedStartups = new Map<
    Promise<OpenCodeServerGeneration>,
    AbortController
  >();
  private readonly serverCleanupPromises = new WeakMap<OpenCodeServerGeneration, Promise<void>>();
  private shuttingDown = false;
  private readonly logger: Logger;
  private readonly runtimeSettings?: ProviderRuntimeSettings;
  private readonly runtimeSettingsKey: string;
  private readonly managedProcesses?: ManagedProcessRegistry;
  private readonly terminateProcess: ProcessTerminator;
  private readonly portAllocator: OpenCodePortAllocator;
  private readonly resolveCommandPrefix: OpenCodeCommandPrefixResolver;
  private readonly resolveHomeDir: () => string;
  private readonly spawnServerProcess: OpenCodeServerProcessSpawner;

  constructor(options: OpenCodeServerManagerOptions) {
    this.logger = options.logger;
    this.runtimeSettings = options.runtimeSettings;
    this.runtimeSettingsKey = JSON.stringify(this.runtimeSettings ?? {});
    this.managedProcesses = options.managedProcesses;
    this.terminateProcess = options.terminateProcess ?? terminateWithTreeKill;
    this.portAllocator = options.portAllocator ?? findAvailablePort;
    this.resolveCommandPrefix =
      options.resolveCommandPrefix ??
      (() => resolveProviderCommandPrefix(this.runtimeSettings?.command, resolveOpenCodeBinary));
    this.resolveHomeDir = options.resolveHomeDir ?? resolveOpenCodeHomeDir;
    this.spawnServerProcess = options.spawnServerProcess ?? spawnProcess;
  }

  static getInstance(
    logger: Logger,
    runtimeSettings?: ProviderRuntimeSettings,
    options: Omit<OpenCodeServerManagerOptions, "logger" | "runtimeSettings"> = {},
  ): OpenCodeServerManager {
    const nextSettingsKey = JSON.stringify(runtimeSettings ?? {});
    if (!OpenCodeServerManager.instance) {
      OpenCodeServerManager.instance = new OpenCodeServerManager({
        logger,
        runtimeSettings,
        ...options,
      });
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

  async acquireCurrent(options: { signal?: AbortSignal } = {}): Promise<OpenCodeServerAcquisition> {
    this.assertRunning();
    const server = await this.getCurrentServer(options.signal);
    return this.acquireReadyServer(server, options.signal);
  }

  async acquireNew(options: { signal?: AbortSignal } = {}): Promise<OpenCodeServerAcquisition> {
    this.assertRunning();
    const server = await this.getNewServer(options.signal);
    return this.acquireReadyServer(server, options.signal);
  }

  async acquireDedicated(env: Record<string, string>): Promise<OpenCodeServerAcquisition> {
    this.assertRunning();
    const controller = new AbortController();
    const startup = this.startServer(env, controller.signal);
    this.dedicatedStartups.set(startup, controller);
    try {
      const server = await startup;
      server.retired = true;
      this.retiredServers.add(server);
      const acquisition = this.acquireServer(server);
      try {
        await server.ready;
        return acquisition;
      } catch (error) {
        try {
          await acquisition.release();
        } catch (cleanupError) {
          this.logger.warn(
            { err: cleanupError },
            "Failed to release OpenCode server after acquisition failure",
          );
        }
        throw error;
      }
    } finally {
      this.dedicatedStartups.delete(startup);
    }
  }

  acquireExisting(url: string): OpenCodeServerAcquisition | null {
    if (this.shuttingDown) {
      return null;
    }
    const server = this.findLiveServerByUrl(url);
    return server ? this.acquireServer(server) : null;
  }

  private findLiveServerByUrl(url: string): OpenCodeServerGeneration | null {
    const servers = [
      ...(this.currentServer ? [this.currentServer] : []),
      ...Array.from(this.retiredServers),
    ];
    return servers.find((server) => server.url === url && this.isServerLive(server)) ?? null;
  }

  private isServerLive(server: OpenCodeServerGeneration): boolean {
    return (
      !server.process.killed &&
      server.process.exitCode === null &&
      server.process.signalCode === null
    );
  }

  private acquireServer(server: OpenCodeServerGeneration): OpenCodeServerAcquisition {
    server.refCount += 1;
    let releasePromise: Promise<void> | null = null;
    return {
      server: { port: server.port, url: server.url },
      release: async () => {
        if (releasePromise) {
          return releasePromise;
        }
        releasePromise = this.releaseServer(server);
        return releasePromise;
      },
    };
  }

  private async acquireReadyServer(
    server: OpenCodeServerGeneration,
    signal?: AbortSignal,
  ): Promise<OpenCodeServerAcquisition> {
    const acquisition = this.acquireServer(server);
    try {
      await awaitWithAbort(server.ready, signal);
      return acquisition;
    } catch (error) {
      void server.ready.catch(() => undefined);
      if (signal?.aborted && server.refCount === 1) {
        server.retired = true;
        if (this.currentServer === server) {
          this.currentServer = null;
        }
        this.retiredServers.add(server);
      }
      try {
        await acquisition.release();
      } catch (cleanupError) {
        this.logger.warn(
          { err: cleanupError },
          "Failed to release OpenCode server after acquisition failure",
        );
      }
      throw error;
    }
  }

  private async releaseServer(server: OpenCodeServerGeneration): Promise<void> {
    server.refCount = Math.max(0, server.refCount - 1);
    if (server.refCount > 0) {
      return;
    }

    if (this.currentServer === server) {
      this.currentServer = null;
      server.retired = true;
    }
    if (!server.retired) {
      return;
    }

    this.retiredServers.delete(server);
    await this.killServer(server);
  }

  private async getNewServer(signal?: AbortSignal): Promise<OpenCodeServerGeneration> {
    this.assertRunning();
    signal?.throwIfAborted();
    if (this.newServerPromise && !this.newServerController?.signal.aborted) {
      const server = await this.waitForNewServer(this.newServerPromise, signal);
      if (!server.retired) {
        return server;
      }
      return await this.getNewServer(signal);
    }

    const controller = new AbortController();
    this.newServerController = controller;
    const startup = Promise.resolve()
      .then(async () => {
        await this.rotateCurrentServer(controller.signal);
        const server = await this.startServer(undefined, controller.signal);
        if (!server.retired) {
          this.currentServer = server;
        }
        return server;
      })
      .finally(() => {
        if (this.newServerPromise === startup) {
          this.newServerPromise = null;
          this.newServerController = null;
        }
      });
    this.newServerPromise = startup;
    const server = await this.waitForNewServer(startup, signal);
    return server.retired ? await this.getNewServer(signal) : server;
  }

  private async getCurrentServer(signal?: AbortSignal): Promise<OpenCodeServerGeneration> {
    this.assertRunning();
    signal?.throwIfAborted();
    if (this.newServerPromise && !this.newServerController?.signal.aborted) {
      const server = await this.waitForNewServer(this.newServerPromise, signal);
      if (!server.retired) {
        return server;
      }
      return await this.getCurrentServer(signal);
    }

    if (this.startPromise && !this.startController?.signal.aborted) {
      const server = await this.waitForCurrentServer(this.startPromise, signal);
      if (!server.retired) {
        return server;
      }
      return await this.getCurrentServer(signal);
    }

    if (this.currentServer && !this.currentServer.retired && !this.currentServer.process.killed) {
      return this.currentServer;
    }

    const controller = new AbortController();
    this.startController = controller;
    const startup = this.startServer(undefined, controller.signal).then((server) => {
      if (!server.retired) {
        this.currentServer = server;
      }
      return server;
    });
    this.startPromise = startup;
    void startup.then(
      () => {
        if (this.startPromise === startup) {
          this.startPromise = null;
          this.startController = null;
        }
        return undefined;
      },
      () => {
        if (this.startPromise === startup) {
          this.startPromise = null;
          this.startController = null;
        }
        return undefined;
      },
    );
    const server = await this.waitForCurrentServer(startup, signal);
    return server.retired ? await this.getCurrentServer(signal) : server;
  }

  private async waitForCurrentServer(
    startup: Promise<OpenCodeServerGeneration>,
    signal?: AbortSignal,
  ): Promise<OpenCodeServerGeneration> {
    this.startWaiters.set(startup, (this.startWaiters.get(startup) ?? 0) + 1);
    try {
      return await awaitWithAbort(startup, signal);
    } finally {
      const remaining = (this.startWaiters.get(startup) ?? 1) - 1;
      if (remaining > 0) {
        this.startWaiters.set(startup, remaining);
      } else {
        this.startWaiters.delete(startup);
      }
      if (remaining === 0 && this.startPromise === startup) {
        this.startController?.abort(
          signal?.reason ?? new Error("OpenCode server startup abandoned"),
        );
      }
    }
  }

  private async waitForNewServer(
    startup: Promise<OpenCodeServerGeneration>,
    signal?: AbortSignal,
  ): Promise<OpenCodeServerGeneration> {
    this.newServerWaiters.set(startup, (this.newServerWaiters.get(startup) ?? 0) + 1);
    try {
      return await awaitWithAbort(startup, signal);
    } finally {
      const remaining = (this.newServerWaiters.get(startup) ?? 1) - 1;
      if (remaining > 0) {
        this.newServerWaiters.set(startup, remaining);
      } else {
        this.newServerWaiters.delete(startup);
      }
      if (remaining === 0 && this.newServerPromise === startup) {
        this.newServerController?.abort(
          signal?.reason ?? new Error("OpenCode server rotation abandoned"),
        );
      }
    }
  }

  private async rotateCurrentServer(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const existing = this.currentServer;
    const pendingStartup = this.startPromise;
    if (existing) {
      existing.retired = true;
      this.retiredServers.add(existing);
      this.currentServer = null;
      await this.cleanupRetiredServers();
      signal?.throwIfAborted();
    }
    if (pendingStartup) {
      const pending = await this.waitForCurrentServer(pendingStartup, signal);
      signal?.throwIfAborted();
      pending.retired = true;
      this.retiredServers.add(pending);
      this.currentServer = null;
      await this.cleanupRetiredServers();
      signal?.throwIfAborted();
    }
  }

  private async startServer(
    launchEnv?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<OpenCodeServerGeneration> {
    signal?.throwIfAborted();
    const port = await awaitWithAbort(this.portAllocator(), signal);
    const url = `http://127.0.0.1:${port}`;
    const launchPrefix = await awaitWithAbort(this.resolveCommandPrefix(), signal);
    signal?.throwIfAborted();
    const serverArgs = [...launchPrefix.args, "serve", "--port", String(port)];
    // Use a neutral OpenCode home as the server cwd. Launching from the user's
    // home directory causes OpenCode to treat it as the default workspace and
    // index the entire home tree.
    const serverCwd = this.resolveHomeDir();
    mkdirSync(serverCwd, { recursive: true });

    const serverProcess = this.spawnServerProcess(launchPrefix.command, serverArgs, {
      cwd: serverCwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      ...createProviderEnvSpec({
        runtimeSettings: this.runtimeSettings,
        overlays: [launchEnv],
      }),
    });
    const managedProcessRecord = this.recordManagedServerProcess({
      process: serverProcess,
      command: launchPrefix.command,
      args: serverArgs,
      port,
    });
    const server: OpenCodeServerGeneration = {
      process: serverProcess,
      port,
      url,
      refCount: 0,
      retired: false,
      ready: Promise.resolve(),
      managedProcessRecord,
    };
    void managedProcessRecord.then((record) => {
      if (record && server.managedProcessRecord === managedProcessRecord) {
        server.managedProcessId = record.id;
      }
      return undefined;
    });

    let started = false;
    let settled = false;
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

    const ready = new Promise<void>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout>;
      const failStartup = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };
      timeout = setTimeout(() => {
        if (!started) {
          failStartup(new Error(buildStartupErrorMessage("OpenCode server startup timeout")));
        }
      }, 30_000);

      serverProcess.stdout?.on("data", (data: Buffer) => {
        const output = data.toString();
        stdoutBuffer = appendCapped(stdoutBuffer, output);
        if (output.includes("listening on") && !settled) {
          started = true;
          settled = true;
          clearTimeout(timeout);
          resolve();
        }
      });

      serverProcess.stderr?.on("data", (data: Buffer) => {
        const output = data.toString();
        stderrBuffer = appendCapped(stderrBuffer, output);
        this.logger.error({ stderr: output.trim() }, "OpenCode server stderr");
      });

      serverProcess.on("error", (error) => {
        const headline = error instanceof Error ? error.message : String(error);
        failStartup(new Error(buildStartupErrorMessage(headline)));
      });

      serverProcess.on("exit", (code) => {
        this.removeManagedServerRecord(server);
        if (!started) {
          failStartup(
            new Error(buildStartupErrorMessage(`OpenCode server exited with code ${code}`)),
          );
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

    server.ready = ready.catch(async (error) => {
      await this.killServer(server);
      if (this.currentServer === server) {
        this.currentServer = null;
      }
      this.retiredServers.delete(server);
      throw error;
    });

    if (signal) {
      const abortStartedServer = () => {
        server.retired = true;
        this.retiredServers.add(server);
        void server.ready.catch(() => undefined);
        void this.killServer(server).catch((error) => {
          this.logger.warn({ err: error }, "Failed to stop abandoned OpenCode server startup");
        });
      };
      signal.addEventListener("abort", abortStartedServer, { once: true });
      void server.ready.then(
        () => {
          signal.removeEventListener("abort", abortStartedServer);
          return undefined;
        },
        () => {
          signal.removeEventListener("abort", abortStartedServer);
          return undefined;
        },
      );
      if (signal.aborted) {
        abortStartedServer();
      }
    }

    return server;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const dedicatedStartups = Array.from(this.dedicatedStartups.entries());
    const startups = [
      ...[this.startPromise, this.newServerPromise].filter(
        (startup): startup is Promise<OpenCodeServerGeneration> => startup !== null,
      ),
      ...dedicatedStartups.map(([startup]) => startup),
    ];
    const shutdownReason = new Error("OpenCode server manager shutting down");
    this.startController?.abort(shutdownReason);
    this.newServerController?.abort(shutdownReason);
    for (const [, controller] of dedicatedStartups) {
      controller.abort(shutdownReason);
    }
    const startupResults = await Promise.allSettled(startups);
    const servers = new Set([
      ...(this.currentServer ? [this.currentServer] : []),
      ...Array.from(this.retiredServers),
      ...startupResults.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])),
    ]);
    await Promise.all(Array.from(servers, (server) => this.killServer(server)));
    this.currentServer = null;
    this.retiredServers.clear();
  }

  private async cleanupRetiredServers(): Promise<void> {
    const cleanup: Promise<void>[] = [];
    for (const server of Array.from(this.retiredServers)) {
      if (server.refCount === 0) {
        this.retiredServers.delete(server);
        cleanup.push(this.killServer(server));
      }
    }
    await Promise.all(cleanup);
  }

  private killServer(server: OpenCodeServerGeneration): Promise<void> {
    const existingCleanup = this.serverCleanupPromises.get(server);
    if (existingCleanup) {
      return existingCleanup;
    }
    const cleanup = this.killServerOnce(server).catch((error) => {
      if (this.serverCleanupPromises.get(server) === cleanup) {
        this.serverCleanupPromises.delete(server);
      }
      server.retired = true;
      this.retiredServers.add(server);
      throw error;
    });
    this.serverCleanupPromises.set(server, cleanup);
    return cleanup;
  }

  private assertRunning(): void {
    if (this.shuttingDown) {
      throw new Error("OpenCode server manager shutting down");
    }
  }

  private async killServerOnce(server: OpenCodeServerGeneration): Promise<void> {
    if (
      (server.process.exitCode !== null && server.process.exitCode !== undefined) ||
      (server.process.signalCode !== null && server.process.signalCode !== undefined)
    ) {
      return;
    }
    const result = await this.terminateProcess(server.process, {
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
      throw new Error("OpenCode server did not exit after SIGKILL");
    }
    if (server.managedProcessId) {
      await this.removeManagedProcessId(server.managedProcessId);
      server.managedProcessId = undefined;
      server.managedProcessRecord = undefined;
    } else {
      this.removeManagedServerRecord(server);
    }
  }

  private async recordManagedServerProcess(options: {
    process: ChildProcess;
    command: string;
    args: string[];
    port: number;
  }): Promise<{ id: string } | null> {
    const pid = options.process.pid;
    if (!this.managedProcesses || typeof pid !== "number" || pid <= 0) {
      return null;
    }

    try {
      return await this.managedProcesses.record({
        owner: { provider: "opencode", kind: "helper-server" },
        pid,
        command: options.command,
        args: options.args,
        metadata: { port: options.port },
      });
    } catch (error) {
      this.logger.warn(
        { err: error, pid, port: options.port },
        "Failed to record OpenCode helper process",
      );
      return null;
    }
  }

  private removeManagedProcessRecordWhenResolved(record: Promise<{ id: string } | null>): void {
    void record.then((resolved) => {
      if (resolved) {
        return this.removeManagedProcessId(resolved.id);
      }
      return undefined;
    });
  }

  private removeManagedServerRecord(server: OpenCodeServerGeneration): void {
    const record = server.managedProcessRecord;
    server.managedProcessRecord = undefined;
    if (server.managedProcessId) {
      void this.removeManagedProcessId(server.managedProcessId);
      server.managedProcessId = undefined;
      return;
    }
    if (record) {
      this.removeManagedProcessRecordWhenResolved(record);
    }
  }

  private async removeManagedProcessId(id: string): Promise<void> {
    try {
      await this.managedProcesses?.remove(id);
    } catch (error) {
      this.logger.warn({ err: error, id }, "Failed to remove OpenCode helper process record");
    }
  }
}

async function resolveOpenCodeBinary(): Promise<string> {
  const found = await findExecutable("opencode");
  if (!found) {
    throw new Error(
      "OpenCode binary not found. Install OpenCode (https://github.com/opencode-ai/opencode) and ensure it is available in your shell PATH.",
    );
  }

  if (process.platform === "win32" && path.extname(found).toLowerCase() === ".cmd") {
    // Global npm: <prefix>/opencode.cmd → <prefix>/node_modules/opencode-ai/bin/opencode.exe
    const globalCandidate = path.join(
      path.dirname(found),
      "node_modules",
      "opencode-ai",
      "bin",
      "opencode.exe",
    );
    if (await pathExists(globalCandidate)) return globalCandidate;

    // Local/pnpm: <project>/node_modules/.bin/opencode.cmd → <project>/node_modules/opencode-ai/bin/opencode.exe
    const localCandidate = path.join(
      path.dirname(found),
      "..",
      "opencode-ai",
      "bin",
      "opencode.exe",
    );
    if (await pathExists(localCandidate)) return localCandidate;

    console.warn(
      "[opencode-server] Found opencode.cmd but could not resolve the real opencode.exe. " +
        "The process may not be properly terminated on exit. Path: %s",
      found,
    );
  }

  return found;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
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
