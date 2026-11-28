import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { z } from "zod";
import { createTestLogger } from "../../../../../test-utils/test-logger.js";
import { OpenCodeBridge } from "../bridge.js";

interface Binding {
  sessionID: string;
  baseUrl: string;
  token: string;
}
interface TestTool {
  name: string;
  execute(input: { value: string }, call: { sessionID: string }): Promise<unknown>;
}
interface ToolDefinition {
  name: string;
  description: string;
}
interface McpTestTool {
  name: string;
  execute(
    input: unknown,
    call: { sessionID: string; agent: string; messageID: string; id: string },
  ): Promise<unknown>;
}
interface TestContext {
  sessionID: string;
  tools: Record<string, unknown>;
  system: unknown[];
}

// The fake OpenCode context has no permission service, as on OpenCode before 2.0.29.
const BOUND_WITHOUT_MCP = { features: { mcpTools: false } };

test("a shared plugin binds Paseo sessions without involving unrelated sessions", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-shared-bridge-"));
  const bridge = new OpenCodeBridge({ paseoHome: home, logger: createTestLogger() });
  const tool = { name: "echo", description: "echo", inputSchema: { value: z.string() } };
  const tools = new Map([[tool.name, tool]]);
  // Session-only tools must survive plugin reload without a global definition.
  bridge.setManifestCatalog({ tools: new Map() });
  await bridge.start();
  const unbind = bridge.bindSession({
    sessionId: "paseo",
    env: {},
    tools: {
      tools,
      getTool: (name) => tools.get(name),
      executeTool: async (_name, input) => ({
        content: [{ type: "text", text: String((input as { value: string }).value) }],
      }),
    },
  });
  expect(() => bridge.bindSession({ sessionId: "paseo", env: {} })).toThrow("already bound");
  try {
    const plugin = {
      package: await bridge.materializeV2Plugin(),
      options: bridge.sharedV2Connection(),
    };
    const module = await import(
      pathToFileURL(path.join(fileURLToPath(plugin.package), "server.js")).href
    );
    const installed = new Map<string, TestTool>();
    const hooks: Array<(input: TestContext) => Promise<void>> = [];
    const refreshed: string[] = [];
    let structured = false;
    let rpc: Record<string, (input: Binding) => Promise<unknown>> = {};
    const context = {
      options: {},
      location: { directory: home },
      provider: {
        reload: async () => {
          refreshed.push("provider");
        },
      },
      model: {
        reload: async () => {
          refreshed.push("model");
        },
      },
      agent: {
        reload: async () => {
          refreshed.push("agent");
        },
      },
      command: {
        reload: async () => {
          refreshed.push("command");
        },
      },
      skill: {
        reload: async () => {
          refreshed.push("skill");
        },
      },
      rpc: {
        register: async (_definition: unknown, handlers: typeof rpc) => {
          rpc = handlers;
          return { dispose: async () => {} };
        },
      },
      tool: {
        transform: async (fn: (editor: { add(item: TestTool): void }) => void) => {
          fn({ add: (item) => installed.set(item.name, item) });
          return { dispose: async () => {} };
        },
      },
      session: {
        context: async () =>
          structured ? [{ type: "user", metadata: { paseoOutputSchema: { type: "string" } } }] : [],
        get: async () => ({ parentID: "" }),
        hook: async (_name: string, fn: (input: TestContext) => Promise<void>) => {
          hooks.push(fn);
          return { dispose: async () => {} };
        },
      },
    };
    let dispose = await module.default.setup(context);
    await rpc.bind({ sessionID: "paseo", ...plugin.options });
    await rpc.refresh({ sessionID: "paseo", ...plugin.options });
    expect(refreshed).toEqual(["provider", "model", "agent", "command", "skill"]);
    await expect(
      rpc.bind({ sessionID: "paseo", ...plugin.options, token: "another-daemon" }),
    ).resolves.toEqual({ error: "OpenCode session is already bound to another Paseo bridge" });
    const own = { sessionID: "paseo", tools: { paseo_echo: {}, native: {} }, system: [] };
    for (const hook of hooks) await hook(own);
    expect(Object.keys(own.tools)).toEqual(["paseo_echo", "native"]);
    expect(
      await installed.get("paseo_echo")!.execute({ value: "ok" }, { sessionID: "paseo" }),
    ).toMatchObject({ content: [{ type: "text", text: "ok" }] });
    await dispose();
    hooks.length = 0;
    installed.clear();
    dispose = await module.default.setup(context);
    const afterReload = { sessionID: "paseo", tools: { paseo_echo: {}, native: {} }, system: [] };
    for (const hook of hooks) await hook(afterReload);
    expect(Object.keys(afterReload.tools)).toEqual(["paseo_echo", "native"]);
    expect(
      await installed.get("paseo_echo")!.execute({ value: "reloaded" }, { sessionID: "paseo" }),
    ).toMatchObject({ content: [{ type: "text", text: "reloaded" }] });
    await bridge.close();
    await dispose();
    hooks.length = 0;
    installed.clear();
    dispose = await module.default.setup(context);
    const unrelated = { sessionID: "other", tools: { paseo_echo: {}, native: {} }, system: [] };
    for (const hook of hooks) await hook(unrelated);
    expect(Object.keys(unrelated.tools)).toEqual(["native"]);
    structured = true;
    const structuredOnly = {
      sessionID: "other",
      tools: { paseo_structured_output: {} },
      system: [],
    };
    for (const hook of hooks) await hook(structuredOnly);
    expect(Object.keys(structuredOnly.tools)).toEqual(["paseo_structured_output"]);
    const restarted = new OpenCodeBridge({
      paseoHome: home,
      logger: createTestLogger(),
      port: Number(new URL(plugin.options.baseUrl).port),
    });
    restarted.setManifestCatalog({ tools });
    await restarted.start();
    const releaseRestarted = restarted.bindSession({ sessionId: "paseo", env: {} });
    try {
      await expect(
        rpc.bind({ sessionID: "paseo", ...restarted.sharedV2Connection() }),
      ).resolves.toEqual(BOUND_WITHOUT_MCP);
    } finally {
      releaseRestarted();
      await restarted.close();
    }
    await dispose();
  } finally {
    unbind();
    await bridge.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("a shared plugin rebinds a session after the previous bridge stops listening", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-shared-bridge-refused-"));
  const previous = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
    response.end(JSON.stringify({ tools: [] }));
  });
  await new Promise<void>((resolve) => previous.listen(0, "127.0.0.1", resolve));
  const previousPort = (previous.address() as AddressInfo).port;
  const current = new OpenCodeBridge({ paseoHome: home, logger: createTestLogger() });
  current.setManifestCatalog({ tools: new Map() });
  let rpc: Record<string, (input: Binding) => Promise<unknown>> = {};
  let dispose: (() => Promise<void>) | undefined;
  let releaseCurrent: (() => void) | undefined;
  try {
    const plugin = {
      package: await current.materializeV2Plugin(),
      options: { baseUrl: `http://127.0.0.1:${previousPort}`, token: "previous-bridge" },
    };
    const module = await import(
      pathToFileURL(path.join(fileURLToPath(plugin.package), "server.js")).href
    );
    dispose = await module.default.setup({
      options: {},
      location: { directory: home },
      provider: { reload: async () => {} },
      model: { reload: async () => {} },
      agent: { reload: async () => {} },
      command: { reload: async () => {} },
      skill: { reload: async () => {} },
      rpc: {
        register: async (_definition: unknown, handlers: typeof rpc) => {
          rpc = handlers;
          return { dispose: async () => {} };
        },
      },
      tool: { transform: async () => ({ dispose: async () => {} }) },
      session: {
        context: async () => [],
        get: async () => ({ parentID: "" }),
        hook: async () => ({ dispose: async () => {} }),
      },
    });
    await expect(rpc.bind({ sessionID: "paseo", ...plugin.options })).resolves.toEqual(
      BOUND_WITHOUT_MCP,
    );
    await current.start();
    // The restarted daemon owns the agent again, so its bridge serves this session.
    releaseCurrent = current.bindSession({ sessionId: "paseo", env: {} });
    await new Promise<void>((resolve) => {
      previous.close(() => resolve());
      previous.closeAllConnections();
    });
    await expect(
      rpc.bind({ sessionID: "paseo", ...current.sharedV2Connection() }),
    ).resolves.toEqual(BOUND_WITHOUT_MCP);
  } finally {
    await dispose?.();
    releaseCurrent?.();
    await current.close();
    await new Promise<void>((resolve) => previous.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});

function addSession(
  bridge: OpenCodeBridge,
  sessionId: string,
  descriptions: Record<string, string>,
) {
  const tools = new Map(
    Object.entries(descriptions).map(([name, description]) => [
      name,
      { name, description, inputSchema: { value: z.string() } },
    ]),
  );
  return bridge.bindSession({
    sessionId,
    env: {},
    tools: {
      tools,
      getTool: (name) => tools.get(name),
      executeTool: async () => ({ content: [] }),
    },
  });
}

async function registerAtLocation(bridge: OpenCodeBridge, home: string) {
  const pluginPath = fileURLToPath(await bridge.materializeV2Plugin());
  const plugin = await import(pathToFileURL(path.join(pluginPath, "server.js")).href);
  const tools: Record<string, ToolDefinition> = {};
  const hooks: Array<(context: TestContext) => Promise<void>> = [];
  let rpc: Record<string, (input: Binding) => Promise<unknown>> = {};
  const dispose = await plugin.default.setup({
    options: {},
    location: { directory: home },
    rpc: {
      register: async (_definition: unknown, handlers: typeof rpc) => {
        rpc = handlers;
        return { dispose: async () => {} };
      },
    },
    tool: {
      transform: async (apply: (editor: { add(item: ToolDefinition): void }) => void) => {
        const added: string[] = [];
        apply({
          add: (item) => {
            added.push(item.name);
            tools[item.name] = item;
          },
        });
        return {
          dispose: async () => {
            for (const name of added) delete tools[name];
          },
        };
      },
    },
    session: {
      context: async () => [],
      get: async () => ({ parentID: "" }),
      hook: async (event: string, handler: (context: TestContext) => Promise<void>) => {
        if (event === "context") hooks.push(handler);
        return { dispose: async () => {} };
      },
    },
  });
  return {
    bind: (owner: OpenCodeBridge, sessionID: string) =>
      rpc.bind!({ sessionID, ...owner.sharedV2Connection() }),
    visible: async (sessionID: string) => {
      const context = { sessionID, tools: { ...tools }, system: [] };
      for (const hook of hooks) await hook(context);
      return context.tools;
    },
    dispose,
  };
}

test.each([false, true])(
  "rebinds an existing session after an owner stops and its definition changes (second retained session: %s)",
  async (second) => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-upgrade-repro-"));
    const old = new OpenCodeBridge({ paseoHome: home, logger: createTestLogger() });
    const peer = new OpenCodeBridge({ paseoHome: home, logger: createTestLogger() });
    const next = new OpenCodeBridge({ paseoHome: home, logger: createTestLogger() });
    let location: Awaited<ReturnType<typeof registerAtLocation>> | undefined;
    try {
      await old.start();
      addSession(old, "first", { echo: "echo v1" });
      location = await registerAtLocation(old, home);
      await location.bind(old, "first");
      expect(await location.visible("first")).toHaveProperty("paseo_echo.description", "echo v1");
      if (second) {
        addSession(old, "second", { echo: "echo v1" });
        await location.bind(old, "second");
      }

      await peer.start();
      addSession(peer, "peer", { extra: "extra" });
      await location.bind(peer, "peer");

      // The OpenCode location survives, while the old daemon's HTTP service stops.
      await old.close();
      await next.start();
      addSession(next, "first", { echo: "echo v2" });
      await expect(location.bind(next, "first")).resolves.toEqual(BOUND_WITHOUT_MCP);
      expect(await location.visible("first")).toHaveProperty("paseo_echo.description", "echo v2");
      expect(await location.visible("peer")).toHaveProperty("paseo_extra");
    } finally {
      await location?.dispose();
      await old.close();
      await next.close();
      await peer.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test("binding another session at the same location preserves the first session's tools", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-upgrade-scope-repro-"));
  const bridge = new OpenCodeBridge({ paseoHome: home, logger: createTestLogger() });
  let location: Awaited<ReturnType<typeof registerAtLocation>> | undefined;
  try {
    await bridge.start();
    addSession(bridge, "first", { echo: "echo", extra: "extra" });
    addSession(bridge, "second", { echo: "echo" });
    location = await registerAtLocation(bridge, home);
    await location.bind(bridge, "first");
    expect(await location.visible("first")).toHaveProperty("paseo_extra");
    await location.bind(bridge, "second");
    expect(await location.visible("second")).not.toHaveProperty("paseo_extra");
    expect(await location.visible("first")).toHaveProperty("paseo_extra");

    addSession(bridge, "conflict", { echo: "echo different" });
    await expect(location.bind(bridge, "conflict")).rejects.toThrow(
      "Conflicting Paseo tool definition: echo",
    );
    expect(await location.visible("first")).toHaveProperty("paseo_echo.description", "echo");
  } finally {
    await location?.dispose();
    await bridge.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("a shared plugin gives each session its own MCP tools behind OpenCode's permission check", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-shared-bridge-mcp-"));
  const bridge = new OpenCodeBridge({ paseoHome: home, logger: createTestLogger() });
  bridge.setManifestCatalog({ tools: new Map() });
  await bridge.start();
  const adopted: string[] = [];
  const sessionMcp = (marker: string) => ({
    tools: [
      {
        name: "hub_marker",
        description: `Return ${marker}`,
        inputSchema: { type: "object" as const },
      },
      // Only session A has `local_env`, which the user's own OpenCode configuration also has.
      ...(marker === "A"
        ? [
            {
              name: "local_env",
              description: "Paseo env",
              inputSchema: { type: "object" as const },
            },
          ]
        : []),
    ],
    instructions: `Use ${marker}`,
    execute: async (name: string, input: unknown) => ({
      content: [{ type: "text" as const, text: `${name}:${marker}:${JSON.stringify(input)}` }],
    }),
  });
  const releases = ["a", "b"].map((id) =>
    bridge.bindSession({
      sessionId: id,
      env: {},
      mcp: sessionMcp(id.toUpperCase()),
      adoptDescendant: async (child) => {
        adopted.push(`${id}>${child}`);
      },
    }),
  );
  let dispose: (() => Promise<void>) | undefined;
  try {
    const plugin = await bridge.materializeV2Plugin();
    const module = await import(pathToFileURL(path.join(fileURLToPath(plugin), "server.js")).href);
    const installed = new Map<string, McpTestTool>();
    const natives = new Map<string, McpTestTool & { description: string; input: unknown }>([
      [
        "local_env",
        {
          name: "local_env",
          description: "User env",
          input: { type: "object" },
          execute: async () => ({ output: { from: "user" } }),
        },
      ],
    ]);
    const hooks: Array<(input: TestContext) => Promise<void>> = [];
    const asserted: unknown[] = [];
    let rpc: Record<string, (input: Binding) => Promise<unknown>> = {};
    const parents: Record<string, string> = { child: "a" };
    dispose = await module.default.setup({
      options: {},
      location: { directory: home },
      ...Object.fromEntries(
        ["provider", "model", "agent", "command", "skill"].map((name) => [
          name,
          { reload: async () => {} },
        ]),
      ),
      rpc: {
        register: async (_definition: unknown, handlers: typeof rpc) => {
          rpc = handlers;
          return { dispose: async () => {} };
        },
      },
      tool: {
        transform: async (
          fn: (editor: {
            get(name: string): McpTestTool | undefined;
            add(item: McpTestTool): void;
          }) => void,
        ) => {
          fn({ get: (name) => natives.get(name), add: (item) => installed.set(item.name, item) });
          return { dispose: async () => {} };
        },
      },
      permission: {
        assert: async (request: unknown) => {
          asserted.push(request);
        },
      },
      session: {
        context: async () => [],
        get: async ({ sessionID }: { sessionID: string }) => ({
          parentID: parents[sessionID] ?? "",
        }),
        hook: async (_name: string, fn: (input: TestContext) => Promise<void>) => {
          hooks.push(fn);
          return { dispose: async () => {} };
        },
      },
    });
    for (const sessionID of ["a", "b"])
      await expect(rpc.bind({ sessionID, ...bridge.sharedV2Connection() })).resolves.toEqual({
        features: { mcpTools: true },
      });
    const requestFor = async (sessionID: string) => {
      const input = {
        sessionID,
        tools: { hub_marker: {}, local_env: { description: "User env" }, native: {} },
        system: [],
      };
      for (const hook of hooks) await hook(input);
      return input;
    };
    const contextFor = async (sessionID: string) => (await requestFor(sessionID)).tools;
    expect(await contextFor("a")).toEqual({
      hub_marker: { description: "Return A", input: { type: "object" } },
      local_env: { description: "Paseo env", input: { type: "object" } },
      native: {},
    });
    expect(await contextFor("b")).toEqual({
      hub_marker: { description: "Return B", input: { type: "object" } },
      local_env: { description: "User env", input: { type: "object" } },
      native: {},
    });
    expect(await contextFor("other")).toEqual({
      local_env: { description: "User env", input: { type: "object" } },
      native: {},
    });
    // OpenCode validates input against the registration, so it accepts both tools' input.
    expect(installed.get("local_env")).toMatchObject({
      input: { type: "object", additionalProperties: true },
    });
    // A descendant uses its root's servers and instructions from its first request, and is
    // adopted once.
    const child = await requestFor("child");
    expect(child.tools).toMatchObject({ hub_marker: { description: "Return A" } });
    expect(child.system).toEqual([{ type: "text", text: "Use A" }]);
    await contextFor("child");
    expect(adopted).toEqual(["a>child"]);
    expect((await requestFor("other")).system).toEqual([]);

    const call = { agent: "build", messageID: "message", id: "call" };
    const hub = installed.get("hub_marker")!;
    await expect(hub.execute({ q: 1 }, { ...call, sessionID: "child" })).resolves.toMatchObject({
      content: [{ type: "text", text: 'hub_marker:A:{"q":1}' }],
    });
    await expect(hub.execute({}, { ...call, sessionID: "b" })).resolves.toMatchObject({
      content: [{ type: "text", text: "hub_marker:B:{}" }],
    });
    await expect(hub.execute({}, { ...call, sessionID: "other" })).rejects.toThrow(
      "not bound to a Paseo agent",
    );
    // A session without its own `local_env` runs the user's tool, which checks its own permission.
    const env = installed.get("local_env")!;
    await expect(env.execute({}, { ...call, sessionID: "b" })).resolves.toEqual({
      content: [{ type: "text", text: '{"from":"user"}' }],
    });
    await expect(env.execute({}, { ...call, sessionID: "a" })).resolves.toMatchObject({
      content: [{ type: "text", text: "local_env:A:{}" }],
    });
    expect(asserted).toEqual([
      expect.objectContaining({ sessionID: "child", action: "hub_marker", resources: ["*"] }),
      expect.objectContaining({ sessionID: "b", action: "hub_marker", resources: ["*"] }),
      expect.objectContaining({ sessionID: "a", action: "local_env", resources: ["*"] }),
    ]);
  } finally {
    await dispose?.();
    for (const release of releases) release();
    await bridge.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("a refused connection is the only probe failure that clears a binding", async () => {
  const source = new URL("./shared-bridge-plugin.mjs", import.meta.url).href;
  const { isRefused } = (await import(source)) as { isRefused: (error: unknown) => boolean };
  const nodeShape = Object.assign(new Error("fetch failed"), {
    cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
  });
  const olderBunShape = Object.assign(new TypeError("Unable to connect"), {
    code: "ConnectionRefused",
  });
  // OpenCode 2.2.5 runs on Bun 1.4.4, which carries the code on the error and
  // leaves `cause` unset. Node puts the same failure on `cause` instead.
  const bunShape = Object.assign(
    new TypeError("ECONNREFUSED: Unable to connect. Is the computer able to access the url?"),
    { code: "ECONNREFUSED" },
  );
  const inconclusive = Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" });
  expect(isRefused(nodeShape)).toBe(true);
  expect(isRefused(olderBunShape)).toBe(true);
  expect(isRefused(bunShape)).toBe(true);
  expect(isRefused(inconclusive)).toBe(false);
  expect(isRefused(undefined)).toBe(false);
});
