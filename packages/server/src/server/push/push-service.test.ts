import type pino from "pino";
import { describe, expect, test, vi } from "vitest";
import { PushService, type PushPayload } from "./push-service.js";
import type { PushSubscription, PushTokenStore } from "./token-store.js";

function createLogger(): pino.Logger {
  const logger = {
    child: () => logger,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger as unknown as pino.Logger;
}

function createStore(subscriptions: PushSubscription[]) {
  const removedExpo: string[] = [];
  const removedWebPush: string[] = [];
  return {
    getAllSubscriptions: () => subscriptions,
    removeToken: (token: string) => removedExpo.push(token),
    removeWebPushSubscription: (endpoint: string) => removedWebPush.push(endpoint),
    removedExpo,
    removedWebPush,
  } as unknown as PushTokenStore & { removedExpo: string[]; removedWebPush: string[] };
}

const payload: PushPayload = {
  title: "Agent finished",
  body: "Done",
  data: { serverId: "srv_test", agentId: "agt_test" },
};

const vapid = {
  subject: "mailto:push@getpaseo.dev",
  publicKey: "public-vapid-key",
  privateKey: "private-vapid-key",
};

describe("PushService", () => {
  test("routes Expo and Web Push subscriptions to their transports", async () => {
    const expoSend = vi.fn().mockResolvedValue([{ status: "ok" }]);
    const webPushSend = vi.fn().mockResolvedValue(undefined);
    const store = createStore([
      {
        kind: "expo",
        token: "ExponentPushToken[test]",
        createdAt: "2026-06-03T00:00:00.000Z",
        updatedAt: "2026-06-03T00:00:00.000Z",
      },
      {
        kind: "webPush",
        endpoint: "https://push.example.test/subscription/abc",
        keys: { p256dh: "p256dh-key", auth: "auth-secret" },
        createdAt: "2026-06-03T00:00:00.000Z",
        updatedAt: "2026-06-03T00:00:00.000Z",
      },
    ]);

    const service = new PushService(createLogger(), store, {
      expoSend,
      webPushSend,
      vapid,
      validateWebPushEndpoint: async () => undefined,
    });

    await service.sendPush(store.getAllSubscriptions(), payload);

    expect(expoSend).toHaveBeenCalledWith([
      {
        to: "ExponentPushToken[test]",
        title: "Agent finished",
        body: "Done",
        data: { serverId: "srv_test", agentId: "agt_test" },
        sound: "default",
      },
    ]);
    expect(webPushSend).toHaveBeenCalledWith(
      {
        endpoint: "https://push.example.test/subscription/abc",
        keys: { p256dh: "p256dh-key", auth: "auth-secret" },
      },
      JSON.stringify(payload),
      { vapidDetails: vapid },
    );
  });

  test("removes expired Web Push subscriptions", async () => {
    const store = createStore([
      {
        kind: "webPush",
        endpoint: "https://push.example.test/subscription/expired",
        keys: { p256dh: "p256dh-key", auth: "auth-secret" },
        createdAt: "2026-06-03T00:00:00.000Z",
        updatedAt: "2026-06-03T00:00:00.000Z",
      },
    ]);
    const error = Object.assign(new Error("Gone"), { statusCode: 410 });
    const service = new PushService(createLogger(), store, {
      expoSend: vi.fn(),
      webPushSend: vi.fn().mockRejectedValue(error),
      vapid,
      validateWebPushEndpoint: async () => undefined,
    });

    await service.sendPush(store.getAllSubscriptions(), payload);

    expect(store.removedWebPush).toEqual(["https://push.example.test/subscription/expired"]);
  });

  test("keeps Web Push subscriptions on transient errors", async () => {
    const store = createStore([
      {
        kind: "webPush",
        endpoint: "https://push.example.test/subscription/transient",
        keys: { p256dh: "p256dh-key", auth: "auth-secret" },
        createdAt: "2026-06-03T00:00:00.000Z",
        updatedAt: "2026-06-03T00:00:00.000Z",
      },
    ]);
    const service = new PushService(createLogger(), store, {
      expoSend: vi.fn(),
      webPushSend: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("Timeout"), { statusCode: 503 })),
      vapid,
      validateWebPushEndpoint: async () => undefined,
    });

    await service.sendPush(store.getAllSubscriptions(), payload);

    expect(store.removedWebPush).toEqual([]);
  });

  test("does not send Web Push notifications without VAPID configuration", async () => {
    const store = createStore([
      {
        kind: "webPush",
        endpoint: "https://push.example.test/subscription/missing-vapid",
        keys: { p256dh: "p256dh-key", auth: "auth-secret" },
        createdAt: "2026-06-03T00:00:00.000Z",
        updatedAt: "2026-06-03T00:00:00.000Z",
      },
    ]);
    const webPushSend = vi.fn().mockResolvedValue(undefined);
    const service = new PushService(createLogger(), store, {
      expoSend: vi.fn(),
      webPushSend,
      validateWebPushEndpoint: async () => undefined,
    });

    await service.sendPush(store.getAllSubscriptions(), payload);

    expect(webPushSend).not.toHaveBeenCalled();
    expect(store.removedWebPush).toEqual([]);
  });
});
