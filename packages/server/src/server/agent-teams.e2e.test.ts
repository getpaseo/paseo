import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { experimental_createMCPClient } from "ai";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, expect, test } from "vitest";

import { AGENT_TEAM_LABEL, AGENT_TEAM_RUN_LABEL } from "./agent/agent-teams.js";
import type { AgentSessionConfig } from "./agent/agent-sdk-types.js";
import { getFullAccessConfig } from "./daemon-e2e/agent-configs.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";
import { DaemonClient } from "./test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "./test-utils/paseo-daemon.js";

const teams = {
  "full-stack": {
    description: "Ship features end to end.",
    peerMessaging: true,
    roles: {
      implementer: {
        description: "Writes the code.",
        provider: "codex",
        model: "impl-model",
        isolation: "worktree" as const,
      },
      researcher: { description: "Reads docs.", profile: "Researcher" },
    },
  },
  broken: { roles: { reviewer: { description: "Reviews.", profile: "Missing profile" } } },
};

let daemon: TestPaseoDaemon;
let client: DaemonClient;
let cwd: string;
let sessionConfigs: AgentSessionConfig[];

beforeEach(async () => {
  cwd = mkdtempSync(path.join(tmpdir(), "paseo-agent-teams-"));
  sessionConfigs = [];
  daemon = await createTestPaseoDaemon({
    agentClients: createTestAgentClients({
      beforeCreateSession: async (config) => {
        sessionConfigs.push(config);
      },
    }),
    agentProfiles: [{ id: "p1", name: "Researcher", provider: "claude", model: "research-model" }],
    teams,
  });
  client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  await client.connect();
  await client.fetchAgents({ subscribe: {} });
});

afterEach(async () => {
  await client.close().catch(() => undefined);
  await daemon.close();
  rmSync(cwd, { recursive: true, force: true });
});

test("the host advertises teams and lists them resolved against agent profiles", async () => {
  expect(client.supportsAgentTeams()).toBe(true);

  const listed = await client.listAgentTeams();

  expect(listed.teams).toEqual([
    {
      name: "full-stack",
      description: "Ship features end to end.",
      roles: [
        {
          name: "implementer",
          description: "Writes the code.",
          provider: "codex",
          model: "impl-model",
        },
        {
          name: "researcher",
          description: "Reads docs.",
          provider: "claude",
          model: "research-model",
          profile: "Researcher",
        },
      ],
    },
  ]);
  expect(listed.error).toBe(
    'Team "broken" role "reviewer" references unknown agent profile "Missing profile"',
  );
});

test("a chat created with a team is labelled and given its roster", async () => {
  const agent = await client.createAgent({
    ...getFullAccessConfig("claude"),
    cwd,
    title: "Team chat",
    team: "full-stack",
  });

  expect(agent.labels[AGENT_TEAM_LABEL]).toBe("full-stack");
  const systemPrompt = sessionConfigs.at(-1)?.systemPrompt ?? "";
  expect(systemPrompt).toContain('You lead the "full-stack" team.');
  expect(systemPrompt).toContain('create_agent provider: "codex/impl-model"');
  expect(systemPrompt).toContain('create_agent provider: "claude/research-model"');
  expect(daemon.daemon.agentManager.getAgent(agent.id)?.config.systemPrompt).toBe(systemPrompt);
});

test("an unknown team fails creation and creates no agent", async () => {
  await expect(
    client.createAgent({
      ...getFullAccessConfig("claude"),
      cwd,
      title: "No such team",
      team: "nope",
    }),
  ).rejects.toThrow('Team "nope" is not defined in daemon.teams');
  expect(sessionConfigs).toHaveLength(0);
  expect(daemon.daemon.agentManager.listAgents()).toHaveLength(0);
});

test("a role model override replaces that role's model in this chat's roster only", async () => {
  await client.createAgent({
    ...getFullAccessConfig("claude"),
    cwd,
    title: "Overridden team chat",
    team: "full-stack",
    teamModelOverrides: { implementer: "fast-model" },
  });

  const systemPrompt = sessionConfigs.at(-1)?.systemPrompt ?? "";
  expect(systemPrompt).toContain('create_agent provider: "codex/fast-model"');
  expect(systemPrompt).not.toContain("codex/impl-model");
  expect(systemPrompt).toContain('create_agent provider: "claude/research-model"');
  expect((await client.listAgentTeams()).teams[0]?.roles[0]?.model).toBe("impl-model");
});

