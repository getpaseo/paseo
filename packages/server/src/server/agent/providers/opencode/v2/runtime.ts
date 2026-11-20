import { decorateOpenCodeV2Env, materializeOpenCodeV2Plugin } from "../bridge.js";
import { resolvePaseoHome } from "../../../../paseo-home.js";
import { OpenCode } from "@opencode/client";
import type { V2Api } from "./api.js";
import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
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
import { resolveExternalOpenCodeServer, type ExternalOpenCodeServer } from "./external-server.js";
import {
  compatibleVersion,
  selectOpenCodeService,
  type OpenCodeServiceSelection,
} from "./service-selection.js";
import { bridgeBindings, connectSharedService, type SharedService } from "./shared-service.js";
import {
  hasManagedBridge,
  openCodeConfigDirectory,
  provisionLocalBridge,
} from "./bridge-provisioning.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenCodeBridge } from "../bridge.js";
import { V2_SESSION_ENV_KEYS } from "./configuration.js";
import type { AgentOpenSupport, McpServerConfig } from "../../../agent-sdk-types.js";

function processEnvironment(env: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !V2_SESSION_ENV_KEYS.has(key)));
}

export interface V2Connection {
  client: V2Api;
  release(): Promise<void>;
  retain(input?: V2RuntimeAcquireOptions): V2Connection;
  reserveMcpServers(cwd: string, servers: Record<string, McpServerConfig>): void;
  commitMcpServers(cwd: string): void;
  bindSession(sessionId: string, cwd: string): Promise<void>;
  unbindSession(sessionId: string, cwd: string): Promise<void>;
  refreshLocation(cwd: string, signal?: AbortSignal): Promise<void>;
  readonly exited: Promise<Error>;
  retainPluginResources?(retain: () => () => Promise<void>): void;
}
interface Generation {
  client: V2Api;
  users: number;
  locations: Map<string, McpLocation>;
  stop(): Promise<void>;
  exited: Promise<Error>;
  bindSession(sessionId: string, cwd: string): Promise<void>;
  unbindSession(sessionId: string, cwd: string): Promise<void>;
  refreshLocation(cwd: string, signal?: AbortSignal): Promise<void>;
}
interface McpLocation {
  servers: Record<string, McpServerConfig>;
  users: number;
  // OpenCode keeps location registrations after a lease closes, including partial writes.
  committed: boolean;
}
interface TrackedStart {
  promise: Promise<Generation>;
  abort: AbortController;
  reservations: number;
  generation?: Generation;
  isolated: boolean;
  env: Record<string, string>;
}
export interface V2RuntimeOptions {
  logger: Logger;
  settings?: ProviderRuntimeSettings;
  managedProcesses?: ManagedProcessRegistry;
  externalServer?: ExternalOpenCodeServer;
  selection?: OpenCodeServiceSelection;
  bridge?: OpenCodeBridge;
  startup?: V2RuntimeStartup;
}

export interface V2RuntimeStartup {
  select(): Promise<OpenCodeServiceSelection>;
  start(input: {
    selection: OpenCodeServiceSelection;
    env: Record<string, string>;
    signal: AbortSignal;
  }): Promise<SharedService>;
}

export interface V2RuntimeAcquireOptions {
  fresh?: boolean;
  dedicated?: boolean;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

// The runtime owns a credential for each subprocess; sessions only receive its authenticated client.
export class V2Runtime {
  private current: TrackedStart | null = null;
  private generations = new Set<Generation>();
  private starts = new Set<TrackedStart>();
  private readonly lifetime = new AbortController();
  private closed = false;
  private readonly selection: Promise<OpenCodeServiceSelection>;

  constructor(private readonly options: V2RuntimeOptions) {
    this.selection = options.selection
      ? Promise.resolve(options.selection)
      : (options.startup?.select() ??
        selectOpenCodeService({
          explicit:
            options.externalServer ??
            resolveExternalOpenCodeServer({
              ...globalThis.process.env,
              ...options.settings?.env,
            }),
          env: options.settings?.env,
        }));
  }

  async describeRestrictions(signal?: AbortSignal): Promise<AgentOpenSupport["restrictions"]> {
    if (this.closed) throw new Error("OpenCode runtime is closed");
    signal?.throwIfAborted();
    const selection = await this.selection;
    signal?.throwIfAborted();
    const restriction = selection.kind === "explicit" ? "none" : "mutable";
    return { mcpConfiguration: restriction, processEnvironment: restriction };
  }

