import { createHash } from "node:crypto";

import type { Logger } from "pino";

import {
  type FileBackedWorkspaceLifecycleOperationStore,
  WorkspaceLifecycleOperationConflictError,
  type WorkspaceLifecycleOperationRecord,
  type WorkspaceLifecycleOperationState,
} from "./workspace-lifecycle-operation-store.js";

export interface WorkspaceLifecycleAdmissionInput {
  resourceKey: string;
  actor: string;
}

/**
 * Shared admission lease on a lifecycle resource. Mutating consumers (agent
 * registration, terminals) hold a shared admission while they work; removal
 * closes admission and drains the active leases before destructive mutation.
 */
export interface WorkspaceLifecycleAdmission {
  withSharedAdmission<T>(
    input: WorkspaceLifecycleAdmissionInput,
    action: () => Promise<T>,
  ): Promise<T>;
}

export class WorkspaceLifecycleAdmissionClosedError extends Error {
  constructor(
    public readonly resourceKey: string,
    public readonly actor: string,
  ) {
    super(`Workspace lifecycle admission closed for ${resourceKey} (requested by ${actor})`);
    this.name = "WorkspaceLifecycleAdmissionClosedError";
  }
}

export class WorkspaceLifecycleManualCleanupError extends Error {
  constructor(
    public readonly operationId: string,
    public readonly resourceKey: string,
    public readonly reason: string,
    options?: { cause?: unknown },
  ) {
    super(
      `Lifecycle operation ${operationId} on ${resourceKey} requires manual cleanup: ${reason}`,
      options,
    );
    this.name = "WorkspaceLifecycleManualCleanupError";
  }
}

/**
 * Deterministic fingerprint for an idempotent lifecycle request. The same
 * logical request always produces the same fingerprint, so a retried request
 * replays the committed result instead of creating a second resource.
 */
export function fingerprintWorkspaceLifecycleRequest(request: Record<string, unknown>): string {
  const canonical = JSON.stringify(
    Object.keys(request)
      .sort()
      .map((key) => [key, request[key]]),
  );
  return createHash("sha256").update(canonical).digest("hex");
}

export interface RunWorkspaceLifecycleCreateInput<TResult> {
  operationId: string;
  fingerprint: string;
  resourceKey: string;
  create: () => Promise<TResult>;
}

export interface RunWorkspaceLifecycleRemovalInput<TResult> {
  operationId: string;
  fingerprint: string;
  resourceKey: string;
  /**
   * Additional admission gates to close and drain before destructive mutation,
   * e.g. the `workspace:<id>` keys of every workspace record backed by the
   * directory being removed. The operation's own resourceKey is always closed.
   */
  admissionResourceKeys?: readonly string[];
  /**
   * Per-operation destructive opt-in. Absent, the service-level default (off
   * unless explicitly enabled at construction) applies. The only production
   * caller that opts in is the explicit workspace archive flow, after records
   * are archived and quiescence is verified.
   */
  allowDestructiveMutation?: boolean;
  quiesce: () => Promise<void>;
  verify: () => Promise<boolean>;
  mutate: () => Promise<TResult>;
}

interface AdmissionGate {
  closed: boolean;
  /** Settled-safe wrappers of in-flight shared admissions. */
  active: Set<Promise<void>>;
}

/**
 * Owner of workspace lifecycle operations. Every create and removal runs as a
 * durable operation record in the store; replays return the committed result,
 * conflicting requests fail closed, and destructive mutation is reached only
 * after admission is closed, active leases drain, and quiescence is verified.
 */
export class PaseoWorkspaceLifecycleOperationService implements WorkspaceLifecycleAdmission {
  private readonly store: FileBackedWorkspaceLifecycleOperationStore;
  private readonly logger: Logger;
  private readonly allowDestructiveMutation: boolean;
  private readonly gates = new Map<string, AdmissionGate>();

