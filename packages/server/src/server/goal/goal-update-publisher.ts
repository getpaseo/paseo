import { toGoalSummary } from "@getpaseo/protocol/goal/progress";
import type { Goal, GoalSummary } from "@getpaseo/protocol/goal/types";
import { type Clock, systemClock } from "./goal-limits.js";
import type { GoalRemovedListener, GoalStoreListener } from "./goal-store.js";

/** At most one goal.update per goal in this window. */
export const GOAL_UPDATE_WINDOW_MS = 250;

export interface GoalUpdatePublisherOptions {
  subscribe(listener: GoalStoreListener): () => void;
  /** Deleted goals; each is pushed once, at once, with `deleted` set. */
  subscribeRemoved?(listener: GoalRemovedListener): () => void;
  publish(goal: GoalSummary, options?: { deleted?: boolean }): void;
  clock?: Clock;
  windowMs?: number;
}

/**
 * Turns recorded goal events into goal.update pushes. The first change to a goal is
 * sent at once; changes inside the following window are folded into one push of the
 * latest state at the window's end, so a burst of events costs one message.
 */
export class GoalUpdatePublisher {
  private readonly publishGoal: GoalUpdatePublisherOptions["publish"];
  private readonly clock: Clock;
  private readonly windowMs: number;
  private readonly lastSentAt = new Map<string, number>();
  private readonly pending = new Map<string, { goal: Goal; cancel: () => void }>();
  private unsubscribe: (() => void) | null;
  private unsubscribeRemoved: (() => void) | null;

  constructor(options: GoalUpdatePublisherOptions) {
    this.publishGoal = options.publish;
    this.clock = options.clock ?? systemClock;
    this.windowMs = options.windowMs ?? GOAL_UPDATE_WINDOW_MS;
    this.unsubscribe = options.subscribe((goal) => this.onChange(goal));
    this.unsubscribeRemoved = options.subscribeRemoved?.((goal) => this.onRemoved(goal)) ?? null;
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribeRemoved?.();
    this.unsubscribeRemoved = null;
    for (const { cancel } of this.pending.values()) cancel();
    this.pending.clear();
    this.lastSentAt.clear();
  }

  private onChange(goal: Goal): void {
    const waiting = this.pending.get(goal.id);
    if (waiting) {
      waiting.goal = goal;
      return;
    }
    const last = this.lastSentAt.get(goal.id);
    const wait = last === undefined ? 0 : last + this.windowMs - this.clock.now();
    if (wait <= 0) {
      this.send(goal);
      return;
    }
    const entry = {
      goal,
      cancel: this.clock.setTimeout(() => {
        this.pending.delete(goal.id);
        this.send(entry.goal);
      }, wait),
    };
    this.pending.set(goal.id, entry);
  }

  /** A change still waiting out its window would arrive after the deletion; drop it. */
  private onRemoved(goal: Goal): void {
    this.pending.get(goal.id)?.cancel();
    this.pending.delete(goal.id);
    this.lastSentAt.delete(goal.id);
    try {
      this.publishGoal(toGoalSummary(goal), { deleted: true });
    } catch {
      // A failed push must not stop later ones; clients still poll goal.list.
    }
  }

  private send(goal: Goal): void {
    this.lastSentAt.set(goal.id, this.clock.now());
    try {
      this.publishGoal(toGoalSummary(goal));
    } catch {
      // A failed push must not stop later ones; clients still poll goal.list.
    }
  }
}
