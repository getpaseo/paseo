import type { ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { Logger } from "pino";

import { findExecutable } from "../../../../executable-resolution/executable-resolution.js";
import { spawnProcess, type SpawnProcessOptions } from "../../../../utils/spawn.js";
import { terminateWithTreeKill, type ProcessTerminator } from "../../../../utils/tree-kill.js";
import type { ManagedProcessRegistry } from "../../../managed-processes/managed-processes.js";
import {
  createProviderEnvSpec,
  resolveProviderCommandPrefix,
  type ProviderRuntimeSettings,
} from "../../provider-launch-config.js";
import { resolveOpenCodeHomeDir } from "./paths.js";
import {
  OpenCodeEventConsumer,
  type OpenCodeEventConsumerFactory,
  type OpenCodeEventSource,
} from "./event-consumer.js";

/** Budget for the OpenCode HTTP server to become usable after spawn. */
export const OPENCODE_SERVER_STARTUP_TIMEOUT_MS = 30_000;
/** One stalled SSE attempt plus enough time for the consumer's retry. */
export const OPENCODE_EVENT_STREAM_READY_TIMEOUT_MS = 45_000;
const OPENCODE_SERVER_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 5_000;
const OPENCODE_SERVER_FORCE_SHUTDOWN_TIMEOUT_MS = 1_000;

export interface OpenCodeServerAcquisition {
  server: { port: number; url: string; catalogVersion?: number };
  events: OpenCodeEventSource;
  release: () => Promise<void>;
}

export interface OpenCodeServerManagerLike {
  acquireCurrent(signal?: AbortSignal): Promise<OpenCodeServerAcquisition>;
  acquireNew(signal?: AbortSignal): Promise<OpenCodeServerAcquisition>;
  acquireDedicated(env: Record<string, string>): Promise<OpenCodeServerAcquisition>;
  acquireExisting(url: string): OpenCodeServerAcquisition | null;
  /** Retire the shared server so the next acquisition loads the current plugin catalog. */
  refreshPluginCatalog?(catalogVersion?: number): Promise<void>;
  shutdown(): Promise<void>;
}

export interface OpenCodeServerGeneration {
  process: ChildProcess;
  port: number;
  url: string;
  refCount: number;
  retired: boolean;
  /** A catalog-retired generation cannot be reacquired by a resumed child session. */
  catalogRetired?: boolean;
  catalogVersion?: number;
  ready: Promise<void>;
  events: OpenCodeEventConsumer;
  managedProcessId?: string;
  managedProcessRecord?: Promise<{ id: string } | null>;
}

type OpenCodeManagerLifecycleState = "open" | "closing" | "closed";

export type OpenCodePortAllocator = () => Promise<number>;
export type OpenCodeCommandPrefixResolver = () => Promise<{ command: string; args: string[] }>;
export type OpenCodeServerProcessSpawner = (
  command: string,
  args: string[],
  options: SpawnProcessOptions,
) => ChildProcess;

export interface OpenCodeServerManagerOptions {
  logger: Logger;
  baseEnv?: SpawnProcessOptions["baseEnv"];
  runtimeSettings?: ProviderRuntimeSettings;
  managedProcesses?: ManagedProcessRegistry;
  terminateProcess?: ProcessTerminator;
  portAllocator?: OpenCodePortAllocator;
  resolveCommandPrefix?: OpenCodeCommandPrefixResolver;
  resolveHomeDir?: () => string;
  spawnServerProcess?: OpenCodeServerProcessSpawner;
  createEventSource?: OpenCodeEventConsumerFactory;
  decorateServerEnv?: (env: Record<string, string>) => Record<string, string>;
  getCatalogVersion?: () => number;
}

export class OpenCodeServerManager implements OpenCodeServerManagerLike {
  private static instance: OpenCodeServerManager | null = null;
  private static exitHandlerRegistered = false;
  private currentServer: OpenCodeServerGeneration | null = null;
  private retiredServers = new Set<OpenCodeServerGeneration>();
  private readonly servers = new Set<OpenCodeServerGeneration>();
  private startPromise: Promise<OpenCodeServerGeneration> | null = null;
  private newServerPromise: Promise<OpenCodeServerGeneration> | null = null;
  private catalogRefreshPromise: Promise<void> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private lifecycleState: OpenCodeManagerLifecycleState = "open";
  private readonly lifecycleMutex = new AsyncMutex();
  private readonly serverKillPromises = new WeakMap<OpenCodeServerGeneration, Promise<void>>();
  private readonly logger: Logger;
  private readonly baseEnv?: SpawnProcessOptions["baseEnv"];
  private readonly runtimeSettings?: ProviderRuntimeSettings;
  private readonly runtimeSettingsKey: string;
  private readonly managedProcesses?: ManagedProcessRegistry;
  private readonly terminateProcess: ProcessTerminator;
  private readonly portAllocator: OpenCodePortAllocator;
  private readonly resolveCommandPrefix: OpenCodeCommandPrefixResolver;
  private readonly resolveHomeDir: () => string;
  private readonly spawnServerProcess: OpenCodeServerProcessSpawner;
  private readonly createEventSource: OpenCodeEventConsumerFactory;
  private readonly decorateServerEnv?: (env: Record<string, string>) => Record<string, string>;
  private readonly getCatalogVersion?: () => number;

  constructor(options: OpenCodeServerManagerOptions) {
    this.logger = options.logger;
    this.baseEnv = options.baseEnv;
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
    this.createEventSource =
      options.createEventSource ?? ((input) => new OpenCodeEventConsumer(input));
    this.decorateServerEnv = options.decorateServerEnv;
    this.getCatalogVersion = options.getCatalogVersion;
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

  async acquireCurrent(signal?: AbortSignal): Promise<OpenCodeServerAcquisition> {
    for (;;) {
      this.assertLifecycleOpen();
      signal?.throwIfAborted();
      const server = await waitForServerAcquisition(this.getCurrentServer(), signal);
      this.assertLifecycleOpen();
      signal?.throwIfAborted();
      if (server.catalogRetired) continue;
      return this.acquireServer(server);
    }
  }

  async acquireNew(signal?: AbortSignal): Promise<OpenCodeServerAcquisition> {
    for (;;) {
      this.assertLifecycleOpen();
      signal?.throwIfAborted();
      const server = await waitForServerAcquisition(this.getNewServer(), signal);
      this.assertLifecycleOpen();
      signal?.throwIfAborted();
      if (server.catalogRetired) {
        const current = await waitForServerAcquisition(this.getCurrentServer(), signal);
        this.assertLifecycleOpen();
        signal?.throwIfAborted();
        if (!current.catalogRetired) return this.acquireServer(current);
        continue;
      }
      return this.acquireServer(server);
    }
  }

  async acquireDedicated(env: Record<string, string>): Promise<OpenCodeServerAcquisition> {
    this.assertLifecycleOpen();
    const server = await this.startServer(env);
    this.assertLifecycleOpen();
    server.retired = true;
    this.retiredServers.add(server);
    const acquisition = this.acquireServer(server);
    try {
      await server.ready;
      return acquisition;
    } catch (error) {
      await acquisition.release();
      throw error;
    }
  }

  acquireExisting(url: string): OpenCodeServerAcquisition | null {
    if (this.lifecycleState !== "open") return null;
    const server = this.findLiveServerByUrl(url);
    return server ? this.acquireServer(server) : null;
  }

  async refreshPluginCatalog(catalogVersion?: number): Promise<void> {
    if (this.catalogRefreshPromise) return this.catalogRefreshPromise;
    if (this.lifecycleState !== "open") return;

    const refresh = this.lifecycleMutex.runExclusive(async () => {
      if (this.lifecycleState !== "open") return;
      try {
        await this.rotateCurrentServer();
        if (this.lifecycleState !== "open") return;
        const server = await this.startServer(undefined, catalogVersion);
        if (this.lifecycleState !== "open") {
          this.retireServer(server);
          await this.cleanupRetiredServers();
          return;
        }
        this.currentServer = server;
        await server.ready;
      } catch (error) {
        if (this.lifecycleState !== "open") return;
        throw error;
      }
    });
    let trackedRefresh!: Promise<void>;
    trackedRefresh = refresh.finally(() => {
      if (this.catalogRefreshPromise === trackedRefresh) {
        this.catalogRefreshPromise = null;
      }
    });
    this.catalogRefreshPromise = trackedRefresh;
    return trackedRefresh;
  }

  private findLiveServerByUrl(url: string): OpenCodeServerGeneration | null {
    const servers = [
      ...(this.currentServer ? [this.currentServer] : []),
      ...Array.from(this.retiredServers),
    ];
    return (
      servers.find(
        (server) => server.url === url && !server.catalogRetired && this.isServerLive(server),
      ) ?? null
    );
  }

  private isServerLive(server: OpenCodeServerGeneration): boolean {
    return (
      !server.process.killed &&
      server.process.exitCode === null &&
      server.process.signalCode === null
    );
  }

  private acquireServer(server: OpenCodeServerGeneration): OpenCodeServerAcquisition {
    if (server.catalogRetired) {
      throw new Error(`OpenCode server generation is retired: ${server.url}`);
    }
    server.refCount += 1;
    let releasePromise: Promise<void> | null = null;
    return {
      server: {
        port: server.port,
        url: server.url,
        ...(server.catalogVersion !== undefined ? { catalogVersion: server.catalogVersion } : {}),
      },
      events: server.events,
      release: async () => {
        if (releasePromise) {
          return releasePromise;
        }
        releasePromise = this.releaseServer(server);
        return releasePromise;
      },
    };
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
    this.logger.info(generationLogContext(server), "OpenCode server generation released");
    await this.killServer(server);
  }

  private async getNewServer(): Promise<OpenCodeServerGeneration> {
    this.assertLifecycleOpen();
    if (this.catalogRefreshPromise)
      return this.catalogRefreshPromise.then(() => this.getCurrentServer());
    if (this.newServerPromise) {
      return this.newServerPromise;
    }

    this.newServerPromise = Promise.resolve()
      .then(async () => {
        await this.rotateCurrentServer(false);
        const server = await this.startServer();
        if (!server.retired && this.lifecycleState === "open") {
          this.currentServer = server;
        } else if (!server.retired) {
          this.retireServer(server);
        }
        await server.ready;
        return server;
      })
      .finally(() => {
        this.newServerPromise = null;
      });
    return this.newServerPromise;
  }

  private async getCurrentServer(): Promise<OpenCodeServerGeneration> {
    this.assertLifecycleOpen();
    if (this.catalogRefreshPromise)
      return this.catalogRefreshPromise.then(() => this.getCurrentServer());
    if (this.newServerPromise) {
      return this.newServerPromise;
    }

    if (this.startPromise) {
      const server = await this.startPromise;
      await server.ready;
      return server;
    }

    if (this.currentServer && !this.currentServer.process.killed) {
      await this.currentServer.ready;
      return this.currentServer;
    }

    this.startPromise = this.startServer().then((server) => {
      if (!server.retired && this.lifecycleState === "open") {
        this.currentServer = server;
      } else if (!server.retired) {
        this.retireServer(server);
      }
      return server;
    });
    const currentStart = this.startPromise;
    const result = await currentStart.finally(() => {
      if (this.startPromise === currentStart) {
        this.startPromise = null;
      }
    });
    await result.ready;
    return result;
  }

  private async rotateCurrentServer(awaitNewServer = true): Promise<void> {
    if (awaitNewServer && this.newServerPromise) {
      const pendingNew = this.newServerPromise;
      const server = await pendingNew;
      this.retireServer(server);
    }
    const existing = this.currentServer;
    if (existing) {
      this.retireServer(existing);
    }
    if (this.startPromise) {
      const pending = await this.startPromise;
      this.retireServer(pending);
    }
    await this.cleanupRetiredServers();
  }

  private retireServer(server: OpenCodeServerGeneration): void {
    server.retired = true;
    server.catalogRetired = true;
    this.retiredServers.add(server);
    if (this.currentServer === server) this.currentServer = null;
    this.logger.info(generationLogContext(server), "OpenCode server generation retired");
  }

  private async startServer(
    launchEnv?: Record<string, string>,
    catalogVersion?: number,
  ): Promise<OpenCodeServerGeneration> {
    this.assertLifecycleOpen();
    const loadedCatalogVersion = catalogVersion ?? this.getCatalogVersion?.();
    const port = await this.portAllocator();
    this.assertLifecycleOpen();
    const url = `http://127.0.0.1:${port}`;
    const launchPrefix = await this.resolveCommandPrefix();
    this.assertLifecycleOpen();
    const serverArgs = [...launchPrefix.args, "serve", "--port", String(port)];
    // Use a neutral OpenCode home as the server cwd. Launching from the user's
    // home directory causes OpenCode to treat it as the default workspace and
    // index the entire home tree.
    const serverCwd = this.resolveHomeDir();
    mkdirSync(serverCwd, { recursive: true });

    const existingConfigContent =
      launchEnv?.OPENCODE_CONFIG_CONTENT ??
      this.runtimeSettings?.env?.OPENCODE_CONFIG_CONTENT ??
      (typeof this.baseEnv?.OPENCODE_CONFIG_CONTENT === "string"
        ? this.baseEnv.OPENCODE_CONFIG_CONTENT
        : process.env.OPENCODE_CONFIG_CONTENT);
    const bridgeEnv = this.decorateServerEnv?.(
      existingConfigContent ? { OPENCODE_CONFIG_CONTENT: existingConfigContent } : {},
    );
    const serverProcess = this.spawnServerProcess(launchPrefix.command, serverArgs, {
      cwd: serverCwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      ...createProviderEnvSpec({
        baseEnv: this.baseEnv,
        runtimeSettings: this.runtimeSettings,
        overlays: [launchEnv, bridgeEnv],
      }),
    });
    const managedProcessRecord = this.recordManagedServerProcess({
      process: serverProcess,
      command: launchPrefix.command,
      args: serverArgs,
      port,
    });
    let resolveProcessExit!: (error: Error) => void;
    const processExit = new Promise<Error>((resolve) => {
      resolveProcessExit = resolve;
    });
    const server: OpenCodeServerGeneration = {
      process: serverProcess,
      port,
      url,
      refCount: 0,
      retired: false,
      catalogVersion: loadedCatalogVersion,
      ready: Promise.resolve(),
      events: this.createEventSource({ serverUrl: url, processExit, logger: this.logger }),
      managedProcessRecord,
    };
    this.servers.add(server);
    this.logger.info(
      { ...generationLogContext(server), dedicated: launchEnv !== undefined },
      "OpenCode server generation started",
    );
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
      }, OPENCODE_SERVER_STARTUP_TIMEOUT_MS);

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

      serverProcess.on("exit", (code, signal) => {
        this.logger.info(
          { ...generationLogContext(server), code, signal },
          "OpenCode server generation exited",
        );
        resolveProcessExit(new Error(`OpenCode server exited with code ${code}`));
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

    return server;
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    if (this.lifecycleState === "closed") return;

    // Set this before taking the mutex. A refresh that is queued but has not started
    // must observe closing and skip its spawn; an active refresh is awaited by the
    // mutex before shutdown snapshots the complete server set.
    this.lifecycleState = "closing";
    const shutdown = this.lifecycleMutex.runExclusive(async () => {
      const servers = [
        ...(this.currentServer ? [this.currentServer] : []),
        ...Array.from(this.retiredServers),
        ...Array.from(this.servers).filter(
          (server) => server !== this.currentServer && !this.retiredServers.has(server),
        ),
      ];
      for (const server of servers) {
        this.logger.info(generationLogContext(server), "OpenCode server generation stopping");
      }
      await Promise.all(servers.map((server) => this.killServer(server)));
      this.currentServer = null;
      this.retiredServers.clear();
      this.servers.clear();
      this.lifecycleState = "closed";
    });
    this.shutdownPromise = shutdown;
    return shutdown;
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
    const existing = this.serverKillPromises.get(server);
    if (existing) return existing;
    const kill = this.killServerInternal(server);
    this.serverKillPromises.set(server, kill);
    return kill;
  }

  private async killServerInternal(server: OpenCodeServerGeneration): Promise<void> {
    try {
      await server.events.close();
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
      }
      if (server.managedProcessId) {
        await this.removeManagedProcessId(server.managedProcessId);
        server.managedProcessId = undefined;
        server.managedProcessRecord = undefined;
      } else {
        this.removeManagedServerRecord(server);
      }
    } finally {
      this.servers.delete(server);
    }
  }

  private assertLifecycleOpen(): void {
    if (this.lifecycleState !== "open") {
      throw new Error(`OpenCode server manager is ${this.lifecycleState}`);
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

function generationLogContext(server: OpenCodeServerGeneration): Record<string, unknown> {
  return {
    pid: server.process.pid,
    port: server.port,
    url: server.url,
    refCount: server.refCount,
    retired: server.retired,
  };
}

async function waitForServerAcquisition<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return await operation;
  let handleAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    handleAbort = () => reject(signal.reason);
    signal.addEventListener("abort", handleAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (handleAbort) signal.removeEventListener("abort", handleAbort);
  }
}

class AsyncMutex {
  private tail = Promise.resolve();

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
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
