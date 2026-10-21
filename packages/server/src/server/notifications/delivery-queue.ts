import { existsSync, readFileSync } from "node:fs";
import type pino from "pino";
import { z } from "zod";
import { ensurePrivateFile, writePrivateFileAtomicSync } from "../private-files.js";
import { DeliveryError } from "./notification-http.js";

const MAX_ENTRIES = 1024;
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 5;
interface QueueEntry<T> {
  id: string;
  payload: T;
  dueAt: number;
  expiresAt: number;
  attempts: number;
  status: "pending" | "completed" | "failed";
  failureCategory?: string;
}
export interface DeliveryContinuation<T> {
  payload: T;
  delayMs: number;
}

// Each provider owns a separate worker so its retries cannot block another destination.
export class DeliveryQueue<T> {
  private entries = new Map<string, QueueEntry<T>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private closed = false;
  private nextAttemptAt = 0;
  private readonly now: () => number;
  private readonly random: () => number;
  constructor(
    private readonly options: {
      filePath: string;
      schema: z.ZodType<T>;
      logger: pino.Logger;
      deliver: (payload: T, id: string) => Promise<DeliveryContinuation<T> | void>;
      now?: () => number;
      random?: () => number;
      automatic?: boolean;
    },
  ) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    if (existsSync(options.filePath)) {
      ensurePrivateFile(options.filePath);
      const schema = z
        .array(
          z.object({
            id: z.string(),
            payload: options.schema,
            dueAt: z.number().finite(),
            expiresAt: z.number().finite(),
            attempts: z.number().int().min(0).max(MAX_ATTEMPTS),
            status: z.enum(["pending", "completed", "failed"]),
            failureCategory: z.string().optional(),
          }),
        )
        .max(MAX_ENTRIES);
      let persisted: unknown;
      try {
        persisted = JSON.parse(readFileSync(options.filePath, "utf8"));
      } catch {
        throw new Error("Unable to read notification delivery queue");
      }
      const result = schema.safeParse(persisted);
      if (!result.success) throw new Error("Invalid notification delivery queue");
      this.entries = new Map(result.data.map((entry) => [entry.id, entry]));
    }
    this.prune();
    this.schedule();
  }

  async enqueue(id: string, payload: T): Promise<void> {
    if (this.closed) return;
    this.prune();
    if (this.entries.has(id)) return;
    if (Buffer.byteLength(JSON.stringify(payload), "utf8") > 8192)
      throw new DeliveryError("payload_too_large", false);
    if (this.entries.size >= MAX_ENTRIES) {
      const completed = [...this.entries.values()].find((entry) => entry.status !== "pending");
      if (completed) this.entries.delete(completed.id);
      else {
        this.options.logger.error(
          { eventId: id, category: "queue_full" },
          "Notification permanent delivery failure",
        );
        throw new DeliveryError("queue_full", false);
      }
    }
    const entry = {
      id,
      payload,
      dueAt: this.now(),
      expiresAt: this.now() + DEDUP_TTL_MS,
      attempts: 0,
      status: "pending" as const,
    };
    this.entries.set(id, entry);
    try {
      this.persist();
    } catch (error) {
      this.entries.delete(id);
      throw error;
    }
    await this.drain();
  }

  drain(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (!this.running) {
      this.running = this.process().finally(() => {
        this.running = undefined;
        this.schedule();
      });
    }
    return this.running;
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    try {
      await this.running;
    } catch {
      this.options.logger.error(
        { category: "persistence" },
        "Notification queue unavailable during shutdown",
      );
    }
  }

  private async process(): Promise<void> {
    for (const entry of Array.from(this.entries.values())) {
      if (this.closed) break;
      if (entry.status !== "pending") continue;
      if (entry.expiresAt <= this.now() || entry.attempts >= MAX_ATTEMPTS) {
        entry.status = "failed";
        entry.failureCategory =
          entry.attempts >= MAX_ATTEMPTS ? "retry_budget_exhausted" : "expired";
        this.options.logger.warn(
          {
            eventId: entry.id,
            category: entry.failureCategory,
          },
          "Notification permanent delivery failure",
        );
        this.persist();
        continue;
      }
      if (entry.dueAt > this.now()) continue;
      if (this.nextAttemptAt > this.now()) {
        entry.dueAt = this.nextAttemptAt;
        continue;
      }
      this.nextAttemptAt = this.now() + 200;
      entry.attempts += 1;
      // Persist the attempt before I/O, so repeated restarts cannot reset the retry budget.
      this.persist();
      this.options.logger.debug(
        { eventId: entry.id, attempt: entry.attempts },
        "Notification delivery attempt",
      );
      try {
        const next = await this.options.deliver(entry.payload, entry.id);
        if (next) {
          entry.payload = next.payload;
          entry.dueAt = this.now() + next.delayMs;
          entry.attempts = 0;
          delete entry.failureCategory;
        } else {
          entry.status = "completed";
          delete entry.failureCategory;
        }
      } catch (error) {
        const failure =
          error instanceof DeliveryError ? error : new DeliveryError("internal", false);
        entry.failureCategory = failure.category;
        if (failure.retryable && entry.attempts < MAX_ATTEMPTS) {
          const delayMs = Math.max(
            failure.retryAfterMs,
            1000 * 2 ** (entry.attempts - 1) * (1 + this.random()),
          );
          entry.dueAt = this.now() + delayMs;
          this.options.logger.warn(
            {
              eventId: entry.id,
              category: failure.category,
              status: failure.status,
              retryCount: entry.attempts,
              delayMs,
            },
            "Notification delivery retry",
          );
        } else {
          entry.status = "failed";
          this.options.logger.error(
            {
              eventId: entry.id,
              category: failure.category,
              status: failure.status,
              attempts: entry.attempts,
            },
            "Notification permanent delivery failure",
          );
        }
      }
      this.persist();
    }
    this.persist();
  }

  private prune(): void {
    for (const [id, entry] of this.entries) {
      if (entry.status !== "pending" && entry.expiresAt <= this.now()) this.entries.delete(id);
    }
  }

  private persist(): void {
    try {
      writePrivateFileAtomicSync(this.options.filePath, JSON.stringify([...this.entries.values()]));
    } catch {
      throw new DeliveryError("persistence", true);
    }
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (this.closed || this.options.automatic === false) return;
    const pending = [...this.entries.values()].filter((entry) => entry.status === "pending");
    if (!pending.length) return;
    const delay = Math.max(
      0,
      Math.min(...pending.map((entry) => Math.min(entry.dueAt, entry.expiresAt))) - this.now(),
    );
    this.timer = setTimeout(
      () => {
        void this.drain().catch(() =>
          this.options.logger.error({ category: "persistence" }, "Notification queue unavailable"),
        );
      },
      Math.max(200, Math.min(delay, 2_147_483_647)),
    );
    this.timer.unref();
  }
}
