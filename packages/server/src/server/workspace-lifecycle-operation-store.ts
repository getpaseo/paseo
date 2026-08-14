import { promises as fs } from "node:fs";

import type { Logger } from "pino";
import { z } from "zod";

import { writeJsonFileAtomicDurable } from "./atomic-file.js";

export const WORKSPACE_LIFECYCLE_OPERATION_STATES = [
  "PREPARED",
  "ADMISSION_CLOSED",
  "QUIESCED",
  "MUTATING",
  "RESOURCE_CREATED",
  "RESOURCE_REMOVED",
  "COMMITTED",
  "NEEDS_COMPENSATION",
  "MANUAL_CLEANUP",
] as const;

export type WorkspaceLifecycleOperationState =
  (typeof WORKSPACE_LIFECYCLE_OPERATION_STATES)[number];
export type WorkspaceLifecycleOperationKind = "create" | "archive" | "recovery" | "rollback";

const terminalStates = new Set<WorkspaceLifecycleOperationState>([
  "COMMITTED",
  "MANUAL_CLEANUP",
]);

const operationRecordSchema = z
  .object({
    operationId: z.string().min(1),
    kind: z.enum(["create", "archive", "recovery", "rollback"]),
    fingerprint: z.string().min(1),
    resourceKey: z.string().min(1),
    generation: z.number().int().positive(),
    fence: z.number().int().positive(),
    version: z.number().int().positive(),
    state: z.enum(WORKSPACE_LIFECYCLE_OPERATION_STATES),
    result: z.unknown().nullable(),
    evidence: z.string().nullable(),
    claimedBy: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

const journalSchema = z
  .object({
    schemaVersion: z.literal(1),
    operations: z.array(operationRecordSchema),
  })
  .strict();

export type WorkspaceLifecycleOperationRecord = z.infer<typeof operationRecordSchema>;

export class WorkspaceLifecycleOperationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceLifecycleOperationConflictError";
  }
}

export class WorkspaceLifecycleOperationStaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceLifecycleOperationStaleError";
  }
}

export interface ReserveWorkspaceLifecycleOperationInput {
  operationId: string;
  kind: WorkspaceLifecycleOperationKind;
  fingerprint: string;
  resourceKey: string;
}

export type ReserveWorkspaceLifecycleOperationResult =
  | { kind: "created"; record: WorkspaceLifecycleOperationRecord }
  | { kind: "replay"; record: WorkspaceLifecycleOperationRecord };

export interface CompareWorkspaceLifecycleOperationInput {
  operationId: string;
  expectedVersion: number;
  expectedState: WorkspaceLifecycleOperationState;
  expectedFence: number;
  nextState: WorkspaceLifecycleOperationState;
  result?: unknown;
  evidence?: string | null;
  claimedBy?: string | null;
}

const allowedTransitions: Readonly<
  Record<WorkspaceLifecycleOperationState, ReadonlySet<WorkspaceLifecycleOperationState>>
> = {
  PREPARED: new Set(["ADMISSION_CLOSED", "MUTATING", "NEEDS_COMPENSATION", "MANUAL_CLEANUP"]),
  ADMISSION_CLOSED: new Set(["QUIESCED", "MANUAL_CLEANUP"]),
  QUIESCED: new Set(["MUTATING", "MANUAL_CLEANUP"]),
  MUTATING: new Set([
    "RESOURCE_CREATED",
    "RESOURCE_REMOVED",
    "NEEDS_COMPENSATION",
    "MANUAL_CLEANUP",
  ]),
  RESOURCE_CREATED: new Set(["COMMITTED", "NEEDS_COMPENSATION", "MANUAL_CLEANUP"]),
  RESOURCE_REMOVED: new Set(["COMMITTED", "MANUAL_CLEANUP"]),
  NEEDS_COMPENSATION: new Set(["MANUAL_CLEANUP"]),
  COMMITTED: new Set(),
  MANUAL_CLEANUP: new Set(),
};

