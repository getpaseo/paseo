import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  StoredScheduleSchema,
  type ScheduleTarget,
  type StoredSchedule,
} from "@getpaseo/protocol/schedule/types";
import type { Logger } from "pino";
import { hasLegacyImportMarker, recordLegacyImportMarker } from "../db/legacy-imports.js";
import { runInTransaction } from "../db/transaction.js";

const LEGACY_IMPORT_STORE = "schedules";

function generateScheduleId(): string {
  return randomBytes(4).toString("hex");
}

type ScheduleUpdater = (schedule: StoredSchedule) => StoredSchedule | Promise<StoredSchedule>;

interface ScheduleNameTargetUpsert {
  create: () => Omit<StoredSchedule, "id"> | Promise<Omit<StoredSchedule, "id">>;
  update: ScheduleUpdater;
}

interface ScheduleStoreOptions {
  database: DatabaseSync;
  legacyDir: string;
  logger: Logger;
}

interface ScheduleRow {
  payload: string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(source)
        .sort()
        .map((key) => [key, canonicalize(source[key])]),
    );
  }
  return value;
}

function normalizeScheduleName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Schedule name is required");
  }
  return trimmed;
}

function normalizeOptionalScheduleName(name: string | null): string | null {
  if (name === null) {
    return null;
  }
  const trimmed = name.trim();
  return trimmed ? trimmed : null;
}

function targetIdentity(target: ScheduleTarget): unknown {
  if (target.type === "agent") {
    return {
      type: target.type,
      agentId: target.agentId,
    };
  }

  return {
    type: target.type,
    config: target.config,
  };
}

function nameTargetIdentityKey(name: string, target: ScheduleTarget): string {
  return JSON.stringify(
    canonicalize({
      name: normalizeScheduleName(name),
      target: targetIdentity(target),
    }),
  );
}

function matchesNameAndTarget(
  schedule: StoredSchedule,
  name: string,
  target: ScheduleTarget,
): boolean {
  const scheduleName = normalizeOptionalScheduleName(schedule.name);
  return (
    schedule.status !== "completed" &&
    scheduleName !== null &&
    scheduleName === normalizeScheduleName(name) &&
    nameTargetIdentityKey(scheduleName, schedule.target) === nameTargetIdentityKey(name, target)
  );
}

export class ScheduleStore {
  private readonly scheduleMutations = new Map<string, Promise<unknown>>();
  private readonly identityMutations = new Map<string, Promise<unknown>>();
  private readonly database: DatabaseSync;
  private readonly legacyDir: string;
  private readonly logger: Logger;

  constructor(options: ScheduleStoreOptions) {
    this.database = options.database;
    this.legacyDir = options.legacyDir;
    this.logger = options.logger.child({ component: "schedule-store" });
    this.importLegacySchedules();
  }

  async list(): Promise<StoredSchedule[]> {
    const rows = this.database
      .prepare("SELECT payload FROM schedules ORDER BY created_at, id")
      .all() as unknown as ScheduleRow[];
    return rows.map((row) => StoredScheduleSchema.parse(JSON.parse(row.payload)));
  }

  async get(id: string): Promise<StoredSchedule | null> {
    const row = this.database.prepare("SELECT payload FROM schedules WHERE id = ?").get(id) as
      | ScheduleRow
      | undefined;
    return row ? StoredScheduleSchema.parse(JSON.parse(row.payload)) : null;
  }

  async create(schedule: Omit<StoredSchedule, "id">): Promise<StoredSchedule> {
    const created = StoredScheduleSchema.parse({ ...schedule, id: generateScheduleId() });
    await this.write(created);
    return created;
  }

  async update(id: string, updater: ScheduleUpdater): Promise<StoredSchedule | null> {
    return this.serializeScheduleMutation(id, async () => {
      const current = await this.get(id);
      if (!current) {
        return null;
      }
      const next = await updater(current);
      if (next === current) {
        return current;
      }
      if (next.id !== id) {
        throw new Error(`Schedule update cannot change id: ${id}`);
      }
      const updated = StoredScheduleSchema.parse(next);
      await this.write(updated);
      return updated;
    });
  }

  async upsertByNameAndTarget(
    name: string,
    target: ScheduleTarget,
    options: ScheduleNameTargetUpsert,
  ): Promise<StoredSchedule> {
    const identity = nameTargetIdentityKey(name, target);
    return this.serializeIdentityMutation(identity, async () => {
      while (true) {
        const existing = (await this.list()).find((schedule) =>
          matchesNameAndTarget(schedule, name, target),
        );
        if (!existing) {
          const created = StoredScheduleSchema.parse({
            ...(await options.create()),
            id: generateScheduleId(),
          });
          if (!matchesNameAndTarget(created, name, target)) {
            throw new Error("Created schedule does not match requested identity");
          }
          await this.write(created);
          return created;
        }

        const updated = await this.updateMatchedSchedule(existing.id, name, target, options.update);
        if (updated) {
          return updated;
        }
      }
    });
  }

