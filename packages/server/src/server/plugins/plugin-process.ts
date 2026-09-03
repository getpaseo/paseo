import type { PluginProcessMessage, PluginProcessRequest } from "./plugin-process-protocol.js";
import { createRequire } from "node:module";
import * as pluginServerRuntime from "@getpaseo/plugin/server";
import { defineAttachmentSource, defineRpc, type PluginRpcContract } from "@getpaseo/plugin";
import {
  PLUGIN_FORGE_SERVICE_METHODS,
  type PluginForgeSerializedError,
  type PluginForgeServerProviderContribution,
  type PluginForgeServerProviderDescriptor,
  type PluginForgeServerService,
  type PluginForgeServiceMethod,
  type PluginHandlerContext,
} from "@getpaseo/plugin/server";
import { createPaseoApi, type PaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createPluginDaemonTransportFactory } from "./daemon-transport.js";
import { parsePluginForgeInput } from "./forge-validation.js";
import {
  isPluginClientOnlySdkSpecifier,
  isPluginSdkSpecifier,
  isPluginServerTypesSdkSpecifier,
} from "./plugin-sdk-specifiers.js";
import { createPluginClientId } from "./plugin-session-identity.js";

type RpcHandler = (input: unknown, context: PluginHandlerContext) => unknown | Promise<unknown>;

interface RegisteredRpc {
  contract: PluginRpcContract;
  handler: RpcHandler;
}

const handlers = new Map<string, RegisteredRpc>();
const forgeProviders = new Map<string, PluginForgeServerProviderContribution>();
const disposedForgeProviders = new Set<string>();
let cleanup: (() => void | Promise<void>) | null = null;
let daemonClient: DaemonClient | null = null;
let paseo: PaseoApi | null = null;
let stopping = false;
const nodeRequire = createRequire(import.meta.url);

function send(message: PluginProcessMessage): void {
  process.send?.(message);
}

