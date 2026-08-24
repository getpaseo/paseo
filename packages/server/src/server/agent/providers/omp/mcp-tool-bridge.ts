import { z } from "zod";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { AgentSessionConfig, McpHttpServerConfig } from "../../agent-sdk-types.js";
import type {
  PaseoToolCatalog,
  PaseoToolDefinition,
  PaseoToolExecutionContext,
  PaseoToolResult,
} from "../../tools/types.js";

const MCP_BRIDGE_CLIENT_NAME = "paseo-omp-mcp-bridge";
const MCP_BRIDGE_CLIENT_VERSION = "0.0.1";

/**
 * A Paseo tool catalog backed by live MCP client connections. Callers must
 * invoke `close()` once the owning agent session ends to release the
 * underlying connections.
 */
export interface OmpMcpToolCatalog extends PaseoToolCatalog {
  close(): Promise<void>;
}

type JsonSchemaObject = Record<string, unknown>;

function isJsonSchemaObject(value: unknown): value is JsonSchemaObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// MCP tool `inputSchema` is plain JSON Schema (see the MCP `Tool` type), but
// Paseo's host-tool registration only knows how to serialize Zod schemas
// (`serializePaseoToolInputParameters` -> `normalizeObjectSchema`). Without a
// conversion, bridged tools would register as taking no parameters at all,
// which breaks structured tools like the Hub's `finish_execution`
// (classification/confidence/summary). Convert the common JSON Schema
// vocabulary MCP servers actually emit; anything unrecognized degrades to
// `z.unknown()` rather than failing the whole tool.
function jsonSchemaPropertyToZod(schema: JsonSchemaObject): z.ZodType {
  const description = typeof schema.description === "string" ? schema.description : undefined;
  const describe = (zodType: z.ZodType): z.ZodType =>
    description !== undefined ? zodType.describe(description) : zodType;

  if (Array.isArray(schema.enum) && schema.enum.every((value) => typeof value === "string")) {
    const values = schema.enum as string[];
    return describe(values.length > 0 ? z.enum(values as [string, ...string[]]) : z.string());
  }

  switch (schema.type) {
    case "string":
      return describe(z.string());
    case "number":
      return describe(z.number());
    case "integer":
      return describe(z.number().int());
    case "boolean":
      return describe(z.boolean());
    case "array": {
      const items = isJsonSchemaObject(schema.items)
        ? jsonSchemaPropertyToZod(schema.items)
        : z.unknown();
      return describe(z.array(items));
    }
    case "object":
      return describe(jsonSchemaObjectToZod(schema));
    default:
      return describe(z.unknown());
  }
}

function jsonSchemaObjectToZod(schema: JsonSchemaObject): z.ZodType {
  const properties = isJsonSchemaObject(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const shape: Record<string, z.ZodType> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!isJsonSchemaObject(value)) continue;
    const propertySchema = jsonSchemaPropertyToZod(value);
    shape[key] = required.has(key) ? propertySchema : propertySchema.optional();
  }
  return z.object(shape);
}

function toPaseoToolResult(result: Record<string, unknown>): PaseoToolResult {
  return {
    content: Array.isArray(result.content) ? (result.content as PaseoToolResult["content"]) : [],
    structuredContent: result.structuredContent,
    isError: typeof result.isError === "boolean" ? result.isError : undefined,
  };
}

function closeOmpMcpClients(clients: Client[]): Promise<void> {
  return Promise.all(clients.map((client) => client.close().catch(() => undefined))).then(
    () => undefined,
  );
}

async function collectOmpMcpToolsFromServer(
  server: McpHttpServerConfig,
  clients: Client[],
): Promise<Array<[string, PaseoToolDefinition]>> {
  const client = new Client({ name: MCP_BRIDGE_CLIENT_NAME, version: MCP_BRIDGE_CLIENT_VERSION });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: server.headers ?? {} },
    }),
  );
  clients.push(client);

  const listed = await client.listTools();
  return listed.tools.map((tool) => [
    tool.name,
    {
      name: tool.name,
      title: tool.title,
      description: tool.description ?? tool.name,
      inputSchema: jsonSchemaObjectToZod(tool.inputSchema),
      handler: (input: unknown, _context: PaseoToolExecutionContext): Promise<PaseoToolResult> =>
        client
          .callTool({
            name: tool.name,
            arguments: (input as Record<string, unknown> | undefined) ?? {},
          })
          .then(toPaseoToolResult),
    },
  ]);
}

/**
 * OMP's `rpc-ui` launch mode never surfaces MCP tools to the model directly;
 * the only channel that reaches the model is Paseo's native host-tool bridge
 * (`host-tools.ts`, driven by `runtimeSession.setHostTools`). To let MCP
 * servers injected into an execution (e.g. the Hub's `hub` server exposing
 * `reply`/`finish_execution`) reach the model at all, connect to each HTTP
 * MCP server declared on the session, list its tools, and re-expose them as
 * host tools whose handler forwards the call to the MCP client.
 *
 * ponytail: only `type: "http"` servers are bridged. The Hub only ever
 * injects `http` servers, and `stdio` servers are configured for OMP's own
 * native MCP support elsewhere; add `sse` here if a caller needs it (the SDK
 * transport is deprecated upstream, so it was left out).
 */
export async function buildOmpMcpHostTools(
  config: Pick<AgentSessionConfig, "mcpServers">,
): Promise<OmpMcpToolCatalog | null> {
  const servers = config.mcpServers;
  if (!servers || Object.keys(servers).length === 0) {
    return null;
  }

  const clients: Client[] = [];
  try {
    const tools = new Map<string, PaseoToolDefinition>();
    for (const server of Object.values(servers)) {
      if (server.type !== "http") continue;
      for (const [name, definition] of await collectOmpMcpToolsFromServer(server, clients)) {
        tools.set(name, definition);
      }
    }

    if (tools.size === 0) {
      await closeOmpMcpClients(clients);
      return null;
    }

    return {
      tools,
      getTool: (name: string): PaseoToolDefinition | undefined => tools.get(name),
      executeTool: (
        name: string,
        input: unknown,
        context?: PaseoToolExecutionContext,
      ): Promise<PaseoToolResult> => {
        const tool = tools.get(name);
        if (!tool) {
          return Promise.reject(new Error(`MCP bridge tool not found: ${name}`));
        }
        return tool.handler(input, context ?? {});
      },
      close: () => closeOmpMcpClients(clients),
    };
  } catch (error) {
    await closeOmpMcpClients(clients);
    throw error;
  }
}

/**
 * Merges two tool catalogs. The `extra` catalog (the MCP bridge) takes
 * precedence over `base` (Paseo's native tools) for tools sharing a name.
 */
export function mergeOmpToolCatalogs(
  base: PaseoToolCatalog | undefined,
  extra: PaseoToolCatalog | undefined,
): PaseoToolCatalog | undefined {
  if (!base) return extra;
  if (!extra) return base;
  const tools = new Map([...base.tools, ...extra.tools]);
  return {
    tools,
    getTool: (name: string): PaseoToolDefinition | undefined => tools.get(name),
    executeTool: (
      name: string,
      input: unknown,
      context?: PaseoToolExecutionContext,
    ): Promise<PaseoToolResult> => {
      if (extra.tools.has(name)) {
        return extra.executeTool(name, input, context);
      }
      if (base.tools.has(name)) {
        return base.executeTool(name, input, context);
      }
      return Promise.reject(new Error(`Tool not found: ${name}`));
    },
  };
}
