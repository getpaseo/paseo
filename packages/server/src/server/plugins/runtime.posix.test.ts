import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fork } from "node:child_process";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import type { ProviderEvent, ProviderRegistration } from "@getpaseo/plugin/server/provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentStreamEvent } from "../agent/agent-sdk-types.js";
import { PluginAgentClientRegistry } from "../agent/plugin-provider.js";
import { PluginRuntime } from "./runtime.js";
import type { PluginSessionSocket } from "./session-socket.js";

const temporaryDirectories: string[] = [];

function hasCompletedAgentTurn(events: readonly AgentStreamEvent[]): boolean {
  return events.some((event) => event.type === "turn_completed");
}

async function createPlugin(id: string, source: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-"));
  temporaryDirectories.push(directory);
  await writeFile(path.join(directory, "paseo-plugin.json"), JSON.stringify({ id }), "utf8");
  await writeFile(path.join(directory, "index.server.ts"), source, "utf8");
  return directory;
}

async function readTextIfPresent(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function createReloadChild(
  name: string,
  events: string[],
  methods: string[] = [],
  providers: Array<{ id: string; label: string }> = [],
) {
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
        queueMicrotask(() => emit("message", { type: "ready", methods, providers }));
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
    emitMessage(message: unknown) {
      emit("message", message);
    },
  };
}

