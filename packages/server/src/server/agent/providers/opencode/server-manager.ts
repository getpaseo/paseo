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

const OPENCODE_SERVER_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 5_000;
const OPENCODE_SERVER_FORCE_SHUTDOWN_TIMEOUT_MS = 1_000;

export interface OpenCodeServerAcquisition {
  server: { port: number; url: string };
  release: () => Promise<void>;
}

export interface OpenCodeServerManagerLike {
  acquireCurrent(signal?: AbortSignal): Promise<OpenCodeServerAcquisition>;
  acquireNew(signal?: AbortSignal): Promise<OpenCodeServerAcquisition>;
  acquireDedicated(
    env: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<OpenCodeServerAcquisition>;
  acquireExisting(url: string): OpenCodeServerAcquisition | null;
  shutdown(): Promise<void>;
}

export interface OpenCodeServerManagerLease {
  manager: OpenCodeServerManager;
  release: () => Promise<void>;
}

interface SharedOpenCodeServerManager {
  manager: OpenCodeServerManager;
  ownerCount: number;
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
  terminationPromise?: Promise<void>;
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
  baseEnv?: SpawnProcessOptions["baseEnv"];
  runtimeSettings?: ProviderRuntimeSettings;
  managedProcesses?: ManagedProcessRegistry;
  terminateProcess?: ProcessTerminator;
  portAllocator?: OpenCodePortAllocator;
  resolveCommandPrefix?: OpenCodeCommandPrefixResolver;
  resolveHomeDir?: () => string;
  spawnServerProcess?: OpenCodeServerProcessSpawner;
}

export class OpenCodeServerManager implements OpenCodeServerManagerLike {
  private static readonly instances = new Map<string, SharedOpenCodeServerManager>();
  private static readonly retiringManagers = new Set<OpenCodeServerManager>();
  private static exitHandlerRegistered = false;
  private currentServer: OpenCodeServerGeneration | null = null;
  private retiredServers = new Set<OpenCodeServerGeneration>();
  private startingServers = new Set<OpenCodeServerGeneration>();
  private terminatingServers = new Set<OpenCodeServerGeneration>();
  private startPromise: Promise<OpenCodeServerGeneration> | null = null;
  private newServerPromise: Promise<OpenCodeServerGeneration> | null = null;
  private lifecycleGeneration = 0;
  private shutDown = false;
  private retainedForSignalCleanup = false;
  private retirementPromise: Promise<void> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private readonly shutdownController = new AbortController();
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
  }

  static getInstance(
    logger: Logger,
    runtimeSettings?: ProviderRuntimeSettings,
    options: Omit<OpenCodeServerManagerOptions, "logger" | "runtimeSettings"> = {},
  ): OpenCodeServerManager {
    const settingsKey = JSON.stringify(runtimeSettings ?? {});
    const existing = OpenCodeServerManager.instances.get(settingsKey);
    if (existing) {
      return existing.manager;
    }
    const manager = new OpenCodeServerManager({
      logger,
      runtimeSettings,
      ...options,
    });
    OpenCodeServerManager.instances.set(settingsKey, { manager, ownerCount: 0 });
    OpenCodeServerManager.registerExitHandler();
    return manager;
  }

  static acquireShared(
    logger: Logger,
    runtimeSettings?: ProviderRuntimeSettings,
    options: Omit<OpenCodeServerManagerOptions, "logger" | "runtimeSettings"> = {},
  ): OpenCodeServerManagerLease {
    const settingsKey = JSON.stringify(runtimeSettings ?? {});
    const manager = OpenCodeServerManager.getInstance(logger, runtimeSettings, options);
    const shared = OpenCodeServerManager.instances.get(settingsKey);
    if (!shared || shared.manager !== manager) {
      throw new Error("OpenCode shared server manager registration failed");
    }
    shared.ownerCount += 1;
    let releasePromise: Promise<void> | null = null;
    return {
      manager,
      release: () => {
        releasePromise ??= OpenCodeServerManager.releaseShared(settingsKey, shared);
        return releasePromise;
      },
    };
  }

