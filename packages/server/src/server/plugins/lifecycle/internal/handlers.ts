import type { PluginHookContext, PluginLifecycleRegistration } from "@getpaseo/plugin/server";
import {
  beforeHookNames,
  lifecycleEventNames,
  validateBeforeRequest,
  validateBeforeResult,
} from "../index.js";

type Handler = (input: unknown, context: PluginHookContext) => unknown;

export class PluginHookHandlers implements PluginLifecycleRegistration {
  private readonly events = new Map<string, Set<Handler>>();
  private readonly transforms = new Map<string, Set<Handler>>();
  private readonly active = new Map<string, AbortController>();

  private readonly changed: () => void;

  constructor(changed: () => void) {
    this.changed = changed;
  }

  readonly on: PluginLifecycleRegistration["on"] = (name, handler) => {
    if (!lifecycleEventNames.includes(name)) {
      throw new Error(`Unknown lifecycle event: ${name}`);
    }
    return this.register(this.events, name, handler as Handler);
  };

  readonly before: PluginLifecycleRegistration["before"] = (name, handler) => {
    if (!beforeHookNames.includes(name)) {
      throw new Error(`Unknown before hook: ${name}`);
    }
    return this.register(this.transforms, name, handler as Handler);
  };

  catalog(): { events: string[]; before: string[] } {
    return { events: [...this.events.keys()], before: [...this.transforms.keys()] };
  }

  async invoke(
    id: string,
    kind: "event" | "before",
    name: string,
    input: unknown,
    paseo: PluginHookContext["paseo"],
  ): Promise<unknown> {
    const controller = new AbortController();
    this.active.set(id, controller);
    try {
      if (kind === "before") {
        if (
          !beforeHookNames.includes(
            name as keyof import("@getpaseo/plugin/server").PluginBeforeRequests,
          )
        ) {
          throw new Error(`Unknown before hook: ${name}`);
        }
        const hookName = name as keyof import("@getpaseo/plugin/server").PluginBeforeRequests;
        let request = validateBeforeRequest(hookName, input);
        for (const handler of this.transforms.get(name) ?? []) {
          controller.signal.throwIfAborted();
          const result = await handler(
            { request: structuredClone(request) },
            { paseo, signal: controller.signal },
          );
          if (result !== undefined) {
            request = validateBeforeResult(hookName, request, result);
          }
        }
        return request;
      }
      for (const handler of this.events.get(name) ?? []) {
        controller.signal.throwIfAborted();
        try {
          await handler(structuredClone(input), { paseo, signal: controller.signal });
        } catch (error) {
          console.error(`Lifecycle hook ${name} failed`, error);
        }
      }
      return null;
    } finally {
      this.active.delete(id);
    }
  }

  cancel(id: string): void {
    this.active.get(id)?.abort();
  }

  close(): void {
    for (const controller of this.active.values()) {
      controller.abort();
    }
    this.events.clear();
    this.transforms.clear();
  }

  private register(
    registry: Map<string, Set<Handler>>,
    name: string,
    handler: Handler,
  ): () => void {
    let handlers = registry.get(name);
    if (!handlers) {
      handlers = new Set();
      registry.set(name, handlers);
    }
    handlers.add(handler);
    this.changed();
    return () => {
      if (!handlers.delete(handler)) {
        return;
      }
      if (handlers.size === 0) {
        registry.delete(name);
      }
      this.changed();
    };
  }
}
