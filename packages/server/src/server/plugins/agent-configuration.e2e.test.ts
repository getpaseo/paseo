import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { DaemonClient } from "../test-utils/daemon-client.js";
import type { AgentSessionConfig } from "../agent/agent-sdk-types.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

test("the configuration example saves Codex options and injects launch-only MCP servers while preserving other configuration", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-config-example-"));
  const launches: AgentSessionConfig[] = [];
  const daemon = await createTestPaseoDaemon({
    daemonVersion: "0.13.2",
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
    appVersion: "0.13.2",
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
