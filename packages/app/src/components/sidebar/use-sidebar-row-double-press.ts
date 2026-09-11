import { useMemo } from "react";

/** Two presses within this window count as a double-press and open rename. */
const DOUBLE_PRESS_MS = 400;

export interface SidebarRowPressHandlerInput {
  onPress: () => void;
  onRename?: () => void;
  /** Set by the long-press drag interaction; a swallowed press must not count toward a double-press. */
  didLongPressRef?: { current: boolean } | null;
  /** Injected clock for tests; defaults to `Date.now`. */
  now?: () => number;
  /** Window for the double-press; overridable in tests. */
  doublePressMs?: number;
}

/**
 * Pure press handler shared by every sidebar workspace row: one press selects, a
 * second press inside the window opens the rename modal. The timestamp survives
 * across presses — deliberately outside React, because the first press's
 * navigation re-renders the row. The row implementations exist per sidebar mode
 * (project groups, status groups), so the behavior is centralized here.
 */
export function createSidebarRowPressHandler(input: SidebarRowPressHandlerInput): () => void {
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
 * React binding for `createSidebarRowPressHandler`. Rebuilt when any input
 * changes, which is the handler identity the rows' `onPress` props expect.
 */
export function useSidebarRowDoublePress(input: SidebarRowPressHandlerInput): () => void {
  const { onPress, onRename, didLongPressRef } = input;
  return useMemo(
    () =>
      createSidebarRowPressHandler({
        onPress,
        onRename,
        didLongPressRef,
      }),
    [onPress, onRename, didLongPressRef],
  );
}
