import {
  isProjectOrderEpochSettled,
  recordProjectOrderWrite,
  settleProjectOrderWrite,
  startProjectOrderEpoch,
  applyProjectOrderWrite,
  type ProjectOrderEntry,
  type ProjectOrderEpoch,
  type ProjectOrderWrite,
} from "./project-order-epoch";

/**
 * The one path every project-order write takes.
 *
 * The epoch lives here, in module state, rather than in the sidebar list: the list unmounts when
 * the grouping mode changes or the sidebar closes, and a write whose host has not answered yet
 * would take its epoch with it, leaving the answer to replay against a fresh one. There is one
 * stored project order, so one epoch is the whole truth about it.
 */
export interface ProjectOrderIO {
  getOrder: () => string[];
  setOrder: (keys: string[]) => void;
}

/** What a caller settles later. Names the epoch, so an orphan from a closed one is a no-op. */
export interface ProjectOrderHandle {
  epoch: ProjectOrderEpoch;
  entry: ProjectOrderEntry;
}

let currentEpoch: ProjectOrderEpoch | null = null;

/**
 * Writes the order. A `pending` write opens an epoch and returns the handle to settle it with;
 * an `accepted` write (the user's own reorder, which no host can refuse) joins an open epoch so
 * a later refusal replays over it, and lands directly when there is none.
 */
export function writeProjectOrder(
  io: ProjectOrderIO,
  write: ProjectOrderWrite,
  status: "pending" | "accepted",
): ProjectOrderHandle | null {
  const currentOrder = io.getOrder();
  if (status === "accepted" && currentEpoch === null) {
    io.setOrder(applyProjectOrderWrite(currentOrder, write));
    return null;
  }
  const epoch = currentEpoch ?? startProjectOrderEpoch(currentOrder);
  currentEpoch = epoch;
  const recorded = recordProjectOrderWrite(epoch, write, currentOrder, status);
  io.setOrder(recorded.order);
  return status === "pending" ? { epoch, entry: recorded.entry } : null;
}

export function settleProjectOrder(
  io: ProjectOrderIO,
  handle: ProjectOrderHandle,
  status: "accepted" | "refused",
): void {
  const order = settleProjectOrderWrite(handle.epoch, handle.entry, status, io.getOrder());
  if (handle.epoch !== currentEpoch) return;
  io.setOrder(order);
  if (isProjectOrderEpochSettled(handle.epoch)) currentEpoch = null;
}

/** Test seam: the module owns one epoch for the app's lifetime, so a test has to clear it. */
export function resetProjectOrderWriterForTest(): void {
  currentEpoch = null;
}
