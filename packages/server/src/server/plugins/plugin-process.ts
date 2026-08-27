import type { PluginProcessMessage, PluginProcessRequest } from "./plugin-process-protocol.js";
import { createRequire } from "node:module";
import type { PluginHandlerContext, PluginRpcContract } from "@getpaseo/plugin/server";
// Namespace, not named imports: this is handed straight to plugin code, so a
// hand-written list silently drops any export the SDK adds later.
import * as PluginServerSdk from "@getpaseo/plugin/server";
import { createPaseoApi, type PaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createPluginDaemonTransportFactory } from "./daemon-transport.js";
import { isPluginSdkSpecifier } from "./plugin-sdk-specifiers.js";

type RpcHandler = (input: unknown, context: PluginHandlerContext) => unknown | Promise<unknown>;

interface RegisteredRpc {
  contract: PluginRpcContract;
  handler: RpcHandler;
}

const handlers = new Map<string, RegisteredRpc>();
let cleanup: (() => void | Promise<void>) | null = null;
let daemonClient: DaemonClient | null = null;
let paseo: PaseoApi | null = null;
let stopping = false;
const nodeRequire = createRequire(import.meta.url);

// process.send throws ERR_IPC_CHANNEL_CLOSED once the host closes the channel,
// and an unhandled throw here kills the subprocess with a stack that looks like
// a plugin crash. A handler that resolves after shutdown has nobody to answer,
// so dropping the reply is the whole correct behaviour.
function canSend(): boolean {
  return typeof process.send === "function" && process.connected;
}

function send(message: PluginProcessMessage): void {
  if (!canSend()) return;
  try {
    process.send?.(message);
  } catch {
    // The channel closed between the check and the write.
  }
}

function sendAndWait(message: PluginProcessMessage): Promise<void> {
  return new Promise((resolve) => {
    if (!canSend()) {
      resolve();
      return;
    }
    try {
      process.send?.(message, () => resolve());
    } catch {
      resolve();
    }
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateMethod(method: string): string {
  const normalized = method.trim();
  if (!/^[a-z][a-z0-9._-]*$/.test(normalized)) {
    throw new Error(`Invalid plugin RPC method: ${method}`);
  }
  if (handlers.has(normalized)) {
    throw new Error(`Duplicate plugin RPC method: ${normalized}`);
  }
  return normalized;
}

function register(contract: PluginRpcContract, handler: RpcHandler): void {
  if (typeof handler !== "function") {
    throw new Error(`Plugin RPC ${contract.name} must provide a handler`);
  }
  const method = validateMethod(contract.name);
  handlers.set(method, { contract: { ...contract, name: method }, handler });
}

// Both SDK specifiers resolve to the server surface here. A shared module that
// reaches for a client hook in the subprocess is a bug in the plugin, not
// something to paper over with a stub.
const pluginAuthorRuntime = PluginServerSdk;

function runtimeRequire(name: string): unknown {
  if (isPluginSdkSpecifier(name)) return pluginAuthorRuntime;
  return nodeRequire(name);
}

function evaluateBundle(bundle: string): void {
  const evaluate: (source: string) => unknown = globalThis.eval;
  const factory = evaluate(bundle);
  if (typeof factory !== "function") throw new Error("Plugin server bundle is not executable");
  const exports = factory(runtimeRequire);
  const setup =
    exports !== null && typeof exports === "object" ? Reflect.get(exports, "default") : undefined;
  if (typeof setup !== "function") {
    throw new Error("Plugin server bundle must default export a function");
  }
  const contributedCleanup = setup({ handle: register });
  if (typeof contributedCleanup !== "function") {
    throw new Error("Plugin contribution must return a cleanup function");
  }
  cleanup = contributedCleanup;
}

const transportFactory = createPluginDaemonTransportFactory({
  send,
  onMessage(handler) {
    process.on("message", handler);
    return () => process.off("message", handler);
  },
});

async function initialize(message: Extract<PluginProcessRequest, { type: "initialize" }>) {
  daemonClient = new DaemonClient({
    url: `ipc://plugin/${encodeURIComponent(message.pluginId)}`,
    clientId: `plugin:${message.pluginId}`,
    clientType: "cli",
    appVersion: message.appVersion,
    reconnect: { enabled: false },
    transportFactory,
  });
  paseo = createPaseoApi(daemonClient);
  await daemonClient.connect();
  evaluateBundle(message.bundle);
  send({ type: "ready", methods: [...handlers.keys()].sort() });
}

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  const currentCleanup = cleanup;
  cleanup = null;
  try {
    await currentCleanup?.();
  } catch (error) {
    console.error("Plugin cleanup failed", error);
  }
  await daemonClient?.close().catch(() => undefined);
  await sendAndWait({ type: "paseo_close" });
  daemonClient = null;
  paseo = null;
  process.disconnect();
}

process.on("message", (message: PluginProcessRequest) => {
  if (message.type === "initialize") {
    void initialize(message).catch(async (error) => {
      send({ type: "fatal", error: describeError(error) });
      await daemonClient?.close().catch(() => undefined);
    });
    return;
  }
  if (message.type === "shutdown") {
    void shutdown();
    return;
  }
  if (message.type === "paseo_frame" || message.type === "paseo_close") return;
  if (stopping) return;
  const registered = handlers.get(message.method);
  if (!registered) {
    send({
      type: "error",
      requestId: message.requestId,
      error: `Unknown RPC method: ${message.method}`,
    });
    return;
  }
  void registered.contract.input
    .parseAsync(message.input)
    .then((input) => {
      if (!paseo) throw new Error("Plugin Paseo API is unavailable");
      return registered.handler(input, { paseo });
    })
    .then((output) => registered.contract.output.parseAsync(output))
    .then(
      (output) => send({ type: "result", requestId: message.requestId, output }),
      (error) => send({ type: "error", requestId: message.requestId, error: describeError(error) }),
    );
});
