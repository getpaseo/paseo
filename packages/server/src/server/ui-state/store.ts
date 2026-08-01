import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  UiStateRecordSchema,
  type UiStateNamespace,
  type UiStateRecord,
} from "@getpaseo/protocol/ui-state/schemas";
import { writeJsonFileAtomic } from "../atomic-file.js";
import { sanitizeUiStateKey } from "./keys.js";

export interface UiStateListEntry {
  key: string;
  record: UiStateRecord;
}

export interface UiStateUpsertResult {
  applied: boolean;
  record: UiStateRecord | null;
}

export interface UiStateClearResult {
  applied: boolean;
}

const StoredUiStateFileSchema = z.object({
  key: z.string().min(1),
  record: UiStateRecordSchema,
});

export class UiStateStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly paseoHome: string) {}

  async get(input: { namespace: UiStateNamespace; key: string }): Promise<UiStateRecord | null> {
    const filePath = this.filePath(input.namespace, input.key);
    try {
      const raw = JSON.parse(await readFile(filePath, "utf8"));
      const parsed = StoredUiStateFileSchema.parse(raw);
      return parsed.record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async upsert(input: {
    namespace: UiStateNamespace;
    key: string;
    record: UiStateRecord;
  }): Promise<UiStateUpsertResult> {
    return this.mutate(async () => {
      const existing = await this.get({ namespace: input.namespace, key: input.key });
      if (existing && isStrictlyNewer(existing.updatedAt, input.record.updatedAt)) {
        return { applied: false, record: existing };
      }
      if (existing && recordsEqual(existing, input.record)) {
        return { applied: true, record: existing };
      }

      const record = UiStateRecordSchema.parse(input.record);
      await this.ensureDir(input.namespace);
      await writeJsonFileAtomic(this.filePath(input.namespace, input.key), {
        key: input.key,
        record,
      });
      return { applied: true, record };
    });
  }

  async clear(input: {
    namespace: UiStateNamespace;
    key: string;
    updatedAt: string;
  }): Promise<UiStateClearResult> {
    return this.mutate(async () => {
      const existing = await this.get({ namespace: input.namespace, key: input.key });
      if (!existing) {
        return { applied: true };
      }
      if (isStrictlyNewer(existing.updatedAt, input.updatedAt)) {
        return { applied: false };
      }
      await rm(this.filePath(input.namespace, input.key), { force: true });
      return { applied: true };
    });
  }

  async list(input: {
    namespace: UiStateNamespace;
    keyPrefix?: string;
  }): Promise<UiStateListEntry[]> {
    const dir = this.dir(input.namespace);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const prefix = input.keyPrefix ?? "";
    const entries: UiStateListEntry[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) {
        continue;
      }
      const filePath = join(dir, name);
      try {
        const raw = JSON.parse(await readFile(filePath, "utf8"));
        const parsed = StoredUiStateFileSchema.parse(raw);
        if (prefix && !parsed.key.startsWith(prefix)) {
          continue;
        }
        entries.push({ key: parsed.key, record: parsed.record });
      } catch {
        // Skip corrupt files rather than failing the whole list.
      }
    }
    return entries.sort((left, right) => left.key.localeCompare(right.key));
  }

  private dir(namespace: UiStateNamespace): string {
    return join(this.paseoHome, "ui-state", namespace);
  }

  private filePath(namespace: UiStateNamespace, key: string): string {
    return join(this.dir(namespace), `${sanitizeUiStateKey(key)}.json`);
  }

  private async ensureDir(namespace: UiStateNamespace): Promise<void> {
    await mkdir(this.dir(namespace), { recursive: true });
  }

  private mutate<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

function isStrictlyNewer(leftIso: string, rightIso: string): boolean {
  return leftIso.localeCompare(rightIso) > 0;
}

function recordsEqual(left: UiStateRecord, right: UiStateRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
