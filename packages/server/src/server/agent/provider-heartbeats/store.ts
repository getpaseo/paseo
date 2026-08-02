import type { AgentProvider } from "../agent-sdk-types.js";

export type ProviderHeartbeatMode = "recurring" | "one_shot" | "dynamic";

export interface ProviderHeartbeatDescriptor {
  taskId: string;
  parentAgentId: string;
  provider: AgentProvider;
  prompt: string;
  mode: ProviderHeartbeatMode;
  scheduleLabel: string;
  nextHint: string | null;
  updatedAt: string;
}

function taskKey(parentAgentId: string, taskId: string): string {
  return `${parentAgentId}\0${taskId}`;
}

function parentPrefix(parentAgentId: string): string {
  return `${parentAgentId}\0`;
}

export class ProviderHeartbeatStore {
  private readonly descriptors = new Map<string, ProviderHeartbeatDescriptor>();

  replaceLiveSet(
    parentAgentId: string,
    tasks: readonly ProviderHeartbeatDescriptor[],
  ): ProviderHeartbeatDescriptor[] {
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

    for (const task of tasks) {
      this.descriptors.set(taskKey(parentAgentId, task.taskId), {
        ...task,
        parentAgentId,
      });
    }

    return this.list(parentAgentId);
  }

  upsert(parentAgentId: string, task: ProviderHeartbeatDescriptor): void {
    this.descriptors.set(taskKey(parentAgentId, task.taskId), {
      ...task,
      parentAgentId,
    });
  }

  remove(parentAgentId: string, taskId: string): boolean {
    return this.descriptors.delete(taskKey(parentAgentId, taskId));
  }

  list(parentAgentId: string): ProviderHeartbeatDescriptor[] {
    const prefix = parentPrefix(parentAgentId);
    const rows: ProviderHeartbeatDescriptor[] = [];
    for (const [key, descriptor] of this.descriptors) {
      if (!key.startsWith(prefix)) continue;
      rows.push(descriptor);
    }
    rows.sort((left, right) => left.taskId.localeCompare(right.taskId));
    return rows;
  }

  get(parentAgentId: string, taskId: string): ProviderHeartbeatDescriptor | null {
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
