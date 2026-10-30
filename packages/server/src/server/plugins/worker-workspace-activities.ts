import {
  parseWorkspaceActivityInput,
  type WorkspaceActivityInput,
} from "@getpaseo/protocol/workspace-activity";
import type { PluginWorkspaceActivityRegistration } from "@getpaseo/plugin/server";

/** Local registration handles; snapshots cross IPC only after initialization succeeds. */
export class WorkerWorkspaceActivities {
  private readonly activities = new Map<string, WorkspaceActivityInput>();
  private closed = false;
  private readonly changed: (activities: WorkspaceActivityInput[]) => void;

  constructor(changed: (activities: WorkspaceActivityInput[]) => void) {
    this.changed = changed;
  }

  snapshot(): WorkspaceActivityInput[] {
    const snapshot: WorkspaceActivityInput[] = [];
    for (const activity of this.activities.values()) {
      snapshot.push({
        ...activity,
        ...(activity.items
          ? { items: activity.items.map((item) => ({ id: item.id, label: item.label })) }
          : {}),
      });
    }
    return snapshot;
  }

  add(input: WorkspaceActivityInput): PluginWorkspaceActivityRegistration {
    if (this.closed) throw new Error("Plugin workspace activities are closed");
    let activity = parseWorkspaceActivityInput(input);
    if (this.activities.has(activity.id))
      throw new Error(`Duplicate workspace activity: ${activity.id}`);
    if (this.activities.size >= 512) throw new Error("Too many plugin workspace activities");
    this.activities.set(activity.id, activity);
    this.changed(this.snapshot());
    let removed = false;
    return {
      update: (patch) => {
        if (removed || this.closed) throw new Error("Workspace activity is no longer registered");
        const next = parseWorkspaceActivityInput({
          ...activity,
          ...patch,
          ...(patch.items !== undefined && patch.count === undefined ? { count: undefined } : {}),
          id: activity.id,
          workspaceId: activity.workspaceId,
        });
        if (JSON.stringify(activity) === JSON.stringify(next)) return;
        activity = next;
        this.activities.set(activity.id, activity);
        this.changed(this.snapshot());
      },
      remove: () => {
        if (removed || this.closed) return;
        removed = true;
        this.activities.delete(activity.id);
        this.changed(this.snapshot());
      },
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.activities.clear();
    this.changed([]);
  }
}
