import { setTimeout as pause } from "node:timers/promises";
import type { FinishSubscription, FinishSubscriptionStore, PendingWork } from "../index.js";
import type { FinishObservationResult } from "./observation-buffer.js";
import type { FinishNotificationReason } from "./notification.js";

/** The followed child is still working when the follow limit passes. */
export const FOLLOW_LIMIT = Symbol("follow limit");
export type FollowOutcome = FinishObservationResult | typeof FOLLOW_LIMIT;

/** What the caller is told about one outcome. */
export interface Notice {
  reason: FinishNotificationReason;
  result: FinishObservationResult | null;
  work: readonly PendingWork[];
}

interface Options {
  /** The watch's coalesced records; any one already following makes the watch follow. */
  records: readonly FinishSubscription[];
  store: Pick<FinishSubscriptionStore, "put">;
  limitMs: number;
  /** Work that will start the child's next turn by itself, read when a turn ends. */
  pendingWork(): readonly PendingWork[];
  reasonFor(result: FinishObservationResult): FinishNotificationReason;
}

/**
 * Separates "the turn ended" from "the child has stopped". A watch waits for its prompt's turn.
 * If that turn ends while the child still has pending work, the caller is told once and the
 * watch follows the child: later turn ends and work changes stay silent until the child
 * settles, which reports `finished`, or until the follow limit passes.
 */
export function createFollowing(options: Options) {
  let since = options.records
    .map((record) => record.followingSince)
    .filter((value) => value !== undefined)
    .sort()[0];
  let latest: FinishObservationResult | null = null;
  /** Set when something outside the child's own events may have settled it. */
  let stale = false;
  let wake: (() => void) | undefined;

  /** The child's last idle outcome, decided again. Nothing while it waits on a permission. */
  function recheckOutcome(): FinishObservationResult | undefined {
    stale = false;
    if (latest?.status !== "idle") return undefined;
    return { ...latest, workChanged: true };
  }

  async function follow(): Promise<void> {
    const followingSince = new Date().toISOString();
    // Written before the notice is sent, so a restart never repeats it.
    for (const record of options.records) await options.store.put({ ...record, followingSince });
    since = followingSince;
  }

  return {
    /** The observed outcome, or the follow limit once a followed child runs out of time. */
    async next(observed: Promise<FinishObservationResult>, signal: AbortSignal) {
      if (!since) return observed;
      // The losing side settles when the observation closes.
      observed.catch(() => undefined);
      const rechecked = stale && recheckOutcome();
      if (rechecked) return rechecked;
      const timer = new AbortController();
      const limit = pause(
        Math.max(0, Date.parse(since) + options.limitMs - Date.now()),
        FOLLOW_LIMIT,
        { signal: AbortSignal.any([signal, timer.signal]) },
      );
      limit.catch(() => undefined);
      const recheck = new Promise<FinishObservationResult>((resolve) => {
        wake = () => {
          const outcome = recheckOutcome();
          if (outcome) resolve(outcome);
        };
      });
      try {
        return await Promise.race<FollowOutcome>([observed, limit, recheck]);
      } finally {
        wake = undefined;
        timer.abort();
      }
    },
    /**
     * Decides the child's state again without an event from it, as when a delegation of its
     * own ended without reporting back. Only a followed child is decided again.
     */
    recheck() {
      if (!since) return;
      stale = true;
      wake?.();
    },
    /** Returns nothing when the outcome is not worth telling the caller. */
    async decide(outcome: FollowOutcome): Promise<Notice | undefined> {
      if (outcome === FOLLOW_LIMIT)
        return { reason: "is still working", result: latest, work: options.pendingWork() };
      latest = outcome;
      const reason = options.reasonFor(outcome);
      if (reason !== "finished") return { reason, result: outcome, work: [] };
      // Before the prompt's turn ends, a work change says nothing about its outcome.
      if (outcome.workChanged && !since) return undefined;
      const work = options.pendingWork();
      if (!work.length) return { reason, result: outcome, work };
      if (since) return undefined;
      await follow();
      return { reason: "ended its turn but is still working", result: outcome, work };
    },
  };
}
