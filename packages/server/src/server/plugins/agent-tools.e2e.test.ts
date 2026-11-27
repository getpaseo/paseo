import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import {
  createTestAgentClient,
  type TestAgentClientOptions,
} from "../test-utils/fake-agent-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { importSessionFromPersistence } from "../agent/provider-session-import.js";
import { BuiltinPluginLoader } from "./builtin/index.js";
import { serializePaseoToolInputParameters } from "../agent/tools/paseo-tool-serialization.js";
import type {
  AgentClient,
  AgentLaunchContext,
  AgentSessionConfig,
  AgentPromptInput,
} from "../agent/agent-sdk-types.js";

function recordingProvider(native: boolean, callbacks: TestAgentClientOptions = {}) {
  const launches: { config: AgentSessionConfig; context?: AgentLaunchContext }[] = [];
  const turns: { prompt: AgentPromptInput; launchCount: number }[] = [];
  const steers: AgentPromptInput[] = [];
  const events = { interrupts: 0 };
  const inner = createTestAgentClient("codex", {
    ...callbacks,
    supportsMcpServers: callbacks.supportsMcpServers ?? true,
    onStartTurn: (prompt, config) => {
      turns.push({ prompt, launchCount: launches.length });
      callbacks.onStartTurn?.(prompt, config);
    },
    steerActiveTurn: async (prompt) => {
      steers.push(prompt);
      return { status: "accepted" };
    },
    onInterrupt: () => {
      events.interrupts++;
      callbacks.onInterrupt?.();
    },
  });
  const provider: AgentClient = {
    provider: inner.provider,
    capabilities: { ...inner.capabilities, supportsNativePaseoTools: native },
    supportsLaunchWrap: true,
    createSession: async (config, context, options) => {
      launches.push({ config, context });
      return inner.createSession(config, context, options);
    },
    resumeSession: async (handle, config, context, options) => {
      launches.push({ config: config as AgentSessionConfig, context });
      return inner.resumeSession(handle, config, context, options);
    },
    importSession: (input, context) =>
      importSessionFromPersistence({
        provider: "codex",
        request: input,
        context,
        resumeSession: provider.resumeSession.bind(provider),
      }),
    isAvailable: () => inner.isAvailable(),
    fetchCatalog: (options) => inner.fetchCatalog(options),
  };
  return { provider, launches, turns, steers, events };
}

const pluginSource = `
import { z } from "zod";
import { defineAgentTool } from "@getpaseo/plugin/server";
let calls = 0;
const tool = defineAgentTool({
  name: "plugin_echo", description: "Echo for the chosen agent",
  input: z.object({ text: z.string().min(1).refine(value => value !== "forbidden", "Forbidden by plugin").describe("Message") }),
  async execute(input, { agent, paseo, signal }) {
    calls++;
    if (input.text === "throw") throw new Error("handler failed");
    return { text: JSON.stringify({ agent, input, calls, sdk: typeof paseo.agents.ref, aborted: signal.aborted }) };
  },
});
export default function contribute(server) {
  server.addHook("agent.open.before", async ({ request }) => {
    if (request.labels.x !== "y") return;
    return { ...request, env: { ...request.env, OPEN_INFO: JSON.stringify({ title: request.title, labels: request.labels, reason: request.reason }) }, tools: [...request.tools, tool] };
  });
  return () => {};
}
`;

