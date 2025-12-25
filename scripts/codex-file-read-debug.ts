import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";

const TEST_FILE = "/tmp/codex-debug-test-file.txt";
const TEST_CONTENT = "hello from debug test";

async function main() {
  console.log("=== Codex MCP File Read Debug Test ===\n");

  // Create test file
  fs.writeFileSync(TEST_FILE, TEST_CONTENT);
  console.log(`Created test file: ${TEST_FILE}`);
  console.log(`Content: ${TEST_CONTENT}\n`);

  const transport = new StdioClientTransport({
    command: "codex",
    args: ["mcp-server"],
    env: { ...process.env },
  });

  const client = new Client(
    { name: "file-read-debug", version: "1.0.0" },
    { capabilities: { elicitation: {} } }
  );

  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    console.log("\n!!! ELICITATION REQUEST !!!");
    console.log(JSON.stringify(request, null, 2));
    return { decision: "approved" };
  });

  interface ProgressParams {
    data?: {
      type?: string;
      item?: { type?: string };
      name?: string;
      [key: string]: unknown;
    };
  }

  const allEvents: ProgressParams["data"][] = [];

  // Intercept low-level transport to see ALL messages
  const origSend = transport.send.bind(transport);
  transport.send = (msg) => {
    console.log(">>> SEND:", JSON.stringify(msg).slice(0, 200));
    return origSend(msg);
  };

  // Also override onmessage to see all incoming
  const origOnMessage = transport.onmessage;
  transport.onmessage = (msg: unknown) => {
    const msgStr = JSON.stringify(msg);
    if (
      msgStr.includes("file") ||
      msgStr.includes("read") ||
      msgStr.includes("cat") ||
      msgStr.includes(TEST_FILE) ||
      msgStr.includes(TEST_CONTENT)
    ) {
      console.log("<<< RECV (file-related):", msgStr.slice(0, 500));
    } else if (msgStr.includes("item") || msgStr.includes("exec") || msgStr.includes("command")) {
      console.log("<<< RECV (command/item):", msgStr.slice(0, 300));
    }
    origOnMessage?.(msg);
  };

  console.log("Connecting to codex mcp-server...");
  await client.connect(transport);
  console.log("Connected!\n");

  console.log("--- Calling codex tool with file read prompt ---\n");

  const result = await client.callTool({
    name: "codex",
    arguments: {
      prompt: `Read the file ${TEST_FILE} and tell me what it says. Reply DONE when finished.`,
      sandbox: "danger-full-access",
      "approval-policy": "never",
    },
  });

  console.log("\n=== RESULT ===\n");
  console.log(JSON.stringify(result, null, 2));

  console.log("\n=== ALL UNIQUE EVENT TYPES ===\n");
  const eventTypes = new Set<string>();
  const itemTypes = new Set<string>();

  for (const e of allEvents) {
    if (e?.type) eventTypes.add(e.type);
    if (e?.item?.type) itemTypes.add(e.item.type);
  }

  console.log("Event types:", [...eventTypes].join(", "));
  console.log("Item types:", [...itemTypes].join(", "));

  // Check for file read evidence
  console.log("\n=== FILE READ ANALYSIS ===\n");
  const fileEvents = allEvents.filter(e =>
    e?.type?.includes("file") ||
    e?.type?.includes("read") ||
    e?.item?.type?.includes("file") ||
    JSON.stringify(e).includes("cat ") ||
    JSON.stringify(e).includes("read_file")
  );

  console.log(`Found ${fileEvents.length} file-related events`);
  for (const e of fileEvents) {
    console.log("  -", JSON.stringify(e));
  }

  // Check for any event that mentions the test file
  const mentioningEvents = allEvents.filter(e =>
    JSON.stringify(e).includes(TEST_FILE) ||
    JSON.stringify(e).includes(TEST_CONTENT)
  );

  console.log(`\nFound ${mentioningEvents.length} events mentioning test file or content`);
  for (const e of mentioningEvents) {
    console.log("  -", e?.type, JSON.stringify(e).slice(0, 200));
  }

  await client.close();
  console.log("\nDone.");
}

main().catch(console.error);
