import { z } from "zod";

export const McpTransportStdioSchema = z.object({
  type: z.literal("stdio"),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

export const McpTransportSseSchema = z.object({
  type: z.literal("sse"),
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const McpTransportHttpSchema = z.object({
  type: z.literal("http"),
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const McpTransportSchema = z.discriminatedUnion("type", [
  McpTransportStdioSchema,
  McpTransportSseSchema,
  McpTransportHttpSchema,
]);
export type McpTransport = z.infer<typeof McpTransportSchema>;

export const McpToolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
});
export type McpTool = z.infer<typeof McpToolSchema>;

export const McpServerSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  enabled: z.boolean(),
  transport: McpTransportSchema,
  tools: z.array(McpToolSchema).optional(),
  lastTestStatus: z.enum(["connected", "disconnected", "error", "testing"]).optional(),
  lastConnected: z.number().optional(),
  builtin: z.boolean().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  originalJson: z.string(),
});
export type McpServer = z.infer<typeof McpServerSchema>;

export const McpServerCreateInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  transport: McpTransportSchema,
  originalJson: z.string().optional(),
});
export type McpServerCreateInput = z.infer<typeof McpServerCreateInputSchema>;

export const McpServerUpdateInputSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  transport: McpTransportSchema.optional(),
  originalJson: z.string().optional(),
});
export type McpServerUpdateInput = z.infer<typeof McpServerUpdateInputSchema>;
