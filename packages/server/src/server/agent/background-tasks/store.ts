export type BackgroundTaskStatus = "running" | "completed" | "failed" | "stopped" | "unknown";

export interface BackgroundTaskDescriptor {
  taskId: string;
  parentAgentId: string;
  type: string;
  description: string;
  command: string | null;
  status: BackgroundTaskStatus;
  outputFile: string | null;
  lastSummary: string | null;
  updatedAt: string;
}

export interface BackgroundTaskLiveMember {
  taskId: string;
  type: string;
  description: string;
}

export type BackgroundTaskEnrichPatch = Partial<{
  type: string;
  description: string;
  command: string | null;
  status: BackgroundTaskStatus;
  outputFile: string | null;
  lastSummary: string | null;
  updatedAt: string;
}>;

export function isShellTaskType(type: string): boolean {
  const normalized = type.trim().toLowerCase();
  return normalized === "shell" || normalized === "bash" || normalized === "local_bash";
}

function taskKey(parentAgentId: string, taskId: string): string {
  return `${parentAgentId}\0${taskId}`;
}

function parentPrefix(parentAgentId: string): string {
  return `${parentAgentId}\0`;
}

export class BackgroundTaskStore {
  private readonly descriptors = new Map<string, BackgroundTaskDescriptor>();

  replaceLiveSet(
    parentAgentId: string,
    tasks: readonly BackgroundTaskLiveMember[],
    nowIso: string,
  ): BackgroundTaskDescriptor[] {
    const prefix = parentPrefix(parentAgentId);
    const previousByTaskId = new Map<string, BackgroundTaskDescriptor>();
    for (const [key, descriptor] of this.descriptors) {
      if (!key.startsWith(prefix)) continue;
      previousByTaskId.set(descriptor.taskId, descriptor);
      this.descriptors.delete(key);
    }

    for (const task of tasks) {
      if (!isShellTaskType(task.type)) continue;
      const previous = previousByTaskId.get(task.taskId);
      const next: BackgroundTaskDescriptor = {
        taskId: task.taskId,
        parentAgentId,
        type: task.type,
        description: task.description,
        command: previous?.command ?? null,
        status: "running",
        outputFile: previous?.outputFile ?? null,
        lastSummary: previous?.lastSummary ?? null,
        updatedAt: nowIso,
      };
      this.descriptors.set(taskKey(parentAgentId, task.taskId), next);
    }

    return this.list(parentAgentId);
  }

  enrich(
    parentAgentId: string,
    taskId: string,
    patch: BackgroundTaskEnrichPatch,
  ): BackgroundTaskDescriptor | null {
    const key = taskKey(parentAgentId, taskId);
    const current = this.descriptors.get(key);
    if (!current) return null;

    const next: BackgroundTaskDescriptor = {
      ...current,
      ...(patch.type !== undefined ? { type: patch.type } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.command !== undefined ? { command: patch.command } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.outputFile !== undefined ? { outputFile: patch.outputFile } : {}),
      ...(patch.lastSummary !== undefined ? { lastSummary: patch.lastSummary } : {}),
      updatedAt: patch.updatedAt ?? current.updatedAt,
    };
    this.descriptors.set(key, next);
    return next;
  }

  list(parentAgentId: string): BackgroundTaskDescriptor[] {
    const prefix = parentPrefix(parentAgentId);
    const rows: BackgroundTaskDescriptor[] = [];
    for (const [key, descriptor] of this.descriptors) {
      if (!key.startsWith(prefix)) continue;
      rows.push(descriptor);
    }
    rows.sort((left, right) => left.taskId.localeCompare(right.taskId));
    return rows;
  }

  get(parentAgentId: string, taskId: string): BackgroundTaskDescriptor | null {
    return this.descriptors.get(taskKey(parentAgentId, taskId)) ?? null;
  }

  deleteParent(parentAgentId: string): void {
    const prefix = parentPrefix(parentAgentId);
    const keysToDelete: string[] = [];
    for (const key of this.descriptors.keys()) {
      if (key.startsWith(prefix)) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      this.descriptors.delete(key);
    }
  }
}
