import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

async function main() {
  const transport = new StdioClientTransport({
    command: "codex",
    args: ["mcp-server"],
    env: { ...process.env },
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
      const event = (data.params as { msg: unknown }).msg as {
        type?: string;
        data?: { text?: string; item?: { type?: string } };
        text?: string;
        item?: { type?: string };
      };
      if (event.type === "turn.started") {
        console.log("\n=== TURN STARTED ===");
      } else if (event.type === "agent_message") {
        console.log("Agent:", event.data?.text || event.text);
      } else if (event.type === "mcp_tool_call") {
        console.log("MCP Tool Call:", JSON.stringify(event.data));
      } else if (event.type === "thread.item") {
        const item = event.data?.item || event.item;
        if (item?.type === "mcp_tool_call") {
          console.log("MCP Tool from thread:", JSON.stringify(item));
        }
      } else {
        console.log("Event:", event.type);
      }
    }
  );

  await client.connect(transport);

  // Try passing MCP server config via the config parameter
  console.log("\n=== Testing dynamic MCP server config ===\n");

  try {
    const result = await client.callTool({
      name: "codex",
      arguments: {
        prompt: "List all the MCP tools you have available. Just list them, don't use any.",
        sandbox: "danger-full-access",
        "approval-policy": "never",
        config: {
          mcp_servers: {
            "test-server": {
              command: "npx",
              args: ["-y", "mcp-server-time"]
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
