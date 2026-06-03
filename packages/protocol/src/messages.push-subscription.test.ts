import { describe, expect, test } from "vitest";
import {
  PushSubscriptionRegisterRequestSchema,
  PushSubscriptionRegisterResponseSchema,
  PushSubscriptionUnregisterRequestSchema,
  PushSubscriptionUnregisterResponseSchema,
  RegisterPushTokenMessageSchema,
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";

const webPushSubscription = {
  kind: "webPush",
  endpoint: "https://push.example.test/subscription/abc",
  keys: {
    p256dh: "p256dh-key",
    auth: "auth-secret",
  },
} as const;

describe("push subscription protocol", () => {
  test("parses Web Push subscription registration requests", () => {
    const message = {
      type: "push.subscription.register.request",
      requestId: "req-register",
      subscription: webPushSubscription,
    };

    expect(PushSubscriptionRegisterRequestSchema.parse(message)).toEqual(message);
    expect(SessionInboundMessageSchema.parse(message)).toEqual(message);
  });

  test("parses Web Push subscription registration responses", () => {
    const message = {
      type: "push.subscription.register.response",
      payload: {
        requestId: "req-register",
        success: true,
        error: null,
      },
    };

    expect(PushSubscriptionRegisterResponseSchema.parse(message)).toEqual(message);
    expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
  });

  test("parses Web Push subscription unregistration messages", () => {
    const request = {
      type: "push.subscription.unregister.request",
      requestId: "req-unregister",
      endpoint: "https://push.example.test/subscription/abc",
    };
    const response = {
      type: "push.subscription.unregister.response",
      payload: {
        requestId: "req-unregister",
        success: false,
        error: "Subscription not found",
      },
    };

    expect(PushSubscriptionUnregisterRequestSchema.parse(request)).toEqual(request);
    expect(PushSubscriptionUnregisterResponseSchema.parse(response)).toEqual(response);
    expect(SessionInboundMessageSchema.parse(request)).toEqual(request);
    expect(SessionOutboundMessageSchema.parse(response)).toEqual(response);
  });

  test("keeps legacy Expo token registration unchanged", () => {
    const message = {
      type: "register_push_token",
      token: "ExponentPushToken[legacy]",
    };

    expect(RegisterPushTokenMessageSchema.parse(message)).toEqual(message);
    expect(SessionInboundMessageSchema.parse(message)).toEqual(message);
  });

  test("parses UnifiedPush feature and VAPID public key in server_info", () => {
    const payload = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "srv_test",
      features: {
        unifiedPush: true,
      },
      capabilities: {
        pushNotifications: {
          webPushVapidPublicKey: "public-vapid-key",
        },
      },
    });

    expect(payload.features?.unifiedPush).toBe(true);
    expect(payload.capabilities?.pushNotifications?.webPushVapidPublicKey).toBe("public-vapid-key");
  });
});
