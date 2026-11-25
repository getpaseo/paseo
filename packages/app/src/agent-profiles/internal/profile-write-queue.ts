import type { AgentProfile } from "@getpaseo/protocol/messages";

export type AgentProfileListUpdater = (current: readonly AgentProfile[]) => AgentProfile[] | null;

export interface AgentProfileWriteStep {
  readCurrent: () => readonly AgentProfile[] | null;
  write: (next: AgentProfile[]) => Promise<AgentProfile[]>;
  updater: AgentProfileListUpdater;
}

export interface AgentProfileWriteQueue {
  enqueue(serverId: string, step: AgentProfileWriteStep): Promise<AgentProfile[] | null>;
}

/** Removes one profile by id, returning `null` if it is already absent so callers skip no-op writes. */
export function removeAgentProfileById(
  current: readonly AgentProfile[],
  profileId: string,
): AgentProfile[] | null {
  const next = current.filter((entry) => entry.id !== profileId);
  return next.length === current.length ? null : next;
}

async function runQueuedWrite(
  previous: Promise<void>,
  step: AgentProfileWriteStep,
): Promise<AgentProfile[] | null> {
  await previous;
  const current = step.readCurrent();
  if (current === null) {
    return null;
  }
  const next = step.updater(current);
  if (next === null) {
    return null;
  }
  return step.write(next);
}

/**
 * Serializes profile list writes per host so overlapping mutations (rapid composer
 * `+` saves, Undo while another save is in flight, split-pane composers) each compute
 * their update against the result of the previous write instead of overwriting it.
 */
export function createAgentProfileWriteQueue(): AgentProfileWriteQueue {
  const tails = new Map<string, Promise<void>>();

  return {
    enqueue(serverId, step) {
      const previous = tails.get(serverId) ?? Promise.resolve();
      const result = runQueuedWrite(previous, step);
      const tail = result.then(
        () => undefined,
        () => undefined,
      );
      tails.set(serverId, tail);
      void tail.finally(() => {
        if (tails.get(serverId) === tail) {
          tails.delete(serverId);
        }
      });
      return result;
    },
  };
}
