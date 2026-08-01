import { normalizePathForIdentity } from "../utils/path.js";

export class WorkspaceLifecycleCoordinator {
  private readonly setupTasks = new Map<string, Promise<void>>();
  private readonly setupTasksByDirectory = new Map<string, Set<Promise<void>>>();
  private readonly archiveOperations = new Map<string, Promise<unknown>>();
  private readonly directoryOperations = new Map<string, Promise<unknown>>();
  private readonly worktreeMutationOperations = new Map<string, Promise<unknown>>();
  private readonly ownershipMutationTasks = new Map<string, Set<Promise<void>>>();
  private readonly archivingWorkspaceIds = new Map<string, number>();

  trackWorkspaceSetup(workspaceId: string, task: Promise<void>, directoryPath?: string): void {
    this.setupTasks.set(workspaceId, task);
    const directoryKey = directoryPath ? normalizePathForIdentity(directoryPath) : null;
    const directoryTasks = directoryKey
      ? (this.setupTasksByDirectory.get(directoryKey) ?? new Set<Promise<void>>())
      : null;
    if (directoryKey && directoryTasks) {
      directoryTasks.add(task);
      this.setupTasksByDirectory.set(directoryKey, directoryTasks);
    }
    const clearTask = () => {
      if (this.setupTasks.get(workspaceId) === task) {
        this.setupTasks.delete(workspaceId);
      }
      if (directoryKey && directoryTasks) {
        directoryTasks.delete(task);
        if (directoryTasks.size === 0) {
          this.setupTasksByDirectory.delete(directoryKey);
        }
      }
    };
    void task.then(clearTask, clearTask);
  }

  reserveWorkspaceSetup(workspaceId: string, directoryPath: string): WorkspaceSetupReservation {
    let releaseReservation: (() => void) | null = null;
    const reservationTask = new Promise<void>((resolve) => {
      releaseReservation = resolve;
    });
    this.trackWorkspaceSetup(workspaceId, reservationTask, directoryPath);

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releaseReservation?.();
    };
    return {
      completeWith(task) {
        void task.then(release, release);
      },
      release,
    };
  }

  async waitForWorkspaceSetups(workspaceIds: Iterable<string>): Promise<void> {
    const tasks = Array.from(workspaceIds, (workspaceId) =>
      this.setupTasks.get(workspaceId),
    ).filter((task): task is Promise<void> => task !== undefined);
    await Promise.allSettled(tasks);
  }

  reserveWorkspaceOwnershipMutation(workspaceId: string): WorkspaceOwnershipMutationReservation {
    if ((this.archivingWorkspaceIds.get(workspaceId) ?? 0) > 0) {
      throw new Error(`Workspace ${workspaceId} is being archived`);
    }

    let releaseReservation: (() => void) | null = null;
    const reservationTask = new Promise<void>((resolve) => {
      releaseReservation = resolve;
    });
    const tasks = this.ownershipMutationTasks.get(workspaceId) ?? new Set<Promise<void>>();
    tasks.add(reservationTask);
    this.ownershipMutationTasks.set(workspaceId, tasks);

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releaseReservation?.();
      tasks.delete(reservationTask);
      if (tasks.size === 0) {
        this.ownershipMutationTasks.delete(workspaceId);
      }
    };
    return { release };
  }

  async runWorkspaceOwnershipMutation<T>(
    workspaceId: string,
    requireActiveWorkspace: () => Promise<void>,
    operation: () => Promise<T>,
  ): Promise<T> {
    const reservation = this.reserveWorkspaceOwnershipMutation(workspaceId);
    try {
      // Validate after acquiring the reservation. An archive either already owns
      // the workspace (and reservation fails), or must now wait for this check and
      // mutation to finish. This also rejects attaches after archive completion.
      await requireActiveWorkspace();
      return await operation();
    } finally {
      reservation.release();
    }
  }

  reserveWorkspaceArchive(workspaceIds: Iterable<string>): WorkspaceArchiveReservation {
    const ownedWorkspaceIds = new Set<string>();
    const add = (additionalWorkspaceIds: Iterable<string>) => {
      for (const workspaceId of additionalWorkspaceIds) {
        if (ownedWorkspaceIds.has(workspaceId)) continue;
        this.archivingWorkspaceIds.set(
          workspaceId,
          (this.archivingWorkspaceIds.get(workspaceId) ?? 0) + 1,
        );
        ownedWorkspaceIds.add(workspaceId);
      }
    };
    add(workspaceIds);

    let released = false;
    return {
      add,
      release: () => {
        if (released) return;
        released = true;
        for (const workspaceId of ownedWorkspaceIds) {
          const remainingReservations = (this.archivingWorkspaceIds.get(workspaceId) ?? 1) - 1;
          if (remainingReservations === 0) {
            this.archivingWorkspaceIds.delete(workspaceId);
          } else {
            this.archivingWorkspaceIds.set(workspaceId, remainingReservations);
          }
        }
      },
    };
  }

  async waitForWorkspaceOwnershipMutations(workspaceIds: Iterable<string>): Promise<void> {
    const tasks = Array.from(workspaceIds).flatMap((workspaceId) =>
      Array.from(this.ownershipMutationTasks.get(workspaceId) ?? []),
    );
    await Promise.allSettled(tasks);
  }

  runArchive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const existing = this.archiveOperations.get(key);
    if (existing) {
      return existing as Promise<T>;
    }

    const task = Promise.resolve().then(operation);
    this.archiveOperations.set(key, task);
    const clearTask = () => {
      if (this.archiveOperations.get(key) === task) {
        this.archiveOperations.delete(key);
      }
    };
    void task.then(clearTask, clearTask);
    return task;
  }

  runDirectoryExclusive<T>(directoryPath: string, operation: () => Promise<T>): Promise<T> {
    const directoryKey = normalizePathForIdentity(directoryPath);
    const previous = this.directoryOperations.get(directoryKey) ?? Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(async () => {
        while (true) {
          const setupTasks = Array.from(this.setupTasksByDirectory.get(directoryKey) ?? []);
          if (setupTasks.length === 0) break;
          await Promise.allSettled(setupTasks);
        }
        return operation();
      });
    this.directoryOperations.set(directoryKey, task);
    const clearTask = () => {
      if (this.directoryOperations.get(directoryKey) === task) {
        this.directoryOperations.delete(directoryKey);
      }
    };
    void task.then(clearTask, clearTask);
    return task;
  }

  runWorktreeMutationExclusive<T>(worktreesRoot: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.worktreeMutationOperations.get(worktreesRoot) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(operation);
    this.worktreeMutationOperations.set(worktreesRoot, task);
    const clearTask = () => {
      if (this.worktreeMutationOperations.get(worktreesRoot) === task) {
        this.worktreeMutationOperations.delete(worktreesRoot);
      }
    };
    void task.then(clearTask, clearTask);
    return task;
  }
}

export interface WorkspaceSetupReservation {
  completeWith(task: Promise<void>): void;
  release(): void;
}

export interface WorkspaceOwnershipMutationReservation {
  release(): void;
}

export interface WorkspaceArchiveReservation {
  add(workspaceIds: Iterable<string>): void;
  release(): void;
}

export const defaultWorkspaceLifecycleCoordinator = new WorkspaceLifecycleCoordinator();
