import { useCallback, useRef } from "react";

/** Two presses within this window count as a double-press and open rename. */
const DOUBLE_PRESS_MS = 400;

/**
 * Press handler shared by every sidebar workspace row: one press selects, a
 * second press inside the window opens the rename modal. The timestamp lives
 * in a ref because the first press's navigation re-renders the row, and the
 * row implementations exist per sidebar mode (project groups, status groups),
 * so the behavior is centralized here instead.
 */
export function useSidebarRowDoublePress({
  onPress,
  onRename,
  didLongPressRef,
}: {
  onPress: () => void;
  onRename?: () => void;
  didLongPressRef?: { current: boolean } | null;
}) {
  const lastPressAtRef = useRef(0);
  return useCallback(() => {
    if (didLongPressRef?.current) {
      didLongPressRef.current = false;
      lastPressAtRef.current = 0;
      return;
    }
    const now = Date.now();
    if (onRename && now - lastPressAtRef.current < DOUBLE_PRESS_MS) {
      lastPressAtRef.current = 0;
      onRename();
      return;
    }
    lastPressAtRef.current = now;
    onPress();
  }, [didLongPressRef, onRename, onPress]);
}
