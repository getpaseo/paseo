import { createHash, randomUUID } from "node:crypto";
import type pino from "pino";
import { z } from "zod";
import { DeliveryQueue } from "../notifications/delivery-queue.js";
import {
  DeliveryError,
  postNotification,
  type NotificationHttp,
} from "../notifications/notification-http.js";

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
  excludedTokens?: string[];
}
export const PushPayloadSchema = z.object({
  title: z.string().max(256),
  body: z.string().max(2048),
  data: z.record(z.string(), z.unknown()).optional(),
});
const TicketSchema = z.object({
  status: z.enum(["ok", "error"]),
  id: z
    .string()
    .max(128)
    .regex(/^[a-zA-Z0-9_-]+$/)
    .optional(),
  details: z.object({ error: z.string().optional() }).optional(),
});
const JobSchema = z.discriminatedUnion("stage", [
  z.object({ stage: z.literal("send"), token: z.string(), payload: PushPayloadSchema }),
  z.object({ stage: z.literal("receipt"), token: z.string(), ticketId: z.string() }),
]);
type Job = z.infer<typeof JobSchema>;
const EXPO_BASE_URL = "https://exp.host/--/api/v2/push/";

export class PushService {
  private readonly queue: DeliveryQueue<Job>;
  private readonly logger: pino.Logger;
  constructor(
    private readonly options: {
      logger: pino.Logger;
      filePath: string;
      revokeToken: (token: string) => void;
      isRegistered: (token: string) => boolean;
      http: NotificationHttp;
      now?: () => number;
      random?: () => number;
      automatic?: boolean;
    },
  ) {
    this.logger = options.logger.child({ provider: "expo" });
    this.queue = new DeliveryQueue({
      ...options,
      schema: JobSchema,
      logger: this.logger,
      deliver: (job, id) => this.deliver(job, id),
    });
  }

  async sendPush(tokens: string[], payload: PushPayload): Promise<void> {
    const eventId =
      typeof payload.data?.notificationId === "string" ? payload.data.notificationId : randomUUID();
    const parsed = PushPayloadSchema.parse(payload);
    await Promise.all(
      tokens.map((token) =>
        this.queue.enqueue(
          `${eventId}:${createHash("sha256").update(token).digest("hex").slice(0, 16)}`,
          { stage: "send", token, payload: parsed },
        ),
      ),
    );
  }
  drain(): Promise<void> {
    return this.queue.drain();
  }
  close(): Promise<void> {
    return this.queue.close();
  }

  private async deliver(job: Job, eventId: string) {
    if (!this.options.isRegistered(job.token)) return;
    if (job.stage === "send") {
      const result = await postNotification(
        this.options.http,
        `${EXPO_BASE_URL}send`,
        [
          {
            to: job.token,
            title: job.payload.title,
            body: job.payload.body,
            data: job.payload.data,
            sound: "default",
            priority: "high",
            channelId: "default",
          },
        ],
        { Accept: "application/json" },
        this.options.now,
      );
      const parsed = z.object({ data: z.array(TicketSchema).length(1) }).safeParse(result);
      if (!parsed.success) throw new DeliveryError("invalid_response", false);
      const ticket = parsed.data.data[0];
      if (ticket.status === "error") {
        this.handleError(job.token, ticket.details?.error, eventId);
        return;
      }
      if (!ticket.id) throw new DeliveryError("missing_ticket", false);
      this.logger.info({ eventId, ticketId: ticket.id, status: "accepted" }, "Expo push accepted");
      return {
        payload: { stage: "receipt" as const, token: job.token, ticketId: ticket.id },
        delayMs: 15 * 60 * 1000,
      };
    }
    const result = await postNotification(
      this.options.http,
      `${EXPO_BASE_URL}getReceipts`,
      { ids: [job.ticketId] },
      { Accept: "application/json" },
      this.options.now,
    );
    const parsed = z.object({ data: z.record(z.string(), TicketSchema) }).safeParse(result);
    if (!parsed.success) throw new DeliveryError("invalid_response", false);
    const receipt = parsed.data.data[job.ticketId];
    if (!receipt) throw new DeliveryError("receipt_pending", true, 60_000);
    if (receipt.status === "error") {
      this.logger.warn(
        { eventId, ticketId: job.ticketId, category: knownExpoError(receipt.details?.error) },
        "Expo receipt failure",
      );
      this.handleError(job.token, receipt.details?.error, eventId);
      return;
    }
    this.logger.info(
      { eventId, ticketId: job.ticketId, status: "delivered_to_push_provider" },
      "Expo receipt confirmed downstream submission",
    );
  }

  private handleError(token: string, category: string | undefined, eventId: string): void {
    if (category === "MessageRateExceeded") throw new DeliveryError("rate_limit", true);
    if (category === "DeviceNotRegistered") {
      try {
        this.options.revokeToken(token);
      } catch {
        throw new DeliveryError("token_revocation_persistence", true);
      }
      this.logger.info({ eventId, category }, "Invalid push token removed");
    }
    // InvalidCredentials is a project credential failure, not an invalid device subscription.
    throw new DeliveryError(
      category === "DeviceNotRegistered" ? "invalid_device" : "provider_rejected",
      false,
    );
  }
}

function knownExpoError(error?: string): string {
  const known = [
    "DeviceNotRegistered",
    "InvalidCredentials",
    "MessageRateExceeded",
    "MessageTooBig",
    "MismatchSenderId",
  ];
  return error && known.includes(error) ? error : "unknown";
}