function createTestRuntime(
  dependencies: NonNullable<ConstructorParameters<typeof PluginRuntime>[2]> = {},
  logger = pino({ level: "silent" }),
  version = "0.4.0",
): PluginRuntime {
  return new PluginRuntime(logger, version, {
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
                  version,
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

function hasCompletedTurn(events: readonly ProviderEvent[]): boolean {
  return events.some((event) => event.type === "session.turn" && event.state === "completed");
}

function hasReadyRequest(events: readonly ProviderEvent[], requestId: string): boolean {
  return events.some((event) => event.type === "session.ready" && event.requestId === requestId);
}

function runtimeFailure(events: readonly ProviderEvent[]): ProviderEvent | undefined {
  return events.find((event) => event.type === "session.runtime_failed");
}

function providerCloseCount(
  messages: readonly { type: string; connectionId?: string }[],
  connectionId: string | undefined,
): number {
  return messages.filter(
    (message) => message.type === "provider.close" && message.connectionId === connectionId,
  ).length;
}

function hasMessageType(messages: readonly { type: string }[], type: string): boolean {
  return messages.some((message) => message.type === type);
}

function adaptRuntimeProvider(
  runtime: PluginRuntime,
  pluginId: string,
  metadata: { id: string; label: string; description?: string; icon?: string },
): ProviderRegistration {
  return {
    ...metadata,
    connect: (request) => runtime.connectProvider(pluginId, metadata.id, request),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("PluginRuntime", () => {
  it.each([
    { specifier: "@getpaseo/plugin", moduleDirectory: "shared" },
    { specifier: "@getpaseo/plugin", moduleDirectory: "server" },
  ])(
    "loads $specifier contracts without React in the subprocess module graph",
    async ({ specifier, moduleDirectory }) => {
      const directory = await createPlugin(
        "react-free",
        `import { rpc } from "./${moduleDirectory}/contract";
export default function contribute(server) {
  server.handle(rpc, (input) => input);
  return () => {};
}`,
      );
      await mkdir(path.join(directory, moduleDirectory));
      await writeFile(
        path.join(directory, moduleDirectory, "contract.ts"),
        `import { defineRpc, defineAttachmentSource } from "${specifier}";
import { z } from "zod";
export const rpc = defineRpc({ name: "echo", input: z.string(), output: z.string() });
const source = defineAttachmentSource({ id: "test", search: rpc });
if (source.search !== rpc) throw new Error("Attachment contract was not preserved");`,
      );
      // Reject imports even when the workspace has React installed. This covers the host's
      // static graph and SDK imports evaluated through the compiled plugin's runtimeRequire.
      const guard = `export function resolve(specifier, context, nextResolve) {
  if (/^(react|react-dom|react-native|use-sync-external-store)(\\/|$)/.test(specifier)) {
    throw new Error("React module reached plugin subprocess: " + specifier);
  }
  return nextResolve(specifier, context);
}`;
      const guardUrl = `data:text/javascript,${encodeURIComponent(guard)}`;
      const loaderUrl = new URL("../../terminal/terminal-ts-loader.mjs", import.meta.url).href;
      const setup = `import { register } from "node:module";
register(${JSON.stringify(loaderUrl)});
register(${JSON.stringify(guardUrl)});`;
      const runtime = createTestRuntime({
        spawnChild: () =>
          fork(new URL("./plugin-process.ts", import.meta.url), [], {
            execArgv: [
              "--experimental-strip-types",
              "--import",
              `data:text/javascript,${encodeURIComponent(setup)}`,
            ],
            serialization: "advanced",
            stdio: ["ignore", "pipe", "pipe", "ipc"],
          }),
      });
      try {
        await runtime.startPlugin("react-free", directory);
        await expect(runtime.invoke("react-free", "echo", "hello")).resolves.toBe("hello");
      } catch (error) {
        throw new Error(JSON.stringify(runtime.getLogs("react-free")), { cause: error });
      } finally {
        await runtime.stopAll();
      }
    },
  );

  it("runs the direct example through the existing AgentClient path", async () => {
    const pluginId = "provider-direct-example";
    const directory = fileURLToPath(
      new URL("../../../../../plugin-examples/provider-direct/", import.meta.url),
    );
    const runtime = createTestRuntime({}, undefined, "0.8.0");
    await runtime.startPlugin(pluginId, directory);
    const [metadata] = runtime.getProviderRegistrations(pluginId);
    expect(metadata).toBeDefined();
    const adapters = new PluginAgentClientRegistry(pino({ level: "silent" }));
    adapters.replace([adaptRuntimeProvider(runtime, pluginId, metadata!)]);
    const client = adapters.clients()[metadata!.id];

    const session = await client!.createSession({ provider: metadata!.id, cwd: directory });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    await expect(session.startTurn("hello", { clientMessageId: "direct-client" })).resolves.toEqual(
      { turnId: "turn-1" },
    );
    await expect.poll(() => hasCompletedAgentTurn(events)).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline",
        item: {
          type: "assistant_message",
          id: undefined,
          messageId: "assistant-1",
          text: "Echo: hello",
        },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "provider_subagent",
        event: expect.objectContaining({ type: "timeline" }),
      }),
    );

    await session.close();
    await adapters.shutdown();
    await runtime.stopAll();
  });

  it("runs a provider connection through the real plugin subprocess boundary", async () => {
    const directory = await createPlugin(
      "provider-round-trip",
      `import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { ProviderEvent, ProviderRegistration } from "@getpaseo/plugin/server/provider";

const provider: ProviderRegistration = {
  id: "direct-example",
  label: "Direct example",
  icon: "icon.svg",
  async connect(request) {
    const listeners = new Set<(event: ProviderEvent) => void>();
    const emit = (event: ProviderEvent) => {
      for (const listener of listeners) listener(event);
    };
    return {
      version: request.versions[0] ?? 1,
      capabilities: request.capabilities,
      async send(input) {
        if (input.type === "session.open") {
          emit({
            type: "session.opened",
            requestId: input.requestId,
            sessionId: input.sessionId,
            capabilities: request.capabilities,
            restoration: "core",
            persistence: { version: 1, data: { resume: "native-1" } },
            cwd: input.config.cwd,
            futureField: "ignored by this protocol version",
          } as ProviderEvent);
          emit({
            type: "session.config",
            sessionId: input.sessionId,
            config: {
              model: "example-1",
              models: [{ id: "example-1", label: "Example 1" }],
              modes: [],
              thinkingOptions: [],
              settings: [
                { type: "toggle", id: "concise", label: "Concise", value: true },
              ],
            },
          });
          emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
          return;
        }
        if (input.type !== "session.prompt") return;
        if (input.prompt.input.type === "command") {
          emit({
            type: "session.prompt_result",
            sessionId: input.sessionId,
            clientMessageId: input.prompt.clientMessageId,
            result: { type: "completed" },
          });
          return;
        }
        emit({
          type: "timeline.item",
          sessionId: input.sessionId,
          item: {
            type: "user_message",
            id: "user-1",
            text: "hello",
            clientMessageId: input.prompt.clientMessageId,
          },
        });
        emit({
          type: "session.prompt_result",
          sessionId: input.sessionId,
          clientMessageId: input.prompt.clientMessageId,
          result: { type: "turn", turnId: "turn-1" },
        });
        emit({
          type: "session.opened",
          sessionId: "child-1",
          parentSessionId: input.sessionId,
          capabilities: [],
          restoration: "parent",
          cwd: "/repo",
        });
        emit({
          type: "timeline.item",
          sessionId: "child-1",
          item: {
            type: "plugin",
            id: "review-1",
            pluginId: "provider-round-trip",
            kind: "review",
            version: 1,
            data: { verdict: "ship" },
          },
        });
      },
      onEvent(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async close() {},
    };
  },
};

export default function contribute(server: PluginServerContext) {
  server.registerProvider(provider);
  return () => {};
}`,
    );
    const runtime = createTestRuntime();
    await runtime.startPlugin("provider-round-trip", directory);

    const [registration] = runtime.getProviderRegistrations("provider-round-trip");
    expect(registration).toMatchObject({
      id: "direct-example",
      label: "Direct example",
      iconPath: "icon.svg",
    });
    const connection = await runtime.connectProvider("provider-round-trip", "direct-example", {
      versions: [1],
      capabilities: [
        "prompt.message",
        "prompt.command",
        "session.configure",
        "session.persistence",
        "session.subsession",
        "timeline.plugin",
        "future.capability",
      ],
    });
    expect(connection.capabilities).not.toContain("future.capability");
    const events: ProviderEvent[] = [];
    const unsubscribe = connection.onEvent((event) => events.push(event));

    await connection.send({
      type: "session.open",
      requestId: "open-1",
      sessionId: "root-1",
      config: {
        cwd: "/repo",
        env: {},
        mcpServers: {},
        settings: {},
        persist: true,
      },
      history: "replay",
    });
    await connection.send({
      type: "session.prompt",
      sessionId: "root-1",
      prompt: {
        clientMessageId: "client-1",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "hello" }] },
      },
    });
    await connection.send({
      type: "session.prompt",
      sessionId: "root-1",
      prompt: {
        clientMessageId: "client-2",
        delivery: "auto",
        input: { type: "command", name: "compact", arguments: "" },
      },
    });

    await expect.poll(() => events.length).toBe(8);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.prompt_result",
        clientMessageId: "client-1",
        result: { type: "turn", turnId: "turn-1" },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.prompt_result",
        clientMessageId: "client-2",
        result: { type: "completed" },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.opened",
        sessionId: "child-1",
        parentSessionId: "root-1",
      }),
    );
    expect(events.find((event) => event.type === "session.opened")).not.toHaveProperty(
      "futureField",
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        sessionId: "child-1",
        item: expect.objectContaining({ type: "plugin", pluginId: "provider-round-trip" }),
      }),
    );

    unsubscribe();
    await connection.close();
    await runtime.stopAll();
  });

  it("adapts an ACP command and example transformer through the AgentClient path", async () => {
    const transformerPath = fileURLToPath(
      new URL(
        "../../../../../plugin-examples/provider-acp-transformer/server/vendor-edit.ts",
        import.meta.url,
      ),
    );
    const directory = await createPlugin(
      "provider-acp-round-trip",
      `import type { PluginServerContext } from "@getpaseo/plugin/server";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import { vendorEditTransformer } from "./server/vendor-edit.js";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(runAcpProvider({
    id: "acp-example",
    label: "ACP example",
    command: [process.execPath, __ACP_COMMAND__],
    transformers: [vendorEditTransformer],
  }));
  return () => {};
}`,
    );
    await mkdir(path.join(directory, "server"));
    await writeFile(
      path.join(directory, "server/vendor-edit.ts"),
      await readFile(transformerPath, "utf8"),
      "utf8",
    );
    const agentPath = path.join(directory, "fake-acp.cjs");
    await writeFile(
      agentPath,
      `const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, agentCapabilities: {} } });
  } else if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "native-1", modes: null, configOptions: [] } });
  } else if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "native-1", update: { sessionUpdate: "tool_call", toolCallId: "edit-1", name: "vendor_file_edit", title: "Vendor edit", status: "completed", rawInput: { path: "/tmp/example.ts", before: "old", after: "new" } } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "native-1", update: { sessionUpdate: "agent_message_chunk", messageId: "assistant-1", content: { type: "text", text: "ACP says hi" } } } });
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  } else if (message.method === "session/close" || message.method === "session/cancel") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  }
});`,
      "utf8",
    );
    const pluginPath = path.join(directory, "index.server.ts");
    const pluginSource = (await readFile(pluginPath, "utf8")).replace(
      "__ACP_COMMAND__",
      JSON.stringify(agentPath),
    );
    await writeFile(pluginPath, pluginSource, "utf8");

    const runtime = createTestRuntime();
    await runtime.startPlugin("provider-acp-round-trip", directory);
    const connection = await runtime.connectProvider("provider-acp-round-trip", "acp-example", {
      versions: [1],
      capabilities: ["prompt.message", "session.persistence"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));

    await connection.send({
      type: "session.open",
      requestId: "open-acp",
      sessionId: "paseo-1",
      config: { cwd: directory, env: {}, mcpServers: {}, settings: {}, persist: true },
      history: "skip",
    });
    await expect.poll(() => hasReadyRequest(events, "open-acp")).toBe(true);
    await connection.send({
      type: "session.prompt",
      sessionId: "paseo-1",
      prompt: {
        clientMessageId: "client-acp",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "hello" }] },
      },
    });

    await expect.poll(() => hasCompletedTurn(events)).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.prompt_result",
        clientMessageId: "client-acp",
        result: { type: "turn", turnId: "acp:client-acp" },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({
          type: "assistant_message",
          id: "assistant-1",
          text: "ACP says hi",
        }),
      }),
    );

    await connection.close();
    const [metadata] = runtime.getProviderRegistrations("provider-acp-round-trip");
    const adapters = new PluginAgentClientRegistry(pino({ level: "silent" }));
    adapters.replace([adaptRuntimeProvider(runtime, "provider-acp-round-trip", metadata!)]);
    const client = adapters.clients()[metadata!.id];
    const session = await client!.createSession({ provider: metadata!.id, cwd: directory });
    const agentEvents: AgentStreamEvent[] = [];
    session.subscribe((event) => agentEvents.push(event));
    await expect(
      session.startTurn("hello", { clientMessageId: "agent-client-acp" }),
    ).resolves.toEqual({ turnId: "acp:agent-client-acp" });
    await expect.poll(() => hasCompletedAgentTurn(agentEvents)).toBe(true);
    expect(agentEvents).toContainEqual(
      expect.objectContaining({
        type: "timeline",
        item: expect.objectContaining({ type: "assistant_message", text: "ACP says hi" }),
      }),
    );
    expect(agentEvents).toContainEqual(
      expect.objectContaining({
        type: "timeline",
        item: expect.objectContaining({
          type: "tool_call",
          callId: "edit-1",
          detail: {
            type: "edit",
            filePath: "/tmp/example.ts",
            oldString: "old",
            newString: "new",
            unifiedDiff: undefined,
          },
        }),
      }),
    );
    await session.close();
    await adapters.shutdown();
    await runtime.stopAll();
  });

  it("rejects a malformed provider event from a real plugin subprocess", async () => {
    const directory = await createPlugin(
      "malicious-provider",
      `import type { ProviderEvent, ProviderRegistration } from "@getpaseo/plugin/server/provider";
let connectionId = "";
process.on("message", (message: unknown) => {
  const value = message as { type?: string; connectionId?: string };
  if (value.type === "provider.connect") connectionId = value.connectionId ?? "";
});
const provider: ProviderRegistration = {
  id: "malicious",
  label: "Malicious",
  async connect(request) {
    const listeners = new Set<(event: ProviderEvent) => void>();
    const emit = (event: ProviderEvent) => { for (const listener of listeners) listener(event); };
    return {
      version: request.versions[0] ?? 1,
      capabilities: ["prompt.message"],
      async send(input) {
        if (input.type === "session.open") {
          emit({ type: "session.opened", requestId: input.requestId, sessionId: input.sessionId, capabilities: ["prompt.message"], restoration: "core", cwd: input.config.cwd });
          emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
        } else if (input.type === "session.prompt") {
          process.send?.({ type: "provider.event", connectionId, event: { type: "invented.event", sessionId: input.sessionId } });
        }
      },
      onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      async close() {},
    };
  },
};
export default function contribute(server: any) { server.registerProvider(provider); return () => undefined; }`,
    );
    const runtime = createTestRuntime();
    await runtime.startPlugin("malicious-provider", directory);
    const connection = await runtime.connectProvider("malicious-provider", "malicious", {
      versions: [1],
      capabilities: ["prompt.message"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    await connection.send({
      type: "session.open",
      requestId: "open-malicious",
      sessionId: "root-malicious",
      config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: true },
      history: "skip",
    });

    await expect(
      connection.send({
        type: "session.prompt",
        sessionId: "root-malicious",
        prompt: {
          clientMessageId: "malformed-now",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "break transport" }] },
        },
      }),
    ).rejects.toThrow("invalid message");
    expect(events).toContainEqual(
      expect.objectContaining({ type: "session.runtime_failed", sessionId: "root-malicious" }),
    );
    expect(runtime.catalog()).toHaveLength(1);
    await runtime.stopAll();
  });

  it("emits runtime failure for live sessions when a real plugin process dies", async () => {
    const directory = await createPlugin(
      "dying-provider",
      `import type { ProviderEvent, ProviderRegistration } from "@getpaseo/plugin/server/provider";
const provider: ProviderRegistration = {
  id: "dying",
  label: "Dying",
  async connect(request) {
    const listeners = new Set<(event: ProviderEvent) => void>();
    const emit = (event: ProviderEvent) => { for (const listener of listeners) listener(event); };
    return {
      version: request.versions[0] ?? 1,
      capabilities: ["prompt.message"],
      async send(input) {
        if (input.type === "session.open") {
          emit({ type: "session.opened", requestId: input.requestId, sessionId: input.sessionId, capabilities: ["prompt.message"], restoration: "core", cwd: input.config.cwd });
          emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
        }
        if (input.type === "session.prompt") setTimeout(() => process.exit(17), 10);
      },
      onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      async close() {},
    };
  },
};
export default function contribute(server: any) { server.registerProvider(provider); return () => undefined; }`,
    );
    const runtime = createTestRuntime();
    await runtime.startPlugin("dying-provider", directory);
    const connection = await runtime.connectProvider("dying-provider", "dying", {
      versions: [1],
      capabilities: ["prompt.message"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    await connection.send({
      type: "session.open",
      requestId: "open-dying",
      sessionId: "root-dying",
      config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: true },
      history: "skip",
    });
    await connection.send({
      type: "session.prompt",
      sessionId: "root-dying",
      prompt: {
        clientMessageId: "die-now",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "bye" }] },
      },
    });

    await expect
      .poll(() => runtimeFailure(events))
      .toMatchObject({
        type: "session.runtime_failed",
        sessionId: "root-dying",
        error: { message: "Plugin process exited: dying-provider" },
      });
    await runtime.stopAll();
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

  it("closes a provider connection that resolves during plugin shutdown", async () => {
    const suffix = `${process.pid}-${Date.now()}`;
    const startedFile = path.join(tmpdir(), `paseo-provider-connect-started-${suffix}`);
    const closedFile = path.join(tmpdir(), `paseo-provider-connect-closed-${suffix}`);
    const directory = await createPlugin(
      "shutdown-connect",
      `import { writeFile } from "node:fs/promises";
import type { ProviderRegistration } from "@getpaseo/plugin/server/provider";

const provider: ProviderRegistration = {
  id: "delayed",
  label: "Delayed",
  async connect() {
    await writeFile(${JSON.stringify(startedFile)}, "started");
    await new Promise((resolve) => setTimeout(resolve, 100));
    return {
      version: 1,
      capabilities: [],
      async send() {},
      onEvent() { return () => undefined; },
      async close() { await writeFile(${JSON.stringify(closedFile)}, "closed"); },
    };
  },
};

export default function contribute(server: { registerProvider(provider: ProviderRegistration): void }) {
  server.registerProvider(provider);
  return () => undefined;
}`,
    );
    const runtime = createTestRuntime();
    await runtime.startPlugin("shutdown-connect", directory);
    const pending = runtime.connectProvider("shutdown-connect", "delayed", {
      versions: [1],
      capabilities: [],
    });
    await expect.poll(() => readTextIfPresent(startedFile)).toBe("started");

    const stopping = runtime.stopPluginById("shutdown-connect");
    await expect(pending).rejects.toThrow("Plugin stopped: shutdown-connect");
    await stopping;

    await expect(readFile(closedFile, "utf8")).resolves.toBe("closed");
    await Promise.all([rm(startedFile, { force: true }), rm(closedFile, { force: true })]);
  });

  it("closes a provider connection that arrives after negotiation timed out", async () => {
    const directory = await createPlugin(
      "late-provider",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const child = createReloadChild(
      "late-provider",
      [],
      [],
      [{ id: "provider", label: "Provider" }],
    );
    const sent: Array<{ type: string; connectionId?: string }> = [];
    const originalSend = child.send.bind(child);
    child.send = (message, callback) => {
      sent.push(message);
      if (message.type === "provider.connect") {
        callback?.(null);
        return true;
      }
      return originalSend(message, callback);
    };
    const runtime = createTestRuntime({ spawnChild: () => child });
    await runtime.startPlugin("late-provider", directory);
    vi.useFakeTimers();
    try {
      const rejected = expect(
        runtime.connectProvider("late-provider", "provider", {
          versions: [1],
          capabilities: [],
        }),
      ).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(30_000);
      await rejected;
      const connectionId = sent.find(
        (message) => message.type === "provider.connect",
      )?.connectionId;
      expect(
        sent.filter(
          (message) => message.type === "provider.close" && message.connectionId === connectionId,
        ),
      ).toHaveLength(1);

      child.emitMessage({
        type: "provider.connected",
        connectionId,
        version: 1,
        capabilities: [],
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(
        sent.filter(
          (message) => message.type === "provider.close" && message.connectionId === connectionId,
        ),
      ).toHaveLength(2);
      child.emitMessage({ type: "provider.closed", connectionId });
    } finally {
      await runtime.stopAll();
      vi.useRealTimers();
    }
  });

  it("closes child-side state after invalid provider negotiation", async () => {
    const directory = await createPlugin(
      "invalid-provider",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const child = createReloadChild(
      "invalid-provider",
      [],
      [],
      [{ id: "provider", label: "Provider" }],
    );
    const sent: Array<{ type: string; connectionId?: string }> = [];
    const originalSend = child.send.bind(child);
    child.send = (message, callback) => {
      sent.push(message);
      if (message.type === "provider.connect") {
        callback?.(null);
        queueMicrotask(() =>
          child.emitMessage({
            type: "provider.connected",
            connectionId: message.connectionId,
            version: 2,
            capabilities: [],
          }),
        );
        return true;
      }
      return originalSend(message, callback);
    };
    const runtime = createTestRuntime({ spawnChild: () => child });
    await runtime.startPlugin("invalid-provider", directory);

    await expect(
      runtime.connectProvider("invalid-provider", "provider", {
        versions: [1],
        capabilities: [],
      }),
    ).rejects.toThrow("unoffered version");
    const connectionId = sent.find((message) => message.type === "provider.connect")?.connectionId;
    await expect.poll(() => sent).toContainEqual({ type: "provider.close", connectionId });
    child.emitMessage({ type: "provider.closed", connectionId });
    await runtime.stopAll();
  });

  it("closes a late connection after the child rejected its negotiation", async () => {
    const directory = await createPlugin(
      "rejected-provider",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const child = createReloadChild(
      "rejected-provider",
      [],
      [],
      [{ id: "provider", label: "Provider" }],
    );
    const sent: Array<{ type: string; connectionId?: string }> = [];
    const originalSend = child.send.bind(child);
    child.send = (message, callback) => {
      sent.push(message);
      if (message.type === "provider.connect") {
        callback?.(null);
        queueMicrotask(() =>
          child.emitMessage({
            type: "provider.connect_failed",
            connectionId: message.connectionId,
            error: "provider rejected connection",
          }),
        );
        return true;
      }
      return originalSend(message, callback);
    };
    const runtime = createTestRuntime({ spawnChild: () => child });
    await runtime.startPlugin("rejected-provider", directory);

    await expect(
      runtime.connectProvider("rejected-provider", "provider", {
        versions: [1],
        capabilities: [],
      }),
    ).rejects.toThrow("provider rejected connection");
    const connectionId = sent.find((message) => message.type === "provider.connect")?.connectionId;
    const closesBeforeLateSuccess = providerCloseCount(sent, connectionId);

    child.emitMessage({
      type: "provider.connected",
      connectionId,
      version: 1,
      capabilities: [],
    });

    await expect
      .poll(() => providerCloseCount(sent, connectionId))
      .toBe(closesBeforeLateSuccess + 1);
    child.emitMessage({ type: "provider.closed", connectionId });
    await runtime.stopAll();
  });

  it("closes a late connection after plugin shutdown cancels negotiation", async () => {
    const directory = await createPlugin(
      "canceled-provider",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const child = createReloadChild(
      "canceled-provider",
      [],
      [],
      [{ id: "provider", label: "Provider" }],
    );
    const sent: Array<{ type: string; connectionId?: string }> = [];
    const originalSend = child.send.bind(child);
    child.send = (message, callback) => {
      sent.push(message);
      if (message.type === "provider.connect" || message.type === "shutdown") {
        callback?.(null);
        return true;
      }
      return originalSend(message, callback);
    };
    const runtime = createTestRuntime({ spawnChild: () => child });
    await runtime.startPlugin("canceled-provider", directory);
    const pending = runtime.connectProvider("canceled-provider", "provider", {
      versions: [1],
      capabilities: [],
    });
    await expect.poll(() => hasMessageType(sent, "provider.connect")).toBe(true);
    const connectionId = sent.find((message) => message.type === "provider.connect")?.connectionId;
    const rejection = pending.then(
      () => null,
      (error: unknown) => error,
    );
    const stopping = runtime.stopPluginById("canceled-provider");
    try {
      await expect.poll(() => providerCloseCount(sent, connectionId)).toBe(1);
      await expect(rejection).resolves.toMatchObject({
        message: "Plugin stopped: canceled-provider",
      });
      const closesBeforeLateSuccess = providerCloseCount(sent, connectionId);
      child.emitMessage({
        type: "provider.connected",
        connectionId,
        version: 1,
        capabilities: [],
      });
      await expect
        .poll(() => providerCloseCount(sent, connectionId))
        .toBe(closesBeforeLateSuccess + 1);
    } finally {
      child.kill();
      await stopping;
    }
  });

  it("escalates a plugin that ignores graceful shutdown from TERM to KILL", async () => {
    vi.useFakeTimers();
    try {
      const directory = await createPlugin(
        "held-cleanup",
        `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
      );
      const child = createReloadChild("held-cleanup", []);
      const originalSend = child.send.bind(child);
      child.send = (message, callback) => {
        if (message.type !== "shutdown") return originalSend(message, callback);
        callback?.(null);
        return true;
      };
      const signals: Array<NodeJS.Signals | undefined> = [];
      const originalKill = child.kill.bind(child);
      child.kill = (signal?: NodeJS.Signals) => {
        signals.push(signal);
        if (signal === "SIGKILL") return originalKill();
        child.killed = true;
        return true;
      };
      const runtime = createTestRuntime({ spawnChild: () => child });
      await runtime.startPlugin("held-cleanup", directory);

      const stopping = runtime.stopPluginById("held-cleanup");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(signals).toEqual(["SIGTERM"]);
      await vi.advanceTimersByTimeAsync(2_000);
      await stopping;
      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
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
    const runtime = createTestRuntime({}, undefined, "0.8.0");

    await runtime.startPlugin("linear", directory);

    expect(runtime.catalog().map((plugin) => plugin.id)).toEqual(["linear"]);
    expect(runtime.catalog()[0]?.clientBundle).toContain("Attach Linear issue");
    expect(runtime.catalog()[0]?.clientBundle).not.toContain("LINEAR_API_KEY");
    expect(runtime.catalog()[0]?.clientBundle).not.toContain("api.linear.app");
    await runtime.stopAll();
  });

  it("explains that an index.ts plugin was made for an older Paseo version", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-"));
    temporaryDirectories.push(directory);
    await Promise.all([
      writeFile(path.join(directory, "paseo-plugin.json"), JSON.stringify({ id: "legacy" })),
      writeFile(path.join(directory, "index.ts"), "export default function contribute() {}"),
    ]);
    const runtime = createTestRuntime();

    await expect(runtime.startPlugin("legacy", directory)).rejects.toThrow(
      "This plugin was made for an older version of Paseo and cannot run on Paseo v0.8. Ask its author to update it. Plugin authors can follow the migration guide: https://paseo.sh/docs/plugins/v0.8/migration",
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
        `import type { PluginClientContext } from "@getpaseo/plugin/client";
import { Surface } from "./client/surface";
export default function contribute(client: PluginClientContext) {
  client.addSurface("main", Surface);
  return () => undefined;
}`,
        "utf8",
      ),
      writeFile(
        path.join(directory, "index.server.ts"),
        `import type { PluginServerContext } from "@getpaseo/plugin/server";
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
        `import type { PluginClientContext } from "@getpaseo/plugin/client";
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
        `import type { PluginServerContext } from "@getpaseo/plugin/server";
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
