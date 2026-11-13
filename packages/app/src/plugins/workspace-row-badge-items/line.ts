/**
 * Which items on one workspace row's plugin line actually drew something. A separator belongs
 * between two drawn things, and only the badge knows whether its item drew, so each badge reports
 * in and the ones after it read the result.
 */
export interface RowBadgeLine {
  subscribe(listener: () => void): () => void;
  /** Positions of the items that have drawn, in a new array each time it changes. */
  getDrawn(): readonly number[];
  /** Record that the item at `position` drew; the returned function takes it back. */
  markDrawn(position: number): () => void;
}

export function createRowBadgeLine(): RowBadgeLine {
  let drawn: readonly number[] = [];
  const listeners = new Set<() => void>();
  const publish = (next: readonly number[]) => {
    drawn = next;
    for (const listener of listeners) listener();
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getDrawn: () => drawn,
    markDrawn(position) {
      publish([...drawn, position]);
      return () => {
        const index = drawn.indexOf(position);
        if (index >= 0) publish(drawn.filter((_, i) => i !== index));
      };
    },
  };
}

/** `leading`: the row drew items of its own before the plugin line. */
export function needsSeparator({
  leading,
  position,
  drawn,
}: {
  leading: boolean;
  position: number;
  drawn: readonly number[];
}): boolean {
  return leading || drawn.some((other) => other < position);
}