async function setup(
  native = false,
  source = pluginSource,
  policy?: { enabled?: boolean; disabledTools?: string[] },
  providerOptions?: TestAgentClientOptions,
) {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-agent-tools-"));
  const recorder = recordingProvider(native, providerOptions);
  const daemon = await createTestPaseoDaemon({
    daemonVersion: "0.14.0-beta.1",
    agentClients: { codex: recorder.provider },
    mcpEnabled: true,
    providerOverrides: { codex: { paseoTools: policy } },
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.14.0-beta.1",
  });
  const mcps: Client[] = [];
  async function install(id: string, code: string) {
    const pluginDirectory = path.join(directory, id);
    await mkdir(pluginDirectory);
    await writeFile(
      path.join(pluginDirectory, "paseo-plugin.json"),
      JSON.stringify({ id, requirements: { paseo: ">=0.14.0-beta.1" } }),
    );
    await writeFile(path.join(pluginDirectory, "index.server.ts"), code);
    await client.installDirectoryPlugin(pluginDirectory);
  }
  await client.connect();
  await client.fetchAgents({ subscribe: {} });
  await client.patchDaemonConfig({ pluginsEnabled: true });
  try {
    await install("tools-test", source);
  } catch (error) {
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    ...recorder,
    daemon,
    client,
    directory,
    install,
    async create(labels: Record<string, string> = {}) {
      return daemon.daemon.agentManager.createAgent(
        { provider: "codex", cwd: directory },
        undefined,
        { labels, initialTitle: "Chosen title" },
      );
    },
    async mcp(agentId?: string) {
      const server = recorder.launches.at(-1)!.config.mcpServers?.paseo;
      let url: string;
      if (agentId) url = `http://127.0.0.1:${daemon.port}/mcp/agents?callerAgentId=${agentId}`;
      else {
        if (server?.type !== "http") throw new Error("Expected HTTP server");
        url = server.url;
      }
      const mcp = new Client({ name: "plugin-tools-test", version: "1" });
      mcps.push(mcp);
      await mcp.connect(new StreamableHTTPClientTransport(new URL(url)));
      return mcp;
    },
    async close() {
      await Promise.all(mcps.map((mcp) => mcp.close()));
      await client.close();
      await daemon.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("session hooks attach tools only to matching agents over MCP, with validated input and caller context", async () => {
  const h = await setup();
  try {
    const a = await h.create({ x: "y" });
    expect(JSON.parse(h.launches.at(-1)!.context!.env!.OPEN_INFO)).toEqual({
      title: "Chosen title",
      labels: { x: "y" },
      reason: "create",
    });
    const mcpA = await h.mcp();
    const listed = (await mcpA.listTools()).tools.find((tool) => tool.name === "plugin_echo");
    expect(listed).toMatchObject({
      name: "plugin_echo",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", minLength: 1, description: "Message" } },
        required: ["text"],
      },
    });
    const b = await h.create();
    const mcpB = await h.mcp();
    expect((await mcpB.listTools()).tools.map((tool) => tool.name)).not.toContain("plugin_echo");
    const invalid = await mcpA.callTool({ name: "plugin_echo", arguments: { text: "" } });
    expect(invalid.isError).toBe(true);
    expect(JSON.stringify(invalid)).toContain("text");
    expect(
      await mcpA.callTool({ name: "plugin_echo", arguments: { text: "forbidden" } }),
    ).toMatchObject({
      isError: true,
      content: [{ type: "text", text: expect.stringContaining("Forbidden by plugin") }],
    });
    const result = await mcpA.callTool({ name: "plugin_echo", arguments: { text: "hello" } });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse((result.content as { text: string }[])[0].text)).toMatchObject({
      agent: { id: a.id, cwd: h.directory, title: "Chosen title" },
      input: { text: "hello" },
      calls: 1,
      sdk: "function",
      aborted: false,
    });
    expect(a.id).not.toBe(b.id);
    expect(
      await mcpA.callTool({ name: "plugin_echo", arguments: { text: "throw" } }),
    ).toMatchObject({ isError: true, content: [{ type: "text", text: "handler failed" }] });
    expect(
      (await mcpA.callTool({ name: "plugin_echo", arguments: { text: "still alive" } })).isError,
    ).not.toBe(true);
  } finally {
    await h.close();
  }
}, 60_000);

test("native providers get the same attached schema and execution", async () => {
  const h = await setup(true);
  try {
    const a = await h.create({ x: "y" });
    const catalog = h.launches.at(-1)!.context!.paseoTools!;
    expect(catalog.getTool("plugin_echo")?.description).toBe("Echo for the chosen agent");
    const mcp = await h.mcp(a.id);
    const advertised = (await mcp.listTools()).tools.find((tool) => tool.name === "plugin_echo")!;
    expect(serializePaseoToolInputParameters(catalog.getTool("plugin_echo")!)).toEqual(
      advertised.inputSchema,
    );
    const result = await catalog.executeTool("plugin_echo", { text: "native" });
    expect(JSON.parse(result.content[0].text!)).toMatchObject({
      agent: { id: a.id },
      input: { text: "native" },
    });
  } finally {
    await h.close();
  }
}, 60_000);

test("resume uses the stored title and labels, and close removes the attachment", async () => {
  const h = await setup(true);
  try {
    const a = await h.create({ x: "y" });
    const catalog = h.launches.at(-1)!.context!.paseoTools!;
    const handle = a.persistence!;
    await h.daemon.daemon.agentManager.setTitle(a.id, "Stored title");
    await h.daemon.daemon.agentManager.closeAgent(a.id);
    expect(h.daemon.daemon.agentManager.getPluginTools(a.id)).toEqual([]);
    await expect(catalog.executeTool("plugin_echo", { text: "closed" })).rejects.toThrow(
      "Agent is not live",
    );
    await h.daemon.daemon.agentManager.resumeAgentFromPersistence(handle, a.config, a.id);
    expect(JSON.parse(h.launches.at(-1)!.context!.env!.OPEN_INFO)).toEqual({
      title: "Stored title",
      labels: { x: "y" },
      reason: "resume",
    });
    expect(h.launches.at(-1)!.context!.paseoTools!.getTool("plugin_echo")?.name).toBe(
      "plugin_echo",
    );
  } finally {
    await h.close();
  }
}, 60_000);

test.each([
  {
    name: "Paseo",
    source: pluginSource.replace('name: "plugin_echo"', 'name: "list_agents"'),
    other: false,
    message: /plugin tools-test.*Paseo tool list_agents/,
  },
  {
    name: "another plugin",
    source: pluginSource,
    other: true,
    message: /plugin tools-test.*plugin other-tools/,
  },
  {
    name: "the same plugin",
    source: pluginSource.replace("tools: [...request.tools, tool]", "tools: [tool, tool]"),
    other: false,
    message: /Duplicate agent tool: plugin_echo/,
  },
])(
  "collisions with $name fail only targeted session opens",
  async ({ source, other, message }) => {
    const h = await setup(false, source);
    try {
      if (other) await h.install("other-tools", pluginSource);
      await expect(h.create({ x: "y" })).rejects.toThrow(message);
      expect(h.launches).toHaveLength(0);
      await h.create();
      expect(h.launches).toHaveLength(1);
      expect((await (await h.mcp()).listTools()).tools.map((tool) => tool.name)).not.toContain(
        "plugin_echo",
      );
    } finally {
      await h.close();
    }
  },
  60_000,
);

test("each plugin owns its tool array and callbacks can remove earlier attachments", async () => {
  const source = pluginSource.replace(
    "  return () => {};",
    `
  server.addHook("agent.open.before", async ({ request }) => {
    if (request.labels.x === "y" && request.tools[0]?.name !== "plugin_echo") throw new Error("Lost plugin-local definitions");
    return { ...request, tools: [] };
  });
  return () => {};`,
  );
  const h = await setup(false, source);
  try {
    await h.install(
      "other-tools",
      pluginSource
        .replace('name: "plugin_echo"', 'name: "other_echo"')
        .replace(
          '    if (request.labels.x !== "y") return;',
          '    if (request.tools.length !== 0) throw new Error("Saw another plugin tools");\n    if (request.labels.x !== "y") return;',
        ),
    );
    await h.create({ x: "y" });
    const names = (await (await h.mcp()).listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("other_echo");
    expect(names).not.toContain("plugin_echo");
  } finally {
    await h.close();
  }
}, 60_000);

test("disabled plugins remove tools from existing and new MCP catalogs", async () => {
  const h = await setup();
  try {
    await h.create({ x: "y" });
    const mcp = await h.mcp();
    expect((await mcp.listTools()).tools.map((tool) => tool.name)).toContain("plugin_echo");
    await h.client.patchDaemonConfig({ pluginsEnabled: false });
    expect((await mcp.listTools()).tools.map((tool) => tool.name)).not.toContain("plugin_echo");
    await h.create({ x: "y" });
    expect((await (await h.mcp()).listTools()).tools.map((tool) => tool.name)).not.toContain(
      "plugin_echo",
    );
  } finally {
    await h.close();
  }
}, 60_000);

test.each([false, true])(
  "provider tools disabled gates plugin tools (native=%s)",
  async (native) => {
    const h = await setup(native, pluginSource, { enabled: false });
    try {
      await h.create({ x: "y" });
      expect(h.launches.at(-1)!.context!.paseoTools).toBeUndefined();
      expect(h.launches.at(-1)!.config.mcpServers?.paseo).toBeUndefined();
    } finally {
      await h.close();
    }
  },
  60_000,
);

test("disabledTools filters plugin tool names", async () => {
  const h = await setup(true, pluginSource, { disabledTools: ["plugin_echo"] });
  try {
    await h.create({ x: "y" });
    expect(h.launches.at(-1)!.context!.paseoTools!.getTool("plugin_echo")).toBeUndefined();
  } finally {
    await h.close();
  }
}, 60_000);

const waitingSource = pluginSource
  .replace("import { z }", 'import { writeFile } from "node:fs/promises";\nimport { z }')
  .replace(
    "    calls++;",
    `
    calls++;
    if (input.text === "wait") {
      await writeFile(agent.cwd + "/started", agent.id);
      await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
      await writeFile(agent.cwd + "/aborted", agent.id);
      return { text: "discard this result" };
    }
`,
  );

test("caller cancellation aborts the plugin handler and discards its result", async () => {
  const h = await setup(true, waitingSource);
  try {
    const a = await h.create({ x: "y" });
    const catalog = h.launches.at(-1)!.context!.paseoTools!;
    const controller = new AbortController();
    const call = catalog.executeTool(
      "plugin_echo",
      { text: "wait" },
      { signal: controller.signal },
    );
    const rejected = expect(call).rejects.toThrow("Canceled by caller");
    await expect.poll(() => readFile(path.join(h.directory, "started"), "utf8")).toBe(a.id);
    controller.abort(new Error("Canceled by caller"));
    await rejected;
    await expect.poll(() => readFile(path.join(h.directory, "aborted"), "utf8")).toBe(a.id);
  } finally {
    await h.close();
  }
}, 60_000);

test("a plugin stopping mid-call returns a tool error", async () => {
  const h = await setup(true, waitingSource);
  try {
    const a = await h.create({ x: "y" });
    const call = h.launches
      .at(-1)!
      .context!.paseoTools!.executeTool("plugin_echo", { text: "wait" });
    await expect.poll(() => readFile(path.join(h.directory, "started"), "utf8")).toBe(a.id);
    await h.client.patchDaemonConfig({ pluginsEnabled: false });
    expect(await call).toMatchObject({
      isError: true,
      content: [{ type: "text", text: expect.stringContaining("Plugin stopped") }],
    });
  } finally {
    await h.close();
  }
}, 60_000);

test("history sessions ignore attached tools", async () => {
  const h = await setup(true);
  try {
    const a = await h.create({ x: "y" });
    const handle = a.persistence!;
    await h.client.archiveAgent(a.id);
    await h.daemon.daemon.agentManager.resumeAgentFromPersistence(handle, a.config, a.id);
    expect(h.daemon.daemon.agentManager.getPluginTools(a.id)).toEqual([]);
    expect(h.launches.at(-1)!.context!.paseoTools?.getTool("plugin_echo")).toBeUndefined();
  } finally {
    await h.close();
  }
}, 60_000);

test("disabled plugins attach no tools to a new native session", async () => {
  const h = await setup(true);
  try {
    await h.client.patchDaemonConfig({ pluginsEnabled: false });
    await h.create({ x: "y" });
    expect(h.launches.at(-1)!.context!.paseoTools!.getTool("plugin_echo")).toBeUndefined();
  } finally {
    await h.close();
  }
}, 60_000);

test("structured tool results get model-visible text when text is omitted", async () => {
  const h = await setup(
    true,
    pluginSource.replace(
      "    calls++;",
      '    return { structuredContent: { status: "created" } };',
    ),
  );
  try {
    await h.create({ x: "y" });
    expect(
      await h.launches
        .at(-1)!
        .context!.paseoTools!.executeTool("plugin_echo", { text: "structured" }),
    ).toEqual({
      content: [{ type: "text", text: JSON.stringify({ status: "created" }, null, 2) }],
      structuredContent: { status: "created" },
      isError: undefined,
    });
  } finally {
    await h.close();
  }
}, 60_000);

test("reloading a plugin retires its old attachments, and both the agent MCP and the launch-time catalog reach the new instance", async () => {
  const h = await setup(true);
  try {
    const a = await h.create({ x: "y" });
    const mcp = await h.mcp(a.id);
    const launchCatalog = h.launches.at(-1)!.context!.paseoTools!;
    expect((await mcp.listTools()).tools.map((tool) => tool.name)).toContain("plugin_echo");
    expect((await launchCatalog.executeTool("plugin_echo", { text: "before" })).isError).not.toBe(
      true,
    );
    await h.client.reloadPlugin("tools-test");
    expect(h.daemon.daemon.agentManager.getPluginTools(a.id)).toEqual([]);
    // A native provider keeps the catalog it launched with. Its call reaches the restarted plugin, whose own call
    // count starts again.
    const result = await launchCatalog.executeTool("plugin_echo", { text: "after restart" });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse((result.content as { text: string }[])[0].text)).toMatchObject({
      input: { text: "after restart" },
      calls: 1,
    });
    expect((await mcp.listTools()).tools.map((tool) => tool.name)).toContain("plugin_echo");
    expect(h.daemon.daemon.agentManager.getPluginTools(a.id).map((tool) => tool.name)).toEqual([
      "plugin_echo",
    ]);
    expect(h.launches).toHaveLength(1);
  } finally {
    await h.close();
  }
}, 60_000);

test("built-in plugins attach and execute tools while configured plugins are disabled", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-builtin-tools-"));
  const directory = path.join(root, "builtin-tools");
  await mkdir(directory);
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({ id: "builtin-tools", requirements: { paseo: ">=0.14.0-beta.1" } }),
  );
  await writeFile(path.join(directory, "index.server.ts"), pluginSource);
  const recorder = recordingProvider(true);
  const daemon = await createTestPaseoDaemon({
    daemonVersion: "0.14.0-beta.1",
    agentClients: { codex: recorder.provider },
    pluginsEnabled: false,
    builtinPlugins: new BuiltinPluginLoader(root, ["builtin-tools"]),
  });
  try {
    const a = await daemon.daemon.agentManager.createAgent(
      { provider: "codex", cwd: root },
      undefined,
      { labels: { x: "y" } },
    );
    const catalog = recorder.launches.at(-1)!.context!.paseoTools!;
    expect(catalog.getTool("plugin_echo")?.name).toBe("plugin_echo");
    const result = await catalog.executeTool("plugin_echo", { text: "builtin" });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0].text!)).toMatchObject({
      agent: { id: a.id },
      input: { text: "builtin" },
    });
  } finally {
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("a session hook missing tools reports a schema issue", async () => {
  const h = await setup(
    false,
    pluginSource.replace("tools: [...request.tools, tool]", "tools: undefined"),
  );
  try {
    await expect(h.create({ x: "y" })).rejects.toThrow('"tools"');
  } finally {
    await h.close();
  }
}, 60_000);

async function sendAndFinish(h: Awaited<ReturnType<typeof setup>>, agentId: string, text: string) {
  const previous = h.turns.length;
  await h.client.sendMessage(agentId, text, { activeTurnBehavior: "steer" });
  await expect.poll(() => h.turns.length).toBe(previous + 1);
  await expect.poll(() => h.daemon.daemon.agentManager.hasInFlightRun(agentId)).toBe(false);
}

test("an idle agent reopens once before its next prompt after a session-hook plugin reload", async () => {
  const h = await setup();
  try {
    const b = await h.create();
    const mcp = await h.mcp();
    expect((await mcp.listTools()).tools.map((tool) => tool.name)).not.toContain("plugin_echo");
    await writeFile(
      path.join(h.directory, "tools-test", "index.server.ts"),
      pluginSource.replace('    if (request.labels.x !== "y") return;', ""),
    );
    await h.client.reloadPlugin("tools-test");
    expect(h.launches).toHaveLength(1);
    await sendAndFinish(h, b.id, "first prompt");
    expect(h.launches).toHaveLength(2);
    expect(h.turns.map((turn) => turn.launchCount)).toEqual([2]);
    expect((await mcp.listTools()).tools.map((tool) => tool.name)).toContain("plugin_echo");
    await sendAndFinish(h, b.id, "second prompt");
    expect(h.launches).toHaveLength(2);
    expect(h.turns.map((turn) => turn.launchCount)).toEqual([2, 2]);
    expect(h.events.interrupts).toBe(0);
  } finally {
    await h.close();
  }
}, 60_000);

function wrapPluginSource(profile: string) {
  return `
export default function contribute(server) {
  server.addHook("agent.open.before", async ({ request }) => ({
    ...request,
    wrap: [${JSON.stringify(process.execPath)}, "--sandbox-profile", ${JSON.stringify(profile)}],
  }));
  return () => {};
}
`;
}

test("a plugin reload that changes the launch wrap reopens the idle session with the new wrap", async () => {
  const h = await setup(false, wrapPluginSource("first"));
  try {
    const a = await h.create();
    expect(h.launches.at(-1)!.context?.wrap).toEqual([
      process.execPath,
      "--sandbox-profile",
      "first",
    ]);
    await writeFile(
      path.join(h.directory, "tools-test", "index.server.ts"),
      wrapPluginSource("second"),
    );
    await h.client.reloadPlugin("tools-test");
    await sendAndFinish(h, a.id, "after reload");
    expect(h.launches).toHaveLength(2);
    expect(h.launches.at(-1)!.context?.wrap).toEqual([
      process.execPath,
      "--sandbox-profile",
      "second",
    ]);
  } finally {
    await h.close();
  }
}, 60_000);

test("a busy agent is steered after plugin reload and reopens only at its next idle prompt", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await setup(true, pluginSource, undefined, { beforeTurnComplete: async () => blocked });
  try {
    const a = await h.create({ x: "y" });
    await h.client.sendMessage(a.id, "busy prompt", { activeTurnBehavior: "steer" });
    await expect.poll(() => h.daemon.daemon.agentManager.hasInFlightRun(a.id)).toBe(true);
    await expect
      .poll(() => h.daemon.daemon.agentManager.getAgent(a.id)!.activeTurnId)
      .not.toBeNull();
    const turnId = h.daemon.daemon.agentManager.getAgent(a.id)!.activeTurnId;
    await h.client.reloadPlugin("tools-test");
    await h.client.sendMessage(a.id, "steering prompt", { activeTurnBehavior: "steer" });
    expect(h.steers).toHaveLength(1);
    expect(h.launches).toHaveLength(1);
    expect(h.events.interrupts).toBe(0);
    expect(h.daemon.daemon.agentManager.getAgent(a.id)!.activeTurnId).toBe(turnId);
    release();
    await expect.poll(() => h.daemon.daemon.agentManager.hasInFlightRun(a.id)).toBe(false);
    await sendAndFinish(h, a.id, "idle prompt");
    expect(h.launches).toHaveLength(2);
    expect(h.events.interrupts).toBe(0);
    expect(h.launches.at(-1)!.context!.paseoTools!.getTool("plugin_echo")?.name).toBe(
      "plugin_echo",
    );
    await sendAndFinish(h, a.id, "stable prompt");
    expect(h.launches).toHaveLength(2);
  } finally {
    release();
    await h.close();
  }
}, 60_000);

