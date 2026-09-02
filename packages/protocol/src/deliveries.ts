import { z } from "zod";

/** A JSON value retained until the receiving principal acknowledges delivery. */
export const DeliveryPayloadSchema = z.json();
export type DeliveryPayload = z.infer<typeof DeliveryPayloadSchema>;

// zod-aot cannot compile the recursive z.json() schema when it is nested in
// the large WebSocket union. The WebSocket transport is already JSON.parse'd;
// retain the strict schema above for persistence and direct consumers while
// using this typed structural escape hatch for generated wire validation.
const DeliveryPayloadWireSchema = z.unknown() as z.ZodType<DeliveryPayload>;

export const DeliveryIdSchema = z.string().trim().min(1).max(256);

export const DeliveryRecordSchema = z
  .object({
    deliveryId: DeliveryIdSchema,
    payload: DeliveryPayloadSchema,
    createdAt: z.string(),
    acknowledgedAt: z.string().nullable(),
  })
  .passthrough();

export type DeliveryRecord = z.infer<typeof DeliveryRecordSchema>;

const DeliveryRecordWireSchema = z
  .object({
    deliveryId: DeliveryIdSchema,
    payload: DeliveryPayloadWireSchema,
    createdAt: z.string(),
    acknowledgedAt: z.string().nullable(),
  })
  .passthrough() as z.ZodType<DeliveryRecord>;

export const DeliveriesSendRequestSchema = z.object({
  type: z.literal("deliveries.send.request"),
  requestId: z.string(),
  deliveryId: DeliveryIdSchema.optional(),
  payload: DeliveryPayloadSchema,
});

export type DeliveriesSendRequest = z.infer<typeof DeliveriesSendRequestSchema>;

export const DeliveriesGetRequestSchema = z.object({
  type: z.literal("deliveries.get.request"),
  requestId: z.string(),
  deliveryId: DeliveryIdSchema.optional(),
  includeAcknowledged: z.boolean().optional(),
  cursor: DeliveryIdSchema.optional(),
  limit: z.number().int().positive().max(1000).optional(),
});

export type DeliveriesGetRequest = z.infer<typeof DeliveriesGetRequestSchema>;

export const DeliveriesAcknowledgeRequestSchema = z.object({
  type: z.literal("deliveries.acknowledge.request"),
  requestId: z.string(),
  deliveryId: DeliveryIdSchema,
});

export type DeliveriesAcknowledgeRequest = z.infer<typeof DeliveriesAcknowledgeRequestSchema>;

export const DeliveriesSendResponseSchema = z.object({
  type: z.literal("deliveries.send.response"),
  payload: z.object({
    requestId: z.string(),
    deliveryId: DeliveryIdSchema,
    delivery: DeliveryRecordWireSchema,
    created: z.boolean(),
  }),
});

export type DeliveriesSendResponse = z.infer<typeof DeliveriesSendResponseSchema>;

export const DeliveriesGetResponseSchema = z.object({
  type: z.literal("deliveries.get.response"),
  payload: z.object({
    requestId: z.string(),
    delivery: DeliveryRecordWireSchema.nullable(),
    deliveries: z.array(DeliveryRecordWireSchema),
    nextCursor: DeliveryIdSchema.nullable(),
  }),
});

export type DeliveriesGetResponse = z.infer<typeof DeliveriesGetResponseSchema>;

export const DeliveriesAcknowledgeResponseSchema = z.object({
  type: z.literal("deliveries.acknowledge.response"),
  payload: z.object({
    requestId: z.string(),
    deliveryId: DeliveryIdSchema,
    delivery: DeliveryRecordWireSchema,
  }),
});

export type DeliveriesAcknowledgeResponse = z.infer<typeof DeliveriesAcknowledgeResponseSchema>;
