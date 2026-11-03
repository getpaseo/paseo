import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { DaemonClient } from "../test-utils/daemon-client.js";
import type { AgentClient, AgentSessionConfig } from "../agent/agent-sdk-types.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

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