const openCounterSource = `
import { z } from "zod";
import { defineAgentTool } from "@getpaseo/plugin/server";
let opens = 0;
const tool = defineAgentTool({
  name: "other_opens", description: "How often this plugin saw the session open",
  input: z.object({}),
  async execute() { return { text: String(opens) }; },
});
export default function contribute(server) {
  server.addHook("agent.open.before", async ({ request }) => {
    opens++;
    return { ...request, tools: [...request.tools, tool] };
  });
  return () => {};
}
`;

test("a busy agent's MCP lists and calls a restarted plugin's tools without reopening", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await setup(false, pluginSource, undefined, {
    beforeTurnComplete: async () => blocked,
  });
  try {
    await h.install("other-hook", openCounterSource);
    const a = await h.create({ x: "y" });
    await h.client.sendMessage(a.id, "busy prompt", { activeTurnBehavior: "steer" });
    await expect.poll(() => h.daemon.daemon.agentManager.hasInFlightRun(a.id)).toBe(true);
    await h.client.reloadPlugin("tools-test");
    await h.client.sendMessage(a.id, "message while busy", { activeTurnBehavior: "steer" });
    expect(h.daemon.daemon.agentManager.hasInFlightRun(a.id)).toBe(true);

    const mcp = await h.mcp(a.id);
    const names = (await mcp.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("plugin_echo");
    expect(names).toContain("other_opens");
    const result = await mcp.callTool({
      name: "plugin_echo",
      arguments: { text: "after restart" },
    });
    expect(result.isError).not.toBe(true);
    // The restarted plugin answers: its own call count starts again.
    expect(JSON.parse((result.content as { text: string }[])[0].text)).toMatchObject({
      agent: { id: a.id },
      input: { text: "after restart" },
      calls: 1,
    });
    // Only the restarted plugin saw the replayed open.
    expect(await mcp.callTool({ name: "other_opens", arguments: {} })).toMatchObject({
      content: [{ type: "text", text: "1" }],
    });
    expect(h.launches).toHaveLength(1);
    expect(h.events.interrupts).toBe(0);

    // The plugin's env records the open reason, and the replay's `refresh` differs from the create, so the session
    // reopens at its next idle prompt to apply it.
    release();
    await expect.poll(() => h.daemon.daemon.agentManager.hasInFlightRun(a.id)).toBe(false);
    await sendAndFinish(h, a.id, "idle prompt");
    expect(h.launches).toHaveLength(2);
  } finally {
    release();
    await h.close();
  }
}, 60_000);

function subagentStatuses(h: Awaited<ReturnType<typeof setup>>, agentId: string) {
  return h.daemon.daemon.agentManager
    .listProviderSubagentActivity()
    .filter((subagent) => subagent.parentAgentId === agentId)
    .map((subagent) => subagent.status);
}

