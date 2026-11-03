import { useState, useRef } from "react";

/** Two presses within this window count as a double-press. */
const DOUBLE_PRESS_MS = 400;

export interface DoublePressHandlerInput {
  onPress: () => void;
  onRename?: () => void;
  /** Set by a long-press drag interaction; a swallowed press must not count toward a double-press. */
  didLongPressRef?: { current: boolean } | null;
  /** Injected clock for tests; defaults to `Date.now`. */
  now?: () => number;
  /** Window for the double-press; overridable in tests. */
  doublePressMs?: number;
}

/**
 * Pure press handler for rows that rename on a double-press: one press selects,
 * a second press inside the window opens rename. The timestamp survives across
 * presses — deliberately outside React, because the first press's selection
 * re-renders the row. Input fields are read at press time, so a handler fed
 * live inputs keeps its timing state while picking up fresh callbacks.
 * Consumers today: sidebar workspace rows (per grouping mode) and the
 * workspace desktop tab chips.
 */
export function createDoublePressHandler(input: DoublePressHandlerInput): () => void {
  let lastPressAt = 0;
  return () => {
    if (input.didLongPressRef?.current) {
      input.didLongPressRef.current = false;
      lastPressAt = 0;
      return;
    }
    const time = (input.now ?? Date.now)();
    if (input.onRename && time - lastPressAt < (input.doublePressMs ?? DOUBLE_PRESS_MS)) {
      lastPressAt = 0;
      input.onRename();
      return;
    }
    lastPressAt = time;
    input.onPress();
  };
}

/**
 * React binding for `createDoublePressHandler`. The handler is created once for
 * the component's lifetime and reads the latest callbacks through a ref, so a
 * press that re-renders the row (e.g. the selection it triggers rebuilding the
 * press callbacks) keeps its timestamp: the second press still lands inside the
 * double-press window and opens rename.
 */
export function useDoublePress(input: DoublePressHandlerInput): () => void {
  const latestInputRef = useRef<DoublePressHandlerInput>(input);
  latestInputRef.current = input;
  const [handlePress] = useState(() =>
    createDoublePressHandler({
      get onPress() {
        return latestInputRef.current.onPress;
      },
      get onRename() {
        return latestInputRef.current.onRename;
      },
      get didLongPressRef() {
        return latestInputRef.current.didLongPressRef;
      },
      get now() {
        return latestInputRef.current.now;
      },
      get doublePressMs() {
        return latestInputRef.current.doublePressMs;
      },
    }),
  );
  return handlePress;
}
