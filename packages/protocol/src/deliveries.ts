import { z } from "zod";

export { MAX_DELIVERY_RESPONSE_BYTES, MAX_WEBSOCKET_MESSAGE_BYTES } from "./transport-limits.js";

/** Keep delivery frames small enough that one queued item cannot monopolize a socket. */
export const MAX_DELIVERY_PAYLOAD_BYTES = 64 * 1024;
export const MAX_DELIVERY_STRING_BYTES = 16 * 1024;
export const MAX_DELIVERY_PAYLOAD_DEPTH = 32;
export const MAX_DELIVERY_PAYLOAD_NODES = 10_000;
export const MAX_DELIVERY_PAGE_SIZE = 100;
export const MAX_DELIVERY_ID_BYTES = 256;
/** New SDK-generated request IDs are bounded; the wire remains legacy-compatible. */
export const MAX_DELIVERY_REQUEST_ID_BYTES = 256;

export interface DeliveryPayloadLimits {
  maxBytes?: number;
  maxStringBytes?: number;
  maxDepth?: number;
  maxNodes?: number;
}

export type DeliveryPayload =
  | null
  | boolean
  | number
  | string
  | DeliveryPayload[]
  | { [key: string]: DeliveryPayload };

export interface DeliveryPayloadValidationResult {
  ok: boolean;
  reason?:
    | "invalid_json"
    | "payload_too_large"
    | "string_too_large"
    | "depth_exceeded"
    | "nodes_exceeded"
    | "dangerous_key";
  bytes?: number;
}

const textEncoder = new TextEncoder();

function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

/**
 * Validate a JSON value without recursively invoking Zod. Incoming WebSocket
 * data is already parsed before the generated wire validator runs, so this
 * iterative walk is also the stack-safe guard used by the server and ledger.
 */
interface DeliveryPayloadStackItem {
  value: unknown;
  depth: number;
  leave?: boolean;
}

function inspectDeliveryNode(
  current: unknown,
  depth: number,
  maxDepth: number,
  maxStringBytes: number,
  active: Set<object>,
  stack: DeliveryPayloadStackItem[],
): DeliveryPayloadValidationResult | null {
  if (depth > maxDepth) return { ok: false, reason: "depth_exceeded" };
  if (typeof current === "string") {
    return utf8ByteLength(current) > maxStringBytes
      ? { ok: false, reason: "string_too_large" }
      : null;
  }
  if (current === null || typeof current === "boolean") return null;
  if (typeof current === "number") {
    return Number.isFinite(current) ? null : { ok: false, reason: "invalid_json" };
  }
  if (typeof current !== "object") return { ok: false, reason: "invalid_json" };
  if (active.has(current)) return { ok: false, reason: "invalid_json" };
  active.add(current);
  stack.push({ value: current, depth, leave: true });

  if (Array.isArray(current)) {
    for (let index = current.length - 1; index >= 0; index -= 1) {
      stack.push({ value: current[index], depth: depth + 1 });
    }
    return null;
  }
  const prototype = Object.getPrototypeOf(current);
  if (prototype !== Object.prototype && prototype !== null) {
    return { ok: false, reason: "invalid_json" };
  }
  for (const [key, child] of Object.entries(current).toReversed()) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      return { ok: false, reason: "dangerous_key" };
    }
    if (utf8ByteLength(key) > maxStringBytes) {
      return { ok: false, reason: "string_too_large" };
    }
    stack.push({ value: child, depth: depth + 1 });
  }
  return null;
}

