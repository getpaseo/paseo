import type pino from "pino";

import { FCM_TOKEN_PREFIX, FcmSender } from "./fcm-sender.js";
import { PushService, type PushPayload } from "./push-service.js";
import { PushTokenStore } from "./token-store.js";

export type { PushPayload };

const PUSH_TOKEN_LEASE_MS = 48 * 60 * 60 * 1000;

export function contentFreePayload(payload: PushPayload): PushPayload {
  return {
    title: "PandaOS",
    body: "Something is waiting for you.",
    ...(payload.data
      ? {
          data: Object.fromEntries(
            ["serverId", "workspaceId", "agentId", "terminalId"].flatMap((key) =>
              typeof payload.data?.[key] === "string" ? [[key, payload.data[key]]] : [],
            ),
          ),
        }
      : {}),
  };
}

export interface PushNotifications {
  renew(token: string): void;
  revoke(token: string): void;
  send(payload: PushPayload): Promise<void>;
}

export type PushNotificationSender = Pick<PushNotifications, "send">;

export function createPushNotifications(options: {
  logger: pino.Logger;
  filePath: string;
  now?: () => number;
  deliver?: (tokens: string[], payload: PushPayload) => Promise<void>;
}): PushNotifications {
  const now = options.now ?? Date.now;
  const store = new PushTokenStore(options.logger, options.filePath, now, PUSH_TOKEN_LEASE_MS);
  const service = new PushService(options.logger, (token) => store.revokeToken(token));
  const fcm = new FcmSender({
    logger: options.logger,
    onInvalidToken: (token) => store.revokeToken(token),
  });
  // Expo tokens go through the Expo push service; tokens the app took from Firebase go to FCM.
  const deliver =
    options.deliver ??
    (async (tokens: string[], payload: PushPayload) => {
      const direct = tokens.filter((token) => token.startsWith(FCM_TOKEN_PREFIX));
      const expo = tokens.filter((token) => !token.startsWith(FCM_TOKEN_PREFIX));
      await Promise.all([
        expo.length > 0 ? service.sendPush(expo, payload) : Promise.resolve(),
        fcm.send(direct, payload),
      ]);
    });

  return {
    renew(token) {
      store.renewToken(token);
    },
    revoke(token) {
      store.revokeToken(token);
    },
    async send(payload) {
      const tokens = store.getActiveTokens();
      options.logger.info({ tokenCount: tokens.length }, "Sending push notification");
      if (tokens.length === 0) return;
      await deliver(tokens, contentFreePayload(payload));
    },
  };
}
