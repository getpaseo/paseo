export interface ReadingSignalSource<T> {
  subscribe: (listener: () => void) => () => void;
  getValue: () => T;
}

export interface ReadingSignal<T> extends ReadingSignalSource<T> {
  publish: (value: T) => void;
}

/**
 * The transcript reports its reading position on every scroll frame, far more often than it
 * re-renders. Keeping the derived value outside React lets the surfaces that mark the reading
 * position subscribe to it without dragging the transcript through a render on each frame.
 *
 * Hold a primitive so the unchanged-value check below is reference-free: scrolling within one turn
 * then resolves to the same value and notifies nobody.
 */
export function createReadingSignal<T>(initial: T): ReadingSignal<T> {
  const listeners = new Set<() => void>();
  let current = initial;
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getValue: () => current,
    publish(value) {
      if (value === current) {
        return;
      }
      current = value;
      for (const listener of listeners) {
        listener();
      }
    },
  };
}
