import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

const DEFAULT_MAX_PENDING_PER_WORKSPACE = 32;

export interface LifecycleMutationIdentity {
  workspaceId: string;
  agentId?: string;
  incarnation?: string;
  revision?: number;
}

export interface LifecycleMutationValidation {
  expected: LifecycleMutationIdentity;
  readCurrent: () => LifecycleMutationIdentity | null | Promise<LifecycleMutationIdentity | null>;
}

export interface LifecycleMutationRequest {
  workspaceIds: Iterable<string>;
  timeoutMs?: number;
  validation?: LifecycleMutationValidation;
}

export interface LifecycleMutationCoordinatorOptions {
  maxPendingPerWorkspace?: number;
  now?: () => number;
}

interface WorkspaceLane {
  admitted: number;
  tail: Promise<void>;
}

interface MutationContext {
  active: boolean;
  ownedTasks: Set<Promise<void>>;
  workspaceIds: ReadonlySet<string>;
}

interface Admission {
  predecessors: Promise<void>;
  release: () => void;
}

export class LifecycleMutationBusyError extends Error {
  constructor(readonly workspaceId: string) {
    super(`Workspace lifecycle mutation queue is full: ${workspaceId}`);
    this.name = "LifecycleMutationBusyError";
  }
}

export class LifecycleMutationDeadlineError extends Error {
  constructor(readonly workspaceIds: readonly string[]) {
    super(`Workspace lifecycle mutation expired before starting: ${workspaceIds.join(", ")}`);
    this.name = "LifecycleMutationDeadlineError";
  }
}

export class LifecycleMutationShuttingDownError extends Error {
  constructor() {
    super("Workspace lifecycle mutation admission is closed");
    this.name = "LifecycleMutationShuttingDownError";
  }
}

export class LifecycleMutationStaleError extends Error {
  constructor(
    readonly expected: LifecycleMutationIdentity,
    readonly actual: LifecycleMutationIdentity | null,
  ) {
    super(`Workspace lifecycle mutation is stale: ${expected.workspaceId}`);
    this.name = "LifecycleMutationStaleError";
  }
}

export class LifecycleMutationReentrancyError extends Error {
  constructor() {
    super("A lifecycle mutation cannot acquire additional workspaces from inside a lane");
    this.name = "LifecycleMutationReentrancyError";
  }
}

export class LifecycleMutationCoordinator {
  private readonly lanes = new Map<string, WorkspaceLane>();
  private readonly activeTasks = new Set<Promise<void>>();
  private readonly context = new AsyncLocalStorage<MutationContext>();
  private readonly maxPendingPerWorkspace: number;
  private readonly now: () => number;
  private accepting = true;

  constructor(options: LifecycleMutationCoordinatorOptions = {}) {
    this.maxPendingPerWorkspace =
      options.maxPendingPerWorkspace ?? DEFAULT_MAX_PENDING_PER_WORKSPACE;
    if (!Number.isInteger(this.maxPendingPerWorkspace) || this.maxPendingPerWorkspace < 0) {
      throw new Error("maxPendingPerWorkspace must be a non-negative integer");
    }
    this.now = options.now ?? (() => performance.now());
  }

  run<T>(request: LifecycleMutationRequest, operation: () => T | Promise<T>): Promise<T> {
    const workspaceIds = Array.from(new Set(request.workspaceIds)).sort();
    if (workspaceIds.length === 0) {
      return Promise.reject(new Error("A lifecycle mutation requires at least one workspace"));
    }

    const currentContext = this.context.getStore();
    if (currentContext?.active) {
      if (!workspaceIds.every((workspaceId) => currentContext.workspaceIds.has(workspaceId))) {
        return Promise.reject(new LifecycleMutationReentrancyError());
      }
      const result = this.runOperation(request.validation, operation);
      const tracked = result.then(
        () => undefined,
        () => undefined,
      );
      currentContext.ownedTasks.add(tracked);
      void tracked.finally(() => currentContext.ownedTasks.delete(tracked));
      return result;
    }

    if (!this.accepting) {
      return Promise.reject(new LifecycleMutationShuttingDownError());
    }

    const timeoutMs = request.timeoutMs;
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
      return Promise.reject(new Error("timeoutMs must be a non-negative finite number"));
    }
    const deadline = timeoutMs === undefined ? null : this.now() + timeoutMs;

