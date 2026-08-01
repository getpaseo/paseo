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
  type TreeKillTarget,
} from "../../../../utils/tree-kill.js";
import {
  createProcessGroupTarget,
  inspectSystemProcessGroupIdentity,
  MANAGED_PROCESS_IDENTITY_ENV,
  type ManagedProcessGroupInspection,
  type ManagedProcessRecord,
  type ManagedProcessRegistry,
  verifySystemManagedProcessIdentity,
} from "../../../managed-processes/managed-processes.js";
import {
  createProviderEnvSpec,
  resolveProviderCommandPrefix,
  type ProviderRuntimeSettings,
} from "../../provider-launch-config.js";
import { resolveOpenCodeHomeDir } from "./paths.js";
import {
  getWindowsJobObjectProofMarker,
  spawnWindowsJobObjectProcess,
} from "./windows-job-object.js";
import type {
  AgentRuntimeCapacityController,
  AgentRuntimeCapacityReservation,
} from "../../agent-sdk-types.js";

const OPENCODE_SERVER_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 5_000;
const OPENCODE_SERVER_FORCE_SHUTDOWN_TIMEOUT_MS = 1_000;
const OPENCODE_SERVER_CLEANUP_RETRY_DELAY_MS = 1_000;

function hasProcessExited(process: ChildProcess): boolean {
  return (
    (process.exitCode !== null && process.exitCode !== undefined) ||
    (process.signalCode !== null && process.signalCode !== undefined)
  );
}

export interface OpenCodeServerAcquisition {
  server: { port: number; url: string };
  release: () => Promise<void>;
}

export interface OpenCodeServerManagerLike {
  configureRuntimeCapacityController(controller: AgentRuntimeCapacityController): void;
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
  ready: Promise<void>;
  managedProcessId?: string;
  managedProcessRecord?: Promise<ManagedProcessRecord | null>;
  managedProcessIdentity?: ManagedProcessRecord;
  ownsProcessGroup: boolean;
  ownsWindowsJob: boolean;
  windowsJobCompletion?: Promise<boolean>;
  identityToken?: string;
  cleanupComplete: boolean;
  abortStartup?: (error: Error) => void;
}

export type OpenCodePortAllocator = () => Promise<number>;
export type OpenCodeCommandPrefixResolver = () => Promise<{ command: string; args: string[] }>;
export type OpenCodeServerProcessSpawner = (
  command: string,
  args: string[],
  options: SpawnProcessOptions,
) => ChildProcess;
export type OpenCodeProcessGroupIdentityVerifier = (
  processGroupId: number,
  identityToken: string,
) => Promise<ManagedProcessGroupInspection>;
export type OpenCodeProcessIdentityVerifier = (record: ManagedProcessRecord) => Promise<boolean>;
export type OpenCodeWindowsJobProofResolver = (process: ChildProcess) => string | undefined;

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
  createManagedProcessIdentityToken?: () => string;
  verifyProcessGroupIdentity?: OpenCodeProcessGroupIdentityVerifier;
  verifyProcessIdentity?: OpenCodeProcessIdentityVerifier;
  getWindowsJobProofMarker?: OpenCodeWindowsJobProofResolver;
  platform?: NodeJS.Platform;
}

