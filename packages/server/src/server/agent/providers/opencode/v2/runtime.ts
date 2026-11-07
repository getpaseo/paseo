import { decorateOpenCodeV2Env, materializeOpenCodeV2Plugin } from "../bridge.js";
import { resolvePaseoHome } from "../../../../paseo-home.js";
import { OpenCode } from "@opencode/client";
import type { V2Api } from "./api.js";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import type { Logger } from "pino";
import { spawnProcess } from "../../../../../utils/spawn.js";
import { terminateWithTreeKill } from "../../../../../utils/tree-kill.js";
import {
  createProviderEnvSpec,
  resolveProviderLaunch,
  type ProviderRuntimeSettings,
} from "../../../provider-launch-config.js";
import type { ManagedProcessRegistry } from "../../../../managed-processes/managed-processes.js";
import { resolveOpenCodeHomeDir } from "../paths.js";
import { OpenCodeHttpError } from "../http-error.js";
import { raceProviderRefreshAbort } from "../../../provider-refresh-deadline.js";
import {
  SERVER_SCOPE_ENV,
  resolveExternalOpenCodeServer,
  resolveOpenCodeServerScope,
  type ExternalOpenCodeServer,
  type OpenCodeServerScope,
} from "./external-server.js";
import { selectOpenCodeService, type OpenCodeServiceSelection } from "./service-selection.js";
import { bridgeBindings, connectSharedService } from "./shared-service.js";
import {
  hasManagedBridge,
  openCodeConfigDirectory,
  provisionLocalBridge,
} from "./bridge-provisioning.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenCodeBridge } from "../bridge.js";

export interface V2Connection {
  client: V2Api;
  release(): Promise<void>;
  retain(): V2Connection;
  bindSession(sessionId: string, cwd: string): Promise<void>;
  unbindSession(sessionId: string, cwd: string): Promise<void>;
  refreshLocation(cwd: string, signal?: AbortSignal): Promise<void>;
  readonly exited: Promise<Error>;
}
interface Generation {
  client: V2Api;
  users: number;
  stop(): Promise<void>;
  exited: Promise<Error>;
  bindSession(sessionId: string, cwd: string): Promise<void>;
  unbindSession(sessionId: string, cwd: string): Promise<void>;
  refreshLocation(cwd: string, signal?: AbortSignal): Promise<void>;
}
export interface V2RuntimeOptions {
  logger: Logger;
  settings?: ProviderRuntimeSettings;
  managedProcesses?: ManagedProcessRegistry;
  externalServer?: ExternalOpenCodeServer;
  selection?: OpenCodeServiceSelection;
  bridge?: OpenCodeBridge;
}

export interface V2RuntimeAcquireOptions {
  fresh?: boolean;
  dedicated?: boolean;
  env?: Record<string, string>;
  /** The agent's workspace, which selects its helper when the scope is `workspace`. */
  workspaceId?: string | null;
  signal?: AbortSignal;
}

// The runtime owns a credential for each subprocess; sessions only receive its authenticated client.
export class V2Runtime {
  private current: Promise<Generation> | null = null;
  private generations = new Set<Generation>();
  private starts = new Set<Promise<Generation>>();
  private closed = false;
  // Helpers started for one workspace each, while the scope is `workspace`.
  private workspaces = new Map<string, Promise<Generation>>();
  // Helpers stopped because their last user released them, as opposed to exiting on their own.
  private readonly released = new WeakSet<Promise<Generation>>();
  private readonly selection: Promise<OpenCodeServiceSelection>;
  private readonly scope: OpenCodeServerScope;

  constructor(private readonly options: V2RuntimeOptions) {
    const env = { ...globalThis.process.env, ...options.settings?.env };
    this.scope = resolveOpenCodeServerScope(env);
    this.selection = options.selection
      ? Promise.resolve(options.selection)
      : selectOpenCodeService({
          explicit: options.externalServer ?? resolveExternalOpenCodeServer(env),
          env: options.settings?.env,
          scope: this.scope,
        });
    // A configuration error surfaces from acquire(); this keeps it from being unhandled until then.
    this.selection.catch(() => undefined);
  }

  async acquire(input: V2RuntimeAcquireOptions = {}): Promise<V2Connection> {
    // A workspace helper whose last user released it while this acquisition waited for it has
    // stopped; the second attempt starts a new one.
    const connection = (await this.acquireOnce(input)) ?? (await this.acquireOnce(input));
    if (!connection) throw new Error("OpenCode helper server exited");
    return connection;
  }

