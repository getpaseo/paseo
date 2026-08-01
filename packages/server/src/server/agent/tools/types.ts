import type { z } from "zod";

export interface PaseoToolExecutionContext {
  signal?: AbortSignal;
  sendUpdate?: (update: PaseoToolResult) => void;
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
  /**
   * Called when a tool leaves an agent working in the background, so a caller
   * that has no agent identity of its own (a routed Live Voice call) can still
   * learn how that work ends. Tools own the knowledge of which of them start
   * work; nothing outside has to guess from tool names or results.
   */
  onBackgroundAgentStarted?: (params: { agentId: string }) => void;
  /**
   * Flips the top-level default for tools that start agent work from blocking to
   * background. A caller that only learns an outcome through
   * {@link onBackgroundAgentStarted} has no way to survive a blocking call: the
   * tool waits, the callback never fires, and the outcome is lost. Callers that
   * can wait for a result leave this alone.
   */
  defaultAgentWorkToBackground?: boolean;
}

export type PaseoToolCatalogFactory = (
  context: PaseoToolRuntimeContext,
) => PaseoToolCatalog | Promise<PaseoToolCatalog>;
