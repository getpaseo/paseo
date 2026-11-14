import type pino from "pino";

export interface PushPayload {
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
const EXPO_PUSH_REQUEST_CONCURRENCY = 4;

export interface PushServiceOptions {
  logger: pino.Logger;
  revokeToken: (token: string) => void;
  request?: typeof fetch;
}

/**
 * Service for sending Expo push notifications.
 * Handles delivery and invalid token removal.
 */
export class PushService {
  private readonly logger: pino.Logger;
  private readonly revokeToken: (token: string) => void;
  private readonly request: typeof fetch;

  constructor(options: PushServiceOptions) {
    this.logger = options.logger.child({ component: "push-service" });
    this.revokeToken = options.revokeToken;
    this.request = options.request ?? fetch;
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

    // Tokens are opaque and can belong to different Expo projects. Mixing projects
    // in one request makes Expo reject every notification in that request.
    // allSettled: one rejected request must not skip the tokens still in flight.
    for (let offset = 0; offset < messages.length; offset += EXPO_PUSH_REQUEST_CONCURRENCY) {
      const inFlight = messages.slice(offset, offset + EXPO_PUSH_REQUEST_CONCURRENCY);
      await Promise.allSettled(inFlight.map((message) => this.sendBatch([message])));
    }
  }

  private async sendBatch(messages: ExpoPushMessage[]): Promise<void> {
    try {
      const response = await this.request(EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(messages),
      });

      if (!response.ok) {
        this.logger.error(
          { status: response.status, statusText: response.statusText },
          "Expo push API error",
        );
        return;
      }

      const result = (await response.json()) as { data: ExpoPushTicket[] };
      this.handleTickets(messages, result.data);
    } catch (error) {
      this.logger.error({ err: error }, "Failed to send push notifications");
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
          this.revokeToken(message.to);
        }
      }
    }
  }
}