  private async acquireOnce(input: V2RuntimeAcquireOptions): Promise<V2Connection | null> {
    if (this.closed) throw new Error("OpenCode runtime is closed");
    input.signal?.throwIfAborted();
    this.assertBridgePort();
    const selection = await raceProviderRefreshAbort(input.signal, this.selection);
    const pending = this.pendingGeneration(input, selection);
    let generation: Generation;
    try {
      generation = await raceProviderRefreshAbort(input.signal, pending);
    } catch (error) {
      if (this.current === pending) this.current = null;
      if (input.signal?.aborted) {
        void pending
          .then(async (started) => {
            if (started.users !== 0) return undefined;
            this.generations.delete(started);
            await started.stop();
            return undefined;
          })
          .catch((cleanupError: unknown) => {
            this.options.logger.warn(
              { error: String(cleanupError) },
              "OpenCode canceled startup cleanup failed",
            );
          });
      }
      throw error;
    }
    if (!this.generations.has(generation)) {
      if (this.current === pending) this.current = null;
      if (this.released.has(pending)) return null;
      throw new Error("OpenCode helper server exited");
    }
    const connection = this.lease(generation, pending);
    if (input.signal?.aborted || this.closed) {
      await connection.release();
      input.signal?.throwIfAborted();
      throw new Error("OpenCode runtime is closed");
    }
    return connection;
  }

  private pendingGeneration(
    input: V2RuntimeAcquireOptions,
    selection: OpenCodeServiceSelection,
  ): Promise<Generation> {
    if (selection.kind !== "owned") {
      this.assertSharedConfiguration(input, selection);
      this.current ??= this.startTracked();
      return this.current;
    }
    if (input.env || input.dedicated)
      return this.startTracked(this.withWorkspace(input.env, input.workspaceId));
    if (this.scope === "workspace" && input.workspaceId)
      return this.workspaceHelper(input.workspaceId);
    this.current ??= this.startTracked();
    return this.current;
  }

  private assertBridgePort(): void {
    const port = this.options.settings?.env?.PASEO_OPENCODE_BRIDGE_PORT;
    if (!port || !this.options.bridge) return;
    const actual = new URL(this.options.bridge.sharedV2Connection().baseUrl).port;
    if (Number(port) !== Number(actual))
      throw new Error("PASEO_OPENCODE_BRIDGE_PORT changed; restart Paseo to apply the bridge port");
  }

  private assertSharedConfiguration(
    input: V2RuntimeAcquireOptions,
    selection: OpenCodeServiceSelection,
  ): void {
    const connectionEnv = new Set([
      "PASEO_OPENCODE_SERVER_URL",
      "PASEO_OPENCODE_SERVER_PASSWORD",
      "PASEO_OPENCODE_BRIDGE_URL",
      "PASEO_OPENCODE_BRIDGE_PORT",
      SERVER_SCOPE_ENV,
    ]);
    if (selection.kind === "discovered") {
      connectionEnv.add("XDG_CONFIG_HOME");
      connectionEnv.add("XDG_STATE_HOME");
      connectionEnv.add("OPENCODE_CONFIG_DIR");
    }
    const processOverrides = Object.keys(this.options.settings?.env ?? {}).filter(
      (key) => !connectionEnv.has(key),
    );
    if (input.env || input.dedicated || processOverrides.length) {
      throw new Error(
        `Custom OpenCode MCP servers or process environment require an isolated server and cannot be used with a shared OpenCode service${processOverrides.length ? `: ${processOverrides.join(", ")}` : ""}.`,
      );
    }
  }

