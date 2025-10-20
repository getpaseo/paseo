import { experimental_createMCPClient } from "ai";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let playwrightMCPClient: Awaited<
  ReturnType<typeof experimental_createMCPClient>
> | null = null;

/**
 * Get or create the Playwright MCP client (singleton)
 */
export async function getPlaywrightMCPClient() {
  if (playwrightMCPClient) {
    return playwrightMCPClient;
  }

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["@playwright/mcp", "--browser", "firefox"],
  });

  playwrightMCPClient = await experimental_createMCPClient({
    transport,
  });

  console.log("Playwright MCP client initialized with Firefox");

  return playwrightMCPClient;
}

/**
 * Get Playwright MCP tools in AI SDK format
 */
export async function getPlaywrightTools() {
  try {
    const client = await getPlaywrightMCPClient();
    const tools = await client.tools();
    console.log(`Loaded ${Object.keys(tools).length} Playwright MCP tools`);
    return tools;
  } catch (error) {
    console.error("Failed to initialize Playwright MCP tools:", error);
    // Return empty object to allow app to continue without Playwright
    return {};
  }
}

/**
 * Cleanup function to close the MCP client
 */
export async function closePlaywrightMCP() {
  if (playwrightMCPClient) {
    await playwrightMCPClient.close();
    playwrightMCPClient = null;
    console.log("Playwright MCP client closed");
  }
}
