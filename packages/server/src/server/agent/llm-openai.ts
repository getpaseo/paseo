import { tool, experimental_createMCPClient, type ToolSet } from "ai";
import { z } from "zod";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createTerminalMcpServer } from "../terminal-mcp/index.js";

type McpClient = Awaited<ReturnType<typeof experimental_createMCPClient>>;

/**
 * Singleton MCP clients
 */
let terminalMcpClient: McpClient | null = null;

let playwrightMcpClient: McpClient | null = null;

/**
 * Get or create Terminal MCP client (singleton)
 */
async function getTerminalMcpClient(): Promise<McpClient> {
  if (terminalMcpClient) {
    return terminalMcpClient;
  }

  // Create Terminal MCP server
  const server = await createTerminalMcpServer({ sessionName: "__voice-dev" });

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
async function getPlaywrightMcpClient(): Promise<McpClient> {
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
let mcpToolsCache: ToolSet | null = null;
let mcpToolsPromise: Promise<ToolSet> | null = null;

async function getMcpTools(): Promise<ToolSet> {
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

    const terminalTools = (await terminalClient.tools()) as ToolSet;
    const playwrightTools: ToolSet = playwrightClient
      ? ((await playwrightClient.tools()) as ToolSet)
      : {};

    const mergedTools: ToolSet = {
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
const manualTools: ToolSet = {
  present_artifact: tool({
    description:
      "Present an artifact (plan, diff, screenshot, etc.) to the user for review. Use this when you need to show information that's hard to convey via TTS, such as markdown plans, code diffs, or visual content",
    inputSchema: z.object({
      type: z
        .enum(["markdown", "diff", "image", "code"])
        .describe("Type of artifact to present."),
      title: z
        .string()
        .describe(
          "Title for the artifact (e.g., 'Implementation Plan', 'Refactoring Strategy', '/path/to/project/package.json')."
        ),
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
 * @param terminalTools - Optional custom terminal tools (per-session). If not provided, uses global singleton.
 * @param agentTools - Optional agent tools (per-session).
 */
export async function getAllTools(
  terminalTools?: ToolSet,
  agentTools?: ToolSet
): Promise<ToolSet> {
  if (terminalTools) {
    // Use provided terminal tools (per-session) and merge with Playwright and agent tools
    const playwrightClient = await getPlaywrightMcpClient().catch((error) => {
      console.error("Failed to initialize Playwright MCP:", error);
      return null;
    });

    const playwrightTools: ToolSet = playwrightClient
      ? ((await playwrightClient.tools()) as ToolSet)
      : {};

    const combinedTools: ToolSet = {
      ...terminalTools,
      ...playwrightTools,
      ...(agentTools ?? {}),
      ...manualTools,
    };

    return combinedTools;
  }

  // Fallback to global singleton tools
  const mcpTools = await getMcpTools();
  const combinedMcpTools: ToolSet = {
    ...mcpTools,
    ...(agentTools ?? {}),
    ...manualTools,
  };
  return combinedMcpTools;
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