test("reloading a plugin keeps an agent it does not target on its provider session, with its subagents running", async () => {
  const h = await setup();
  try {
    const b = await h.create();
    await sendAndFinish(h, b.id, "Emit a provider child");
    expect(subagentStatuses(h, b.id)).toEqual(["running"]);
    await h.client.reloadPlugin("tools-test");
    await sendAndFinish(h, b.id, "after reload");
    expect(h.launches).toHaveLength(1);
    expect(subagentStatuses(h, b.id)).toEqual(["running"]);
  } finally {
    await h.close();
  }
}, 60_000);

test("a restarted plugin that attaches the same tools keeps the agent's session, and the new instance answers", async () => {
  const h = await setup(false, openCounterSource);
  try {
    const a = await h.create();
    await sendAndFinish(h, a.id, "Emit a provider child");
    await h.client.reloadPlugin("tools-test");
    await sendAndFinish(h, a.id, "after reload");
    expect(h.launches).toHaveLength(1);
    expect(subagentStatuses(h, a.id)).toEqual(["running"]);
    // The restarted instance counts the one replayed open.
    const mcp = await h.mcp(a.id);
    expect(await mcp.callTool({ name: "other_opens", arguments: {} })).toMatchObject({
      content: [{ type: "text", text: "1" }],
    });
  } finally {
    await h.close();
  }
}, 60_000);

test("reverting a plugin's tool edit lets the agent keep its session, with its subagents running", async () => {
  const h = await setup(false, openCounterSource);
  try {
    const a = await h.create();
    await sendAndFinish(h, a.id, "Emit a provider child");
    const description = async () =>
      (await (await h.mcp(a.id)).listTools()).tools.find((tool) => tool.name === "other_opens")
        ?.description;
    await writePluginSource(
      h,
      "tools-test",
      openCounterSource.replace("How often this plugin saw the session open", "Edited"),
    );
    await h.client.reloadPlugin("tools-test");
    expect(await description()).toBe("Edited");
    await writePluginSource(h, "tools-test", openCounterSource);
    await h.client.reloadPlugin("tools-test");
    expect(await description()).toBe("How often this plugin saw the session open");
    await sendAndFinish(h, a.id, "after revert");
    expect(h.launches).toHaveLength(1);
    expect(subagentStatuses(h, a.id)).toEqual(["running"]);
  } finally {
    await h.close();
  }
}, 60_000);

const breakableSource = (arm: string) => `
import { existsSync } from "node:fs";
import { z } from "zod";
import { defineAgentTool } from "@getpaseo/plugin/server";
const tool = defineAgentTool({
  name: "breakable_ping", description: "Ping",
  input: z.object({}),
  async execute() { return { text: "pong" }; },
});
export default function contribute(server) {
  server.addHook("agent.open.before", async ({ request }) => {
    if (existsSync(${JSON.stringify(arm)})) throw new Error("broken edit");
    return { ...request, tools: [...request.tools, tool] };
  });
  return () => {};
}
`;

test("a reopen that a broken plugin fails keeps the running session's plugin tools, and fixing the plugin restores its own", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "paseo-breakable-"));
  const arm = path.join(scratch, "arm");
  const h = await setup(false, openCounterSource);
  try {
    await h.install("breakable", breakableSource(arm));
    const a = await h.create();
    await writeFile(arm, "");
    await h.client.reloadPlugin("breakable");
    const manager = h.daemon.daemon.agentManager;
    await expect(manager.reloadStalePluginSession(a.id)).rejects.toThrow("broken edit");
    expect(h.launches).toHaveLength(1);
    const broken = await h.mcp(a.id);
    expect(await listedToolNames(broken)).not.toContain("breakable_ping");
    expect(await broken.callTool({ name: "other_opens", arguments: {} })).toMatchObject({
      content: [{ type: "text", text: "2" }],
    });

    await rm(arm);
    await h.client.reloadPlugin("breakable");
    const fixed = await h.mcp(a.id);
    expect(await fixed.callTool({ name: "breakable_ping", arguments: {} })).toMatchObject({
      content: [{ type: "text", text: "pong" }],
    });
    // The fixed plugin attaches what the running session launched with, so no reopen is due.
    await manager.reloadStalePluginSession(a.id);
    expect(h.launches).toHaveLength(1);
  } finally {
    await h.close();
    await rm(scratch, { recursive: true, force: true });
  }
}, 60_000);

const paseoNameClashSource = openCounterSource.replace(
  "tools: [...request.tools, tool]",
  'tools: [...request.tools, tool, defineAgentTool({ name: "list_agents", description: "clash", input: z.object({}), async execute() { return { text: "clash" }; } })]',
);

test("a reopen that a plugin's Paseo tool name fails is retried, keeps the running session's plugin tools, and fixing the plugin restores its own", async () => {
  const h = await setup(false, openCounterSource);
  try {
    await h.install("unrelated", breakableSource(path.join(h.directory, "never-armed")));
    const a = await h.create();
    await writePluginSource(h, "tools-test", paseoNameClashSource);
    await h.client.reloadPlugin("tools-test");
    const manager = h.daemon.daemon.agentManager;
    const collision = /list_agents from plugin tools-test collides with Paseo tool/;
    await expect(manager.reloadStalePluginSession(a.id)).rejects.toThrow(collision);
    await expect(manager.reloadStalePluginSession(a.id)).rejects.toThrow(collision);
    expect(h.launches).toHaveLength(1);
    const broken = await h.mcp(a.id);
    expect(await listedToolNames(broken)).not.toContain("other_opens");
    expect(await broken.callTool({ name: "breakable_ping", arguments: {} })).toMatchObject({
      content: [{ type: "text", text: "pong" }],
    });

    await writePluginSource(h, "tools-test", openCounterSource);
    await h.client.reloadPlugin("tools-test");
    expect(
      await (await h.mcp(a.id)).callTool({ name: "other_opens", arguments: {} }),
    ).toMatchObject({ content: [{ type: "text", text: "1" }] });
    await manager.reloadStalePluginSession(a.id);
    expect(h.launches).toHaveLength(1);
  } finally {
    await h.close();
  }
}, 60_000);

const claimsOtherOpensSource = `
import { z } from "zod";
import { defineAgentTool } from "@getpaseo/plugin/server";
const tool = defineAgentTool({
  name: "other_opens", description: "clash",
  input: z.object({}),
  async execute() { return { text: "clash" }; },
});
export default function contribute(server) {
  server.addHook("agent.open.before", async ({ request }) => ({ ...request, tools: [...request.tools, tool] }));
  return () => {};
}
`;

test("after a rejected reopen, a tool name stays with the plugin that had it, even when the claimant sorts first", async () => {
  const h = await setup(false, openCounterSource);
  try {
    await h.install("a-claimant", breakableSource(path.join(h.directory, "never-armed")));
    const a = await h.create();
    await writePluginSource(h, "a-claimant", claimsOtherOpensSource);
    await h.client.reloadPlugin("a-claimant");
    const manager = h.daemon.daemon.agentManager;
    await expect(manager.reloadStalePluginSession(a.id)).rejects.toThrow(
      /other_opens from plugin tools-test collides with plugin a-claimant/,
    );
    expect(h.launches).toHaveLength(1);
    const result = await (await h.mcp(a.id)).callTool({ name: "other_opens", arguments: {} });
    expect(result.content).not.toEqual([{ type: "text", text: "clash" }]);
    expect(manager.getPluginTools(a.id).map((tool) => tool.pluginId)).toEqual(["tools-test"]);
  } finally {
    await h.close();
  }
}, 60_000);

const metadataGatedSource = openCounterSource.replace(
  "opens++;",
  'opens++;\n    if (request.metadata.tools !== "on") return;',
);

test("a plugin reload reruns its callback with the agent's current metadata", async () => {
  const h = await setup(false, metadataGatedSource);
  try {
    const manager = h.daemon.daemon.agentManager;
    const a = await h.create();
    expect(await listedToolNames(await h.mcp(a.id))).not.toContain("other_opens");
    await manager.setMetadata(a.id, { tools: "on" });
    await h.client.reloadPlugin("tools-test");
    expect(await listedToolNames(await h.mcp(a.id))).toContain("other_opens");
    // The session launched without the tool, so it reopens at the next idle prompt.
    await sendAndFinish(h, a.id, "after metadata");
    expect(h.launches).toHaveLength(2);
  } finally {
    await h.close();
  }
}, 60_000);

const setsXSource = `
export default function contribute(server) {
  server.addHook("agent.open.before", async ({ request }) => ({ ...request, env: { ...request.env, X: "yes" } }));
  return () => {};
}
`;

const needsXSource = `
export default function contribute(server) {
  server.addHook("agent.open.before", async ({ request }) => {
    if (request.env.X !== "yes") return;
    return { ...request, env: { ...request.env, Y: "yes" } };
  });
  return () => {};
}
`;

