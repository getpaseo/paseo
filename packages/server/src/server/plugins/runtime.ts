import { fork } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type pino from "pino";
import type { PluginLogEntry } from "@getpaseo/protocol/messages";
import { compilePlugin } from "./compiler.js";
import { readPluginManifest } from "./manifest.js";
import {
  validatePluginProcessMessage,
  validatePluginProcessRequest,
  type PluginProcessMessage,
  type PluginProcessRequest,
  type PluginToolCallerContext,
  type PluginToolCatalogEntry,
} from "./plugin-process-protocol.js";
import {
  PLUGIN_TOOL_MAX_CONCURRENT_GLOBAL,
  PLUGIN_TOOL_MAX_CONCURRENT_PER_PLUGIN,
  PLUGIN_TOOL_CANCEL_GRACE_MS,
  PLUGIN_TOOL_MAX_CATALOG_SCHEMA_BYTES,
  PLUGIN_TOOL_MAX_CATALOG_TOOLS,
  PLUGIN_TOOL_MAX_DESCRIPTION_BYTES,
  PLUGIN_TOOL_MAX_NAME_BYTES,
  PLUGIN_TOOL_MAX_RESULT_BYTES,
  PLUGIN_TOOL_MAX_SCHEMA_BYTES,
  PLUGIN_TOOL_MAX_TITLE_BYTES,
  PLUGIN_TOOL_MAX_TIMEOUT_MS,
  PLUGIN_TOOL_MAX_UPDATE_BYTES,
  PLUGIN_TOOL_NAME_PATTERN,
  assertSafeJson,
  assertSafePluginToolText,
  assertPluginToolCatalogBytes,
  assertSupportedJsonSchema,
  isReservedPluginToolName,
  truncateUtf8,
} from "./plugin-tool.js";
import { PluginSessionSocket } from "./session-socket.js";
import { terminateWithTreeKill, type ProcessTerminator } from "../../utils/tree-kill.js";

const ENTRY_FILENAME = "index.ts";
// COMPAT(plugin-index-tsx): added in v0.4, remove after 2027-02-17
const LEGACY_ENTRY_FILENAME = "index.tsx";
const REQUEST_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 2_000;
const MAX_LOG_ENTRIES = 500;
const MAX_LOG_BYTES = 256 * 1024;
const MAX_LOG_LINE_BYTES = 16 * 1024;

interface PluginOutputStream {
  on(event: "data", listener: (chunk: Buffer | string) => void): this;
}

interface PluginChild {
  connected: boolean;
  killed: boolean;
  pid?: number;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  stdout?: PluginOutputStream | null;
  stderr?: PluginOutputStream | null;
  send(message: PluginProcessRequest, callback?: (error: Error | null) => void): boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
  disconnect(): void;
  once?(event: "exit", listener: () => void): unknown;
  on(event: "message", listener: (message: PluginProcessMessage) => void): this;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

interface PendingInvocation {
  resolve: (output: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout> | null;
  cancelTimeout: ReturnType<typeof setTimeout> | null;
  kind: "rpc" | "tool";
  onUpdate?: (update: unknown) => void;
  cleanup?: () => void;
  callerSettled: boolean;
  cancellationRequested: boolean;
  onComplete?: () => void;
}

interface LoadedPlugin {
  id: string;
  generation: number;
  installationId: string;
  clientBundle: string;
  methods: ReadonlySet<string>;
  tools: ReadonlyMap<string, PluginToolCatalogEntry>;
  child: PluginChild;
  outputCapture: PluginOutputCapture;
  pending: Map<string, PendingInvocation>;
  sessionSocket: PluginSessionSocket;
  sessionClosed: Promise<void>;
  childClosed: Promise<void>;
  childClosedObserved: () => boolean;
  quarantined: boolean;
}

interface PluginRuntimeDependencies {
  spawnChild?: () => PluginChild;
  terminateProcess?: ProcessTerminator;
  sessionHost?: PluginPaseoSessionHost;
  resolveToolContext?: (callerAgentId: string) => Promise<PluginToolCallerContext>;
}

interface PluginLogTail {
  entries: PluginLogEntry[];
  bytes: number;
  nextSequence: number;
}

class PluginOutputCapture {
  private readonly pending = new Map<PluginLogEntry["stream"], Buffer>([
    ["stdout", Buffer.alloc(0)],
    ["stderr", Buffer.alloc(0)],
  ]);
  private readonly overflowed = new Set<PluginLogEntry["stream"]>();
  private readonly lastActivity = new Map<PluginLogEntry["stream"], number>();
  private activitySequence = 0;
  private flushed = false;

  constructor(
    child: PluginChild,
    private readonly emit: (stream: PluginLogEntry["stream"], message: string) => void,
  ) {
    child.stdout?.on("data", (chunk) => this.write("stdout", chunk));
    child.stderr?.on("data", (chunk) => this.write("stderr", chunk));
    child.on("close", () => this.flush());
  }

