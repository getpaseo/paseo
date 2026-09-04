import { createRequire } from "node:module";
import { Buffer } from "node:buffer";
import {
  defineAttachmentSource,
  defineRpc,
  defineTool,
  type PluginHandlerContext,
  type PluginRpcContract,
  type PluginToolContribution,
  type PluginToolHandlerContext,
} from "@getpaseo/plugin/server";
import { createPaseoPluginApi, type PaseoPluginApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createPluginDaemonTransportFactory } from "./daemon-transport.js";
import {
  validatePluginProcessMessage,
  validatePluginProcessRequest,
  type PluginProcessMessage,
  type PluginProcessRequest,
  type PluginToolCallerContext,
  type PluginToolCatalogEntry,
} from "./plugin-process-protocol.js";
import {
  PLUGIN_TOOL_MAX_UPDATE_BYTES,
  PLUGIN_TOOL_MAX_UPDATE_COUNT,
  PLUGIN_TOOL_MAX_UPDATE_TOTAL_BYTES,
  PLUGIN_TOOL_MAX_ERROR_BYTES,
  PLUGIN_TOOL_MAX_DESCRIPTION_BYTES,
  PLUGIN_TOOL_MAX_NAME_BYTES,
  PLUGIN_TOOL_MAX_TITLE_BYTES,
  assertSafeJson,
  assertSafePluginToolText,
  clampPluginToolTimeout,
  serializePluginToolSchema,
  truncateUtf8,
} from "./plugin-tool.js";
import { isPluginClientOnlySdkSpecifier, isPluginSdkSpecifier } from "./plugin-sdk-specifiers.js";
import { sendPluginProcessMessage } from "./bounded-process-send.js";

type RpcHandler = (input: unknown, context: PluginHandlerContext) => unknown | Promise<unknown>;
type ToolHandler = (
  input: unknown,
  context: PluginToolHandlerContext,
) => unknown | Promise<unknown>;

interface RegisteredRpc {
  contract: PluginRpcContract;
  handler: RpcHandler;
}