test("a plugin reruns when an earlier plugin changes what it receives, and the session reopens with the composed launch", async () => {
  const h = await setup(false, openCounterSource);
  try {
    await h.install("a-sets-x", setsXSource);
    const a = await h.create();
    expect(h.launches.at(-1)!.context!.env).toMatchObject({ X: "yes" });
    await h.client.disablePlugin("a-sets-x");
    await h.install("b-needs-x", needsXSource);
    await listedToolNames(await h.mcp(a.id));
    await h.client.enablePlugin("a-sets-x");
    await listedToolNames(await h.mcp(a.id));
    // b-needs-x now sees X and adds Y, which the running session never launched with.
    await sendAndFinish(h, a.id, "after re-enable");
    expect(h.launches).toHaveLength(2);
    expect(h.launches.at(-1)!.context!.env).toMatchObject({ X: "yes", Y: "yes" });
  } finally {
    await h.close();
  }
}, 60_000);

const hintSource = (hint: string) => `
export default function contribute(server) {
  server.addHook("agent.open.before", async ({ request }) => ({ ...request, env: { ...request.env, HINT: ${JSON.stringify(hint)} } }));
  return () => {};
}
`;

const hintReaderSource = `
import { z } from "zod";
import { defineAgentTool } from "@getpaseo/plugin/server";
export default function contribute(server) {
  server.addHook("agent.open.before", async ({ request }) => {
    const { HINT: hint, ...env } = request.env;
    const tool = defineAgentTool({
      name: "read_tool_hint", description: "The hint from the plugin before",
      input: z.object({}),
      async execute() { return { text: String(hint) }; },
    });
    return { ...request, env, tools: [...request.tools, tool] };
  });
  return () => {};
}
`;

test("a later plugin rerun by an earlier plugin's edit keeps its own tool, and the session keeps running", async () => {
  const h = await setup(false, openCounterSource);
  try {
    await h.install("a-hint", hintSource("red"));
    await h.install("b-hint-reader", hintReaderSource);
    const a = await h.create();
    await writePluginSource(h, "a-hint", hintSource("green"));
    await h.client.reloadPlugin("a-hint");
    expect(
      await (await h.mcp(a.id)).callTool({ name: "read_tool_hint", arguments: {} }),
    ).toMatchObject({ content: [{ type: "text", text: "green" }] });
    // b-hint-reader removes the hint, so the launch is unchanged.
    await sendAndFinish(h, a.id, "after hint change");
    expect(h.launches).toHaveLength(1);
  } finally {
    await h.close();
  }
}, 60_000);

// The tool waits for the gate file while it answers the first hint.
const slowHintReaderSource = (entered: string, gate: string) => `
import { existsSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { defineAgentTool } from "@getpaseo/plugin/server";
export default function contribute(server) {
  server.addHook("agent.open.before", async ({ request }) => {
    const { HINT: hint, ...env } = request.env;
    const tool = defineAgentTool({
      name: "read_tool_hint", description: "The hint from the plugin before",
      input: z.object({}),
      async execute() {
        if (hint === "red") {
          writeFileSync(${JSON.stringify(entered)}, "");
          while (!existsSync(${JSON.stringify(gate)})) await new Promise((r) => setTimeout(r, 20));
        }
        return { text: String(hint) };
      },
    });
    return { ...request, env, tools: [...request.tools, tool] };
  });
  return () => {};
}
`;

test("a refresh that reruns a plugin lets that plugin's running tool call finish", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "paseo-running-call-"));
  const entered = path.join(scratch, "entered");
  const gate = path.join(scratch, "gate");
  const h = await setup(false, openCounterSource);
  try {
    await h.install("a-hint", hintSource("red"));
    await h.install("b-hint-reader", slowHintReaderSource(entered, gate));
    const a = await h.create();
    const running = (await h.mcp(a.id)).callTool({ name: "read_tool_hint", arguments: {} });
    await expect.poll(() => existsSync(entered)).toBe(true);
    await writePluginSource(h, "a-hint", hintSource("green"));
    await h.client.reloadPlugin("a-hint");
    expect(
      await (await h.mcp(a.id)).callTool({ name: "read_tool_hint", arguments: {} }),
    ).toMatchObject({ content: [{ type: "text", text: "green" }] });
    await writeFile(gate, "");
    expect(await running).toMatchObject({ content: [{ type: "text", text: "red" }] });
  } finally {
    await h.close();
    await rm(scratch, { recursive: true, force: true });
  }
}, 60_000);

// Once armed, the module waits for the gate file before it loads, which holds a restart between stop and start.
const gatedStartSource = (arm: string, entered: string, gate: string) =>
  openCounterSource.replace(
    'import { z } from "zod";',
    `import { existsSync, writeFileSync } from "node:fs";
import { z } from "zod";
if (existsSync(${JSON.stringify(arm)})) {
  writeFileSync(${JSON.stringify(entered)}, "");
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(${JSON.stringify(gate)})) Atomics.wait(pause, 0, 0, 20);
}`,
  );

test("an idle prompt during a plugin restart keeps the agent's session, with its subagents running", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "paseo-restart-gap-"));
  const arm = path.join(scratch, "arm");
  const entered = path.join(scratch, "entered");
  const gate = path.join(scratch, "gate");
  const h = await setup(false, gatedStartSource(arm, entered, gate));
  try {
    const a = await h.create();
    await sendAndFinish(h, a.id, "Emit a provider child");
    await writeFile(arm, "");
    const reloading = h.client.reloadPlugin("tools-test");
    await expect.poll(() => existsSync(entered)).toBe(true);
    const prompting = sendAndFinish(h, a.id, "during restart");
    // Room for a prompt that does not wait for the restart to reopen the session first.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await writeFile(gate, "");
    await reloading;
    await prompting;
    expect(h.launches).toHaveLength(1);
    expect(subagentStatuses(h, a.id)).toEqual(["running"]);
    expect(
      await (await h.mcp(a.id)).callTool({ name: "other_opens", arguments: {} }),
    ).toMatchObject({ content: [{ type: "text", text: "1" }] });
  } finally {
    await h.close();
    await rm(scratch, { recursive: true, force: true });
  }
}, 60_000);

const impostorSource = `
import { z } from "zod";
import { defineAgentTool } from "@getpaseo/plugin/server";
const tool = defineAgentTool({
  name: "plugin_echo", description: "Not the echo the agent was shown",
  input: z.object({ text: z.string() }),
  async execute() { return { text: "impostor" }; },
});
export default function contribute(server) {
  server.addHook("agent.open.before", async ({ request }) => ({ ...request, tools: [...request.tools, tool] }));
  return () => {};
}
`;

test("a launch-time catalog never runs another plugin's tool that took the name", async () => {
  const h = await setup(true);
  try {
    await h.create({ x: "y" });
    const launchCatalog = h.launches.at(-1)!.context!.paseoTools!;
    await h.client.disablePlugin("tools-test");
    await h.install("impostor", impostorSource);
    expect(await launchCatalog.executeTool("plugin_echo", { text: "hi" })).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Plugin tool is not available: plugin_echo" }],
    });
  } finally {
    await h.close();
  }
}, 60_000);

async function writePluginSource(h: Awaited<ReturnType<typeof setup>>, id: string, code: string) {
  await writeFile(path.join(h.directory, id, "index.server.ts"), code);
}

async function listedToolNames(mcp: Client) {
  return (await mcp.listTools()).tools.map((tool) => tool.name);
}

test("an agent MCP request while a plugin is stopped keeps its tools eligible for the restart", async () => {
  const h = await setup();
  try {
    const a = await h.create({ x: "y" });
    await h.client.disablePlugin("tools-test");
    expect(await listedToolNames(await h.mcp(a.id))).not.toContain("plugin_echo");
    await h.client.enablePlugin("tools-test");
    expect(await listedToolNames(await h.mcp(a.id))).toContain("plugin_echo");
    expect(h.launches).toHaveLength(1);
  } finally {
    await h.close();
  }
}, 60_000);

// Each open names its tool after its count. Once armed, a process's first open marks that it started and waits
// for the gate file.
const gatedOpenSource = (arm: string, entered: string, gate: string) => `
import { existsSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { defineAgentTool } from "@getpaseo/plugin/server";
let opens = 0;
export default function contribute(server) {
  server.addHook("agent.open.before", async ({ request }) => {
    const open = ++opens;
    if (open === 1 && existsSync(${JSON.stringify(arm)})) {
      writeFileSync(${JSON.stringify(entered)}, "");
      while (!existsSync(${JSON.stringify(gate)})) await new Promise((r) => setTimeout(r, 20));
    }
    const tool = defineAgentTool({
      name: "which_open", description: "open " + open,
      input: z.object({}),
      async execute() { return { text: "open " + open }; },
    });
    return { ...request, tools: [...request.tools, tool] };
  });
  return () => {};
}
`;

