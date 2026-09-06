import { z } from "zod";

export const VoiceAppContextSchema = z.object({
  workspaceId: z.string().nullable(),
  agentId: z.string().nullable(),
});

export const VoiceCallStartRequestSchema = z.object({
  type: z.literal("voice.call.start.request"),
  requestId: z.string(),
  context: VoiceAppContextSchema,
  // COMPAT(voiceCallTransportOffers): added in v0.3, optional so old clients still parse.
  transports: z
    .array(
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("daemon-audio") }),
        z.object({ kind: z.literal("webrtc"), offerSdp: z.string().min(1) }),
      ]),
    )
    .optional(),
});

export const VoiceCallTransportSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("daemon-audio") }),
  z.object({ kind: z.literal("webrtc"), answerSdp: z.string().min(1) }),
]);

export const VoiceCallStartResponseSchema = z.object({
  type: z.literal("voice.call.start.response"),
  payload: z.object({
    requestId: z.string(),
    accepted: z.boolean(),
    callId: z.string().nullable(),
    transport: VoiceCallTransportSchema.optional(),
    error: z.string().nullable(),
  }),
});

export const VoiceCallStopRequestSchema = z.object({
  type: z.literal("voice.call.stop.request"),
  requestId: z.string(),
  callId: z.string(),
});

export const VoiceCallStopResponseSchema = z.object({
  type: z.literal("voice.call.stop.response"),
  payload: z.object({
    requestId: z.string(),
    callId: z.string(),
    accepted: z.boolean(),
    error: z.string().nullable(),
  }),
});

export const VoiceCallContextUpdateRequestSchema = z.object({
  type: z.literal("voice.call.context.update.request"),
  requestId: z.string(),
  callId: z.string(),
  context: VoiceAppContextSchema,
});

export const VoiceCallContextUpdateResponseSchema = z.object({
  type: z.literal("voice.call.context.update.response"),
  payload: z.object({
    requestId: z.string(),
    callId: z.string(),
    accepted: z.boolean(),
    error: z.string().nullable(),
  }),
});

export const VoiceCallClientTransportMessageSchema = z.object({
  type: z.literal("voice.call.transport.client"),
  callId: z.string(),
  data: z.unknown(),
});

export const VoiceCallInboundMessageSchema = z.discriminatedUnion("type", [
  VoiceCallStartRequestSchema,
  VoiceCallStopRequestSchema,
  VoiceCallContextUpdateRequestSchema,
  VoiceCallClientTransportMessageSchema,
]);

export const VoiceCallStateSchema = z.object({
  callId: z.string(),
  lifecycle: z.enum(["active", "ended", "failed"]),
  input: z.enum(["idle", "listening", "speech_detected"]),
  error: z.string().nullable(),
});

export const VoiceCallStateMessageSchema = z.object({
  type: z.literal("voice.call.state"),
  payload: VoiceCallStateSchema,
});

export const VoiceCallTranscriptEventSchema = z.object({
  type: z.literal("transcript"),
  id: z.string(),
  speaker: z.enum(["user", "assistant"]),
  text: z.string(),
  final: z.boolean(),
});

export const VoiceCallActivityEventSchema = z.object({
  type: z.literal("activity"),
  id: z.string(),
  label: z.string(),
  state: z.enum(["running", "completed", "failed"]),
});

export const VoiceCallNoticeEventSchema = z.object({
  type: z.literal("notice"),
  id: z.string(),
  text: z.string(),
});

export const VoiceCallErrorEventSchema = z.object({
  type: z.literal("error"),
  id: z.string(),
  message: z.string(),
});

export const VoiceCallEventSchema = z.discriminatedUnion("type", [
  VoiceCallTranscriptEventSchema,
  VoiceCallActivityEventSchema,
  VoiceCallNoticeEventSchema,
  VoiceCallErrorEventSchema,
]);

export const VoiceCallEventMessageSchema = z.object({
  type: z.literal("voice.call.event"),
  payload: z.object({
    callId: z.string(),
    event: VoiceCallEventSchema,
  }),
});

export const VoiceCallServerTransportMessageSchema = z.object({
  type: z.literal("voice.call.transport.server"),
  payload: z.object({
    callId: z.string(),
    data: z.unknown(),
  }),
});

export const VoiceCallOutboundMessageSchema = z.discriminatedUnion("type", [
  VoiceCallStartResponseSchema,
  VoiceCallStopResponseSchema,
  VoiceCallContextUpdateResponseSchema,
  VoiceCallStateMessageSchema,
  VoiceCallEventMessageSchema,
  VoiceCallServerTransportMessageSchema,
]);

export type VoiceAppContext = z.infer<typeof VoiceAppContextSchema>;
export type VoiceCallInboundMessage = z.infer<typeof VoiceCallInboundMessageSchema>;
export type VoiceCallOutboundMessage = z.infer<typeof VoiceCallOutboundMessageSchema>;
export type VoiceCallState = z.infer<typeof VoiceCallStateSchema>;
export type VoiceCallEvent = z.infer<typeof VoiceCallEventSchema>;
export type VoiceCallTransport = z.infer<typeof VoiceCallTransportSchema>;
export type VoiceCallTransportOffer = NonNullable<
  z.infer<typeof VoiceCallStartRequestSchema>["transports"]
>[number];
export type VoiceCallClientTransportMessage = z.infer<typeof VoiceCallClientTransportMessageSchema>;
export type VoiceCallServerTransportMessage = z.infer<typeof VoiceCallServerTransportMessageSchema>;