interface RegisteredTool {
  definition: PluginToolContribution;
  handler: ToolHandler;
  timeoutMs: number;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

const handlers = new Map<string, RegisteredRpc>();
const tools = new Map<string, RegisteredTool>();
const activeTools = new Map<
  string,
  { controller: AbortController; done: Promise<void>; cancelAck: Promise<void> | null }
>();
const activeRpcs = new Map<
  string,
  { controller: AbortController; done: Promise<void>; cancelAck: Promise<void> | null }
>();
let cleanup: (() => void | Promise<void>) | null = null;
let daemonClient: DaemonClient | null = null;
let paseo: PaseoPluginApi | null = null;
let stopping = false;
const nodeRequire = createRequire(import.meta.url);

let ipcFailureShutdown: Promise<void> | null = null;

function send(message: PluginProcessMessage): void {
  const validated = validatePluginProcessMessage(message);
  void sendPluginProcessMessage(process.send?.bind(process), validated).catch((error) => {
    console.error(`Plugin IPC send failed: ${describeError(error)}`);
    ipcFailureShutdown ??= shutdown().catch(() => undefined);
  });
}

function sendAndWait(message: PluginProcessMessage): Promise<void> {
  return sendPluginProcessMessage(
    process.send?.bind(process),
    validatePluginProcessMessage(message),
  );
}

async function sendSettled(message: PluginProcessMessage): Promise<void> {
  try {
    await sendAndWait(message);
  } catch (error) {
    console.error(`Plugin IPC send failed: ${describeError(error)}`);
    ipcFailureShutdown ??= shutdown().catch(() => undefined);
    throw error;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundError(error: unknown): string {
  return truncateUtf8(describeError(error), PLUGIN_TOOL_MAX_ERROR_BYTES);
}

function validateName(name: string, kind: string): string {
  if (typeof name !== "string" || name.length === 0 || name.trim() !== name) {
    throw new Error(`Invalid plugin ${kind} name: ${name}`);
  }
  if (!/^[a-z][a-z0-9._-]*$/u.test(name)) {
    throw new Error(`Invalid plugin ${kind} name: ${name}`);
  }
  assertSafePluginToolText(name, `Plugin ${kind} name`, PLUGIN_TOOL_MAX_NAME_BYTES);
  return name;
}

function register(contract: PluginRpcContract, handler: RpcHandler): void {
  if (typeof handler !== "function") {
    throw new Error(`Plugin RPC ${contract.name} must provide a handler`);
  }
  const method = validateName(contract.name, "RPC");
  if (handlers.has(method)) throw new Error(`Duplicate plugin RPC method: ${method}`);
  handlers.set(method, { contract: { ...contract, name: method }, handler });
}

function registerTool(definition: PluginToolContribution, handler?: ToolHandler): void {
  if (typeof definition !== "object" || definition === null) {
    throw new Error("Plugin tool definition must be an object");
  }
  const name = validateName(definition.name, "tool");
  if (tools.has(name)) throw new Error(`Duplicate plugin tool name: ${name}`);
  if (typeof definition.title !== "string" || definition.title.trim().length === 0) {
    throw new Error(`Plugin tool ${name} must provide a title`);
  }
  assertSafePluginToolText(
    definition.title,
    `Plugin tool ${name} title`,
    PLUGIN_TOOL_MAX_TITLE_BYTES,
  );
  if (typeof definition.description !== "string" || definition.description.trim().length === 0) {
    throw new Error(`Plugin tool ${name} must provide a description`);
  }
  assertSafePluginToolText(
    definition.description,
    `Plugin tool ${name} description`,
    PLUGIN_TOOL_MAX_DESCRIPTION_BYTES,
  );
  if (!definition.input || typeof definition.input.parseAsync !== "function") {
    throw new Error(`Plugin tool ${name} must provide a Zod input schema`);
  }
  if (definition.output !== undefined && typeof definition.output.parseAsync !== "function") {
    throw new Error(`Plugin tool ${name} output must be a Zod schema`);
  }
  const inputSchema = serializePluginToolSchema(definition.input, `${name}.input`, {
    requireObject: true,
  });
  const outputSchema = definition.output
    ? serializePluginToolSchema(definition.output, `${name}.output`)
    : undefined;
  const actualHandler = handler ?? (definition.handler as ToolHandler);
  if (typeof actualHandler !== "function")
    throw new Error(`Plugin tool ${name} must provide a handler`);
  tools.set(name, {
    definition: { ...definition, name },
    handler: actualHandler,
    timeoutMs: clampPluginToolTimeout(definition.timeoutMs),
    inputSchema,
    ...(outputSchema ? { outputSchema } : {}),
  });
}

const pluginAuthorRuntime = {
  defineAttachmentSource,
  defineRpc,
  defineTool,
  Icon() {
    throw new Error("Icon is available only in plugin client code");
  },
};

function runtimeRequire(name: string): unknown {
  if (isPluginClientOnlySdkSpecifier(name)) {
    throw new Error(`${name} is available only in plugin client code`);
  }
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
  const contributedCleanup = setup({ handle: register, addTool: registerTool });
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

function freezeSnapshot<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeSnapshot(child, seen);
  return Object.freeze(value);
}

function createToolContext(
  message: PluginToolCallerContext,
  controller: AbortController,
  reportProgress: (update: unknown) => void,
): PluginToolHandlerContext {
  if (!paseo) throw new Error("Plugin Paseo API is unavailable");
  return {
    paseo,
    callerAgentId: message.callerAgentId,
    agent: freezeSnapshot(message.agent),
    workspace: freezeSnapshot(message.workspace),
    signal: controller.signal,
    progress: reportProgress,
  } as PluginToolHandlerContext;
}

function invokeTool(message: Extract<PluginProcessRequest, { type: "tool_invoke" }>): void {
  const registered = tools.get(message.name);
  if (!registered) {
    send({
      type: "tool_error",
      requestId: message.requestId,
      error: `Unknown plugin tool: ${message.name}`,
    });
    return;
  }
  const controller = new AbortController();
  let updateCount = 0;
  let updateBytes = 0;
  const reportProgress = (update: unknown): void => {
    if (updateCount >= PLUGIN_TOOL_MAX_UPDATE_COUNT) return;
    try {
      assertSafeJson(update, "Plugin tool progress update", PLUGIN_TOOL_MAX_UPDATE_BYTES);
      const bytes = Buffer.byteLength(JSON.stringify(update), "utf8");
      if (updateBytes + bytes > PLUGIN_TOOL_MAX_UPDATE_TOTAL_BYTES) return;
      updateCount += 1;
      updateBytes += bytes;
      send({ type: "tool_update", requestId: message.requestId, update });
    } catch (error) {
      // Progress is best effort. The final tool result still has a chance to
      // complete when a plugin emits an invalid progress value.
      console.error(`Plugin tool progress dropped: ${describeError(error)}`);
    }
  };
  const run = (async () => {
    try {
      const input = await registered.definition.input.parseAsync(message.input);
      const output = await registered.handler(
        input,
        createToolContext(message.context, controller, reportProgress),
      );
      const parsedOutput = registered.definition.output
        ? await registered.definition.output.parseAsync(output)
        : output;
      assertSafeJson(parsedOutput, "Plugin tool output");
      await sendSettled({
        type: "tool_result",
        requestId: message.requestId,
        output: parsedOutput,
      });
    } catch (error) {
      await sendSettled({
        type: "tool_error",
        requestId: message.requestId,
        error: boundError(error),
      }).catch(() => undefined);
    } finally {
      activeTools.delete(message.requestId);
    }
  })();
  activeTools.set(message.requestId, { controller, done: run, cancelAck: null });
}

function invokeRpc(message: Extract<PluginProcessRequest, { type: "invoke" }>): void {
  const registered = handlers.get(message.method);
  if (!registered) {
    send({
      type: "error",
      requestId: message.requestId,
      error: `Unknown RPC method: ${message.method}`,
    });
    return;
  }
  const controller = new AbortController();
  const run = (async () => {
    try {
      const input = await registered.contract.input.parseAsync(message.input);
      if (!paseo) throw new Error("Plugin Paseo API is unavailable");
      const output = await registered.handler(input, { paseo, signal: controller.signal });
      const parsedOutput = await registered.contract.output.parseAsync(output);
      await sendSettled({ type: "result", requestId: message.requestId, output: parsedOutput });
    } catch (error) {
      await sendSettled({
        type: "error",
        requestId: message.requestId,
        error: boundError(error),
      }).catch(() => undefined);
    } finally {
      activeRpcs.delete(message.requestId);
    }
  })();
  activeRpcs.set(message.requestId, { controller, done: run, cancelAck: null });
}

async function initialize(message: Extract<PluginProcessRequest, { type: "initialize" }>) {
  daemonClient = new DaemonClient({
    url: `ipc://plugin/${encodeURIComponent(message.pluginId)}`,
    clientId: `plugin:${message.pluginId}`,
    clientType: "cli",
    appVersion: message.appVersion,
    reconnect: { enabled: false },
    transportFactory,
  });
  paseo = createPaseoPluginApi(daemonClient);
  await daemonClient.connect();
  evaluateBundle(message.bundle);
  const catalog: PluginToolCatalogEntry[] = Array.from(tools.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, tool]) => {
      const entry: PluginToolCatalogEntry = {
        pluginId: message.pluginId,
        generation: message.generation ?? 1,
        installationId: message.installationId,
        name,
        title: tool.definition.title,
        description: tool.definition.description,
        inputSchema: tool.inputSchema,
        timeoutMs: tool.timeoutMs,
      };
      if (tool.outputSchema) entry.outputSchema = tool.outputSchema;
      return entry;
    });
  send({ type: "ready", methods: [...handlers.keys()].sort(), catalog });
}

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  for (const active of activeTools.values())
    active.controller.abort(new Error("Plugin is stopping"));
  for (const active of activeRpcs.values())
    active.controller.abort(new Error("Plugin is stopping"));
  const active = [
    ...[...activeTools.values()].map(({ done }) => done),
    ...[...activeRpcs.values()].map(({ done }) => done),
  ];
  await Promise.race([
    Promise.allSettled(active),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  const currentCleanup = cleanup;
  cleanup = null;
  await Promise.race([
    Promise.resolve(currentCleanup?.()).catch((error) => {
      console.error("Plugin cleanup failed", error);
    }),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
  await Promise.race([
    daemonClient?.close().catch(() => undefined) ?? Promise.resolve(),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
  await sendAndWait({ type: "paseo_close" }).catch(() => undefined);
  daemonClient = null;
  paseo = null;
  process.disconnect?.();
  process.exit(0);
}

process.on("message", (rawMessage: unknown) => {
  let message: PluginProcessRequest;
  try {
    message = validatePluginProcessRequest(rawMessage);
  } catch (error) {
    send({ type: "fatal", error: `Invalid plugin process request: ${describeError(error)}` });
    return;
  }
  if (message.type === "initialize") {
    void initialize(message).catch(async (error) => {
      send({ type: "fatal", error: boundError(error) });
      await daemonClient?.close().catch(() => undefined);
    });
    return;
  }
  if (message.type === "shutdown") {
    void shutdown();
    return;
  }
  if (message.type === "tool_cancel") {
    const active = activeTools.get(message.requestId);
    if (!active) {
      send({ type: "tool_cancel_ack", requestId: message.requestId });
      return;
    }
    active.controller.abort(new Error("Plugin tool invocation cancelled"));
    active.cancelAck ??= active.done.then(
      () => send({ type: "tool_cancel_ack", requestId: message.requestId }),
      () => send({ type: "tool_cancel_ack", requestId: message.requestId }),
    );
    void active.cancelAck.catch(() => undefined);
    return;
  }
  if (message.type === "rpc_cancel") {
    const active = activeRpcs.get(message.requestId);
    if (!active) {
      send({ type: "rpc_cancel_ack", requestId: message.requestId });
      return;
    }
    active.controller.abort(new Error("Plugin RPC invocation cancelled"));
    active.cancelAck ??= active.done.then(
      () => sendAndWait({ type: "rpc_cancel_ack", requestId: message.requestId }),
      () => sendAndWait({ type: "rpc_cancel_ack", requestId: message.requestId }),
    );
    void active.cancelAck.catch(() => undefined);
    return;
  }
  if (message.type === "tool_invoke") {
    if (!stopping) invokeTool(message);
    return;
  }
  if (message.type === "paseo_frame" || message.type === "paseo_close") return;
  if (stopping) return;
  invokeRpc(message);
});