export function inspectDeliveryPayload(
  value: unknown,
  limits: DeliveryPayloadLimits = {},
): DeliveryPayloadValidationResult {
  const maxBytes = limits.maxBytes ?? MAX_DELIVERY_PAYLOAD_BYTES;
  const maxStringBytes = limits.maxStringBytes ?? MAX_DELIVERY_STRING_BYTES;
  const maxDepth = limits.maxDepth ?? MAX_DELIVERY_PAYLOAD_DEPTH;
  const maxNodes = limits.maxNodes ?? MAX_DELIVERY_PAYLOAD_NODES;
  const active = new Set<object>();
  const stack: DeliveryPayloadStackItem[] = [{ value, depth: 0 }];
  let nodes = 0;

  try {
    while (stack.length > 0) {
      const item = stack.pop();
      if (!item) continue;
      if (item.leave) {
        if (typeof item.value === "object" && item.value !== null) {
          active.delete(item.value);
        }
        continue;
      }
      nodes += 1;
      if (nodes > maxNodes) return { ok: false, reason: "nodes_exceeded" };
      const failure = inspectDeliveryNode(
        item.value,
        item.depth,
        maxDepth,
        maxStringBytes,
        active,
        stack,
      );
      if (failure) return failure;
    }
  } catch {
    return { ok: false, reason: "invalid_json" };
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  if (serialized === undefined) return { ok: false, reason: "invalid_json" };
  const bytes = utf8ByteLength(serialized);
  if (bytes > maxBytes) return { ok: false, reason: "payload_too_large", bytes };
  return { ok: true, bytes };
}

export function isDeliveryPayload(value: unknown): value is DeliveryPayload {
  return inspectDeliveryPayload(value).ok;
}

export class DeliveryPayloadValidationError extends Error {
  readonly code = "delivery_payload_invalid" as const;

  constructor(readonly reason: NonNullable<DeliveryPayloadValidationResult["reason"]>) {
    super(`Invalid delivery payload: ${reason.replaceAll("_", " ")}`);
    this.name = "DeliveryPayloadValidationError";
  }
}

export function assertDeliveryPayload(
  value: unknown,
  limits?: DeliveryPayloadLimits,
): asserts value is DeliveryPayload {
  const result = inspectDeliveryPayload(value, limits);
  if (!result.ok) {
    throw new DeliveryPayloadValidationError(result.reason ?? "invalid_json");
  }
}

/** A JSON value retained until the receiving principal acknowledges delivery. */
// This custom schema stays out of the generated WebSocket validator; the
// server calls assertDeliveryPayload after its raw-frame size check.
export const DeliveryPayloadSchema = z.custom<DeliveryPayload>(isDeliveryPayload, {
  message: "Expected a bounded JSON value",
});

// zod-aot cannot compile the recursive JSON schema when it is nested in the
// large WebSocket union. The transport performs the bounded validation after
// JSON.parse; retain this structural escape hatch for generated wire output.
const DeliveryPayloadWireSchema = z.unknown() as z.ZodType<DeliveryPayload>;

export const DeliveryIdSchema = z.string().trim().min(1).max(MAX_DELIVERY_ID_BYTES);
export const DeliveryTargetAgentIdSchema = z.string().trim().min(1).max(MAX_DELIVERY_ID_BYTES);
export const DeliveryMessageIdSchema = z.string().trim().min(1).max(MAX_DELIVERY_ID_BYTES);
// The wire accepts legacy cursor strings so an old peer still parses the
// request. The ledger only accepts sequence cursors and never interprets one
// as a delivery ID.
export const DeliveryCursorSchema = z.string().trim().min(1).max(MAX_DELIVERY_ID_BYTES);
export const DeliverySequenceCursorSchema = DeliveryCursorSchema.regex(/^seq:[1-9]\d*$/).refine(
  (cursor) => Number.isSafeInteger(Number(cursor.slice(4))),
  { message: "Expected a safe delivery sequence cursor" },
);

export const DeliveryStatusSchema = z.enum([
  "recorded",
  "dispatching",
  "accepted",
  "failed",
  "ambiguous",
  "acknowledged",
]);
export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>;
// A descriptive alias for callers that model this as a state machine.
export type DeliveryState = DeliveryStatus;

export const DeliveryModeSchema = z.enum(["targeted", "legacy_pull"]);
export type DeliveryMode = z.infer<typeof DeliveryModeSchema>;

export const DeliveryRecordSchema = z
  .object({
    deliveryId: DeliveryIdSchema,
    // COMPAT(durableDeliverySequence): old records are assigned a sequence
    // deterministically while loading.
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    // COMPAT(durableDeliveryTarget): optional for records written by the
    // initial principal-scoped pull ledger.
    targetAgentId: DeliveryTargetAgentIdSchema.optional(),
    // COMPAT(durableDeliveryMessageId): old records use deliveryId implicitly.
    messageId: DeliveryMessageIdSchema.optional(),
    // COMPAT(durableDeliveryState): old records predate native dispatch.
    status: DeliveryStatusSchema.optional(),
    // COMPAT(legacyPullDelivery): version-1 pull records are explicitly
    // acknowledged pull state after migration; new records are targeted.
    deliveryMode: DeliveryModeSchema.optional(),
    // Acknowledged records may be compacted to a tombstone after retention.
    payload: DeliveryPayloadSchema.optional(),
    payloadFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    // Only clients advertising deliveryPayloadTombstones may admit records
    // whose acknowledged payload can later be compacted.
    payloadTombstoneEligible: z.boolean().optional(),
    createdAt: z.string(),
    dispatchingAt: z.string().nullable().optional(),
    acceptedAt: z.string().nullable().optional(),
    failedAt: z.string().nullable().optional(),
    ambiguousAt: z.string().nullable().optional(),
    error: z.string().nullable().optional(),
    acknowledgedAt: z.string().nullable(),
  })
  .passthrough();

export type DeliveryRecord = z.infer<typeof DeliveryRecordSchema>;

const DeliveryRecordWireSchema = z
  .object({
    deliveryId: DeliveryIdSchema,
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    targetAgentId: DeliveryTargetAgentIdSchema.optional(),
    messageId: DeliveryMessageIdSchema.optional(),
    status: DeliveryStatusSchema.optional(),
    deliveryMode: DeliveryModeSchema.optional(),
    payload: DeliveryPayloadWireSchema.optional(),
    payloadFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    payloadTombstoneEligible: z.boolean().optional(),
    createdAt: z.string(),
    dispatchingAt: z.string().nullable().optional(),
    acceptedAt: z.string().nullable().optional(),
    failedAt: z.string().nullable().optional(),
    ambiguousAt: z.string().nullable().optional(),
    error: z.string().nullable().optional(),
    acknowledgedAt: z.string().nullable(),
  })
  .passthrough() as z.ZodType<DeliveryRecord>;

export const DeliveriesSendRequestSchema = z.object({
  type: z.literal("deliveries.send.request"),
  // Keep this unbounded at the schema layer: older clients generated longer
  // request IDs that were valid as long as the complete WS frame was bounded.
  requestId: z.string().min(1),
  deliveryId: DeliveryIdSchema.optional(),
  // COMPAT(durableDeliveryTarget): old pull-only clients may omit this field.
  targetAgentId: DeliveryTargetAgentIdSchema.optional(),
  messageId: DeliveryMessageIdSchema.optional(),
  payload: DeliveryPayloadSchema,
});

export type DeliveriesSendRequest = z.infer<typeof DeliveriesSendRequestSchema>;

export const DeliveriesGetRequestSchema = z.object({
  type: z.literal("deliveries.get.request"),
  requestId: z.string().min(1),
  deliveryId: DeliveryIdSchema.optional(),
  includeAcknowledged: z.boolean().optional(),
  cursor: DeliveryCursorSchema.optional(),
  limit: z.number().int().positive().max(MAX_DELIVERY_PAGE_SIZE).optional(),
});

export type DeliveriesGetRequest = z.infer<typeof DeliveriesGetRequestSchema>;

export const DeliveriesAcknowledgeRequestSchema = z.object({
  type: z.literal("deliveries.acknowledge.request"),
  requestId: z.string().min(1),
  deliveryId: DeliveryIdSchema,
});

export type DeliveriesAcknowledgeRequest = z.infer<typeof DeliveriesAcknowledgeRequestSchema>;

export const DeliveriesSendResponseSchema = z.object({
  type: z.literal("deliveries.send.response"),
  payload: z.object({
    requestId: z.string().min(1),
    deliveryId: DeliveryIdSchema,
    delivery: DeliveryRecordWireSchema,
    created: z.boolean(),
  }),
});

export type DeliveriesSendResponse = z.infer<typeof DeliveriesSendResponseSchema>;

export const DeliveriesGetResponseSchema = z.object({
  type: z.literal("deliveries.get.response"),
  payload: z.object({
    requestId: z.string().min(1),
    delivery: DeliveryRecordWireSchema.nullable(),
    deliveries: z.array(DeliveryRecordWireSchema),
    nextCursor: DeliveryCursorSchema.nullable(),
  }),
});

export type DeliveriesGetResponse = z.infer<typeof DeliveriesGetResponseSchema>;

export const DeliveriesAcknowledgeResponseSchema = z.object({
  type: z.literal("deliveries.acknowledge.response"),
  payload: z.object({
    requestId: z.string().min(1),
    deliveryId: DeliveryIdSchema,
    delivery: DeliveryRecordWireSchema,
  }),
});

export type DeliveriesAcknowledgeResponse = z.infer<typeof DeliveriesAcknowledgeResponseSchema>;
