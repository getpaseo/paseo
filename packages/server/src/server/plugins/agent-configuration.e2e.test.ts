import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { expect, test } from "vitest";
import { DaemonClient } from "../test-utils/daemon-client.js";
import type { AgentClient, AgentSessionConfig } from "../agent/agent-sdk-types.js";
import { ClaudeAgentClient } from "../agent/providers/claude/agent.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

test("the configuration example saves Codex options and injects launch-only MCP servers while preserving other configuration", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-config-example-"));
  const launches: AgentSessionConfig[] = [];
  const daemon = await createTestPaseoDaemon({
    daemonVersion: "0.14.0-beta.1",
    agentClients: {
      codex: createTestAgentClient("codex", {
        supportsMcpServers: true,
        beforeCreateSession: async (config) => {
          launches.push(config);
        },
      }),
    },
    mcpEnabled: false,
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.14.0-beta.1",
  });
  try {
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(
      fileURLToPath(new URL("../../../../../plugin-examples/agent-configuration", import.meta.url)),
    );
    const agent = await client.createAgent({
      provider: "codex",
      cwd: directory,
      systemPrompt: "Keep the user's instructions.",
      providerOptions: {
        sandbox_mode: "read-only",
        approval_policy: "never",
        web_search: "disabled",
      },
      mcpServers: { existing: { type: "http", url: "https://existing.example.com/mcp" } },
    });
    expect(daemon.daemon.agentManager.getAgent(agent.id)?.config).toMatchObject({
      provider: "codex",
      cwd: directory,
      systemPrompt: "Keep the user's instructions.",
      providerOptions: {
        sandbox_mode: "workspace-write",
        approval_policy: "on-request",
        web_search: "disabled",
      },
      mcpServers: {
        existing: { type: "http", url: "https://existing.example.com/mcp" },
      },
    });
    expect(daemon.daemon.agentManager.getAgent(agent.id)!.config.mcpServers).toEqual({
      existing: { type: "http", url: "https://existing.example.com/mcp" },
    });
    expect(launches[0].mcpServers).toEqual({
      existing: { type: "http", url: "https://existing.example.com/mcp" },
      company: { type: "http", url: "https://tools.example.com/mcp" },
    });
    await client.archiveAgent(agent.id);
  } finally {
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("Claude sends the current plugin system prompt after refreshing a session", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-claude-append-"));
  const configDir = path.join(directory, "claude");
  const pluginId = "claude-append-test";
  const requests: { markers: string[]; hasPriorTurn: boolean }[] = [];
  const model = "claude-haiku-4-5-20251001";
  // Run Claude Code's real prompt assembly and resume logic with a local Messages endpoint.
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (!request.url?.match(/^\/v1\/messages(?:\?|$)/)) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    const payload = JSON.parse(body);
    const system = JSON.stringify(payload.system ?? "");
    requests.push({
      markers: ["PASEO-APPEND-ALPHA", "PASEO-APPEND-BETA"].filter((marker) =>
        system.includes(marker),
      ),
      hasPriorTurn: JSON.stringify(payload.messages).includes("First turn of the append test."),
    });
    const events = [
      {
        type: "message_start",
        message: {
          id: `msg_append_${requests.length}`,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 0 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    );
  });

  async function writeHook(marker: string) {
    await writeFile(
      path.join(directory, "index.server.ts"),
      `export default function contribute(server) {
        return server.addHook("agent.open.before", ({ request }) => ({
          ...request,
          appendSystemPrompt: [${JSON.stringify(marker)}],
        }));
      }`,
    );
  }

  let daemon: TestPaseoDaemon | undefined;
  let client: DaemonClient | undefined;
  try {
    await mkdir(configDir);
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: pluginId, requirements: { paseo: ">=0.17.0" } }),
    );
    await writeHook("PASEO-APPEND-ALPHA");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture has no TCP address");
    const logger = pino({ level: "silent" });
    daemon = await createTestPaseoDaemon({
      daemonVersion: "0.17.5",
      agentClients: {
        claude: new ClaudeAgentClient({
          logger,
          runtimeSettings: {
            env: {
              ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
              ANTHROPIC_AUTH_TOKEN: "fixture-token",
              ANTHROPIC_API_KEY: "",
              CLAUDE_CODE_OAUTH_TOKEN: "",
              CLAUDE_CONFIG_DIR: configDir,
              CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
            },
          },
        }),
      },
      mcpEnabled: false,
    });
    client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.17.5" });
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    await client.patchDaemonConfig({ pluginsEnabled: true });
    expect((await client.installDirectoryPlugin(directory)).status).toBe("running");
    const agent = await client.createAgent({ provider: "claude", cwd: directory, model });

    await client.sendMessage(agent.id, "First turn of the append test.");
    expect((await client.waitForFinish(agent.id, 15_000)).status).toBe("idle");
    expect(requests.at(-1)?.markers).toEqual(["PASEO-APPEND-ALPHA"]);

    await writeHook("PASEO-APPEND-BETA");
    expect((await client.reloadPlugin(pluginId)).status).toBe("running");
    await client.refreshAgent(agent.id);
    await client.sendMessage(agent.id, "Second turn of the append test.");
    expect((await client.waitForFinish(agent.id, 15_000)).status).toBe("idle");
    expect(requests.at(-1)).toEqual({ markers: ["PASEO-APPEND-BETA"], hasPriorTurn: true });

    await client.disablePlugin(pluginId);
    await client.refreshAgent(agent.id);
    await client.sendMessage(agent.id, "Third turn of the append test.");
    expect((await client.waitForFinish(agent.id, 15_000)).status).toBe("idle");
    expect(requests.at(-1)).toEqual({ markers: [], hasPriorTurn: true });
    expect(requests).toHaveLength(3);
  } finally {
    await client?.close();
    await daemon?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("session-open entrypoint contributions are optional and rederived for existing agents", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-entrypoint-hook-"));
  const launches: { provider: string; env?: Record<string, string> }[] = [];
  function recordingProvider(provider: "claude" | "codex"): AgentClient {
    const inner = createTestAgentClient(provider);
    return {
      provider: inner.provider,
      capabilities: inner.capabilities,
      isAvailable: () => inner.isAvailable(),
      fetchCatalog: (options) => inner.fetchCatalog(options),
      createSession: async (...args: Parameters<typeof inner.createSession>) => {
        launches.push({ provider, env: args[1]?.env });
        return inner.createSession(...args);
      },
      resumeSession: async (...args: Parameters<typeof inner.resumeSession>) => {
        launches.push({ provider, env: args[2]?.env });
        return inner.resumeSession(...args);
      },
    };
  }
  const daemon = await createTestPaseoDaemon({
    daemonVersion: "0.14.0-beta.2",
    agentClients: { claude: recordingProvider("claude"), codex: recordingProvider("codex") },
    mcpEnabled: false,
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.14.0-beta.2",
  });
  try {
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: "entrypoint-test", requirements: { paseo: ">=0.14.0-beta.2" } }),
    );
    await writeFile(
      path.join(directory, "index.server.ts"),
      `
export default function contribute(server) {
  return server.before("agent.session_open", ({ request }) => {
    if (request.provider !== "claude") return;
    return { ...request, env: { ...request.env, CLAUDE_CODE_ENTRYPOINT: "custom-client" } };
  });
}
`,
    );
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    const existing = await client.createAgent({ provider: "claude", cwd: directory });
    expect(launches.at(-1)?.env?.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    await daemon.daemon.agentManager.reloadAgentSession(existing.id);
    expect(launches.at(-1)?.env?.CLAUDE_CODE_ENTRYPOINT).toBe("custom-client");
    await client.createAgent({ provider: "claude", cwd: directory });
    expect(launches.at(-1)?.env?.CLAUDE_CODE_ENTRYPOINT).toBe("custom-client");
    await client.createAgent({ provider: "codex", cwd: directory });
    expect(launches.at(-1)).toMatchObject({ provider: "codex" });
    expect(launches.at(-1)?.env?.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    await client.disablePlugin("entrypoint-test");
    await daemon.daemon.agentManager.reloadAgentSession(existing.id);
    expect(launches.at(-1)?.env?.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
  } finally {
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("a create hook reads launch-wrap support for a plugin provider that never connected", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-launch-wrap-snapshot-"));
  const daemon = await createTestPaseoDaemon({
    daemonVersion: "0.14.0-beta.2",
    agentClients: { codex: createTestAgentClient("codex") },
    mcpEnabled: false,
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.14.0-beta.2",
  });
  try {
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: "launch-wrap-snapshot", requirements: { paseo: ">=0.14.0-beta.2" } }),
    );
    // connect() always fails, so nothing negotiated over a connection can reach the snapshot.
    await writeFile(
      path.join(directory, "index.server.ts"),
      `import { runAcpProvider } from "@getpaseo/plugin/server/acp";
let connects = 0;
export default function contribute(server) {
  const acp = runAcpProvider({ id: "wrap-acp", label: "Wrap ACP", command: [process.execPath, "--version"] });
  server.registerProvider({ ...acp, connect() { connects += 1; throw new Error("not connected in this test"); } });
  return server.before("agent.create", async ({ request }, { paseo }) => {
    const snapshot = await paseo.providers.snapshot();
    const entry = snapshot.entries.find((candidate) => candidate.provider === "wrap-acp");
    return { ...request, metadata: { ...request.metadata, launchWrapProbe: { launchWrap: entry?.launchWrap ?? null, status: entry?.status ?? null, connects } } };
  });
}
`,
    );
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    const agent = await client.createAgent({ provider: "codex", cwd: directory });
    expect(daemon.daemon.agentManager.getAgent(agent.id)?.metadata.launchWrapProbe).toMatchObject({
      launchWrap: true,
      connects: 0,
    });
    await client.archiveAgent(agent.id);
  } finally {
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
