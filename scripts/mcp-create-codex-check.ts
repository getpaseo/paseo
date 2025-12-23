import { experimental_createMCPClient } from "ai";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { resolvePaseoPort } from "../packages/server/src/server/config.ts";

function resolveAuthHeader(): string | undefined {
  const user = process.env.PASEO_BASIC_AUTH_USER ?? "mo";
  const pass = process.env.PASEO_BASIC_AUTH_PASS ?? "bo";
  if (!user || !pass) {
    return undefined;
  }
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

async function main(): Promise<void> {
  const port = resolvePaseoPort();
  const agentMcpUrl = `http://127.0.0.1:${port}/mcp/agents`;
  const authHeader = resolveAuthHeader();

  const transport = new StreamableHTTPClientTransport(
    new URL(agentMcpUrl),
    authHeader
      ? {
          requestInit: {
            headers: { Authorization: authHeader },
          },
        }
      : undefined
  );

  const client = await experimental_createMCPClient({ transport });
  console.log(`[mcp-check] connected to ${agentMcpUrl}`);

  const createResult = await client.callTool({
    name: "create_agent",
    args: {
      cwd: process.cwd(),
      title: "Codex MCP check",
      agentType: "codex",
      background: false,
    },
  });

  console.log("[mcp-check] create_agent result:", createResult);

  const agentId =
    (createResult as any)?.structuredContent?.agentId ??
    (createResult as any)?.content?.[0]?.structuredContent?.agentId ??
    (createResult as any)?.content?.[0]?.agentId;
  if (!agentId || typeof agentId !== "string") {
    throw new Error("create_agent did not return agentId");
  }

  const prompt = [
    "Use the MCP tool agent_control.list_agents and report the agent IDs you receive.",
    "If the tool is unavailable, say exactly: MCP tool list_agents unavailable.",
    "Then stop.",
  ].join("\n");

  const promptResult = await client.callTool({
    name: "send_agent_prompt",
    args: { agentId, prompt, background: false },
  });

  console.log("[mcp-check] send_agent_prompt result:", promptResult);

  const activityResult = await client.callTool({
    name: "get_agent_activity",
    args: { agentId, limit: 20 },
  });

  console.log("[mcp-check] get_agent_activity result:", activityResult);

  await client.callTool({ name: "kill_agent", args: { agentId } });
  if (typeof (client as any).close === "function") {
    await (client as any).close();
  }
}

main().catch((error) => {
  console.error("[mcp-check] failed:", error);
  process.exit(1);
});
