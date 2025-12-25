import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

async function main() {
  console.log("=== Codex MCP Web Search Debug Test ===\n");

  const transport = new StdioClientTransport({
    command: "codex",
    args: ["mcp-server"],
    env: { ...process.env },
  });

  const client = new Client(
    { name: "websearch-debug", version: "1.0.0" },
    { capabilities: { elicitation: {} } }
  );

  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    console.log("\n!!! ELICITATION REQUEST !!!");
    console.log(JSON.stringify(request, null, 2));
    return { decision: "approved" };
  });

  const origOnMessage = transport.onmessage;
  transport.onmessage = (msg: unknown) => {
    const msgStr = JSON.stringify(msg);
    if (
      msgStr.includes("web_search") ||
      msgStr.includes("search") ||
      msgStr.includes("query")
    ) {
      console.log("<<< WEB SEARCH EVENT:", msgStr.slice(0, 800));
    }
    origOnMessage?.(msg);
  };

  console.log("Connecting to codex mcp-server...");
  await client.connect(transport);
  console.log("Connected!\n");

  console.log("--- Calling codex tool with web search prompt ---\n");

  const result = await client.callTool({
    name: "codex",
    arguments: {
      prompt: "Use web search to find information about 'Anthropic Claude'. Reply with what you find.",
      sandbox: "danger-full-access",
      "approval-policy": "never",
    },
  });

  console.log("\n=== RESULT ===\n");
  console.log(JSON.stringify(result, null, 2));

  await client.close();
  console.log("\nDone.");
}

main().catch(console.error);
