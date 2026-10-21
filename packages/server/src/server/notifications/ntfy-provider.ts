import { createHash } from "node:crypto";
import type pino from "pino";
import { z } from "zod";
import { DeliveryQueue } from "./delivery-queue.js";
import { postNotification, DeliveryError, type NotificationHttp } from "./notification-http.js";
import type { NotificationConfig } from "./notification-config.js";

const NtfyMessageSchema = z.object({
  title: z.string().max(256),
  message: z.string().max(2048),
  priority: z.enum(["min", "low", "default", "high", "urgent"]),
});
export type NtfyMessage = z.infer<typeof NtfyMessageSchema>;

export class NtfyProvider {
  private readonly queue: DeliveryQueue<NtfyMessage & { destination: string }>;
  private readonly destination: string;
  constructor(options: {
    config: NotificationConfig["ntfy"];
    logger: pino.Logger;
    filePath: string;
    http: NotificationHttp;
    now?: () => number;
    automatic?: boolean;
  }) {
    const logger = options.logger.child({ provider: "ntfy" });
    // JSON publishing supports UTF-8 titles without placing untrusted text in HTTP headers.
    const url = `${options.config.url!.replace(/\/+$/, "")}/`;
    this.destination = createHash("sha256").update(`${url}|${options.config.topic}`).digest("hex");
    this.queue = new DeliveryQueue({
      ...options,
      schema: NtfyMessageSchema.extend({ destination: z.string() }),
      logger,
      deliver: async (payload, eventId) => {
        if (payload.destination !== this.destination) {
          logger.info(
            { eventId, suppressionReason: "destination_changed" },
            "Notification suppressed",
          );
          return;
        }
        const result = await postNotification(
          options.http,
          url,
          {
            topic: options.config.topic,
            title: payload.title,
            message: payload.message,
            priority: { min: 1, low: 2, default: 3, high: 4, urgent: 5 }[payload.priority],
          },
          { Authorization: `Bearer ${options.config.token}` },
          options.now,
        );
        if (!z.object({ id: z.string(), event: z.literal("message") }).safeParse(result).success) {
          throw new DeliveryError("invalid_response", false);
        }
        logger.info({ eventId, status: "accepted" }, "ntfy notification accepted");
      },
    });
  }
  send(id: string, message: NtfyMessage): Promise<void> {
    return this.queue.enqueue(id, {
      ...NtfyMessageSchema.parse(message),
      destination: this.destination,
    });
  }
  drain(): Promise<void> {
    return this.queue.drain();
  }
  close(): Promise<void> {
    return this.queue.close();
  }
}
