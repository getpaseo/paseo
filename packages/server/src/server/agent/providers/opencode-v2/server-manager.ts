import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { V2Event } from "@opencode-ai/client";
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
import { resolveOpenCodeV2HomeDir } from "./paths.js";

/** Budget for the opencode2 HTTP server to become usable after spawn. */
export const OPENCODE_V2_SERVER_STARTUP_TIMEOUT_MS = 30_000;
/** One stalled SSE attempt plus enough time for the consumer's retry. */
export const OPENCODE_V2_EVENT_STREAM_READY_TIMEOUT_MS = 45_000;
const OPENCODE_V2_SERVER_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 5_000;
const OPENCODE_V2_SERVER_FORCE_SHUTDOWN_TIMEOUT_MS = 1_000;

export type OpenCodeV2EventSourceInput =
  | { type: "server-exited"; error: Error }
  | { type: "reconnected" }
  | { type: "event"; event: V2Event };

export interface OpenCodeV2EventSource {
  ready(): Promise<void>;
  subscribe(listener: (input: OpenCodeV2EventSourceInput) => void): () => void;
  close(): Promise<void>;
}

export interface OpenCodeV2EventSourceFactoryOptions {
  serverUrl: string;
  password: string;
  authorization: string;
  processExit: Promise<Error>;
  logger: Pick<Logger, "debug" | "warn">;
}

export type OpenCodeV2EventConsumerFactory = (
  options: OpenCodeV2EventSourceFactoryOptions,
) => OpenCodeV2EventSource;

export interface OpenCodeV2ServerAcquisition {
  server: {
    port: number;
    url: string;
    password: string;
    authorization: string;
  };
  events: OpenCodeV2EventSource;
  release: () => Promise<void>;
}

export interface OpenCodeV2ServerManagerLike {
  acquireCurrent(signal?: AbortSignal): Promise<OpenCodeV2ServerAcquisition>;
  acquireNew(signal?: AbortSignal): Promise<OpenCodeV2ServerAcquisition>;
  acquireDedicated(env: Record<string, string>): Promise<OpenCodeV2ServerAcquisition>;
  acquireExisting(url: string): OpenCodeV2ServerAcquisition | null;
  shutdown(): Promise<void>;
}

export interface OpenCodeV2ServerGeneration {
  process: ChildProcess;
  port: number;
  url: string;
  password: string;
  authorization: string;
  refCount: number;
  retired: boolean;
  ready: Promise<void>;
  events: OpenCodeV2EventSource;
  managedProcessId?: string;
  managedProcessRecord?: Promise<{ id: string } | null>;
}

export type OpenCodeV2PortAllocator = () => Promise<number>;
export type OpenCodeV2CommandPrefixResolver = () => Promise<{ command: string; args: string[] }>;
export type OpenCodeV2ServerProcessSpawner = (
  command: string,
  args: string[],
  options: SpawnProcessOptions,
) => ChildProcess;

export interface OpenCodeV2ServerManagerOptions {
  logger: Logger;
  baseEnv?: SpawnProcessOptions["baseEnv"];
  runtimeSettings?: ProviderRuntimeSettings;
  managedProcesses?: ManagedProcessRegistry;
  terminateProcess?: ProcessTerminator;
  portAllocator?: OpenCodeV2PortAllocator;
  resolveCommandPrefix?: OpenCodeV2CommandPrefixResolver;
  resolveHomeDir?: () => string;
  /** Resolve the real user's opencode2 auth file to seed into the isolated home. */
  resolveCredentialSourcePath?: () => string;
  spawnServerProcess?: OpenCodeV2ServerProcessSpawner;
  createEventSource?: OpenCodeV2EventConsumerFactory;
}

