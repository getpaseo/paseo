import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { Logger } from "pino";

import { findExecutable } from "../../../../executable-resolution/executable-resolution.js";
import { spawnProcess, type SpawnProcessOptions } from "../../../../utils/spawn.js";
import {
  terminateWithTreeKill,
  type ProcessTerminator,
  type TerminateWithTreeKillResult,
} from "../../../../utils/tree-kill.js";
import { isWindowsCommandScript } from "../../../../utils/windows-command.js";
import {
  createProcessGroupTarget,
  isManagedProcessSignalAllowed,
  MANAGED_PROCESS_OWNERSHIP_TOKEN_ENV,
} from "../../../managed-processes/managed-processes.js";
import type {
  ManagedProcessRecord,
  ManagedProcessRegistry,
  ManagedProcessVerification,
} from "../../../managed-processes/managed-processes.js";
import {
  createProviderEnvSpec,
  resolveProviderCommandPrefix,
  type ProviderRuntimeSettings,
} from "../../provider-launch-config.js";
import { resolveOpenCodeHomeDir } from "./paths.js";

const OPENCODE_SERVER_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 5_000;
const OPENCODE_SERVER_FORCE_SHUTDOWN_TIMEOUT_MS = 1_000;
const OPENCODE_SERVER_STARTUP_TIMEOUT_MS = 30_000;

export interface OpenCodeServerAcquisition {
  server: { port: number; url: string };
  release: () => Promise<void>;
}

export interface OpenCodeServerManagerLike {
  acquireCurrent(): Promise<OpenCodeServerAcquisition>;
  acquireNew(): Promise<OpenCodeServerAcquisition>;
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
  available: boolean;
  ready: Promise<void>;
  managedProcessId?: string;
  managedProcessRecord?: Promise<ManagedProcessRecord | null>;
  managedProcessIdentity?: ManagedProcessRecord;
  ownsProcessGroup: boolean;
  ownershipToken?: string;
  cleanupRequested: boolean;
  cleanupComplete: boolean;
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
  startupTimeoutMs?: number;
}

export class OpenCodeServerManager implements OpenCodeServerManagerLike {
  private static instance: OpenCodeServerManager | null = null;
  private static exitHandlerRegistered = false;
  private currentServer: OpenCodeServerGeneration | null = null;
  private retiredServers = new Set<OpenCodeServerGeneration>();
  private allServers = new Set<OpenCodeServerGeneration>();
  private terminationPromises = new WeakMap<OpenCodeServerGeneration, Promise<void>>();
  private pendingRecordCleanups = new Set<Promise<void>>();
  private pendingStarts = new Set<Promise<OpenCodeServerGeneration>>();
  private startPromise: Promise<OpenCodeServerGeneration> | null = null;
  private newServerPromise: Promise<OpenCodeServerGeneration> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private shuttingDown = false;
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
  private readonly startupTimeoutMs: number;

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
    this.startupTimeoutMs = options.startupTimeoutMs ?? OPENCODE_SERVER_STARTUP_TIMEOUT_MS;
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

  async acquireCurrent(): Promise<OpenCodeServerAcquisition> {
    this.assertAcceptingAcquisitions();
    const acquisition = await this.getCurrentAcquisition();
    try {
      this.assertAcceptingAcquisitions();
      return acquisition;
    } catch (error) {
      await acquisition.release();
      throw error;
    }
  }

  async acquireNew(): Promise<OpenCodeServerAcquisition> {
    this.assertAcceptingAcquisitions();
    const acquisition = await this.getNewAcquisition();
    try {
      this.assertAcceptingAcquisitions();
      return acquisition;
    } catch (error) {
      await acquisition.release();
      throw error;
    }
  }