  constructor(options: {
    store: FileBackedWorkspaceLifecycleOperationStore;
    logger: Logger;
    allowDestructiveMutation?: boolean;
  }) {
    this.store = options.store;
    this.logger = options.logger.child({ module: "workspace-lifecycle-operation-service" });
    this.allowDestructiveMutation = options.allowDestructiveMutation ?? false;
  }

  async withSharedAdmission<T>(
    input: WorkspaceLifecycleAdmissionInput,
    action: () => Promise<T>,
  ): Promise<T> {
    const gate = this.gate(input.resourceKey);
    if (gate.closed) {
      throw new WorkspaceLifecycleAdmissionClosedError(input.resourceKey, input.actor);
    }
    // Registration is synchronous relative to the closed check above, so a
    // concurrent close cannot miss this lease.
    const admission = action();
    const tracked = admission.then(
      () => undefined,
      () => undefined,
    );
    gate.active.add(tracked);
    try {
      return await admission;
    } finally {
      gate.active.delete(tracked);
    }
  }

  async runCreate<TResult>(input: RunWorkspaceLifecycleCreateInput<TResult>): Promise<TResult> {
    const reservation = await this.store.reserve({
      operationId: input.operationId,
      kind: "create",
      fingerprint: input.fingerprint,
      resourceKey: input.resourceKey,
    });
    if (reservation.kind === "replay") {
      return this.replayTerminalResult<TResult>(reservation.record);
    }

    let record = await this.transition(reservation.record, "MUTATING");
    let result: TResult;
    try {
      result = await input.create();
    } catch (error) {
      // The create callback compensates inline (rollback of a partially
      // created resource) before rethrowing, so the record terminates here to
      // release the resource for a retry under a new generation.
      const compensating = await this.transition(record, "NEEDS_COMPENSATION", {
        evidence: `create failed: ${describeError(error)}`,
      });
      await this.transition(compensating, "MANUAL_CLEANUP");
      throw error;
    }
    record = await this.transition(record, "RESOURCE_CREATED", { result });
    await this.transition(record, "COMMITTED");
    return result;
  }

  async runRemoval<TResult>(input: RunWorkspaceLifecycleRemovalInput<TResult>): Promise<TResult> {
    const reservation = await this.store.reserve({
      operationId: input.operationId,
      kind: "archive",
      fingerprint: input.fingerprint,
      resourceKey: input.resourceKey,
    });
    if (reservation.kind === "replay") {
      return this.replayTerminalResult<TResult>(reservation.record);
    }

    let record = reservation.record;
    if (!(input.allowDestructiveMutation ?? this.allowDestructiveMutation)) {
      throw await this.failToManualCleanup(record, "automatic destructive mutation is disabled");
    }

    const draining: Promise<void>[] = [];
    for (const key of [input.resourceKey, ...(input.admissionResourceKeys ?? [])]) {
      const gate = this.gate(key);
      gate.closed = true;
      draining.push(...gate.active);
    }
    record = await this.transition(record, "ADMISSION_CLOSED");
    await Promise.all(draining);

    try {
      await input.quiesce();
    } catch (error) {
      throw await this.failToManualCleanup(record, `quiescence failed: ${describeError(error)}`, {
        cause: error,
      });
    }
    record = await this.transition(record, "QUIESCED");

    if (!(await input.verify())) {
      throw await this.failToManualCleanup(record, "removal verification failed");
    }
    record = await this.transition(record, "MUTATING");

    let result: TResult;
    try {
      result = await input.mutate();
    } catch (error) {
      throw await this.failToManualCleanup(record, `mutation failed: ${describeError(error)}`, {
        cause: error,
      });
    }
    record = await this.transition(record, "RESOURCE_REMOVED", { result });
    await this.transition(record, "COMMITTED");
    return result;
  }

