import {
  parseWorkspaceActivityInput,
  type WorkspaceActivity,
  type WorkspaceActivityInput,
} from "@getpaseo/protocol/workspace-activity";

interface ActivityOwner {
  pluginId: string;
  instanceId: string;
}

/** Daemon-owned live state. A client disconnect never ends a plugin's activities. */
export class WorkspaceActivityRegistry {
  private readonly owners = new Map<string, Map<string, WorkspaceActivity>>();
  private readonly archivedWorkspaces = new Set<string>();
  private readonly listeners = new Set<(workspaceIds: readonly string[]) => void>();

  constructor(private readonly now: () => number = Date.now) {}

  list(): WorkspaceActivity[] {
    const result: WorkspaceActivity[] = [];
    for (const activities of this.owners.values()) result.push(...activities.values());
    return result.sort((left, right) => left.id.localeCompare(right.id));
  }

  subscribe(listener: (workspaceIds: readonly string[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  replace(owner: ActivityOwner, contributions: readonly WorkspaceActivityInput[]): void {
    const previous = this.owners.get(owner.instanceId) ?? new Map<string, WorkspaceActivity>();
    const next = new Map<string, WorkspaceActivity>();
    const changedWorkspaces = new Set<string>();
    for (const contribution of contributions) {
      const input = parseWorkspaceActivityInput(contribution);
      if (this.archivedWorkspaces.has(input.workspaceId)) continue;
      if (next.has(input.id)) throw new Error(`Duplicate workspace activity: ${input.id}`);
      const existing = previous.get(input.id);
      const value = {
        ...input,
        id: `${owner.pluginId}/${input.id}`,
        pluginId: owner.pluginId,
        activityId: input.id,
      };
      if (existing && sameActivity(existing, value)) {
        next.set(input.id, existing);
      } else {
        next.set(input.id, { ...value, changedAt: new Date(this.now()).toISOString() });
        changedWorkspaces.add(input.workspaceId);
        if (existing) changedWorkspaces.add(existing.workspaceId);
      }
    }
    for (const [id, activity] of previous) {
      if (!next.has(id)) changedWorkspaces.add(activity.workspaceId);
    }
    if (next.size) this.owners.set(owner.instanceId, next);
    else this.owners.delete(owner.instanceId);
    this.notify(changedWorkspaces);
  }

  removeOwner(instanceId: string): void {
    const activities = this.owners.get(instanceId);
    if (!activities) return;
    this.owners.delete(instanceId);
    this.notify(new Set([...activities.values()].map((activity) => activity.workspaceId)));
  }

  archiveWorkspace(workspaceId: string): void {
    // Late IPC snapshots from the live worker cannot revive an archived workspace's activity.
    this.archivedWorkspaces.add(workspaceId);
    let changed = false;
    for (const [owner, activities] of this.owners) {
      for (const [id, activity] of activities) {
        if (activity.workspaceId === workspaceId) {
          activities.delete(id);
          changed = true;
        }
      }
      if (!activities.size) this.owners.delete(owner);
    }
    if (changed) this.notify(new Set([workspaceId]));
  }

  private notify(workspaceIds: ReadonlySet<string>): void {
    if (!workspaceIds.size) return;
    const ids = [...workspaceIds];
    for (const listener of this.listeners) listener(ids);
  }
}

function sameActivity(
  left: WorkspaceActivity,
  right: Omit<WorkspaceActivity, "changedAt">,
): boolean {
  return (
    left.id === right.id &&
    left.pluginId === right.pluginId &&
    left.activityId === right.activityId &&
    left.workspaceId === right.workspaceId &&
    left.kind === right.kind &&
    left.label === right.label &&
    left.status === right.status &&
    left.icon === right.icon &&
    left.count === right.count &&
    JSON.stringify(left.items) === JSON.stringify(right.items)
  );
}
