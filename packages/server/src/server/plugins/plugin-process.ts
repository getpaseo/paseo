import { PluginHookHandlers } from "./lifecycle/index.js";
import {
  PluginProcessRequestSchema,
  type PluginProcessMessage,
  type PluginProcessRequest,
} from "./plugin-process-protocol.js";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import * as pluginSharedRuntime from "@getpaseo/plugin";
import * as pluginServerRuntime from "@getpaseo/plugin/server";
import * as pluginProviderRuntime from "@getpaseo/plugin/server/provider";
import * as pluginAcpRuntime from "@getpaseo/plugin/server/acp";
import * as pluginForgeToolkitRuntime from "@getpaseo/plugin/server/forge-toolkit";
import type { SettingsDefinition, PluginRpcContract } from "@getpaseo/plugin";
import {
  PLUGIN_FORGE_SERVICE_METHODS,
  type PluginForgeSerializedError,
  type PluginForgeServerProviderContribution,
  type PluginForgeServerProviderDescriptor,
  type PluginForgeServerService,
  type PluginForgeServiceMethod,
  type PluginHandlerContext,
  type PluginPresence,
} from "@getpaseo/plugin/server";
import type { ZodType } from "zod";
import {
  ProviderEventSchema,
  type ProviderConnection,
  type ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import { createPaseoApi, type PaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createPluginDaemonTransportFactory } from "./daemon-transport.js";
import { isPluginClientOnlySdkSpecifier } from "./plugin-sdk-specifiers.js";
import { createPluginClientId } from "./plugin-session-identity.js";

import { PluginSettingsStore } from "./settings/index.js";
import { PluginSecretStore } from "./secrets.js";
let settingsStore: PluginSettingsStore | null = null;
let secretStore: PluginSecretStore | null = null;

/**
 * Deliberately not an RPC. The daemon never publishes a handler for these, so a
 * plugin's token cannot be fetched by a connected client.
 */
const secrets = {
  get: (key: string) => requireSecretStore().get(key),
  has: (key: string) => requireSecretStore().has(key),
  keys: () => requireSecretStore().keys(),
  set: (key: string, value: string) => requireSecretStore().set(key, value),
  delete: (key: string) => requireSecretStore().delete(key),
};

const pendingPresence = new Map<
  string,
  { resolve: (presence: PluginPresence) => void; reject: (error: Error) => void }
>();

// Client presence lives in the daemon's WebSocket server, so the child asks for it over IPC.
function presence(): Promise<PluginPresence> {
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    pendingPresence.set(requestId, { resolve, reject });
    send({ type: "presence.request", requestId });
  });
}

function requireSecretStore(): PluginSecretStore {
  if (!secretStore) throw new Error("Plugin secret storage is unavailable");
  return secretStore;
}
function registerSettings<Schema extends ZodType>(definition: SettingsDefinition<Schema>) {
  if (!settingsStore) throw new Error("Plugin settings storage is unavailable");
  const handlers = settingsStore.register(definition);
  register(handlers.read.contract, handlers.read.handle);
  register(handlers.write.contract, (input) =>
    handlers.write.handle(handlers.write.contract.input.parse(input)),
  );
  register(handlers.reset.contract, (input) =>
    handlers.reset.handle(handlers.reset.contract.input.parse(input)),
  );
  return handlers.settings;
}

type RpcHandler = (input: unknown, context: PluginHandlerContext) => unknown | Promise<unknown>;

interface RegisteredRpc {
  contract: PluginRpcContract;
  handler: RpcHandler;
}

const hooks = new PluginHookHandlers(() => {
  send({ type: "hooks.changed", hooks: hooks.catalog() });
});
const handlers = new Map<string, RegisteredRpc>();
const providers = new Map<string, ProviderRegistration>();
const providerConnections = new Map<
  string,
  { connection: ProviderConnection; unsubscribe: () => void; closing?: Promise<void> }
>();
const pendingProviderConnections = new Map<string, { tombstoned: boolean }>();
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

