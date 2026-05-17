import type pino from "pino";

import { PushService, type PushPayload } from "./push-service.js";
import { ServerChanService } from "./serverchan-service.js";
import type { PushTokenStore } from "./token-store.js";

export type { PushPayload };

export interface PushNotificationSendOptions {
  expo?: boolean;
  serverChan?: boolean;
}

export interface PushNotificationSender {
  readonly serverChanEnabled?: boolean;
  send(payload: PushPayload, options?: PushNotificationSendOptions): Promise<void>;
}

export function createPushNotificationSender(
  logger: pino.Logger,
  tokenStore: PushTokenStore,
): PushNotificationSender {
  const pushService = new PushService(logger, tokenStore);
  const serverChanService = new ServerChanService(logger);

  return {
    serverChanEnabled: serverChanService.enabled,
    async send(payload, options = {}) {
      const shouldSendServerChan = options.serverChan ?? true;
      const shouldSendExpo = options.expo ?? true;

      if (shouldSendServerChan && serverChanService.enabled) {
        logger.info("Sending ServerChan notification");
        await serverChanService.send(payload);
      }

      if (!shouldSendExpo) {
        return;
      }

      const tokens = tokenStore.getAllTokens();
      logger.info({ tokenCount: tokens.length }, "Sending push notification");
      if (tokens.length === 0) {
        return;
      }

      await pushService.sendPush(tokens, payload);
    },
  };
}
