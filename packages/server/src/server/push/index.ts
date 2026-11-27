import type pino from "pino";
import {
  normalizeNotificationPreferences,
  shouldDeliverNotification,
  type NotificationKind,
  type NotificationPreferences,
  type NotificationPreferencesInput,
} from "@getpaseo/protocol/notification-preferences";

import { PushService, type PushPayload } from "./push-service.js";
import { PushTokenStore } from "./token-store.js";

export type { PushPayload };

const PUSH_TOKEN_LEASE_MS = 48 * 60 * 60 * 1000;

// COMPAT(pushNotificationPreferences): added in v0.18.0, remove after 2027-06-01.
// Mobile apps predating notification preferences cannot opt back into finished pushes, so
// tokens registered without explicit preferences retain the pre-v0.18 push filter.
const LEGACY_PUSH_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  enabled: true,
  events: {
    agentPermission: true,
    agentError: false,
    agentFinished: true,
    terminalNeedsInput: true,
    terminalFinished: true,
  },
  plugins: {
    enabled: true,
    muted: [],
  },
};

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
  const service = new PushService({
    logger: options.logger,
    revokeToken: (token) => store.revokeToken(token),
  });
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
          const preferences =
            entry.preferences !== undefined
              ? normalizeNotificationPreferences(entry.preferences)
              : LEGACY_PUSH_NOTIFICATION_PREFERENCES;
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
