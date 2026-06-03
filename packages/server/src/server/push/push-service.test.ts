import type pino from "pino";
import { describe, expect, test, vi } from "vitest";
import {
  PushService,
  type ExpoPushMessage,
  type ExpoPushTicket,
  type PushPayload,
  type WebPushSendOptions,
} from "./push-service.js";
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

interface SentWebPushMessage {
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
  payload: string;
  options: WebPushSendOptions;
}

function createPushTransportFake(options?: {
  expoTickets?: ExpoPushTicket[];
  webPushError?: Error;
}) {
  const expoMessages: ExpoPushMessage[][] = [];
  const webPushMessages: SentWebPushMessage[] = [];
  return {
    expoMessages,
    webPushMessages,
    expoSend: async (messages: ExpoPushMessage[]) => {
      expoMessages.push(messages);
      return options?.expoTickets ?? [];
    },
    webPushSend: async (
      subscription: SentWebPushMessage["subscription"],
      serializedPayload: string,
      sendOptions: WebPushSendOptions,
    ) => {
      webPushMessages.push({ subscription, payload: serializedPayload, options: sendOptions });
      if (options?.webPushError) throw options.webPushError;
    },
  };
}

describe("PushService", () => {
  test("routes Expo and Web Push subscriptions to their transports", async () => {
    const transports = createPushTransportFake({ expoTickets: [{ status: "ok" }] });
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
      expoSend: transports.expoSend,
      webPushSend: transports.webPushSend,
      vapid,
      validateWebPushEndpoint: async () => undefined,
    });

    await service.sendPush(store.getAllSubscriptions(), payload);

    expect(transports.expoMessages).toEqual([
      [
        {
          to: "ExponentPushToken[test]",
          title: "Agent finished",
          body: "Done",
          data: { serverId: "srv_test", agentId: "agt_test" },
          sound: "default",
        },
      ],
    ]);
    expect(transports.webPushMessages).toEqual([
      {
        subscription: {
          endpoint: "https://push.example.test/subscription/abc",
          keys: { p256dh: "p256dh-key", auth: "auth-secret" },
        },
        payload: JSON.stringify(payload),
        options: { vapidDetails: vapid },
      },
    ]);
  });

  test("removes invalid Expo push tokens", async () => {
    const transports = createPushTransportFake({
      expoTickets: [{ status: "error", details: { error: "DeviceNotRegistered" } }],
    });
    const store = createStore([
      {
        kind: "expo",
        token: "ExponentPushToken[invalid]",
        createdAt: "2026-06-03T00:00:00.000Z",
        updatedAt: "2026-06-03T00:00:00.000Z",
      },
    ]);
    const service = new PushService(createLogger(), store, {
      expoSend: transports.expoSend,
      webPushSend: transports.webPushSend,
      vapid,
      validateWebPushEndpoint: async () => undefined,
    });

    await service.sendPush(store.getAllSubscriptions(), payload);

    expect(store.removedExpo).toEqual(["ExponentPushToken[invalid]"]);
  });

  test("does not remove valid Expo push tokens", async () => {
    const transports = createPushTransportFake({ expoTickets: [{ status: "ok" }] });
    const store = createStore([
      {
        kind: "expo",
        token: "ExponentPushToken[valid]",
        createdAt: "2026-06-03T00:00:00.000Z",
        updatedAt: "2026-06-03T00:00:00.000Z",
      },
    ]);
    const service = new PushService(createLogger(), store, {
      expoSend: transports.expoSend,
      webPushSend: transports.webPushSend,
      vapid,
      validateWebPushEndpoint: async () => undefined,
    });

    await service.sendPush(store.getAllSubscriptions(), payload);

    expect(store.removedExpo).toEqual([]);
  });

  test("uses VAPID details when sending Web Push notifications", async () => {
    const transports = createPushTransportFake();
    const store = createStore([
      {
        kind: "webPush",
        endpoint: "https://push.example.test/subscription/abc",
        keys: { p256dh: "p256dh-key", auth: "auth-secret" },
        createdAt: "2026-06-03T00:00:00.000Z",
        updatedAt: "2026-06-03T00:00:00.000Z",
      },
    ]);
    const service = new PushService(createLogger(), store, {
      expoSend: transports.expoSend,
      webPushSend: transports.webPushSend,
      vapid,
      validateWebPushEndpoint: async () => undefined,
    });

    await service.sendPush(store.getAllSubscriptions(), payload);

    expect(transports.webPushMessages).toEqual([
      {
        subscription: {
          endpoint: "https://push.example.test/subscription/abc",
          keys: { p256dh: "p256dh-key", auth: "auth-secret" },
        },
        payload: JSON.stringify(payload),
        options: { vapidDetails: vapid },
      },
    ]);
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
    const transports = createPushTransportFake({ webPushError: error });
    const service = new PushService(createLogger(), store, {
      expoSend: transports.expoSend,
      webPushSend: transports.webPushSend,
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
    const transports = createPushTransportFake({
      webPushError: Object.assign(new Error("Timeout"), { statusCode: 503 }),
    });
    const service = new PushService(createLogger(), store, {
      expoSend: transports.expoSend,
      webPushSend: transports.webPushSend,
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
    const transports = createPushTransportFake();
    const service = new PushService(createLogger(), store, {
      expoSend: transports.expoSend,
      webPushSend: transports.webPushSend,
      validateWebPushEndpoint: async () => undefined,
    });

    await service.sendPush(store.getAllSubscriptions(), payload);

    expect(transports.webPushMessages).toEqual([]);
    expect(store.removedWebPush).toEqual([]);
  });
});
