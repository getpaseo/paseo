import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";

import { writeJsonFileAtomic } from "../atomic-file.js";

const PendingFinishNotificationSchema = z.object({
  id: z.string().min(1),
  callerAgentId: z.string().min(1),
  childAgentId: z.string().min(1),
  event: z.enum(["finished", "errored", "permission-required", "closed"]),
  body: z.string(),
  createdAt: z.string(),
  // "dispatching" means the provider may already hold the notification.
  state: z.enum(["queued", "dispatching"]),
});

export type PendingFinishNotification = z.infer<typeof PendingFinishNotificationSchema>;

export interface FinishNotificationOutboxOptions {
  directory: string;
  logger: Logger;
}

/**
 * One file per finish notification that has not reached its caller yet, so a
 * notification waiting on a busy caller survives a daemon restart.
 */
export class FinishNotificationOutbox {
  private readonly directory: string;
  private readonly logger: Logger;

  constructor(options: FinishNotificationOutboxOptions) {
    this.directory = options.directory;
    this.logger = options.logger;
  }

  async save(notification: PendingFinishNotification): Promise<void> {
    await writeJsonFileAtomic(this.fileFor(notification.id), notification);
  }

  /** The record as it is on disk now, or null once it was removed. */
  async get(id: string): Promise<PendingFinishNotification | null> {
    try {
      return PendingFinishNotificationSchema.parse(
        JSON.parse(await readFile(this.fileFor(id), "utf8")),
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }

  async remove(id: string): Promise<void> {
    await rm(this.fileFor(id), { force: true });
  }

  async list(): Promise<PendingFinishNotification[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    const notifications: PendingFinishNotification[] = [];
    for (const name of names) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      const file = path.join(this.directory, name);
      try {
        notifications.push(
          PendingFinishNotificationSchema.parse(JSON.parse(await readFile(file, "utf8"))),
        );
      } catch (error) {
        this.logger.warn({ err: error, file }, "Skipping unreadable pending finish notification");
      }
    }
    return notifications.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private fileFor(id: string): string {
    return path.join(this.directory, `${encodeURIComponent(id)}.json`);
  }
}