  private write(stream: PluginLogEntry["stream"], chunk: Buffer | string): void {
    if (this.flushed) return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < data.length) {
      const newline = data.indexOf(0x0a, offset);
      const end = newline === -1 ? data.length : newline;
      this.append(stream, data.subarray(offset, end));
      if (newline === -1) return;
      this.emitLine(stream);
      offset = newline + 1;
    }
  }

  private append(stream: PluginLogEntry["stream"], chunk: Buffer): void {
    if (chunk.length > 0) this.lastActivity.set(stream, ++this.activitySequence);
    const current = this.pending.get(stream) ?? Buffer.alloc(0);
    const remaining = MAX_LOG_LINE_BYTES - current.length;
    if (chunk.length > remaining) this.overflowed.add(stream);
    if (remaining <= 0) return;
    this.pending.set(stream, Buffer.concat([current, chunk.subarray(0, remaining)]));
  }

  private emitLine(stream: PluginLogEntry["stream"]): void {
    let line = this.pending.get(stream) ?? Buffer.alloc(0);
    if (!this.overflowed.has(stream) && line.at(-1) === 0x0d) line = line.subarray(0, -1);
    this.emit(stream, line.toString("utf8"));
    this.pending.set(stream, Buffer.alloc(0));
    this.overflowed.delete(stream);
    this.lastActivity.delete(stream);
  }

