import { z } from "zod";
import {
  McpServerSchema,
  McpServerCreateInputSchema,
  McpServerUpdateInputSchema,
} from "./types.js";

const McpResponsePayloadSchema = z.object({
  requestId: z.string(),
  server: McpServerSchema.nullable(),
  error: z.string().nullable(),
});

export const McpListRequestSchema = z.object({
  type: z.literal("mcp.list.request"),
  requestId: z.string(),
});

export const McpListResponseSchema = z.object({
  type: z.literal("mcp.list.response"),
  payload: z.object({
    requestId: z.string(),
    servers: z.array(McpServerSchema),
    error: z.string().nullable(),
  }),
});

export const McpCreateRequestSchema = z.object({
  type: z.literal("mcp.create.request"),
  requestId: z.string(),
  server: McpServerCreateInputSchema,
});

export const McpCreateResponseSchema = z.object({
  type: z.literal("mcp.create.response"),
  payload: McpResponsePayloadSchema,
});

export const McpUpdateRequestSchema = z.object({
  type: z.literal("mcp.update.request"),
  requestId: z.string(),
  server: McpServerUpdateInputSchema,
});

export const McpUpdateResponseSchema = z.object({
  type: z.literal("mcp.update.response"),
  payload: McpResponsePayloadSchema,
});

export const McpDeleteRequestSchema = z.object({
  type: z.literal("mcp.delete.request"),
  requestId: z.string(),
  id: z.string().min(1),
});

export const McpDeleteResponseSchema = z.object({
  type: z.literal("mcp.delete.response"),
  payload: z.object({
    requestId: z.string(),
    id: z.string(),
    ok: z.boolean(),
    error: z.string().nullable(),
  }),
});

export const McpTestConnectionRequestSchema = z.object({
  type: z.literal("mcp.test_connection.request"),
  requestId: z.string(),
  id: z.string().min(1),
});

export const McpTestConnectionResponseSchema = z.object({
  type: z.literal("mcp.test_connection.response"),
  payload: z.object({
    requestId: z.string(),
    status: z.enum(["connected", "error"]),
    tools: z.array(z.object({ name: z.string(), description: z.string().optional() })).optional(),
    error: z.string().nullable(),
  }),
});

export const McpChangedMessageSchema = z.object({
  type: z.literal("mcp.changed"),
  payload: z.object({
    servers: z.array(McpServerSchema),
  }),
});