function jsonTransportValue<Value>(value: Value): Value {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Provider value is not JSON-serializable");
  return JSON.parse(encoded) as Value;
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

function registerProvider(provider: ProviderRegistration): void {
  const id = provider.id.trim();
  if (!/^[a-z][a-z0-9._-]*$/.test(id)) {
    throw new Error(`Invalid plugin provider ID: ${provider.id}`);
  }
  if (!provider.label.trim()) throw new Error(`Plugin provider ${id} requires a label`);
  if (typeof provider.connect !== "function") {
    throw new Error(`Plugin provider ${id} must implement connect()`);
  }
  if (
    provider.getCatalogCacheKey !== undefined &&
    typeof provider.getCatalogCacheKey !== "function"
  ) {
    throw new Error(`Invalid catalogue key callback for plugin provider ${id}`);
  }
  if (providers.has(id)) throw new Error(`Duplicate plugin provider ID: ${id}`);
  providers.set(id, { ...provider, id });
}

function providerMetadata(provider: ProviderRegistration) {
  return {
    id: provider.id,
    label: provider.label,
    description: provider.description,
    iconPath: provider.icon,
    hasCatalogCacheKey: provider.getCatalogCacheKey !== undefined,
  };
}

async function connectProvider(
  message: Extract<PluginProcessRequest, { type: "provider.connect" }>,
): Promise<void> {
  if (stopping) throw new Error("Plugin is stopping");
  const provider = providers.get(message.providerId);
  if (!provider) throw new Error(`Unknown plugin provider: ${message.providerId}`);
  if (
    providerConnections.has(message.connectionId) ||
    pendingProviderConnections.has(message.connectionId)
  ) {
    throw new Error(`Duplicate provider connection: ${message.connectionId}`);
  }
  const pending = { tombstoned: false };
  pendingProviderConnections.set(message.connectionId, pending);
  let connection: ProviderConnection;
  try {
    connection = await provider.connect(message.request);
  } catch (error) {
    pendingProviderConnections.delete(message.connectionId);
    if (pending.tombstoned || stopping) return;
    throw error;
  }
  pendingProviderConnections.delete(message.connectionId);
  if (pending.tombstoned || stopping) {
    await connection.close().catch(() => undefined);
    return;
  }
  let unsubscribe = () => {};
  unsubscribe = connection.onEvent((event) => {
    try {
      send({
        type: "provider.event",
        connectionId: message.connectionId,
        event: ProviderEventSchema.parse(jsonTransportValue(event)),
      });
    } catch (error) {
      providerConnections.delete(message.connectionId);
      unsubscribe();
      void connection.close().catch(() => undefined);
      send({
        type: "provider.closed",
        connectionId: message.connectionId,
        error: describeError(error),
      });
    }
  });
  providerConnections.set(message.connectionId, { connection, unsubscribe });
  send({
    type: "provider.connected",
    connectionId: message.connectionId,
    version: connection.version,
    capabilities: connection.capabilities,
  });
}

async function sendProviderInput(
  message: Extract<PluginProcessRequest, { type: "provider.send" }>,
): Promise<void> {
  if (stopping) throw new Error("Plugin is stopping");
  const current = providerConnections.get(message.connectionId);
  if (!current) throw new Error(`Unknown provider connection: ${message.connectionId}`);
  if (current.closing) throw new Error("Provider connection is closing");
  await current.connection.send(message.input);
  send({
    type: "provider.accepted",
    connectionId: message.connectionId,
    acceptanceId: message.acceptanceId,
  });
}

// The connection stays registered until its close has reported, so shutdown
// waits for a close already in flight instead of disconnecting underneath it.
async function closeProviderConnection(connectionId: string): Promise<void> {
  const current = providerConnections.get(connectionId);
  if (!current) return;
  if (current.closing) return current.closing;
  const closing = (async () => {
    current.unsubscribe();
    try {
      await current.connection.close();
      send({ type: "provider.closed", connectionId });
    } catch (error) {
      send({ type: "provider.closed", connectionId, error: describeError(error) });
    } finally {
      providerConnections.delete(connectionId);
    }
  })();
  current.closing = closing;
  return closing;
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

function registerForgeProvider(contribution: PluginForgeServerProviderContribution): void {
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

function runtimeRequire(name: string): unknown {
  if (isPluginClientOnlySdkSpecifier(name)) {
    throw new Error(`${name} is available only in plugin client code`);
  }
  if (name === "@getpaseo/plugin") return pluginSharedRuntime;
  if (name === "@getpaseo/plugin/server") return pluginServerRuntime;
  if (name === "@getpaseo/plugin/server/provider") return pluginProviderRuntime;
  if (name === "@getpaseo/plugin/server/acp") return pluginAcpRuntime;
  if (name === "@getpaseo/plugin/server/forge-toolkit") return pluginForgeToolkitRuntime;
  if (name === "@getpaseo/plugin/client/host")
    throw new Error(`${name} is private to the app host`);
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
  if (!paseo) throw new Error("Plugin Paseo API is unavailable");
  const contributedCleanup = setup({
    paseo,
    secrets,
    presence,
    handle: register,
    registerProvider,
    registerSettings,
    on: hooks.on,
    before: hooks.before,
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
    // The runtime re-attaches a session when the daemon drops this socket.
    reconnect: { enabled: true },
    transportFactory,
  });
  paseo = createPaseoApi(daemonClient);
  await daemonClient.connect();
  settingsStore = message.settingsDirectory
    ? new PluginSettingsStore(message.settingsDirectory, (settingsId) =>
        send({ type: "settings.changed", settingsId }),
      )
    : null;
  secretStore = message.settingsDirectory ? new PluginSecretStore(message.settingsDirectory) : null;
  evaluateBundle(message.bundle);
  send({
    type: "ready",
    methods: [...handlers.keys()].sort(),
    hooks: hooks.catalog(),
    providers: [...providers.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(providerMetadata),
    forgeProviders: [...forgeProviders]
      .map(([providerId, contribution]) => describeForgeProvider(providerId, contribution))
      .sort((left, right) => left.definition.id.localeCompare(right.definition.id)),
  });
}

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  const releaseApi = paseo
    ?.dispose()
    .catch((error) => console.error("Plugin API cleanup failed", error));
  hooks.close();
  for (const pending of pendingProviderConnections.values()) pending.tombstoned = true;
  const currentCleanup = cleanup;
  cleanup = null;
  try {
    await currentCleanup?.();
  } catch (error) {
    console.error("Plugin cleanup failed", error);
  }
  await Promise.all([...providerConnections.keys()].map(closeProviderConnection));
  for (const [providerId, contribution] of forgeProviders) {
    if (disposedForgeProviders.has(providerId)) continue;
    disposedForgeProviders.add(providerId);
    try {
      await contribution.service.dispose?.();
    } catch (error) {
      console.error(`Plugin forge provider cleanup failed: ${providerId}`, error);
    }
  }
  await releaseApi;
  await daemonClient?.close().catch(() => undefined);
  await sendAndWait({ type: "paseo_close" });
  daemonClient = null;
  paseo = null;
  for (const pending of pendingPresence.values()) pending.reject(new Error("Plugin stopped"));
  pendingPresence.clear();
  process.disconnect();
}

function handleForgeInvocation(
  message: Extract<PluginProcessRequest, { type: "invoke_forge" }>,
): void {
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
      return contribution.probeHost(message.input as string);
    }
    const method = contribution.service[message.method];
    if (typeof method !== "function") {
      throw new Error(`Forge provider ${message.providerId} does not implement ${message.method}`);
    }
    const invokeMethod = method as (this: PluginForgeServerService, input?: unknown) => unknown;
    if (message.method === "dispose") {
      disposedForgeProviders.add(message.providerId);
      return invokeMethod.call(contribution.service);
    }
    return invokeMethod.call(contribution.service, message.input);
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
}

function handleMessageWhileStopping(message: PluginProcessRequest): void {
  if (message.type === "provider.catalog_key") {
    send({ type: "error", requestId: message.requestId, error: "Plugin is stopping" });
  } else if (message.type === "provider.connect") {
    send({
      type: "provider.connect_failed",
      connectionId: message.connectionId,
      error: "Plugin is stopping",
    });
  } else if (message.type === "provider.send") {
    send({
      type: "provider.rejected",
      connectionId: message.connectionId,
      acceptanceId: message.acceptanceId,
      error: "Plugin is stopping",
    });
  } else if (message.type === "provider.close") {
    send({ type: "provider.closed", connectionId: message.connectionId });
  }
}

process.on("message", (rawMessage: unknown) => {
  const parsed = PluginProcessRequestSchema.safeParse(rawMessage);
  if (!parsed.success) {
    const value = rawMessage as { connectionId?: unknown; acceptanceId?: unknown } | null;
    if (value && typeof value.connectionId === "string" && typeof value.acceptanceId === "string") {
      send({
        type: "provider.rejected",
        connectionId: value.connectionId,
        acceptanceId: value.acceptanceId,
        error: `Invalid provider input: ${parsed.error.message}`,
      });
      void closeProviderConnection(value.connectionId);
      return;
    }
    send({ type: "fatal", error: `Invalid plugin process request: ${parsed.error.message}` });
    void shutdown();
    return;
  }
  const message = parsed.data;
  // Cleanup may still be waiting on presence, so answers are delivered while stopping too.
  if (message.type === "presence.result") {
    pendingPresence.get(message.requestId)?.resolve(message.presence);
    pendingPresence.delete(message.requestId);
    return;
  }
  if (message.type === "initialize") {
    void initialize(message).catch(async (error) => {
      send({ type: "fatal", error: describeError(error) });
      await paseo
        ?.dispose()
        .catch((failure) => console.error("Plugin API cleanup failed", failure));
      await daemonClient?.close().catch(() => undefined);
    });
    return;
  }
  if (message.type === "shutdown") {
    void shutdown();
    return;
  }
  if (stopping) {
    handleMessageWhileStopping(message);
    return;
  }
  if (message.type === "provider.catalog_key") {
    void (async () => {
      const provider = providers.get(message.providerId);
      if (!provider) throw new Error(`Unknown provider: ${message.providerId}`);
      const output = await provider.getCatalogCacheKey?.(message.options);
      if (output !== undefined && typeof output !== "string")
        throw new Error("Invalid catalogue key");
      send({ type: "result", requestId: message.requestId, output });
    })().catch((error) =>
      send({ type: "error", requestId: message.requestId, error: describeError(error) }),
    );
    return;
  }
  if (message.type === "provider.connect") {
    void connectProvider(message).catch((error) => {
      if (stopping) return;
      send({
        type: "provider.connect_failed",
        connectionId: message.connectionId,
        error: describeError(error),
      });
    });
    return;
  }
  if (message.type === "provider.send") {
    void sendProviderInput(message).catch((error) => {
      if (stopping) return;
      send({
        type: "provider.rejected",
        connectionId: message.connectionId,
        acceptanceId: message.acceptanceId,
        error: describeError(error),
      });
    });
    return;
  }
  if (message.type === "provider.close") {
    void closeProviderConnection(message.connectionId);
    return;
  }
  if (message.type === "paseo_frame" || message.type === "paseo_close") return;
  if (isHookMessage(message)) {
    handleHookMessage(message);
    return;
  }
  if (message.type === "invoke_forge") {
    handleForgeInvocation(message);
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

function handleHookMessage(
  message: Extract<PluginProcessRequest, { type: "hook" | "hook.cancel" }>,
): void {
  if (message.type === "hook.cancel") {
    hooks.cancel(message.requestId);
    return;
  }
  if (message.type === "hook") {
    if (!paseo) {
      send({
        type: "error",
        requestId: message.requestId,
        error: "Plugin Paseo API is unavailable",
      });
      return;
    }
    void hooks.invoke(message.requestId, message.kind, message.name, message.input, paseo).then(
      (output) => {
        return send({ type: "result", requestId: message.requestId, output });
      },
      (error) => {
        return send({ type: "error", requestId: message.requestId, error: describeError(error) });
      },
    );
    return;
  }
}

function isHookMessage(
  message: PluginProcessRequest,
): message is Extract<PluginProcessRequest, { type: "hook" | "hook.cancel" }> {
  return message.type === "hook" || message.type === "hook.cancel";
}