  async acquireDedicated(env: Record<string, string>): Promise<OpenCodeServerAcquisition> {
    this.assertAcceptingAcquisitions();
    const server = await this.trackPendingStart(this.startServer(env));
    server.retired = true;
    this.retiredServers.add(server);
    const acquisition = await this.acquireServerWhenReady(server);
    try {
      this.assertAcceptingAcquisitions();
      return acquisition;
    } catch (error) {
      await acquisition.release();
      throw error;
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
    return (
      servers.find(
        (server) => server.url === url && server.available && this.isServerLive(server),
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

  private getNewAcquisition(): Promise<OpenCodeServerAcquisition> {
    if (this.newServerPromise) {
      return this.acquireServerWhenStarted(this.newServerPromise);
    }

    const nextGeneration = this.trackPendingStart(
      Promise.resolve().then(async () => {
        await this.rotateCurrentServer();
        const server = await this.startServer();
        if (!server.retired && !this.shuttingDown) {
          this.currentServer = server;
        } else {
          server.retired = true;
          this.retiredServers.add(server);
          void this.killServer(server);
        }
        return server;
      }),
    );
    this.newServerPromise = nextGeneration;
    void nextGeneration
      .then((server) => server.ready)
      .finally(() => {
        if (this.newServerPromise === nextGeneration) {
          this.newServerPromise = null;
        }
      })
      .catch(() => undefined);
    return this.acquireServerWhenStarted(nextGeneration);
  }

  private getCurrentAcquisition(): Promise<OpenCodeServerAcquisition> {
    if (this.newServerPromise) {
      return this.acquireServerWhenStarted(this.newServerPromise);
    }

    if (this.startPromise) {
      return this.acquireServerWhenStarted(this.startPromise);
    }

    if (this.currentServer && !this.currentServer.process.killed) {
      return this.acquireServerWhenReady(this.currentServer);
    }

    this.startPromise = this.trackPendingStart(
      this.startServer().then((server) => {
        if (!server.retired && !this.shuttingDown) {
          this.currentServer = server;
        } else {
          server.retired = true;
          this.retiredServers.add(server);
          void this.killServer(server);
        }
        return server;
      }),
    );
    const currentStart = this.startPromise;
    const acquisition = this.acquireServerWhenStarted(currentStart);
    void currentStart
      .finally(() => {
        if (this.startPromise === currentStart) {
          this.startPromise = null;
        }
      })
      .catch(() => undefined);
    return acquisition;
  }

  private async acquireServerWhenStarted(
    serverStart: Promise<OpenCodeServerGeneration>,
  ): Promise<OpenCodeServerAcquisition> {
    return this.acquireServerWhenReady(await serverStart);
  }

  private async acquireServerWhenReady(
    server: OpenCodeServerGeneration,
  ): Promise<OpenCodeServerAcquisition> {
    const acquisition = this.acquireServer(server);
    try {
      await server.ready;
      return acquisition;
    } catch (error) {
      await acquisition.release();
      throw error;
    }
  }

  private async rotateCurrentServer(): Promise<void> {
    const existing = this.currentServer;
    if (existing) {
      existing.retired = true;
      this.retiredServers.add(existing);
      this.currentServer = null;
      await this.cleanupRetiredServers();
    }
    if (this.startPromise) {
      const pending = await this.startPromise;
      pending.retired = true;
      this.retiredServers.add(pending);
      this.currentServer = null;
      await this.cleanupRetiredServers();
    }
  }

  private async startServer(launchEnv?: Record<string, string>): Promise<OpenCodeServerGeneration> {
    await this.assertNoIncompleteCleanup();
    this.assertAcceptingAcquisitions();
    const port = await this.portAllocator();
    this.assertAcceptingAcquisitions();
    const url = `http://127.0.0.1:${port}`;
    const launchPrefix = await this.resolveCommandPrefix();
    this.assertAcceptingAcquisitions();
    const launchCommand = await resolveOpenCodeLaunchCommand(launchPrefix.command);
    this.assertAcceptingAcquisitions();
    const serverArgs = [...launchPrefix.args, "serve", "--port", String(port)];
    // Use a neutral OpenCode home as the server cwd. Launching from the user's
    // home directory causes OpenCode to treat it as the default workspace and
    // index the entire home tree.
    const serverCwd = this.resolveHomeDir();
    mkdirSync(serverCwd, { recursive: true });

    const ownsProcessGroup = process.platform !== "win32";
    const ownershipToken = ownsProcessGroup ? randomUUID() : undefined;
    const serverProcess = this.spawnServerProcess(launchCommand, serverArgs, {
      cwd: serverCwd,
      detached: ownsProcessGroup,
      stdio: ["ignore", "pipe", "pipe"],
      ...createProviderEnvSpec({
        baseEnv: this.baseEnv,
        runtimeSettings: this.runtimeSettings,
        overlays: [
          launchEnv,
          ownershipToken ? { [MANAGED_PROCESS_OWNERSHIP_TOKEN_ENV]: ownershipToken } : undefined,
        ],
      }),
    });
    let managedProcessIdentity: ManagedProcessRecord | undefined;
    let managedProcessId: string | undefined;
    const serverRef: { current?: OpenCodeServerGeneration } = {};
    const managedProcessRecord = this.recordManagedServerProcess({
      process: serverProcess,
      command: launchCommand,
      args: serverArgs,
      port,
      ownershipToken,
      onIdentityCaptured: (record) => {
        managedProcessIdentity = record;
        const currentServer = serverRef.current;
        if (currentServer) {
          currentServer.managedProcessIdentity = record;
          if (currentServer.cleanupRequested) {
            queueMicrotask(() => void this.killServer(currentServer));
          }
        }
      },
      onRecordPersisted: (record) => {
        managedProcessId = record.id;
        managedProcessIdentity = record;
        const currentServer = serverRef.current;
        if (!currentServer) {
          return;
        }
        currentServer.managedProcessId = record.id;
        currentServer.managedProcessIdentity = record;
        if (currentServer.cleanupRequested) {
          if (currentServer.cleanupComplete) {
            currentServer.cleanupComplete = false;
            this.allServers.add(currentServer);
          }
          queueMicrotask(() => void this.killServer(currentServer));
        }
      },
    });
    const server: OpenCodeServerGeneration = {
      process: serverProcess,
      port,
      url,
      refCount: 0,
      retired: false,
      available: false,
      ready: Promise.resolve(),
      managedProcessId,
      managedProcessRecord,
      managedProcessIdentity,
      ownsProcessGroup,
      ownershipToken,
      cleanupRequested: false,
      cleanupComplete: false,
    };
    serverRef.current = server;
    this.allServers.add(server);
    void managedProcessRecord
      .then((record) => {
        if (record && server.managedProcessRecord === managedProcessRecord) {
          server.managedProcessId = record.id;
          server.managedProcessIdentity = record;
        } else if (record) {
          return this.removeManagedProcessId(record.id);
        }
        return undefined;
      })
      .catch(() => undefined);

    let started = false;
    let startupConfirmed = false;
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

    let rejectExitBeforeReady: (error: Error) => void = () => undefined;
    const exitBeforeReady = new Promise<never>((_resolve, reject) => {
      rejectExitBeforeReady = reject;
    });
    const listening = new Promise<void>((resolve, reject) => {
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
      }, this.startupTimeoutMs);

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
        if (typeof serverProcess.pid !== "number" || serverProcess.pid <= 0) {
          server.cleanupComplete = true;
          this.allServers.delete(server);
          this.retiredServers.delete(server);
        }
        failStartup(new Error(buildStartupErrorMessage(headline)));
      });

      serverProcess.on("exit", (code) => {
        server.available = false;
        server.cleanupRequested = true;
        server.retired = true;
        this.retiredServers.add(server);
        queueMicrotask(() => void this.killServer(server));
        const exitError = new Error(
          buildStartupErrorMessage(`OpenCode server exited with code ${code}`),
        );
        if (!startupConfirmed) {
          rejectExitBeforeReady(exitError);
        }
        if (!started) {
          failStartup(exitError);
        }
        if (this.currentServer?.process === serverProcess) {
          this.currentServer = null;
        }
        for (const retired of Array.from(this.retiredServers)) {
          if (retired.process === serverProcess && retired.cleanupComplete) {
            this.retiredServers.delete(retired);
          }
        }
      });
    });

    let readinessTimeout: NodeJS.Timeout | undefined;
    const readinessDeadline = new Promise<never>((_resolve, reject) => {
      readinessTimeout = setTimeout(() => {
        reject(new Error(buildStartupErrorMessage("OpenCode server startup timeout")));
      }, this.startupTimeoutMs);
    });
    server.ready = Promise.race([
      Promise.all([listening, managedProcessRecord]).then(() => {
        if (server.cleanupRequested) {
          throw new Error("OpenCode server was terminated during startup");
        }
        if (!this.isServerLive(server)) {
          throw new Error(
            buildStartupErrorMessage(`OpenCode server exited with code ${server.process.exitCode}`),
          );
        }
        startupConfirmed = true;
        server.available = true;
        return undefined;
      }),
      exitBeforeReady,
      readinessDeadline,
    ])
      .catch((error) => {
        void this.killServer(server).catch((cleanupError) => {
          this.logger.warn({ err: cleanupError }, "OpenCode server cleanup failed");
        });
        if (this.currentServer === server) {
          this.currentServer = null;
        }
        throw error;
      })
      .finally(() => {
        if (readinessTimeout) {
          clearTimeout(readinessTimeout);
        }
      });

    return server;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }
    this.shuttingDown = true;
    const shutdown = this.shutdownOnce();
    const tracked = shutdown.finally(() => {
      if (OpenCodeServerManager.instance === this) {
        OpenCodeServerManager.instance = null;
      }
    });
    this.shutdownPromise = tracked;
    return tracked;
  }

  private async shutdownOnce(): Promise<void> {
    const attemptedServers = new Set<OpenCodeServerGeneration>();
    const pendingRecords = new Set(
      Array.from(this.allServers).flatMap((server) =>
        server.managedProcessRecord ? [server.managedProcessRecord] : [],
      ),
    );
    const killUnattemptedServers = async () => {
      const servers = Array.from(this.allServers).filter((server) => !attemptedServers.has(server));
      for (const server of servers) {
        attemptedServers.add(server);
      }
      await Promise.all(servers.map((server) => this.killServer(server)));
    };
    await killUnattemptedServers();
    await Promise.allSettled(Array.from(this.pendingStarts));
    for (const server of this.allServers) {
      if (server.managedProcessRecord) {
        pendingRecords.add(server.managedProcessRecord);
      }
    }
    await killUnattemptedServers();
    await Promise.allSettled(Array.from(pendingRecords));
    await Promise.resolve();
    await Promise.all(
      Array.from(this.allServers).flatMap((server) => {
        const termination = this.terminationPromises.get(server);
        return termination ? [termination] : [];
      }),
    );
    await this.drainPendingRecordCleanups();
    this.currentServer = null;
  }

  private async drainPendingRecordCleanups(): Promise<void> {
    while (this.pendingRecordCleanups.size > 0) {
      await Promise.all(Array.from(this.pendingRecordCleanups));
    }
  }

  private trackPendingStart(
    start: Promise<OpenCodeServerGeneration>,
  ): Promise<OpenCodeServerGeneration> {
    const tracked = start.finally(() => {
      this.pendingStarts.delete(tracked);
    });
    this.pendingStarts.add(tracked);
    return tracked;
  }

  private async cleanupRetiredServers(): Promise<void> {
    const cleanup: Promise<void>[] = [];
    for (const server of Array.from(this.retiredServers)) {
      if (server.refCount === 0) {
        cleanup.push(this.killServer(server));
      }
    }
    await Promise.all(cleanup);
  }

  private async killServer(server: OpenCodeServerGeneration): Promise<void> {
    server.available = false;
    if (server.cleanupComplete) {
      return;
    }
    server.cleanupRequested = true;
    server.retired = true;
    this.retiredServers.add(server);

    const existingTermination = this.terminationPromises.get(server);
    if (existingTermination) {
      return existingTermination;
    }
    const termination = this.killServerOnce(server).finally(() => {
      this.terminationPromises.delete(server);
    });
    this.terminationPromises.set(server, termination);
    return termination;
  }

  private async killServerOnce(server: OpenCodeServerGeneration): Promise<void> {
    const pid = server.process.pid;
    const rootExited =
      (server.process.exitCode !== null && server.process.exitCode !== undefined) ||
      (server.process.signalCode !== null && server.process.signalCode !== undefined);
    const processGroupAlive = isServerProcessGroupAlive(server);
    if (rootExited && !processGroupAlive) {
      if (await this.finishOwnedServerCleanup(server, "already-exited", "not-found")) {
        return;
      }
      await this.completeServerCleanup(server);
      return;
    }

    const target =
      server.ownsProcessGroup && typeof pid === "number"
        ? createProcessGroupTarget(pid)
        : server.process;
    const signalVerification: { current: ManagedProcessVerification } = { current: "unknown" };
    const terminationOptions = this.createTerminationOptions(server, pid, signalVerification);
    const result = await this.terminateProcess(target, terminationOptions);
    if (await this.finishOwnedServerCleanup(server, result, signalVerification.current)) {
      return;
    }
    if (result === "kill-timeout") {
      this.logger.warn(
        { timeoutMs: OPENCODE_SERVER_FORCE_SHUTDOWN_TIMEOUT_MS },
        "OpenCode server did not report exit after SIGKILL",
      );
      return;
    }
    if (result === "signal-skipped") {
      if (
        signalVerification.current === "mismatch" ||
        (signalVerification.current === "not-found" && !isServerProcessGroupAlive(server))
      ) {
        await this.completeServerCleanup(server);
        return;
      }
      this.logger.warn(
        { pid: server.process.pid },
        "OpenCode server identity changed before cleanup; skipping signal",
      );
      return;
    }
    await this.completeServerCleanup(server);
  }

  private createTerminationOptions(
    server: OpenCodeServerGeneration,
    pid: number | undefined,
    signalVerification: { current: ManagedProcessVerification },
  ): Parameters<ProcessTerminator>[1] {
    const managedProcesses = this.managedProcesses;
    const managedProcessIdentity = server.managedProcessIdentity;
    const terminationOptions: Parameters<ProcessTerminator>[1] = {
      gracefulTimeoutMs: OPENCODE_SERVER_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
      forceTimeoutMs: OPENCODE_SERVER_FORCE_SHUTDOWN_TIMEOUT_MS,
      onForceSignal: () => {
        this.logger.warn(
          { timeoutMs: OPENCODE_SERVER_GRACEFUL_SHUTDOWN_TIMEOUT_MS },
          "OpenCode server did not exit after SIGTERM; sending SIGKILL",
        );
      },
    };
    if (
      server.ownsProcessGroup &&
      typeof pid === "number" &&
      server.ownershipToken &&
      managedProcesses
    ) {
      const ownershipToken = server.ownershipToken;
      terminationOptions.beforeSignal = async (signal) => {
        signalVerification.current = await managedProcesses.verifyProcessGroup({
          processGroupId: pid,
          ownershipToken,
        });
        return isManagedProcessSignalAllowed({
          signal,
          verification: signalVerification.current,
          processGroupAlive: isServerProcessGroupAlive(server),
        });
      };
    } else if (managedProcessIdentity && managedProcesses) {
      terminationOptions.beforeSignal = async (signal) => {
        signalVerification.current = await managedProcesses.verify(managedProcessIdentity);
        return isManagedProcessSignalAllowed({
          signal,
          verification: signalVerification.current,
          processGroupAlive: isServerProcessGroupAlive(server),
        });
      };
      if (process.platform === "win32") {
        terminationOptions.signalProcessOnly = true;
      }
    } else if (process.platform === "win32") {
      terminationOptions.signalProcessOnly = true;
    }
    return terminationOptions;
  }

  private async finishOwnedServerCleanup(
    server: OpenCodeServerGeneration,
    result: TerminateWithTreeKillResult,
    verification: ManagedProcessVerification,
  ): Promise<boolean> {
    if (!server.ownershipToken || !this.managedProcesses) {
      return false;
    }
    const cleanup = await this.managedProcesses.cleanupOwnedProcesses(server.ownershipToken);
    if (!cleanup.complete) {
      this.logger.warn({ pid: server.process.pid }, "OpenCode child process cleanup is incomplete");
      return true;
    }
    if (result === "signal-skipped" && verification === "unknown") {
      return true;
    }
    if (result === "kill-timeout" && (!cleanup.found || isServerProcessGroupAlive(server))) {
      return false;
    }
    await this.completeServerCleanup(server);
    return true;
  }

  private async completeServerCleanup(server: OpenCodeServerGeneration): Promise<void> {
    if (server.managedProcessId) {
      if (!(await this.removeManagedProcessId(server.managedProcessId))) {
        return;
      }
      server.managedProcessId = undefined;
      server.managedProcessRecord = undefined;
    } else {
      this.removeManagedServerRecord(server);
    }
    server.cleanupComplete = true;
    this.retiredServers.delete(server);
    this.allServers.delete(server);
  }

  private async assertNoIncompleteCleanup(): Promise<void> {
    let trackedServers = Array.from(this.allServers);
    const pendingCleanup = trackedServers.flatMap((server) => {
      const termination = this.terminationPromises.get(server);
      return termination ? [termination] : [];
    });
    if (pendingCleanup.length > 0) {
      await Promise.allSettled(pendingCleanup);
    }
    const incompleteCleanup = Array.from(this.allServers).filter(
      (server) => server.cleanupRequested && !server.cleanupComplete,
    );
    if (incompleteCleanup.length > 0) {
      await Promise.allSettled(incompleteCleanup.map((server) => this.killServer(server)));
    }
    trackedServers = Array.from(this.allServers);
    if (trackedServers.some((server) => server.cleanupRequested && !server.cleanupComplete)) {
      throw new Error("OpenCode helper cleanup is incomplete; refusing to start another helper");
    }
    if (!this.managedProcesses) {
      return;
    }

    const trackedRecordIds = new Set(
      trackedServers.flatMap((server) =>
        server.managedProcessId ? [server.managedProcessId] : [],
      ),
    );
    const leftover = (await this.managedProcesses.list()).find(
      (record) =>
        record.owner.provider === "opencode" &&
        record.owner.kind === "helper-server" &&
        !trackedRecordIds.has(record.id),
    );
    if (leftover) {
      throw new Error(
        `OpenCode helper cleanup is incomplete for record ${leftover.id}; refusing to start another helper`,
      );
    }
  }

  private async recordManagedServerProcess(options: {
    process: ChildProcess;
    command: string;
    args: string[];
    port: number;
    ownershipToken?: string;
    onIdentityCaptured: (record: ManagedProcessRecord) => void;
    onRecordPersisted: (record: ManagedProcessRecord) => void;
  }): Promise<ManagedProcessRecord | null> {
    const pid = options.process.pid;
    if (!this.managedProcesses) {
      return null;
    }
    if (typeof pid !== "number" || pid <= 0) {
      throw new Error("OpenCode helper process did not provide a valid PID");
    }

    return this.managedProcesses.record(
      {
        owner: { provider: "opencode", kind: "helper-server" },
        pid,
        command: options.command,
        args: options.args,
        metadata: {
          port: options.port,
          terminationScope: process.platform === "win32" ? "process" : "process-group",
          ...(process.platform === "win32" ? { directExecutable: true } : {}),
        },
        ownershipToken: options.ownershipToken,
      },
      {
        onIdentityCaptured: options.onIdentityCaptured,
        onRecordPersisted: options.onRecordPersisted,
      },
    );
  }

  private removeManagedProcessRecordWhenResolved(
    record: Promise<ManagedProcessRecord | null>,
  ): void {
    const cleanup = record
      .then(async (resolved) => {
        if (resolved) {
          await this.removeManagedProcessId(resolved.id);
        }
        return undefined;
      })
      .catch(() => undefined);
    const tracked = cleanup.finally(() => {
      this.pendingRecordCleanups.delete(tracked);
    });
    this.pendingRecordCleanups.add(tracked);
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

  private assertAcceptingAcquisitions(): void {
    if (this.shuttingDown) {
      throw new Error("OpenCode server manager is shutting down");
    }
  }

  private async removeManagedProcessId(id: string): Promise<boolean> {
    try {
      await this.managedProcesses?.remove(id);
      return true;
    } catch (error) {
      this.logger.warn({ err: error, id }, "Failed to remove OpenCode helper process record");
      return false;
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

  return resolveOpenCodeWindowsExecutable(found);
}

async function resolveOpenCodeLaunchCommand(command: string): Promise<string> {
  if (process.platform !== "win32") {
    return command;
  }
  const resolved = await findExecutable(command);
  if (!resolved && !path.isAbsolute(command)) {
    throw new Error(`OpenCode command could not be resolved to an executable: ${command}`);
  }
  const launchCommand = resolved ?? command;
  if (isWindowsCommandScript(launchCommand) || !isDirectOpenCodeWindowsExecutable(launchCommand)) {
    throw new Error(
      `OpenCode commands must point directly to opencode.exe on Windows: ${launchCommand}`,
    );
  }
  return launchCommand;
}

export function isDirectOpenCodeWindowsExecutable(command: string): boolean {
  return path.win32.basename(command).toLowerCase() === "opencode.exe";
}

async function resolveOpenCodeWindowsExecutable(command: string): Promise<string> {
  if (!isWindowsCommandScript(command)) {
    return command;
  }

  // Global npm: <prefix>/opencode.cmd -> <prefix>/node_modules/opencode-ai/bin/opencode.exe
  const globalCandidate = path.join(
    path.dirname(command),
    "node_modules",
    "opencode-ai",
    "bin",
    "opencode.exe",
  );
  if (await pathExists(globalCandidate)) return globalCandidate;

  // Local/pnpm: <project>/node_modules/.bin/opencode.cmd -> <project>/node_modules/opencode-ai/bin/opencode.exe
  const localCandidate = path.join(
    path.dirname(command),
    "..",
    "opencode-ai",
    "bin",
    "opencode.exe",
  );
  if (await pathExists(localCandidate)) return localCandidate;

  throw new Error(`OpenCode command wrapper could not be resolved to opencode.exe: ${command}`);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function isProcessTargetAlive(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isServerProcessGroupAlive(server: OpenCodeServerGeneration): boolean {
  return (
    server.ownsProcessGroup &&
    typeof server.process.pid === "number" &&
    isProcessTargetAlive(-server.process.pid)
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
