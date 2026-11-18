import type { Goal, GoalEvent, GoalEventInput } from "@getpaseo/protocol/goal/types";
import type { GoalEventLog } from "./event-log.js";
import { GoalTransitionError, applyGoalEvent, replayGoal } from "./goal-reducer.js";

export type GoalStoreListener = (goal: Goal, event: GoalEvent) => void;
/** Called with the goal's last state once its log has been tombstoned. */
export type GoalRemovedListener = (goal: Goal) => void;

export interface DispatchResult {
  goal: Goal;
  /** True when the event id was already applied; state is unchanged. */
  duplicate: boolean;
}

/**
 * Goal state is a projection of the event log. dispatch() validates the event
 * against current state before it is written, so the log never holds an event
 * the reducer would reject on replay.
 */
export class GoalStore {
  private readonly goals = new Map<string, Goal>();
  private readonly queues = new Map<string, Promise<unknown>>();

  private readonly listeners = new Set<GoalStoreListener>();
  private readonly removedListeners = new Set<GoalRemovedListener>();
  /**
   * Goals found tombstoned at the last recover(): deletion started but may not have
   * finished. The value is the goal's last state, or null when its log was unreadable.
   */
  readonly pendingDeletions = new Map<string, Goal | null>();
  /** Goals whose log could not be replayed at the last recover(). */
  readonly unreadable = new Map<string, Error>();

  constructor(private readonly log: GoalEventLog) {}

  /** Called after an event is durably appended and applied. Not called for duplicates. */
  subscribe(listener: GoalStoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeRemoved(listener: GoalRemovedListener): () => void {
    this.removedListeners.add(listener);
    return () => this.removedListeners.delete(listener);
  }

  /** Rebuild every goal from its log. Call once at daemon start. */
  async recover(): Promise<void> {
    this.goals.clear();
    this.unreadable.clear();
    this.pendingDeletions.clear();
    for (const goalId of await this.log.listTombstones()) {
      try {
        const events = await this.log.readTombstone(goalId);
        this.pendingDeletions.set(goalId, events ? replayGoal(events) : null);
      } catch {
        this.pendingDeletions.set(goalId, null);
      }
    }
    for (const goalId of await this.log.listGoalIds()) {
      try {
        const goal = replayGoal(await this.log.read(goalId));
        if (goal) {
          this.goals.set(goalId, goal);
        }
      } catch (error) {
        // One bad log must not keep the daemon from starting. The goal stays
        // unavailable and its file is left untouched for inspection.
        this.unreadable.set(goalId, error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  get(goalId: string): Goal | undefined {
    return this.goals.get(goalId);
  }

  list(): Goal[] {
    return [...this.goals.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * Tombstone the goal's log and forget the goal, after any event already queued for
   * it. `guard` may throw to refuse. Returns the goal's last state, or null when there
   * was no such goal. What else
   * the goal owns is the caller's to release; see GoalService.delete.
   */
  remove(goalId: string, guard?: (goal: Goal) => void): Promise<Goal | null> {
    return this.serialized(goalId, async () => {
      const goal = this.goals.get(goalId) ?? null;
      // Checked here, after every event queued before the removal has been applied.
      if (goal) guard?.(goal);
      if (!goal) return null;
      await this.log.tombstone(goalId);
      this.goals.delete(goalId);
      for (const listener of this.removedListeners) {
        try {
          listener(goal);
        } catch {
          // A faulty observer must not fail a committed deletion.
        }
      }
      return goal;
    });
  }

  /** Last step of a deletion, once what the goal owned has been released. */
  removeTombstone(goalId: string): Promise<void> {
    return this.log.removeTombstone(goalId);
  }

  dispatch(goalId: string, input: GoalEventInput): Promise<DispatchResult> {
    return this.serialized(goalId, () => this.dispatchNow(goalId, input));
  }

  /**
   * Dispatch `input`, or, when the reducer refuses it, the event `fallback` builds from the
   * refusal's message. Both happen in one queue slot, so no other event lands in between and
   * whenIdle() covers the outcome either way.
   */
  dispatchOrElse(
    goalId: string,
    input: GoalEventInput,
    fallback: (reason: string) => GoalEventInput,
  ): Promise<DispatchResult> {
    return this.serialized(goalId, async () => {
      try {
        return await this.dispatchNow(goalId, input);
      } catch (error) {
        if (!(error instanceof GoalTransitionError)) throw error;
        return this.dispatchNow(goalId, fallback(error.message));
      }
    });
  }

  /** Resolves once every event queued for the goal so far has been applied or refused. */
  async whenIdle(goalId: string): Promise<void> {
    await this.queues.get(goalId);
  }

  private serialized<T>(goalId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(goalId) ?? Promise.resolve();
    const run = previous.then(task, task);
    this.queues.set(
      goalId,
      run.catch(() => undefined),
    );
    return run;
  }

  private async dispatchNow(goalId: string, input: GoalEventInput): Promise<DispatchResult> {
    const current = this.goals.get(goalId) ?? null;
    if (await this.log.hasEvent(goalId, input.id)) {
      return { goal: this.requireGoal(goalId), duplicate: true };
    }

    // Validate against a provisional event before touching disk. The log
    // assigns the real seq and timestamp; a provisional seq of lastSeq + 1 is
    // equivalent, and the time comes from the log's clock, since the reducer
    // checks retries against the time limit.
    applyGoalEvent(current, {
      ...input,
      goalId,
      seq: (current?.lastSeq ?? 0) + 1,
      at: this.log.timestamp(),
    });

    const { event, duplicate } = await this.log.append(goalId, input);
    if (duplicate) {
      return { goal: this.requireGoal(goalId), duplicate: true };
    }
    const next = applyGoalEvent(current, event);
    this.goals.set(goalId, next);
    for (const listener of this.listeners) {
      try {
        listener(next, event);
      } catch {
        // A faulty observer must not fail a committed event.
      }
    }
    return { goal: next, duplicate: false };
  }

  private requireGoal(goalId: string): Goal {
    const goal = this.goals.get(goalId);
    if (!goal) {
      throw new Error(`Goal ${goalId} not found`);
    }
    return goal;
  }
}
