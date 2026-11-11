import { type ArchiveResult, WorkspaceArchiveCanceledError } from "./workspace-archive-service.js";

export type WorkspaceArchiveOutcome =
  | { kind: "archived"; result: ArchiveResult }
  | { kind: "canceled"; archivedAt: string };

export interface WorkspaceArchiveUndoInput {
  archivedAt?: string;
}

type LaneEntry =
  | { kind: "archiving"; controller: AbortController; done: Promise<WorkspaceArchiveOutcome> }
  | { kind: "undoing"; done: Promise<void> };

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
 */
export class WorkspaceArchiveOperations {
  private readonly lanes = new Map<string, LaneEntry>();

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
        return { kind: "archived", result };
      } catch (error) {
        if (!(error instanceof WorkspaceArchiveCanceledError)) throw error;
        return { kind: "canceled", archivedAt: error.archivedAt };
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
      const outcome =
        current?.kind === "archiving" ? await current.done.catch(() => undefined) : undefined;
      await restore({ archivedAt: outcome?.kind === "canceled" ? outcome.archivedAt : undefined });
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
}

async function settled(promise: Promise<unknown> | undefined): Promise<void> {
  if (!promise) return;
  try {
    await promise;
  } catch {
    // The earlier request reports its own failure; this one only waits for the lane.
  }
}
