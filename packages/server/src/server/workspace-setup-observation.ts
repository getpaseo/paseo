import type { PersistedWorkspaceRecord } from "./workspace-registry.js";
import type { WorkspaceSetupSnapshot } from "@getpaseo/protocol/messages";

type Listener = (
  workspaceId: string,
  snapshot: WorkspaceSetupSnapshot,
  statusChanged: boolean,
) => void;

/** Daemon-owned setup snapshots, shared by sessions; output never invalidates the directory. */
export class WorkspaceSetupObservation {
  private readonly listeners = new Set<Listener>();
  private readonly statuses = new Map<string, WorkspaceSetupSnapshot["status"] | null>();

  private readonly snapshots = new Map<string, WorkspaceSetupSnapshot>();

  get(workspaceId: string): WorkspaceSetupSnapshot | undefined {
    return this.snapshots.get(workspaceId);
  }

  cache(workspaceId: string, snapshot: WorkspaceSetupSnapshot): void {
    this.snapshots.set(workspaceId, snapshot);
  }

  publish(workspaceId: string, snapshot: WorkspaceSetupSnapshot): void {
    const status = this.summary(snapshot);
    const statusChanged = (this.statuses.get(workspaceId) ?? null) !== status;
    this.statuses.set(workspaceId, status);
    this.snapshots.set(workspaceId, snapshot);
    for (const listener of this.listeners) listener(workspaceId, snapshot, statusChanged);
  }

  status(
    workspace: Pick<PersistedWorkspaceRecord, "workspaceId" | "untrustedSource">,
  ): WorkspaceSetupSnapshot["status"] | null {
    const snapshot = this.snapshots.get(workspace.workspaceId);
    if (snapshot) return this.summary(snapshot);
    return workspace.untrustedSource ? "blocked" : null;
  }

  private summary(snapshot: WorkspaceSetupSnapshot): WorkspaceSetupSnapshot["status"] | null {
    if (
      snapshot.status === "failed" ||
      snapshot.status === "blocked" ||
      snapshot.error !== null ||
      snapshot.detail.commands.length > 0
    )
      return snapshot.status;
    return null;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
