import { describe, expect, test } from "vitest";
import {
  DeliveriesAcknowledgeRequestSchema,
  DeliveriesGetRequestSchema,
  DeliveriesSendRequestSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";
import { DeliveryPayloadSchema } from "./deliveries.js";
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

  test("advertises a distinct client capability", () => {
    expect(CLIENT_CAPS.durableDeliveries).toBe("durable_deliveries");
  });
});
