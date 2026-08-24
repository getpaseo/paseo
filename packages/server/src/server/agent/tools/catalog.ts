import { z } from "zod";
import type {
  PaseoToolCatalog,
  PaseoToolConfig,
  PaseoToolDefinition,
  PaseoToolExecutionContext,
  PaseoToolResult,
} from "./types.js";

export interface PaseoToolRegistry {
  registerTool: (
    name: string,
    config: PaseoToolConfig,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Tool handlers are schema-validated at registration boundaries.
    handler: (input: any, context: PaseoToolExecutionContext) => Promise<PaseoToolResult>,
  ) => void;
  tools: Map<string, PaseoToolDefinition>;
  toCatalog: () => PaseoToolCatalog;
}

async function parseToolInput(tool: PaseoToolDefinition, input: unknown): Promise<unknown> {
  const inputSchema = tool.inputSchema;
  if (!inputSchema) {
    return input;
  }
  const schema =
    typeof inputSchema === "object" &&
    inputSchema !== null &&
    typeof (inputSchema as { safeParseAsync?: unknown }).safeParseAsync === "function"
      ? (inputSchema as z.ZodType)
      : z.object(inputSchema as z.ZodRawShape).passthrough();
  return schema.parseAsync(input);
}

export function createPaseoToolRegistry(): PaseoToolRegistry {
  const tools = new Map<string, PaseoToolDefinition>();
  const registerTool: PaseoToolRegistry["registerTool"] = (name, config, handler) => {
    tools.set(name, {
      name,
      title: config.title,
      description: config.description ?? name,
      inputSchema: config.inputSchema,
      outputSchema: config.outputSchema,
      handler: handler as PaseoToolDefinition["handler"],
    });
  };
  const toCatalog = (): PaseoToolCatalog => ({
    tools,
    getTool(name: string): PaseoToolDefinition | undefined {
      return tools.get(name);
    },
    async executeTool(
      name: string,
      input: unknown,
      context: PaseoToolExecutionContext = {},
    ): Promise<PaseoToolResult> {
      const tool = tools.get(name);
      if (!tool) {
        throw new Error(`Paseo tool not found: ${name}`);
      }
      return tool.handler(await parseToolInput(tool, input), context);
    },
  });
  return { registerTool, tools, toCatalog };
}
