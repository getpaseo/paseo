import { groupStartAnchor, moveKeyRelative, spliceReorderedKeys } from "@/utils/sidebar-reorder";

/**
 * The stored project order while group moves are in flight.
 *
 * A cross-group drop writes the order before its host answers, and several drops can be waiting
 * at once while the user keeps reordering rows. Putting a refused row "back where it was" is
 * order-dependent as soon as two moves touch the same neighbours, so the epoch does not undo
 * anything: it keeps the order the first pending write found (`baseOrder`) and a log of every
 * write since, and the stored order is always the base with every write that was not refused
 * replayed over it, in the order the writes were made. What the sidebar shows once the hosts have
 * all answered is then a function of the writes and of which ones were refused, never of who
 * answered first.
 *
 * Writes the host has no say in (a reorder inside one list) enter the log already accepted. The
 * epoch ends when no write is pending, and `project-order-writer.ts` owns the live one.
 *
 * A write says what the drop meant, never where it landed at the time. A header drop keeps its
 * "ahead of this group" intent (`group_start`) rather than the row it resolved to, because
 * refusing an earlier drop on the same header changes what a later one should be ahead of.
 */
export type ProjectOrderWrite =
  | {
      kind: "move";
      key: string;
      anchorKey: string;
      placement: "before" | "after";
      /**
       * The group the row lands in, when the drop put it in one. A later drop on that group's
       * header has to go ahead of it, the same as for a `group_start` write.
       */
      groupKey?: string | null;
    }
  | {
      kind: "group_start";
      key: string;
      /** The group the row was dropped on. Its first row changes; the group does not. */
      groupKey: string;
      /** The group's first row at drop time. */
      firstViewKey: string;
      /**
       * Rows accepted into the same group whose project record had not arrived yet, so the
       * group still showed `firstViewKey` first. Rows that arrive through this epoch's own log
       * are found there instead, and only while their write survives.
       */
      arrivingKeys: readonly string[];
    }
  | { kind: "splice"; visibleKeys: readonly string[] }
  /**
   * A drop that changed a row's group without moving it: leaving a group keeps a row's place, but
   * a later drop on the group it left must not still be told the row is on its way in.
   */
  | { kind: "membership"; key: string; groupKey: string | null };

export type ProjectOrderWriteStatus = "pending" | "accepted" | "refused";

export interface ProjectOrderEntry {
  write: ProjectOrderWrite;
  status: ProjectOrderWriteStatus;
}

export interface ProjectOrderEpoch {
  baseOrder: string[];
  entries: ProjectOrderEntry[];
}

export function startProjectOrderEpoch(order: string[]): ProjectOrderEpoch {
  return { baseOrder: [...order], entries: [] };
}

/**
 * Folds keys the sidebar gained or lost since the base was taken into the base itself, so a
 * later replay starts from them rather than from an order some refused write already touched.
 * Every entry point calls this before it reads or logs anything, which is what makes it safe to
 * assume a write only ever names keys the base already has.
 */
function syncEpochBase(epoch: ProjectOrderEpoch, currentOrder: readonly string[]): void {
  const currentSet = new Set(currentOrder);
  const baseSet = new Set(epoch.baseOrder);
  const kept = epoch.baseOrder.filter((key) => currentSet.has(key));
  const added = currentOrder.filter((key) => !baseSet.has(key));
  if (added.length === 0 && kept.length === epoch.baseOrder.length) return;
  epoch.baseOrder = [...kept, ...added];
}

/** Logs a write and returns the stored order with it in effect. */
export function recordProjectOrderWrite(
  epoch: ProjectOrderEpoch,
  write: ProjectOrderWrite,
  currentOrder: string[],
  status: "pending" | "accepted",
): { entry: ProjectOrderEntry; order: string[] } {
  syncEpochBase(epoch, currentOrder);
  const entry: ProjectOrderEntry = { write, status };
  epoch.entries.push(entry);
  return { entry, order: replayProjectOrder(epoch) };
}

/** Marks a pending write and returns the stored order without it (refused) or with it (accepted). */
export function settleProjectOrderWrite(
  epoch: ProjectOrderEpoch,
  entry: ProjectOrderEntry,
  status: "accepted" | "refused",
  currentOrder: string[],
): string[] {
  syncEpochBase(epoch, currentOrder);
  entry.status = status;
  return replayProjectOrder(epoch);
}

export function isProjectOrderEpochSettled(epoch: ProjectOrderEpoch): boolean {
  return epoch.entries.every((entry) => entry.status !== "pending");
}

function replayProjectOrder(epoch: ProjectOrderEpoch): string[] {
  // Which rows each group has already taken in, counting only surviving writes: the next drop on
  // that header goes ahead of them, the way it would have at drop time. Keyed by the group, not
  // by its first row, because a replica arriving between two drops changes which row is first.
  const arrivedByGroupKey = new Map<string, Set<string>>();
  let order = epoch.baseOrder;
  for (const entry of epoch.entries) {
    if (entry.status === "refused") continue;
    order = applyProjectOrderWrite(order, entry.write, arrivedByGroupKey);
  }
  return order;
}

/**
 * Notes that `key` is now in `groupKey`, and no longer in whichever group a write put it in
 * before: a row dragged on to a second group must stop counting as an arrival in the first, or
 * a later drop on the first group's header would try to land ahead of a row that left.
 */
function recordArrival(
  arrivedByGroupKey: Map<string, Set<string>>,
  key: string,
  groupKey: string | null,
): void {
  for (const arrived of arrivedByGroupKey.values()) arrived.delete(key);
  if (groupKey === null) return;
  const arrived = arrivedByGroupKey.get(groupKey) ?? new Set<string>();
  arrived.add(key);
  arrivedByGroupKey.set(groupKey, arrived);
}

/** One write over an order. A key the order no longer has is left out rather than re-added. */
export function applyProjectOrderWrite(
  order: string[],
  write: ProjectOrderWrite,
  arrivedByGroupKey = new Map<string, Set<string>>(),
): string[] {
  switch (write.kind) {
    case "move": {
      if (!order.includes(write.key)) return order;
      if (write.groupKey !== undefined) recordArrival(arrivedByGroupKey, write.key, write.groupKey);
      return moveKeyRelative({
        currentOrder: order,
        key: write.key,
        anchorKey: write.anchorKey,
        placement: write.placement,
      });
    }
    case "group_start": {
      if (!order.includes(write.key)) return order;
      const arrived = arrivedByGroupKey.get(write.groupKey) ?? new Set<string>();
      const anchorKey = groupStartAnchor({
        currentOrder: order,
        firstViewKey: write.firstViewKey,
        arrivingKeys: new Set([...write.arrivingKeys, ...arrived]),
      });
      recordArrival(arrivedByGroupKey, write.key, write.groupKey);
      return moveKeyRelative({
        currentOrder: order,
        key: write.key,
        anchorKey,
        placement: "before",
      });
    }
    case "membership":
      if (order.includes(write.key)) recordArrival(arrivedByGroupKey, write.key, write.groupKey);
      return order;
    case "splice": {
      const present = new Set(order);
      return spliceReorderedKeys({
        currentOrder: order,
        reorderedVisibleKeys: write.visibleKeys.filter((key) => present.has(key)),
      });
    }
  }
}
