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
        process.stdout.write("\n=== TURN STARTED ===\n");
      } else if (event.type === "agent_message") {
        process.stdout.write("Agent: " + (event.data?.text || event.text) + "\n");
      } else if (event.type === "mcp_tool_call") {
        process.stdout.write("MCP Tool Call: " + JSON.stringify(event.data) + "\n");
      } else if (event.type === "thread.item") {
        const item = event.data?.item || event.item;
        if (item?.type === "mcp_tool_call") {
          process.stdout.write("MCP Tool from thread: " + JSON.stringify(item) + "\n");
        }
      } else {
        process.stdout.write("Event: " + event.type + "\n");
      }
    }
  );

  await client.connect(transport);

  // Try passing MCP server config via the config parameter
  process.stdout.write("\n=== Testing dynamic MCP server config ===\n\n");

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
