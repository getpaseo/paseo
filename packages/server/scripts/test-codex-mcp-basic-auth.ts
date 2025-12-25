import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

async function main() {
  const transport = new StdioClientTransport({
    command: "codex",
    args: ["mcp-server"],
    env: {
      ...process.env,
      // Try passing credentials via env var that Codex might read
      AGENT_CONTROL_AUTH: "mo:bo"
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
        console.log("MCP Event:", JSON.stringify(event, null, 2));
      }
    }
  );

  await client.connect(transport);

  // Try passing MCP server config via the config parameter with headers
  console.log("\n=== Testing HTTP MCP server with basic auth in config ===\n");

  try {
    // Create base64 encoded credentials
    const credentials = Buffer.from("mo:bo").toString("base64");

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
              // Try various ways to pass auth
              headers: {
                "Authorization": `Basic ${credentials}`
              }
            }
          }
        }
      }
    }, undefined, { timeout: 60000 });

    console.log("\n=== RESULT ===");
    const content = (result as { content: { text?: string }[] }).content;
    for (const item of content) {
      if (item.text) {
        console.log(item.text);
      }
    }
  } catch (error) {
    console.error("Error:", error);
  }

  await client.close();
}

main().catch(console.error);
