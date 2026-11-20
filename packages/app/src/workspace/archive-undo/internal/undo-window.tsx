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

interface UndoWindowInput {
  client: UndoableWorkspaceArchiveClient;
  workspace: WorkspaceArchiveTarget;
  toast: ToastApi;
  hidden: WorkspaceDescriptor | null;
  onArchiveCommitted: () => void;
}

let latest: UndoWindow | null = null;

/**
 * One archive's chance to be undone. It opens when the row hides and closes when its toast
 * leaves the screen (timeout, replaced by another toast, or undo).
 *
 * - `open`: undo is offered.
 * - `closed`: undo is no longer offered; the archive stands.
 * - `undone`: the user took the archive back.
 */
class UndoWindow {
  phase: "open" | "closed" | "undone" = "open";
  private archived = false;
  private readonly dismissToast: DismissToast;

  constructor(private readonly input: UndoWindowInput) {
    this.dismissToast = input.toast.show(<WorkspaceArchivedToast onUndo={this.undo} />, {
      durationMs: WORKSPACE_ARCHIVE_UNDO_WINDOW_MS,
      testID: "workspace-archived-toast",
      onDismiss: this.close,
    });
  }

  /** The host finished the archive. It commits now if undo is no longer offered. */
  archiveFinished(): void {
    this.archived = true;
    if (this.phase === "closed") this.commit();
  }

  /** The archive failed on the host, so there is nothing left to undo. */
  archiveFailed(): void {
    this.close();
    this.dismissToast();
  }

  readonly close = (): void => {
    if (this.phase !== "open") return;
    this.phase = "closed";
    this.release();
    if (this.archived) this.commit();
  };

  /** Commits unless the workspace is back by now, for example restored from another client. */
  private commit(): void {
    if (isWorkspaceListed(this.input.workspace)) return;
    this.input.onArchiveCommitted();
  }

  readonly undo = (): boolean => {
    if (this.phase !== "open") return false;
    this.phase = "undone";
    this.release();
    this.dismissToast();
    void undoWorkspaceArchiveOptimistically(this.input).catch((error: unknown) => {
      console.warn("[workspace-archive-undo] undo failed", error);
      this.input.toast.error(i18n.t("sidebar.workspace.toasts.undoArchiveFailed"));
    });
    return true;
  };

  private release(): void {
    if (latest === this) latest = null;
  }
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
  const archive = beginOptimisticWorkspaceArchive(input);
  const window = new UndoWindow({ ...input, hidden: archive.hidden });
  latest = window;

  let outcome: Awaited<typeof archive.done>;
  try {
    outcome = await archive.done;
  } catch (error) {
    if (window.phase === "undone") return;
    window.archiveFailed();
    throw error;
  }
  if (outcome === "archived") window.archiveFinished();
}

/** Undoes the most recent archive while its toast is up. Returns false when there is none. */
export function undoLatestWorkspaceArchive(): boolean {
  return latest ? latest.undo() : false;
}

export function hasUndoableWorkspaceArchive(): boolean {
  return latest !== null;
}
