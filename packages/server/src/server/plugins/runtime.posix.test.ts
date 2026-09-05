import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginRuntime } from "./runtime.js";
import type { PluginSessionSocket } from "./session-socket.js";
import {
  PLUGIN_TOOL_MAX_CONCURRENT_PER_PLUGIN,
  PLUGIN_TOOL_MAX_UPDATE_COUNT,
} from "./plugin-tool.js";
import {
  MAX_PLUGIN_PROCESS_MESSAGE_BYTES,
  type PluginToolCatalogEntry,
} from "./plugin-process-protocol.js";

const temporaryDirectories: string[] = [];

async function createPlugin(id: string, source: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-"));
  temporaryDirectories.push(directory);
  await writeFile(path.join(directory, "paseo-plugin.json"), JSON.stringify({ id }), "utf8");
  await writeFile(path.join(directory, "index.tsx"), source, "utf8");
  return directory;
}

function createReloadChild(
  name: string,
  events: string[],
  methods: string[] = [],
  deferClose = false,
  catalog: PluginToolCatalogEntry[] = [],
) {
  const listeners = new Map<string, Array<(message: never) => void>>();
  const emit = (event: string, message: unknown) => {
    for (const listener of listeners.get(event) ?? []) listener(message as never);
  };
  const closeNow = () => {
    events.push(`exit:${name}`);
    emit("close", null);
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
        queueMicrotask(() =>
          emit("message", {
            type: "ready",
            methods,
            catalog: catalog.map((entry) => ({
              ...entry,
              pluginId: message.pluginId,
              generation: message.generation ?? 1,
              installationId: message.installationId,
            })),
          }),
        );
      }
      if (message.type === "shutdown") {
        events.push(`shutdown:${name}`);
        this.connected = false;
        if (!deferClose) queueMicrotask(closeNow);
      }
      return true;
    },
    kill() {
      this.killed = true;
      this.connected = false;
      if (!deferClose) queueMicrotask(() => emit("close", null));
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
    closeNow,
    emit,
  };
}

