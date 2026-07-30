import { z } from "zod";

/**
 * Values that can cross the two WebSocket hops used by Live Voice routing.
 * This excludes values such as `undefined`, `bigint`, and platform objects that
 * JSON serialization would silently corrupt.
 */
export const LiveVoiceJsonValueSchema = z.json();

export const LiveVoiceJsonObjectSchema = z.record(z.string(), LiveVoiceJsonValueSchema);

export const VoiceLiveToolResultSchema = z.object({
  content: z.array(LiveVoiceJsonValueSchema),
  structuredContent: LiveVoiceJsonValueSchema.optional(),
  isError: z.boolean().optional(),
});

export const VoiceLiveRouteHostSchema = z.object({
  serverId: z.string().min(1),
  label: z.string().min(1),
  hostname: z.string().nullable(),
  version: z.string().nullable(),
  online: z.boolean(),
  toolExecutionSupported: z.boolean(),
});

export const VoiceLiveRouteOperationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("list_hosts"),
  }),
  z.object({
    kind: z.literal("execute_tool"),
    targetServerId: z.string().min(1),
    toolName: z.string().min(1),
    arguments: LiveVoiceJsonObjectSchema,
  }),
]);

export const VoiceLiveRouteRequestSchema = z.object({
  type: z.literal("voice.live.route.request"),
  requestId: z.string().min(1),
  liveSessionId: z.string().min(1),
  operation: VoiceLiveRouteOperationSchema,
});

export const VoiceLiveRouteErrorSchema = z.object({
  // Deliberately open so newer peers can add error codes without breaking old clients.
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean().optional(),
});

export const VoiceLiveRouteResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("list_hosts"),
    hosts: z.array(VoiceLiveRouteHostSchema),
  }),
  z.object({
    kind: z.literal("execute_tool"),
    targetServerId: z.string().min(1),
    toolResult: VoiceLiveToolResultSchema,
  }),
]);

export const VoiceLiveRouteResponseSchema = z.object({
  type: z.literal("voice.live.route.response"),
  payload: z.discriminatedUnion("ok", [
    z.object({
      requestId: z.string().min(1),
      liveSessionId: z.string().min(1),
      ok: z.literal(true),
      result: VoiceLiveRouteResultSchema,
    }),
    z.object({
      requestId: z.string().min(1),
      liveSessionId: z.string().min(1),
      ok: z.literal(false),
      error: VoiceLiveRouteErrorSchema,
    }),
  ]),
});

export const VoiceLiveToolExecuteRequestSchema = z.object({
  type: z.literal("voice.live.tool.execute.request"),
  requestId: z.string().min(1),
  toolName: z.string().min(1),
  arguments: LiveVoiceJsonObjectSchema,
});

export const VoiceLiveToolExecuteResponseSchema = z.object({
  type: z.literal("voice.live.tool.execute.response"),
  payload: z.discriminatedUnion("ok", [
    z.object({
      requestId: z.string().min(1),
      ok: z.literal(true),
      toolResult: VoiceLiveToolResultSchema,
    }),
    z.object({
      requestId: z.string().min(1),
      ok: z.literal(false),
      error: VoiceLiveRouteErrorSchema,
    }),
  ]),
});

export type LiveVoiceJsonValue = z.infer<typeof LiveVoiceJsonValueSchema>;
export type LiveVoiceJsonObject = z.infer<typeof LiveVoiceJsonObjectSchema>;
export type VoiceLiveToolResult = z.infer<typeof VoiceLiveToolResultSchema>;
export type VoiceLiveRouteHost = z.infer<typeof VoiceLiveRouteHostSchema>;
export type VoiceLiveRouteOperation = z.infer<typeof VoiceLiveRouteOperationSchema>;
export type VoiceLiveRouteRequest = z.infer<typeof VoiceLiveRouteRequestSchema>;
export type VoiceLiveRouteError = z.infer<typeof VoiceLiveRouteErrorSchema>;
export type VoiceLiveRouteResult = z.infer<typeof VoiceLiveRouteResultSchema>;
export type VoiceLiveRouteResponse = z.infer<typeof VoiceLiveRouteResponseSchema>;
export type VoiceLiveToolExecuteRequest = z.infer<typeof VoiceLiveToolExecuteRequestSchema>;
export type VoiceLiveToolExecuteResponse = z.infer<typeof VoiceLiveToolExecuteResponseSchema>;