  private static async releaseShared(
    settingsKey: string,
    shared: SharedOpenCodeServerManager,
  ): Promise<void> {
    shared.ownerCount = Math.max(0, shared.ownerCount - 1);
    if (shared.ownerCount > 0 || OpenCodeServerManager.instances.get(settingsKey) !== shared) {
      return;
    }
    OpenCodeServerManager.instances.delete(settingsKey);
    shared.manager.retainForSignalCleanup();
    await shared.manager.retireWhenUnused();
    shared.manager.releaseSignalCleanupRetentionIfSettled();
  }

  private static registerExitHandler(): void {
    if (OpenCodeServerManager.exitHandlerRegistered) {
      return;
    }
    OpenCodeServerManager.exitHandlerRegistered = true;

    const cleanup = () => {
      const managers = new Set([
        ...Array.from(OpenCodeServerManager.instances.values(), (shared) => shared.manager),
        ...OpenCodeServerManager.retiringManagers,
      ]);
      for (const manager of managers) {
        void manager.shutdown();
      }
    };

    process.on("exit", cleanup);
    process.on("SIGTERM", cleanup);
    process.on("SIGINT", cleanup);
  }

  async acquireCurrent(signal?: AbortSignal): Promise<OpenCodeServerAcquisition> {
    const generation = this.getActiveGeneration();
    const current = this.currentServer;
    if (current && !current.process.killed) {
      const reservation = this.reserveServer(current, generation);
      try {
        const acquisition = await waitForOperationOrAbort(reservation, signal);
        this.assertGenerationActive(generation);
        assertSignalActive(signal);
        return acquisition;
      } catch (error) {
        void reservation.then(
          async (acquisition) => await acquisition.release(),
          () => undefined,
        );
        throw error;
      }
    }

    const server = await waitForOperationOrAbort(this.getCurrentServer(generation), signal);
    this.assertGenerationActive(generation);
    assertSignalActive(signal);
    return this.acquireServer(server);
  }

  async acquireNew(signal?: AbortSignal): Promise<OpenCodeServerAcquisition> {
    const generation = this.getActiveGeneration();
    const server = await waitForOperationOrAbort(this.getNewServer(generation), signal);
    this.assertGenerationActive(generation);
    assertSignalActive(signal);
    return this.acquireServer(server);
  }