export class OpenCodeV2ServerManager implements OpenCodeV2ServerManagerLike {
  private static instance: OpenCodeV2ServerManager | null = null;
  private static exitHandlerRegistered = false;
  private currentServer: OpenCodeV2ServerGeneration | null = null;
  private retiredServers = new Set<OpenCodeV2ServerGeneration>();
  private startPromise: Promise<OpenCodeV2ServerGeneration> | null = null;
  private newServerPromise: Promise<OpenCodeV2ServerGeneration> | null = null;
  private readonly logger: Logger;
  private readonly baseEnv?: SpawnProcessOptions["baseEnv"];
  private readonly runtimeSettings?: ProviderRuntimeSettings;
  private readonly runtimeSettingsKey: string;
  private readonly managedProcesses?: ManagedProcessRegistry;
  private readonly terminateProcess: ProcessTerminator;
  private readonly portAllocator: OpenCodeV2PortAllocator;
  private readonly resolveCommandPrefix: OpenCodeV2CommandPrefixResolver;
  private readonly resolveHomeDir: () => string;
  private readonly resolveCredentialSourcePath: () => string;
  private readonly spawnServerProcess: OpenCodeV2ServerProcessSpawner;
  private readonly createEventSource: OpenCodeV2EventConsumerFactory;

  constructor(options: OpenCodeV2ServerManagerOptions) {
    this.logger = options.logger;
    this.baseEnv = options.baseEnv;
    this.runtimeSettings = options.runtimeSettings;
    this.runtimeSettingsKey = JSON.stringify(this.runtimeSettings ?? {});
    this.managedProcesses = options.managedProcesses;
    this.terminateProcess = options.terminateProcess ?? terminateWithTreeKill;
    this.portAllocator = options.portAllocator ?? findAvailablePort;
    this.resolveCommandPrefix =
      options.resolveCommandPrefix ??
      (() => resolveProviderCommandPrefix(this.runtimeSettings?.command, resolveOpenCodeV2Binary));
    this.resolveHomeDir =
      options.resolveHomeDir ??
      (() => {
        // Honor an explicit PASEO_HOME in the provider runtime-settings env so
        // tests (and users) can point the isolated opencode2 home at a temp
        // dir instead of the real user's ~/.paseo. Otherwise fall back to the
        // daemon process env.
        const env = this.runtimeSettings?.env;
        if (env && typeof env.PASEO_HOME === "string" && env.PASEO_HOME.trim().length > 0) {
          return resolveOpenCodeV2HomeDir(env);
        }
        return resolveOpenCodeV2HomeDir();
      });
    this.resolveCredentialSourcePath =
      options.resolveCredentialSourcePath ?? resolveOpenCodeV2CredentialSourcePath;
    this.spawnServerProcess = options.spawnServerProcess ?? spawnProcess;
    this.createEventSource =
      options.createEventSource ?? ((input) => new OpenCodeV2ServerEventSource(input));
  }

  static getInstance(
    logger: Logger,
    runtimeSettings?: ProviderRuntimeSettings,
    options: Omit<OpenCodeV2ServerManagerOptions, "logger" | "runtimeSettings"> = {},
  ): OpenCodeV2ServerManager {
    const nextSettingsKey = JSON.stringify(runtimeSettings ?? {});
    if (!OpenCodeV2ServerManager.instance) {
      OpenCodeV2ServerManager.instance = new OpenCodeV2ServerManager({
        logger,
        runtimeSettings,
        ...options,
      });
      OpenCodeV2ServerManager.registerExitHandler();
    } else if (OpenCodeV2ServerManager.instance.runtimeSettingsKey !== nextSettingsKey) {
      logger.warn(
        {
          existingRuntimeSettings: OpenCodeV2ServerManager.instance.runtimeSettingsKey,
          requestedRuntimeSettings: nextSettingsKey,
        },
        "OpenCode 2 server manager already initialized with different runtime settings",
      );
    }
    return OpenCodeV2ServerManager.instance;
  }

  private static registerExitHandler(): void {
    if (OpenCodeV2ServerManager.exitHandlerRegistered) {
      return;
    }
    OpenCodeV2ServerManager.exitHandlerRegistered = true;

    const cleanup = () => {
      const instance = OpenCodeV2ServerManager.instance;
      void instance?.shutdown();
    };

    process.on("exit", cleanup);
    process.on("SIGTERM", cleanup);
    process.on("SIGINT", cleanup);
  }

