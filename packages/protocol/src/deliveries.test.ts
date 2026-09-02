import { describe, expect, test } from "vitest";
import {
  DeliveriesAcknowledgeRequestSchema,
  DeliveriesGetRequestSchema,
  DeliveriesSendRequestSchema,
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";
import {
  DeliveryPayloadSchema,
  DeliverySequenceCursorSchema,
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
    expect(inspectDeliveryPayload(JSON.parse('{"__proto__":"unsafe"}'))).toMatchObject({
      ok: false,
      reason: "dangerous_key",
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

  test("validates sequence cursors independently from delivery IDs", () => {
    expect(DeliverySequenceCursorSchema.parse("seq:7")).toBe("seq:7");
    expect(DeliverySequenceCursorSchema.safeParse("delivery-one").success).toBe(false);
    expect(DeliverySequenceCursorSchema.safeParse("seq:0").success).toBe(false);
    expect(DeliverySequenceCursorSchema.safeParse("seq:9007199254740992").success).toBe(false);
    expect(
      DeliveriesGetRequestSchema.parse({
        type: "deliveries.get.request",
        requestId: "request-cursor",
        cursor: "seq:7",
      }).cursor,
    ).toBe("seq:7");
  });

  test("advertises a distinct client capability", () => {
    expect(CLIENT_CAPS.durableDeliveries).toBe("durable_deliveries");
    expect(CLIENT_CAPS.deliveryPayloadTombstones).toBe("delivery_payload_tombstones");
  });

  test("accepts old server_info peers while recognizing the new capability", () => {
    const oldPeer = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "old-daemon",
      features: { durableDeliveries: true },
    });
    const newPeer = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "new-daemon",
      features: {
        durableDeliveries: true,
        deliveryPayloadTombstones: true,
      },
    });

    expect(oldPeer.features?.deliveryPayloadTombstones).toBeUndefined();
    expect(newPeer.features?.deliveryPayloadTombstones).toBe(true);
  });

  test("keeps delivery responses below the WebSocket transport maximum", () => {
    expect(MAX_DELIVERY_RESPONSE_BYTES).toBe(MAX_WEBSOCKET_MESSAGE_BYTES - 1);
    const legacyRequestId = "x".repeat(MAX_DELIVERY_REQUEST_ID_BYTES + 1);
    expect(
      DeliveriesGetRequestSchema.safeParse({
        type: "deliveries.get.request",
        requestId: legacyRequestId,
      }).success,
    ).toBe(true);
    expect(
      SessionOutboundMessageSchema.safeParse({
        type: "deliveries.get.response",
        payload: {
          requestId: legacyRequestId,
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