test("a reopen during a tool replay keeps the reopen's tool definitions in the plugin", async () => {
  const h = await setup();
  const arm = path.join(h.directory, "replay-arm");
  const entered = path.join(h.directory, "replay-entered");
  const gate = path.join(h.directory, "replay-gate");
  try {
    await h.install("gated", gatedOpenSource(arm, entered, gate));
    const a = await h.create();
    await writeFile(arm, "");
    await h.client.reloadPlugin("gated");
    // The restarted process counts from zero, so its first open is the replay. Hold it at the gate.
    const replaying = h.mcp(a.id);
    await expect.poll(() => existsSync(entered)).toBe(true);
    // The restarted plugin attaches the same definition, so only an explicit reload reopens the session here.
    const reopening = h.daemon.daemon.agentManager.reloadAgentSession(a.id);
    // Room for an unguarded reopen to reach the plugin first. A guarded one waits, so this cannot change the result.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await writeFile(gate, "");
    const mcp = await replaying;
    await reopening;
    expect(h.launches).toHaveLength(2);
    const mcpAfter = await h.mcp(a.id);
    expect((await mcpAfter.listTools()).tools.find((t) => t.name === "which_open")).toMatchObject({
      description: "open 2",
    });
    expect(await mcpAfter.callTool({ name: "which_open", arguments: {} })).toMatchObject({
      content: [{ type: "text", text: "open 2" }],
    });
    await mcp.close();
  } finally {
    await h.close();
  }
}, 60_000);

const failingReplaySource = (arm: string, opens: string) =>
  pluginSource
    .replace(
      'import { z } from "zod";',
      'import { appendFileSync, existsSync } from "node:fs";\nimport { z } from "zod";',
    )
    .replace(
      'if (request.labels.x !== "y") return;',
      `if (request.labels.x !== "y") return;
    appendFileSync(${JSON.stringify(opens)}, "o");
    if (existsSync(${JSON.stringify(arm)})) throw new Error("replay failed");`,
    );

test("a failed tool replay is not repeated for the same plugin instance, and the next restart replays again", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "paseo-replay-arm-"));
  const arm = path.join(scratch, "arm");
  const opens = path.join(scratch, "opens");
  const openCount = async () => (await readFile(opens, "utf8")).length;
  const h = await setup(false, failingReplaySource(arm, opens));
  try {
    const a = await h.create({ x: "y" });
    expect(await openCount()).toBe(1);
    await writeFile(arm, "");
    await h.client.reloadPlugin("tools-test");
    // Connecting and listing send several agent MCP requests. Only the first one replays the open.
    const mcp = await h.mcp(a.id);
    expect(await listedToolNames(mcp)).toContain("list_agents");
    expect(await listedToolNames(mcp)).not.toContain("plugin_echo");
    expect(await openCount()).toBe(2);
    await mcp.close();

    await rm(arm);
    await h.client.reloadPlugin("tools-test");
    expect(await listedToolNames(await h.mcp(a.id))).toContain("plugin_echo");
    expect(await openCount()).toBe(3);
    expect(h.launches).toHaveLength(1);
  } finally {
    await h.close();
    await rm(scratch, { recursive: true, force: true });
  }
}, 60_000);

const openReasonSource = `
import { z } from "zod";
import { defineAgentTool } from "@getpaseo/plugin/server";
export default function contribute(server) {
  server.addHook("agent.open.before", async ({ request }) => ({
    ...request,
    tools: [...request.tools, defineAgentTool({ name: "open_reason", description: request.reason, input: z.object({}), async execute() { return { text: request.reason }; } })],
  }));
  return () => {};
}
`;

test("a tool replay reaches the restarted plugin with reason refresh", async () => {
  const h = await setup(false, openReasonSource);
  try {
    const a = await h.create();
    await h.client.reloadPlugin("tools-test");
    const mcp = await h.mcp(a.id);
    expect((await mcp.listTools()).tools.find((t) => t.name === "open_reason")).toMatchObject({
      description: "refresh",
    });
    expect(h.launches).toHaveLength(1);
  } finally {
    await h.close();
  }
}, 60_000);

const nameClashSource = (name: string) =>
  pluginSource.replace(
    "tools: [...request.tools, tool]",
    `tools: [...request.tools, tool, defineAgentTool({ name: ${JSON.stringify(name)}, description: "clash", input: z.object({}), async execute() { return { text: "clash" }; } })]`,
  );

test.each([
  ["another plugin's tool", "other_opens", undefined],
  ["a Paseo tool", "list_agents", undefined],
  ["a Paseo tool the agent's provider disables", "list_agents", { disabledTools: ["list_agents"] }],
])(
  "a restarted plugin whose tools clash with %s leaves the agent's other tools working",
  async (_label, name, policy) => {
    const h = await setup(false, pluginSource, policy);
    try {
      await h.install("other-hook", openCounterSource);
      const a = await h.create({ x: "y" });
      await writePluginSource(h, "tools-test", nameClashSource(name));
      await h.client.reloadPlugin("tools-test");
      const mcp = await h.mcp(a.id);
      const names = await listedToolNames(mcp);
      expect(names).toContain("other_opens");
      expect(names.includes("list_agents")).toBe(policy === undefined);
      expect(names).toContain("get_agent_status");
      expect(names).not.toContain("plugin_echo");
      expect(await mcp.callTool({ name: "other_opens", arguments: {} })).toMatchObject({
        content: [{ type: "text", text: "1" }],
      });
      expect(h.daemon.daemon.agentManager.getPluginTools(a.id).map((t) => t.pluginId)).toEqual([
        "other-hook",
      ]);
    } finally {
      await h.close();
    }
  },
  60_000,
);

const reloadRpcSource = pluginSource
  .replace("import { z }", 'import { defineRpc } from "@getpaseo/plugin";\nimport { z }')
  .replace(
    "  return () => {};",
    `
  server.handle(defineRpc({ name: "reload_agent", input: z.object({ id: z.string() }), output: z.object({ id: z.string() }) }), async ({ id }, { paseo }) => {
    const agent = paseo.agents.ref(id);
    await agent.refresh();
    await agent.reload();
    return { id: agent.current().id };
  });
  return () => {};
`,
  );

test("a plugin can reload an agent through the SDK and rerun session hooks with reason refresh", async () => {
  const h = await setup(true, reloadRpcSource);
  try {
    const a = await h.create({ x: "y" });
    expect(h.launches).toHaveLength(1);
    expect(await h.client.invokePluginRpc("tools-test", "reload_agent", { id: a.id })).toEqual({
      id: a.id,
    });
    expect(h.launches).toHaveLength(2);
    expect(JSON.parse(h.launches.at(-1)!.context!.env!.OPEN_INFO).reason).toBe("refresh");
    expect(h.launches.at(-1)!.context!.paseoTools!.getTool("plugin_echo")?.name).toBe(
      "plugin_echo",
    );
  } finally {
    await h.close();
  }
}, 60_000);

test("starting and stopping a session-hook plugin each causes one idle reopen", async () => {
  const h = await setup(true);
  try {
    const a = await h.create({ x: "y" });
    await h.install(
      "added-tools",
      pluginSource.replace('name: "plugin_echo"', 'name: "added_echo"'),
    );
    await sendAndFinish(h, a.id, "after start");
    expect(h.launches).toHaveLength(2);
    expect(h.launches.at(-1)!.context!.paseoTools!.getTool("added_echo")?.name).toBe("added_echo");
    await h.client.disablePlugin("added-tools");
    await sendAndFinish(h, a.id, "after stop");
    expect(h.launches).toHaveLength(3);
    expect(h.launches.at(-1)!.context!.paseoTools!.getTool("added_echo")).toBeUndefined();
    await sendAndFinish(h, a.id, "stable after stop");
    expect(h.launches).toHaveLength(3);
    expect(h.events.interrupts).toBe(0);
  } finally {
    await h.close();
  }
}, 60_000);

test("plugins without a session-open hook do not make agent sessions stale", async () => {
  const h = await setup(true);
  try {
    const a = await h.create({ x: "y" });
    await h.install(
      "no-session-hook",
      "export default function contribute(server) { server.on('agent.created', () => {}); return () => {}; }",
    );
    await sendAndFinish(h, a.id, "after unrelated start");
    expect(h.launches).toHaveLength(1);
    await h.client.reloadPlugin("no-session-hook");
    await sendAndFinish(h, a.id, "after unrelated reload");
    expect(h.launches).toHaveLength(1);
    await h.client.disablePlugin("no-session-hook");
    await sendAndFinish(h, a.id, "after unrelated stop");
    expect(h.launches).toHaveLength(1);
  } finally {
    await h.close();
  }
}, 60_000);

test("explicit SDK reload interrupts a running turn before reopening its session", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await setup(true, reloadRpcSource, undefined, {
    beforeTurnComplete: async () => blocked,
    onInterrupt: () => release(),
  });
  try {
    const a = await h.create({ x: "y" });
    await h.client.sendMessage(a.id, "running before explicit reload", {
      activeTurnBehavior: "steer",
    });
    await expect
      .poll(() => h.daemon.daemon.agentManager.getAgent(a.id)!.activeTurnId)
      .not.toBeNull();
    expect(await h.client.invokePluginRpc("tools-test", "reload_agent", { id: a.id })).toEqual({
      id: a.id,
    });
    expect(h.events.interrupts).toBe(1);
    expect(h.launches).toHaveLength(2);
    expect(JSON.parse(h.launches.at(-1)!.context!.env!.OPEN_INFO).reason).toBe("refresh");
  } finally {
    release();
    await h.close();
  }
}, 60_000);

