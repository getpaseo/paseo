import { describe, expect, test } from "vitest";
import {
  DeliveriesAcknowledgeRequestSchema,
  DeliveriesGetRequestSchema,
  DeliveriesSendRequestSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";
import {
  DeliveryPayloadSchema,
  inspectDeliveryPayload,
  MAX_DELIVERY_REQUEST_ID_BYTES,
  MAX_DELIVERY_PAYLOAD_BYTES,
  MAX_DELIVERY_RESPONSE_BYTES,
  MAX_WEBSOCKET_MESSAGE_BYTES,
} from "./deliveries.js";
import { CLIENT_CAPS } from "./client-capabilities.js";

const pendingDelivery = {
  deliveryId: "delivery-one",
  payload: { kind: "notification", count: 1 },
  createdAt: "2026-09-01T00:00:00.000Z",
  acknowledgedAt: null,
};

describe("durable delivery protocol", () => {
  test("registers namespaced requests and responses in the session unions", () => {
    const request = {
      type: "deliveries.send.request",
      requestId: "request-one",
      deliveryId: "delivery-one",
      payload: { hello: "world" },
    };
    const response = {
      type: "deliveries.send.response",
      payload: {
        requestId: "request-one",
        deliveryId: "delivery-one",
        delivery: pendingDelivery,
        created: true,
      },
    };

    expect(SessionInboundMessageSchema.parse(request)).toEqual(request);
    expect(SessionOutboundMessageSchema.parse(response)).toEqual(response);
  });

  test("keeps get and acknowledgement payloads JSON-safe", () => {
    expect(DeliveryPayloadSchema.safeParse({ nested: ["value", { count: 1 }] }).success).toBe(true);
    expect(DeliveryPayloadSchema.safeParse({ bad: undefined }).success).toBe(false);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(DeliveryPayloadSchema.safeParse(cycle).success).toBe(false);
    expect(DeliveryPayloadSchema.safeParse(Number.NaN).success).toBe(false);
    expect(
      DeliveriesGetRequestSchema.parse({
        type: "deliveries.get.request",
        requestId: "request-one",
        includeAcknowledged: false,
        limit: 20,
      }),
    ).toMatchObject({ includeAcknowledged: false, limit: 20 });
    expect(
      DeliveriesAcknowledgeRequestSchema.parse({
        type: "deliveries.acknowledge.request",
        requestId: "request-two",
        deliveryId: "delivery-one",
      }),
    ).toMatchObject({ deliveryId: "delivery-one" });
    expect(
      DeliveriesSendRequestSchema.safeParse({
        type: "deliveries.send.request",
        requestId: "request-three",
        payload: undefined,
      }).success,
    ).toBe(false);
  });

  test("bounds payload inspection without recursive traversal", () => {
    expect(inspectDeliveryPayload("x", { maxStringBytes: 0 })).toMatchObject({
      ok: false,
      reason: "string_too_large",
    });
    expect(inspectDeliveryPayload({ nested: { value: true } }, { maxDepth: 1 })).toMatchObject({
      ok: false,
      reason: "depth_exceeded",
    });
    expect(inspectDeliveryPayload([null, null], { maxNodes: 2 })).toMatchObject({
      ok: false,
      reason: "nodes_exceeded",
    });
    expect(
      inspectDeliveryPayload("x".repeat(MAX_DELIVERY_PAYLOAD_BYTES), {
        maxBytes: MAX_DELIVERY_PAYLOAD_BYTES - 1,
        maxStringBytes: MAX_DELIVERY_PAYLOAD_BYTES,
      }),
    ).toMatchObject({ ok: false, reason: "payload_too_large" });
  });

  test("accepts targeted delivery identity while retaining optional legacy fields", () => {
    const request = DeliveriesSendRequestSchema.parse({
      type: "deliveries.send.request",
      requestId: "request-targeted",
      targetAgentId: "agent-exact",
      messageId: "message-stable",
      payload: { hello: "world" },
    });
    expect(request).toMatchObject({
      targetAgentId: "agent-exact",
      messageId: "message-stable",
    });
  });

  test("advertises a distinct client capability", () => {
    expect(CLIENT_CAPS.durableDeliveries).toBe("durable_deliveries");
  });

  test("keeps delivery responses below the WebSocket transport maximum", () => {
    expect(MAX_DELIVERY_RESPONSE_BYTES).toBe(MAX_WEBSOCKET_MESSAGE_BYTES - 1);
    const oversizedRequestId = "x".repeat(MAX_DELIVERY_REQUEST_ID_BYTES + 1);
    expect(
      DeliveriesGetRequestSchema.safeParse({
        type: "deliveries.get.request",
        requestId: oversizedRequestId,
      }).success,
    ).toBe(false);
    expect(
      SessionOutboundMessageSchema.safeParse({
        type: "deliveries.get.response",
        payload: {
          requestId: "request-one",
          delivery: {
            ...pendingDelivery,
            sequence: 1,
            payloadFingerprint: "a".repeat(64),
          },
          deliveries: [],
          nextCursor: null,
        },
      }).success,
    ).toBe(true);
  });
});