  async acquireCurrent(signal?: AbortSignal): Promise<OpenCodeV2ServerAcquisition> {
    signal?.throwIfAborted();
    const server = await waitForServerAcquisition(this.getCurrentServer(), signal);
    signal?.throwIfAborted();
    return this.acquireServer(server);
  }

  async acquireNew(signal?: AbortSignal): Promise<OpenCodeV2ServerAcquisition> {
    signal?.throwIfAborted();
    const server = await waitForServerAcquisition(this.getNewServer(), signal);
    signal?.throwIfAborted();
    return this.acquireServer(server);
  }

  async acquireDedicated(env: Record<string, string>): Promise<OpenCodeV2ServerAcquisition> {
    const server = await this.startServer(env);
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

  acquireExisting(url: string): OpenCodeV2ServerAcquisition | null {
    const server = this.findLiveServerByUrl(url);
    return server ? this.acquireServer(server) : null;
  }

  private findLiveServerByUrl(url: string): OpenCodeV2ServerGeneration | null {
    const servers = [
      ...(this.currentServer ? [this.currentServer] : []),
      ...Array.from(this.retiredServers),
    ];
    return servers.find((server) => server.url === url && this.isServerLive(server)) ?? null;
  }

  private isServerLive(server: OpenCodeV2ServerGeneration): boolean {
    return (
      !server.process.killed &&
      server.process.exitCode === null &&
      server.process.signalCode === null
    );
  }

  private acquireServer(server: OpenCodeV2ServerGeneration): OpenCodeV2ServerAcquisition {
    server.refCount += 1;
    let releasePromise: Promise<void> | null = null;
    return {
      server: {
        port: server.port,
        url: server.url,
        password: server.password,
        authorization: server.authorization,
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

  private async releaseServer(server: OpenCodeV2ServerGeneration): Promise<void> {
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

  private async getNewServer(): Promise<OpenCodeV2ServerGeneration> {
    if (this.newServerPromise) {
      return this.newServerPromise;
    }

    this.newServerPromise = Promise.resolve()
      .then(async () => {
        await this.rotateCurrentServer();
        const server = await this.startServer();
        if (!server.retired) {
          this.currentServer = server;
        }
        await server.ready;
        return server;
      })
      .finally(() => {
        this.newServerPromise = null;
      });
    return this.newServerPromise;
  }

  private async getCurrentServer(): Promise<OpenCodeV2ServerGeneration> {
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

  private async startServer(
    launchEnv?: Record<string, string>,
  ): Promise<OpenCodeV2ServerGeneration> {
    const port = await this.portAllocator();
    const url = `http://127.0.0.1:${port}`;
    const password = generateServerPassword();
    const authorization = buildBasicAuthHeader(password);
    const launchPrefix = await this.resolveCommandPrefix();
    const serverArgs = [...launchPrefix.args, "serve", "--port", String(port)];
    // Run the server from an isolated opencode2 home so its config, data, and
    // cache never touch the user's real opencode config. HOME plus the XDG dirs
    // are pinned under $PASEO_HOME/opencode2-home.
    const serverCwd = this.resolveHomeDir();
    mkdirSync(serverCwd, { recursive: true });
    const dataHome = path.join(serverCwd, ".local", "share");
    // Seed the user's real opencode2 credentials (auth.json) into the isolated
    // home's data dir so credentialed-provider models (Baseten, OpenAI) work
    // through the daemon. Runtime-only, never committed; no-op if absent.
    this.seedCredentialsIntoIsolatedHome(dataHome);
    const serverEnv: Record<string, string> = {
      OPENCODE_PASSWORD: password,
      HOME: serverCwd,
      XDG_CONFIG_HOME: path.join(serverCwd, ".config"),
      XDG_DATA_HOME: dataHome,
      XDG_CACHE_HOME: path.join(serverCwd, ".cache"),
    };

    const serverProcess = this.spawnServerProcess(launchPrefix.command, serverArgs, {
      cwd: serverCwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      ...createProviderEnvSpec({
        baseEnv: this.baseEnv,
        runtimeSettings: this.runtimeSettings,
        overlays: [launchEnv, serverEnv],
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
    const server: OpenCodeV2ServerGeneration = {
      process: serverProcess,
      port,
      url,
      password,
      authorization,
      refCount: 0,
      retired: false,
      ready: Promise.resolve(),
      events: this.createEventSource({
        serverUrl: url,
        password,
        authorization,
        processExit,
        logger: this.logger,
      }),
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
          failStartup(new Error(buildStartupErrorMessage("OpenCode 2 server startup timeout")));
        }
      }, OPENCODE_V2_SERVER_STARTUP_TIMEOUT_MS);

      serverProcess.stdout?.on("data", (data: Buffer) => {
        const output = data.toString();
        stdoutBuffer = appendCapped(stdoutBuffer, output);
        if (output.includes("server listening on") && !settled) {
          started = true;
          settled = true;
          clearTimeout(timeout);
          resolve();
        }
      });

      serverProcess.stderr?.on("data", (data: Buffer) => {
        const output = data.toString();
        stderrBuffer = appendCapped(stderrBuffer, output);
        this.logger.error({ stderr: output.trim() }, "OpenCode 2 server stderr");
      });

      serverProcess.on("error", (error) => {
        const headline = error instanceof Error ? error.message : String(error);
        failStartup(new Error(buildStartupErrorMessage(headline)));
      });

      serverProcess.on("exit", (code) => {
        resolveProcessExit(new Error(`OpenCode 2 server exited with code ${code}`));
        this.removeManagedServerRecord(server);
        if (!started) {
          failStartup(
            new Error(buildStartupErrorMessage(`OpenCode 2 server exited with code ${code}`)),
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

    server.ready = ready
      .then(() => this.seedCredentialsIntoDatabase(dataHome))
      .catch(async (error) => {
        await this.killServer(server);
        if (this.currentServer === server) {
          this.currentServer = null;
        }
        this.retiredServers.delete(server);
        throw error;
      });

    return server;
  }

  private seedCredentialsIntoIsolatedHome(dataHome: string): void {
    const source = this.resolveCredentialSourcePath();
    if (!existsSync(source)) {
      this.logger.debug({ source }, "OpenCode 2 credential source not found; skipping seeding");
      return;
    }
    const targetDir = path.join(dataHome, "opencode");
    const target = path.join(targetDir, "auth.json");
    try {
      mkdirSync(targetDir, { recursive: true });
      copyFileSync(source, target);
      this.logger.debug({ source, target }, "Seeded OpenCode 2 credentials into the isolated home");
    } catch (error) {
      this.logger.warn(
        { err: error, source, target },
        "Failed to seed OpenCode 2 credentials into the isolated home",
      );
    }
  }

  /**
   * beta-18155 stores credentials in the isolated home's SQLite database, not
   * just auth.json: a fresh database bootstraps with every migration marked
   * complete, so the legacy auth.json import never runs. After the server is
   * ready (its database exists), copy the credential rows in directly so
   * credentialed-provider models (Baseten, OpenAI) work through the daemon.
   * Graceful no-op when the source auth file or the database is missing.
   */
  private async seedCredentialsIntoDatabase(dataHome: string): Promise<void> {
    const source = this.resolveCredentialSourcePath();
    if (!existsSync(source)) {
      return; // the file-copy step already logged the skip
    }
    const dbPath = path.join(dataHome, "opencode", "opencode.db");
    if (!existsSync(dbPath)) {
      this.logger.debug(
        { dbPath },
        "OpenCode 2 database not found; skipping credential DB seeding",
      );
      return;
    }
    try {
      const sqlite = await loadOpenCodeV2NodeSqlite();
      if (!sqlite) {
        this.logger.debug("node:sqlite unavailable; skipping OpenCode 2 credential DB seeding");
        return;
      }
      const auth = JSON.parse(readFileSync(source, "utf8")) as Record<string, unknown>;
      const db = new sqlite.DatabaseSync(dbPath);
      try {
        const now = Date.now();
        for (const [integrationID, raw] of Object.entries(auth)) {
          const value = toOpenCodeV2CredentialValue(integrationID, raw);
          if (!value) continue;
          const existing = db
            .prepare("SELECT id FROM credential WHERE integration_id = ?")
            .get(integrationID);
          if (existing) continue;
          db.prepare(
            "INSERT INTO credential (id, integration_id, label, value, time_created, time_updated) VALUES (?, ?, 'default', ?, ?, ?)",
          ).run(
            `cred_${randomBytes(12).toString("hex")}`,
            integrationID,
            JSON.stringify(value),
            now,
            now,
          );
        }
      } finally {
        db.close();
      }
      this.logger.debug(
        { dbPath },
        "Seeded OpenCode 2 credentials into the isolated home database",
      );
    } catch (error) {
      this.logger.warn(
        { err: error, dbPath },
        "Failed to seed OpenCode 2 credentials into the isolated home database",
      );
    }
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

  private async killServer(server: OpenCodeV2ServerGeneration): Promise<void> {
    await server.events.close();
    if (
      (server.process.exitCode !== null && server.process.exitCode !== undefined) ||
      (server.process.signalCode !== null && server.process.signalCode !== undefined)
    ) {
      return;
    }
    const result = await this.terminateProcess(server.process, {
      gracefulTimeoutMs: OPENCODE_V2_SERVER_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
      forceTimeoutMs: OPENCODE_V2_SERVER_FORCE_SHUTDOWN_TIMEOUT_MS,
      onForceSignal: () => {
        this.logger.warn(
          { timeoutMs: OPENCODE_V2_SERVER_GRACEFUL_SHUTDOWN_TIMEOUT_MS },
          "OpenCode 2 server did not exit after SIGTERM; sending SIGKILL",
        );
      },
    });
    if (result === "kill-timeout") {
      this.logger.warn(
        { timeoutMs: OPENCODE_V2_SERVER_FORCE_SHUTDOWN_TIMEOUT_MS },
        "OpenCode 2 server did not report exit after SIGKILL",
      );
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
        owner: { provider: "opencode-v2", kind: "helper-server" },
        pid,
        command: options.command,
        args: options.args,
        metadata: { port: options.port },
      });
    } catch (error) {
      this.logger.warn(
        { err: error, pid, port: options.port },
        "Failed to record opencode2 helper process",
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

  private removeManagedServerRecord(server: OpenCodeV2ServerGeneration): void {
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
      this.logger.warn({ err: error, id }, "Failed to remove opencode2 helper process record");
    }
  }
}

/**
 * Minimal default event source. The session-core feature replaces this with the
 * real SSE-backed OpenCodeV2EventConsumer via the createEventSource factory; this
 * default only surfaces server-exit so sessions can detect a mid-session crash.
 */
class OpenCodeV2ServerEventSource implements OpenCodeV2EventSource {
  private readonly listeners = new Set<(input: OpenCodeV2EventSourceInput) => void>();
  private readonly readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private closed = false;

  constructor(options: OpenCodeV2EventSourceFactoryOptions) {
    this.readyPromise = new Promise<void>((resolve) => {
      this.resolveReady = resolve;
    });
    void options.processExit.then((error) => this.exit(error));
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  subscribe(listener: (input: OpenCodeV2EventSourceInput) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    this.resolveReady();
  }

  private exit(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.publish({ type: "server-exited", error });
    this.listeners.clear();
  }

  private publish(input: OpenCodeV2EventSourceInput): void {
    for (const listener of this.listeners) {
      try {
        listener(input);
      } catch {
        // A session callback cannot tear down the generation-owned transport.
      }
    }
  }
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

function generateServerPassword(): string {
  return randomBytes(24).toString("base64url");
}

export function buildBasicAuthHeader(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`;
}

/**
 * The real user's opencode2 auth file, read from the daemon process env. The
 * isolated home pins XDG_DATA_HOME, which would otherwise hide these stored
 * credentials; the server manager seeds this file into the isolated home so
 * credentialed-provider models (Baseten, OpenAI) work through the daemon.
 */
export function resolveOpenCodeV2CredentialSourcePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const dataHome = env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "opencode", "auth.json");
}

// @types/node@20 predates the node:sqlite typings; declare the slice we use.
// The runtime (Node 22+ / Electron) provides it. Mirrors quota-fetcher/cursor.ts.
interface OpenCodeV2CredentialStatement {
  get(...params: unknown[]): { id?: string } | undefined;
  run(...params: unknown[]): unknown;
}
interface OpenCodeV2CredentialDatabase {
  prepare(sql: string): OpenCodeV2CredentialStatement;
  close(): void;
}
interface OpenCodeV2NodeSqliteModule {
  DatabaseSync: new (path: string) => OpenCodeV2CredentialDatabase;
}

async function loadOpenCodeV2NodeSqlite(): Promise<OpenCodeV2NodeSqliteModule | null> {
  const sqliteSpecifier: string = "node:sqlite";
  try {
    return (await import(sqliteSpecifier)) as unknown as OpenCodeV2NodeSqliteModule;
  } catch {
    return null; // runtime without node:sqlite
  }
}

/**
 * Convert a legacy auth.json entry into the credential value stored in the
 * opencode2 database. Mirrors opencode2's legacy-credential import: `api` keys
 * become `key` credentials and `oauth` entries become `oauth` credentials with
 * the integration's method id.
 */
export function toOpenCodeV2CredentialValue(
  integrationID: string,
  raw: unknown,
): Record<string, unknown> | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.type === "api" && typeof record.key === "string") {
    return { type: "key", key: record.key };
  }
  if (
    record.type === "oauth" &&
    typeof record.refresh === "string" &&
    typeof record.access === "string" &&
    typeof record.expires === "number"
  ) {
    const value: Record<string, unknown> = {
      type: "oauth",
      methodID: resolveOpenCodeV2CredentialMethodID(integrationID),
      refresh: record.refresh,
      access: record.access,
      expires: record.expires,
    };
    if (typeof record.accountId === "string") {
      value.metadata = { accountID: record.accountId };
    }
    return value;
  }
  return undefined;
}

function resolveOpenCodeV2CredentialMethodID(integrationID: string): string {
  if (integrationID === "openai") return "chatgpt-browser";
  if (["github-copilot", "opencode", "xai"].includes(integrationID)) return "device";
  return "oauth";
}

async function resolveOpenCodeV2Binary(): Promise<string> {
  const found = await findExecutable("opencode2");
  if (!found) {
    throw new Error(
      "OpenCode 2 binary not found. Install opencode2 and ensure it is available in your shell PATH.",
    );
  }

  if (process.platform === "win32" && path.extname(found).toLowerCase() === ".cmd") {
    // Global npm: <prefix>/opencode2.cmd → <prefix>/node_modules/@opencode-ai/cli/bin/opencode2.exe
    const globalCandidate = path.join(
      path.dirname(found),
      "node_modules",
      "@opencode-ai",
      "cli",
      "bin",
      "opencode2.exe",
    );
    if (await pathExists(globalCandidate)) return globalCandidate;

    // Local/pnpm: <project>/node_modules/.bin/opencode2.cmd → <project>/node_modules/@opencode-ai/cli/bin/opencode2.exe
    const localCandidate = path.join(
      path.dirname(found),
      "..",
      "@opencode-ai",
      "cli",
      "bin",
      "opencode2.exe",
    );
    if (await pathExists(localCandidate)) return localCandidate;

    console.warn(
      "[opencode2-server] Found opencode2.cmd but could not resolve the real opencode2.exe. " +
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
