import type pino from "pino";
import {
  createNotificationHttp,
  type NotificationHttp,
} from "../notifications/notification-http.js";

import { PushService, type PushPayload } from "./push-service.js";
import { PushTokenStore } from "./token-store.js";

export type { PushPayload };

const DEFAULT_TOKEN_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

export interface PushNotifications {
  renew(token: string): void;
  revoke(token: string): void;
  send(payload: PushPayload): Promise<void>;
  close?(): Promise<void>;
}

export type PushNotificationSender = Pick<PushNotifications, "send">;

export function createPushNotifications(options: {
  logger: pino.Logger;
  filePath: string;
  now?: () => number;
  retentionMs?: number;
  enabled?: boolean;
  http?: NotificationHttp;
  automatic?: boolean;
  deliver?: (tokens: string[], payload: PushPayload) => Promise<void>;
}): PushNotifications {
  const now = options.now ?? Date.now;
  const store = new PushTokenStore(
    options.logger,
    options.filePath,
    now,
    options.retentionMs ?? DEFAULT_TOKEN_RETENTION_MS,
  );
  const enabled = options.enabled !== false;
  const transport =
    options.http || options.deliver || !enabled ? undefined : createNotificationHttp();
  const service =
    options.deliver || !enabled
      ? undefined
      : new PushService({
          logger: options.logger,
          filePath: `${options.filePath}.deliveries`,
          now,
          revokeToken: (token) => store.revokeToken(token),
          isRegistered: (token) => store.getActiveTokens().includes(token),
          http: options.http ?? transport!.request,
          automatic: options.automatic,
        });
  const deliver =
    options.deliver ??
    ((tokens: string[], payload: PushPayload) => service!.sendPush(tokens, payload));

  return {
    async close() {
      await service?.close();
      await transport?.close();
    },
    renew(token) {
      store.renewToken(token);
    },
    revoke(token) {
      store.revokeToken(token);
    },
    async send(payload) {
      if (!enabled) return;
      const tokens = store
        .getActiveTokens()
        .filter((token) => !payload.excludedTokens?.includes(token));
      options.logger.debug(
        { eventId: payload.data?.notificationId, tokenCount: tokens.length },
        "Expo notification devices",
      );
      if (tokens.length === 0)
        options.logger.info(
          {
            eventId: payload.data?.notificationId,
            registeredDevices: store.getActiveTokens().length,
          },
          "No eligible registered push tokens",
        );
      if (tokens.length === 0) return;
      await deliver(tokens, payload);
    },
  };
}