  async acquire(input: V2RuntimeAcquireOptions = {}): Promise<V2Connection> {
    if (this.closed) throw new Error("OpenCode runtime is closed");
    input.signal?.throwIfAborted();
    this.assertBridgePort();
    const signal = input.signal
      ? AbortSignal.any([input.signal, this.lifetime.signal])
      : this.lifetime.signal;
    let selection = await raceProviderRefreshAbort(signal, this.selection);
    signal.throwIfAborted();
    const isolated = Boolean(input.dedicated || Object.keys(processEnvironment(input.env)).length);
    const processOverrides = this.processOverrides(selection);
    if (selection.kind === "discovered" && (isolated || processOverrides.length)) {
      this.options.logger.info("Using an owned OpenCode helper for custom session settings");
      selection = { kind: "owned" };
    }
    let pending: TrackedStart;
    if (selection.kind !== "owned") {
      this.assertSharedConfiguration(input, selection);
      this.current ??= this.startTracked(selection);
      pending = this.current;
    } else if (isolated) {
      pending = this.startTracked(selection, input.env, true);
    } else {
      if (!this.current) this.current = this.startTracked(selection);
      pending = this.current;
    }
    pending.reservations += 1;
    try {
      const generation = await raceProviderRefreshAbort(signal, pending.promise);
      signal.throwIfAborted();
      if (!this.generations.has(generation)) {
        throw new Error("OpenCode helper server exited");
      }
      return this.lease(generation, pending);
    } finally {
      await this.releaseReservation(pending, signal);
    }
  }

  private async releaseReservation(pending: TrackedStart, signal: AbortSignal): Promise<void> {
    pending.reservations -= 1;
    if (pending.reservations) return;
    if (!pending.generation) {
      if (this.current === pending) this.current = null;
      pending.abort.abort(new Error("OpenCode startup has no remaining callers"));
    } else if (pending.generation.users === 0 && signal.aborted) {
      if (this.current === pending) this.current = null;
      await this.stopGeneration(pending.generation);
    }
  }

  private assertBridgePort(): void {
    const port = this.options.settings?.env?.PASEO_OPENCODE_BRIDGE_PORT;
    if (!port || !this.options.bridge) return;
    const actual = new URL(this.options.bridge.sharedV2Connection().baseUrl).port;
    if (Number(port) !== Number(actual))
      throw new Error("PASEO_OPENCODE_BRIDGE_PORT changed; restart Paseo to apply the bridge port");
  }

  private processOverrides(selection: OpenCodeServiceSelection): string[] {
    const connectionEnv = new Set([
      "PASEO_OPENCODE_SERVER_URL",
      "PASEO_OPENCODE_SERVER_PASSWORD",
      "PASEO_OPENCODE_BRIDGE_URL",
      "PASEO_OPENCODE_BRIDGE_PORT",
    ]);
    if (selection.kind === "discovered") {
      connectionEnv.add("XDG_CONFIG_HOME");
      connectionEnv.add("XDG_STATE_HOME");
      connectionEnv.add("OPENCODE_CONFIG_DIR");
    }
    return Object.keys(this.options.settings?.env ?? {}).filter((key) => !connectionEnv.has(key));
  }

  private assertSharedConfiguration(
    input: V2RuntimeAcquireOptions,
    selection: OpenCodeServiceSelection,
  ): void {
    const processOverrides = this.processOverrides(selection);
    if (
      Object.keys(processEnvironment(input.env)).length ||
      input.dedicated ||
      processOverrides.length
    ) {
      throw new Error(
        `Custom OpenCode MCP servers or process environment require an isolated server and cannot be used with a shared OpenCode service${processOverrides.length ? `: ${processOverrides.join(", ")}` : ""}.`,
      );
    }
  }