test("an override for a role the team lacks fails creation", async () => {
  await expect(
    client.createAgent({
      ...getFullAccessConfig("claude"),
      cwd,
      title: "Bad override",
      team: "full-stack",
      teamModelOverrides: { tester: "fast-model" },
    }),
  ).rejects.toThrow('Team "full-stack" has no role "tester"');
  expect(sessionConfigs).toHaveLength(0);
});

test("helpers the team chat creates do not inherit the team", async () => {
  const chat = await client.createAgent({
    ...getFullAccessConfig("claude"),
    cwd,
    title: "Team chat",
    team: "full-stack",
  });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${daemon.port}/mcp/agents?callerAgentId=${chat.id}`),
  );
  const mcp = await experimental_createMCPClient({ transport });
  try {
    const callTool = Reflect.get(mcp, "callTool").bind(mcp) as (input: {
      name: string;
      args: Record<string, unknown>;
    }) => Promise<{ structuredContent?: { agentId?: string }; isError?: boolean }>;
    const result = await callTool({
      name: "create_agent",
      args: {
        title: "Implementer",
        provider: "codex/impl-model",
        initialPrompt: "say done",
        settings: { modeId: "full-access" },
        notifyOnFinish: false,
      },
    });
    expect(result.isError).toBe(false);
    const helperId = result.structuredContent?.agentId ?? "";
    const helper = daemon.daemon.agentManager.getAgent(helperId);
    expect(helper).toBeDefined();
    expect(helper?.labels[AGENT_TEAM_LABEL]).toBeUndefined();
    expect(helper?.config.systemPrompt ?? "").not.toContain("You lead the");
  } finally {
    await mcp.close();
  }
});

test("team run members message each other through the daemon", async () => {
  const chat = await client.createAgent({
    ...getFullAccessConfig("claude"),
    cwd,
    title: "Team chat",
    team: "full-stack",
  });
  expect(sessionConfigs.at(-1)?.systemPrompt ?? "").toContain("send_team_message");
  const connect = async (callerAgentId: string) => {
    const mcp = await experimental_createMCPClient({
      transport: new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${daemon.port}/mcp/agents?callerAgentId=${callerAgentId}`),
      ),
    });
    const callTool = Reflect.get(mcp, "callTool").bind(mcp) as (input: {
      name: string;
      args: Record<string, unknown>;
    }) => Promise<{ structuredContent?: Record<string, unknown>; isError?: boolean }>;
    return { mcp, callTool };
  };
  const chatMcp = await connect(chat.id);
  try {
    const created = await chatMcp.callTool({
      name: "create_agent",
      args: {
        title: "Reviewer",
        provider: "claude/research-model",
        initialPrompt: "say done",
        notifyOnFinish: false,
        labels: { "paseo.team-role": "reviewer" },
      },
    });
    expect(created.isError).toBe(false);
    const helperId = String(created.structuredContent?.agentId);
    expect(daemon.daemon.agentManager.getAgent(helperId)?.labels[AGENT_TEAM_RUN_LABEL]).toBe(
      chat.id,
    );

    const helperMcp = await connect(helperId);
    try {
      const listed = await helperMcp.callTool({ name: "list_team_members", args: {} });
      expect(listed.isError).toBe(false);
      expect(listed.structuredContent?.members).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ agentId: chat.id, isParent: true, isSelf: false }),
          expect.objectContaining({ agentId: helperId, role: "reviewer", isSelf: true }),
        ]),
      );

      const sent = await helperMcp.callTool({
        name: "send_team_message",
        args: { agentId: chat.id, message: "Review finished, no defects" },
      });
      expect(sent.isError).toBe(false);
      expect(sent.structuredContent).toMatchObject({ outcome: "delivered", agentId: chat.id });
    } finally {
      await helperMcp.mcp.close();
    }
  } finally {
    await chatMcp.mcp.close();
  }
});
