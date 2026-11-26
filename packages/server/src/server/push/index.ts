import type pino from "pino";
import {
  normalizeNotificationPreferences,
  shouldDeliverNotification,
  type NotificationKind,
  type NotificationPreferencesInput,
} from "@getpaseo/protocol/notification-preferences";

import { PushService, type PushPayload } from "./push-service.js";
import { PushTokenStore } from "./token-store.js";

export type { PushPayload };

const PUSH_TOKEN_LEASE_MS = 48 * 60 * 60 * 1000;

export interface PushNotifications {
  renew(token: string, preferences?: NotificationPreferencesInput): void;
  revoke(token: string): void;
  send(payload: PushPayload, kind?: NotificationKind): Promise<void>;
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
  const deliver =
    options.deliver ??
    ((tokens: string[], payload: PushPayload) => service.sendPush(tokens, payload));

  return {
    renew(token, preferences) {
      store.renewToken(token, preferences);
    },
    revoke(token) {
      store.revokeToken(token);
    },
    async send(payload, kind) {
      const subscriptions = store.getActiveSubscriptions();
      const tokens = subscriptions
        .filter((entry) => {
          const preferences = normalizeNotificationPreferences(entry.preferences);
          return kind ? shouldDeliverNotification(preferences, kind) : preferences.enabled;
        })
        .map((entry) => entry.token);
      options.logger.info(
        { tokenCount: tokens.length, activeTokenCount: subscriptions.length, kind },
        "Sending push notification",
      );
      if (tokens.length === 0) return;
      await deliver(tokens, payload);
    },
  };
}
