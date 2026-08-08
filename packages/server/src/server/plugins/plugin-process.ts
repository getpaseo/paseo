import type { PluginProcessMessage, PluginProcessRequest } from "./plugin-process-protocol.js";
import { createRequire } from "node:module";
import type { ZodType } from "zod";

type RpcHandler = (input: unknown) => unknown | Promise<unknown>;

interface RpcContract {
  name: string;
  input: ZodType;
  output: ZodType;
}

interface RegisteredRpc {
  contract: RpcContract;
  handler: RpcHandler;
}

const handlers = new Map<string, RegisteredRpc>();
const nodeRequire = createRequire(import.meta.url);

function send(message: PluginProcessMessage): void {
  process.send?.(message);
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

function defineRpc(contract: RpcContract): RpcContract {
  return { ...contract, name: contract.name.trim() };
}

function defineAttachmentSource<T>(definition: T): T {
  return definition;
}

function register(contract: RpcContract, handler: RpcHandler): void {
  if (typeof handler !== "function") {
    throw new Error(`Plugin RPC ${contract.name} must provide a handler`);
  }
  const method = validateMethod(contract.name);
  handlers.set(method, { contract: { ...contract, name: method }, handler });
}

function runtimeRequire(name: string): unknown {
  if (name === "@paseo/plugin") return { defineAttachmentSource, defineRpc };
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
  setup({ handle: register });
}

process.on("message", (message: PluginProcessRequest) => {
  if (message.type === "initialize") {
    try {
      evaluateBundle(message.bundle);
      send({ type: "ready", methods: [...handlers.keys()].sort() });
    } catch (error) {
      send({ type: "fatal", error: describeError(error) });
    }
    return;
  }
  if (message.type === "shutdown") {
    process.disconnect();
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
    .then(registered.handler)
    .then((output) => registered.contract.output.parseAsync(output))
    .then(
      (output) => send({ type: "result", requestId: message.requestId, output }),
      (error) => send({ type: "error", requestId: message.requestId, error: describeError(error) }),
    );
});
