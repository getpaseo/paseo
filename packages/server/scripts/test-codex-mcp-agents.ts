import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

async function main() {
  // The bearer token is the base64-encoded credentials
  const bearerToken = Buffer.from("mo:bo").toString("base64");

  const transport = new StdioClientTransport({
    command: "codex",
    args: ["mcp-server"],
    env: {
      ...process.env,
      // Set the bearer token env var
      PASEO_AGENT_CONTROL_TOKEN: bearerToken
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

  // Use correct route (/mcp/agents) and bearer token env var
  process.stdout.write("\n=== Testing HTTP MCP server with correct route and bearer token ===\n\n");

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
              url: "http://localhost:6767/mcp/agents",
              bearer_token_env_var: "PASEO_AGENT_CONTROL_TOKEN"
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
