import equal from "fast-deep-equal";
import type { WorkspaceDescriptorPayload } from "./messages.js";

/**
 * Pure dedupe decision for the bootstrap flush.
 *
 * During the bootstrap window the session buffers workspace updates that
 * race with the initial `fetch_workspaces_response`. The flush step decides
 * which buffered updates still carry new information and which are
 * redundant with what the client just received in the snapshot.
 *
 * A remaining chat can keep the bucket and its timestamp unchanged while a
 * different chat is resolved. The buffered result list must reach the menu too.
 */
export interface BootstrapUpdateSnapshot {
  attentionKeys?: WorkspaceDescriptorPayload["attentionKeys"];
  reviewResults?: WorkspaceDescriptorPayload["reviewResults"];
  status: string;
  statusEnteredAt: string | null;
  activityAtMs: number | null;
}

export interface BootstrapUpdateCheckInput {
  /** Snapshot captured from the fetch_workspaces_response. `null` means
   * the workspace was not in the snapshot (first-time subscription). */
  snapshot: BootstrapUpdateSnapshot | null;
  /** Pending update buffered during the bootstrap window. */
  update: BootstrapUpdateSnapshot;
}

export function shouldEmitPendingBootstrapUpdate(input: BootstrapUpdateCheckInput): boolean {
  const { snapshot, update } = input;
  if (!snapshot) {
    return true;
  }

  if (
    snapshot.status !== update.status ||
    !equal(snapshot.reviewResults, update.reviewResults) ||
    !equal(snapshot.attentionKeys, update.attentionKeys)
  ) {
    return true;
  }

  const snapshotEnteredAt = snapshot.statusEnteredAt ?? null;
  const updateEnteredAt = update.statusEnteredAt ?? null;
  if (snapshotEnteredAt !== updateEnteredAt) {
    return true;
  }

  // Status pair is unchanged. The only remaining signal is activity.
  if (update.activityAtMs === null) {
    return false;
  }
  if (snapshot.activityAtMs === null) {
    return true;
  }
  return update.activityAtMs > snapshot.activityAtMs;
}