export class FileBackedWorkspaceLifecycleOperationStore {
  private readonly filePath: string;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private loaded = false;
  private operations = new Map<string, WorkspaceLifecycleOperationRecord>();
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: { filePath: string; logger: Logger; now?: () => Date }) {
    this.filePath = options.filePath;
    this.logger = options.logger.child({ module: "workspace-lifecycle-operation-store" });
    this.now = options.now ?? (() => new Date());
  }

  async initialize(): Promise<void> {
    await this.serializeMutation(async () => this.load());
  }

  async get(operationId: string): Promise<WorkspaceLifecycleOperationRecord | null> {
    await this.initializeIfNeeded();
    return this.operations.get(operationId) ?? null;
  }

  async listNonterminal(): Promise<WorkspaceLifecycleOperationRecord[]> {
    await this.initializeIfNeeded();
    return Array.from(this.operations.values()).filter((record) => !terminalStates.has(record.state));
  }

  async findCurrentByResource(
    resourceKey: string,
  ): Promise<WorkspaceLifecycleOperationRecord | null> {
    await this.initializeIfNeeded();
    const matches = Array.from(this.operations.values()).filter(
      (record) => record.resourceKey === resourceKey,
    );
    matches.sort((left, right) => right.generation - left.generation);
    return matches[0] ?? null;
  }

  async reserve(
    input: ReserveWorkspaceLifecycleOperationInput,
  ): Promise<ReserveWorkspaceLifecycleOperationResult> {
    return this.serializeMutation(async () => {
      await this.load();
      const existing = this.operations.get(input.operationId);
      if (existing) {
        if (
          existing.kind !== input.kind ||
          existing.fingerprint !== input.fingerprint ||
          existing.resourceKey !== input.resourceKey
        ) {
          throw new WorkspaceLifecycleOperationConflictError(
            `Lifecycle operation ${input.operationId} conflicts with its durable fingerprint`,
          );
        }
        return { kind: "replay", record: existing };
      }

      const resourceRecords = Array.from(this.operations.values()).filter(
        (record) => record.resourceKey === input.resourceKey,
      );
      const activeOwner = resourceRecords.find((record) => !terminalStates.has(record.state));
      if (activeOwner) {
        throw new WorkspaceLifecycleOperationConflictError(
          `Resource ${input.resourceKey} is owned by nonterminal operation ${activeOwner.operationId}`,
        );
      }
      const generation =
        resourceRecords.reduce((maximum, record) => Math.max(maximum, record.generation), 0) + 1;
      const timestamp = this.now().toISOString();
      const record: WorkspaceLifecycleOperationRecord = {
        operationId: input.operationId,
        kind: input.kind,
        fingerprint: input.fingerprint,
        resourceKey: input.resourceKey,
        generation,
        fence: generation,
        version: 1,
        state: "PREPARED",
        result: null,
        evidence: null,
        claimedBy: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const next = new Map(this.operations);
      next.set(record.operationId, record);
      await this.persist(next);
      this.operations = next;
      return { kind: "created", record };
    });
  }

  async compareAndTransition(
    input: CompareWorkspaceLifecycleOperationInput,
  ): Promise<WorkspaceLifecycleOperationRecord> {
    return this.serializeMutation(async () => {
      await this.load();
      const current = this.operations.get(input.operationId);
      if (!current) {
        throw new WorkspaceLifecycleOperationStaleError(
          `Lifecycle operation ${input.operationId} is missing`,
        );
      }
      if (
        current.version !== input.expectedVersion ||
        current.state !== input.expectedState ||
        current.fence !== input.expectedFence
      ) {
        throw new WorkspaceLifecycleOperationStaleError(
          `Lifecycle operation ${input.operationId} has a stale version, state, or fence`,
        );
      }
      if (!allowedTransitions[current.state].has(input.nextState)) {
        throw new WorkspaceLifecycleOperationConflictError(
          `Invalid lifecycle transition ${current.state} -> ${input.nextState}`,
        );
      }
      const nextRecord = operationRecordSchema.parse({
        ...current,
        version: current.version + 1,
        state: input.nextState,
        result: input.result === undefined ? current.result : input.result,
        evidence: input.evidence === undefined ? current.evidence : input.evidence,
        claimedBy: input.claimedBy === undefined ? current.claimedBy : input.claimedBy,
        updatedAt: this.now().toISOString(),
      });
      const next = new Map(this.operations);
      next.set(nextRecord.operationId, nextRecord);
      await this.persist(next);
      this.operations = next;
      return nextRecord;
    });
  }

  private async initializeIfNeeded(): Promise<void> {
    if (!this.loaded) {
      await this.initialize();
    }
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const journal = journalSchema.parse(JSON.parse(raw));
      this.operations = new Map(journal.operations.map((record) => [record.operationId, record]));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.error({ err: error, filePath: this.filePath }, "Failed to load lifecycle journal");
        throw error;
      }
      this.operations = new Map();
    }
    this.loaded = true;
  }

  private async persist(
    operations: ReadonlyMap<string, WorkspaceLifecycleOperationRecord>,
  ): Promise<void> {
    await writeJsonFileAtomicDurable(this.filePath, {
      schemaVersion: 1,
      operations: Array.from(operations.values()).sort((left, right) =>
        left.operationId.localeCompare(right.operationId),
      ),
    });
  }

  private serializeMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(mutation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