export class OpenCodeServerManager implements OpenCodeServerManagerLike {
  private static instance: OpenCodeServerManager | null = null;
  private static exitHandlerRegistered = false;
  private currentServer: OpenCodeServerGeneration | null = null;
  private retiredServers = new Set<OpenCodeServerGeneration>();
  private terminationPromises = new WeakMap<OpenCodeServerGeneration, Promise<void>>();
  private cleanupRetryTimers = new WeakMap<OpenCodeServerGeneration, NodeJS.Timeout>();
  private cleanupRetriesDisabled = new WeakSet<OpenCodeServerGeneration>();
  private pendingStarts = new Set<Promise<OpenCodeServerGeneration>>();
  private shutdownPromise: Promise<void> | null = null;
  private startPromise: Promise<OpenCodeServerGeneration> | null = null;
  private newServerPromise: Promise<OpenCodeServerGeneration> | null = null;
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
  private runtimeCapacity: AgentRuntimeCapacityController | null = null;
  private readonly createManagedProcessIdentityToken: () => string;
  private readonly verifyProcessGroupIdentity: OpenCodeProcessGroupIdentityVerifier;
  private readonly verifyProcessIdentity: OpenCodeProcessIdentityVerifier;
  private readonly platform: NodeJS.Platform;
  private readonly getWindowsJobProofMarker: OpenCodeWindowsJobProofResolver;

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
    this.platform = options.platform ?? process.platform;
    this.getWindowsJobProofMarker =
      options.getWindowsJobProofMarker ?? getWindowsJobObjectProofMarker;
    const defaultSpawner = this.platform === "win32" ? spawnWindowsJobObjectProcess : spawnProcess;
    const spawnServerProcess = options.spawnServerProcess ?? defaultSpawner;
    this.spawnServerProcess = (command, args, spawnOptions) => {
      let reservation: AgentRuntimeCapacityReservation | null =
        this.runtimeCapacity?.reserve() ?? null;
      try {
        const child = spawnServerProcess(command, args, spawnOptions);
        reservation?.track(child);
        reservation = null;
        return child;
      } catch (error) {
        reservation?.release();
        throw error;
      }
    };
    this.createManagedProcessIdentityToken =
      options.createManagedProcessIdentityToken ?? randomUUID;
    this.verifyProcessGroupIdentity =
      options.verifyProcessGroupIdentity ?? inspectSystemProcessGroupIdentity;
    this.verifyProcessIdentity =
      options.verifyProcessIdentity ?? verifySystemManagedProcessIdentity;
  }

  configureRuntimeCapacityController(controller: AgentRuntimeCapacityController): void {
    if (
      this.runtimeCapacity &&
      this.runtimeCapacity !== controller &&
      (this.currentServer ||
        this.retiredServers.size > 0 ||
        this.startPromise ||
        this.newServerPromise)
    ) {
      throw new Error(
        "OpenCode server manager already has a different runtime capacity controller",
      );
    }
    this.runtimeCapacity = controller;
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
    if (this.shutdownPromise) {
      await this.shutdownPromise;
    }
    const server = await this.getCurrentServer();
    return this.acquireServer(server);
  }

  async acquireNew(): Promise<OpenCodeServerAcquisition> {
    if (this.shutdownPromise) {
      await this.shutdownPromise;
    }
    const server = await this.getNewServer();
    return this.acquireServer(server);
  }

  async acquireDedicated(env: Record<string, string>): Promise<OpenCodeServerAcquisition> {
    if (this.shutdownPromise) {
      await this.shutdownPromise;
    }
    const server = await this.trackPendingStart(
      this.startServer(env).then((startedServer) => {
        startedServer.retired = true;
        this.retiredServers.add(startedServer);
        return startedServer;
      }),
    );
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

    await this.killServer(server);
  }

  private async getNewServer(): Promise<OpenCodeServerGeneration> {
    if (this.newServerPromise) {
      return this.newServerPromise;
    }

    const generation = this.trackPendingStart(
      Promise.resolve().then(async () => {
        await this.rotateCurrentServer();
        const server = await this.startServer();
        if (!server.retired) {
          this.currentServer = server;
        }
        return server;
      }),
    );
    this.newServerPromise = generation
      .then(async (server) => {
        await server.ready;
        return server;
      })
      .finally(() => {
        this.newServerPromise = null;
      });
    return this.newServerPromise;
  }

  private async getCurrentServer(): Promise<OpenCodeServerGeneration> {
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

    this.startPromise = this.trackPendingStart(
      this.startServer().then((server) => {
        if (!server.retired) {
          this.currentServer = server;
        }
        return server;
      }),
    );
    const currentStart = this.startPromise;
    const result = await currentStart.finally(() => {
      if (this.startPromise === currentStart) {
        this.startPromise = null;
      }
    });
    await result.ready;
    return result;
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
    const port = await this.portAllocator();
    const url = `http://127.0.0.1:${port}`;
    const launchPrefix = await this.resolveCommandPrefix();
    const serverArgs = [...launchPrefix.args, "serve", "--port", String(port)];
    // Use a neutral OpenCode home as the server cwd. Launching from the user's
    // home directory causes OpenCode to treat it as the default workspace and
    // index the entire home tree.
    const serverCwd = this.resolveHomeDir();
    mkdirSync(serverCwd, { recursive: true });
    const ownsProcessGroup = this.platform !== "win32";
    const ownsWindowsJob = this.platform === "win32";
    const identityToken = ownsProcessGroup ? this.createManagedProcessIdentityToken() : undefined;

    const serverProcess = this.spawnServerProcess(launchPrefix.command, serverArgs, {
      cwd: serverCwd,
      detached: ownsProcessGroup,
      stdio: ["ignore", "pipe", "pipe"],
      ...createProviderEnvSpec({
        baseEnv: this.baseEnv,
        runtimeSettings: this.runtimeSettings,
        overlays: [
          launchEnv,
          identityToken ? { [MANAGED_PROCESS_IDENTITY_ENV]: identityToken } : undefined,
        ],
      }),
    });
    const windowsJobProofMarker = ownsWindowsJob
      ? this.getWindowsJobProofMarker(serverProcess)
      : undefined;
    let resolveWindowsJobCompletion: ((proven: boolean) => void) | undefined;
    const windowsJobCompletion = ownsWindowsJob
      ? new Promise<boolean>((resolve) => {
          resolveWindowsJobCompletion = resolve;
        })
      : undefined;
    let capturedManagedProcessIdentity: ManagedProcessRecord | undefined;
    const serverRef: { current?: OpenCodeServerGeneration } = {};
    const managedProcessRecord = this.recordManagedServerProcess({
      process: serverProcess,
      command: launchPrefix.command,
      args: serverArgs,
      port,
      ownsProcessGroup,
      identityToken,
      onIdentityCaptured: (record) => {
        capturedManagedProcessIdentity = record;
        if (serverRef.current) {
          serverRef.current.managedProcessIdentity = record;
        }
      },
    });
    const server: OpenCodeServerGeneration = {
      process: serverProcess,
      port,
      url,
      refCount: 0,
      retired: false,
      ready: Promise.resolve(),
      managedProcessRecord,
      managedProcessIdentity: capturedManagedProcessIdentity,
      ownsProcessGroup,
      ownsWindowsJob,
      windowsJobCompletion,
      identityToken,
      cleanupComplete: false,
    };
    serverRef.current = server;
    void managedProcessRecord
      .then((record) => {
        if (record && server.managedProcessRecord === managedProcessRecord) {
          server.managedProcessId = record.id;
          server.managedProcessIdentity = record;
        }
        return undefined;
      })
      .catch(() => undefined);

    let started = false;
    let settled = false;
    let stderrBuffer = "";
    let stdoutBuffer = "";
    let windowsJobProofBuffer = "";
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
        if (!settled) {
          failStartup(new Error(buildStartupErrorMessage("OpenCode server startup timeout")));
        }
      }, 30_000);

      serverProcess.stdout?.on("data", (data: Buffer) => {
        const output = data.toString();
        if (windowsJobProofMarker) {
          windowsJobProofBuffer = appendProofBuffer(windowsJobProofBuffer, output);
          if (windowsJobProofBuffer.includes(windowsJobProofMarker)) {
            resolveWindowsJobCompletion?.(true);
            resolveWindowsJobCompletion = undefined;
          }
        }
        stdoutBuffer = appendCapped(stdoutBuffer, output);
        if (output.includes("listening on") && !started && !settled) {
          started = true;
          void this.confirmManagedServerExecTransition(managedProcessRecord).then(() => {
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              resolve();
            }
            return undefined;
          }, failStartup);
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
        if (server.ownsProcessGroup) {
          // Members of the original group can outlive its leader. Keep the
          // generation strongly tracked until that group cleanup completes.
          server.retired = true;
          this.retiredServers.add(server);
          queueMicrotask(() => void this.killServer(server));
        } else if (!server.ownsWindowsJob && !this.terminationPromises.has(server)) {
          server.cleanupComplete = true;
          this.removeManagedServerRecord(server);
          this.finishServerCleanup(server);
        }
        if (!settled) {
          failStartup(
            new Error(buildStartupErrorMessage(`OpenCode server exited with code ${code}`)),
          );
        }
        if (this.currentServer?.process === serverProcess) {
          this.currentServer = null;
        }
      });
      serverProcess.on("close", () => {
        if (!server.ownsWindowsJob) {
          return;
        }
        resolveWindowsJobCompletion?.(false);
        resolveWindowsJobCompletion = undefined;
        if (!this.terminationPromises.has(server)) {
          void this.finishWindowsJobAfterExit(server);
        }
      });
      server.abortStartup = failStartup;
    });

    server.ready = ready.catch(async (error) => {
      await this.killServer(server);
      if (this.currentServer === server) {
        this.currentServer = null;
      }
      if (server.cleanupComplete) {
        this.retiredServers.delete(server);
      }
      throw error;
    });

    return server;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }
    const shutdown = this.shutdownOnce();
    const tracked = shutdown.finally(() => {
      if (this.shutdownPromise === tracked) {
        this.shutdownPromise = null;
      }
    });
    this.shutdownPromise = tracked;
    return tracked;
  }

  private async shutdownOnce(): Promise<void> {
    const servers = new Set<OpenCodeServerGeneration>([
      ...(this.currentServer ? [this.currentServer] : []),
      ...this.retiredServers,
    ]);
    for (const server of servers) {
      this.disableCleanupRetry(server);
    }
    const pendingResults = await Promise.allSettled(Array.from(this.pendingStarts));
    for (const result of pendingResults) {
      if (result.status === "fulfilled") {
        servers.add(result.value);
        this.disableCleanupRetry(result.value);
      }
    }
    await Promise.all(Array.from(servers, (server) => this.killServer(server)));
    this.currentServer = null;
    this.retiredServers.clear();
    for (const server of servers) {
      if (!server.cleanupComplete) {
        this.retiredServers.add(server);
      }
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
    if (server.cleanupComplete) {
      return;
    }
    server.retired = true;
    this.retiredServers.add(server);
    const existing = this.terminationPromises.get(server);
    if (existing) {
      return existing;
    }

    const termination = this.killServerOnce(server).finally(() => {
      this.terminationPromises.delete(server);
    });
    this.terminationPromises.set(server, termination);
    return termination;
  }

  private async killServerOnce(server: OpenCodeServerGeneration): Promise<void> {
    server.abortStartup?.(new Error("OpenCode server terminated during startup"));
    server.abortStartup = undefined;
    if (hasExitedWithoutContainer(server)) {
      server.cleanupComplete = true;
      this.removeManagedServerRecord(server);
      this.finishServerCleanup(server);
      return;
    }
    const managedProcessIdentity = server.managedProcessIdentity;
    const target = createServerTerminationTarget(server);
    const processGroupId = server.ownsProcessGroup ? server.process.pid : undefined;
    const identityToken = server.identityToken;
    const processGroupState: { inspection?: ManagedProcessGroupInspection } = {};
    let beforeSignal: (() => Promise<boolean>) | undefined;
    if (processGroupId && identityToken) {
      beforeSignal = async () => {
        const inspection = await this.verifyProcessGroupIdentity(processGroupId, identityToken);
        processGroupState.inspection = inspection;
        return inspection.status === "owned";
      };
    } else if (managedProcessIdentity) {
      beforeSignal = () => this.verifyProcessIdentity(managedProcessIdentity);
    }
    let result: Awaited<ReturnType<ProcessTerminator>>;
    try {
      result = await this.terminateProcess(target, {
        gracefulTimeoutMs: OPENCODE_SERVER_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
        forceTimeoutMs: OPENCODE_SERVER_FORCE_SHUTDOWN_TIMEOUT_MS,
        preserveRootOnTreeFailure: true,
        onForceSignal: () => {
          this.logger.warn(
            { timeoutMs: OPENCODE_SERVER_GRACEFUL_SHUTDOWN_TIMEOUT_MS },
            "OpenCode server did not exit after SIGTERM; sending SIGKILL",
          );
        },
        ...(beforeSignal ? { beforeSignal } : {}),
      });
    } catch (error) {
      this.logger.warn({ err: error }, "OpenCode server cleanup failed");
      await this.retainForCleanupRetry(server);
      return;
    }
    if (result === "signal-skipped" && processGroupState.inspection?.status === "not-found") {
      this.removeManagedServerRecord(server);
      server.cleanupComplete = true;
      this.finishServerCleanup(server);
      return;
    }
    if (result === "kill-timeout" || result === "signal-skipped") {
      this.logger.warn(
        { result, timeoutMs: OPENCODE_SERVER_FORCE_SHUTDOWN_TIMEOUT_MS },
        "OpenCode server cleanup did not complete",
      );
      if (
        result === "kill-timeout" ||
        (result === "signal-skipped" && processGroupState.inspection?.status !== "not-found")
      ) {
        await this.retainForCleanupRetry(server);
      }
      return;
    }
    await this.finishTerminatedServer(server);
  }

  private async finishTerminatedServer(server: OpenCodeServerGeneration): Promise<void> {
    if (server.ownsWindowsJob && !(await server.windowsJobCompletion)) {
      this.logger.warn(
        { pid: server.process.pid },
        "Windows OpenCode Job Object supervisor exited without proving the generation empty",
      );
      await this.retainForCleanupRetry(server);
      return;
    }
    if (server.managedProcessId) {
      await this.removeManagedProcessId(server.managedProcessId);
      server.managedProcessId = undefined;
      server.managedProcessRecord = undefined;
    } else {
      this.removeManagedServerRecord(server);
    }
    server.cleanupComplete = true;
    this.finishServerCleanup(server);
  }

  private async retainForCleanupRetry(server: OpenCodeServerGeneration): Promise<void> {
    server.retired = true;
    this.retiredServers.add(server);
    if (!server.managedProcessId && server.managedProcessIdentity && this.managedProcesses) {
      try {
        await this.managedProcesses.retain(server.managedProcessIdentity);
        server.managedProcessId = server.managedProcessIdentity.id;
        server.managedProcessRecord = Promise.resolve(server.managedProcessIdentity);
      } catch (error) {
        this.logger.warn(
          { err: error, pid: server.process.pid },
          "Failed to retain incomplete OpenCode helper cleanup in the managed-process ledger",
        );
      }
    }
    if (this.cleanupRetryTimers.has(server)) {
      return;
    }
    if (this.cleanupRetriesDisabled.has(server)) {
      return;
    }
    const timer = setTimeout(() => {
      this.cleanupRetryTimers.delete(server);
      void this.killServer(server);
    }, OPENCODE_SERVER_CLEANUP_RETRY_DELAY_MS);
    timer.unref();
    this.cleanupRetryTimers.set(server, timer);
  }

  private disableCleanupRetry(server: OpenCodeServerGeneration): void {
    this.cleanupRetriesDisabled.add(server);
    const retryTimer = this.cleanupRetryTimers.get(server);
    if (retryTimer) {
      clearTimeout(retryTimer);
      this.cleanupRetryTimers.delete(server);
    }
  }

  private finishServerCleanup(server: OpenCodeServerGeneration): void {
    const retryTimer = this.cleanupRetryTimers.get(server);
    if (retryTimer) {
      clearTimeout(retryTimer);
      this.cleanupRetryTimers.delete(server);
    }
    this.retiredServers.delete(server);
    this.runtimeCapacity?.release(server.process);
  }

  private async finishWindowsJobAfterExit(server: OpenCodeServerGeneration): Promise<void> {
    if (server.cleanupComplete || !(await server.windowsJobCompletion)) {
      if (!server.cleanupComplete) {
        await this.retainForCleanupRetry(server);
      }
      return;
    }
    server.cleanupComplete = true;
    this.removeManagedServerRecord(server);
    this.finishServerCleanup(server);
  }

  private async recordManagedServerProcess(options: {
    process: ChildProcess;
    command: string;
    args: string[];
    port: number;
    ownsProcessGroup: boolean;
    identityToken?: string;
    onIdentityCaptured: (record: ManagedProcessRecord) => void;
  }): Promise<ManagedProcessRecord | null> {
    const pid = options.process.pid;
    if (!this.managedProcesses || typeof pid !== "number" || pid <= 0) {
      return null;
    }

    return this.managedProcesses.record(
      {
        owner: { provider: "opencode", kind: "helper-server" },
        pid,
        command: options.command,
        args: options.args,
        metadata: { port: options.port },
        lifecycle: {
          execTransition: options.ownsProcessGroup ? "pending" : "none",
          terminationScope: options.ownsProcessGroup ? "process-group" : "process",
        },
        ...(options.identityToken ? { identityToken: options.identityToken } : {}),
      },
      { onIdentityCaptured: options.onIdentityCaptured },
    );
  }

  private async confirmManagedServerExecTransition(
    record: Promise<ManagedProcessRecord | null>,
  ): Promise<void> {
    const resolved = await record;
    if (resolved) {
      await this.managedProcesses?.confirmExecTransition(resolved.id);
    }
  }

  private removeManagedProcessRecordWhenResolved(
    record: Promise<ManagedProcessRecord | null>,
  ): void {
    void record
      .then((resolved) => {
        if (resolved) {
          return this.removeManagedProcessId(resolved.id);
        }
        return undefined;
      })
      .catch(() => undefined);
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

function createDirectChildTarget(process: ChildProcess): TreeKillTarget {
  return {
    get exitCode() {
      return process.exitCode;
    },
    get signalCode() {
      return process.signalCode;
    },
    kill: (signal) => process.kill(signal),
    once: (event, listener) => process.once(event, listener),
    off: (event, listener) => process.off(event, listener),
  };
}

function createServerTerminationTarget(server: OpenCodeServerGeneration): TreeKillTarget {
  if (server.ownsProcessGroup && server.process.pid) {
    return createProcessGroupTarget(server.process.pid);
  }
  if (server.ownsWindowsJob) {
    return createWindowsJobTarget(server.process);
  }
  return createDirectChildTarget(server.process);
}

function createWindowsJobTarget(process: ChildProcess): TreeKillTarget {
  return {
    get exitCode() {
      return process.exitCode;
    },
    get signalCode() {
      return process.signalCode;
    },
    kill: () => process.stdin?.write("terminate\n") ?? false,
    once: (event, listener) => process.once(event, listener),
    off: (event, listener) => process.off(event, listener),
  };
}

function appendProofBuffer(current: string, output: string): string {
  const proofBufferCap = 256;
  return (current + output).slice(-proofBufferCap);
}

function hasExitedWithoutContainer(server: OpenCodeServerGeneration): boolean {
  return !server.ownsProcessGroup && !server.ownsWindowsJob && hasProcessExited(server.process);
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
