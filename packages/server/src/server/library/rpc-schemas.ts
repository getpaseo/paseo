import { z } from "zod";

const baseResponseError = z.object({
  requestId: z.string(),
  error: z.string().nullable(),
});

export const McpTestPayloadSchema = z.discriminatedUnion("transport", [
  z.object({
    transport: z.literal("stdio"),
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    transport: z.literal("http"),
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    transport: z.literal("sse"),
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
]);

export const LibraryMcpTestRequestSchema = z.object({
  type: z.literal("library/mcp/test"),
  requestId: z.string(),
  payload: McpTestPayloadSchema,
});

export const LibraryMcpTestResponseSchema = z.object({
  type: z.literal("library/mcp/test/response"),
  payload: baseResponseError.extend({
    ok: z.boolean(),
    durationMs: z.number().int().nonnegative(),
    tools: z.array(z.string()),
    toolCount: z.number().int().nonnegative(),
    serverInfo: z
      .object({
        name: z.string().optional(),
        version: z.string().optional(),
      })
      .optional(),
  }),
});

export type LibraryMcpTestRequest = z.infer<typeof LibraryMcpTestRequestSchema>;
export type LibraryMcpTestResponse = z.infer<typeof LibraryMcpTestResponseSchema>;
export type McpTestPayload = z.infer<typeof McpTestPayloadSchema>;

/** library/mcp/gui-sync → app pushes the MCPs flagged for hubcode-gui injection. */
export const LibraryGuiSyncEntrySchema = z.object({
  name: z.string().min(1),
  payload: McpTestPayloadSchema,
});

export const LibraryGuiSyncRequestSchema = z.object({
  type: z.literal("library/mcp/gui-sync"),
  requestId: z.string(),
  entries: z.array(LibraryGuiSyncEntrySchema),
});

export const LibraryGuiSyncResponseSchema = z.object({
  type: z.literal("library/mcp/gui-sync/response"),
  payload: baseResponseError.extend({
    count: z.number().int().nonnegative(),
  }),
});

export type LibraryGuiSyncRequest = z.infer<typeof LibraryGuiSyncRequestSchema>;
export type LibraryGuiSyncResponse = z.infer<typeof LibraryGuiSyncResponseSchema>;
export type LibraryGuiSyncEntry = z.infer<typeof LibraryGuiSyncEntrySchema>;
