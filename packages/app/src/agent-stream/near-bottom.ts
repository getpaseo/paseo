import { useState, useSyncExternalStore } from "react";

/**
 * Whether the reader is at the end of the timeline. The viewport writes it and only the
 * scroll-to-bottom button reads it, so detaching from the end (a scroll, or a disclosure
 * that opens below its trigger) re-renders the button and not the timeline.
 */
export interface NearBottom {
  set: (value: boolean) => void;
  subscribe: (listener: () => void) => () => void;
  get: () => boolean;
}

function createNearBottom(): NearBottom {
  let value = true;
  const listeners = new Set<() => void>();
  return {
    set: (next) => {
      if (next === value) return;
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get: () => value,
  };
}

/** One per viewed agent; a newly viewed agent starts at the end. */
export function useNearBottom(agentId: string): NearBottom {
  const [owner, setOwner] = useState(() => ({ agentId, nearBottom: createNearBottom() }));
  if (owner.agentId === agentId) return owner.nearBottom;
  const next = { agentId, nearBottom: createNearBottom() };
  setOwner(next);
  return next.nearBottom;
}

export function useIsNearBottom(nearBottom: NearBottom): boolean {
  return useSyncExternalStore(nearBottom.subscribe, nearBottom.get, nearBottom.get);
}
