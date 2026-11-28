import { setTimeout as pause } from "node:timers/promises";
import type { FinishSubscription, FinishSubscriptionStore, PendingWork } from "../index.js";
import type { FinishObservationResult } from "./observation-buffer.js";
import type { FinishNotificationReason } from "./notification.js";

/** The followed child still has pending work when the follow limit passes. */
export const FOLLOW_LIMIT = Symbol("follow limit");
export type FollowOutcome = FinishObservationResult | typeof FOLLOW_LIMIT;

/** What the caller is told about one outcome. */
export interface Notice {
  reason: FinishNotificationReason;
  result: FinishObservationResult | null;
  /** The turn ended with this work pending; the watch keeps following the child. */
  pendingWork?: readonly PendingWork[];
  /** The follow limit passed while the child still had pending work; the watch ends. */
  followLimit?: true;
}

/** What one outcome means for the watch: what to tell the caller, and whether to stop watching. */
export interface Decision {
  notice?: Notice;
  done: boolean;
}

const KEEP_WATCHING: Decision = { done: false };

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
 * Each turn end reports `finished` at once. When work that will start the child's next turn is
 * still pending, the notice names that work and the watch follows the child: later turn ends
 * report again, and the child settling with nothing pending, even without another turn, sends the
 * final `finished` and ends the watch. When the follow limit passes first, the caller gets a final
 * `finished` with the child's last reply.
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
    // A restart keeps following instead of waiting for another turn end.
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
    async decide(outcome: FollowOutcome): Promise<Decision> {
      if (outcome === FOLLOW_LIMIT)
        return { notice: { reason: "finished", result: latest, followLimit: true }, done: true };
      latest = outcome;
      const reason = options.reasonFor(outcome);
      // A permission request is a checkpoint; the caller still hears how the child ends.
      if (reason !== "finished")
        return { notice: { reason, result: outcome }, done: reason !== "needs permission" };
      // Before the prompt's turn ends, a work change says nothing about its outcome.
      if (outcome.workChanged && !since) return KEEP_WATCHING;
      const pendingWork = options.pendingWork();
      if (!pendingWork.length) return { notice: { reason, result: outcome }, done: true };
      if (!since) await follow();
      // Work that changed but is still pending brings no new reply.
      if (outcome.workChanged) return KEEP_WATCHING;
      return { notice: { reason, result: outcome, pendingWork }, done: false };
    },
  };
}
