import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { StoredScheduleSchema, type StoredSchedule } from "@getpaseo/protocol/schedule/types";
import { writeJsonFileAtomic } from "../atomic-file.js";

function generateScheduleId(): string {
  return randomBytes(4).toString("hex");
}

type ScheduleUpdater = (schedule: StoredSchedule) => StoredSchedule | Promise<StoredSchedule>;

interface ScheduleIdentityUpsert {
  identity: string;
  matches: (schedule: StoredSchedule) => boolean;
  create: () => Omit<StoredSchedule, "id"> | Promise<Omit<StoredSchedule, "id">>;
  update: ScheduleUpdater;
}

export class ScheduleStore {
  private readonly scheduleMutations = new Map<string, Promise<unknown>>();
  private readonly identityMutations = new Map<string, Promise<unknown>>();

  constructor(private readonly dir: string) {}

  private filePath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async list(): Promise<StoredSchedule[]> {
    await this.ensureDir();
    const entries = await readdir(this.dir, { withFileTypes: true });
    const schedules = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          const content = await readFile(join(this.dir, entry.name), "utf-8");
          return StoredScheduleSchema.parse(JSON.parse(content));
        }),
    );
    return schedules.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async get(id: string): Promise<StoredSchedule | null> {
    await this.ensureDir();
    try {
      const content = await readFile(this.filePath(id), "utf-8");
      return StoredScheduleSchema.parse(JSON.parse(content));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async create(schedule: Omit<StoredSchedule, "id">): Promise<StoredSchedule> {
    const created = StoredScheduleSchema.parse({ ...schedule, id: generateScheduleId() });
    await this.write(created);
    return created;
  }

  async put(schedule: StoredSchedule): Promise<void> {
    await this.serializeScheduleMutation(schedule.id, async () => {
      await this.write(StoredScheduleSchema.parse(schedule));
    });
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

  async upsertByIdentity(options: ScheduleIdentityUpsert): Promise<StoredSchedule> {
    return this.serializeIdentityMutation(options.identity, async () => {
      const existing = (await this.list()).find(options.matches);
      if (!existing) {
        const created = StoredScheduleSchema.parse({
          ...(await options.create()),
          id: generateScheduleId(),
        });
        await this.write(created);
        return created;
      }

      const updated = await this.update(existing.id, options.update);
      if (updated) {
        return updated;
      }

      const created = StoredScheduleSchema.parse({
        ...(await options.create()),
        id: generateScheduleId(),
      });
      await this.write(created);
      return created;
    });
  }

  private async write(schedule: StoredSchedule): Promise<void> {
    await this.ensureDir();
    await writeJsonFileAtomic(this.filePath(schedule.id), schedule);
  }

  async delete(id: string): Promise<void> {
    await this.serializeScheduleMutation(id, async () => {
      await this.ensureDir();
      await rm(this.filePath(id), { force: true });
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
}
