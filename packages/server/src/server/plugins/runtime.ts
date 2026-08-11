import { fork } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type pino from "pino";
import { z } from "zod";
import { PluginIdSchema, type PluginSource } from "@getpaseo/protocol/messages";
import { compilePlugin } from "./compiler.js";
import type { PluginProcessMessage, PluginProcessRequest } from "./plugin-process-protocol.js";

const MANIFEST_FILENAME = "paseo-plugin.json";
const ENTRY_FILENAME = "index.tsx";
const REQUEST_TIMEOUT_MS = 30_000;

const PluginManifestSchema = z.object({ id: PluginIdSchema }).strict();

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

interface PluginRuntimeConfig {
  enabled: boolean;
  sources: Record<string, PluginSource>;
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

async function readManifest(directory: string): Promise<{ id: string }> {
  const manifestPath = path.join(directory, MANIFEST_FILENAME);
  await requireRegularFile(manifestPath, "Plugin manifest");
  return PluginManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
}

export class PluginRuntime {
  private readonly plugins = new Map<string, LoadedPlugin>();
  private readonly logger: pino.Logger;

  constructor(logger: pino.Logger) {
    this.logger = logger.child({ module: "plugins" });
  }

  async start(config: PluginRuntimeConfig): Promise<void> {
    if (!config.enabled) return;

    for (const [pluginId, source] of Object.entries(config.sources)) {
      try {
        await this.loadDirectoryPlugin(pluginId, source.path);
      } catch (error) {
        this.logger.error({ err: error, pluginId, source }, "Failed to load plugin");
      }
    }
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

  async stop(): Promise<void> {
    await Promise.all([...this.plugins.values()].map((loaded) => this.stopPlugin(loaded)));
    this.plugins.clear();
  }

  private async loadDirectoryPlugin(pluginId: string, configuredPath: string): Promise<void> {
    const directory = path.resolve(configuredPath);
    const manifest = await readManifest(directory);
    if (manifest.id !== pluginId) {
      throw new Error(`Configured plugin "${pluginId}" points to manifest "${manifest.id}"`);
    }
    const entryPath = path.join(directory, ENTRY_FILENAME);
    await requireRegularFile(entryPath, "Plugin entry point");
    const bundles = await compilePlugin(entryPath);
    const child = spawnPluginChild();
    const pending = new Map<string, PendingInvocation>();
    const methods = await new Promise<string[]>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Plugin ${pluginId} did not initialize`)),
        REQUEST_TIMEOUT_MS,
      );
      child.on("message", (message) => {
        if (message.type === "ready") {
          clearTimeout(timeout);
          resolve(message.methods);
        } else if (message.type === "fatal") {
          clearTimeout(timeout);
          reject(new Error(message.error));
        }
      });
      void send(child, { type: "initialize", bundle: bundles.serverBundle }).catch(reject);
    });
    const loaded: LoadedPlugin = {
      id: pluginId,
      clientBundle: bundles.clientBundle,
      methods: new Set(methods),
      child,
      pending,
    };
    child.on("message", (message) => this.handleChildMessage(loaded, message));
    child.on("close", () => this.handleChildClose(loaded));
    this.plugins.set(pluginId, loaded);
    this.logger.info({ pluginId, methods }, "Loaded plugin");
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
    if (this.plugins.get(loaded.id) === loaded) this.plugins.delete(loaded.id);
    for (const invocation of loaded.pending.values()) {
      clearTimeout(invocation.timeout);
      invocation.reject(new Error(`Plugin process exited: ${loaded.id}`));
    }
    loaded.pending.clear();
  }

  private async stopPlugin(loaded: LoadedPlugin): Promise<void> {
    if (!loaded.child.connected) return;
    await send(loaded.child, { type: "shutdown" }).catch(() => undefined);
    loaded.child.disconnect();
    if (!loaded.child.killed) loaded.child.kill();
  }
}