  private write(schedule: StoredSchedule): void {
    const identityKey =
      schedule.status !== "completed" && normalizeOptionalScheduleName(schedule.name) !== null
        ? nameTargetIdentityKey(schedule.name!, schedule.target)
        : null;
    this.database
      .prepare(
        `INSERT INTO schedules (id, created_at, identity_key, payload)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           created_at = excluded.created_at,
           identity_key = excluded.identity_key,
           payload = excluded.payload`,
      )
      .run(schedule.id, schedule.createdAt, identityKey, JSON.stringify(schedule));
  }

  private insert(schedule: StoredSchedule): void {
    const identityKey =
      schedule.status !== "completed" && normalizeOptionalScheduleName(schedule.name) !== null
        ? nameTargetIdentityKey(schedule.name!, schedule.target)
        : null;
    this.database
      .prepare(
        `INSERT INTO schedules (id, created_at, identity_key, payload)
         VALUES (?, ?, ?, ?)`,
      )
      .run(schedule.id, schedule.createdAt, identityKey, JSON.stringify(schedule));
  }

  async delete(id: string): Promise<void> {
    await this.serializeScheduleMutation(id, async () => {
      this.database.prepare("DELETE FROM schedules WHERE id = ?").run(id);
    });
  }

  private async serializeScheduleMutation<T>(
    scheduleId: string,
    mutation: () => Promise<T>,
  ): Promise<T> {
    return this.serializeMutation(this.scheduleMutations, scheduleId, mutation);
  }

  private async serializeIdentityMutation<T>(
    identity: string,
    mutation: () => Promise<T>,
  ): Promise<T> {
    return this.serializeMutation(this.identityMutations, identity, mutation);
  }

  private async serializeMutation<T>(
    promises: Map<string, Promise<unknown>>,
    key: string,
    mutation: () => Promise<T>,
  ): Promise<T> {
    const previous = promises.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(mutation);
    promises.set(key, next);
    try {
      return await next;
    } finally {
      if (promises.get(key) === next) {
        promises.delete(key);
      }
    }
  }

  private async updateMatchedSchedule(
    id: string,
    name: string,
    target: ScheduleTarget,
    updater: ScheduleUpdater,
  ): Promise<StoredSchedule | null> {
    return this.serializeScheduleMutation(id, async () => {
      const current = await this.get(id);
      if (!current || !matchesNameAndTarget(current, name, target)) {
        return null;
      }
      const next = await updater(current);
      if (next.id !== id) {
        throw new Error(`Schedule update cannot change id: ${id}`);
      }
      const updated = StoredScheduleSchema.parse(next);
      if (!matchesNameAndTarget(updated, name, target)) {
        throw new Error("Updated schedule does not match requested identity");
      }
      await this.write(updated);
      return updated;
    });
  }

  private count(): number {
    const row = this.database.prepare("SELECT count(*) AS count FROM schedules").get() as {
      count: number;
    };
    return row.count;
  }

  private importLegacySchedules(): void {
    if (hasLegacyImportMarker(this.database, LEGACY_IMPORT_STORE)) {
      return;
    }

    try {
      runInTransaction(this.database, () => {
        let importedCount = 0;
        let skippedCount = 0;
        if (this.count() === 0 && existsSync(this.legacyDir)) {
          const entries = readdirSync(this.legacyDir, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith(".json")) {
              continue;
            }
            const filePath = join(this.legacyDir, entry.name);
            const content = readFileSync(filePath, "utf-8");
            let json: unknown;
            try {
              json = JSON.parse(content);
            } catch (error) {
              skippedCount += 1;
              this.logger.warn({ err: error, filePath }, "Skipping invalid legacy schedule record");
              continue;
            }
            const parsed = StoredScheduleSchema.safeParse(json);
            if (!parsed.success) {
              skippedCount += 1;
              this.logger.warn(
                { err: parsed.error, filePath },
                "Skipping invalid legacy schedule record",
              );
              continue;
            }
            this.insert(parsed.data);
            importedCount += 1;
          }
        }
        recordLegacyImportMarker(this.database, LEGACY_IMPORT_STORE, {
          importedCount,
          skippedCount,
        });
        this.logger.info({ importedCount, skippedCount }, "Legacy schedule import complete");
      });
    } catch (error) {
      throw new Error(`Failed to import legacy schedules from ${this.legacyDir}`, { cause: error });
    }
  }
}