    let admission: Admission;
    try {
      admission = this.admit(workspaceIds);
    } catch (error) {
      return Promise.reject(error);
    }

    const result = this.execute({
      admission,
      deadline,
      operation,
      validation: request.validation,
      workspaceIds,
    });
    const tracked = result.then(
      () => undefined,
      () => undefined,
    );
    this.activeTasks.add(tracked);
    void tracked.finally(() => this.activeTasks.delete(tracked));
    return result;
  }

  closeAdmission(): void {
    this.accepting = false;
  }

  async drain(): Promise<void> {
    while (this.activeTasks.size > 0) {
      await Promise.all(this.activeTasks);
    }
  }

  private admit(workspaceIds: readonly string[]): Admission {
    for (const workspaceId of workspaceIds) {
      const lane = this.lanes.get(workspaceId);
      const pending = lane ? Math.max(0, lane.admitted - 1) : 0;
      if (pending >= this.maxPendingPerWorkspace && lane?.admitted) {
        throw new LifecycleMutationBusyError(workspaceId);
      }
    }

    const lanes = workspaceIds.map((workspaceId) => {
      const existing = this.lanes.get(workspaceId);
      if (existing) {
        return { workspaceId, lane: existing };
      }
      const lane = { admitted: 0, tail: Promise.resolve() };
      this.lanes.set(workspaceId, lane);
      return { workspaceId, lane };
    });
    const predecessors = Promise.all(lanes.map(({ lane }) => lane.tail)).then(() => undefined);
    let releaseTurn = () => {};
    const turn = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const tail = predecessors.then(() => turn);
    for (const { lane } of lanes) {
      lane.admitted += 1;
      lane.tail = tail;
    }

    let released = false;
    return {
      predecessors,
      release: () => {
        if (released) return;
        released = true;
        releaseTurn();
        for (const { workspaceId, lane } of lanes) {
          lane.admitted -= 1;
          if (lane.admitted === 0 && lane.tail === tail) {
            this.lanes.delete(workspaceId);
          }
        }
      },
    };
  }

  private async execute<T>(input: {
    admission: Admission;
    deadline: number | null;
    operation: () => T | Promise<T>;
    validation?: LifecycleMutationValidation;
    workspaceIds: readonly string[];
  }): Promise<T> {
    try {
      await input.admission.predecessors;
      if (input.deadline !== null && this.now() >= input.deadline) {
        throw new LifecycleMutationDeadlineError(input.workspaceIds);
      }
      const context: MutationContext = {
        active: true,
        ownedTasks: new Set(),
        workspaceIds: new Set(input.workspaceIds),
      };
      return await this.context.run(context, async () => {
        try {
          return await this.runOperation(input.validation, input.operation);
        } finally {
          while (context.ownedTasks.size > 0) {
            await Promise.all(context.ownedTasks);
          }
          context.active = false;
        }
      });
    } finally {
      input.admission.release();
    }
  }

  private async runOperation<T>(
    validation: LifecycleMutationValidation | undefined,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    if (validation) {
      const actual = await validation.readCurrent();
      if (!sameIdentity(validation.expected, actual)) {
        throw new LifecycleMutationStaleError(validation.expected, actual);
      }
    }
    return await operation();
  }
}

function sameIdentity(
  expected: LifecycleMutationIdentity,
  actual: LifecycleMutationIdentity | null,
): boolean {
  return (
    actual !== null &&
    actual.workspaceId === expected.workspaceId &&
    actual.agentId === expected.agentId &&
    actual.incarnation === expected.incarnation &&
    actual.revision === expected.revision
  );
}