  async acquireDedicated(
    env: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<OpenCodeServerAcquisition> {
    const generation = this.getActiveGeneration();
    const server = await this.startServer(env, generation, signal);
    try {
      await waitForOperationOrAbort(server.ready, signal);
      this.assertGenerationActive(generation);
      assertSignalActive(signal);
      this.startingServers.delete(server);
      server.retired = true;
      this.retiredServers.add(server);
      const acquisition = this.acquireServer(server);
      return acquisition;
    } catch (error) {
      await this.killServer(server);
      throw error;
    }
  }

  acquireExisting(url: string): OpenCodeServerAcquisition | null {
    if (this.shutDown) {
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

  private async reserveServer(
    server: OpenCodeServerGeneration,
    generation: number,
  ): Promise<OpenCodeServerAcquisition> {
    const acquisition = this.acquireServer(server);
    try {
      await server.ready;
      this.assertGenerationActive(generation);
      return acquisition;
    } catch (error) {
      await acquisition.release();
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

  private async getNewServer(generation: number): Promise<OpenCodeServerGeneration> {
    if (this.newServerPromise) {
      const server = await this.newServerPromise;
      this.assertGenerationActive(generation);
      return server;
    }

    this.newServerPromise = Promise.resolve()
      .then(async () => {
        this.assertGenerationActive(generation);
        await this.rotateCurrentServer(generation);
        const server = await this.startServer(undefined, generation);
        await server.ready;
        this.assertGenerationActive(generation);
        this.startingServers.delete(server);
        if (!server.retired) {
          this.currentServer = server;
        }
        return server;
      })
      .finally(() => {
        this.newServerPromise = null;
      });
    return this.newServerPromise;
  }

  private async getCurrentServer(generation: number): Promise<OpenCodeServerGeneration> {
    if (this.newServerPromise) {
      const server = await this.newServerPromise;
      this.assertGenerationActive(generation);
      return server;
    }

    if (this.startPromise) {
      const server = await this.startPromise;
      this.assertGenerationActive(generation);
      await server.ready;
      this.assertGenerationActive(generation);
      return server;
    }

    if (this.currentServer && !this.currentServer.process.killed) {
      await this.currentServer.ready;
      return this.currentServer;
    }

    this.startPromise = this.startServer(undefined, generation).then(async (server) => {
      await server.ready;
      if (!this.isGenerationActive(generation)) {
        await this.killServer(server);
        throw this.createShutDownError();
      }
      this.startingServers.delete(server);
      if (!server.retired) {
        this.currentServer = server;
      }
      return server;
    });
    const currentStart = this.startPromise;
    const result = await currentStart.finally(() => {
      if (this.startPromise === currentStart) {
        this.startPromise = null;
      }
    });
    this.assertGenerationActive(generation);
    await result.ready;
    this.assertGenerationActive(generation);
    return result;
  }

  private async rotateCurrentServer(generation: number): Promise<void> {
    this.assertGenerationActive(generation);
    const existing = this.currentServer;
    if (existing) {
      existing.retired = true;
      this.retiredServers.add(existing);
      this.currentServer = null;
      await this.cleanupRetiredServers();
      this.assertGenerationActive(generation);
    }
    if (this.startPromise) {
      const pending = await this.startPromise;
      this.assertGenerationActive(generation);
      pending.retired = true;
      this.retiredServers.add(pending);
      this.currentServer = null;
      await this.cleanupRetiredServers();
      this.assertGenerationActive(generation);
    }
  }

  private async startServer(
    launchEnv: Record<string, string> | undefined,
    generation: number,
    signal?: AbortSignal,
  ): Promise<OpenCodeServerGeneration> {
    this.assertGenerationActive(generation);
    assertSignalActive(signal);
    const port = await this.awaitLifecycleOperation(this.portAllocator(), generation, signal);
    this.assertGenerationActive(generation);
    assertSignalActive(signal);
    const url = `http://127.0.0.1:${port}`;
    const launchPrefix = await this.awaitLifecycleOperation(
      this.resolveCommandPrefix(),
      generation,
      signal,
    );
    this.assertGenerationActive(generation);
    assertSignalActive(signal);
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
        baseEnv: this.baseEnv,
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
    this.startingServers.add(server);
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
        this.releaseSignalCleanupRetentionIfSettled();
      });
    });

    server.ready = ready.catch(async (error) => {
      await this.killServer(server);
      if (this.currentServer === server) {
        this.currentServer = null;
      }
      this.retiredServers.delete(server);
      this.startingServers.delete(server);
      throw error;
    });

    return server;
  }

  async shutdown(): Promise<void> {
    this.unregisterSharedInstance();
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }
    if (!this.shutDown) {
      this.shutDown = true;
      this.lifecycleGeneration += 1;
      this.shutdownController.abort(this.createShutDownError());
    }
    const servers = new Set([
      ...(this.currentServer ? [this.currentServer] : []),
      ...Array.from(this.retiredServers),
      ...Array.from(this.startingServers),
    ]);
    const shutdownPromise = Promise.all(
      Array.from(servers, (server) => this.killServer(server)),
    ).then(() => undefined);
    this.shutdownPromise = shutdownPromise.finally(() => {
      this.currentServer = null;
      this.retiredServers.clear();
      this.startingServers.clear();
      this.releaseSignalCleanupRetentionIfSettled();
    });
    return this.shutdownPromise;
  }

