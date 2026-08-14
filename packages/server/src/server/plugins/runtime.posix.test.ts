import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { PluginRuntime } from "./runtime.js";

const temporaryDirectories: string[] = [];

async function createPlugin(id: string, source: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-"));
  temporaryDirectories.push(directory);
  await writeFile(path.join(directory, "paseo-plugin.json"), JSON.stringify({ id }), "utf8");
  await writeFile(path.join(directory, "index.tsx"), source, "utf8");
  return directory;
}

function createReloadChild(name: string, events: string[], methods: string[] = []) {
  const listeners = new Map<string, Array<(message: never) => void>>();
  const emit = (event: string, message: unknown) => {
    for (const listener of listeners.get(event) ?? []) listener(message as never);
  };
  return {
    connected: true,
    killed: false,
    send(message: { type: string }, callback?: (error: Error | null) => void) {
      callback?.(null);
      if (message.type === "initialize") {
        events.push(`start:${name}`);
        queueMicrotask(() => emit("message", { type: "ready", methods }));
      }
      if (message.type === "shutdown") {
        events.push(`shutdown:${name}`);
        this.connected = false;
        queueMicrotask(() => {
          events.push(`exit:${name}`);
          emit("close", null);
        });
      }
      return true;
    },
    kill() {
      this.killed = true;
      this.connected = false;
      queueMicrotask(() => emit("close", null));
      return true;
    },
    disconnect() {
      this.connected = false;
    },
    on(event: string, listener: (message: never) => void) {
      const registered = listeners.get(event) ?? [];
      registered.push(listener);
      listeners.set(event, registered);
      return this;
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("PluginRuntime", () => {
  it("waits for the old subprocess to exit before starting its replacement", async () => {
    const directory = await createPlugin(
      "reloadable",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const events: string[] = [];
    const children = [createReloadChild("old", events), createReloadChild("new", events)];
    const runtime = new PluginRuntime(pino({ level: "silent" }), {
      spawnChild: () => {
        const child = children.shift();
        if (!child) throw new Error("Unexpected extra child");
        return child;
      },
    });
    await runtime.startPlugin("configured-id", directory);

    await runtime.stopPluginById("configured-id");
    await runtime.startPlugin("configured-id", directory);

    expect(events).toEqual(["start:old", "shutdown:old", "exit:old", "start:new"]);
    await runtime.stopAll();
  });

  it("rejects pending RPCs when the plugin stops", async () => {
    const directory = await createPlugin(
      "pending",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const child = createReloadChild("pending", [], ["wait"]);
    const runtime = new PluginRuntime(pino({ level: "silent" }), {
      spawnChild: () => child,
    });
    await runtime.startPlugin("pending", directory);

    const rejection = expect(runtime.invoke("pending", "wait", {})).rejects.toThrow(
      "Plugin stopped: pending",
    );
    await runtime.stopPluginById("pending");

    await rejection;
  });

  it("kills a plugin child that fails initialization", async () => {
    const directory = await createPlugin(
      "broken",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const listeners = new Map<string, Array<(message: never) => void>>();
    const child = {
      connected: true,
      killed: false,
      send(message: { type: string }, callback?: (error: Error | null) => void) {
        callback?.(null);
        if (message.type === "initialize") {
          queueMicrotask(() => {
            for (const listener of listeners.get("message") ?? []) {
              listener({ type: "fatal", error: "broken plugin" } as never);
            }
          });
        }
        return true;
      },
      kill() {
        this.killed = true;
        this.connected = false;
        return true;
      },
      disconnect() {
        this.connected = false;
      },
      on(event: string, listener: (message: never) => void) {
        const registered = listeners.get(event) ?? [];
        registered.push(listener);
        listeners.set(event, registered);
        return this;
      },
    };
    const runtime = new PluginRuntime(pino({ level: "silent" }), {
      spawnChild: () => child,
    });

    await expect(runtime.startPlugin("broken", directory)).rejects.toThrow("broken plugin");

    expect(child.killed).toBe(true);
    await runtime.stopAll();
  });

  it("rejects a server contribution without cleanup", async () => {
    const directory = await createPlugin(
      "missing-cleanup",
      `export default function contribute(plugin: unknown) { void plugin; }`,
    );
    const runtime = new PluginRuntime(pino({ level: "silent" }));

    await expect(runtime.startPlugin("missing-cleanup", directory)).rejects.toThrow(
      "must return a cleanup function",
    );
    expect(runtime.catalog()).toEqual([]);
    await runtime.stopAll();
  });

  it("loads the official Linear attachment extension", async () => {
    const directory = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../../plugin-examples/linear",
    );
    const runtime = new PluginRuntime(pino({ level: "silent" }));

    await runtime.startPlugin("linear", directory);

    expect(runtime.catalog().map((plugin) => plugin.id)).toEqual(["linear"]);
    expect(runtime.catalog()[0]?.clientBundle).toContain("Attach Linear issue");
    expect(runtime.catalog()[0]?.clientBundle).not.toContain("LINEAR_API_KEY");
    expect(runtime.catalog()[0]?.clientBundle).not.toContain("api.linear.app");
    await runtime.stopAll();
  });

  it("loads one index.tsx, exposes its client bundle, and invokes its server RPC", async () => {
    const directory = await createPlugin(
      "hello",
      `import React from "react";
import { platform } from "node:os";
import { Text } from "react-native";
import { z } from "zod";
import { defineAttachmentSource, defineRpc } from "@paseo/plugin";

const greetRpc = defineRpc({
  name: "greet",
  input: z.object({ name: z.string() }),
  output: z.object({ message: z.string(), platform: z.string() }),
});

const attachments = defineAttachmentSource({
  id: "issues",
  title: "Example issue",
  icon: "CircleDot",
  pickerTitle: "Attach example issue",
  searchPlaceholder: "Search issues",
  search: greetRpc,
});

function HelloSurface() {
  return <Text>Hello from native UI</Text>;
}

export default function contribute(plugin: any) {
  plugin.handle(greetRpc, async (input: { name: string }) => ({
    message: "Hello, " + input.name,
    platform: platform(),
  }));
  plugin.addSurface("main", HelloSurface);
  plugin.addSidebarItem({ id: "hello", title: "Hello", icon: "Sparkles", surface: "main" });
  plugin.addAttachmentSource(attachments);
  return () => undefined;
}`,
    );
    const runtime = new PluginRuntime(pino({ level: "silent" }));

    await runtime.startPlugin("hello", directory);

    const catalog = runtime.catalog();
    expect(catalog).toHaveLength(1);
    expect(catalog[0]?.id).toBe("hello");
    expect(catalog[0]?.clientBundle).toContain("Hello from native UI");
    expect(catalog[0]?.clientBundle).toContain("Attach example issue");
    expect(catalog[0]?.clientBundle).not.toContain("node:os");
    expect(catalog[0]?.clientBundle).not.toContain("get: () => from[key]");
    await expect(runtime.invoke("hello", "greet", { name: "Paseo" })).resolves.toMatchObject({
      message: "Hello, Paseo",
    });
    await expect(runtime.invoke("hello", "greet", { name: 7 })).rejects.toThrow();

    await runtime.stopAll();
  });

  it("rejects a handler result that does not match its RPC output schema", async () => {
    const directory = await createPlugin(
      "invalid-output",
      `import { z } from "zod";
import { defineRpc } from "@paseo/plugin";
const brokenRpc = defineRpc({
  name: "broken",
  input: z.object({}),
  output: z.object({ value: z.number() }),
});
export default function contribute(plugin: any) {
  plugin.handle(brokenRpc, async () => ({ value: "wrong" }));
  return () => undefined;
}`,
    );
    const runtime = new PluginRuntime(pino({ level: "silent" }));

    await runtime.startPlugin("invalid-output", directory);

    await expect(runtime.invoke("invalid-output", "broken", {})).rejects.toThrow();
    await runtime.stopAll();
  });

  it("uses the config key as runtime identity without comparing the manifest id", async () => {
    const directory = await createPlugin(
      "actual",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const runtime = new PluginRuntime(pino({ level: "silent" }));

    await runtime.startPlugin("configured", directory);

    expect(runtime.catalog().map((plugin) => plugin.id)).toEqual(["configured"]);
    await runtime.stopAll();
  });

  it("does not publish a plugin when lifecycle intent changes while it starts", async () => {
    const directory = await createPlugin(
      "blocked",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const events: string[] = [];
    const child = createReloadChild("blocked", events);
    const runtime = new PluginRuntime(pino({ level: "silent" }), { spawnChild: () => child });

    await expect(runtime.startPlugin("blocked", directory, () => false)).rejects.toThrow(
      "Plugin start cancelled: blocked",
    );

    expect(runtime.catalog()).toEqual([]);
    expect(events).toEqual(["start:blocked", "shutdown:blocked", "exit:blocked"]);
  });

  it("reports an unexpected subprocess crash and removes its catalog entry", async () => {
    const directory = await createPlugin(
      "crashing",
      `export default function contribute(plugin: unknown) {
  void plugin;
  setTimeout(() => process.exit(17), 20);
  return () => undefined;
}`,
    );
    const runtime = new PluginRuntime(pino({ level: "silent" }));
    const crashed = new Promise<string>((resolve) => {
      runtime.subscribe((pluginId, error) => {
        if (pluginId === "crashing" && error) resolve(error);
      });
    });
    await runtime.startPlugin("crashing", directory);

    await expect(crashed).resolves.toBe("Plugin process exited: crashing");
    expect(runtime.catalog()).toEqual([]);
    await expect(runtime.invoke("crashing", "anything", {})).rejects.toThrow(
      "Plugin is not available",
    );
  });
});