  /**
   * Fail-closed startup recovery. Every operation a prior process left
   * nonterminal is claimed and recorded MANUAL_CLEANUP so its resource frees
   * for an explicit retry. No create/mutate callbacks run — recovery never
   * builds replacement resources.
   */
  async recoverInterruptedOperations(): Promise<WorkspaceLifecycleOperationRecord[]> {
    const interrupted = await this.store.listNonterminal();
    const recovered: WorkspaceLifecycleOperationRecord[] = [];
    for (const record of interrupted) {
      recovered.push(
        await this.store.compareAndTransition({
          operationId: record.operationId,
          expectedVersion: record.version,
          expectedState: record.state,
          expectedFence: record.fence,
          nextState: "MANUAL_CLEANUP",
          evidence: `daemon restart found operation nonterminal in state ${record.state}`,
          claimedBy: "startup-recovery",
        }),
      );
      this.logger.warn(
        {
          operationId: record.operationId,
          resourceKey: record.resourceKey,
          priorState: record.state,
        },
        "Workspace lifecycle operation interrupted by restart; recorded MANUAL_CLEANUP",
      );
    }
    return recovered;
  }

  private gate(resourceKey: string): AdmissionGate {
    let gate = this.gates.get(resourceKey);
    if (!gate) {
      gate = { closed: false, active: new Set() };
      this.gates.set(resourceKey, gate);
    }
    return gate;
  }

  private replayTerminalResult<TResult>(record: WorkspaceLifecycleOperationRecord): TResult {
    if (record.state === "COMMITTED") {
      return record.result as TResult;
    }
    if (record.state === "MANUAL_CLEANUP") {
      throw new WorkspaceLifecycleManualCleanupError(
        record.operationId,
        record.resourceKey,
        record.evidence ?? "operation previously recorded for manual cleanup",
      );
    }
    throw new WorkspaceLifecycleOperationConflictError(
      `Lifecycle operation ${record.operationId} is still in flight (state ${record.state})`,
    );
  }

  private async transition(
    record: WorkspaceLifecycleOperationRecord,
    nextState: WorkspaceLifecycleOperationState,
    updates?: { result?: unknown; evidence?: string | null },
  ): Promise<WorkspaceLifecycleOperationRecord> {
    return this.store.compareAndTransition({
      operationId: record.operationId,
      expectedVersion: record.version,
      expectedState: record.state,
      expectedFence: record.fence,
      nextState,
      result: updates?.result,
      evidence: updates?.evidence,
    });
  }

  private async failToManualCleanup(
    record: WorkspaceLifecycleOperationRecord,
    reason: string,
    options?: { cause?: unknown },
  ): Promise<WorkspaceLifecycleManualCleanupError> {
    await this.transition(record, "MANUAL_CLEANUP", { evidence: reason });
    this.logger.error(
      { operationId: record.operationId, resourceKey: record.resourceKey, reason },
      "Workspace lifecycle operation recorded MANUAL_CLEANUP",
    );
    return new WorkspaceLifecycleManualCleanupError(
      record.operationId,
      record.resourceKey,
      reason,
      options,
    );
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The capability surface production callers hold on the lifecycle owner. The
 * daemon constructs one service instance and threads this view through the
 * create, removal, and admission integration points.
 */
export type WorkspaceLifecycleOperationOwner = Pick<
  PaseoWorkspaceLifecycleOperationService,
  "runCreate" | "runRemoval" | "withSharedAdmission"
>;

/**
 * Reads the lifecycle owner off a carrier (the daemon's AgentManager). Only a
 * real owner object counts: carriers are frequently partial doubles whose
 * unknown properties are not the owner, so anything that is not an object
 * resolves to undefined and the caller stays on its non-owner path.
 */
export function resolveWorkspaceLifecycleOperationOwner(carrier: {
  workspaceLifecycleOperations?: WorkspaceLifecycleOperationOwner | null;
}): WorkspaceLifecycleOperationOwner | undefined {
  const candidate = carrier.workspaceLifecycleOperations;
  return candidate !== null && typeof candidate === "object" ? candidate : undefined;
}
