import { useEffect, useRef, useState } from "react";

/**
 * Whether a docked sidebar is being dragged to a new width. Surfaces that switch layout with the
 * workspace width hold that switch until the drag ends: every React commit during the drag stalls
 * the gesture's UI-thread width updates on Fabric.
 *
 * Gestures call `begin` once they activate and `end` once they finish, so a tap on a grip never
 * counts. Overlapping drags (two pointers on two grips) keep the activity until both end.
 *
 * Nothing subscribes through React state: that would re-render every surface at the start and end
 * of each drag. Surfaces route their layout updates through a gate instead.
 */
let activeResizes = 0;
const endListeners = new Set<() => void>();

export function beginSidebarResize(): void {
  activeResizes += 1;
}

export function endSidebarResize(): void {
  if (activeResizes === 0) return;
  activeResizes -= 1;
  if (activeResizes > 0) return;
  for (const listener of endListeners) listener();
}

export function isSidebarResizeActive(): boolean {
  return activeResizes > 0;
}

/** Calls `listener` each time the last running drag ends. Returns the unsubscribe function. */
export function subscribeSidebarResizeEnd(listener: () => void): () => void {
  endListeners.add(listener);
  return () => {
    endListeners.delete(listener);
  };
}

export interface SidebarResizeGate<T> {
  /** Applies `value` now, or holds it while a drag runs. A later offer replaces a held value. */
  offer: (value: T) => void;
  /** Applies the held value, if any. Subscribe it to the end of a drag. */
  flush: () => void;
}

export function createSidebarResizeGate<T>(apply: (value: T) => void): SidebarResizeGate<T> {
  let held: { value: T } | null = null;
  return {
    offer: (value) => {
      if (isSidebarResizeActive()) {
        held = { value };
        return;
      }
      held = null;
      apply(value);
    },
    flush: () => {
      if (held === null) return;
      const { value } = held;
      held = null;
      apply(value);
    },
  };
}

/** A gate that calls the latest `apply` and flushes when a drag ends. Returns its `offer`. */
export function useSidebarResizeGate<T>(apply: (value: T) => void): (value: T) => void {
  const applyRef = useRef(apply);
  useEffect(() => {
    applyRef.current = apply;
  }, [apply]);
  const [gate] = useState(() => createSidebarResizeGate<T>((value) => applyRef.current(value)));
  useEffect(() => subscribeSidebarResizeEnd(gate.flush), [gate]);
  return gate.offer;
}