  private lease(
    generation: Generation,
    pending: TrackedStart,
    inheritedResources: Array<() => () => Promise<void>> = [],
  ): V2Connection {
    if (this.closed || !this.generations.has(generation))
      throw new Error("OpenCode helper server is no longer running");
    generation.users += 1;
    let released = false;
    const locations = new Map<string, McpLocation>();
    const resources = new Map<() => () => Promise<void>, () => Promise<void>>();
    for (const retain of inheritedResources) resources.set(retain, retain());
    const release = async () => {
      if (released) return;
      released = true;
      for (const [cwd, location] of locations) {
        location.users -= 1;
        if (!location.users && !location.committed) generation.locations.delete(cwd);
      }
      generation.users -= 1;
      const results = await Promise.allSettled([...resources.values()].map((cleanup) => cleanup()));
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length)
        throw new AggregateError(errors, "OpenCode plugin resource release failed");
      if (generation.users !== 0 || pending.reservations !== 0) return;
      if (this.current === pending) return;
      await this.stopGeneration(generation);
    };
    return {
      client: generation.client,
      release,
      retainPluginResources: (retain) => {
        if (released) throw new Error("OpenCode connection has been released");
        if (!resources.has(retain)) resources.set(retain, retain());
      },
      reserveMcpServers: (cwd, servers) => {
        if (released) throw new Error("OpenCode connection has been released");
        let location = generation.locations.get(cwd);
        if (location && !isDeepStrictEqual(location.servers, servers))
          throw new Error(
            "OpenCode retained connection cannot change MCP servers in the same location",
          );
        if (locations.has(cwd)) return;
        if (!location) {
          location = { servers: structuredClone(servers), users: 0, committed: false };
          generation.locations.set(cwd, location);
        }
        location.users += 1;
        locations.set(cwd, location);
      },
      commitMcpServers: (cwd) => {
        const location = locations.get(cwd);
        if (released || !location)
          throw new Error("OpenCode MCP location must be reserved before configuration");
        location.committed = true;
      },
      retain: (input = {}) => {
        if (released) throw new Error("OpenCode connection has been released");
        const env = processEnvironment(input.env);
        if ((input.dedicated || Object.keys(env).length) && !pending.isolated)
          throw new Error("OpenCode retained connection requires an isolated server");
        if (pending.isolated && !isDeepStrictEqual(env, pending.env))
          throw new Error("OpenCode retained connection cannot change process environment");
        return this.lease(generation, pending, [...resources.keys()]);
      },
      bindSession: generation.bindSession,
      unbindSession: generation.unbindSession,
      refreshLocation: generation.refreshLocation,
      exited: generation.exited,
    };
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    this.lifetime.abort(new Error("OpenCode runtime is closed"));
    for (const start of this.starts) start.abort.abort(this.lifetime.signal.reason);
    await Promise.allSettled([...this.starts].map((start) => start.promise));
    await Promise.all([...this.generations].map((generation) => this.stopGeneration(generation)));
    this.current = null;
  }

  private async stopGeneration(generation: Generation): Promise<void> {
    if (!this.generations.delete(generation)) return;
    await generation.stop();
  }

  private startTracked(
    selection: OpenCodeServiceSelection,
    env?: Record<string, string>,
    isolated = false,
  ): TrackedStart {
    const abort = new AbortController();
    const snapshot = { ...env };
    const pending: TrackedStart = {
      abort,
      reservations: 0,
      isolated,
      env: processEnvironment(snapshot),
      promise: Promise.resolve().then(async () => {
        abort.signal.throwIfAborted();
        const service = await (this.options.startup
          ? this.options.startup.start({ selection, env: snapshot, signal: abort.signal })
          : this.start(selection, snapshot, abort.signal));
        if (abort.signal.aborted) {
          await service.stop();
          abort.signal.throwIfAborted();
        }
        const generation: Generation = { ...service, users: 0, locations: new Map() };
        pending.generation = generation;
        this.generations.add(generation);
        void generation.exited.then(() => {
          this.generations.delete(generation);
          if (this.current === pending) this.current = null;
          return undefined;
        });
        return generation;
      }),
    };
    this.starts.add(pending);
    void pending.promise.then(
      () => this.starts.delete(pending),
      () => {
        this.starts.delete(pending);
        if (this.current === pending) this.current = null;
      },
    );
    return pending;
  }

  private async start(
    selection: OpenCodeServiceSelection,
    env: Record<string, string>,
    signal: AbortSignal,
  ): Promise<SharedService> {
    if (selection.kind !== "owned") {
      return connectSharedService(selection, this.options, signal);
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
    signal.throwIfAborted();
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
          signal.removeEventListener("abort", onAbort);
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
        const onAbort = () => finish(signal.reason);
        process.stdout?.on("data", onData);
        process.once("error", onError);
        process.once("exit", onExit);
        signal.addEventListener("abort", onAbort, { once: true });
        // Drain stderr without retaining provider output that may contain credentials.
        process.stderr?.on("data", () => undefined);
      });
      const client = OpenCode.make({
        baseUrl: url,
        headers: {
          Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
        },
        fetch: async (request, init) => {
          const requestSignal = init?.signal
            ? AbortSignal.any([init.signal, processAbort.signal])
            : processAbort.signal;
          const response = await fetch(request, { ...init, signal: requestSignal });
          const html = response.headers.get("content-type")?.includes("text/html") ?? false;
          if (!response.ok || html) {
            const requestUrl = request instanceof Request ? request.url : String(request);
            throw new OpenCodeHttpError(new URL(requestUrl).pathname, response.status, html);
          }
          return response;
        },
      });
      const info = await client.server.info({
        signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]),
      });
      if (!compatibleVersion(info.version))
        throw new Error(
          `Unsupported OpenCode version ${info.version}; version 2.0.10 or newer is required`,
        );
      const generation: SharedService = {
        client,
        stop,
        exited,
        ...bridgeBindings(client, bridge),
      };
      process.once("exit", () => {
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