  private retireWhenUnused(): Promise<void> {
    if (this.retirementPromise) {
      return this.retirementPromise;
    }
    if (!this.shutDown) {
      this.shutDown = true;
      this.lifecycleGeneration += 1;
      this.shutdownController.abort(this.createShutDownError());
    }
    const servers = new Set([
      ...(this.currentServer ? [this.currentServer] : []),
      ...Array.from(this.retiredServers),
      ...Array.from(this.startingServers),
    ]);
    this.currentServer = null;
    for (const server of servers) {
      server.retired = true;
      this.retiredServers.add(server);
    }
    this.retirementPromise = this.cleanupRetiredServers().finally(() => {
      this.releaseSignalCleanupRetentionIfSettled();
    });
    return this.retirementPromise;
  }

  private unregisterSharedInstance(): void {
    if (OpenCodeServerManager.instances.get(this.runtimeSettingsKey)?.manager === this) {
      this.retainForSignalCleanup();
      OpenCodeServerManager.instances.delete(this.runtimeSettingsKey);
    }
  }

  private retainForSignalCleanup(): void {
    this.retainedForSignalCleanup = true;
    OpenCodeServerManager.retiringManagers.add(this);
  }

  private releaseSignalCleanupRetentionIfSettled(): void {
    if (
      !this.retainedForSignalCleanup ||
      this.currentServer ||
      this.retiredServers.size > 0 ||
      this.startingServers.size > 0 ||
      this.terminatingServers.size > 0
    ) {
      return;
    }
    this.retainedForSignalCleanup = false;
    OpenCodeServerManager.retiringManagers.delete(this);
  }

  private getActiveGeneration(): number {
    const generation = this.lifecycleGeneration;
    this.assertGenerationActive(generation);
    return generation;
  }

  private isGenerationActive(generation: number): boolean {
    return !this.shutDown && generation === this.lifecycleGeneration;
  }

  private assertGenerationActive(generation: number): void {
    if (!this.isGenerationActive(generation)) {
      throw this.createShutDownError();
    }
  }

  private createShutDownError(): Error {
    return new Error("OpenCode server manager has shut down");
  }

  private async awaitLifecycleOperation<T>(
    operation: Promise<T>,
    generation: number,
    signal?: AbortSignal,
  ): Promise<T> {
    this.assertGenerationActive(generation);
    const shutdownSignal = this.shutdownController.signal;
    if (shutdownSignal.aborted) {
      throw this.createShutDownError();
    }
    assertSignalActive(signal);
    return await waitForOperationOrAbort(
      waitForOperationOrAbort(operation, shutdownSignal, () => this.createShutDownError()),
      signal,
    );
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
    const existingTermination = server.terminationPromise;
    if (existingTermination) {
      return existingTermination;
    }

    const termination = this.terminateServer(server);
    server.terminationPromise = termination;
    this.terminatingServers.add(server);
    void termination.then(
      () => {
        this.terminatingServers.delete(server);
        this.releaseSignalCleanupRetentionIfSettled();
        return undefined;
      },
      () => {
        this.terminatingServers.delete(server);
        this.releaseSignalCleanupRetentionIfSettled();
        return undefined;
      },
    );
    return termination;
  }

  private async terminateServer(server: OpenCodeServerGeneration): Promise<void> {
    if (server.process.exitCode === null && server.process.signalCode === null) {
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
          "OpenCode server did not report exit after SIGKILL; retaining its managed-process record",
        );
        return;
      }
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

function assertSignalActive(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  throw signal.reason instanceof Error ? signal.reason : new Error("OpenCode acquisition canceled");
}

async function waitForOperationOrAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  getAbortError: () => Error = () =>
    signal?.reason instanceof Error ? signal.reason : new Error("OpenCode acquisition canceled"),
): Promise<T> {
  if (!signal) {
    return await operation;
  }
  if (signal.aborted) {
    throw getAbortError();
  }

  let onAbort: (() => void) | null = null;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(getAbortError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
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
