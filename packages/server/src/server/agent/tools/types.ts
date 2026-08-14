import type { z } from "zod";

export interface PaseoToolExecutionContext {
  signal?: AbortSignal;
  sendUpdate?: (update: PaseoToolResult) => void;
  /**
   * The MCP JSON-RPC request id of this tool call, type-tagged (`n:<number>`
   * or `s:<string>`) so numeric and string ids never collide. Tools use it as
   * the durable identity of lifecycle operations they start.
   */
  requestId?: string;
  /**
   * The MCP transport session id, when the transport provides one. Combined
   * with requestId it scopes the identity across connections; without it,
   * uniqueness holds only within one transport session.
   */
  sessionId?: string;
}

export interface PaseoToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: unknown;
  isError?: boolean;
}

export interface PaseoToolConfig {
  title?: string;
  description?: string;
  inputSchema?: z.ZodRawShape | z.ZodType;
  outputSchema?: z.ZodRawShape;
}

export interface PaseoToolDefinition extends PaseoToolConfig {
  name: string;
  description: string;
  handler: (input: unknown, context: PaseoToolExecutionContext) => Promise<PaseoToolResult>;
}

export interface PaseoToolCatalog {
  tools: ReadonlyMap<string, PaseoToolDefinition>;
  getTool(name: string): PaseoToolDefinition | undefined;
  executeTool(
    name: string,
    input: unknown,
    context?: PaseoToolExecutionContext,
  ): Promise<PaseoToolResult>;
}

export interface PaseoToolRuntimeContext {
  callerAgentId?: string;
  enableVoiceTools?: boolean;
  voiceOnly?: boolean;
}

export type PaseoToolCatalogFactory = (
  context: PaseoToolRuntimeContext,
) => PaseoToolCatalog | Promise<PaseoToolCatalog>;
