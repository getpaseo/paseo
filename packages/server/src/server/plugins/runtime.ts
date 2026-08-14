import { fork } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type pino from "pino";
import { compilePlugin } from "./compiler.js";
import { readPluginManifest } from "./manifest.js";
import type { PluginProcessMessage, PluginProcessRequest } from "./plugin-process-protocol.js";

const ENTRY_FILENAME = "index.tsx";
const REQUEST_TIMEOUT_MS = 30_000;

interface PluginChild {
  connected: boolean;
  killed: boolean;
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
  child: PluginChild;
  pending: Map<string, PendingInvocation>;
}

interface PluginRuntimeDependencies {
  spawnChild?: () => PluginChild;
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
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  }) as PluginChild;
}

function terminatePluginChild(child: PluginChild): void {
  if (child.connected) child.disconnect();
  if (!child.killed) child.kill();
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

async function requireRegularFile(filePath: string, label: string): Promise<void> {
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) throw new Error(`${label} is missing: ${filePath}`);
}

export class PluginRuntime {
  private readonly plugins = new Map<string, LoadedPlugin>();
  private readonly logger: pino.Logger;
  private readonly spawnChild: () => PluginChild;
  private readonly listeners = new Set<(pluginId: string, error?: string) => void>();

  constructor(logger: pino.Logger, dependencies: PluginRuntimeDependencies = {}) {
    this.logger = logger.child({ module: "plugins" });
    this.spawnChild = dependencies.spawnChild ?? spawnPluginChild;
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
    const loaded = await this.loadDirectoryPlugin(pluginId, configuredPath);
    if (!canPublish()) {
      await this.stopPlugin(loaded);
      throw new Error(`Plugin start cancelled: ${pluginId}`);
    }
    this.plugins.set(pluginId, loaded);
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

  async invoke(pluginId: string, method: string, input: unknown): Promise<unknown> {
    const loaded = this.plugins.get(pluginId);
    if (!loaded) throw new Error(`Plugin is not available: ${pluginId}`);
    if (!loaded.methods.has(method))
      throw new Error(`Plugin ${pluginId} does not contribute RPC ${method}`);
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        loaded.pending.delete(requestId);
        reject(new Error(`Plugin RPC timed out: ${pluginId}.${method}`));
      }, REQUEST_TIMEOUT_MS);
      loaded.pending.set(requestId, { resolve, reject, timeout });
      void send(loaded.child, { type: "invoke", requestId, method, input }).catch((error) => {
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
    const entryPath = path.join(directory, ENTRY_FILENAME);
    await requireRegularFile(entryPath, "Plugin entry point");
    const bundles = await compilePlugin(entryPath);
    const child = this.spawnChild();
    const pending = new Map<string, PendingInvocation>();
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
          if (message.type === "ready") {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            resolve(message.methods);
          } else if (message.type === "fatal") {
            fail(new Error(message.error));
          }
        });
        child.on("close", () => fail(new Error(`Plugin ${pluginId} exited during initialization`)));
        void send(child, { type: "initialize", bundle: bundles.serverBundle }).catch(fail);
      });
    } catch (error) {
      terminatePluginChild(child);
      throw error;
    }
    const loaded: LoadedPlugin = {
      id: pluginId,
      clientBundle: bundles.clientBundle,
      methods: new Set(methods),
      child,
      pending,
    };
    child.on("message", (message) => this.handleChildMessage(loaded, message));
    child.on("close", () => this.handleChildClose(loaded));
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

  private handleChildClose(loaded: LoadedPlugin): void {
    if (this.plugins.get(loaded.id) === loaded) {
      this.plugins.delete(loaded.id);
      this.notify(loaded.id, `Plugin process exited: ${loaded.id}`);
    }
    this.rejectPending(loaded, `Plugin process exited: ${loaded.id}`);
  }

  private async stopPlugin(loaded: LoadedPlugin): Promise<void> {
    if (loaded.child.killed) return;
    let didClose = false;
    const closed = new Promise<void>((resolve) =>
      loaded.child.on("close", () => {
        didClose = true;
        resolve();
      }),
    );
    if (loaded.child.connected) {
      await send(loaded.child, { type: "shutdown" }).catch(() => undefined);
    }
    await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
    if (!didClose) terminatePluginChild(loaded.child);
    await closed;
  }

  private rejectPending(loaded: LoadedPlugin, message: string): void {
    for (const invocation of loaded.pending.values()) {
      clearTimeout(invocation.timeout);
      invocation.reject(new Error(message));
    }
    loaded.pending.clear();
  }

  private notify(pluginId: string, error?: string): void {
    for (const listener of this.listeners) listener(pluginId, error);
  }
}