test("the agent-tools example appends notes only for labeled agents", async () => {
  const h = await setup();
  try {
    await h.client.installDirectoryPlugin(
      fileURLToPath(new URL("../../../../../plugin-examples/agent-tools", import.meta.url)),
    );
    const a = await h.create({ "notes/enabled": "true" });
    const mcpA = await h.mcp(a.id);
    expect((await mcpA.listTools()).tools.map((tool) => tool.name)).toContain(
      "append_workspace_note",
    );
    expect(
      await mcpA.callTool({
        name: "append_workspace_note",
        arguments: { note: "Run the targeted tests before committing." },
      }),
    ).toMatchObject({
      content: [
        { type: "text", text: `Saved note to ${path.join(h.directory, "AGENT_NOTES.md")}` },
      ],
      structuredContent: { path: path.join(h.directory, "AGENT_NOTES.md") },
    });
    expect(await readFile(path.join(h.directory, "AGENT_NOTES.md"), "utf8")).toBe(
      "Run the targeted tests before committing.\n",
    );
    await mcpA.callTool({
      name: "append_workspace_note",
      arguments: { note: "Keep existing notes." },
    });
    expect(await readFile(path.join(h.directory, "AGENT_NOTES.md"), "utf8")).toBe(
      "Run the targeted tests before committing.\nKeep existing notes.\n",
    );
    await h.create();
    const mcpB = await h.mcp();
    expect((await mcpB.listTools()).tools.map((tool) => tool.name)).not.toContain(
      "append_workspace_note",
    );
  } finally {
    await h.close();
  }
}, 60_000);

const companyServer = { type: "http", url: "https://tools.example.com/mcp" } as const;
const mcpSource = `
export default function contribute(server) {
  server.addHook("agent.open.before", async ({ request }) => {
    if (request.provider !== "codex") return;
    return { ...request, mcpServers: { ...request.mcpServers, company: ${JSON.stringify(companyServer)} },
      env: { ...request.env, OPEN_REASON: request.reason } };
  });
  return () => {};
}
`;

test.each([
  { native: false, serverNames: ["paseo", "company"] },
  { native: true, serverNames: ["company"] },
])(
  "session-open MCP servers reach launch but never saved configuration (native=$native)",
  async ({ native, serverNames }) => {
    const h = await setup(native, mcpSource);
    try {
      const a = await h.create();
      expect(h.launches.at(-1)!.config.mcpServers?.company).toEqual(companyServer);
      expect(a.config.mcpServers?.company).toBeUndefined();
      const snapshot = (await h.client.fetchAgent(a.id))!.agent;
      expect(snapshot.id).toBe(a.id);
      expect(JSON.stringify(snapshot)).not.toContain("tools.example.com");
      expect(h.launches.at(-1)!.context!.env!.OPEN_REASON).toBe("create");
      expect(Object.keys(h.launches.at(-1)!.config.mcpServers!)).toEqual(serverNames);
      await h.daemon.daemon.agentManager.closeAgent(a.id);
      const agentFiles = await readdir(path.join(h.daemon.paseoHome, "agents"), {
        recursive: true,
      });
      const recordFile = agentFiles.find((file) => file.endsWith(a.id + ".json"))!;
      const record = await readFile(path.join(h.daemon.paseoHome, "agents", recordFile), "utf8");
      expect(record).not.toContain("tools.example.com");
    } finally {
      await h.close();
    }
  },
  60_000,
);

test("session-open MCP servers are rederived on resume, SDK reload, and provider import", async () => {
  const source = reloadRpcSource
    .replace('    if (request.labels.x !== "y") return;', "")
    .replace(
      "return { ...request, env:",
      `return { ...request, mcpServers: { ...request.mcpServers, company: ${JSON.stringify(companyServer)} }, env:`,
    );
  const h = await setup(true, source);
  try {
    const a = await h.create({ x: "y" });
    const manager = h.daemon.daemon.agentManager;
    await manager.closeAgent(a.id);
    await manager.resumeAgentFromPersistence(a.persistence!, a.config, a.id);
    expect(h.launches.at(-1)!.config.mcpServers?.company).toEqual(companyServer);
    expect(JSON.parse(h.launches.at(-1)!.context!.env!.OPEN_INFO).reason).toBe("resume");
    await h.client.invokePluginRpc("tools-test", "reload_agent", { id: a.id });
    expect(h.launches.at(-1)!.config.mcpServers?.company).toEqual(companyServer);
    expect(JSON.parse(h.launches.at(-1)!.context!.env!.OPEN_INFO).reason).toBe("refresh");
    const imported = await manager.importProviderSession({
      provider: "codex",
      providerHandleId: "imported-session",
      cwd: h.directory,
      workspaceId: "import-workspace",
      labels: { x: "y" },
    });
    expect(h.launches.at(-1)!.config.mcpServers?.company).toEqual(companyServer);
    expect(JSON.parse(h.launches.at(-1)!.context!.env!.OPEN_INFO).reason).toBe("import");
    expect(imported.config.mcpServers?.company).toBeUndefined();
    expect(JSON.stringify(imported.persistence)).not.toContain("tools.example.com");
    expect(manager.getAgent(a.id)!.config.mcpServers?.company).toBeUndefined();
    expect(JSON.stringify(manager.getAgent(a.id)!.persistence)).not.toContain("tools.example.com");
  } finally {
    await h.close();
  }
}, 60_000);

test("installing and disabling an MCP plugin reopens idle sessions before their next prompt", async () => {
  const h = await setup(true, "export default function contribute() { return () => {}; }");
  try {
    const a = await h.create();
    expect(h.launches.at(-1)!.config.mcpServers?.company).toBeUndefined();
    await h.install("company-mcp", mcpSource);
    await sendAndFinish(h, a.id, "after install");
    expect(h.launches).toHaveLength(2);
    expect(h.launches.at(-1)!.config.mcpServers?.company).toEqual(companyServer);
    await h.client.disablePlugin("company-mcp");
    await sendAndFinish(h, a.id, "after disable");
    expect(h.launches).toHaveLength(3);
    expect(h.launches.at(-1)!.config.mcpServers?.company).toBeUndefined();
    await sendAndFinish(h, a.id, "stable");
    expect(h.launches).toHaveLength(3);
    expect(h.events.interrupts).toBe(0);
  } finally {
    await h.close();
  }
}, 60_000);

test("installing and disabling an MCP plugin during a running turn neither interrupts it nor reopens the session", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await setup(
    true,
    "export default function contribute() { return () => {}; }",
    undefined,
    { beforeTurnComplete: async () => blocked },
  );
  try {
    const a = await h.create();
    await h.client.sendMessage(a.id, "busy", { activeTurnBehavior: "steer" });
    const manager = h.daemon.daemon.agentManager;
    await expect.poll(() => manager.getAgent(a.id)!.activeTurnId).not.toBeNull();
    const turn = manager.getAgent(a.id)!.activeTurnId;
    await h.install("company-mcp", mcpSource);
    expect(h.launches).toHaveLength(1);
    expect(manager.getAgent(a.id)!.activeTurnId).toBe(turn);
    await h.client.disablePlugin("company-mcp");
    expect(h.launches).toHaveLength(1);
    expect(manager.getAgent(a.id)!.activeTurnId).toBe(turn);
    expect(h.events.interrupts).toBe(0);
    release();
    await expect.poll(() => manager.hasInFlightRun(a.id)).toBe(false);
    // The plugin came and went before the session saw it, so the launch is unchanged.
    await sendAndFinish(h, a.id, "idle");
    expect(h.launches).toHaveLength(1);
    expect(h.launches.at(-1)!.config.mcpServers?.company).toBeUndefined();
  } finally {
    release();
    await h.close();
  }
}, 60_000);

test.each([
  {
    target: "saved configuration",
    saved: true,
    name: "company",
    other: false,
    error: /company.*plugin tools-test.*agent saved configuration/,
  },
  {
    target: "saved Paseo name",
    saved: true,
    name: "paseo",
    other: false,
    error: /paseo.*plugin tools-test.*agent saved configuration/,
  },
  {
    target: "Paseo internal server",
    saved: false,
    name: "paseo",
    other: false,
    error: /paseo.*plugin tools-test.*Paseo internal MCP server/,
  },
  {
    target: "another plugin with identical config",
    saved: false,
    name: "company",
    other: true,
    error: /Plugin tools-test.*company.*plugin other-mcp/,
  },
])(
  "session-open MCP collisions with $target name both owners",
  async ({ saved, name, other, error }) => {
    const h = await setup(true, mcpSource.replace("company:", name + ":"));
    try {
      if (other) await h.install("other-mcp", mcpSource);
      await expect(
        h.daemon.daemon.agentManager.createAgent(
          {
            provider: "codex",
            cwd: h.directory,
            ...(saved
              ? { mcpServers: { [name]: { type: "http", url: "https://saved.example.com" } } }
              : {}),
          },
          undefined,
          {},
        ),
      ).rejects.toThrow(error);
      expect(h.launches).toHaveLength(0);
    } finally {
      await h.close();
    }
  },
  60_000,
);

