import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Logger } from "pino";
import { UsageReportEntrySchema } from "@getpaseo/protocol/messages";
import { writePrivateFileAtomic } from "../../private-files.js";

const RetainedUsageSchema = z.object({
  /** The registry's cache identity: account plus its ordered login set. */
  key: z.string(),
  /** When the entry was cached, on the registry's clock. */
  at: z.number(),
  entry: UsageReportEntrySchema,
  successful: UsageReportEntrySchema.shape.lastSuccessful,
});

const UsageReportFileSchema = z.object({ reports: z.array(RetainedUsageSchema) });

export type RetainedUsage = z.infer<typeof RetainedUsageSchema>;

/** The last fetch of each account, kept across daemon restarts. */
export interface UsageReportStore {
  /** Never rejects: a missing or unreadable store starts empty. */
  load(): Promise<RetainedUsage[]>;
  /** Replaces the whole list. Writes land in call order; never rejects, a failed write is logged. */
  save(reports: RetainedUsage[]): Promise<void>;
}

export interface UsageReportFile extends UsageReportStore {
  /** Resolves once every queued write has landed. */
  flush(): Promise<void>;
}

interface UsageReportFileOptions {
  filePath: string;
  logger: Pick<Logger, "warn">;
}

export function createUsageReportFile({
  filePath,
  logger,
}: UsageReportFileOptions): UsageReportFile {
  let queue = Promise.resolve();
  let written: string | undefined;

  async function write(text: string): Promise<void> {
    // Every list saves, and most lists change nothing.
    if (text === written) return;
    try {
      await writePrivateFileAtomic(filePath, text);
      written = text;
    } catch (error) {
      logger.warn({ err: error, filePath }, "Failed to save usage reports");
    }
  }

  return {
    async load() {
      let text: string;
      try {
        text = await readFile(filePath, "utf8");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          logger.warn({ err: error, filePath }, "Failed to read saved usage reports");
        }
        return [];
      }
      try {
        return UsageReportFileSchema.parse(JSON.parse(text)).reports;
      } catch (error) {
        if (!(error instanceof SyntaxError || error instanceof z.ZodError)) throw error;
        logger.warn({ err: error, filePath }, "Ignoring unreadable saved usage reports");
        return [];
      }
    },
    save(reports) {
      const text = JSON.stringify({ reports });
      queue = queue.then(() => write(text));
      return queue;
    },
    flush() {
      return queue;
    },
  };
}
