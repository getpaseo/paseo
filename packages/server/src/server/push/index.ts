import type pino from "pino";

import { PushService, type PushPayload } from "./push-service.js";
import type { PushTokenStore } from "./token-store.js";

export type { PushPayload };

export interface PushNotifications {
  renew(token: string): void;
  revoke(token: string): void;
  send(payload: PushPayload): Promise<void>;
}

export type PushNotificationSender = Pick<PushNotifications, "send">;

export function createPushNotifications(options: {
  logger: pino.Logger;
  store: PushTokenStore;
  deliver?: (tokens: string[], payload: PushPayload) => Promise<void>;
}): PushNotifications {
  const service = new PushService(options.logger, (token) => options.store.revokeToken(token));
  const deliver =
    options.deliver ??
    ((tokens: string[], payload: PushPayload) => service.sendPush(tokens, payload));

  return {
    renew(token) {
      options.store.renewToken(token);
    },
    revoke(token) {
      options.store.revokeToken(token);
    },
    async send(payload) {
      const tokens = options.store.getActiveTokens();
      options.logger.info({ tokenCount: tokens.length }, "Sending push notification");
      if (tokens.length === 0) return;
      await deliver(tokens, payload);
    },
  };
}
