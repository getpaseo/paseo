import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, test } from "vitest";
import { createDaemonTestContext } from "../test-utils/index.js";

test("an attended MCP caller can discover and supply a cross-provider child mode", async () => {
  const artifacts = path.join(process.cwd(), ".artifacts");
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(path.join(artifacts, "create-agent-mode-"));
  const ctx = await createDaemonTestContext({ paseoHomeRoot: root, mcpEnabled: true });
  const mcp = new Client({ name: "mode-contract-test", version: "1" });
  try {
    const parent = await ctx.client.createAgent({
      provider: "claude",
      cwd: root,
      modeId: "default",
      title: "Attended parent",
    });
    await mcp.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${ctx.daemon.port}/mcp/agents?callerAgentId=${parent.id}`),
      ),
    );
    const { tools } = await mcp.listTools();
    const create = tools.find((tool) => tool.name === "create_agent");
    expect.soft(create?.description).toContain("settings.modeId");

    const args = {
      provider: "codex/gpt-5.4-mini",
      title: "Cross-provider child",
      initialPrompt: "Reply with OK",
    };
    const refused = await mcp.callTool({ name: "create_agent", arguments: args });
    expect(refused.isError).toBe(true);
    expect.soft(refused.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("Pass an explicit mode in settings.modeId"),
      }),
    ]);
    expect((await ctx.client.fetchAgents({ subscribe: {} })).entries).toHaveLength(1);

    const inspected = await mcp.callTool({
      name: "inspect_provider",
      arguments: { provider: "codex" },
    });
    expect(inspected.isError).not.toBe(true);
    expect(inspected.structuredContent).toMatchObject({
      modes: expect.arrayContaining([expect.objectContaining({ id: "auto" })]),
    });
    const created = await mcp.callTool({
      name: "create_agent",
      arguments: { ...args, settings: { modeId: "auto" } },
    });
    expect(created.isError).not.toBe(true);
    expect(created.structuredContent).toMatchObject({ type: "codex", currentModeId: "auto" });
    const childId = (created.structuredContent as { agentId: string }).agentId;
    expect((await ctx.client.fetchAgent(childId))?.agent.currentModeId).toBe("auto");
    expect((await ctx.client.waitForFinish(childId, 5000)).status).toBe("idle");
  } finally {
    await mcp.close();
    await ctx.cleanup();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