  private flush(): void {
    if (this.flushed) return;
    this.flushed = true;
    const pendingStreams = (["stdout", "stderr"] as const)
      .filter(
        (stream) => (this.pending.get(stream)?.length ?? 0) > 0 || this.overflowed.has(stream),
      )
      .sort(
        (left, right) => (this.lastActivity.get(left) ?? 0) - (this.lastActivity.get(right) ?? 0),
      );
    for (const stream of pendingStreams) {
      this.emitLine(stream);
    }
  }
}

export interface PluginPaseoSessionHost {
  /** Fence durable delivery dispatch before the plugin process is stopped. */
  beginPluginShutdown?(pluginId: string): void;
  attachPluginSocket(
    pluginId: string,
    socket: PluginSessionSocket,
  ): Promise<{ closed: Promise<void> }>;
}

function resolveWorkerUrl(): URL {
  return new URL(
    import.meta.url.endsWith(".ts") ? "./plugin-process.ts" : "./plugin-process.js",
    import.meta.url,
  );
}

function resolveWorkerExecArgv(): string[] {
  if (!import.meta.url.endsWith(".ts")) return [];
  const loaderUrl = new URL("../../terminal/terminal-ts-loader.mjs", import.meta.url).href;
  const importSource = [
    'import { register } from "node:module";',
    'import { pathToFileURL } from "node:url";',
    `register(${JSON.stringify(loaderUrl)}, pathToFileURL("./"));`,
  ].join(" ");
  return [
    "--experimental-strip-types",
    "--import",
    `data:text/javascript,${encodeURIComponent(importSource)}`,
  ];
}

function spawnPluginChild(): PluginChild {
  return fork(fileURLToPath(resolveWorkerUrl()), [], {
    execArgv: resolveWorkerExecArgv(),
    serialization: "advanced",
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  }) as PluginChild;
}

function terminatePluginChild(child: PluginChild): void {
  try {
    if (child.connected) child.disconnect();
  } catch {
    // Cleanup races must not mask the original plugin failure.
  }
  if (child.killed) return;
  try {
    child.kill();
  } catch {
    // Cleanup races must not mask the original plugin failure.
  }
}

function canObservePluginExit(child: PluginChild): boolean {
  return typeof child.pid === "number" || typeof child.once === "function";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function send(child: PluginChild, message: PluginProcessRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    let validated: PluginProcessRequest;
    try {
      validated = validatePluginProcessRequest(message);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    child.send(validated, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function resolveEntryPath(directory: string): Promise<string> {
  for (const filename of [ENTRY_FILENAME, LEGACY_ENTRY_FILENAME]) {
    const filePath = path.join(directory, filename);
    const info = await stat(filePath).catch(() => null);
    if (info?.isFile()) return filePath;
  }
  throw new Error(`Plugin entry point is missing: ${path.join(directory, ENTRY_FILENAME)}`);
}

export class PluginRuntime {
  private readonly plugins = new Map<string, LoadedPlugin>();
  private readonly logTails = new Map<string, PluginLogTail>();
  private readonly logger: pino.Logger;
  private readonly spawnChild: () => PluginChild;
  private readonly terminateProcess: ProcessTerminator;
  private sessionHost: PluginPaseoSessionHost | null;
  private resolveToolContext: ((callerAgentId: string) => Promise<PluginToolCallerContext>) | null;
  private readonly listeners = new Set<(pluginId: string, error?: string) => void>();
  private readonly nextGenerations = new Map<string, number>();
  private activeToolInvocations = 0;
  private readonly activeToolInvocationsByPlugin = new Map<string, number>();
  private readonly closingPlugins = new Map<string, Set<Promise<void>>>();
  private readonly closingPluginOperations = new WeakMap<
    LoadedPlugin,
    { stop: Promise<void>; closed: Promise<void> }
  >();

  constructor(
    logger: pino.Logger,
    private readonly daemonVersion: string,
    dependencies: PluginRuntimeDependencies = {},
  ) {
    this.logger = logger.child({ module: "plugins" });
    this.spawnChild = dependencies.spawnChild ?? spawnPluginChild;
    this.terminateProcess = dependencies.terminateProcess ?? terminateWithTreeKill;
    this.sessionHost = dependencies.sessionHost ?? null;
    this.resolveToolContext = dependencies.resolveToolContext ?? null;
  }

  bindToolContextResolver(
    resolver: (callerAgentId: string) => Promise<PluginToolCallerContext>,
  ): void {
    this.resolveToolContext = resolver;
  }

  bindPaseoSessionHost(sessionHost: PluginPaseoSessionHost): void {
    if (this.plugins.size > 0)
      throw new Error("Cannot replace the plugin session host while running");
    this.sessionHost = sessionHost;
  }

  subscribe(listener: (pluginId: string, error?: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async startPlugin(
    pluginId: string,
    configuredPath: string,
    canPublish: () => boolean = () => true,
  ): Promise<void> {
    await this.waitForPluginClosing(pluginId);
    if (this.plugins.has(pluginId)) throw new Error(`Plugin is already running: ${pluginId}`);
    this.appendLog(pluginId, "stdout", "[paseo] Loading plugin");
    const loaded = await this.loadDirectoryPlugin(pluginId, configuredPath).catch((error) => {
      this.appendLog(pluginId, "stderr", `[paseo] Plugin failed to load: ${describeError(error)}`);
      throw error;
    });
    if (!canPublish()) {
      await this.trackPluginClosing(loaded);
      throw new Error(`Plugin start cancelled: ${pluginId}`);
    }
    try {
      this.assertAggregateToolCatalogWithinLimits([...this.plugins.values(), loaded]);
    } catch (error) {
      await this.trackPluginClosing(loaded);
      throw error;
    }
    this.plugins.set(pluginId, loaded);
    this.appendLog(pluginId, "stdout", "[paseo] Plugin ready");
  }

  async validatePlugin(configuredPath: string): Promise<void> {
    const directory = path.resolve(configuredPath);
    await readPluginManifest(directory);
    const entryPath = await resolveEntryPath(directory);
    await compilePlugin(entryPath);
  }

  async stopPluginById(pluginId: string): Promise<boolean> {
    const loaded = this.plugins.get(pluginId);
    if (!loaded) return false;
    this.sessionHost?.beginPluginShutdown?.(pluginId);
    this.plugins.delete(pluginId);
    this.rejectPending(loaded, `Plugin stopped: ${pluginId}`);
    await this.trackPluginClosing(loaded);
    return true;
  }

  catalog(): Array<{ id: string; clientBundle: string }> {
    return [...this.plugins.values()]
      .map(({ id, clientBundle }) => ({ id, clientBundle }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  toolCatalog(): PluginToolCatalogEntry[] {
    const tools: PluginToolCatalogEntry[] = [];
    for (const plugin of this.plugins.values()) {
      for (const tool of plugin.tools.values()) tools.push(Object.assign({}, tool));
    }
    const sorted = tools.sort(
      (left, right) =>
        left.name.localeCompare(right.name) || left.pluginId.localeCompare(right.pluginId),
    );
    this.assertAggregateToolCatalogWithinLimits([...this.plugins.values()], sorted.length, sorted);
    return sorted;
  }

  getLogs(pluginId: string): PluginLogEntry[] {
    return (
      this.logTails.get(pluginId)?.entries.map((entry) => ({
        sequence: entry.sequence,
        timestamp: entry.timestamp,
        stream: entry.stream,
        message: entry.message,
      })) ?? []
    );
  }

  clearLogs(pluginId: string): void {
    this.logTails.delete(pluginId);
  }

  async invoke(pluginId: string, method: string, input: unknown): Promise<unknown> {
    const loaded = this.plugins.get(pluginId);
    if (!loaded) throw new Error(`Plugin is not available: ${pluginId}`);
    if (!loaded.methods.has(method))
      throw new Error(`Plugin ${pluginId} does not contribute RPC ${method}`);
    return this.invokeChild(loaded, {
      type: "invoke",
      method,
      input,
    });
  }

  async invokeTool(
    pluginId: string,
    name: string,
    input: unknown,
    options: {
      generation?: number;
      installationId?: string;
      callerAgentId: string;
      signal?: AbortSignal;
      onUpdate?: (update: unknown) => void;
    },
  ): Promise<unknown> {
    const loaded = this.plugins.get(pluginId);
    if (
      !loaded ||
      (options.generation !== undefined && loaded.generation !== options.generation) ||
      (options.installationId !== undefined && loaded.installationId !== options.installationId)
    ) {
      throw new Error(`Plugin tool is no longer available: ${pluginId}.${name}`);
    }
    const tool = loaded.tools.get(name);
    if (!tool) throw new Error(`Plugin ${pluginId} does not contribute tool ${name}`);
    if (!this.resolveToolContext) throw new Error("Plugin tool caller context is unavailable");
    if (this.activeToolInvocations >= PLUGIN_TOOL_MAX_CONCURRENT_GLOBAL) {
      throw new Error("Plugin tool global concurrency limit reached");
    }
    const pluginActive = this.activeToolInvocationsByPlugin.get(pluginId) ?? 0;
    if (pluginActive >= PLUGIN_TOOL_MAX_CONCURRENT_PER_PLUGIN) {
      throw new Error(`Plugin tool concurrency limit reached: ${pluginId}`);
    }
    this.activeToolInvocations += 1;
    this.activeToolInvocationsByPlugin.set(pluginId, pluginActive + 1);
    const release = (): void => {
      this.activeToolInvocations = Math.max(0, this.activeToolInvocations - 1);
      const remaining = (this.activeToolInvocationsByPlugin.get(pluginId) ?? 1) - 1;
      if (remaining <= 0) this.activeToolInvocationsByPlugin.delete(pluginId);
      else this.activeToolInvocationsByPlugin.set(pluginId, remaining);
    };
    try {
      assertSafeJson(input, "Plugin tool input", PLUGIN_TOOL_MAX_RESULT_BYTES);
      const context = await this.resolveToolContext(options.callerAgentId);
      if (
        this.plugins.get(pluginId) !== loaded ||
        (options.generation !== undefined && loaded.generation !== options.generation) ||
        (options.installationId !== undefined && loaded.installationId !== options.installationId)
      ) {
        throw new Error(`Plugin tool is no longer available: ${pluginId}.${name}`);
      }
      const result = this.invokeChild(
        loaded,
        { type: "tool_invoke", name, input, context },
        tool.timeoutMs,
        {
          kind: "tool",
          signal: options.signal,
          onUpdate: options.onUpdate,
          onComplete: release,
        },
      );
      return result;
    } catch (error) {
      release();
      throw error;
    }
  }

  async stopAll(): Promise<void> {
    const loaded = [...this.plugins.values()];
    for (const plugin of loaded) this.sessionHost?.beginPluginShutdown?.(plugin.id);
    this.plugins.clear();
    for (const plugin of loaded) {
      this.rejectPending(plugin, `Plugin stopped: ${plugin.id}`);
    }
    await Promise.all(loaded.map((plugin) => this.trackPluginClosing(plugin)));
    await this.waitForAllPluginClosingsBounded(STOP_TIMEOUT_MS);
  }

  private async loadDirectoryPlugin(
    pluginId: string,
    configuredPath: string,
  ): Promise<LoadedPlugin> {
    const directory = path.resolve(configuredPath);
    await readPluginManifest(directory);
    const entryPath = await resolveEntryPath(directory);
    const bundles = await compilePlugin(entryPath);
    const sessionHost = this.sessionHost;
    if (!sessionHost) throw new Error("Plugin Paseo session host is not attached");
    const child = this.spawnChild();
    const outputCapture = new PluginOutputCapture(child, (stream, message) => {
      this.appendLog(pluginId, stream, message);
    });
    const sessionSocket = new PluginSessionSocket(child);
    const pending = new Map<string, PendingInvocation>();
    let loaded: LoadedPlugin | null = null;
    let childClosedObserved = false;
    let resolveChildClosed!: () => void;
    const childClosed = new Promise<void>((resolve) => {
      resolveChildClosed = () => {
        if (childClosedObserved) return;
        childClosedObserved = true;
        resolve();
      };
    });
    sessionSocket.on("error", (error) => {
      const reason = `Plugin session transport failed: ${describeError(error)}`;
      if (loaded) {
        this.quarantinePlugin(loaded, reason);
      } else {
        terminatePluginChild(child);
      }
    });
    const sessionAttachment = await sessionHost
      .attachPluginSocket(pluginId, sessionSocket)
      .catch((error) => {
        terminatePluginChild(child);
        throw error;
      });
    const generation = (this.nextGenerations.get(pluginId) ?? 0) + 1;
    this.nextGenerations.set(pluginId, generation);
    const installationId = randomUUID();
    let ready: { methods: string[]; catalog: PluginToolCatalogEntry[] };
    try {
      ready = await new Promise<{ methods: string[]; catalog: PluginToolCatalogEntry[] }>(
        (resolve, reject) => {
          let settled = false;
          const timeout = setTimeout(
            () => fail(new Error(`Plugin ${pluginId} did not initialize`)),
            REQUEST_TIMEOUT_MS,
          );
          const fail = (error: Error): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            reject(error);
          };
          child.on("message", (rawMessage) => {
            let message: PluginProcessMessage;
            try {
              message = validatePluginProcessMessage(rawMessage);
            } catch (error) {
              const invalidMessage = new Error(
                `Invalid plugin process message: ${describeError(error)}`,
              );
              if (loaded) {
                this.quarantinePlugin(loaded, invalidMessage.message);
              } else {
                fail(invalidMessage);
                terminatePluginChild(child);
              }
              return;
            }
            if (message.type === "paseo_frame") {
              sessionSocket.receive(message.data, message.isBinary);
            } else if (message.type === "paseo_close") {
              sessionSocket.peerClosed();
            } else if (message.type === "ready") {
              if (settled) return;
              settled = true;
              clearTimeout(timeout);
              resolve({ methods: message.methods, catalog: message.catalog ?? [] });
            } else if (message.type === "fatal") {
              fail(new Error(message.error));
            } else if (loaded) {
              this.handleChildMessage(loaded, message);
            }
          });
          child.on("close", () => {
            resolveChildClosed();
            sessionSocket.peerClosed();
            if (!loaded) {
              fail(new Error(`Plugin ${pluginId} exited during initialization`));
              return;
            }
            void this.handleChildClose(loaded);
          });
          void send(child, {
            type: "initialize",
            pluginId,
            appVersion: this.daemonVersion,
            generation,
            installationId,
            bundle: bundles.serverBundle,
          }).catch(fail);
        },
      );
    } catch (error) {
      sessionSocket.close();
      await sessionAttachment.closed;
      terminatePluginChild(child);
      throw error;
    }
    let tools: ReadonlyMap<string, PluginToolCatalogEntry>;
    try {
      tools = this.validateToolCatalog(pluginId, generation, installationId, ready.catalog);
      const conflict = [...tools.keys()]
        .sort()
        .map((name) => ({ name, kind: this.toolNameConflict(name) }))
        .find((entry) => entry.kind !== null);
      if (conflict?.kind === "reserved") {
        throw new Error(`Plugin tool name is reserved: ${conflict.name}`);
      }
      if (conflict?.kind === "duplicate") {
        throw new Error(`Duplicate plugin tool name across plugins: ${conflict.name}`);
      }
    } catch (error) {
      sessionSocket.close();
      await sessionAttachment.closed;
      terminatePluginChild(child);
      throw error;
    }
    loaded = {
      id: pluginId,
      generation,
      installationId,
      clientBundle: bundles.clientBundle,
      methods: new Set(ready.methods),
      tools,
      child,
      outputCapture,
      pending,
      sessionSocket,
      sessionClosed: sessionAttachment.closed,
      childClosed,
      childClosedObserved: () => childClosedObserved,
      quarantined: false,
    };
    this.logger.info(
      { pluginId, generation, installationId, methods: ready.methods },
      "Loaded plugin",
    );
    return loaded;
  }

  private handleChildMessage(loaded: LoadedPlugin, message: PluginProcessMessage): void {
    if (
      message.type !== "result" &&
      message.type !== "error" &&
      message.type !== "tool_result" &&
      message.type !== "tool_error" &&
      message.type !== "tool_update" &&
      message.type !== "tool_cancel_ack"
    ) {
      return;
    }
    const pending = loaded.pending.get(message.requestId);
    if (!pending) return;
    if (message.type === "tool_cancel_ack") {
      if (pending.kind === "tool" && pending.cancellationRequested) {
        this.finishPending(loaded, message.requestId, pending);
      }
      return;
    }
    if (message.type === "tool_update") {
      if (pending.kind !== "tool" || !pending.onUpdate) return;
      try {
        assertSafeJson(message.update, "Plugin tool progress update", PLUGIN_TOOL_MAX_UPDATE_BYTES);
      } catch (error) {
        this.logger.debug(
          { err: error, pluginId: loaded.id },
          "Dropped invalid plugin tool update",
        );
        return;
      }
      try {
        pending.onUpdate(message.update);
      } catch (error) {
        this.logger.debug(
          { err: error, pluginId: loaded.id },
          "Plugin tool update consumer failed",
        );
      }
      return;
    }
    this.finishPending(loaded, message.requestId, pending, () => {
      if (pending.cancellationRequested) return;
      if (message.type === "result" || message.type === "tool_result")
        pending.resolve(message.output);
      else pending.reject(new Error(message.error));
    });
  }

  private async handleChildClose(loaded: LoadedPlugin): Promise<void> {
    loaded.sessionSocket.peerClosed();
    const wasPublished = this.plugins.get(loaded.id) === loaded;
    if (wasPublished) {
      this.plugins.delete(loaded.id);
    }
    this.rejectPending(loaded, `Plugin process exited: ${loaded.id}`, true);
    await loaded.sessionClosed;
    if (wasPublished) this.notify(loaded.id, `Plugin process exited: ${loaded.id}`);
  }

  private async stopPlugin(loaded: LoadedPlugin): Promise<void> {
    this.appendLog(loaded.id, "stdout", "[paseo] Stopping plugin");
    if (!loaded.child.killed && loaded.child.connected) {
      await send(loaded.child, { type: "shutdown" }).catch(() => undefined);
    }
    await Promise.race([
      loaded.childClosed,
      new Promise<void>((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS)),
    ]);

    if (!loaded.childClosedObserved() && !loaded.child.killed) {
      if (canObservePluginExit(loaded.child)) {
        const result = await this.terminateProcess(loaded.child, {
          gracefulTimeoutMs: STOP_TIMEOUT_MS,
          forceTimeoutMs: STOP_TIMEOUT_MS,
          onForceSignal: () => {
            this.logger.warn(
              { pluginId: loaded.id },
              "Plugin process did not exit after graceful shutdown; forcing termination",
            );
          },
        }).catch((error) => {
          this.logger.warn(
            { err: error, pluginId: loaded.id },
            "Failed to terminate plugin process tree",
          );
          return "kill-timeout" as const;
        });
        if (result === "kill-timeout") {
          this.logger.warn({ pluginId: loaded.id }, "Plugin process did not report termination");
          terminatePluginChild(loaded.child);
        }
      } else {
        // Deterministic fakes and unusual child wrappers may expose neither a
        // usable PID nor an exit event. Kill the direct child and keep the
        // closing operation fenced until a real close notification arrives.
        terminatePluginChild(loaded.child);
      }
    }

    // Do not leave callers or concurrency slots waiting for a close event that
    // a forced or test child can never emit. The child-close promise remains
    // unresolved so a replacement cannot reuse an unquiesced installation.
    if (!loaded.childClosedObserved()) {
      this.rejectPending(loaded, `Plugin stopped: ${loaded.id}`, true);
    }
    loaded.sessionSocket.peerClosed();
    await Promise.race([
      loaded.sessionClosed,
      new Promise<void>((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS)),
    ]);
    this.appendLog(loaded.id, "stdout", "[paseo] Plugin stopped");
  }

  private rejectPending(loaded: LoadedPlugin, message: string, childGone = false): void {
    for (const [requestId, invocation] of loaded.pending) {
      if (invocation.timeout) clearTimeout(invocation.timeout);
      invocation.timeout = null;
      if (invocation.cancelTimeout) clearTimeout(invocation.cancelTimeout);
      invocation.cancelTimeout = null;
      invocation.cancellationRequested = true;
      invocation.cleanup?.();
      if (!invocation.callerSettled) {
        invocation.callerSettled = true;
        invocation.reject(new Error(message));
      }
      if (invocation.kind === "tool" && !childGone) {
        void send(loaded.child, { type: "tool_cancel", requestId }).catch(() => undefined);
      }
    }
    if (childGone) {
      for (const [requestId, invocation] of loaded.pending) {
        this.finishPending(loaded, requestId, invocation);
      }
    }
  }

  private finishPending(
    loaded: LoadedPlugin,
    requestId: string,
    invocation: PendingInvocation,
    settleCaller?: () => void,
  ): void {
    if (loaded.pending.get(requestId) !== invocation) return;
    loaded.pending.delete(requestId);
    if (invocation.timeout) clearTimeout(invocation.timeout);
    if (invocation.cancelTimeout) clearTimeout(invocation.cancelTimeout);
    invocation.timeout = null;
    invocation.cancelTimeout = null;
    invocation.cleanup?.();
    if (settleCaller && !invocation.callerSettled) {
      invocation.callerSettled = true;
      settleCaller();
    }
    invocation.onComplete?.();
  }

  private requestCancellation(
    loaded: LoadedPlugin,
    requestId: string,
    invocation: PendingInvocation,
    reason: Error,
  ): void {
    if (loaded.pending.get(requestId) !== invocation || invocation.cancellationRequested) return;
    invocation.cancellationRequested = true;
    if (invocation.timeout) clearTimeout(invocation.timeout);
    invocation.timeout = null;
    invocation.cleanup?.();
    if (!invocation.callerSettled) {
      invocation.callerSettled = true;
      invocation.reject(reason);
    }
    invocation.cancelTimeout = setTimeout(() => {
      if (loaded.pending.get(requestId) !== invocation) return;
      this.quarantinePlugin(
        loaded,
        `Plugin ${loaded.id} did not acknowledge tool cancellation within ${PLUGIN_TOOL_CANCEL_GRACE_MS}ms`,
      );
    }, PLUGIN_TOOL_CANCEL_GRACE_MS);
    void send(loaded.child, { type: "tool_cancel", requestId }).catch((error) => {
      this.quarantinePlugin(loaded, `Plugin cancellation delivery failed: ${describeError(error)}`);
    });
  }

  private quarantinePlugin(loaded: LoadedPlugin, reason: string): void {
    if (loaded.quarantined) return;
    loaded.quarantined = true;
    if (this.plugins.get(loaded.id) === loaded) {
      this.plugins.delete(loaded.id);
      this.sessionHost?.beginPluginShutdown?.(loaded.id);
      this.notify(loaded.id, reason);
    }
    this.rejectPending(loaded, reason);
    void this.trackPluginClosing(loaded);
  }

  private async trackPluginClosing(loaded: LoadedPlugin): Promise<void> {
    const existingOperation = this.closingPluginOperations.get(loaded);
    if (existingOperation) {
      await existingOperation.stop;
      return;
    }
    const closing = this.closingPlugins.get(loaded.id) ?? new Set<Promise<void>>();
    const stop = this.stopPlugin(loaded).catch((error) => {
      this.logger.warn({ err: error, pluginId: loaded.id }, "Failed to stop plugin process");
    });
    const closed = stop.then(() => loaded.childClosed);
    closing.add(closed);
    this.closingPlugins.set(loaded.id, closing);
    this.closingPluginOperations.set(loaded, { stop, closed });
    void closed.then(() => {
      if (closing.delete(closed) && closing.size === 0) {
        this.closingPlugins.delete(loaded.id);
      }
      return undefined;
    });
    await stop;
  }

  private async waitForPluginClosing(pluginId: string): Promise<void> {
    const closing = this.closingPlugins.get(pluginId);
    if (!closing || closing.size === 0) return;
    await Promise.allSettled(closing);
  }

  private async waitForAllPluginClosingsBounded(timeoutMs: number): Promise<void> {
    const closing: Promise<void>[] = [];
    for (const operations of this.closingPlugins.values()) closing.push(...operations);
    if (closing.length === 0) return;
    await Promise.race([
      Promise.allSettled(closing),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  private invokeChild(
    loaded: LoadedPlugin,
    request:
      | { type: "invoke"; method: string; input: unknown }
      | { type: "tool_invoke"; name: string; input: unknown; context: PluginToolCallerContext },
    timeoutMs: number = REQUEST_TIMEOUT_MS,
    options: {
      kind?: "rpc" | "tool";
      signal?: AbortSignal;
      onUpdate?: (update: unknown) => void;
      onComplete?: () => void;
    } = {},
  ): Promise<unknown> {
    const kind = options.kind ?? "rpc";
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(
          options.signal.reason instanceof Error
            ? options.signal.reason
            : new Error("Plugin invocation cancelled"),
        );
        return;
      }
      let abort = (): void => undefined;
      const pending: PendingInvocation = {
        resolve,
        reject,
        timeout: null,
        cancelTimeout: null,
        kind,
        onUpdate: options.onUpdate,
        callerSettled: false,
        cancellationRequested: false,
        onComplete: options.onComplete,
      };
      pending.cleanup = () => options.signal?.removeEventListener("abort", abort);
      pending.timeout = setTimeout(() => {
        if (kind === "tool") {
          this.requestCancellation(
            loaded,
            requestId,
            pending,
            new Error(`Plugin ${kind} timed out: ${loaded.id}`),
          );
          return;
        }
        this.finishPending(loaded, requestId, pending, () =>
          reject(new Error(`Plugin ${kind} timed out: ${loaded.id}`)),
        );
      }, timeoutMs);
      loaded.pending.set(requestId, pending);
      abort = (): void => {
        if (kind !== "tool") {
          this.finishPending(loaded, requestId, pending, () =>
            reject(
              options.signal?.reason instanceof Error
                ? options.signal.reason
                : new Error("Plugin invocation cancelled"),
            ),
          );
          return;
        }
        this.requestCancellation(
          loaded,
          requestId,
          pending,
          options.signal?.reason instanceof Error
            ? options.signal.reason
            : new Error("Plugin tool invocation cancelled"),
        );
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      void send(loaded.child, { ...request, requestId } as PluginProcessRequest).catch((error) => {
        if (loaded.pending.get(requestId) !== pending) return;
        this.quarantinePlugin(loaded, `Plugin request delivery failed: ${describeError(error)}`);
      });
    });
  }

  private validateToolCatalog(
    pluginId: string,
    generation: number,
    installationId: string,
    catalog: PluginToolCatalogEntry[],
  ): ReadonlyMap<string, PluginToolCatalogEntry> {
    const tools = new Map<string, PluginToolCatalogEntry>();
    let schemaBytes = 0;
    if (catalog.length > PLUGIN_TOOL_MAX_CATALOG_TOOLS) {
      throw new Error(`Plugin ${pluginId} tool catalog exceeds the tool count limit`);
    }
    for (const raw of catalog) {
      if (
        raw.pluginId !== pluginId ||
        raw.generation !== generation ||
        raw.installationId !== installationId
      ) {
        throw new Error(`Plugin ${pluginId} reported an invalid tool installation identity`);
      }
      if (!PLUGIN_TOOL_NAME_PATTERN.test(raw.name)) {
        throw new Error(`Invalid plugin tool name: ${raw.name}`);
      }
      assertSafePluginToolText(raw.name, "Plugin tool name", PLUGIN_TOOL_MAX_NAME_BYTES);
      assertSafePluginToolText(
        raw.pluginId,
        `Plugin tool ${raw.name} pluginId`,
        PLUGIN_TOOL_MAX_NAME_BYTES,
      );
      assertSafePluginToolText(
        raw.installationId,
        `Plugin tool ${raw.name} installationId`,
        PLUGIN_TOOL_MAX_NAME_BYTES,
      );
      assertSafePluginToolText(
        raw.title,
        `Plugin tool ${raw.name} title`,
        PLUGIN_TOOL_MAX_TITLE_BYTES,
      );
      if (raw.title.trim().length === 0) {
        throw new Error(`Plugin tool ${raw.name} must provide a title`);
      }
      assertSafePluginToolText(
        raw.description,
        `Plugin tool ${raw.name} description`,
        PLUGIN_TOOL_MAX_DESCRIPTION_BYTES,
      );
      if (raw.description.trim().length === 0) {
        throw new Error(`Plugin tool ${raw.name} must provide a description`);
      }
      if (isReservedPluginToolName(raw.name)) {
        throw new Error(`Plugin tool name is reserved: ${raw.name}`);
      }
      if (raw.timeoutMs > PLUGIN_TOOL_MAX_TIMEOUT_MS) {
        throw new Error(`Plugin tool timeout exceeds host maximum: ${raw.name}`);
      }
      assertSafeJson(
        raw.inputSchema,
        `Plugin tool ${raw.name} input schema`,
        PLUGIN_TOOL_MAX_SCHEMA_BYTES,
      );
      assertSupportedJsonSchema(raw.inputSchema, `Plugin tool ${raw.name} input schema`, {
        requireObject: true,
      });
      schemaBytes += Buffer.byteLength(JSON.stringify(raw.inputSchema), "utf8");
      if (raw.outputSchema) {
        assertSafeJson(
          raw.outputSchema,
          `Plugin tool ${raw.name} output schema`,
          PLUGIN_TOOL_MAX_SCHEMA_BYTES,
        );
        assertSupportedJsonSchema(raw.outputSchema, `Plugin tool ${raw.name} output schema`);
        schemaBytes += Buffer.byteLength(JSON.stringify(raw.outputSchema), "utf8");
      }
      if (tools.has(raw.name)) throw new Error(`Duplicate plugin tool name: ${raw.name}`);
      tools.set(raw.name, { ...raw });
    }
    if (schemaBytes > PLUGIN_TOOL_MAX_CATALOG_SCHEMA_BYTES) {
      throw new Error(`Plugin ${pluginId} tool catalog exceeds the schema byte limit`);
    }
    assertPluginToolCatalogBytes([...tools.values()], `Plugin ${pluginId} tool catalog`);
    return tools;
  }

  private assertAggregateToolCatalogWithinLimits(
    plugins: readonly LoadedPlugin[],
    sortedCount?: number,
    sortedTools?: readonly PluginToolCatalogEntry[],
  ): void {
    const tools =
      sortedTools ??
      plugins
        .flatMap((plugin) => [...plugin.tools.values()])
        .sort(
          (left, right) =>
            left.name.localeCompare(right.name) || left.pluginId.localeCompare(right.pluginId),
        );
    if ((sortedCount ?? tools.length) > PLUGIN_TOOL_MAX_CATALOG_TOOLS) {
      throw new Error("Plugin tool aggregate catalog exceeds the tool count limit");
    }
    let schemaBytes = 0;
    for (const tool of tools) {
      schemaBytes += Buffer.byteLength(JSON.stringify(tool.inputSchema), "utf8");
      if (tool.outputSchema) {
        schemaBytes += Buffer.byteLength(JSON.stringify(tool.outputSchema), "utf8");
      }
      if (schemaBytes > PLUGIN_TOOL_MAX_CATALOG_SCHEMA_BYTES) {
        throw new Error(
          `Plugin tool aggregate catalog exceeds the schema byte limit at ${tool.pluginId}.${tool.name}`,
        );
      }
    }
    assertPluginToolCatalogBytes(tools, "Plugin tool aggregate catalog");
  }

  private toolNameConflict(name: string): "reserved" | "duplicate" | null {
    if (isReservedPluginToolName(name)) return "reserved";
    return [...this.plugins.values()].some((plugin) => plugin.tools.has(name)) ? "duplicate" : null;
  }

  private appendLog(pluginId: string, stream: PluginLogEntry["stream"], message: string): void {
    const boundedMessage = truncateUtf8(message, MAX_LOG_LINE_BYTES);
    let tail = this.logTails.get(pluginId);
    if (!tail) {
      tail = { entries: [], bytes: 0, nextSequence: 1 };
      this.logTails.set(pluginId, tail);
    }
    const entry: PluginLogEntry = {
      sequence: tail.nextSequence++,
      timestamp: new Date().toISOString(),
      stream,
      message: boundedMessage,
    };
    tail.entries.push(entry);
    tail.bytes += Buffer.byteLength(boundedMessage);
    while (tail.entries.length > MAX_LOG_ENTRIES || tail.bytes > MAX_LOG_BYTES) {
      const removed = tail.entries.shift();
      if (!removed) break;
      tail.bytes -= Buffer.byteLength(removed.message);
    }
    this.logger.info({ pluginId, ...entry }, "Plugin output");
  }

  private notify(pluginId: string, error?: string): void {
    for (const listener of this.listeners) listener(pluginId, error);
  }
}
