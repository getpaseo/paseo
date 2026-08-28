import { beforeEach, describe, expect, test, vi } from "vitest";

import type {
  PaseoToolCatalog,
  PaseoToolDefinition,
  PaseoToolExecutionContext,
} from "../../tools/types.js";
import { buildOmpMcpHostTools, mergeOmpToolCatalogs } from "./mcp-tool-bridge.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface FakeMcpClientRecord {
  connectCalls: unknown[];
  callToolCalls: Array<{ name: string; arguments: unknown }>;
  closeCalls: number;
}

const { mcpClientInstances, mcpFixture } = vi.hoisted(() => ({
  mcpClientInstances: [] as FakeMcpClientRecord[],
  mcpFixture: {
    tools: [] as Array<{
      name: string;
      title?: string;
      description?: string;
      inputSchema: unknown;
    }>,
    callToolResult: { content: [{ type: "text", text: "ok" }] } as unknown,
  },
}));

// Mocks the two MCP SDK entry points mcp-tool-bridge.ts imports. No network:
// `connect`/`listTools`/`callTool`/`close` are recorded on `mcpClientInstances`
// so tests can assert the bridge actually drives the client, not just that it
// registers a catalog shape.
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => {
  class FakeMcpBridgeClient implements FakeMcpClientRecord {
    connectCalls: unknown[] = [];
    callToolCalls: Array<{ name: string; arguments: unknown }> = [];
    closeCalls = 0;

    constructor() {
      mcpClientInstances.push(this);
    }

    connect(transport: unknown): Promise<void> {
      this.connectCalls.push(transport);
      return Promise.resolve();
    }

    listTools(): Promise<{ tools: typeof mcpFixture.tools }> {
      return Promise.resolve({ tools: mcpFixture.tools });
    }

    callTool(params: { name: string; arguments: unknown }): Promise<unknown> {
      this.callToolCalls.push(params);
      return Promise.resolve(mcpFixture.callToolResult);
    }

    close(): Promise<void> {
      this.closeCalls += 1;
      return Promise.resolve();
    }
  }
  return { Client: FakeMcpBridgeClient };
});

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => {
  class FakeStreamableHTTPClientTransport {
    constructor(
      readonly url: URL,
      readonly options: unknown,
    ) {}
  }
  return { StreamableHTTPClientTransport: FakeStreamableHTTPClientTransport };
});

function createCatalog(tools: PaseoToolDefinition[]): PaseoToolCatalog {
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  return {
    tools: toolMap,
    getTool: (name: string) => toolMap.get(name),
    executeTool: (name: string, input: unknown, context?: PaseoToolExecutionContext) => {
      const tool = toolMap.get(name);
      if (!tool) return Promise.reject(new Error(`Tool not found: ${name}`));
      return tool.handler(input, context ?? {});
    },
  };
}

beforeEach(() => {
  mcpClientInstances.length = 0;
  mcpFixture.tools = [
    {
      name: "finish_execution",
      description: "Complete this Hub execution with a structured classification result.",
      inputSchema: {
        type: "object",
        properties: {
          classification: { type: "string", enum: ["safe", "needs_review", "blocked"] },
          confidence: { type: "number" },
          summary: { type: "string" },
        },
        required: ["classification", "confidence", "summary"],
      },
    },
  ];
  mcpFixture.callToolResult = { content: [{ type: "text", text: "ok" }] };
});

describe("buildOmpMcpHostTools", () => {
  test("returns null and connects nothing when no mcpServers are configured", async () => {
    await expect(buildOmpMcpHostTools({})).resolves.toBeNull();
    expect(mcpClientInstances).toHaveLength(0);
  });

  test("ignores non-http servers and returns null when nothing is bridged", async () => {
    const catalog = await buildOmpMcpHostTools({
      mcpServers: { local: { type: "stdio", command: "true" } },
    });
    expect(catalog).toBeNull();
    expect(mcpClientInstances).toHaveLength(0);
  });

  test("connects to http MCP servers and converts each tool's JSON Schema to Zod", async () => {
    const catalog = await buildOmpMcpHostTools({
      mcpServers: {
        hub: {
          type: "http",
          url: "http://127.0.0.1/execution",
          headers: { Authorization: "Bearer t" },
        },
      },
    });

    expect(catalog?.tools.has("finish_execution")).toBe(true);
    const definition = catalog?.getTool("finish_execution");
    expect(definition?.description).toBe(
      "Complete this Hub execution with a structured classification result.",
    );
    // The tool's actual parameters must survive conversion, not collapse to an
    // empty-object schema (see the comment on jsonSchemaObjectToZod).
    const inputSchema = definition?.inputSchema;
    if (
      !inputSchema ||
      typeof inputSchema !== "object" ||
      !("shape" in inputSchema) ||
      !isRecord(inputSchema.shape)
    ) {
      throw new Error("Expected finish_execution inputSchema to be a Zod object schema");
    }
    expect(Object.keys(inputSchema.shape).sort()).toEqual([
      "classification",
      "confidence",
      "summary",
    ]);

    expect(mcpClientInstances).toHaveLength(1);
    expect(mcpClientInstances[0].connectCalls).toHaveLength(1);
  });

  test("executeTool forwards the call to the MCP client and maps the result", async () => {
    const catalog = await buildOmpMcpHostTools({
      mcpServers: { hub: { type: "http", url: "http://127.0.0.1/execution" } },
    });

    const result = await catalog?.executeTool("finish_execution", {
      classification: "safe",
      confidence: 1,
      summary: "done",
    });

    expect(mcpClientInstances[0].callToolCalls).toEqual([
      {
        name: "finish_execution",
        arguments: { classification: "safe", confidence: 1, summary: "done" },
      },
    ]);
    expect(result).toEqual({
      content: [{ type: "text", text: "ok" }],
      structuredContent: undefined,
      isError: undefined,
    });
  });

  test("executeTool rejects for a tool the bridge never registered", async () => {
    const catalog = await buildOmpMcpHostTools({
      mcpServers: { hub: { type: "http", url: "http://127.0.0.1/execution" } },
    });
    await expect(catalog?.executeTool("no_such_tool", {})).rejects.toThrow(
      "MCP bridge tool not found: no_such_tool",
    );
  });

  test("close() closes every connected MCP client", async () => {
    const catalog = await buildOmpMcpHostTools({
      mcpServers: { hub: { type: "http", url: "http://127.0.0.1/execution" } },
    });
    await catalog?.close();
    expect(mcpClientInstances[0].closeCalls).toBe(1);
  });
});

describe("mergeOmpToolCatalogs", () => {
  test("prefers the extra (bridge) catalog when both define the same tool name", async () => {
    const base = createCatalog([
      {
        name: "shared",
        description: "base",
        handler: async () => ({ content: [{ type: "text", text: "base" }] }),
      },
    ]);
    const extra = createCatalog([
      {
        name: "shared",
        description: "extra",
        handler: async () => ({ content: [{ type: "text", text: "extra" }] }),
      },
    ]);

    const merged = mergeOmpToolCatalogs(base, extra);
    const result = await merged?.executeTool("shared", {});
    expect(result).toEqual({ content: [{ type: "text", text: "extra" }] });
  });

  test("returns the other catalog untouched when one side is missing", () => {
    const base = createCatalog([]);
    expect(mergeOmpToolCatalogs(base, undefined)).toBe(base);
    expect(mergeOmpToolCatalogs(undefined, base)).toBe(base);
  });

  test("returns undefined when both catalogs are undefined", () => {
    expect(mergeOmpToolCatalogs(undefined, undefined)).toBeUndefined();
  });
});