const fakeToolCatalog: PluginToolCatalogEntry[] = [
  {
    pluginId: "fake-tool-runtime",
    generation: 1,
    installationId: "fake-installation",
    name: "acme.wait",
    title: "Wait",
    description: "Wait for a result.",
    inputSchema: { type: "object", properties: {} },
    timeoutMs: 30_000,
  },
];

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
  it("absorbs client registrations that survive server bundle filtering", async () => {
    const directory = await createPlugin(
      "wrong-target-registrations",
      `export default function contribute(plugin: any) {
  const register = (context: any, method: string) => context[method]({});
  function registerClientContributions(context: any) {
    const addSurface = context.addSurface;
    addSurface({});
    register(context, "addSidebarItem");
    const methods = [
      "addWorkspacePanel",
      "addCommandCenterItem",
      "addClientSide",
      "addAttachmentSource",
      "addTheme",
      "addTimelineTransformer",
      "addTimelineRenderer",
    ];
    for (const method of methods) context[method]({});
  }
  registerClientContributions(plugin);
  return () => undefined;
}`,
    );
    const runtime = createTestRuntime();

    await runtime.startPlugin("wrong-target-registrations", directory);

    expect(runtime.toolCatalog()).toEqual([]);
    await runtime.stopPluginById("wrong-target-registrations");
  });

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

  it("waits for an old child to actually close before starting the same plugin", async () => {
    const directory = await createPlugin(
      "serialized-reload",
      `export default function contribute(plugin: any) { return () => undefined; }`,
    );
    const events: string[] = [];
    const first = createReloadChild("first", events, [], true);
    const second = createReloadChild("second", events);
    const children = [first, second];
    const runtime = createTestRuntime({ spawnChild: () => children.shift()! });

    await runtime.startPlugin("serialized-reload", directory);
    const stopping = runtime.stopPluginById("serialized-reload");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const starting = runtime.startPlugin("serialized-reload", directory);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(events).toEqual(["start:first", "shutdown:first"]);
    first.closeNow();
    await stopping;
    await starting;
    expect(events).toEqual(["start:first", "shutdown:first", "exit:first", "start:second"]);
    await runtime.stopAll();
  });

  it("fences the plugin delivery owner before stopping its process", async () => {
    const directory = await createPlugin(
      "delivery-fence",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const child = createReloadChild("delivery-fence", []);
    const beginPluginShutdown = vi.fn();
    const host = createTrackedSessionHost().host;
    const runtime = createTestRuntime({
      spawnChild: () => child,
      sessionHost: { ...host, beginPluginShutdown },
    });

    await runtime.startPlugin("delivery-fence", directory);
    await runtime.stopPluginById("delivery-fence");

    expect(beginPluginShutdown).toHaveBeenCalledOnce();
    expect(beginPluginShutdown).toHaveBeenCalledWith("delivery-fence");
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
  });

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

  it("cancels non-tool RPCs through the child and passes the abort signal", async () => {
    const directory = await createPlugin(
      "rpc-cancellation",
      `import { z } from "zod";
import { defineRpc } from "@getpaseo/plugin/server";

const wait = defineRpc({ name: "wait", input: z.object({}), output: z.object({ ok: z.boolean() }) });
export default function contribute(plugin: any) {
  plugin.handle(wait, (_input: unknown, context: any) => new Promise((resolve, reject) => {
    context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
  }));
  return () => undefined;
}`,
    );
    const runtime = createTestRuntime();
    await runtime.startPlugin("rpc-cancellation", directory);

    const controller = new AbortController();
    const invocation = runtime.invoke(
      "rpc-cancellation",
      "wait",
      {},
      { signal: controller.signal, timeoutMs: 2_000 },
    );
    controller.abort(new Error("rpc caller cancelled"));

    await expect(invocation).rejects.toThrow("rpc caller cancelled");
    expect(runtime.catalog()).toHaveLength(1);
    await runtime.stopAll();
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

  it("kills a child whose graceful cleanup exceeds the stop bound", async () => {
    vi.useFakeTimers();
    try {
      const directory = await createPlugin(
        "held-cleanup",
        `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
      );
      const events: string[] = [];
      const child = createReloadChild("held-cleanup", events);
      const originalSend = child.send.bind(child);
      child.send = (message, callback) => {
        if (message.type !== "shutdown") return originalSend(message, callback);
        callback?.(null);
        events.push("shutdown:held-cleanup");
        return true;
      };
      const runtime = createTestRuntime({ spawnChild: () => child });
      await runtime.startPlugin("held-cleanup", directory);

      const stopping = runtime.stopPluginById("held-cleanup");
      await vi.advanceTimersByTimeAsync(2_001);
      await stopping;
      expect(child.killed).toBe(true);
      expect(events).toContain("shutdown:held-cleanup");
    } finally {
      vi.useRealTimers();
    }
  });

  it("kills a child when the shutdown IPC callback hangs", async () => {
    vi.useFakeTimers();
    try {
      const directory = await createPlugin(
        "hung-shutdown-send",
        `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
      );
      const child = createReloadChild("hung-shutdown-send", []);
      const originalSend = child.send.bind(child);
      child.send = (message, callback) => {
        if (message.type === "shutdown") return true;
        return originalSend(message, callback);
      };
      const runtime = createTestRuntime({ spawnChild: () => child });
      await runtime.startPlugin("hung-shutdown-send", directory);

      const stopping = runtime.stopPluginById("hung-shutdown-send");
      await vi.advanceTimersByTimeAsync(3_001);
      await stopping;
      expect(child.killed).toBe(true);
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

  it("loads one index.tsx, exposes its client bundle, and invokes its server RPC", async () => {
    const directory = await createPlugin(
      "hello",
      `import React from "react";
import { platform } from "node:os";
import { Text } from "react-native";
import { z } from "zod";
import { defineAttachmentSource, defineRpc } from "@getpaseo/plugin";

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

function ReviewPanel() {
  return <Text>Workspace review panel</Text>;
}

export default function contribute(plugin: any) {
  plugin.handle(greetRpc, async (input: { name: string }) => ({
    message: "Hello, " + input.name,
    platform: platform(),
  }));
  plugin.addSurface("main", HelloSurface);
  plugin.addSidebarItem({ id: "hello", title: "Hello", icon: "Sparkles", surface: "main" });
  plugin.addWorkspacePanel({ id: "review", title: "Review", icon: "Scan", context: "workspace", Component: ReviewPanel });
  plugin.addCommandCenterItem({ id: "open-review", title: "Open review", icon: "Scan", context: "workspace", onSelect() {} });
  plugin.addAttachmentSource(attachments);
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

  it("binds generic RPC host authority to the selected caller and leaves global RPC unscoped", async () => {
    const directory = await createPlugin(
      "caller-rpc",
      `import { z } from "zod";
import { defineRpc } from "@getpaseo/plugin/server";

const inspect = defineRpc({
  name: "inspect",
  input: z.object({}),
  output: z.object({ callerAgentId: z.string().nullable(), hasHost: z.boolean() }),
});

export default function contribute(plugin: any) {
  plugin.handle(inspect, (_input: unknown, context: any) => ({
    callerAgentId: context.caller?.callerAgentId ?? null,
    hasHost: context.host !== null,
  }));
  return () => undefined;
}`,
    );
    const authority = {
      callerAgentId: "agent-selected",
      agent: {
        id: "agent-selected",
        workspaceId: "workspace-selected",
        provider: "codex",
        status: "running",
        createdAt: "2026-09-04T00:00:00.000Z",
        updatedAt: "2026-09-04T00:00:00.000Z",
        lastActivityAt: "2026-09-04T00:00:00.000Z",
        title: null,
        cwd: "/tmp/workspace-selected",
        model: "gpt-5",
        currentModeId: null,
        thinkingOptionId: null,
        requiresAttention: false,
        attentionReason: null,
        parentAgentId: null,
        labels: {},
      },
      workspace: null,
      effective: {
        provider: { known: true, value: "codex" },
        model: { known: true, value: "gpt-5" },
        thinking: { known: false },
        providerSessionId: { known: false },
      },
      securityCeiling: {
        filesystem: "unknown",
        network: "unknown",
        approvals: "unknown",
        unattended: "unknown",
      },
    };
    const runtime = createTestRuntime({
      resolveToolContext: async (callerAgentId) => ({
        callerAgentId,
        agent: authority.agent,
        workspace: authority.workspace,
        caller: { ...authority, callerAgentId },
      }),
    });
    await runtime.startPlugin("caller-rpc", directory);

    await expect(
      runtime.invoke("caller-rpc", "inspect", {}, { callerAgentId: "agent-selected" }),
    ).resolves.toEqual({ callerAgentId: "agent-selected", hasHost: true });
    await expect(runtime.invoke("caller-rpc", "inspect", {})).resolves.toEqual({
      callerAgentId: null,
      hasHost: false,
    });
    await runtime.stopAll();
  });

  it("routes host capability calls through the invocation-owned process channel", async () => {
    const directory = await createPlugin(
      "host-rpc",
      `import { z } from "zod";
import { defineRpc } from "@getpaseo/plugin/server";

const send = defineRpc({
  name: "send",
  input: z.object({}),
  output: z.object({ callerAgentId: z.string(), targetAgentId: z.string() }),
});

export default function contribute(plugin: any) {
  plugin.handle(send, async (_input: unknown, context: any) => {
    const delivery = await context.host.deliveries.send(
      { event: "host-test" },
      { deliveryId: "host-test-delivery" },
    );
    return { callerAgentId: context.caller.callerAgentId, targetAgentId: delivery.targetAgentId };
  });
  return () => undefined;
}`,
    );
    const authority = {
      callerAgentId: "agent-host",
      agent: {
        id: "agent-host",
        workspaceId: "workspace-host",
        provider: "codex",
        status: "running",
        createdAt: "2026-09-04T00:00:00.000Z",
        updatedAt: "2026-09-04T00:00:00.000Z",
        lastActivityAt: "2026-09-04T00:00:00.000Z",
        title: null,
        cwd: "/tmp/workspace-host",
        model: "gpt-5",
        currentModeId: null,
        thinkingOptionId: null,
        requiresAttention: false,
        attentionReason: null,
        parentAgentId: null,
        labels: {},
      },
      workspace: null,
      effective: {
        provider: { known: true, value: "codex" },
        model: { known: true, value: "gpt-5" },
        thinking: { known: false },
        providerSessionId: { known: false },
      },
      securityCeiling: {
        filesystem: "unknown",
        network: "unknown",
        approvals: "unknown",
        unattended: "unknown",
      },
    };
    const baseHost = createTrackedSessionHost().host;
    const invokePluginHost = vi.fn(
      async (input: {
        caller: typeof authority;
        operation: string;
        invocationId: string;
        generation: number;
        installationId: string;
        capabilityNonce: string;
      }) => {
        expect(input.operation).toBe("delivery.send");
        expect(input.invocationId).toMatch(/^[0-9a-f-]{36}$/u);
        expect(input.generation).toBe(1);
        expect(input.installationId).toMatch(/^[0-9a-f-]{36}$/u);
        expect(input.capabilityNonce).toMatch(/^[0-9a-f-]{36}$/u);
        return {
          deliveryId: "delivery-host",
          targetAgentId: input.caller.callerAgentId,
          payload: { event: "host-test" },
          createdAt: "2026-09-04T00:00:00.000Z",
          acknowledgedAt: null,
        };
      },
    );
    const runtime = createTestRuntime({
      sessionHost: { ...baseHost, invokePluginHost },
      resolveToolContext: async (callerAgentId) => ({
        callerAgentId,
        agent: authority.agent,
        workspace: authority.workspace,
        caller: { ...authority, callerAgentId },
      }),
    });
    await runtime.startPlugin("host-rpc", directory);

    await expect(
      runtime.invoke("host-rpc", "send", {}, { callerAgentId: "agent-host" }),
    ).resolves.toEqual({ callerAgentId: "agent-host", targetAgentId: "agent-host" });
    expect(invokePluginHost).toHaveBeenCalledOnce();
    expect(invokePluginHost.mock.calls[0]?.[0].caller.callerAgentId).toBe("agent-host");
    await runtime.stopAll();
  });

  it("publishes and invokes model-facing tools with host-owned context", async () => {
    const directory = await createPlugin(
      "model-tools",
      `import { z } from "zod";
import { defineTool } from "@getpaseo/plugin/server";

const echo = defineTool({
  name: "echo_value",
  title: "Echo value",
  description: "Echo a value with the active caller identity.",
  input: z.object({ value: z.string(), callerAgentId: z.string().optional() }),
  output: z.object({ value: z.string(), callerAgentId: z.string() }),
  handler(input, context) {
    context.progress?.({ stage: "started" });
    return { value: input.value, callerAgentId: context.callerAgentId };
  },
});

export default function contribute(plugin: any) {
  plugin.addTool(echo);
  return () => undefined;
}`,
    );
    const updates: unknown[] = [];
    const runtime = createTestRuntime({
      resolveToolContext: async (callerAgentId) => ({
        callerAgentId,
        agent: { id: callerAgentId, status: "running" },
        workspace: { id: "workspace-1" },
      }),
    });

    await runtime.startPlugin("model-tools", directory);

    expect(runtime.toolCatalog()).toEqual([
      expect.objectContaining({
        pluginId: "model-tools",
        generation: 1,
        name: "echo_value",
        title: "Echo value",
        timeoutMs: 30_000,
        inputSchema: expect.objectContaining({
          type: "object",
          properties: expect.objectContaining({ value: expect.anything() }),
        }),
        outputSchema: expect.objectContaining({ type: "object" }),
      }),
    ]);

    await expect(
      runtime.invokeTool(
        "model-tools",
        "echo_value",
        { value: "hello" },
        {
          callerAgentId: "agent-authoritative",
          onUpdate: (update) => updates.push(update),
        },
      ),
    ).resolves.toEqual({ value: "hello", callerAgentId: "agent-authoritative" });
    expect(updates).toEqual([{ stage: "started" }]);

    await expect(
      runtime.invokeTool(
        "model-tools",
        "echo_value",
        { value: "hello", callerAgentId: "model-spoof" },
        { callerAgentId: "agent-authoritative" },
      ),
    ).resolves.toEqual({ value: "hello", callerAgentId: "agent-authoritative" });

    await expect(
      runtime.invokeTool(
        "model-tools",
        "echo_value",
        { value: 7 },
        {
          callerAgentId: "agent-authoritative",
        },
      ),
    ).rejects.toThrow();
    await runtime.stopAll();
  });

  it("rejects duplicate and reserved model-facing tool names", async () => {
    const duplicateDirectory = await createPlugin(
      "duplicate-tools",
      `import { z } from "zod";
import { defineTool } from "@getpaseo/plugin/server";

const first = defineTool({ name: "acme.duplicate", title: "First", description: "First.", input: z.object({}), handler: () => ({ ok: true }) });
const second = defineTool({ name: "acme.duplicate", title: "Second", description: "Second.", input: z.object({}), handler: () => ({ ok: true }) });

export default function contribute(plugin: any) {
  plugin.addTool(first);
  plugin.addTool(second);
  return () => undefined;
}`,
    );
    const reservedDirectory = await createPlugin(
      "reserved-tools",
      `import { z } from "zod";
import { defineTool } from "@getpaseo/plugin/server";

const reserved = defineTool({ name: "get_agent_status", title: "Reserved", description: "Reserved.", input: z.object({}), handler: () => ({ ok: true }) });

export default function contribute(plugin: any) {
  plugin.addTool(reserved);
  return () => undefined;
}`,
    );

    const runtime = createTestRuntime({
      resolveToolContext: async (callerAgentId) => ({
        callerAgentId,
        agent: null,
        workspace: null,
      }),
    });
    await expect(runtime.startPlugin("duplicate-tools", duplicateDirectory)).rejects.toThrow(
      "Duplicate plugin tool name: acme.duplicate",
    );
    await expect(runtime.startPlugin("reserved-tools", reservedDirectory)).rejects.toThrow(
      "Plugin tool name is reserved: get_agent_status",
    );
    expect(runtime.toolCatalog()).toEqual([]);
    await runtime.stopAll();
  });

  it("fences a stale tool catalog across plugin reloads", async () => {
    const directory = await createPlugin(
      "reloadable-tools",
      `import { z } from "zod";
import { defineTool } from "@getpaseo/plugin/server";

const tool = defineTool({ name: "acme.reload", title: "Reload", description: "Reload.", input: z.object({}), handler: () => ({ ok: true }) });

export default function contribute(plugin: any) {
  plugin.addTool(tool);
  return () => undefined;
}`,
    );
    const runtime = createTestRuntime({
      resolveToolContext: async (callerAgentId) => ({
        callerAgentId,
        agent: null,
        workspace: null,
      }),
    });

    await runtime.startPlugin("reloadable-tools", directory);
    const [first] = runtime.toolCatalog();
    if (!first) throw new Error("First plugin tool was not published");
    await runtime.stopPluginById("reloadable-tools");
    await runtime.startPlugin("reloadable-tools", directory);
    const [second] = runtime.toolCatalog();
    if (!second) throw new Error("Reloaded plugin tool was not published");

    expect(second.generation).toBe(first.generation + 1);
    expect(second.installationId).not.toBe(first.installationId);
    await expect(
      runtime.invokeTool(
        "reloadable-tools",
        "acme.reload",
        {},
        {
          generation: first.generation,
          installationId: first.installationId,
          callerAgentId: "agent-1",
        },
      ),
    ).rejects.toThrow("no longer available");
    await runtime.stopAll();
  });

  it("propagates cancellation and host timeout without killing the plugin", async () => {
    const directory = await createPlugin(
      "model-tool-cancellation",
      `import { z } from "zod";
import { defineTool } from "@getpaseo/plugin/server";

const wait = defineTool({
  name: "wait_for_signal",
  title: "Wait for signal",
  description: "Wait until the host cancels the invocation.",
  input: z.object({}),
  timeoutMs: 20,
  handler(_input, context) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ ok: true }), 200);
      context.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(context.signal.reason ?? new Error("cancelled"));
      }, { once: true });
    });
  },
});

export default function contribute(plugin: any) {
  plugin.addTool(wait);
  return () => undefined;
}`,
    );
    const runtime = createTestRuntime({
      resolveToolContext: async (callerAgentId) => ({
        callerAgentId,
        agent: null,
        workspace: null,
      }),
    });
    await runtime.startPlugin("model-tool-cancellation", directory);

    const controller = new AbortController();
    const canceled = runtime.invokeTool(
      "model-tool-cancellation",
      "wait_for_signal",
      {},
      { callerAgentId: "agent-1", signal: controller.signal },
    );
    controller.abort(new Error("caller cancelled"));
    await expect(canceled).rejects.toThrow("caller cancelled");

    await expect(
      runtime.invokeTool(
        "model-tool-cancellation",
        "wait_for_signal",
        {},
        { callerAgentId: "agent-1" },
      ),
    ).rejects.toThrow("timed out");
    expect(runtime.catalog()).toHaveLength(1);
    await runtime.stopAll();
  });

  it("holds all concurrency slots until an ignored cancellation quarantines the child", async () => {
    const directory = await createPlugin(
      "ignored-cancellation",
      `import { z } from "zod";
import { defineTool } from "@getpaseo/plugin/server";

const wait = defineTool({
  name: "ignore_abort",
  title: "Ignore abort",
  description: "Never settles.",
  input: z.object({}),
  timeoutMs: 30_000,
  handler: () => new Promise(() => undefined),
});

export default function contribute(plugin: any) {
  plugin.addTool(wait);
  return () => undefined;
}`,
    );
    const runtime = createTestRuntime({
      resolveToolContext: async (callerAgentId) => ({
        callerAgentId,
        agent: null,
        workspace: null,
      }),
    });
    await runtime.startPlugin("ignored-cancellation", directory);

    const controllers = Array.from({ length: 8 }, () => new AbortController());
    const calls = controllers.map((controller) =>
      runtime.invokeTool(
        "ignored-cancellation",
        "ignore_abort",
        {},
        { callerAgentId: "agent-1", signal: controller.signal },
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    controllers[0]?.abort(new Error("caller cancelled"));
    await expect(calls[0]).rejects.toThrow("caller cancelled");

    await expect(
      runtime.invokeTool("ignored-cancellation", "ignore_abort", {}, { callerAgentId: "agent-1" }),
    ).rejects.toThrow("concurrency limit");

    await expect(Promise.allSettled(calls)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "rejected" })]),
    );
    await vi.waitFor(() => expect(runtime.toolCatalog()).toEqual([]), { timeout: 5_000 });
  }, 8_000);

  it("releases a saturated tool slot once across result, cancel, and child-close races", async () => {
    const directory = await createPlugin(
      "fake-tool-runtime",
      `export default function contribute(plugin: any) { void plugin; return () => undefined; }`,
    );
    const child = createReloadChild("fake-tool-runtime", [], [], false, fakeToolCatalog);
    const requestIds: string[] = [];
    const originalSend = child.send.bind(child);
    child.send = (message, callback) => {
      if (message.type === "tool_invoke")
        requestIds.push((message as { requestId: string }).requestId);
      return originalSend(message, callback);
    };
    const runtime = createTestRuntime({
      spawnChild: () => child,
      resolveToolContext: async (callerAgentId) => ({
        callerAgentId,
        agent: null,
        workspace: null,
      }),
    });
    await runtime.startPlugin("fake-tool-runtime", directory);

    const controllers = Array.from({ length: 8 }, () => new AbortController());
    const calls = controllers.map((controller) =>
      runtime.invokeTool(
        "fake-tool-runtime",
        "acme.wait",
        {},
        {
          callerAgentId: "agent-1",
          signal: controller.signal,
        },
      ),
    );
    await vi.waitFor(() => expect(requestIds).toHaveLength(8));

    controllers[0]?.abort(new Error("race cancellation"));
    child.emit("message", { type: "tool_result", requestId: requestIds[0], output: { ok: true } });
    child.emit("message", { type: "tool_cancel_ack", requestId: requestIds[0] });
    await expect(calls[0]).rejects.toThrow("race cancellation");

    const replacement = runtime.invokeTool(
      "fake-tool-runtime",
      "acme.wait",
      {},
      {
        callerAgentId: "agent-1",
      },
    );
    const overLimit = runtime.invokeTool(
      "fake-tool-runtime",
      "acme.wait",
      {},
      {
        callerAgentId: "agent-1",
      },
    );
    await expect(overLimit).rejects.toThrow("concurrency limit");
    await vi.waitFor(() => expect(requestIds).toHaveLength(9));

    for (const requestId of requestIds.slice(1)) {
      child.emit("message", { type: "tool_result", requestId, output: { ok: true } });
    }
    await expect(Promise.all([replacement, ...calls.slice(1)])).resolves.toHaveLength(8);
    await runtime.stopAll();
  });

  it("rejects oversized caller contexts before occupying tool admission slots", async () => {
    vi.useFakeTimers();
    try {
      const directory = await createPlugin(
        "oversized-context",
        `export default function contribute(plugin: any) { void plugin; return () => undefined; }`,
      );
      const child = createReloadChild("oversized-context", [], [], false, fakeToolCatalog);
      const requestIds: string[] = [];
      const originalSend = child.send.bind(child);
      child.send = (message, callback) => {
        if (message.type === "tool_invoke") {
          requestIds.push((message as { requestId: string }).requestId);
        }
        return originalSend(message, callback);
      };
      let useOversizedContext = true;
      const runtime = createTestRuntime({
        spawnChild: () => child,
        resolveToolContext: async (callerAgentId) => ({
          callerAgentId,
          agent: useOversizedContext
            ? { oversized: "x".repeat(MAX_PLUGIN_PROCESS_MESSAGE_BYTES) }
            : null,
          workspace: null,
        }),
      });
      await runtime.startPlugin("oversized-context", directory);

      const oversizedCalls = Array.from({ length: PLUGIN_TOOL_MAX_CONCURRENT_PER_PLUGIN }, () =>
        runtime.invokeTool("oversized-context", "acme.wait", {}, { callerAgentId: "agent-1" }),
      );
      await expect(Promise.allSettled(oversizedCalls)).resolves.toEqual(
        Array.from({ length: PLUGIN_TOOL_MAX_CONCURRENT_PER_PLUGIN }, () =>
          expect.objectContaining({
            status: "rejected",
            reason: expect.objectContaining({
              message: expect.stringContaining("exceeds the IPC size limit"),
            }),
          }),
        ),
      );
      expect(requestIds).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);

      useOversizedContext = false;
      const validCalls = Array.from({ length: PLUGIN_TOOL_MAX_CONCURRENT_PER_PLUGIN }, () =>
        runtime.invokeTool("oversized-context", "acme.wait", {}, { callerAgentId: "agent-1" }),
      );
      await vi.waitFor(() =>
        expect(requestIds).toHaveLength(PLUGIN_TOOL_MAX_CONCURRENT_PER_PLUGIN),
      );
      for (const requestId of requestIds) {
        child.emit("message", { type: "tool_result", requestId, output: { ok: true } });
      }
      await expect(Promise.all(validCalls)).resolves.toHaveLength(
        PLUGIN_TOOL_MAX_CONCURRENT_PER_PLUGIN,
      );
      expect(vi.getTimerCount()).toBe(0);
      await runtime.stopAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it("quarantines a child that forges more than the host progress bound", async () => {
    const directory = await createPlugin(
      "forged-progress",
      `export default function contribute(plugin: any) { void plugin; return () => undefined; }`,
    );
    const child = createReloadChild("forged-progress", [], [], false, fakeToolCatalog);
    let requestId: string | undefined;
    const originalSend = child.send.bind(child);
    child.send = (message, callback) => {
      if (message.type === "tool_invoke") requestId = (message as { requestId: string }).requestId;
      return originalSend(message, callback);
    };
    const runtime = createTestRuntime({
      spawnChild: () => child,
      resolveToolContext: async (callerAgentId) => ({
        callerAgentId,
        agent: null,
        workspace: null,
      }),
    });
    await runtime.startPlugin("forged-progress", directory);
    const invocation = runtime.invokeTool(
      "forged-progress",
      "acme.wait",
      {},
      {
        callerAgentId: "agent-1",
      },
    );
    await vi.waitFor(() => expect(requestId).toEqual(expect.any(String)));

    for (let index = 0; index <= PLUGIN_TOOL_MAX_UPDATE_COUNT; index += 1) {
      child.emit("message", {
        type: "tool_update",
        requestId,
        update: { index },
      });
    }

    await expect(invocation).rejects.toThrow(/progress limit|stopped|exited/i);
    await vi.waitFor(() => expect(runtime.catalog()).toEqual([]));
  });

  it("does not start a tool after its plugin is stopped while context is resolving", async () => {
    const directory = await createPlugin(
      "resolving-tool",
      `import { z } from "zod";
import { defineTool } from "@getpaseo/plugin/server";

const tool = defineTool({ name: "acme.resolving", title: "Resolving", description: "Resolving.", input: z.object({}), handler: () => ({ ok: true }) });

export default function contribute(plugin: any) {
  plugin.addTool(tool);
  return () => undefined;
}`,
    );
    let markContextResolutionStarted = () => undefined;
    const contextResolutionStarted = new Promise<void>((resolve) => {
      markContextResolutionStarted = resolve;
    });
    let releaseContextResolution = () => undefined;
    const contextResolution = new Promise<void>((resolve) => {
      releaseContextResolution = resolve;
    });
    const runtime = createTestRuntime({
      resolveToolContext: async (callerAgentId) => {
        markContextResolutionStarted();
        await contextResolution;
        return { callerAgentId, agent: null, workspace: null };
      },
    });
    await runtime.startPlugin("resolving-tool", directory);

    const invocation = runtime.invokeTool(
      "resolving-tool",
      "acme.resolving",
      {},
      {
        callerAgentId: "agent-1",
      },
    );
    await contextResolutionStarted;
    await runtime.stopPluginById("resolving-tool");
    releaseContextResolution();

    await expect(invocation).rejects.toThrow("no longer available");
    await runtime.stopAll();
  });

  // COMPAT(plugin-sdk-scope): plugins scaffolded through 0.5.0-beta.1 import the unpublished
  // @paseo/plugin name. Drop with the specifiers in plugin-sdk-specifiers.ts.
  it("loads a plugin that imports the pre-rename @paseo/plugin specifier", async () => {
    const directory = await createPlugin(
      "legacy-sdk",
      `import { z } from "zod";
import { defineRpc } from "@paseo/plugin/server";

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
      writeFile(
        path.join(directory, "paseo-plugin.json"),
        JSON.stringify({ id: "split-runtime" }),
        "utf8",
      ),
      writeFile(
        path.join(directory, "index.ts"),
        `import type { PluginContext } from "@getpaseo/plugin";
import { Surface } from "./surface.client";
import { inspectRpc } from "./inspect.shared";
import { inspectHost } from "./inspect.server";

export default function contribute(plugin: PluginContext) {
  plugin.handle(inspectRpc, inspectHost);
  plugin.addSurface("main", Surface);
  return () => undefined;
}`,
        "utf8",
      ),
      writeFile(
        path.join(directory, "surface.client.tsx"),
        `import React from "react";
import { StyleSheet, Text } from "react-native";

const styles = StyleSheet.create({ label: { fontWeight: "600" } });

export function Surface() {
  return <Text style={styles.label}>Client-only surface</Text>;
}`,
        "utf8",
      ),
      writeFile(
        path.join(directory, "inspect.shared.ts"),
        `import { defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";

export const inspectRpc = defineRpc({
  name: "inspect",
  input: z.object({}),
  output: z.object({ platform: z.string() }),
});`,
        "utf8",
      ),
      writeFile(
        path.join(directory, "inspect.server.ts"),
        `import { platform } from "node:os";
import type { z } from "zod";
import { inspectRpc } from "./inspect.shared";

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
      writeFile(
        path.join(directory, "paseo-plugin.json"),
        JSON.stringify({ id: "cross-runtime-import" }),
        "utf8",
      ),
      writeFile(
        path.join(directory, "index.ts"),
        `import type { PluginContext } from "@getpaseo/plugin";
import { Surface } from "./surface.client";

export default function contribute(plugin: PluginContext) {
  plugin.addSurface("main", Surface);
  return () => undefined;
}`,
        "utf8",
      ),
      writeFile(
        path.join(directory, "surface.client.tsx"),
        `import { readSecret } from "./secret.server";
export function Surface() { return readSecret(); }`,
        "utf8",
      ),
      writeFile(
        path.join(directory, "secret.server.ts"),
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
      writeFile(
        path.join(directory, "paseo-plugin.json"),
        JSON.stringify({ id: "cross-runtime-import" }),
        "utf8",
      ),
      writeFile(
        path.join(directory, "index.ts"),
        `import type { PluginContext } from "@getpaseo/plugin";
import { inspect } from "./inspect.server";
import { inspectRpc } from "./inspect.shared";

export default function contribute(plugin: PluginContext) {
  plugin.handle(inspectRpc, inspect);
  return () => undefined;
}`,
        "utf8",
      ),
      writeFile(
        path.join(directory, "inspect.shared.ts"),
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
        path.join(directory, "inspect.server.ts"),
        `import { Surface } from "./surface.client";
export function inspect() { void Surface; return {}; }`,
        "utf8",
      ),
      writeFile(
        path.join(directory, "surface.client.tsx"),
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
