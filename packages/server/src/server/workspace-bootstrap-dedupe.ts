/**
 * Pure dedupe decision for the bootstrap flush.
 *
 * During the bootstrap window the session buffers workspace updates that
 * race with the initial `fetch_workspaces_response`. The flush step decides
 * which buffered updates still carry new information and which are
 * redundant with what the client just received in the snapshot.
 *
 * Returns `true` (emit) when ANY of:
 *   - the status changed from the snapshot
 *   - the statusEnteredAt changed from the snapshot (including the
 *     null↔value transition that the unmask case produces)
 *   - the update's activityAtMs is strictly newer than the snapshot's
 *   - the snapshot has no activityAtMs and the update has one (new activity
 *     where there was none)
 *
 * Returns `false` (drop) when the status pair is unchanged AND the update
 * is not strictly newer than the snapshot in activity. The both-null
 * activity case falls through to drop — there is genuinely no new info.
 */
export interface BootstrapUpdateSnapshot {
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

  if (snapshot.status !== update.status) {
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
