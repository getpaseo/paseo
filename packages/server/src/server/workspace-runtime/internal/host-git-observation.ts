import {
  createFileObserver,
  type FileObserver,
  type FileObserverDiagnostics,
  type FileObserverSubscription,
} from "../../file-observer/index.js";
import { realpath } from "node:fs/promises";
import { getGitCommonDir } from "../../../utils/worktree.js";

interface CommonObservation {
  listeners: Set<() => void>;
  subscription: FileObserverSubscription | null;
}

export interface HostGitObservationOwner {
  observe(root: string, listener: () => void): Promise<{ unsubscribe(): Promise<void> }>;
  getDiagnostics(): FileObserverDiagnostics;
}

/** One private physical common-Git watcher per host common directory. */
export function createHostGitObservationOwner(
  observer: FileObserver = createFileObserver(),
): HostGitObservationOwner {
  const observations = new Map<string, CommonObservation>();
  const tails = new Map<string, Promise<void>>();

  return {
    async observe(root, listener) {
      const commonDirectory = await realpath(await getGitCommonDir(root));
      await sequence(commonDirectory, async () => {
        let observation = observations.get(commonDirectory);
        if (!observation) {
          const listeners = new Set<() => void>();
          observation = { listeners, subscription: null };
          observations.set(commonDirectory, observation);
        }
        observation.subscription ??= await subscribe(commonDirectory, observation);
        observation.listeners.add(listener);
      });
      let active = true;
      return {
        async unsubscribe() {
          if (!active) return;
          active = false;
          await sequence(commonDirectory, async () => {
            const observation = observations.get(commonDirectory);
            if (!observation) return;
            observation.listeners.delete(listener);
            if (observation.listeners.size > 0) return;
            observations.delete(commonDirectory);
            await observation.subscription?.unsubscribe();
            observation.subscription = null;
          });
        },
      };
    },
    getDiagnostics() {
      return observer.getDiagnostics();
    },
  };

  async function sequence(key: string, operation: () => Promise<void>): Promise<void> {
    const previous = tails.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    tails.set(key, current);
    try {
      await current;
    } finally {
      if (tails.get(key) === current) tails.delete(key);
    }
  }

  async function subscribe(
    commonDirectory: string,
    observation: CommonObservation,
  ): Promise<FileObserverSubscription> {
    let subscription!: FileObserverSubscription;
    subscription = await observer.subscribe(commonDirectory, (error, events) => {
      if (error || events.length > 0) {
        for (const notify of observation.listeners) notify();
      }
      if (error) rebindAfterFailure(commonDirectory, observation, subscription);
    });
    return subscription;
  }

  function rebindAfterFailure(
    commonDirectory: string,
    observation: CommonObservation,
    failedSubscription: FileObserverSubscription,
  ): void {
    void sequence(commonDirectory, async () => {
      if (
        observations.get(commonDirectory) !== observation ||
        observation.subscription !== failedSubscription
      ) {
        return;
      }
      observation.subscription = null;
      await failedSubscription.unsubscribe();
      if (observation.listeners.size === 0) {
        observations.delete(commonDirectory);
        return;
      }
      observation.subscription = await subscribe(commonDirectory, observation);
    }).catch(() => {
      for (const notify of observation.listeners) notify();
    });
  }
}
