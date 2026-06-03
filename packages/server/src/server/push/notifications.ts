import type pino from "pino";

import { PushService, type PushPayload, type WebPushVapidDetails } from "./push-service.js";
import type { PushTokenStore } from "./token-store.js";

export type { PushPayload };

export interface PushNotificationSender {
  send(payload: PushPayload): Promise<void>;
}

export function createPushNotificationSender(
  logger: pino.Logger,
  tokenStore: PushTokenStore,
  vapid: WebPushVapidDetails,
): PushNotificationSender {
  const pushService = new PushService(logger, tokenStore, { vapid });

  return {
    async send(payload) {
      const subscriptions = tokenStore.getAllSubscriptions();
      logger.info({ subscriptionCount: subscriptions.length }, "Sending push notification");
      if (subscriptions.length === 0) {
        return;
      }

      await pushService.sendPush(subscriptions, payload);
    },
  };
}
