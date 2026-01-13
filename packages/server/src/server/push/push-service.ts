import type { PushTokenStore } from "./token-store.js";

interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: "default";
}

interface ExpoPushTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const MAX_BATCH_SIZE = 100;

/**
 * Service for sending Expo push notifications.
 * Handles batching and invalid token removal.
 */
export class PushService {
  private tokenStore: PushTokenStore;

  constructor(tokenStore: PushTokenStore) {
    this.tokenStore = tokenStore;
  }

  async sendPush(tokens: string[], payload: PushPayload): Promise<void> {
    if (tokens.length === 0) {
      return;
    }

    const messages: ExpoPushMessage[] = tokens.map((token) => ({
      to: token,
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

    for (const batch of batches) {
      await this.sendBatch(batch);
    }
  }

  private async sendBatch(messages: ExpoPushMessage[]): Promise<void> {
    try {
      const response = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(messages),
      });

      if (!response.ok) {
        console.error(
          `[PushService] Expo push API error: ${response.status} ${response.statusText}`
        );
        return;
      }

      const result = (await response.json()) as { data: ExpoPushTicket[] };
      this.handleTickets(messages, result.data);
    } catch (error) {
      console.error("[PushService] Failed to send push notifications:", error);
    }
  }

  private handleTickets(
    messages: ExpoPushMessage[],
    tickets: ExpoPushTicket[]
  ): void {
    for (let i = 0; i < tickets.length; i++) {
      const ticket = tickets[i];
      const message = messages[i];

      if (ticket.status === "error") {
        console.error(
          `[PushService] Push failed for token: ${ticket.message}`,
          ticket.details
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
