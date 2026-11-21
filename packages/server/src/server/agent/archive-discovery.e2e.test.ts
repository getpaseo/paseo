import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import {
  AgentListItemPayloadSchema,
  AgentSnapshotPayloadSchema,
} from "@getpaseo/protocol/messages";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { CodexAppServerAgentClient } from "./providers/codex-app-server-agent.js";
import { ClaudeAgentClient } from "./providers/claude/agent.js";

// Opt in to the same workflow with the installed providers instead of test clients.
const real = process.env.PASEO_ARCHIVE_REAL === "1";
const StatusSchema = z.object({ snapshot: AgentSnapshotPayloadSchema });
const ListSchema = z.object({ agents: z.array(AgentListItemPayloadSchema) });

test.each(["codex", "claude"] as const)(
  "archived %s history remains archived across MCP discovery",
  async (provider) => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "archive-discovery-"));
    const logger = pino({ level: "silent" });
    const daemon = await createTestPaseoDaemon({
      agentClients: real
        ? {
            [provider]:
              provider === "codex"
                ? new CodexAppServerAgentClient(logger)
                : new ClaudeAgentClient({ logger }),
          }
        : createTestAgentClients(),
      pluginsEnabled: false,
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    const mcp = new Client({ name: "archive-discovery-test", version: "1.0.0" });
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await mcp.callTool({ name, arguments: args });
      if (result.isError) throw new Error(JSON.stringify(result.content));
      return result.structuredContent;
    };
    const list = async (includeArchived: boolean) =>
      ListSchema.parse(await call("list_agents", { cwd, includeArchived })).agents;
    const status = async (agentId: string) =>
      StatusSchema.parse(await call("get_agent_status", { agentId })).snapshot;
    try {
      await client.connect();
      await mcp.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${daemon.port}/mcp/agents`)),
      );
      const realModel = provider === "codex" ? "gpt-5.6-sol" : "haiku";
      const agent = await client.createAgent({
        config: {
          provider,
          cwd,
          model: real ? realModel : undefined,
          modeId: provider === "codex" ? "full-access" : "bypassPermissions",
        },
      });
      await daemon.daemon.agentManager.runAgent(
        agent.id,
        "Reply with ARCHIVE_OK. Do not use tools.",
      );
      expect((await list(false)).map((item) => item.id)).toContain(agent.id);
      await call("archive_agent", { agentId: agent.id });
      const archivedAt = (await status(agent.id)).archivedAt;
      expect(archivedAt).toEqual(expect.any(String));
      expect((await list(false)).map((item) => item.id)).not.toContain(agent.id);

      const timeline = await client.fetchAgentTimeline(agent.id, { direction: "tail", limit: 0 });
      expect(timeline.entries.length).toBeGreaterThan(0);
      expect.soft((await status(agent.id)).archivedAt).toBe(archivedAt);
      expect.soft((await list(false)).map((item) => item.id)).not.toContain(agent.id);
      expect
        .soft((await list(true)).find((item) => item.id === agent.id)?.archivedAt)
        .toBe(archivedAt);
      const ordinary = await client.fetchAgents({ filter: { includeArchived: false } });
      expect.soft(ordinary.entries.map((entry) => entry.agent.id)).not.toContain(agent.id);
      const inclusive = await client.fetchAgents({ filter: { includeArchived: true } });
      expect
        .soft(inclusive.entries.find((entry) => entry.agent.id === agent.id)?.agent.archivedAt)
        .toBe(archivedAt);

      await client.refreshAgent(agent.id);
      expect((await status(agent.id)).archivedAt).toBeNull();
      expect((await list(false)).map((item) => item.id)).toContain(agent.id);
    } finally {
      await mcp.close();
      await client.close();
      await daemon.close();
      await rm(cwd, { recursive: true, force: true });
    }
  },
  120_000,
);
