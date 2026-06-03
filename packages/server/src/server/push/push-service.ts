import type pino from "pino";
import webPush from "web-push";
import { assertSafeWebPushEndpoint, createEndpointLogContext } from "./endpoint-security.js";
import type {
  ExpoPushSubscription,
  PushSubscription,
  PushTokenStore,
  WebPushSubscription,
} from "./token-store.js";

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: "default";
}

export interface ExpoPushTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

export interface PushServiceTransports {
  expoSend?: (messages: ExpoPushMessage[]) => Promise<ExpoPushTicket[]>;
  webPushSend?: (
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    payload: string,
    options: WebPushSendOptions,
  ) => Promise<void>;
  validateWebPushEndpoint?: (endpoint: string) => Promise<void>;
  vapid?: WebPushVapidDetails;
}

export interface WebPushVapidDetails {
  subject: string;
  publicKey: string;
  privateKey: string;
}

export interface WebPushSendOptions {
  vapidDetails: WebPushVapidDetails;
}

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const MAX_BATCH_SIZE = 100;

/**
 * Service for sending Expo push notifications.
 * Handles batching and invalid token removal.
 */
export class PushService {
  private readonly logger: pino.Logger;
  private readonly tokenStore: PushTokenStore;
  private readonly expoSend: (messages: ExpoPushMessage[]) => Promise<ExpoPushTicket[]>;
  private readonly webPushSend: PushServiceTransports["webPushSend"];
  private readonly validateWebPushEndpoint: (endpoint: string) => Promise<void>;
  private readonly vapid: WebPushVapidDetails | null;

  constructor(
    logger: pino.Logger,
    tokenStore: PushTokenStore,
    transports: PushServiceTransports = {},
  ) {
    this.logger = logger.child({ component: "push-service" });
    this.tokenStore = tokenStore;
    this.expoSend = transports.expoSend ?? sendExpoMessages;
    this.webPushSend = transports.webPushSend ?? sendWebPushNotification;
    this.vapid = transports.vapid ?? null;
    this.validateWebPushEndpoint =
      transports.validateWebPushEndpoint ??
      (async (endpoint) => void (await assertSafeWebPushEndpoint(endpoint)));
  }

  async sendPush(subscriptions: PushSubscription[], payload: PushPayload): Promise<void> {
    if (subscriptions.length === 0) {
      return;
    }

    const expoSubscriptions = subscriptions.filter(
      (subscription): subscription is ExpoPushSubscription => subscription.kind === "expo",
    );
    const webPushSubscriptions = subscriptions.filter(
      (subscription): subscription is WebPushSubscription => subscription.kind === "webPush",
    );

    const messages: ExpoPushMessage[] = expoSubscriptions.map((subscription) => ({
      to: subscription.token,
      title: payload.title,
      body: payload.body,
      data: payload.data,
      sound: "default",
    }));

    // Batch tokens (max 100 per request per Expo limits)
    const batches: ExpoPushMessage[][] = [];
    for (let i = 0; i < messages.length; i += MAX_BATCH_SIZE) {
      batches.push(messages.slice(i, i + MAX_BATCH_SIZE));
    }

    await Promise.all([
      ...batches.map((batch) => this.sendExpoBatch(batch)),
      ...webPushSubscriptions.map((subscription) => this.sendWebPush(subscription, payload)),
    ]);
  }

  private async sendExpoBatch(messages: ExpoPushMessage[]): Promise<void> {
    try {
      const tickets = await this.expoSend(messages);
      this.handleTickets(messages, tickets);
    } catch (error) {
      this.logger.error({ err: error }, "Failed to send push notifications");
    }
  }

  private async sendWebPush(
    subscription: WebPushSubscription,
    payload: PushPayload,
  ): Promise<void> {
    const logContext = createEndpointLogContext(subscription.endpoint);
    try {
      await this.validateWebPushEndpoint(subscription.endpoint);
      if (!this.vapid) {
        throw new Error("Missing VAPID configuration for Web Push notification");
      }
      await this.webPushSend?.(
        {
          endpoint: subscription.endpoint,
          keys: subscription.keys,
        },
        JSON.stringify(payload),
        { vapidDetails: this.vapid },
      );
    } catch (error) {
      const statusCode = getStatusCode(error);
      if (statusCode === 404 || statusCode === 410) {
        this.tokenStore.removeWebPushSubscription(subscription.endpoint);
      }
      this.logger.error(
        { err: error, statusCode, ...logContext },
        "Failed to send Web Push notification",
      );
    }
  }

  private handleTickets(messages: ExpoPushMessage[], tickets: ExpoPushTicket[]): void {
    for (let i = 0; i < tickets.length; i++) {
      const ticket = tickets[i];
      const message = messages[i];

      if (ticket.status === "error") {
        this.logger.error(
          { token: message.to, message: ticket.message, details: ticket.details },
          "Push failed for token",
        );

        // Remove invalid tokens
        if (
          ticket.details?.error === "DeviceNotRegistered" ||
          ticket.details?.error === "InvalidCredentials"
        ) {
          this.tokenStore.removeToken(message.to);
        }
      }
    }
  }
}

async function sendExpoMessages(messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]> {
  const response = await fetch(EXPO_PUSH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(messages),
  });

  if (!response.ok) {
    throw Object.assign(new Error("Expo push API error"), {
      status: response.status,
      statusText: response.statusText,
    });
  }

  const result = (await response.json()) as { data: ExpoPushTicket[] };
  return result.data;
}

async function sendWebPushNotification(
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
  options: WebPushSendOptions,
): Promise<void> {
  await webPush.sendNotification(subscription, payload, options);
}

function getStatusCode(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" ? statusCode : null;
}
