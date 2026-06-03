import { describe, expect, test } from "vitest";
import type { ServerInfoStatusPayload } from "@getpaseo/protocol/messages";
import {
  getUnifiedPushRegistrationTarget,
  getUnifiedPushRegistrationConfig,
  handleUnifiedPushEvent,
  normalizeRegisteredSubscription,
  parseUnifiedPushMessage,
  selectUnifiedPushDistributor,
} from "./unified-push-shared";

describe("UnifiedPush helpers", () => {
  test("enables Android UnifiedPush only when server advertises feature and VAPID key", () => {
    const unifiedPushServerInfo = {
      status: "server_info",
      serverId: "srv_test",
      hostname: null,
      version: null,
      features: { unifiedPush: true },
      capabilities: {
        pushNotifications: { webPushVapidPublicKey: " public-key " },
      },
    } satisfies ServerInfoStatusPayload;
    const iosServerInfo = {
      status: "server_info",
      serverId: "srv_test",
      hostname: null,
      version: null,
      features: { unifiedPush: true },
      capabilities: {
        pushNotifications: { webPushVapidPublicKey: "public-key" },
      },
    } satisfies ServerInfoStatusPayload;
    const unsupportedServerInfo = {
      status: "server_info",
      serverId: "srv_test",
      hostname: null,
      version: null,
    } satisfies ServerInfoStatusPayload;

    expect(
      getUnifiedPushRegistrationConfig({
        platform: "android",
        serverInfo: unifiedPushServerInfo,
      }),
    ).toEqual({ enabled: true, vapidPublicKey: "public-key" });

    expect(
      getUnifiedPushRegistrationConfig({
        platform: "ios",
        serverInfo: iosServerInfo,
      }),
    ).toEqual({ enabled: false, vapidPublicKey: null });

    expect(
      getUnifiedPushRegistrationConfig({
        platform: "android",
        serverInfo: unsupportedServerInfo,
      }),
    ).toEqual({ enabled: false, vapidPublicKey: null });
  });

  test("derives a stable registration target from UnifiedPush capability fields only", () => {
    const firstServerInfo = {
      status: "server_info",
      serverId: "srv_test",
      hostname: null,
      version: "0.1.90",
      features: { unifiedPush: true },
      capabilities: {
        pushNotifications: { webPushVapidPublicKey: " public-key " },
      },
    } satisfies ServerInfoStatusPayload;
    const repeatedServerInfo = {
      status: "server_info",
      serverId: "srv_test",
      hostname: "updated-hostname",
      version: "0.1.91",
      features: { unifiedPush: true },
      capabilities: {
        pushNotifications: { webPushVapidPublicKey: " public-key " },
      },
    } satisfies ServerInfoStatusPayload;

    expect(
      getUnifiedPushRegistrationTarget({
        platform: "android",
        serverInfo: firstServerInfo,
      }),
    ).toBe("public-key");
    expect(
      getUnifiedPushRegistrationTarget({
        platform: "android",
        serverInfo: repeatedServerInfo,
      }),
    ).toBe("public-key");
  });

  test("normalizes distributor registration payloads", () => {
    expect(
      normalizeRegisteredSubscription({
        endpoint: " https://push.example.test/subscription/abc ",
        keys: { p256dh: " p256dh-key ", auth: " auth-secret " },
      }),
    ).toEqual({
      kind: "webPush",
      endpoint: "https://push.example.test/subscription/abc",
      keys: { p256dh: "p256dh-key", auth: "auth-secret" },
    });

    expect(
      normalizeRegisteredSubscription({
        endpoint: "https://push.example.test/subscription/abc",
        pubKey: "p256dh-key",
        auth: "auth-secret",
      }),
    ).toEqual({
      kind: "webPush",
      endpoint: "https://push.example.test/subscription/abc",
      keys: { p256dh: "p256dh-key", auth: "auth-secret" },
    });

    expect(
      normalizeRegisteredSubscription({
        url: "https://push.example.test/subscription/abc",
        pubKey: "p256dh-key",
        auth: "auth-secret",
      }),
    ).toEqual({
      kind: "webPush",
      endpoint: "https://push.example.test/subscription/abc",
      keys: { p256dh: "p256dh-key", auth: "auth-secret" },
    });

    expect(normalizeRegisteredSubscription({ endpoint: "https://push.example.test" })).toBeNull();
  });

  test("selects saved distributor, then external distributor, then first available distributor", () => {
    const distributors = [
      { id: "internal", isInternal: true },
      { id: "external", isInternal: false },
    ];

    expect(selectUnifiedPushDistributor(distributors, "internal")).toEqual({
      id: "internal",
      isInternal: true,
    });
    expect(selectUnifiedPushDistributor(distributors, null)).toEqual({
      id: "external",
      isInternal: false,
    });
    expect(selectUnifiedPushDistributor([{ id: "internal", isInternal: true }], null)).toEqual({
      id: "internal",
      isInternal: true,
    });
    expect(selectUnifiedPushDistributor([], null)).toBeNull();
  });

  test("parses decrypted UnifiedPush messages", () => {
    expect(
      parseUnifiedPushMessage({
        decrypted: true,
        message: JSON.stringify({
          title: "Agent finished",
          body: "Done",
          data: { serverId: "srv_test", agentId: "agt_test" },
        }),
      }),
    ).toEqual({
      title: "Agent finished",
      body: "Done",
      data: { serverId: "srv_test", agentId: "agt_test" },
    });

    expect(parseUnifiedPushMessage({ decrypted: false, message: "{}" })).toBeNull();
    expect(parseUnifiedPushMessage({ decrypted: true, message: "{" })).toBeNull();
    expect(
      parseUnifiedPushMessage({ decrypted: true, message: JSON.stringify({ title: "x" }) }),
    ).toBeNull();
  });

  test("handles UnifiedPush registration, unregistration, and message events", async () => {
    const registered: unknown[] = [];
    const unregistered: string[] = [];
    const notifications: unknown[] = [];
    const warnings: unknown[] = [];
    let storedEndpoint: string | null = null;

    const dependencies = {
      getStoredEndpoint: async () => storedEndpoint,
      removeStoredEndpoint: async () => {
        storedEndpoint = null;
      },
      registerSubscription: (subscription: unknown) => {
        registered.push(subscription);
      },
      setStoredEndpoint: async (endpoint: string) => {
        storedEndpoint = endpoint;
      },
      showNotification: (payload: unknown) => {
        notifications.push(payload);
      },
      unregisterSubscription: (endpoint: string) => {
        unregistered.push(endpoint);
      },
      warn: (message: string, error?: unknown) => {
        warnings.push([message, error]);
      },
    };

    handleUnifiedPushEvent(
      {
        action: "registered",
        data: {
          url: "https://push.example.test/subscription/abc",
          pubKey: "p256dh-key",
          auth: "auth-secret",
        },
      },
      dependencies,
    );
    await Promise.resolve();

    expect(storedEndpoint).toBe("https://push.example.test/subscription/abc");
    expect(registered).toEqual([
      {
        kind: "webPush",
        endpoint: "https://push.example.test/subscription/abc",
        keys: { p256dh: "p256dh-key", auth: "auth-secret" },
      },
    ]);

    handleUnifiedPushEvent(
      {
        action: "message",
        data: {
          decrypted: true,
          message: JSON.stringify({ title: "Agent finished", body: "Done" }),
        },
      },
      dependencies,
    );

    expect(notifications).toEqual([{ title: "Agent finished", body: "Done" }]);

    handleUnifiedPushEvent(
      { action: "unregistered", data: { instance: "srv_test" } },
      dependencies,
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(unregistered).toEqual(["https://push.example.test/subscription/abc"]);
    expect(storedEndpoint).toBeNull();
    expect(warnings).toEqual([]);
  });
});
