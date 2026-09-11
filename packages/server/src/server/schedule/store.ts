import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  ScheduleStatusSchema,
  StoredScheduleSchema,
  type ScheduleTarget,
  type StoredSchedule,
} from "@getpaseo/protocol/schedule/types";
import { writeJsonFileAtomic } from "../atomic-file.js";

function generateScheduleId(): string {
  return randomBytes(4).toString("hex");
}

type ScheduleUpdater = (schedule: StoredSchedule) => StoredSchedule | Promise<StoredSchedule>;

const ScheduleMutationVersionSchema = z.object({
  generation: z.string(),
  sequence: z.number().int().nonnegative(),
});
type ScheduleMutationVersion = z.infer<typeof ScheduleMutationVersionSchema>;

const PersistedScheduleSchema = StoredScheduleSchema.extend({
  _mutationVersion: ScheduleMutationVersionSchema,
});
type PersistedSchedule = z.infer<typeof PersistedScheduleSchema>;

const ScheduleStateSchema = z.object({
  status: ScheduleStatusSchema,
  pausedAt: z.string().nullable(),
  nextRunAt: z.string().nullable(),
});
export type ScheduleState = z.infer<typeof ScheduleStateSchema>;

const ScheduleStateReceiptSchema = z.object({
  version: ScheduleMutationVersionSchema,
  state: ScheduleStateSchema,
  schedule: StoredScheduleSchema,
});
type ScheduleStateReceipt = z.infer<typeof ScheduleStateReceiptSchema>;

const ScheduleStateOperationSchema = z.object({
  operationId: z.string(),
  scheduleId: z.string(),
  targetStatus: z.enum(["active", "paused"]),
  phase: z.enum(["prepared", "applied", "restore-prepared", "restored"]),
  before: ScheduleStateReceiptSchema,
  after: ScheduleStateReceiptSchema,
  restored: ScheduleStateReceiptSchema.optional(),
});
type ScheduleStateOperation = z.infer<typeof ScheduleStateOperationSchema>;

export interface ScheduleStateOperationResult {
  schedule: StoredSchedule;
  replayed: boolean;
  isCurrent: boolean;
}

export interface ScheduleStoreTestHooks {
  afterOperationPrepared?: () => void | Promise<void>;
  afterScheduleWritten?: () => void | Promise<void>;
  afterRestorePrepared?: () => void | Promise<void>;
  afterRestoreScheduleWritten?: () => void | Promise<void>;
}

interface ScheduleNameTargetUpsert {
  create: () => Omit<StoredSchedule, "id"> | Promise<Omit<StoredSchedule, "id">>;
  update: ScheduleUpdater;
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

  constructor(
    private readonly dir: string,
    private readonly testHooks: ScheduleStoreTestHooks = {},
  ) {}

