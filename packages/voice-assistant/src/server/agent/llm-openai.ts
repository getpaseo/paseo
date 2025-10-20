import { stepCountIs, streamText, tool } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";
import invariant from "tiny-invariant";
import { experimental_createMCPClient } from "ai";
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
 * Message interface for conversation
 */
export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Streaming LLM parameters
 */
export interface StreamLLMParams {
  systemPrompt: string;
  messages: Message[];
  abortSignal?: AbortSignal;
  onChunk?: (chunk: string) => void | Promise<void>;
  onTextSegment?: (segment: string) => void;
  onToolCall?: (
    toolCallId: string,
    toolName: string,
    args: any
  ) => Promise<void>;
  onToolResult?: (toolCallId: string, toolName: string, result: any) => void;
  onToolError?: (
    toolCallId: string,
    toolName: string,
    error: unknown
  ) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
  onFinish?: (fullText: string) => void | Promise<void>;
}

/**
 * Stream LLM response with automatic tool execution
 */
export async function streamLLM(params: StreamLLMParams): Promise<string> {
  invariant(process.env.OPENROUTER_API_KEY, "OPENROUTER_API_KEY is required");

  const openrouter = createOpenRouter({
    apiKey: process.env.OPENROUTER_API_KEY,
  });

  // Get all MCP tools and merge with manual tools
  const mcpTools = await getMcpTools();
  const allTools = {
    ...mcpTools,
    ...manualTools,
  };

  const result = await streamText({
    model: openrouter("anthropic/claude-haiku-4.5"),
    system: params.systemPrompt,
    messages: params.messages,
    tools: allTools,
    abortSignal: params.abortSignal,
    onChunk: async ({ chunk }) => {
      // console.log("onChunk", chunk);
      if (chunk.type === "text-delta") {
        // Accumulate text in buffer
        textBuffer += chunk.text;
        fullText += chunk.text;

        params.onChunk?.(chunk.text);
      } else if (chunk.type === "tool-call") {
        // Flush accumulated text as a segment before tool call
        flushTextBuffer();

        // Emit tool call event
        if (params.onToolCall) {
          await params.onToolCall(
            chunk.toolCallId,
            chunk.toolName,
            chunk.input
          );
        }
      } else if (chunk.type === "tool-result") {
        // Emit tool result event
        if (params.onToolResult) {
          params.onToolResult(chunk.toolCallId, chunk.toolName, chunk.output);
        }
      }
    },
    onError: async (error) => {
      // Emit general stream error
      if (params.onError) {
        await params.onError(error);
      }
    },
    stopWhen: stepCountIs(10),
  });

  let fullText = "";
  let textBuffer = "";

  function flushTextBuffer() {
    if (textBuffer.length > 0 && params.onTextSegment) {
      params.onTextSegment(textBuffer);
    }
    textBuffer = "";
  }

  for await (const part of result.fullStream) {
    // console.log("part", part);

    // Handle tool-error chunks (not available in onChunk callback)
    if (part.type === "tool-error") {
      if (params.onToolError) {
        await params.onToolError(part.toolCallId, part.toolName, part.error);
      }
    }
  }

  // Flush any remaining text at the end
  flushTextBuffer();

  if (params.onFinish) {
    await params.onFinish(fullText);
  }

  return fullText;
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
