export class WorkspaceLifecycleCoordinator {
  private readonly setupTasks = new Map<string, Promise<void>>();
  private readonly archiveOperations = new Map<string, Promise<unknown>>();

  trackWorkspaceSetup(workspaceId: string, task: Promise<void>): void {
    this.setupTasks.set(workspaceId, task);
    const clearTask = () => {
      if (this.setupTasks.get(workspaceId) === task) {
        this.setupTasks.delete(workspaceId);
      }
    };
    void task.then(clearTask, clearTask);
  }

  async waitForWorkspaceSetups(workspaceIds: Iterable<string>): Promise<void> {
    const tasks = Array.from(workspaceIds, (workspaceId) =>
      this.setupTasks.get(workspaceId),
    ).filter((task): task is Promise<void> => task !== undefined);
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
}

export const defaultWorkspaceLifecycleCoordinator = new WorkspaceLifecycleCoordinator();