  private lease(generation: Generation, pending: Promise<Generation>): V2Connection {
    if (this.closed || !this.generations.has(generation))
      throw new Error("OpenCode helper server is no longer running");
    generation.users += 1;
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      generation.users -= 1;
      if (generation.users !== 0) return;
      if (this.current === pending) return;
      this.forgetWorkspaceHelper(pending);
      this.released.add(pending);
      this.generations.delete(generation);
      await generation.stop();
    };
    return {
      client: generation.client,
      release,
      retain: () => this.lease(generation, pending),
      bindSession: generation.bindSession,
      unbindSession: generation.unbindSession,
      refreshLocation: generation.refreshLocation,
      exited: generation.exited,
    };
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(this.starts);
    await Promise.all([...this.generations].map((generation) => generation.stop()));
    this.generations.clear();
    this.workspaces.clear();
    this.current = null;
  }

  // Paseo's own helpers outside the shared scope learn their workspace, so a launch command
  // such as a sandbox wrapper can find it without per-agent environment.
  private withWorkspace(
    env: Record<string, string> | undefined,
    workspaceId: string | null | undefined,
  ): Record<string, string> | undefined {
    if (this.scope === "shared" || !workspaceId) return env;
    return { ...env, PASEO_WORKSPACE_ID: workspaceId };
  }

  private workspaceHelper(workspaceId: string): Promise<Generation> {
    const existing = this.workspaces.get(workspaceId);
    if (existing) return existing;
    const pending = this.startTracked({ PASEO_WORKSPACE_ID: workspaceId });
    this.workspaces.set(workspaceId, pending);
    const forget = () => this.forgetWorkspaceHelper(pending);
    void pending.then((generation) => generation.exited.then(forget), forget);
    return pending;
  }

  private forgetWorkspaceHelper(pending: Promise<Generation>): void {
    for (const [workspaceId, helper] of this.workspaces)
      if (helper === pending) this.workspaces.delete(workspaceId);
  }

  private startTracked(env?: Record<string, string>): Promise<Generation> {
    const pending = this.start(env);
    this.starts.add(pending);
    void pending.then(
      (generation) =>
        generation.exited.then(() => {
          if (this.current === pending) this.current = null;
          return undefined;
        }),
      () => undefined,
    );
    void pending.then(
      () => this.starts.delete(pending),
      () => this.starts.delete(pending),
    );
    return pending;
  }

  private async start(env: Record<string, string> = {}): Promise<Generation> {
    const selection = await this.selection;
    if (selection.kind !== "owned") {
      const generation: Generation = {
        ...(await connectSharedService(selection, this.options)),
        users: 0,
      };
      this.generations.add(generation);
      return generation;
    }

    const { settings, managedProcesses, logger } = this.options;
    const launch = await resolveProviderLaunch({
      commandConfig: settings?.command,
      defaultBinary: "opencode",
    });
    const cwd = resolveOpenCodeHomeDir();
    await mkdir(cwd, { recursive: true });
    const password = randomBytes(32).toString("base64url");
    const inheritedConfig = globalThis.process.env.OPENCODE_CONFIG_CONTENT;
    const configured = {
      ...(inheritedConfig ? { OPENCODE_CONFIG_CONTENT: inheritedConfig } : {}),
      ...settings?.env,
      ...env,
    };
    const bridge = this.options.bridge;
    const plugin = bridge
      ? await bridge.materializeV2Plugin()
      : await materializeOpenCodeV2Plugin(resolvePaseoHome());
    const globalConfig = openCodeConfigDirectory({ ...globalThis.process.env, ...configured });
    const managed = await hasManagedBridge(globalConfig);
    if (managed && bridge)
      await provisionLocalBridge({
        configDirectory: globalConfig,
        artifact: path.join(fileURLToPath(plugin), "server.js"),
      });
    const decorated = managed
      ? configured
      : decorateOpenCodeV2Env(configured, plugin, bridge ? {} : { mode: "structured-only" });
    const args = [...launch.args, "serve", "--hostname", "127.0.0.1", "--port", "0"];
    const process = spawnProcess(launch.command, args, {
      cwd,
      detached: globalThis.process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      ...createProviderEnvSpec({
        runtimeSettings: settings,
        overlays: [{ ...decorated, OPENCODE_PASSWORD: password }],
      }),
    });
    const processAbort = new AbortController();
    const exited = new Promise<Error>((resolve) =>
      process.once("exit", (code) => {
        const error = new Error(`OpenCode helper server exited (${code})`);
        processAbort.abort(error);
        resolve(error);
      }),
    );
    let stopped: Promise<void> | undefined;
    const record =
      process.pid && managedProcesses
        ? managedProcesses
            .record({
              owner: { provider: "opencode", kind: "helper-server" },
              pid: process.pid,
              command: launch.command,
              args,
            })
            .catch((error: unknown) => {
              logger.warn({ error }, "Could not record OpenCode helper process");
              return null;
            })
        : Promise.resolve(null);
    const stop = () => {
      stopped ??= (async () => {
        await terminateWithTreeKill(process, { gracefulTimeoutMs: 5_000, forceTimeoutMs: 1_000 });
        const entry = await record;
        if (entry) await managedProcesses?.remove(entry.id);
      })();
      return stopped;
    };
    const deadline = Date.now() + 30_000;
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => finish(new Error("OpenCode v2 server startup timed out after 30s")),
          30_000,
        );
        let buffer = "";
        const finish = (result: string | Error) => {
          clearTimeout(timer);
          process.stdout?.off("data", onData);
          process.off("error", onError);
          process.off("exit", onExit);
          if (result instanceof Error) reject(result);
          else resolve(result);
        };
        const onData = (chunk: Buffer) => {
          buffer = (buffer + chunk.toString()).slice(-8192);
          const match = buffer.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)(?:\r?\n)/);
          if (match) finish(match[1]);
        };
        const onError = (error: Error) => finish(error);
        const onExit = (code: number | null) =>
          finish(new Error(`OpenCode v2 server exited during startup (${code})`));
        process.stdout?.on("data", onData);
        process.once("error", onError);
        process.once("exit", onExit);
        // Drain stderr without retaining provider output that may contain credentials.
        process.stderr?.on("data", () => undefined);
      });
      const client = OpenCode.make({
        baseUrl: url,
        headers: {
          Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
        },
        fetch: async (request, init) => {
          const signal = init?.signal
            ? AbortSignal.any([init.signal, processAbort.signal])
            : processAbort.signal;
          const response = await fetch(request, { ...init, signal });
          const html = response.headers.get("content-type")?.includes("text/html") ?? false;
          if (!response.ok || html) {
            const requestUrl = request instanceof Request ? request.url : String(request);
            throw new OpenCodeHttpError(new URL(requestUrl).pathname, response.status, html);
          }
          return response;
        },
      });
      await client.server.info({ signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
      const generation: Generation = {
        client,
        users: 0,
        stop,
        exited,
        ...bridgeBindings(client, bridge),
      };
      this.generations.add(generation);
      process.once("exit", () => {
        this.generations.delete(generation);
        void stop().catch((error: unknown) =>
          logger.warn({ error }, "OpenCode process cleanup failed"),
        );
      });
      return generation;
    } catch (error) {
      await stop();
      throw error;
    }
  }
}
