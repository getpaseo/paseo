import type { z } from "zod";
import type { WorkspaceRuntimeAgentToolGroup } from "../../workspace-runtime/index.js";

export type PaseoToolRuntimeTarget =
  | { kind: "caller" }
  | { kind: "caller-workspace"; selectCwd?: (input: unknown) => string | undefined }
  | { kind: "workspace"; selectWorkspaceId: (input: unknown) => string | undefined }
  | { kind: "agent"; selectAgentId: (input: unknown) => string }
  | { kind: "direct-child-agent"; selectAgentId: (input: unknown) => string }
  | { kind: "terminal"; selectTerminalId: (input: unknown) => string }
  | { kind: "create-child-agent" };

export interface PaseoToolRuntimeAccess {
  group: WorkspaceRuntimeAgentToolGroup;
  target: PaseoToolRuntimeTarget;
}

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
  runtimeAccess?: PaseoToolRuntimeAccess;
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
