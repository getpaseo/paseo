import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import pino from "pino";

import { ClaudeAgentClient } from "../src/server/agent/providers/claude-agent.js";
import { CodexAppServerAgentClient } from "../src/server/agent/providers/codex-app-server-agent.js";
import {
  getFullAccessConfig,
  isProviderAvailable,
} from "../src/server/daemon-e2e/agent-configs.js";
import { DaemonClient } from "../src/server/test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../src/server/test-utils/paseo-daemon.js";

function collectAssistantText(entries: Array<{ item: { type: string; text?: string } }>): string {
  return entries
    .filter(
      (entry): entry is { item: { type: "assistant_message"; text: string } } =>
        entry.item.type === "assistant_message" && typeof entry.item.text === "string",
    )
    .map((entry) => entry.item.text)
    .join("\n");
}

type ToolCallRecord = {
  name: string;
  status: string;
};

type ProviderRunResult = {
  provider: "claude" | "codex";
  agentId: string;
  assistantText: string;
  toolCalls: ToolCallRecord[];
};

async function verifyInjectedMcpForProvider(
  client: DaemonClient,
  provider: "claude" | "codex",
  cwd: string,
): Promise<ProviderRunResult> {
  const created = await client.createAgent({
    cwd,
    title: `mcp-inject-real-${provider}`,
    ...getFullAccessConfig(provider),
  });
  const agentId = created.id;

  try {
    const prompt = [
      "List all your available MCP tools.",
      "If you have a tool called list_agents or create_agent from a paseo MCP server, call list_agents once.",
      "After checking, reply with exactly PASEO_MCP_FOUND.",
      "If you do not have those tools, reply with exactly PASEO_MCP_NOT_FOUND.",
      "Do not say anything else.",
    ].join(" ");

    await client.sendMessage(agentId, prompt);

    const finished = await client.waitForFinish(agentId, 240_000);
    if (finished.status !== "idle") {
      throw new Error(`Agent did not finish successfully (status=${finished.status})`);
    }

    const timeline = await client.fetchAgentTimeline(agentId, {
      direction: "tail",
      limit: 0,
      projection: "canonical",
    });
    const assistantText = collectAssistantText(timeline.entries);
    const toolCalls = timeline.entries
      .filter(
        (
          entry,
        ): entry is typeof entry & {
          item: { type: "tool_call"; name: string; status: string };
        } => entry.item.type === "tool_call" && typeof entry.item.name === "string",
      )
      .map((entry) => ({
        name: entry.item.name,
        status: entry.item.status,
      }));

    if (!assistantText.includes("PASEO_MCP_FOUND")) {
      throw new Error(
        `Expected assistant to confirm Paseo MCP availability. Assistant text:\n${assistantText}`,
      );
    }

    const listAgentsCalls = toolCalls.filter(
      (call) =>
        call.name === "list_agents" ||
        call.name === "paseo.list_agents" ||
        call.name.endsWith("__list_agents"),
    );
    if (listAgentsCalls.length === 0) {
      throw new Error(
        `Expected agent to call list_agents. Tool calls:\n${JSON.stringify(toolCalls, null, 2)}`,
      );
    }
    if (!listAgentsCalls.some((call) => call.status === "completed")) {
      throw new Error(
        `Expected list_agents to complete successfully. Tool calls:\n${JSON.stringify(toolCalls, null, 2)}`,
      );
    }
    if (listAgentsCalls.some((call) => call.status === "failed")) {
      throw new Error(
        `Expected list_agents to succeed. Tool calls:\n${JSON.stringify(toolCalls, null, 2)}`,
      );
    }

    return {
      provider,
      agentId,
      assistantText,
      toolCalls,
    };
  } catch (error) {
    await client.archiveAgent(agentId).catch(() => undefined);
    throw error;
  }
}

async function main(): Promise<void> {
  const claudeAvailable = await isProviderAvailable("claude");
  if (!claudeAvailable) {
    throw new Error(
      "Claude is not available in this environment. Ensure the `claude` binary and credentials are configured.",
    );
  }
  const codexAvailable = await isProviderAvailable("codex");

  const logger = pino({ level: "silent" });
  const rootCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-mcp-inject-real-"));
  const claudeCwd = path.join(rootCwd, "claude");
  const codexCwd = path.join(rootCwd, "codex");
  const daemon = await createTestPaseoDaemon({
    agentClients: {
      claude: new ClaudeAgentClient({ logger }),
      ...(codexAvailable ? { codex: new CodexAppServerAgentClient(logger) } : {}),
    },
    logger,
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const createdAgentIds: string[] = [];

  try {
    await mkdir(claudeCwd, { recursive: true });
    await mkdir(codexCwd, { recursive: true });

    await client.connect();
    await client.fetchAgents({
      subscribe: { subscriptionId: "mcp-inject-real-claude" },
    });

    const results: ProviderRunResult[] = [];

    const claudeResult = await verifyInjectedMcpForProvider(client, "claude", claudeCwd);
    createdAgentIds.push(claudeResult.agentId);
    results.push(claudeResult);
    console.log(`[PASS] Claude MCP injection verified for agent ${claudeResult.agentId}`);

    if (codexAvailable) {
      const codexResult = await verifyInjectedMcpForProvider(client, "codex", codexCwd);
      createdAgentIds.push(codexResult.agentId);
      results.push(codexResult);
      console.log(`[PASS] Codex MCP injection verified for agent ${codexResult.agentId}`);
    } else {
      console.log("[SKIP] Codex is not available in this environment");
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          results,
        },
        null,
        2,
      ),
    );
  } finally {
    for (const agentId of createdAgentIds) {
      await client.archiveAgent(agentId).catch(() => undefined);
    }
    await client.close().catch(() => undefined);
    await daemon.close().catch(() => undefined);
    await rm(rootCwd, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
