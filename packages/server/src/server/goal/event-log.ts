import { mkdir, open, readFile, readdir, rename, truncate, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  GoalEventSchema,
  type GoalEvent,
  type GoalEventInput,
} from "@getpaseo/protocol/goal/types";

export class GoalEventLogCorruptionError extends Error {
  constructor(
    public readonly goalId: string,
    message: string,
  ) {
    super(`Goal ${goalId} event log is corrupt: ${message}`);
    this.name = "GoalEventLogCorruptionError";
  }
}

const GOAL_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** A deleted goal's log is renamed to this before anything else of it is removed. */
const TOMBSTONE_SUFFIX = ".jsonl.deleted";

export interface AppendResult {
  event: GoalEvent;
  /** True when an event with the same id was already in the log; nothing was written. */
  duplicate: boolean;
}

export interface GoalEventLogOptions {
  dir: string;
  now?: () => string;
}

interface LoadedLog {
  events: GoalEvent[];
  ids: Map<string, GoalEvent>;
}

/**
 * Append-only JSONL log, one file per goal. Each line is one event, written
 * with a single append followed by fsync. A line without a trailing newline is
 * a torn write from a crash and is truncated on load.
 */
export class GoalEventLog {
  private readonly dir: string;
  private readonly now: () => string;
  private readonly loaded = new Map<string, Promise<LoadedLog>>();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(options: GoalEventLogOptions) {
    this.dir = options.dir;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** The time an event appended now would carry. */
  timestamp(): string {
    return this.now();
  }

  async listGoalIds(): Promise<string[]> {
    try {
      const names = await readdir(this.dir);
      return names
        .filter((n) => n.endsWith(".jsonl"))
        .map((n) => n.slice(0, -".jsonl".length))
        .filter((id) => GOAL_ID_PATTERN.test(id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  /** Goals whose deletion started but may not have finished. */
  async listTombstones(): Promise<string[]> {
    try {
      const names = await readdir(this.dir);
      return names
        .filter((n) => n.endsWith(TOMBSTONE_SUFFIX))
        .map((n) => n.slice(0, -TOMBSTONE_SUFFIX.length))
        .filter((id) => GOAL_ID_PATTERN.test(id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  /**
   * First step of deleting a goal: its log is renamed out of the way in one atomic
   * step, so a crash leaves the goal either whole or marked deleted, never half there.
   * Returns false when the goal had no log.
   */
  async tombstone(goalId: string): Promise<boolean> {
    return this.serialized(goalId, async () => {
      try {
        await rename(this.filePath(goalId), this.tombstonePath(goalId));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      } finally {
        this.loaded.delete(goalId);
      }
      await this.syncDirectory();
      return true;
    });
  }

  /** The events of a tombstoned log, so its cleanup can be finished after a crash. */
  async readTombstone(goalId: string): Promise<GoalEvent[] | null> {
    return this.serialized(goalId, async () => {
      try {
        const text = await readFile(this.tombstonePath(goalId), "utf8");
        const lines = text.split("\n");
        lines.pop();
        return parseLines(goalId, lines).events;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    });
  }

  /** Last step of deleting a goal. Removing a tombstone that is gone is not an error. */
  async removeTombstone(goalId: string): Promise<void> {
    await this.serialized(goalId, async () => {
      try {
        await unlink(this.tombstonePath(goalId));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return;
      }
      await this.syncDirectory();
    });
  }

  async read(goalId: string): Promise<GoalEvent[]> {
    return this.serialized(goalId, async () => [...(await this.load(goalId)).events]);
  }

  async hasEvent(goalId: string, eventId: string): Promise<boolean> {
    return this.serialized(goalId, async () => (await this.load(goalId)).ids.has(eventId));
  }

  async append(goalId: string, input: GoalEventInput): Promise<AppendResult> {
    return this.serialized(goalId, async () => {
      const log = await this.load(goalId);
      const existing = log.ids.get(input.id);
      if (existing) {
        return { event: existing, duplicate: true };
      }
      const event = GoalEventSchema.parse({
        ...input,
        goalId,
        seq: log.events.length + 1,
        at: this.now(),
      });
      try {
        await this.writeLine(goalId, event);
      } catch (error) {
        // The file may now hold a partial or complete line the cache does not
        // know about. Drop the cache so the next use re-reads the disk.
        this.loaded.delete(goalId);
        throw error;
      }
      log.events.push(event);
      log.ids.set(event.id, event);
      return { event, duplicate: false };
    });
  }

  private filePath(goalId: string): string {
    if (!GOAL_ID_PATTERN.test(goalId)) {
      throw new Error(`Invalid goal id: ${goalId}`);
    }
    return join(this.dir, `${goalId}.jsonl`);
  }

  private tombstonePath(goalId: string): string {
    if (!GOAL_ID_PATTERN.test(goalId)) {
      throw new Error(`Invalid goal id: ${goalId}`);
    }
    return join(this.dir, `${goalId}${TOMBSTONE_SUFFIX}`);
  }

  private serialized<T>(goalId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(goalId) ?? Promise.resolve();
    const run = previous.then(task, task);
    this.queues.set(
      goalId,
      run.catch(() => undefined),
    );
    return run;
  }

  private load(goalId: string): Promise<LoadedLog> {
    let pending = this.loaded.get(goalId);
    if (!pending) {
      pending = this.readFromDisk(goalId);
      this.loaded.set(goalId, pending);
      pending.catch(() => this.loaded.delete(goalId));
    }
    return pending;
  }

  private async readFromDisk(goalId: string): Promise<LoadedLog> {
    const path = this.filePath(goalId);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { events: [], ids: new Map() };
      }
      throw error;
    }

    const lines = text.split("\n");
    const tail = lines.pop() ?? "";
    if (tail !== "") {
      await truncate(path, Buffer.byteLength(text.slice(0, text.length - tail.length)));
    }

    return parseLines(goalId, lines);
  }

  private async syncDirectory(): Promise<void> {
    const directory = await open(this.dir, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  private async writeLine(goalId: string, event: GoalEvent): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const created = event.seq === 1;
    const handle = await open(this.filePath(goalId), "a");
    try {
      await handle.write(`${JSON.stringify(event)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // A new file is only durable once its directory entry is too.
    if (created) await this.syncDirectory();
  }
}

function parseLines(goalId: string, lines: readonly string[]): LoadedLog {
  const events: GoalEvent[] = [];
  const ids = new Map<string, GoalEvent>();
  lines.forEach((line, index) => {
    let event: GoalEvent;
    try {
      event = GoalEventSchema.parse(JSON.parse(line));
    } catch (error) {
      throw new GoalEventLogCorruptionError(
        goalId,
        `line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (event.goalId !== goalId || event.seq !== index + 1 || ids.has(event.id)) {
      throw new GoalEventLogCorruptionError(
        goalId,
        `line ${index + 1}: unexpected goalId, seq ${event.seq}, or repeated id ${event.id}`,
      );
    }
    events.push(event);
    ids.set(event.id, event);
  });
  return { events, ids };
}
