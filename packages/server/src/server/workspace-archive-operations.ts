import { type ArchiveResult, WorkspaceArchiveCanceledError } from "./workspace-archive-service.js";

export type WorkspaceArchiveOutcome =
  | { kind: "archived"; result: ArchiveResult }
  | { kind: "canceled" };

export interface WorkspaceArchiveUndoInput {
  /** Agents the undone archive took down. Empty when the daemon no longer remembers it. */
  agentIds: string[];
}

type LaneEntry =
  | { kind: "archiving"; controller: AbortController; done: Promise<WorkspaceArchiveOutcome> }
  | { kind: "undoing"; done: Promise<void> };

interface UndoableArchive {
  agentIds: string[];
  expiresAt: number;
}

const DEFAULT_UNDO_RETENTION_MS = 10 * 60_000;

/**
 * One lane per workspace for archive and its undo, shared by every session on the daemon.
 *
 * - An archive while one runs joins it.
 * - An undo while an archive runs aborts it, waits for it to stop, then restores.
 * - An archive while an undo runs waits for the undo, then archives.
 * - An undo while an undo runs joins it.
 *
 * Each call claims the lane synchronously, so whichever request arrives last decides the
 * workspace's final state no matter how the earlier work interleaves.
 *
 * The agents an archive took down are kept in memory for the undo window. An archive that took
 * nothing down, such as a repeat archive from a stale client, leaves them alone. After a daemon
 * restart, undo still restores the workspace but its agents stay archived.
 */
export class WorkspaceArchiveOperations {
  private readonly lanes = new Map<string, LaneEntry>();
  private readonly undoable = new Map<string, UndoableArchive>();
  private readonly undoRetentionMs: number;
  private readonly now: () => number;

  constructor(options: { undoRetentionMs?: number; now?: () => number } = {}) {
    this.undoRetentionMs = options.undoRetentionMs ?? DEFAULT_UNDO_RETENTION_MS;
    this.now = options.now ?? Date.now;
  }

  archive(
    workspaceId: string,
    run: (signal: AbortSignal) => Promise<ArchiveResult>,
  ): Promise<WorkspaceArchiveOutcome> {
    const current = this.lanes.get(workspaceId);
    if (current?.kind === "archiving") {
      return current.done;
    }
    const controller = new AbortController();
    const done = (async (): Promise<WorkspaceArchiveOutcome> => {
      await settled(current?.done);
      try {
        const result = await run(controller.signal);
        if (result.archivedWorkspaceIds.length > 0 || result.newlyArchivedAgentIds.length > 0) {
          this.retainUndoable(workspaceId, result.newlyArchivedAgentIds);
        }
        return { kind: "archived", result };
      } catch (error) {
        if (!(error instanceof WorkspaceArchiveCanceledError)) throw error;
        if (error.recordArchived || error.newlyArchivedAgentIds.length > 0) {
          this.retainUndoable(workspaceId, error.newlyArchivedAgentIds);
        }
        return { kind: "canceled" };
      }
    })();
    this.claim(workspaceId, { kind: "archiving", controller, done });
    return done;
  }

  undo(
    workspaceId: string,
    restore: (input: WorkspaceArchiveUndoInput) => Promise<void>,
  ): Promise<void> {
    const current = this.lanes.get(workspaceId);
    if (current?.kind === "undoing") {
      return current.done;
    }
    current?.controller.abort();
    const done = (async () => {
      await settled(current?.done);
      const agentIds = this.takeUndoable(workspaceId);
      try {
        await restore({ agentIds });
      } catch (error) {
        // Keep the agents for a retry; the archive they came from is still the latest one.
        this.retainUndoable(workspaceId, agentIds);
        throw error;
      }
    })();
    this.claim(workspaceId, { kind: "undoing", done });
    return done;
  }

  private claim(workspaceId: string, entry: LaneEntry): void {
    this.lanes.set(workspaceId, entry);
    const release = () => {
      if (this.lanes.get(workspaceId) === entry) this.lanes.delete(workspaceId);
    };
    void (entry.done as Promise<unknown>).then(release, release);
  }

  private retainUndoable(workspaceId: string, agentIds: string[]): void {
    const now = this.now();
    for (const [id, entry] of this.undoable) {
      if (entry.expiresAt <= now) this.undoable.delete(id);
    }
    this.undoable.set(workspaceId, { agentIds, expiresAt: now + this.undoRetentionMs });
  }

  private takeUndoable(workspaceId: string): string[] {
    const entry = this.undoable.get(workspaceId);
    this.undoable.delete(workspaceId);
    if (!entry || entry.expiresAt <= this.now()) return [];
    return entry.agentIds;
  }
}

async function settled(promise: Promise<unknown> | undefined): Promise<void> {
  if (!promise) return;
  try {
    await promise;
  } catch {
    // The earlier request reports its own failure; this one only waits for the lane.
  }
}
