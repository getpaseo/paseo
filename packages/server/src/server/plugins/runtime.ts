import { fork } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type pino from "pino";
import type { PluginLogEntry } from "@getpaseo/protocol/messages";
import { compilePlugin } from "./compiler.js";
import { readPluginManifest } from "./manifest.js";
import type { PluginProcessMessage, PluginProcessRequest } from "./plugin-process-protocol.js";
import { PluginSessionSocket } from "./session-socket.js";

const CLIENT_ENTRY_FILENAMES = ["index.client.ts", "index.client.tsx"] as const;
const SERVER_ENTRY_FILENAMES = ["index.server.ts", "index.server.tsx"] as const;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_LOG_ENTRIES = 500;
const MAX_LOG_BYTES = 256 * 1024;
const MAX_LOG_LINE_BYTES = 16 * 1024;

interface PluginOutputStream {
  on(event: "data", listener: (chunk: Buffer | string) => void): this;
}

interface PluginChild {
  connected: boolean;
  killed: boolean;
  stdout?: PluginOutputStream | null;
  stderr?: PluginOutputStream | null;
  send(message: PluginProcessRequest, callback?: (error: Error | null) => void): boolean;
  kill(): boolean;
  disconnect(): void;
  on(event: "message", listener: (message: PluginProcessMessage) => void): this;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

interface PendingInvocation {
  resolve: (output: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface LoadedPlugin {
  id: string;
  clientBundle: string;
  methods: ReadonlySet<string>;
  child: PluginChild | null;
  outputCapture: PluginOutputCapture | null;
  pending: Map<string, PendingInvocation>;
  sessionSocket: PluginSessionSocket | null;
  sessionClosed: Promise<void> | null;
}

interface PluginRuntimeDependencies {
  spawnChild?: () => PluginChild;
  sessionHost?: PluginPaseoSessionHost;
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
  if (child.connected) child.disconnect();
  if (!child.killed) child.kill();
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function send(child: PluginChild, message: PluginProcessRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    child.send(message, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function findEntry(directory: string, filenames: readonly string[]): Promise<string | null> {
  for (const filename of filenames) {
    const filePath = path.join(directory, filename);
    const info = await stat(filePath).catch(() => null);
    if (info?.isFile()) return filePath;
  }
  return null;
}

async function resolveEntryPaths(directory: string): Promise<{
  client: string | null;
  server: string | null;
}> {
  const [client, server] = await Promise.all([
    findEntry(directory, CLIENT_ENTRY_FILENAMES),
    findEntry(directory, SERVER_ENTRY_FILENAMES),
  ]);
  if (client || server) return { client, server };
  const legacyEntry = await findEntry(directory, ["index.ts", "index.tsx"]);
  if (legacyEntry) {
    throw new Error(
      "Plugin entry split is required: migrate index.ts to index.client.tsx and/or index.server.ts. See https://paseo.sh/docs/plugins/v0.8/migration",
    );
  }
  throw new Error(
    `Plugin entry points are missing: expected ${CLIENT_ENTRY_FILENAMES.join(" or ")} and/or ${SERVER_ENTRY_FILENAMES.join(" or ")} in ${directory}`,
  );
}

export class PluginRuntime {
  private readonly plugins = new Map<string, LoadedPlugin>();
  private readonly logTails = new Map<string, PluginLogTail>();
  private readonly logger: pino.Logger;
  private readonly spawnChild: () => PluginChild;
  private sessionHost: PluginPaseoSessionHost | null;
  private readonly listeners = new Set<(pluginId: string, error?: string) => void>();

  constructor(
    logger: pino.Logger,
    private readonly daemonVersion: string,
    dependencies: PluginRuntimeDependencies = {},
  ) {
    this.logger = logger.child({ module: "plugins" });
    this.spawnChild = dependencies.spawnChild ?? spawnPluginChild;
    this.sessionHost = dependencies.sessionHost ?? null;
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
    if (this.plugins.has(pluginId)) throw new Error(`Plugin is already running: ${pluginId}`);
    this.appendLog(pluginId, "stdout", "[paseo] Loading plugin");
    const loaded = await this.loadDirectoryPlugin(pluginId, configuredPath).catch((error) => {
      this.appendLog(pluginId, "stderr", `[paseo] Plugin failed to load: ${describeError(error)}`);
      throw error;
    });
    if (!canPublish()) {
      await this.stopPlugin(loaded);
      throw new Error(`Plugin start cancelled: ${pluginId}`);
    }
    this.plugins.set(pluginId, loaded);
    this.appendLog(pluginId, "stdout", "[paseo] Plugin ready");
  }

  async validatePlugin(configuredPath: string): Promise<void> {
    const directory = path.resolve(configuredPath);
    await readPluginManifest(directory);
    const entryPaths = await resolveEntryPaths(directory);
    await compilePlugin(entryPaths);
  }

  async stopPluginById(pluginId: string): Promise<boolean> {
    const loaded = this.plugins.get(pluginId);
    if (!loaded) return false;
    this.plugins.delete(pluginId);
    this.rejectPending(loaded, `Plugin stopped: ${pluginId}`);
    await this.stopPlugin(loaded);
    return true;
  }

  catalog(): Array<{ id: string; clientBundle: string }> {
    return [...this.plugins.values()]
      .map(({ id, clientBundle }) => ({ id, clientBundle }))
      .sort((left, right) => left.id.localeCompare(right.id));
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
    const child = loaded.child;
    if (!child) throw new Error(`Plugin ${pluginId} has no server entry`);
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        loaded.pending.delete(requestId);
        reject(new Error(`Plugin RPC timed out: ${pluginId}.${method}`));
      }, REQUEST_TIMEOUT_MS);
      loaded.pending.set(requestId, { resolve, reject, timeout });
      void send(child, { type: "invoke", requestId, method, input }).catch((error) => {
        clearTimeout(timeout);
        loaded.pending.delete(requestId);
        reject(error);
      });
    });
  }

  async stopAll(): Promise<void> {
    const loaded = [...this.plugins.values()];
    this.plugins.clear();
    for (const plugin of loaded) {
      this.rejectPending(plugin, `Plugin stopped: ${plugin.id}`);
    }
    await Promise.all(loaded.map((plugin) => this.stopPlugin(plugin)));
  }

  private async loadDirectoryPlugin(
    pluginId: string,
    configuredPath: string,
  ): Promise<LoadedPlugin> {
    const directory = path.resolve(configuredPath);
    await readPluginManifest(directory);
    const entryPaths = await resolveEntryPaths(directory);
    const bundles = await compilePlugin(entryPaths);
    const serverBundle = bundles.serverBundle;
    if (!serverBundle) {
      return {
        id: pluginId,
        clientBundle: bundles.clientBundle ?? "",
        methods: new Set(),
        child: null,
        outputCapture: null,
        pending: new Map(),
        sessionSocket: null,
        sessionClosed: null,
      };
    }
    const sessionHost = this.sessionHost;
    if (!sessionHost) throw new Error("Plugin Paseo session host is not attached");
    const child = this.spawnChild();
    const outputCapture = new PluginOutputCapture(child, (stream, message) => {
      this.appendLog(pluginId, stream, message);
    });
    const sessionSocket = new PluginSessionSocket(child);
    const pending = new Map<string, PendingInvocation>();
    const sessionAttachment = await sessionHost
      .attachPluginSocket(pluginId, sessionSocket)
      .catch((error) => {
        terminatePluginChild(child);
        throw error;
      });
    let loaded: LoadedPlugin | null = null;
    let methods: string[];
    try {
      methods = await new Promise<string[]>((resolve, reject) => {
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
        child.on("message", (message) => {
          if (message.type === "paseo_frame") {
            sessionSocket.receive(message.data, message.isBinary);
          } else if (message.type === "paseo_close") {
            sessionSocket.peerClosed();
          } else if (message.type === "ready") {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            resolve(message.methods);
          } else if (message.type === "fatal") {
            fail(new Error(message.error));
          } else if (loaded) {
            this.handleChildMessage(loaded, message);
          }
        });
        child.on("close", () => {
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
          bundle: serverBundle,
        }).catch(fail);
      });
    } catch (error) {
      sessionSocket.close();
      await sessionAttachment.closed;
      terminatePluginChild(child);
      throw error;
    }
    loaded = {
      id: pluginId,
      clientBundle: bundles.clientBundle ?? "",
      methods: new Set(methods),
      child,
      outputCapture,
      pending,
      sessionSocket,
      sessionClosed: sessionAttachment.closed,
    };
    this.logger.info({ pluginId, methods }, "Loaded plugin");
    return loaded;
  }

  private handleChildMessage(loaded: LoadedPlugin, message: PluginProcessMessage): void {
    if (message.type !== "result" && message.type !== "error") return;
    const pending = loaded.pending.get(message.requestId);
    if (!pending) return;
    loaded.pending.delete(message.requestId);
    clearTimeout(pending.timeout);
    if (message.type === "result") pending.resolve(message.output);
    else pending.reject(new Error(message.error));
  }

  private async handleChildClose(loaded: LoadedPlugin): Promise<void> {
    loaded.sessionSocket?.peerClosed();
    const wasPublished = this.plugins.get(loaded.id) === loaded;
    if (wasPublished) {
      this.plugins.delete(loaded.id);
    }
    this.rejectPending(loaded, `Plugin process exited: ${loaded.id}`);
    await loaded.sessionClosed;
    if (wasPublished) this.notify(loaded.id, `Plugin process exited: ${loaded.id}`);
  }

  private async stopPlugin(loaded: LoadedPlugin): Promise<void> {
    this.appendLog(loaded.id, "stdout", "[paseo] Stopping plugin");
    const { child, sessionSocket, sessionClosed } = loaded;
    if (!child || !sessionSocket || !sessionClosed) {
      this.appendLog(loaded.id, "stdout", "[paseo] Plugin stopped");
      return;
    }
    if (child.killed) {
      sessionSocket.peerClosed();
      await sessionClosed;
      this.appendLog(loaded.id, "stdout", "[paseo] Plugin stopped");
      return;
    }
    const closed = new Promise<void>((resolve) =>
      child.on("close", () => {
        resolve();
      }),
    );
    if (child.connected) {
      await send(child, { type: "shutdown" }).catch(() => undefined);
    }
    await closed;
    sessionSocket.peerClosed();
    await sessionClosed;
    this.appendLog(loaded.id, "stdout", "[paseo] Plugin stopped");
  }

  private rejectPending(loaded: LoadedPlugin, message: string): void {
    for (const invocation of loaded.pending.values()) {
      clearTimeout(invocation.timeout);
      invocation.reject(new Error(message));
    }
    loaded.pending.clear();
  }

  private appendLog(pluginId: string, stream: PluginLogEntry["stream"], message: string): void {
    const boundedMessage = Buffer.from(message).subarray(0, MAX_LOG_LINE_BYTES).toString("utf8");
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
