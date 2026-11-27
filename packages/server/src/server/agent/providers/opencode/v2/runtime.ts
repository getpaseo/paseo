import { decorateOpenCodeV2Env, materializeOpenCodeV2Plugin } from "../bridge.js";
import { resolvePaseoHome } from "../../../../paseo-home.js";
import { OpenCode } from "@opencode/client";
import type { V2Api } from "./api.js";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import type { Logger } from "pino";
import type { LaunchWrap } from "../../../../../utils/launch-wrap.js";
import { spawnProcess } from "../../../../../utils/spawn.js";
import { terminateWithTreeKill } from "../../../../../utils/tree-kill.js";
import {
  createProviderEnvSpec,
  resolveProviderLaunch,
  type ProviderRuntimeSettings,
} from "../../../provider-launch-config.js";
import type { ManagedProcessRegistry } from "../../../../managed-processes/managed-processes.js";
import { resolveOpenCodeHomeDir } from "../paths.js";
import { validateOpenCodeResponse } from "./http-response.js";
import { raceProviderRefreshAbort } from "../../../provider-refresh-deadline.js";
import { resolveExternalOpenCodeServer, type ExternalOpenCodeServer } from "./external-server.js";
import {
  processEnvironmentOverrides,
  selectOpenCodeService,
  type OpenCodeServiceSelection,
} from "./service-selection.js";
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
  /** True when releasing this lease would stop the server, with every execution inside it. */
  releaseStopsServer(): boolean;
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

/** A server started for one caller alone, behind its wrap and with its launch environment. */
export interface V2DedicatedLaunch {
  wrap: LaunchWrap;
  env: Record<string, string> | undefined;
}

export interface V2RuntimeAcquireOptions {
  fresh?: boolean;
  signal?: AbortSignal;
  /** Start a server for this caller alone. Other callers never share it. */
  dedicated?: V2DedicatedLaunch;
}

// The runtime owns a credential for each subprocess; sessions only receive its authenticated client.
export class V2Runtime {
  private current: Promise<Generation> | null = null;
  private generations = new Set<Generation>();
  private starts = new Set<Promise<Generation>>();
  private closed = false;
  private readonly selection: Promise<OpenCodeServiceSelection>;

  constructor(private readonly options: V2RuntimeOptions) {
    this.selection = options.selection
      ? Promise.resolve(options.selection)
      : selectOpenCodeService({
          explicit:
            options.externalServer ??
            resolveExternalOpenCodeServer({
              ...globalThis.process.env,
              ...options.settings?.env,
            }),
          env: options.settings?.env,
        });
  }

  async acquire(input: V2RuntimeAcquireOptions = {}): Promise<V2Connection> {
    if (this.closed) throw new Error("OpenCode runtime is closed");
    input.signal?.throwIfAborted();
    this.assertBridgePort();
    const selection = await raceProviderRefreshAbort(input.signal, this.selection);
    if (selection.kind === "explicit") this.assertExplicitConfiguration();
    const pending = input.dedicated
      ? this.startTracked(input.dedicated)
      : (this.current ??= this.startTracked());
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

  private assertBridgePort(): void {
    const port = this.options.settings?.env?.PASEO_OPENCODE_BRIDGE_PORT;
    if (!port || !this.options.bridge) return;
    const actual = new URL(this.options.bridge.sharedV2Connection().baseUrl).port;
    if (Number(port) !== Number(actual))
      throw new Error("PASEO_OPENCODE_BRIDGE_PORT changed; restart Paseo to apply the bridge port");
  }

  // Discovery skips a service that cannot honor the provider environment; an explicit one cannot be skipped.
  private assertExplicitConfiguration(): void {
    const overrides = processEnvironmentOverrides(this.options.settings?.env);
    if (overrides.length)
      throw new Error(
        `OpenCode provider environment configures the server process and cannot be used with an existing OpenCode server: ${overrides.join(", ")}.`,
      );
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
      this.generations.delete(generation);
      await generation.stop();
    };
    return {
      client: generation.client,
      release,
      retain: () => this.lease(generation, pending),
      releaseStopsServer: () => !released && generation.users === 1 && this.current !== pending,
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
    this.current = null;
  }

  private startTracked(dedicated?: V2DedicatedLaunch): Promise<Generation> {
    const pending = this.start(dedicated);
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

  private async start(dedicated: V2DedicatedLaunch | undefined): Promise<Generation> {
    const selection = await this.selection;
    if (dedicated && selection.kind === "explicit")
      throw new Error(
        "OpenCode is configured to use an existing server, so Paseo cannot start it behind a launch wrap",
      );
    // A discovered server is only a preference; a wrapped caller gets a server Paseo starts.
    if (selection.kind !== "owned" && !dedicated) {
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
      ...dedicated?.env,
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
      wrap: dedicated?.wrap,
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
          return validateOpenCodeResponse(request, response);
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
