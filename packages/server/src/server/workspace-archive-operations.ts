import { resolve } from "node:path";

import { normalizePathForIdentity } from "../utils/path.js";
import { type ArchiveResult, WorkspaceArchiveCanceledError } from "./workspace-archive-service.js";

export type WorkspaceArchiveOutcome =
  | { kind: "archived"; result: ArchiveResult }
  | { kind: "canceled"; archivedAt: string };

export interface WorkspaceArchiveUndoInput {
  archivedAt?: string;
}

interface PendingArchive {
  controller: AbortController;
  done: Promise<WorkspaceArchiveOutcome>;
}

type LaneEntry =
  | { kind: "archiving"; controller: AbortController; done: Promise<WorkspaceArchiveOutcome> }
  | {
      kind: "restoring";
      pendingArchive: PendingArchive | null;
      supersededBy: Promise<void> | null;
      done: Promise<void>;
    }
  | { kind: "undoing"; done: Promise<void> };

/**
 * Daemon-wide coordinator for workspace archive, undo, and restore operations.
 *
 * Per-workspace lanes:
 * - An archive while one runs joins it.
 * - An undo while an archive runs (including when a restore queued behind it) aborts the archive,
 *   waits for it to stop, then restores.
 * - A restore while an archive runs waits for the archive without aborting it, then restores.
 * - An archive while an undo or restore runs waits for it, then archives.
 * - A duplicate undo or restore while recovery runs joins it.
 *
 * Per-checkout gates:
 * - Any archive or recovery mutating the same backing checkout directory (including CLI worktree
 *   archives covering multiple workspace records, background auto-archives, and sibling workspaces
 *   sharing one checkout) serializes through `withCheckout` so a restore cannot inspect or unarchive
 *   a checkout while an archive is still deleting it.
 * - Lock order is strictly workspace lane -> checkout gate, preventing deadlocks.
 */
export class WorkspaceArchiveOperations {
  private readonly lanes = new Map<string, LaneEntry>();
  private readonly checkoutGates = new Map<string, Promise<void>>();

  // Project removal can overlap a checkout-scoped archive of the same workspace.
  private readonly archiving = new Map<string, { startedAt: string; count: number }>();

  getArchivingAt(workspaceId: string): string | null {
    return this.archiving.get(workspaceId)?.startedAt ?? null;
  }

  markArchiving(workspaceIds: Iterable<string>, startedAt: string): void {
    for (const id of workspaceIds) {
      const current = this.archiving.get(id);
      if (current) current.count += 1;
      else this.archiving.set(id, { startedAt, count: 1 });
    }
  }

  clearArchiving(workspaceIds: Iterable<string>): void {
    for (const id of workspaceIds) {
      const current = this.archiving.get(id);
      if (!current) continue;
      current.count -= 1;
      if (current.count === 0) this.archiving.delete(id);
    }
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
    if (current?.kind === "restoring" && current.pendingArchive === null) {
      return current.done;
    }
    let pendingArchive: PendingArchive | null = null;
    if (current?.kind === "archiving") {
      pendingArchive = { controller: current.controller, done: current.done };
    } else if (current?.kind === "restoring") {
      pendingArchive = current.pendingArchive;
    }
    pendingArchive?.controller.abort();
    const done = (async () => {
      const outcome = pendingArchive ? await pendingArchive.done.catch(() => undefined) : undefined;
      await restore({ archivedAt: outcome?.kind === "canceled" ? outcome.archivedAt : undefined });
    })();
    if (current?.kind === "restoring") {
      current.supersededBy = done;
    }
    this.claim(workspaceId, { kind: "undoing", done });
    return done;
  }

  /**
   * Run a workspace recovery restore on the per-workspace lane so concurrent restores
   * across daemon sessions share one outcome and wait for checkout + validation to settle.
   * When queued behind an in-flight archive, the archive stays cancelable by a subsequent undo.
   */
  restore(workspaceId: string, run: () => Promise<void>): Promise<void> {
    const current = this.lanes.get(workspaceId);
    if (current?.kind === "undoing" || current?.kind === "restoring") {
      return current.done;
    }
    const pendingArchive: PendingArchive | null =
      current?.kind === "archiving" ? { controller: current.controller, done: current.done } : null;
    const entry: Extract<LaneEntry, { kind: "restoring" }> = {
      kind: "restoring",
      pendingArchive,
      supersededBy: null,
      done: Promise.resolve(),
    };
    entry.done = (async () => {
      if (pendingArchive) {
        await settled(pendingArchive.done);
        entry.pendingArchive = null;
        if (entry.supersededBy) {
          await entry.supersededBy;
          return;
        }
      } else {
        await settled(current?.done);
      }
      await run();
    })();
    this.claim(workspaceId, entry);
    return entry.done;
  }

  /**
   * Serialize mutations touching the same backing checkout directory across all daemon callers
   * (UI archive, CLI worktree archive, background auto-archive, undo, and recovery restore).
   */
  withCheckout<T>(checkoutPath: string, run: () => Promise<T>): Promise<T> {
    const key = normalizePathForIdentity(resolve(checkoutPath));
    const previous = this.checkoutGates.get(key);
    let release!: () => void;
    const current = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const gate = previous ? previous.then(() => current) : current;
    this.checkoutGates.set(key, gate);
    const cleanup = () => {
      if (this.checkoutGates.get(key) === gate) {
        this.checkoutGates.delete(key);
      }
    };
    void gate.then(cleanup, cleanup);

    return (async () => {
      await settled(previous);
      try {
        return await run();
      } finally {
        release();
      }
    })();
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
