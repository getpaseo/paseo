import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

async function main() {
  // Create base64 encoded credentials
  const credentials = Buffer.from("mo:bo").toString("base64");

  const transport = new StdioClientTransport({
    command: "codex",
    args: ["mcp-server"],
    env: {
      ...process.env,
      // Set the bearer token env var that we will reference
      AGENT_CONTROL_TOKEN: `Basic ${credentials}`
    },
  });

  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: { elicitation: {} } }
  );

  // Listen for events
  client.setNotificationHandler(
    z.object({
      method: z.literal("codex/event"),
      params: z.object({ msg: z.any() }),
    }).passthrough(),
    (data) => {
      const event = (data.params as { msg: unknown }).msg as { type?: string };
      if (event.type === "mcp_startup_update" || event.type === "mcp_startup_complete") {
        process.stdout.write("MCP Event: " + JSON.stringify(event, null, 2) + "\n");
      }
    }
  );

  await client.connect(transport);

  // Try passing MCP server config with bearer_token_env_var
  process.stdout.write("\n=== Testing HTTP MCP server with bearer_token_env_var ===\n\n");

  try {
    const result = await client.callTool({
      name: "codex",
      arguments: {
        prompt: "List all the MCP tools you have available. Just list them, don't use any.",
        sandbox: "danger-full-access",
        "approval-policy": "never",
        config: {
          mcp_servers: {
            "agent-control": {
              url: "http://localhost:6767/mcp/agent-control",
              bearer_token_env_var: "AGENT_CONTROL_TOKEN"
            }
          }
        }
      }
    }, undefined, { timeout: 60000 });

    process.stdout.write("\n=== RESULT ===\n");
    const content = (result as { content: { text?: string }[] }).content;
    for (const item of content) {
      if (item.text) {
        process.stdout.write(item.text + "\n");
      }
    }
  } catch (error) {
    process.stderr.write("Error: " + String(error) + "\n");
  }

  await client.close();
}

main().catch((error) => {
  process.stderr.write(String(error) + "\n");
  process.exitCode = 1;
});
