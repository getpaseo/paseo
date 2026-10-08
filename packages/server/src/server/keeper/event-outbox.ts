import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { KeeperEvent } from "@getpaseo/protocol/messages";
import { writeFileAtomic, writeJsonFileAtomic } from "../atomic-file.js";

export type KeeperEventInput = Omit<KeeperEvent, "eventId" | "seq" | "timestamp">;

export interface KeeperEventPage {
  events: KeeperEvent[];
  nextCursor: string;
  headCursor: string;
  resyncRequired: boolean;
}

interface Waiter {
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
}

const MetaSchema = z.object({ epoch: z.string().min(1) });
const EventLineSchema = z.object({
  eventId: z.string(),
  seq: z.number().int().nonnegative(),
  timestamp: z.string(),
  category: z.string(),
  type: z.string(),
  agentId: z.string(),
  bootId: z.string(),
  sessionIncarnation: z.string().nullable(),
  permissionGeneration: z.number().int().nonnegative().nullable(),
  permissionRequestId: z.string().nullable(),
  turnId: z.string().nullable(),
  lifecycle: z.string().nullable(),
});

// Durable event log addressed by `<epoch>.<seq>` cursors; reads return only events already on
// disk, so a consumer never sees one that a restart would forget.
export class KeeperEventOutbox {
  private readonly events: KeeperEvent[];
  private nextSeq: number;
  private flushedSeq: number;
  private fileLines: number;
  private chain: Promise<void> = Promise.resolve();
  private waiters = new Set<Waiter>();
  private writeError: Error | null = null;

  private constructor(
    private readonly directory: string,
    private readonly epoch: string,
    loaded: KeeperEvent[],
    private readonly maxEvents: number,
    private readonly now: () => Date,
  ) {
    this.events = loaded;
    const last = loaded.at(-1)?.seq ?? 0;
    this.nextSeq = last + 1;
    this.flushedSeq = last;
    this.fileLines = loaded.length;
  }

  static async open(
    directory: string,
    options: { maxEvents?: number; now?: () => Date } = {},
  ): Promise<KeeperEventOutbox> {
    await mkdir(directory, { recursive: true });
    const metaPath = path.join(directory, "meta.json");
    const existingEpoch = await readEpoch(metaPath);
    const raw = await readText(path.join(directory, "events.jsonl"));
    // Meta without a log means the log was lost: a new epoch forces consumers to resync.
    const reuse = existingEpoch !== null && raw !== null;
    const epoch = reuse ? existingEpoch : randomUUID();
    if (!reuse) await writeJsonFileAtomic(metaPath, { epoch });
    const maxEvents = options.maxEvents ?? 10_000;
    const loaded = parseEvents(raw ?? "").slice(-maxEvents);
    if (raw && !isCleanLog(raw, loaded.length)) {
      // A torn tail would swallow the next append, so the log is rewritten first.
      const body = loaded.map((e) => JSON.stringify(e)).join("\n");
      await writeFileAtomic(path.join(directory, "events.jsonl"), body ? `${body}\n` : "");
    }
    const now = options.now ?? (() => new Date());
    return new KeeperEventOutbox(directory, epoch, loaded, maxEvents, now);
  }

  append(input: KeeperEventInput): KeeperEvent {
    const seq = this.nextSeq++;
    const event: KeeperEvent = {
      ...input,
      eventId: `${this.epoch}.${seq}`,
      seq,
      timestamp: this.now().toISOString(),
    };
    this.events.push(event);
    this.fileLines += 1;
    this.chain = this.chain.then(() => this.persist(event));
    return event;
  }

  headCursor(): string {
    return this.cursorFor(this.flushedSeq);
  }

  async flush(): Promise<void> {
    await this.chain;
  }

  lastWriteError(): Error | null {
    return this.writeError;
  }

  async read(cursor: string | null, limit: number, waitMs: number): Promise<KeeperEventPage> {
    const parsed = this.parseCursor(cursor);
    if (parsed === "resync") return this.page([], this.flushedSeq, true);
    if (waitMs > 0 && this.flushedSeq <= parsed) await this.waitForFlush(waitMs);
    const oldest = this.events[0]?.seq ?? this.nextSeq;
    if (parsed + 1 < oldest && parsed < this.flushedSeq) {
      return this.page([], this.flushedSeq, true);
    }
    const ready = this.events.filter((e) => e.seq > parsed && e.seq <= this.flushedSeq);
    const batch = ready.slice(0, limit);
    return this.page(batch, batch.at(-1)?.seq ?? parsed, false);
  }

  close(): void {
    this.wake();
  }

  private page(events: KeeperEvent[], next: number, resyncRequired: boolean): KeeperEventPage {
    return {
      events,
      nextCursor: this.cursorFor(next),
      headCursor: this.headCursor(),
      resyncRequired,
    };
  }

  private cursorFor(seq: number): string {
    return `${this.epoch}.${seq}`;
  }

  private parseCursor(cursor: string | null): number | "resync" {
    if (cursor === null) return (this.events[0]?.seq ?? this.nextSeq) - 1;
    const dot = cursor.lastIndexOf(".");
    if (dot < 0 || cursor.slice(0, dot) !== this.epoch) return "resync";
    const seq = Number(cursor.slice(dot + 1));
    if (!Number.isInteger(seq) || seq < 0 || seq >= this.nextSeq) return "resync";
    return seq;
  }

  private waitForFlush(waitMs: number): Promise<void> {
    return new Promise((resolve) => {
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          resolve();
        }, waitMs),
      };
      this.waiters.add(waiter);
    });
  }

  private wake(): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    this.waiters.clear();
  }

  private async persist(event: KeeperEvent): Promise<void> {
    // After a failed write later events are not flushed, or the log would have a hole.
    if (this.writeError) return;
    try {
      await appendFile(path.join(this.directory, "events.jsonl"), `${JSON.stringify(event)}\n`);
      this.flushedSeq = event.seq;
      await this.compactIfNeeded();
    } catch (error) {
      this.writeError = error instanceof Error ? error : new Error(String(error));
    }
    this.wake();
  }

  private async compactIfNeeded(): Promise<void> {
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
    if (this.fileLines <= this.maxEvents * 2) return;
    const retained = this.events.filter((e) => e.seq <= this.flushedSeq);
    const body = retained.map((e) => JSON.stringify(e)).join("\n");
    await writeFileAtomic(path.join(this.directory, "events.jsonl"), body ? `${body}\n` : "");
    this.fileLines = retained.length;
  }
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function readEpoch(file: string): Promise<string | null> {
  const raw = await readText(file);
  if (raw === null) return null;
  try {
    return MetaSchema.parse(JSON.parse(raw)).epoch;
  } catch {
    return null;
  }
}

function isCleanLog(raw: string, parsed: number): boolean {
  return raw.endsWith("\n") && raw.split("\n").filter(Boolean).length === parsed;
}

function parseEvents(raw: string): KeeperEvent[] {
  const out: KeeperEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const event = EventLineSchema.parse(JSON.parse(line));
      if (event.seq > (out.at(-1)?.seq ?? 0)) out.push(event);
    } catch {
      // A torn final line was never reported as flushed, so it is dropped.
    }
  }
  return out;
}
