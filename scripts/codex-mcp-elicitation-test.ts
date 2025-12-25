import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const PROMPT = 'Run exactly: curl -s https://httpbin.org/get\nThen say done.';

async function main() {
  console.log("=== Codex MCP Elicitation Debug Test ===\n");

  const transport = new StdioClientTransport({
    command: "codex",
    args: ["mcp-server"],
    env: { ...process.env },
  });

  const client = new Client(
    { name: "elicitation-test", version: "1.0.0" },
    { capabilities: { elicitation: {} } }
  );

  // Handle elicitation requests
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    console.log("\n!!! ELICITATION REQUEST RECEIVED !!!");
    console.log(JSON.stringify(request, null, 2));
    // Codex expects lowercase: approved | denied | abort | approved_for_session
    return { decision: "approved" };
  });

  console.log("Connecting to codex mcp-server...");
  await client.connect(transport);
  console.log("Connected!\n");

  const tools = await client.listTools();
  console.log("Available tools:", tools.tools.map(t => t.name).join(", "));

  console.log("\n--- Calling codex tool ---");
  console.log("Config: sandbox=workspace-write, approval-policy=untrusted\n");

  try {
    const result = await client.callTool({
      name: "codex",
      arguments: {
        prompt: PROMPT,
        sandbox: "workspace-write",
        "approval-policy": "on-request",
      },
    });
    console.log("\n--- Tool Result ---");
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error("Tool call failed:", err);
  }

  await client.close();
  console.log("\nDone.");
}

main().catch(console.error);
