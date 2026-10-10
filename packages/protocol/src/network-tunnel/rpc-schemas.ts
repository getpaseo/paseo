import { z } from "zod";
import { CLIENT_CAPS } from "../client-capabilities.js";
export const TUNNEL_INITIAL_WINDOW_BYTES = 262144;
export const TUNNEL_MAX_DATA_BYTES = 65536;
export const TUNNEL_MAX_STREAMS = 64;
export const TUNNEL_CONNECT_TIMEOUT_MS = 10000;

// Accepting this capability also means accepting network.proxy in permission envelopes.
export const NETWORK_TUNNEL_CAPABILITY = CLIENT_CAPS.networkTunnel;

export const NetworkTunnelRpcErrorSchema = z.object({
  code: z.enum([
    "permission_denied",
    "unsupported_capability",
    "resource_limit",
    "not_found",
    "internal_error",
  ]),
  message: z.string(),
});

export const NetworkTunnelLimitsSchema = z.object({
  initialWindowBytes: z.number().int().positive(),
  maxDataBytes: z.number().int().positive(),
  maxStreams: z.number().int().positive(),
  connectTimeoutMs: z.number().int().positive(),
});

const RequestIdSchema = z.string().min(1);
const SubscriptionIdSchema = z.uuid();
const FailurePayloadSchema = z.object({
  requestId: RequestIdSchema,
  ok: z.literal(false),
  error: NetworkTunnelRpcErrorSchema,
});

export const NetworkTunnelOpenRequestSchema = z.object({
  type: z.literal("network.tunnel.open.request"),
  requestId: RequestIdSchema,
});

export const NetworkTunnelOpenResponseSchema = z.object({
  type: z.literal("network.tunnel.open.response"),
  // zod-aot 0.20.4 stringifies boolean discriminators; the generated-envelope
  // regression tests cover this sequential union (protocol-validation.md).
  payload: z.union([
    NetworkTunnelLimitsSchema.extend({
      requestId: RequestIdSchema,
      ok: z.literal(true),
      subscriptionId: SubscriptionIdSchema,
    }),
    FailurePayloadSchema,
  ]),
});

export const NetworkTunnelCloseRequestSchema = z.object({
  type: z.literal("network.tunnel.close.request"),
  requestId: RequestIdSchema,
  subscriptionId: SubscriptionIdSchema,
});

export const NetworkTunnelCloseResponseSchema = z.object({
  type: z.literal("network.tunnel.close.response"),
  // zod-aot 0.20.4 stringifies boolean discriminators; the generated-envelope
  // regression tests cover this sequential union (protocol-validation.md).
  payload: z.union([
    z.object({
      requestId: RequestIdSchema,
      ok: z.literal(true),
      subscriptionId: SubscriptionIdSchema,
    }),
    FailurePayloadSchema,
  ]),
});

export const NetworkTunnelClosedReasonSchema = z.enum([
  "revoked",
  "protocol_error",
  "resource_limit",
  "internal_error",
]);

export const NetworkTunnelClosedMessageSchema = z.object({
  type: z.literal("network.tunnel.closed"),
  payload: z.object({
    subscriptionId: SubscriptionIdSchema,
    reason: NetworkTunnelClosedReasonSchema,
  }),
});

export type NetworkTunnelLimits = z.infer<typeof NetworkTunnelLimitsSchema>;
export type NetworkTunnelRpcError = z.infer<typeof NetworkTunnelRpcErrorSchema>;
export type NetworkTunnelOpenRequest = z.infer<typeof NetworkTunnelOpenRequestSchema>;
export type NetworkTunnelOpenResponse = z.infer<typeof NetworkTunnelOpenResponseSchema>;
export type NetworkTunnelCloseRequest = z.infer<typeof NetworkTunnelCloseRequestSchema>;
export type NetworkTunnelCloseResponse = z.infer<typeof NetworkTunnelCloseResponseSchema>;
export type NetworkTunnelClosedReason = z.infer<typeof NetworkTunnelClosedReasonSchema>;
export type NetworkTunnelClosedMessage = z.infer<typeof NetworkTunnelClosedMessageSchema>;
