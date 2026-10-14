import { useMemo } from "react";

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
 * re-renders the row. Consumers today: sidebar workspace rows (per grouping
 * mode) and the workspace desktop tab chips.
 */
export function createDoublePressHandler(input: DoublePressHandlerInput): () => void {
  const {
    onPress,
    onRename,
    didLongPressRef,
    now = Date.now,
    doublePressMs = DOUBLE_PRESS_MS,
  } = input;
  let lastPressAt = 0;
  return () => {
    if (didLongPressRef?.current) {
      didLongPressRef.current = false;
      lastPressAt = 0;
      return;
    }
    const time = now();
    if (onRename && time - lastPressAt < doublePressMs) {
      lastPressAt = 0;
      onRename();
      return;
    }
    lastPressAt = time;
    onPress();
  };
}

/**
 * React binding for `createDoublePressHandler`. Rebuilt when any input
 * changes, which is the handler identity the rows' `onPress` props expect.
 */
export function useDoublePress(input: DoublePressHandlerInput): () => void {
  const { onPress, onRename, didLongPressRef } = input;
  return useMemo(
    () =>
      createDoublePressHandler({
        onPress,
        onRename,
        didLongPressRef,
      }),
    [onPress, onRename, didLongPressRef],
  );
}