  private filePath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private operationFilePath(operationId: string): string {
    const digest = createHash("sha256").update(operationId).digest("hex");
    return join(this.dir, "operations", `${digest}.json`);
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
          const id = entry.name.slice(0, -".json".length);
          const persisted = await this.getPersisted(id);
          if (!persisted) {
            throw new Error(`Schedule disappeared while listing: ${id}`);
          }
          return this.toStoredSchedule(persisted);
        }),
    );
    return schedules.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async get(id: string): Promise<StoredSchedule | null> {
    const persisted = await this.getPersisted(id);
    return persisted ? this.toStoredSchedule(persisted) : null;
  }

  private async getPersisted(id: string): Promise<PersistedSchedule | null> {
    await this.ensureDir();
    try {
      const content = await readFile(this.filePath(id), "utf-8");
      const parsed = JSON.parse(content) as Record<string, unknown>;
      if (parsed._mutationVersion === undefined) {
        return PersistedScheduleSchema.parse({
          ...parsed,
          _mutationVersion: {
            generation: createHash("sha256")
              .update(JSON.stringify(canonicalize(parsed)))
              .digest("hex"),
            sequence: 0,
          },
        });
      }
      return PersistedScheduleSchema.parse(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async create(schedule: Omit<StoredSchedule, "id">): Promise<StoredSchedule> {
    const created = StoredScheduleSchema.parse({ ...schedule, id: generateScheduleId() });
    await this.writePersisted({
      ...created,
      _mutationVersion: { generation: randomUUID(), sequence: 0 },
    });
    return created;
  }

  async update(id: string, updater: ScheduleUpdater): Promise<StoredSchedule | null> {
    return this.serializeScheduleMutation(id, async () => {
      const persisted = await this.getPersisted(id);
      if (!persisted) {
        return null;
      }
      const current = this.toStoredSchedule(persisted);
      const next = await updater(current);
      if (next === current) {
        return current;
      }
      if (next.id !== id) {
        throw new Error(`Schedule update cannot change id: ${id}`);
      }
      const updated = StoredScheduleSchema.parse(next);
      await this.writePersisted({
        ...updated,
        _mutationVersion: this.nextMutationVersion(persisted._mutationVersion),
      });
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
          await this.writePersisted({
            ...created,
            _mutationVersion: { generation: randomUUID(), sequence: 0 },
          });
          return created;
        }

        const updated = await this.updateMatchedSchedule(existing.id, name, target, options.update);
        if (updated) {
          return updated;
        }
      }
    });
  }

  private async writePersisted(schedule: PersistedSchedule): Promise<void> {
    await this.ensureDir();
    await writeJsonFileAtomic(this.filePath(schedule.id), schedule);
  }

  private toStoredSchedule(schedule: PersistedSchedule): StoredSchedule {
    return StoredScheduleSchema.parse(schedule);
  }

  private nextMutationVersion(version: ScheduleMutationVersion): ScheduleMutationVersion {
    return { ...version, sequence: version.sequence + 1 };
  }

  async delete(id: string): Promise<void> {
    await this.serializeScheduleMutation(id, async () => {
      await this.ensureDir();
      await rm(this.filePath(id), { force: true });
    });
  }

  async transitionState(
    input: { operationId: string; scheduleId: string; targetStatus: "active" | "paused" },
    transition: ScheduleUpdater,
  ): Promise<ScheduleStateOperationResult> {
    return this.serializeIdentityMutation(`state-operation:${input.operationId}`, async () => {
      const existing = await this.getOperation(input.operationId);
      if (existing) {
        this.assertMatchingOperation(existing, input);
        if (existing.phase === "restored" || existing.phase === "restore-prepared") {
          throw new Error(`Schedule state operation ${input.operationId} was already restored`);
        }
        return this.serializeScheduleMutation(input.scheduleId, async () => {
          const operation = await this.reconcileTransition(existing);
          const current = await this.getPersisted(input.scheduleId);
          return {
            schedule: operation.after.schedule,
            replayed: true,
            isCurrent: current !== null && this.matchesReceipt(current, operation.after),
          };
        });
      }

      return this.serializeScheduleMutation(input.scheduleId, async () => {
        const raced = await this.getOperation(input.operationId);
        if (raced) {
          this.assertMatchingOperation(raced, input);
          const operation = await this.reconcileTransition(raced);
          const current = await this.getPersisted(input.scheduleId);
          return {
            schedule: operation.after.schedule,
            replayed: true,
            isCurrent: current !== null && this.matchesReceipt(current, operation.after),
          };
        }

        const beforePersisted = await this.getPersisted(input.scheduleId);
        if (!beforePersisted) {
          throw new Error(`Schedule not found: ${input.scheduleId}`);
        }
        const before = this.toStoredSchedule(beforePersisted);
        const after = StoredScheduleSchema.parse(await transition(before));
        if (after.id !== input.scheduleId) {
          throw new Error(`Schedule update cannot change id: ${input.scheduleId}`);
        }
        const afterPersisted: PersistedSchedule = {
          ...after,
          _mutationVersion: this.nextMutationVersion(beforePersisted._mutationVersion),
        };
        const operation: ScheduleStateOperation = {
          ...input,
          phase: "prepared",
          before: this.toReceipt(beforePersisted),
          after: this.toReceipt(afterPersisted),
        };
        await this.writeOperation(operation);
        await this.testHooks.afterOperationPrepared?.();
        await this.writePersisted(afterPersisted);
        await this.testHooks.afterScheduleWritten?.();
        await this.writeOperation({ ...operation, phase: "applied" });
        return { schedule: after, replayed: false, isCurrent: true };
      });
    });
  }

  async restoreState(
    input: { operationId: string; scheduleId: string },
    restore: (schedule: StoredSchedule, state: ScheduleState) => StoredSchedule,
  ): Promise<ScheduleStateOperationResult> {
    return this.serializeIdentityMutation(`state-operation:${input.operationId}`, async () => {
      const operation = await this.getOperation(input.operationId);
      if (!operation) {
        throw new Error(`Schedule state operation not found: ${input.operationId}`);
      }
      if (operation.scheduleId !== input.scheduleId) {
        throw new Error(
          `Schedule state operation ${input.operationId} belongs to another schedule`,
        );
      }
      return this.serializeScheduleMutation(input.scheduleId, async () => {
        let reconciled = await this.reconcileTransition(operation);
        if (reconciled.phase === "restored") {
          const current = await this.getPersisted(input.scheduleId);
          return {
            schedule: reconciled.restored!.schedule,
            replayed: true,
            isCurrent: current !== null && this.matchesReceipt(current, reconciled.restored!),
          };
        }
        if (reconciled.phase === "restore-prepared") {
          reconciled = await this.reconcileRestore(reconciled);
          return { schedule: reconciled.restored!.schedule, replayed: true, isCurrent: true };
        }

        const current = await this.getPersisted(input.scheduleId);
        if (!current || !this.matchesReceipt(current, reconciled.after)) {
          throw new Error(
            `Schedule ${input.scheduleId} changed after operation ${input.operationId}; refusing restore`,
          );
        }
        const restoredSchedule = StoredScheduleSchema.parse(
          restore(this.toStoredSchedule(current), reconciled.before.state),
        );
        const restoredPersisted: PersistedSchedule = {
          ...restoredSchedule,
          _mutationVersion: this.nextMutationVersion(current._mutationVersion),
        };
        reconciled = {
          ...reconciled,
          phase: "restore-prepared",
          restored: this.toReceipt(restoredPersisted),
        };
        await this.writeOperation(reconciled);
        await this.testHooks.afterRestorePrepared?.();
        await this.writePersisted(restoredPersisted);
        await this.testHooks.afterRestoreScheduleWritten?.();
        reconciled = { ...reconciled, phase: "restored" };
        await this.writeOperation(reconciled);
        return { schedule: restoredSchedule, replayed: false, isCurrent: true };
      });
    });
  }

  private async reconcileTransition(
    operation: ScheduleStateOperation,
  ): Promise<ScheduleStateOperation> {
    if (operation.phase !== "prepared") {
      return operation;
    }
    const current = await this.getPersisted(operation.scheduleId);
    if (current && this.matchesReceipt(current, operation.after)) {
      const applied = { ...operation, phase: "applied" as const };
      await this.writeOperation(applied);
      return applied;
    }
    if (current && this.matchesReceipt(current, operation.before)) {
      const afterPersisted = PersistedScheduleSchema.parse({
        ...operation.after.schedule,
        _mutationVersion: operation.after.version,
      });
      await this.writePersisted(afterPersisted);
      const applied = { ...operation, phase: "applied" as const };
      await this.writeOperation(applied);
      return applied;
    }
    throw new Error(
      `Schedule ${operation.scheduleId} no longer matches prepared operation ${operation.operationId}`,
    );
  }

  private async reconcileRestore(
    operation: ScheduleStateOperation,
  ): Promise<ScheduleStateOperation> {
    const restored = operation.restored;
    if (operation.phase !== "restore-prepared" || !restored) {
      return operation;
    }
    const current = await this.getPersisted(operation.scheduleId);
    if (current && this.matchesReceipt(current, restored)) {
      const completed = { ...operation, phase: "restored" as const };
      await this.writeOperation(completed);
      return completed;
    }
    if (current && this.matchesReceipt(current, operation.after)) {
      const restoredPersisted = PersistedScheduleSchema.parse({
        ...restored.schedule,
        _mutationVersion: restored.version,
      });
      await this.writePersisted(restoredPersisted);
      const completed = { ...operation, phase: "restored" as const };
      await this.writeOperation(completed);
      return completed;
    }
    throw new Error(
      `Schedule ${operation.scheduleId} changed during restore ${operation.operationId}`,
    );
  }

  private toReceipt(schedule: PersistedSchedule): ScheduleStateReceipt {
    const stored = this.toStoredSchedule(schedule);
    return {
      version: schedule._mutationVersion,
      state: {
        status: stored.status,
        pausedAt: stored.pausedAt,
        nextRunAt: stored.nextRunAt,
      },
      schedule: stored,
    };
  }

  private matchesReceipt(schedule: PersistedSchedule, receipt: ScheduleStateReceipt): boolean {
    return (
      schedule._mutationVersion.generation === receipt.version.generation &&
      schedule._mutationVersion.sequence === receipt.version.sequence &&
      schedule.status === receipt.state.status &&
      schedule.pausedAt === receipt.state.pausedAt &&
      schedule.nextRunAt === receipt.state.nextRunAt
    );
  }

  private assertMatchingOperation(
    operation: ScheduleStateOperation,
    input: { operationId: string; scheduleId: string; targetStatus: "active" | "paused" },
  ): void {
    if (
      operation.scheduleId !== input.scheduleId ||
      operation.targetStatus !== input.targetStatus
    ) {
      throw new Error(`Schedule state operation id already used: ${input.operationId}`);
    }
  }

  private async getOperation(operationId: string): Promise<ScheduleStateOperation | null> {
    try {
      const content = await readFile(this.operationFilePath(operationId), "utf-8");
      const operation = ScheduleStateOperationSchema.parse(JSON.parse(content));
      if (operation.operationId !== operationId) {
        throw new Error(`Schedule state operation hash collision: ${operationId}`);
      }
      return operation;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private async writeOperation(operation: ScheduleStateOperation): Promise<void> {
    await mkdir(join(this.dir, "operations"), { recursive: true });
    await writeJsonFileAtomic(this.operationFilePath(operation.operationId), operation);
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
      const persisted = await this.getPersisted(id);
      if (!persisted) {
        return null;
      }
      const current = this.toStoredSchedule(persisted);
      if (!matchesNameAndTarget(current, name, target)) {
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
      await this.writePersisted({
        ...updated,
        _mutationVersion: this.nextMutationVersion(persisted._mutationVersion),
      });
      return updated;
    });
  }
}
