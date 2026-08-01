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
  compatibility: z.enum(["ready", "offline", "upgrade_required"]).optional(),
  agentNotificationsSupported: z.boolean().optional(),
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
    // The source daemon can take delivery of a work notification for whatever
    // this tool starts in the background. Optional so an older source daemon,
    // which has nowhere to deliver one, simply omits it.
    notifyOnAgentFinish: z.boolean().optional(),
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
  // Watch whatever background agent work this tool starts and push a
  // `voice.live.agent.update` for it to this socket. The target daemon knows
  // nothing about the call the work belongs to; correlation is the client's job.
  notifyOnAgentFinish: z.boolean().optional(),
});

/**
 * One completed piece of agent work reported into a Live Voice call.
 * `reason` stays `z.string()` so a newer daemon can report outcomes an older
 * client has never heard of.
 */
export const VoiceLiveAgentNotificationSchema = z.object({
  agentId: z.string().min(1),
  title: z.string().min(1),
  reason: z.string().min(1),
  scope: z.literal("agent_turn").optional(),
  turnId: z.string().min(1).optional(),
  /** The agent's last assistant message, truncated. Null when it produced none. */
  summary: z.string().nullable(),
  /** Filled in by the client, which is the only party that knows host labels. */
  hostLabel: z.string().min(1).optional(),
  /**
   * The call did not start this work — it came from the ambient watch over
   * everything on the host. The user did not ask for it mid-conversation, so the
   * model is told it may stay silent rather than told to speak.
   *
   * A source daemon too old to know this field strips it and speaks the
   * notification as if the call had started the work. That is a louder call, not
   * a broken one, so it does not need its own capability gate.
   */
  unsolicited: z.boolean().optional(),
});

/** Target daemon -> the client socket that issued the routed tool call. */
export const VoiceLiveAgentUpdateSchema = z.object({
  type: z.literal("voice.live.agent.update"),
  payload: z.object({
    requestId: z.string().min(1),
    notification: VoiceLiveAgentNotificationSchema,
  }),
});

/**
 * Client -> a target daemon, to watch every agent on it rather than only work a
 * routed tool call started.
 *
 * Enabling is per socket and dies with it, exactly like a routed watch. The
 * daemon is still told nothing about the call: it reports to the requesting
 * socket and the client decides which call, if any, the report belongs to.
 */
export const VoiceLiveAgentWatchRequestSchema = z.object({
  type: z.literal("voice.live.agent.watch.request"),
  requestId: z.string().min(1),
  enabled: z.boolean(),
});

export const VoiceLiveAgentWatchResponseSchema = z.object({
  type: z.literal("voice.live.agent.watch.response"),
  payload: z.object({
    requestId: z.string().min(1),
    enabled: z.boolean(),
    error: VoiceLiveRouteErrorSchema.optional(),
  }),
});

/** Client -> the source daemon hosting the call, to speak the notification. */
export const VoiceLiveAgentNotifyRequestSchema = z.object({
  type: z.literal("voice.live.agent.notify.request"),
  requestId: z.string().min(1),
  liveSessionId: z.string().min(1),
  notification: VoiceLiveAgentNotificationSchema,
});

export const VoiceLiveAgentNotifyResponseSchema = z.object({
  type: z.literal("voice.live.agent.notify.response"),
  payload: z.object({
    requestId: z.string().min(1),
    delivered: z.boolean(),
    error: VoiceLiveRouteErrorSchema.optional(),
  }),
});

export const VoiceLiveToolExecuteResponseSchema = z.object({
  type: z.literal("voice.live.tool.execute.response"),
  payload: z.discriminatedUnion("ok", [
    z.object({
      requestId: z.string().min(1),
      ok: z.literal(true),
      toolResult: VoiceLiveToolResultSchema,
      backgroundAgentId: z.string().min(1).optional(),
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
export type VoiceLiveAgentNotification = z.infer<typeof VoiceLiveAgentNotificationSchema>;
export type VoiceLiveAgentUpdate = z.infer<typeof VoiceLiveAgentUpdateSchema>;
export type VoiceLiveAgentNotifyRequest = z.infer<typeof VoiceLiveAgentNotifyRequestSchema>;
export type VoiceLiveAgentNotifyResponse = z.infer<typeof VoiceLiveAgentNotifyResponseSchema>;
export type VoiceLiveAgentWatchRequest = z.infer<typeof VoiceLiveAgentWatchRequestSchema>;
export type VoiceLiveAgentWatchResponse = z.infer<typeof VoiceLiveAgentWatchResponseSchema>;