function sendAndWait(message: PluginProcessMessage): Promise<void> {
  return new Promise((resolve) => {
    if (!process.send) {
      resolve();
      return;
    }
    process.send(message, () => resolve());
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

const OPTIONAL_FORGE_SERVICE_METHODS = new Set<PluginForgeServiceMethod>([
  "defaultCheckoutRefs",
  "buildPrLocalBranchName",
  "dispose",
]);

function validateForgeProviderId(providerId: string): string {
  const normalized = providerId.trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(normalized)) {
    throw new Error(`Invalid plugin forge provider id: ${providerId}`);
  }
  if (forgeProviders.has(normalized)) {
    throw new Error(`Duplicate plugin forge provider id: ${normalized}`);
  }
  return normalized;
}

function registerForgeProvider(
  contribution: PluginForgeServerProviderContribution,
): () => Promise<void> {
  if (!contribution || typeof contribution !== "object") {
    throw new Error("Plugin forge provider contribution must be an object");
  }
  const providerId = validateForgeProviderId(contribution.definition?.id ?? "");
  if (!contribution.service || typeof contribution.service !== "object") {
    throw new Error(`Plugin forge provider ${providerId} must provide a service`);
  }
  for (const method of PLUGIN_FORGE_SERVICE_METHODS) {
    if (OPTIONAL_FORGE_SERVICE_METHODS.has(method)) continue;
    if (typeof contribution.service[method] !== "function") {
      throw new Error(`Plugin forge provider ${providerId} must implement ${method}`);
    }
  }
  forgeProviders.set(providerId, {
    ...contribution,
    definition: { ...contribution.definition, id: providerId },
  });
  disposedForgeProviders.delete(providerId);
  let active = true;
  return async () => {
    if (!active) return;
    active = false;
    const registered = forgeProviders.get(providerId);
    if (!registered) return;
    forgeProviders.delete(providerId);
    if (disposedForgeProviders.has(providerId)) return;
    disposedForgeProviders.add(providerId);
    await registered.service.dispose?.();
  };
}

function describeForgeProvider(
  providerId: string,
  contribution: PluginForgeServerProviderContribution,
): PluginForgeServerProviderDescriptor {
  const methods = PLUGIN_FORGE_SERVICE_METHODS.filter(
    (method) => typeof contribution.service[method] === "function",
  );
  return {
    definition: { ...contribution.definition, id: providerId },
    methods,
    authProbeCanThrow: contribution.service.authProbeCanThrow === true,
    supportsCrossRepoCheckoutWithoutRefs:
      contribution.service.supportsCrossRepoCheckoutWithoutRefs === true,
    hasProbeHost: typeof contribution.probeHost === "function",
  };
}

function serializeForgeError(error: unknown): PluginForgeSerializedError {
  if (!error || typeof error !== "object") {
    return { message: String(error) };
  }
  const record = error as Record<string, unknown>;
  const serialized: PluginForgeSerializedError = {
    message: typeof record.message === "string" ? record.message : String(error),
  };
  if (typeof record.name === "string") serialized.name = record.name;
  if (
    record.kind === "missing-cli" ||
    record.kind === "auth-failure" ||
    record.kind === "command-error"
  ) {
    serialized.kind = record.kind;
  }
  if (typeof record.stderr === "string") serialized.stderr = record.stderr;
  if (Array.isArray(record.args) && record.args.every((value) => typeof value === "string")) {
    serialized.args = record.args;
  }
  if (typeof record.cwd === "string") serialized.cwd = record.cwd;
  if (typeof record.exitCode === "number" || record.exitCode === null) {
    serialized.exitCode = record.exitCode;
  }
  if (typeof record.brand === "string") serialized.brand = record.brand;
  if (typeof record.binary === "string") serialized.binary = record.binary;
  return serialized;
}

const pluginAuthorRuntime = {
  defineAttachmentSource,
  defineRpc,
  ...pluginServerRuntime,
  Icon() {
    throw new Error("Icon is available only in plugin client code");
  },
};

function runtimeRequire(name: string): unknown {
  if (isPluginClientOnlySdkSpecifier(name)) {
    throw new Error(`${name} is available only in plugin client code`);
  }
  if (isPluginServerTypesSdkSpecifier(name)) return pluginServerRuntime;
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
  const contributedCleanup = setup({
    handle: register,
    addForgeServerProvider: registerForgeProvider,
  });
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
    clientId: createPluginClientId(message.pluginId),
    clientType: "cli",
    appVersion: message.appVersion,
    reconnect: { enabled: false },
    transportFactory,
  });
  paseo = createPaseoApi(daemonClient);
  await daemonClient.connect();
  evaluateBundle(message.bundle);
  send({
    type: "ready",
    methods: [...handlers.keys()].sort(),
    forgeProviders: [...forgeProviders]
      .map(([providerId, contribution]) => describeForgeProvider(providerId, contribution))
      .sort((left, right) => left.definition.id.localeCompare(right.definition.id)),
  });
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
  for (const [providerId, contribution] of forgeProviders) {
    if (disposedForgeProviders.has(providerId)) continue;
    disposedForgeProviders.add(providerId);
    try {
      await contribution.service.dispose?.();
    } catch (error) {
      console.error(`Plugin forge provider cleanup failed: ${providerId}`, error);
    }
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
  if (message.type === "invoke_forge") {
    const contribution = forgeProviders.get(message.providerId);
    if (!contribution) {
      send({
        type: "forge_error",
        requestId: message.requestId,
        error: { message: `Unknown forge provider: ${message.providerId}` },
      });
      return;
    }
    const invocation = Promise.resolve().then(() => {
      if (message.method === "probeHost") {
        if (!contribution.probeHost) {
          throw new Error(`Forge provider ${message.providerId} has no host probe`);
        }
        const host = parsePluginForgeInput("probeHost", message.input);
        return contribution.probeHost(host);
      }
      const input = parsePluginForgeInput(message.method, message.input);
      const method = contribution.service[message.method];
      if (typeof method !== "function") {
        throw new Error(
          `Forge provider ${message.providerId} does not implement ${message.method}`,
        );
      }
      const invokeMethod = method as (this: PluginForgeServerService, input?: unknown) => unknown;
      if (message.method === "dispose") {
        disposedForgeProviders.add(message.providerId);
        return invokeMethod.call(contribution.service);
      }
      return invokeMethod.call(contribution.service, input);
    });
    void invocation.then(
      (output) => send({ type: "forge_result", requestId: message.requestId, output }),
      (error) =>
        send({
          type: "forge_error",
          requestId: message.requestId,
          error: serializeForgeError(error),
        }),
    );
    return;
  }
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
