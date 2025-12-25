import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

async function main() {
  console.log("=== Testing if Codex can launch Claude ===\n");

  const transport = new StdioClientTransport({
    command: "codex",
    args: ["mcp-server"],
    env: { ...process.env },
  });

  const client = new Client(
    { name: "claude-test", version: "1.0.0" },
    { capabilities: { elicitation: {} } }
  );

  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    console.log("\n!!! ELICITATION REQUEST !!!");
    console.log(JSON.stringify(request.params, null, 2));
    return { decision: "approved" };
  });

  console.log("Connecting to Codex MCP server...");
  await client.connect(transport);
  console.log("Connected!\n");

  console.log("Asking Codex to run: claude -p 'Say hello'");
  console.log("Using: sandbox=danger-full-access, approval-policy=never\n");

  try {
    const result = await client.callTool({
      name: "codex",
      arguments: {
        prompt: 'Run this exact command: claude -p "Say hello world"',
        sandbox: "danger-full-access",
        "approval-policy": "never",
      },
    });

    console.log("\n=== RESULT ===");
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error("\n=== ERROR ===");
    console.error(err);
  }

  await client.close();
  console.log("\nDone.");
}

main().catch(console.error);
