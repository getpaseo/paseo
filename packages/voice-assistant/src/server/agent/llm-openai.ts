import { tool, experimental_createMCPClient } from "ai";
import { z } from "zod";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createTerminalMcpServer } from "../terminal-mcp/index.js";

/**
 * Singleton MCP clients
 */
let terminalMcpClient: Awaited<
  ReturnType<typeof experimental_createMCPClient>
> | null = null;

let playwrightMcpClient: Awaited<
  ReturnType<typeof experimental_createMCPClient>
> | null = null;

/**
 * Get or create Terminal MCP client (singleton)
 */
async function getTerminalMcpClient() {
  if (terminalMcpClient) {
    return terminalMcpClient;
  }

  // Create Terminal MCP server
  const server = await createTerminalMcpServer({ sessionName: "voice-dev" });

  // Create linked transport pair
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  // Connect server to its transport
  await server.connect(serverTransport);

  // Create client connected to the other side
  terminalMcpClient = await experimental_createMCPClient({
    transport: clientTransport,
  });

  console.log("Terminal MCP client initialized");

  return terminalMcpClient;
}

/**
 * Get or create Playwright MCP client (singleton)
 */
async function getPlaywrightMcpClient() {
  if (playwrightMcpClient) {
    return playwrightMcpClient;
  }

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["@playwright/mcp", "--image-responses", "omit"],
  });

  playwrightMcpClient = await experimental_createMCPClient({
    transport,
  });

  console.log("Playwright MCP client initialized");

  return playwrightMcpClient;
}

/**
 * Cache for merged MCP tools
 */
let mcpToolsCache: Record<string, any> | null = null;
let mcpToolsPromise: Promise<Record<string, any>> | null = null;

async function getMcpTools(): Promise<Record<string, any>> {
  if (mcpToolsCache) {
    return mcpToolsCache;
  }

  if (mcpToolsPromise) {
    return mcpToolsPromise;
  }

  mcpToolsPromise = (async () => {
    const [terminalClient, playwrightClient] = await Promise.all([
      getTerminalMcpClient(),
      getPlaywrightMcpClient().catch((error) => {
        console.error("Failed to initialize Playwright MCP:", error);
        return null;
      }),
    ]);

    const terminalTools = await terminalClient.tools();
    const playwrightTools = playwrightClient
      ? await playwrightClient.tools()
      : {};

    const mergedTools = {
      ...terminalTools,
      ...playwrightTools,
    };

    mcpToolsCache = mergedTools;
    console.log(`Loaded ${Object.keys(mergedTools).length} MCP tools`);

    return mergedTools;
  })();

  return mcpToolsPromise;
}

/**
 * Manual tools that aren't MCP-based
 */
const manualTools = {
  present_artifact: tool({
    description:
      "Present an artifact (plan, diff, screenshot, etc.) to the user for review. Use this when you need to show information that's hard to convey via TTS, such as markdown plans, code diffs, or visual content",
    inputSchema: z.object({
      type: z
        .enum(["markdown", "diff", "image", "code"])
        .describe("Type of artifact to present."),
      source: z.union([
        z.object({
          type: z.literal("file"),
          path: z.string(),
        }),
        z.object({
          type: z.literal("command_output"),
          command: z.string(),
        }),
        z.object({
          type: z.literal("text"),
          text: z.string(),
        }),
      ]),
      title: z
        .string()
        .describe(
          "Title for the artifact (e.g., 'Implementation Plan', 'Refactoring Strategy', '/path/to/project/package.json')."
        ),
    }),
    execute: async () => {
      // Artifact will be broadcast by orchestrator via onToolCall callback
      // We just return a simple acknowledgment here
      return {
        success: true,
        message: "Artifact presented to user.",
      };
    },
  }),
};

/**
 * Get all tools (MCP + manual) for LLM
 */
export async function getAllTools(): Promise<Record<string, any>> {
  const mcpTools = await getMcpTools();
  return {
    ...mcpTools,
    ...manualTools,
  };
}

/**
 * Cleanup function to close MCP clients
 */
export async function closeMcpClients() {
  if (terminalMcpClient) {
    await terminalMcpClient.close();
    terminalMcpClient = null;
    console.log("Terminal MCP client closed");
  }

  if (playwrightMcpClient) {
    await playwrightMcpClient.close();
    playwrightMcpClient = null;
    console.log("Playwright MCP client closed");
  }

  mcpToolsCache = null;
  mcpToolsPromise = null;
}
