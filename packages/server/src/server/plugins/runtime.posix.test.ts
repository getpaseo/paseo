import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ForgeCommandError } from "../../services/forge-cli-command.js";
import { forgeAuthStateFromError, isForgeAuthError } from "../../utils/checkout-git.js";
import { PluginRuntime } from "./runtime.js";
import type { PluginSessionSocket } from "./session-socket.js";

const temporaryDirectories: string[] = [];

async function createPlugin(id: string, source: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-"));
  temporaryDirectories.push(directory);
  await writeFile(path.join(directory, "paseo-plugin.json"), JSON.stringify({ id }), "utf8");
  await writeFile(path.join(directory, "index.server.ts"), source, "utf8");
  return directory;
}

function createReloadChild(name: string, events: string[], methods: string[] = []) {
  const listeners = new Map<string, Array<(message: never) => void>>();
  const emit = (event: string, message: unknown) => {
    for (const listener of listeners.get(event) ?? []) listener(message as never);
  };
  return {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    connected: true,
    killed: false,
    send(message: { type: string }, callback?: (error: Error | null) => void) {
      callback?.(null);
      if (message.type === "initialize") {
        events.push(`start:${name}`);
        queueMicrotask(() => emit("message", { type: "ready", methods, forgeProviders: [] }));
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

function createTestRuntime(
  dependencies: NonNullable<ConstructorParameters<typeof PluginRuntime>[2]> = {},
  logger = pino({ level: "silent" }),
): PluginRuntime {
  return new PluginRuntime(logger, "0.4.0", {
    ...dependencies,
    sessionHost: dependencies.sessionHost ?? {
      async attachPluginSocket(_pluginId, socket) {
        const closed = new Promise<void>((resolve) => socket.once("close", resolve));
        socket.on("message", (data) => {
          if (typeof data !== "string") return;
          const message = JSON.parse(data);
          if (message.type !== "hello") return;
          socket.send(
            JSON.stringify({
              type: "session",
              message: {
                type: "status",
                payload: {
                  status: "server_info",
                  serverId: "plugin-test",
                  hostname: "plugin-test",
                  version: "0.4.0",
                  features: {},
                },
              },
            }),
          );
        });
        return { closed };
      },
    },
  });
}

function createTrackedSessionHost() {
  const active = new Set<object>();
  return {
    active,
    host: {
      async attachPluginSocket(_pluginId: string, socket: PluginSessionSocket) {
        const closed = new Promise<void>((resolve) => socket.once("close", resolve));
        active.add(socket);
        socket.once("close", () => active.delete(socket));
        socket.on("message", (data) => {
          if (typeof data !== "string") return;
          const message = JSON.parse(data);
          if (message.type !== "hello") return;
          socket.send(
            JSON.stringify({
              type: "session",
              message: {
                type: "status",
                payload: {
                  status: "server_info",
                  serverId: "tracked-plugin-test",
                  hostname: "tracked-plugin-test",
                  version: "0.4.0",
                  features: {},
                },
              },
            }),
          );
        });
        return { closed };
      },
    },
  };
}

function lifecycleMessages(runtime: PluginRuntime): string[] {
  return runtime
    .getLogs("lifecycle-output")
    .map((entry) => entry.message)
    .filter((message) => message === "initialized" || message === "initialization warning")
    .sort();
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("PluginRuntime", () => {
  it("records host-owned plugin lifecycle events", async () => {
    const directory = await createPlugin(
      "lifecycle",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const child = createReloadChild("lifecycle", []);
    const runtime = createTestRuntime({ spawnChild: () => child });

    await runtime.startPlugin("lifecycle", directory);
    await runtime.stopPluginById("lifecycle");

    expect(
      runtime.getLogs("lifecycle").map(({ stream, message }) => ({ stream, message })),
    ).toEqual([
      { stream: "stdout", message: "[paseo] Loading plugin" },
      { stream: "stdout", message: "[paseo] Plugin ready" },
      { stream: "stdout", message: "[paseo] Stopping plugin" },
      { stream: "stdout", message: "[paseo] Plugin stopped" },
    ]);
  });

  it("frames stdout and stderr, normalizes CRLF, and flushes final fragments once", async () => {
    const directory = await createPlugin(
      "output",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const child = createReloadChild("output", []);
    const runtime = createTestRuntime({ spawnChild: () => child });
    await runtime.startPlugin("output", directory);

    child.stdout.write("first\r");
    child.stdout.write("\n");
    child.stderr.write("problem\nfinal stderr");
    child.stdout.write("final stdout");
    await runtime.stopPluginById("output");

    const logs = runtime.getLogs("output");
    expect(
      logs
        .filter((entry) => !entry.message.startsWith("[paseo]"))
        .map(({ stream, message }) => ({ stream, message })),
    ).toEqual([
      { stream: "stdout", message: "first" },
      { stream: "stderr", message: "problem" },
      { stream: "stderr", message: "final stderr" },
      { stream: "stdout", message: "final stdout" },
    ]);
    expect(logs.map((entry) => entry.sequence)).toEqual(
      Array.from({ length: logs.length }, (_, index) => index + 1),
    );
  });

  it("writes plugin output through the daemon logger with structured identity fields", async () => {
    const directory = await createPlugin(
      "tagged-output",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const child = createReloadChild("tagged-output", []);
    const records: Array<Record<string, unknown>> = [];
    const logger = pino(
      { level: "info" },
      { write: (line: string) => records.push(JSON.parse(line) as Record<string, unknown>) },
    );
    const runtime = createTestRuntime({ spawnChild: () => child }, logger);
    await runtime.startPlugin("tagged-output", directory);

    child.stderr.write("connection failed\n");

    expect(records.find((record) => record.message === "connection failed")).toMatchObject({
      module: "plugins",
      pluginId: "tagged-output",
      sequence: 3,
      stream: "stderr",
      message: "connection failed",
    });
    expect(records.find((record) => record.message === "connection failed")?.timestamp).toEqual(
      expect.any(String),
    );
    await runtime.stopAll();
  });

  it("bounds retained output by entry count, total bytes, and individual line bytes", async () => {
    const directory = await createPlugin(
      "noisy",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const child = createReloadChild("noisy", []);
    const runtime = createTestRuntime({ spawnChild: () => child });
    await runtime.startPlugin("noisy", directory);

    child.stdout.write(
      `${Array.from({ length: 510 }, (_, index) => `line-${index}`).join("\n")}\n`,
    );
    expect(runtime.getLogs("noisy")).toHaveLength(500);
    expect(runtime.getLogs("noisy")[0]?.message).toBe("line-10");

    child.stdout.write(`${Array.from({ length: 20 }, () => "x".repeat(16 * 1024)).join("\n")}\n`);
    expect(runtime.getLogs("noisy")).toHaveLength(16);

    child.stderr.write("y".repeat(20 * 1024));
    await runtime.stopPluginById("noisy");
    const logs = runtime.getLogs("noisy");
    expect(logs.length).toBeLessThanOrEqual(500);
    expect(
      logs.reduce((bytes, entry) => bytes + Buffer.byteLength(entry.message), 0),
    ).toBeLessThanOrEqual(256 * 1024);
    expect(logs.every((entry) => Buffer.byteLength(entry.message) <= 16 * 1024)).toBe(true);
    expect(logs).toContainEqual(
      expect.objectContaining({ stream: "stderr", message: "y".repeat(16 * 1024) }),
    );
  });

  it("captures output emitted during initialization and cleanup across reloads", async () => {
    const directory = await createPlugin(
      "lifecycle-output",
      `export default function contribute(plugin: unknown) {
  void plugin;
  console.log("initialized");
  console.error("initialization warning");
  return () => process.stdout.write("cleanup fragment");
}`,
    );
    const runtime = createTestRuntime();

    await runtime.startPlugin("lifecycle-output", directory);
    await expect
      .poll(() => lifecycleMessages(runtime))
      .toEqual(["initialization warning", "initialized"]);
    await runtime.stopPluginById("lifecycle-output");
    await runtime.startPlugin("lifecycle-output", directory);
    await runtime.stopPluginById("lifecycle-output");

    const logs = runtime.getLogs("lifecycle-output");
    expect(
      logs
        .filter((entry) => entry.stream === "stdout")
        .map((entry) => entry.message)
        .filter((message) => message === "initialized" || message === "cleanup fragment"),
    ).toEqual(["initialized", "cleanup fragment", "initialized", "cleanup fragment"]);
    expect(
      logs
        .filter((entry) => entry.stream === "stderr")
        .map((entry) => entry.message)
        .filter((message) => message === "initialization warning"),
    ).toEqual(["initialization warning", "initialization warning"]);
    expect(logs.map((entry) => entry.sequence)).toEqual(
      Array.from({ length: logs.length }, (_, index) => index + 1),
    );
  }, 20_000);

  it("retains compilation failures in the plugin stderr tail", async () => {
    const directory = await createPlugin("broken-compile", `export default function contribute( {`);
    const runtime = createTestRuntime();

    await expect(runtime.startPlugin("broken-compile", directory)).rejects.toThrow();

    expect(
      runtime.getLogs("broken-compile").map(({ stream, message }) => ({ stream, message })),
    ).toEqual([
      {
        stream: "stdout",
        message: "[paseo] Loading plugin",
      },
      {
        stream: "stderr",
        message: expect.stringContaining("Plugin failed to load:"),
      },
    ]);
    await runtime.stopAll();
  });

  it("waits for the old subprocess to exit before starting its replacement", async () => {
    const directory = await createPlugin(
      "reloadable",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const events: string[] = [];
    const children = [createReloadChild("old", events), createReloadChild("new", events)];
    const runtime = createTestRuntime({
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
    const runtime = createTestRuntime({
      spawnChild: () => child,
    });
    await runtime.startPlugin("pending", directory);

    const rejection = expect(runtime.invoke("pending", "wait", {})).rejects.toThrow(
      "Plugin stopped: pending",
    );
    await runtime.stopPluginById("pending");

    await rejection;
  });

  it("waits for asynchronous plugin cleanup before stopping", async () => {
    const cleanupFile = path.join(tmpdir(), `paseo-plugin-cleanup-${Date.now()}`);
    const directory = await createPlugin(
      "async-cleanup",
      `import { writeFile } from "node:fs/promises";
export default function contribute(plugin: unknown) {
  void plugin;
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(${JSON.stringify(cleanupFile)}, "cleaned");
  };
}`,
    );
    const runtime = createTestRuntime();
    await runtime.startPlugin("async-cleanup", directory);

    await runtime.stopPluginById("async-cleanup");

    await expect(readFile(cleanupFile, "utf8")).resolves.toBe("cleaned");
    await rm(cleanupFile, { force: true });
  });

  it("does not kill a healthy child while its graceful cleanup is still running", async () => {
    vi.useFakeTimers();
    try {
      const directory = await createPlugin(
        "held-cleanup",
        `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
      );
      const events: string[] = [];
      const child = createReloadChild("held-cleanup", events);
      const originalSend = child.send.bind(child);
      let releaseCleanup = () => undefined;
      child.send = (message, callback) => {
        if (message.type !== "shutdown") return originalSend(message, callback);
        callback?.(null);
        events.push("shutdown:held-cleanup");
        releaseCleanup = () => {
          child.connected = false;
          child.kill();
          child.killed = false;
        };
        return true;
      };
      const runtime = createTestRuntime({ spawnChild: () => child });
      await runtime.startPlugin("held-cleanup", directory);

      const stopping = runtime.stopPluginById("held-cleanup");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(child.killed).toBe(false);

      releaseCleanup();
      await stopping;
      expect(events).toContain("shutdown:held-cleanup");
    } finally {
      vi.useRealTimers();
    }
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
    const runtime = createTestRuntime({
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
    const runtime = createTestRuntime();

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
    const runtime = createTestRuntime();

    await runtime.startPlugin("linear", directory);

    expect(runtime.catalog().map((plugin) => plugin.id)).toEqual(["linear"]);
    expect(runtime.catalog()[0]?.clientBundle).toContain("Attach Linear issue");
    expect(runtime.catalog()[0]?.clientBundle).not.toContain("LINEAR_API_KEY");
    expect(runtime.catalog()[0]?.clientBundle).not.toContain("api.linear.app");
    await runtime.stopAll();
  });

  it("rejects an index.ts plugin with the migration path", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-"));
    temporaryDirectories.push(directory);
    await Promise.all([
      writeFile(path.join(directory, "paseo-plugin.json"), JSON.stringify({ id: "legacy" })),
      writeFile(path.join(directory, "index.ts"), "export default function contribute() {}"),
    ]);
    const runtime = createTestRuntime();

    await expect(runtime.startPlugin("legacy", directory)).rejects.toThrow(
      "Plugin entry split is required",
    );
    await expect(runtime.startPlugin("legacy", directory)).rejects.toThrow(
      "https://paseo.sh/docs/plugins/v0.8/migration",
    );
  });

  it("loads a client-only plugin without spawning a subprocess", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-"));
    temporaryDirectories.push(directory);
    await Promise.all([
      writeFile(path.join(directory, "paseo-plugin.json"), JSON.stringify({ id: "theme" })),
      writeFile(
        path.join(directory, "index.client.tsx"),
        `export default function contribute(client: any) {
  client.addTheme({ id: "theme", name: "Theme", appearance: "dark", colors: {} });
  return () => undefined;
}`,
      ),
    ]);
    const spawnChild = vi.fn();
    const runtime = createTestRuntime({ spawnChild });

    await runtime.startPlugin("theme", directory);

    expect(spawnChild).not.toHaveBeenCalled();
    expect(runtime.catalog()[0]?.clientBundle).toContain("addTheme");
    await runtime.stopAll();
  });

  it("loads separate entries, exposes the client bundle, and invokes the server RPC", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-"));
    temporaryDirectories.push(directory);
    await mkdir(path.join(directory, "shared"));
    await writeFile(path.join(directory, "paseo-plugin.json"), JSON.stringify({ id: "hello" }));
    await writeFile(
      path.join(directory, "index.client.tsx"),
      `import React from "react";
import { Text } from "react-native";
import { defineAttachmentSource } from "@getpaseo/plugin";
import { greetRpc } from "./shared/greet";

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

function ReviewPanel() {
  return <Text>Workspace review panel</Text>;
}

export default function contribute(client: any) {
  client.addSurface("main", HelloSurface);
  client.addSidebarItem({ id: "hello", title: "Hello", icon: "Sparkles", surface: "main" });
  client.addWorkspacePanel({ id: "review", title: "Review", icon: "Scan", context: "workspace", Component: ReviewPanel });
  client.addCommandCenterItem({ id: "open-review", title: "Open review", icon: "Scan", context: "workspace", onSelect() {} });
  client.addAttachmentSource(attachments);
  return () => undefined;
}`,
    );
    await writeFile(
      path.join(directory, "shared", "greet.ts"),
      `import { z } from "zod";
import { defineRpc } from "@getpaseo/plugin";
export const greetRpc = defineRpc({
  name: "greet",
  input: z.object({ name: z.string() }),
  output: z.object({ message: z.string(), platform: z.string() }),
});`,
    );
    await writeFile(
      path.join(directory, "index.server.ts"),
      `import { platform } from "node:os";
import { greetRpc } from "./shared/greet";
export default function contribute(server: any) {
  server.handle(greetRpc, async (input: { name: string }) => ({
    message: "Hello, " + input.name,
    platform: platform(),
  }));
  return () => undefined;
}`,
    );
    const runtime = createTestRuntime();

    await runtime.startPlugin("hello", directory);

    const catalog = runtime.catalog();
    expect(catalog).toHaveLength(1);
    expect(catalog[0]?.id).toBe("hello");
    expect(catalog[0]?.clientBundle).toContain("Hello from native UI");
    expect(catalog[0]?.clientBundle).toContain("Attach example issue");
    expect(catalog[0]?.clientBundle).toContain("Workspace review panel");
    expect(catalog[0]?.clientBundle).toContain("Open review");
    expect(catalog[0]?.clientBundle).not.toContain("node:os");
    expect(catalog[0]?.clientBundle).not.toContain("get: () => from[key]");
    await expect(runtime.invoke("hello", "greet", { name: "Paseo" })).resolves.toMatchObject({
      message: "Hello, Paseo",
    });
    await expect(runtime.invoke("hello", "greet", { name: 7 })).rejects.toThrow();

    await runtime.stopAll();
  });

  // COMPAT(plugin-sdk-scope): plugins scaffolded through 0.5.0-beta.1 import the unpublished
  // @paseo/plugin name. Drop with the specifiers in plugin-sdk-specifiers.ts.
  it("loads a plugin that imports the pre-rename @paseo/plugin specifier", async () => {
    const directory = await createPlugin(
      "legacy-sdk",
      `import { z } from "zod";
import { defineRpc } from "@paseo/plugin";

const pingRpc = defineRpc({
  name: "ping",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
});

export default function contribute(plugin: any) {
  plugin.handle(pingRpc, async () => ({ ok: true }));
  return () => undefined;
}`,
    );
    const runtime = createTestRuntime();

    await runtime.startPlugin("legacy-sdk", directory);

    await expect(runtime.invoke("legacy-sdk", "ping", {})).resolves.toMatchObject({ ok: true });

    await runtime.stopAll();
  });

  it("keeps client and server modules in their target runtime", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-"));
    temporaryDirectories.push(directory);
    await Promise.all([
      mkdir(path.join(directory, "client")),
      mkdir(path.join(directory, "server")),
      mkdir(path.join(directory, "shared")),
    ]);
    await Promise.all([
      writeFile(
        path.join(directory, "paseo-plugin.json"),
        JSON.stringify({ id: "split-runtime" }),
        "utf8",
      ),
      writeFile(
        path.join(directory, "index.client.tsx"),
        `import type { PluginClientContext } from "@getpaseo/plugin";
import { Surface } from "./client/surface";
export default function contribute(client: PluginClientContext) {
  client.addSurface("main", Surface);
  return () => undefined;
}`,
        "utf8",
      ),
      writeFile(
        path.join(directory, "index.server.ts"),
        `import type { PluginServerContext } from "@getpaseo/plugin";
import { inspectRpc } from "./shared/inspect";
import { inspectHost } from "./server/inspect";
export default function contribute(server: PluginServerContext) {
  server.handle(inspectRpc, inspectHost);
  return () => undefined;
}`,
        "utf8",
      ),
      writeFile(
        path.join(directory, "client", "surface.tsx"),
        `import React from "react";
import { StyleSheet, Text } from "react-native";

const styles = StyleSheet.create({ label: { fontWeight: "600" } });

export function Surface() {
  return <Text style={styles.label}>Client-only surface</Text>;
}`,
        "utf8",
      ),
      writeFile(
        path.join(directory, "shared", "inspect.ts"),
        `import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const inspectRpc = defineRpc({
  name: "inspect",
  input: z.object({}),
  output: z.object({ platform: z.string() }),
});`,
        "utf8",
      ),
      writeFile(
        path.join(directory, "server", "inspect.ts"),
        `import { platform } from "node:os";
import type { z } from "zod";
import { inspectRpc } from "../shared/inspect";

export function inspectHost(_input: z.input<typeof inspectRpc.input>) {
  return { platform: platform() };
}`,
        "utf8",
      ),
    ]);
    const runtime = createTestRuntime();

    await runtime.startPlugin("split-runtime", directory);

    const plugin = runtime.catalog()[0];
    expect(plugin?.clientBundle).toContain("Client-only surface");
    expect(plugin?.clientBundle).not.toContain("node:os");
    await expect(runtime.invoke("split-runtime", "inspect", {})).resolves.toMatchObject({
      platform: expect.any(String),
    });
    await runtime.stopAll();
  });

  it("rejects server imports from client-only modules", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-"));
    temporaryDirectories.push(directory);
    await Promise.all([
      mkdir(path.join(directory, "client")),
      mkdir(path.join(directory, "server")),
    ]);
    await Promise.all([
      writeFile(
        path.join(directory, "paseo-plugin.json"),
        JSON.stringify({ id: "cross-runtime-import" }),
        "utf8",
      ),
      writeFile(
        path.join(directory, "index.client.tsx"),
        `import type { PluginClientContext } from "@getpaseo/plugin";
import { Surface } from "./client/surface";

export default function contribute(client: PluginClientContext) {
  client.addSurface("main", Surface);
  return () => undefined;
}`,
        "utf8",
      ),
      writeFile(
        path.join(directory, "client", "surface.tsx"),
        `import { readSecret } from "../server/secret";
export function Surface() { return readSecret(); }`,
        "utf8",
      ),
      writeFile(
        path.join(directory, "server", "secret.ts"),
        `export function readSecret() { return null; }`,
        "utf8",
      ),
    ]);
    const runtime = createTestRuntime();

    await expect(runtime.startPlugin("cross-runtime-import", directory)).rejects.toThrow(
      "server-only module cannot be imported into the plugin client bundle",
    );
    await runtime.stopAll();
  });

  it("rejects client imports from server-only modules", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-"));
    temporaryDirectories.push(directory);
    await Promise.all([
      mkdir(path.join(directory, "client")),
      mkdir(path.join(directory, "server")),
      mkdir(path.join(directory, "shared")),
    ]);
    await Promise.all([
      writeFile(
        path.join(directory, "paseo-plugin.json"),
        JSON.stringify({ id: "cross-runtime-import" }),
        "utf8",
      ),
      writeFile(
        path.join(directory, "index.server.ts"),
        `import type { PluginServerContext } from "@getpaseo/plugin";
import { inspect } from "./server/inspect";
import { inspectRpc } from "./shared/inspect";

export default function contribute(server: PluginServerContext) {
  server.handle(inspectRpc, inspect);
  return () => undefined;
}`,
        "utf8",
      ),
      writeFile(
        path.join(directory, "shared", "inspect.ts"),
        `import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
export const inspectRpc = defineRpc({
  name: "inspect",
  input: z.object({}),
  output: z.object({}),
});`,
        "utf8",
      ),
      writeFile(
        path.join(directory, "server", "inspect.ts"),
        `import { Surface } from "../client/surface";
export function inspect() { void Surface; return {}; }`,
        "utf8",
      ),
      writeFile(
        path.join(directory, "client", "surface.tsx"),
        `export function Surface() { return null; }`,
        "utf8",
      ),
    ]);
    const runtime = createTestRuntime();

    await expect(runtime.startPlugin("cross-runtime-import", directory)).rejects.toThrow(
      "client-only module cannot be imported into the plugin server bundle",
    );
    await runtime.stopAll();
  });

  it("rejects a handler result that does not match its RPC output schema", async () => {
    const directory = await createPlugin(
      "invalid-output",
      `import { z } from "zod";
import { defineRpc } from "@getpaseo/plugin";
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
    const runtime = createTestRuntime();

    await runtime.startPlugin("invalid-output", directory);

    await expect(runtime.invoke("invalid-output", "broken", {})).rejects.toThrow();
    await runtime.stopAll();
  });

  it("uses the config key as runtime identity without comparing the manifest id", async () => {
    const directory = await createPlugin(
      "actual",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const runtime = createTestRuntime();

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
    const runtime = createTestRuntime({ spawnChild: () => child });

    await expect(runtime.startPlugin("blocked", directory, () => false)).rejects.toThrow(
      "Plugin start cancelled: blocked",
    );

    expect(runtime.catalog()).toEqual([]);
    expect(events).toEqual(["start:blocked", "shutdown:blocked", "exit:blocked"]);
  });

  it("publishes Forge descriptors, validates results, and preserves classified auth errors", async () => {
    const directory = await createPlugin(
      "forge-runtime",
      `import { ForgeCliMissingError, ForgeCommandError } from "@getpaseo/plugin/server";

const pullRequest = {
  number: 7,
  title: "Plugin change",
  url: "https://forge.example.com/acme/repo/changes/7",
  state: "open",
  body: null,
  baseRefName: "main",
  headRefName: "feature",
  labels: [],
  updatedAt: "2026-08-20T00:00:00.000Z",
};
let listPullRequestCalls = 0;

export default function contribute(plugin: any) {
  plugin.addForgeServerProvider({
    definition: {
      id: "acme",
      displayName: "Acme Forge",
      changeRequestAbbrev: "CR",
      changeRequestNoun: "change request",
      changeRequestNumberPrefix: "!",
      issueNumberPrefix: "#",
      signIn: null,
      cloudHosts: ["forge.example.com"],
    },
    probeHost: async (host: string) => host === "self-hosted.example.com",
    service: {
      listPullRequests: async () => {
        listPullRequestCalls += 1;
        return listPullRequestCalls === 1 ? [] : [pullRequest];
      },
      listIssues() {
        throw new ForgeCommandError(
          { brand: "Acme", binary: "acme" },
          {
            args: ["merge", "--body", "sensitive body"],
            cwd: "/sensitive/repo",
            exitCode: 1,
            stderr: "sensitive stderr",
          },
        );
      },
      getPullRequest: async () => pullRequest,
      getPullRequestHeadRef: async () => 42,
      getPullRequestCheckoutTarget: async () => ({
        number: 7,
        baseRefName: "main",
        headRefName: "feature",
        headOwnerLogin: null,
        headRepositorySshUrl: null,
        headRepositoryUrl: null,
        isCrossRepository: false,
      }),
      getCurrentPullRequestStatus: async () => ({
        number: 7,
        repoOwner: "acme",
        repoName: "repo",
        url: pullRequest.url,
        title: pullRequest.title,
        state: pullRequest.state,
        baseRefName: pullRequest.baseRefName,
        headRefName: pullRequest.headRefName,
        isMerged: false,
        mergeable: "UNKNOWN",
        checks: [
          {
            name: "Deploy approval",
            status: "skipped",
            url: null,
            traits: ["manual", "future-forge-trait"],
          },
        ],
        checksStatus: "success",
        reviewDecision: null,
      }),
      getPullRequestTimeline: async () => ({
        prNumber: 7,
        repoOwner: "acme",
        repoName: "repo",
        items: [],
        truncated: false,
        error: null,
      }),
      getCheckDetails: async () => ({
        checkRunId: 1,
        name: "checks",
        annotations: [],
        failedJobs: [],
        truncated: false,
      }),
      searchIssuesAndPrs: async () => ({
        items: [],
        featuresEnabled: true,
        authState: "authenticated",
      }),
      createPullRequest: async () => ({ url: pullRequest.url, number: 7 }),
      mergePullRequest: async () => ({ success: true }),
      enablePullRequestAutoMerge: async () => ({ success: true }),
      disablePullRequestAutoMerge: async () => ({ success: true }),
      isAuthenticated() {
        throw new ForgeCliMissingError("acme CLI is missing");
      },
      invalidate() {},
    },
  });
  return () => undefined;
}`,
    );
    const runtime = createTestRuntime();

    await runtime.startPlugin("forge-runtime", directory);

    expect(runtime.forgeProviders("forge-runtime")).toEqual([
      expect.objectContaining({
        definition: expect.objectContaining({ id: "acme", displayName: "Acme Forge" }),
        hasProbeHost: true,
      }),
    ]);
    await expect(
      runtime.invokeForge("forge-runtime", "acme", "probeHost", "self-hosted.example.com"),
    ).resolves.toBe(true);
    await expect(
      runtime.invokeForge("forge-runtime", "acme", "listPullRequests", {
        cwd: "",
        force: true,
      }),
    ).rejects.toThrow("Plugin forge listPullRequests received invalid input");
    await expect(
      runtime.invokeForge("forge-runtime", "acme", "mergePullRequest", {
        cwd: "/repo",
        prNumber: 7,
        mergeMethod: "fast-forward",
      }),
    ).rejects.toThrow("Plugin forge mergePullRequest received invalid input");
    await expect(
      runtime.invokeForge("forge-runtime", "acme", "listPullRequests", { cwd: "/repo" }),
    ).resolves.toEqual([]);
    await expect(
      runtime.invokeForge("forge-runtime", "acme", "getCurrentPullRequestStatus", {
        cwd: "/repo",
        headRef: "feature",
      }),
    ).resolves.toEqual({
      number: 7,
      repoOwner: "acme",
      repoName: "repo",
      url: "https://forge.example.com/acme/repo/changes/7",
      title: "Plugin change",
      state: "open",
      baseRefName: "main",
      headRefName: "feature",
      isMerged: false,
      mergeable: "UNKNOWN",
      checks: [
        {
          name: "Deploy approval",
          status: "skipped",
          url: null,
          traits: ["manual", "future-forge-trait"],
        },
      ],
      checksStatus: "success",
      reviewDecision: null,
    });
    await expect(
      runtime.invokeForge("forge-runtime", "acme", "getPullRequestHeadRef", {
        cwd: "/repo",
        number: 7,
      }),
    ).rejects.toThrow("returned invalid output");

    const authError = await runtime
      .invokeForge("forge-runtime", "acme", "isAuthenticated", { cwd: "/repo" })
      .catch((error: unknown) => error);
    expect(isForgeAuthError(authError)).toBe(true);
    expect(forgeAuthStateFromError(authError)).toBe("cli_missing");

    const commandError = await runtime
      .invokeForge("forge-runtime", "acme", "listIssues", { cwd: "/repo" })
      .catch((error: unknown) => error);
    expect(commandError).toBeInstanceOf(ForgeCommandError);
    expect(commandError).toMatchObject({
      message: "Acme CLI command failed: acme",
      args: ["merge", "--body", "sensitive body"],
      cwd: "/sensitive/repo",
      exitCode: 1,
      stderr: "sensitive stderr",
    });
    for (const key of ["args", "cwd", "stderr"]) {
      expect(Object.keys(commandError as Error)).not.toContain(key);
    }

    await runtime.stopAll();
  }, 10_000);

  it("rejects Forge provider ids that are not already lowercase", async () => {
    const directory = await createPlugin(
      "invalid-forge-id",
      `export default function contribute(plugin: any) {
  plugin.addForgeServerProvider({
    definition: {
      id: "Codeup",
      displayName: "Codeup",
      changeRequestAbbrev: "MR",
      changeRequestNoun: "merge request",
      changeRequestNumberPrefix: "!",
      issueNumberPrefix: "#",
      signIn: null,
    },
    service: {},
  });
  return () => undefined;
}`,
    );
    const runtime = createTestRuntime();

    await expect(runtime.startPlugin("invalid-forge-id", directory)).rejects.toThrow(
      "Invalid plugin forge provider id: Codeup",
    );
  });

  it("reports an unexpected subprocess crash and removes its catalog entry", async () => {
    const directory = await createPlugin(
      "crashing",
      `export default function contribute(plugin: unknown) {
  void plugin;
  process.stdout.write("before crash");
  setTimeout(() => process.exit(17), 20);
  return () => undefined;
}`,
    );
    const sessions = createTrackedSessionHost();
    const runtime = createTestRuntime({ sessionHost: sessions.host });
    const crashed = new Promise<string>((resolve) => {
      runtime.subscribe((pluginId, error) => {
        if (pluginId === "crashing" && error) resolve(error);
      });
    });
    await runtime.startPlugin("crashing", directory);

    await expect(crashed).resolves.toBe("Plugin process exited: crashing");
    expect(sessions.active.size).toBe(0);
    expect(runtime.catalog()).toEqual([]);
    expect(runtime.getLogs("crashing").map((entry) => entry.message)).toContain("before crash");
    await expect(runtime.invoke("crashing", "anything", {})).rejects.toThrow(
      "Plugin is not available",
    );
  });
});