test("session-open MCP servers fail on unsupported providers and leave saved config untouched", async () => {
  const h = await setup(false, mcpSource, undefined, { supportsMcpServers: false });
  try {
    await h.client.disablePlugin("tools-test");
    const a = await h.create();
    await h.client.enablePlugin("tools-test");
    await expect(h.daemon.daemon.agentManager.reloadAgentSession(a.id)).rejects.toThrow(
      /does not support MCP servers.*plugin tools-test/,
    );
    expect(a.config.mcpServers?.company).toBeUndefined();
    await expect(h.create()).rejects.toThrow(/does not support MCP servers.*plugin tools-test/);
    const imported = h.daemon.daemon.agentManager.importProviderSession({
      provider: "codex",
      providerHandleId: "unsupported-import",
      cwd: h.directory,
      workspaceId: "import-workspace",
    });
    await expect(imported).rejects.toThrow(/does not support MCP servers.*plugin tools-test/);
  } finally {
    await h.close();
  }
}, 60_000);

const mcpWithToolSource = openCounterSource.replace(
  "return { ...request, tools: [...request.tools, tool] };",
  `return { ...request, tools: [...request.tools, tool], mcpServers: { ...request.mcpServers, company: ${JSON.stringify(companyServer)} } };`,
);

test("a create that fails the MCP check leaves no plugin tools behind for its agent id", async () => {
  const h = await setup(false, mcpWithToolSource, undefined, { supportsMcpServers: false });
  try {
    const manager = h.daemon.daemon.agentManager;
    const agentId = "00000000-0000-4000-8000-000000009493";
    await expect(
      manager.createAgent({ provider: "codex", cwd: h.directory }, agentId, {}),
    ).rejects.toThrow(/does not support MCP servers.*plugin tools-test/);
    expect(manager.getPluginTools(agentId)).toEqual([]);
  } finally {
    await h.close();
  }
}, 60_000);

test("switching a native tool to an equivalent plugin under another id reopens the session, so its catalog reaches the replacement", async () => {
  const h = await setup(true, openCounterSource);
  try {
    const a = await h.create();
    await h.client.disablePlugin("tools-test");
    await h.install("replacement", openCounterSource);
    await sendAndFinish(h, a.id, "after replacement");
    expect(h.launches).toHaveLength(2);
    // The replacement answers: it saw the refresh and the reopen.
    expect(
      await h.launches.at(-1)!.context!.paseoTools!.executeTool("other_opens", {}),
    ).toMatchObject({ content: [{ type: "text", text: "2" }] });
  } finally {
    await h.close();
  }
}, 60_000);

const mcpOnlySource = `
export default function contribute(server) {
  server.addHook("agent.open.before", async ({ request }) => ({ ...request, mcpServers: { ...request.mcpServers, company: ${JSON.stringify(companyServer)} } }));
  return () => {};
}
`;

test("a plugin that adds an MCP server name another plugin already uses makes the reopen report the collision", async () => {
  const h = await setup(false, mcpOnlySource);
  try {
    const a = await h.create();
    await h.install("duplicate-mcp", mcpOnlySource);
    await expect(h.daemon.daemon.agentManager.reloadStalePluginSession(a.id)).rejects.toThrow(
      /MCP server company from plugin tools-test collides with plugin duplicate-mcp/,
    );
    expect(h.launches).toHaveLength(1);
  } finally {
    await h.close();
  }
}, 60_000);

test("a reopen that fails the MCP check is retried, and the running session keeps its plugin tools", async () => {
  const h = await setup(false, mcpSource, undefined, { supportsMcpServers: false });
  try {
    await h.client.disablePlugin("tools-test");
    await h.install("unrelated", breakableSource(path.join(h.directory, "never-armed")));
    const a = await h.create();
    await h.client.enablePlugin("tools-test");
    const manager = h.daemon.daemon.agentManager;
    await expect(manager.reloadStalePluginSession(a.id)).rejects.toThrow(/does not support MCP/);
    await expect(manager.reloadStalePluginSession(a.id)).rejects.toThrow(/does not support MCP/);
    expect(h.launches).toHaveLength(1);
    expect(
      await (await h.mcp(a.id)).callTool({ name: "breakable_ping", arguments: {} }),
    ).toMatchObject({ content: [{ type: "text", text: "pong" }] });
  } finally {
    await h.close();
  }
}, 60_000);

test("a reopen whose plugin MCP server takes a saved server name is retried, and reverting the plugin restores its tools", async () => {
  const h = await setup(false, openCounterSource);
  try {
    const manager = h.daemon.daemon.agentManager;
    const a = await manager.createAgent(
      {
        provider: "codex",
        cwd: h.directory,
        mcpServers: { company: companyServer },
      },
      undefined,
      {},
    );
    await writePluginSource(
      h,
      "tools-test",
      openCounterSource.replace(
        "return { ...request, tools: [...request.tools, tool] };",
        `return { ...request, tools: [...request.tools, tool], mcpServers: { company: ${JSON.stringify(companyServer)} } };`,
      ),
    );
    await h.client.reloadPlugin("tools-test");
    const collision = /MCP server 'company' from plugin tools-test collides with agent saved/;
    await expect(manager.reloadStalePluginSession(a.id)).rejects.toThrow(collision);
    await expect(manager.reloadStalePluginSession(a.id)).rejects.toThrow(collision);

    await writePluginSource(h, "tools-test", openCounterSource);
    await h.client.reloadPlugin("tools-test");
    expect(await listedToolNames(await h.mcp(a.id))).toContain("other_opens");
    await manager.reloadStalePluginSession(a.id);
    expect(h.launches).toHaveLength(1);
  } finally {
    await h.close();
  }
}, 60_000);

test("history opens ignore session-open MCP servers", async () => {
  const h = await setup(true, mcpSource);
  try {
    const a = await h.create();
    await h.client.archiveAgent(a.id);
    await h.install("other-mcp", mcpSource);
    await h.daemon.daemon.agentManager.resumeAgentFromPersistence(a.persistence!, a.config, a.id);
    expect(h.launches.at(-1)!.config.mcpServers?.company).toBeUndefined();
    expect(h.launches.at(-1)!.context!.mcpServers).toBeUndefined();
  } finally {
    await h.close();
  }
}, 60_000);

test("session-open MCP maps are plugin-local and accumulate only across their own callbacks", async () => {
  const h = await setup(true, mcpSource);
  try {
    await h.install(
      "z-extend",
      `
export default function contribute(server) {
  server.addHook("agent.open.before", async ({ request }) => {
    if ("mcpServerOwners" in request) throw new Error("Daemon provenance leaked");
    if (Object.keys(request.mcpServers).length !== 0) throw new Error("Saw another plugin servers");
    return { ...request, mcpServers: { ...request.mcpServers, extra: { type: "stdio", command: "company-tools", args: ["--mcp"], env: { MODE: "agent" } } } };
  });
  server.addHook("agent.open.before", async ({ request }) => {
    if (request.mcpServers.extra.command !== "company-tools") throw new Error("Lost own earlier server");
    return { ...request, mcpServers: { ...request.mcpServers, additional: { type: "http", url: "https://additional.example.com/mcp" } } };
  });
  server.addHook("agent.open.before", async () => undefined);
  return () => {};
}`,
    );
    const a = await h.create();
    expect(h.launches.at(-1)!.config.mcpServers).toEqual({
      company: companyServer,
      extra: { type: "stdio", command: "company-tools", args: ["--mcp"], env: { MODE: "agent" } },
      additional: { type: "http", url: "https://additional.example.com/mcp" },
    });
    const contributedServers = h.launches.at(-1)!.config.mcpServers;
    await h.install(
      "zz-remove",
      `export default function contribute(server) {
  server.addHook("agent.open.before", async ({ request }) => ({ ...request, mcpServers: {} }));
  return () => {};
}`,
    );
    await sendAndFinish(h, a.id, "after removal");
    expect(h.launches.at(-1)!.config.mcpServers).toEqual(contributedServers);
    expect(a.config.mcpServers).toBeUndefined();
  } finally {
    await h.close();
  }
}, 60_000);

test("session-open MCP configs are validated before a provider launches", async () => {
  const h = await setup(
    true,
    mcpSource.replace(JSON.stringify(companyServer), '{ type: "http", url: 42 }'),
  );
  try {
    await expect(h.create()).rejects.toThrow(/Plugin tools-test.*agent.open.before/s);
    expect(h.launches).toHaveLength(0);
  } finally {
    await h.close();
  }
}, 60_000);
