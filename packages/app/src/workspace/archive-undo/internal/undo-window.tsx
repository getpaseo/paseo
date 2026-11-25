import type { DismissToast, ToastApi } from "@/components/toast-host";
import { i18n } from "@/i18n/i18next";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import {
  beginOptimisticWorkspaceArchive,
  isWorkspaceListed,
  undoWorkspaceArchiveOptimistically,
  type WorkspaceArchiveTarget,
} from "@/workspace/workspace-archive";
import { WorkspaceArchivedToast } from "./workspace-archived-toast";

/** How long the archived toast, and with it the chance to undo, stays up. */
export const WORKSPACE_ARCHIVE_UNDO_WINDOW_MS = 6000;

export interface UndoableWorkspaceArchiveClient {
  archiveWorkspace: (workspaceId: string) => Promise<{ error: string | null; canceled?: boolean }>;
  undoWorkspaceArchive: (workspaceId: string) => Promise<void>;
}

export interface UndoableWorkspaceArchiveEntryInput {
  client: UndoableWorkspaceArchiveClient;
  workspace: WorkspaceArchiveTarget;
  onArchiveCommitted: () => void;
}

interface UndoWindowEntry extends UndoableWorkspaceArchiveEntryInput {
  hidden: WorkspaceDescriptor | null;
  archived: boolean;
  failed: boolean;
  committed: boolean;
}

interface UndoWindowInput {
  entries: UndoWindowEntry[];
  toast: ToastApi;
}

let latest: UndoWindow | null = null;

/**
 * One archive batch's chance to be undone. It opens when the row(s) hide and closes when its toast
 * leaves the screen (timeout, replaced by another toast, or undo).
 *
 * - `open`: undo is offered.
 * - `closed`: undo is no longer offered; the archive stands.
 * - `undone`: the user took the archive back.
 */
class UndoWindow {
  phase: "open" | "closed" | "undone" = "open";
  private readonly dismissToast: DismissToast;

  constructor(private readonly input: UndoWindowInput) {
    this.dismissToast = input.toast.show(
      <WorkspaceArchivedToast count={input.entries.length} onUndo={this.undo} />,
      {
        layout: "action",
        durationMs: WORKSPACE_ARCHIVE_UNDO_WINDOW_MS,
        testID: "workspace-archived-toast",
        onDismiss: this.close,
      },
    );
  }

  /** The host finished archiving this entry. It commits now if undo is no longer offered. */
  entryFinished(entry: UndoWindowEntry): void {
    entry.archived = true;
    if (this.phase === "closed") this.commitEntry(entry);
  }

  /** The archive failed on the host. Dismisses the toast once every entry has failed. */
  entryFailed(entry: UndoWindowEntry): void {
    entry.failed = true;
    if (this.input.entries.every((item) => item.failed)) {
      this.close();
      this.dismissToast();
    }
  }

  readonly close = (): void => {
    if (this.phase !== "open") return;
    this.phase = "closed";
    this.release();
    for (const entry of this.input.entries) {
      if (entry.archived) this.commitEntry(entry);
    }
  };

  /** Commits unless the workspace is back by now, for example restored from another client. */
  private commitEntry(entry: UndoWindowEntry): void {
    if (entry.committed || entry.failed) return;
    if (isWorkspaceListed(entry.workspace)) return;
    entry.committed = true;
    entry.onArchiveCommitted();
  }

  readonly undo = (): boolean => {
    if (this.phase !== "open") return false;
    this.phase = "undone";
    this.release();
    this.dismissToast();
    const undoable = this.input.entries.filter((entry) => !entry.failed);
    void (async () => {
      const results = await Promise.allSettled(
        undoable.map((entry) => undoWorkspaceArchiveOptimistically(entry)),
      );
      const failed = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failed.length > 0) {
        console.warn("[workspace-archive-undo] undo failed", failed[0]?.reason);
        this.input.toast.error(i18n.t("sidebar.workspace.toasts.undoArchiveFailed"));
      }
    })();
    return true;
  };

  private release(): void {
    if (latest === this) latest = null;
  }
}

export interface WorkspaceArchiveBatchFailure {
  workspace: WorkspaceArchiveTarget;
  error: unknown;
}

/**
 * Archives one or more workspaces together and offers one undo until the toast goes away.
 *
 * `onArchiveCommitted` runs per workspace once that archive both finished on the host and can no
 * longer be undone, and only if the workspace is still gone then. Returns failures for any
 * workspace whose archive failed while not undone; those rows are already restored.
 */
export async function archiveWorkspacesWithUndo(input: {
  entries: readonly UndoableWorkspaceArchiveEntryInput[];
  toast: ToastApi;
}): Promise<WorkspaceArchiveBatchFailure[]> {
  if (input.entries.length === 0) return [];

  const started = input.entries.map((entry) => {
    const archive = beginOptimisticWorkspaceArchive(entry);
    const windowEntry: UndoWindowEntry = {
      ...entry,
      hidden: archive.hidden,
      archived: false,
      failed: false,
      committed: false,
    };
    return { windowEntry, done: archive.done };
  });

  const window = new UndoWindow({
    entries: started.map((item) => item.windowEntry),
    toast: input.toast,
  });
  latest = window;

  const failures: WorkspaceArchiveBatchFailure[] = [];
  await Promise.all(
    started.map(async ({ windowEntry, done }) => {
      let outcome: Awaited<typeof done>;
      try {
        outcome = await done;
      } catch (error) {
        if (window.phase === "undone") return;
        window.entryFailed(windowEntry);
        failures.push({ workspace: windowEntry.workspace, error });
        return;
      }
      if (outcome === "archived") window.entryFinished(windowEntry);
    }),
  );

  return failures;
}

/**
 * Archives a workspace and offers to undo it until the toast goes away.
 *
 * `onArchiveCommitted` runs once the archive both finished on the host and can no longer be
 * undone, and only if the workspace is still gone then. Local state the undo would want back
 * (tabs, layout) survives the window, and survives a restore from another client.
 * Rejects when the archive fails and was not undone; the row is back by then.
 */
export async function archiveWorkspaceWithUndo(input: {
  client: UndoableWorkspaceArchiveClient;
  workspace: WorkspaceArchiveTarget;
  toast: ToastApi;
  onArchiveCommitted: () => void;
}): Promise<void> {
  const failures = await archiveWorkspacesWithUndo({
    entries: [
      {
        client: input.client,
        workspace: input.workspace,
        onArchiveCommitted: input.onArchiveCommitted,
      },
    ],
    toast: input.toast,
  });
  if (failures[0]) {
    throw failures[0].error;
  }
}

/** Undoes the most recent archive while its toast is up. Returns false when there is none. */
export function undoLatestWorkspaceArchive(): boolean {
  return latest ? latest.undo() : false;
}

export function hasUndoableWorkspaceArchive(): boolean {
  return latest !== null;
}
