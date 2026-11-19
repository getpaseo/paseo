import { useEffect, useRef, useState } from "react";

/**
 * Whether a docked sidebar is being dragged to a new width. On native the drag holds the committed
 * layout width and moves the visible edge with a transform, so the sibling column does not re-run
 * Yoga or re-measure its text every frame; the width lands once, when the drag ends. Surfaces that
 * switch layout with the workspace width also hold that switch until the drag ends: every React
 * commit during the drag stalls the gesture's UI-thread updates on Fabric.
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

/**
 * Where a held drag draws the panel edge, measured from the committed edge. A held drag keeps the
 * committed layout width until it ends, so only this offset moves while the finger does. Positive
 * moves the dragged edge to the right. `grows` is the direction the panel widens in: a left sidebar
 * grows right, a right rail grows left.
 */
export function resolveSidebarResizePreviewOffset(input: {
  grows: "left" | "right";
  committedWidth: number;
  targetWidth: number;
}): number {
  "worklet";
  const delta = input.targetWidth - input.committedWidth;
  return input.grows === "right" ? delta : -delta;
}

/**
 * Width of the color slabs that fill the gap a shifted pane opens. They are wider than a sidebar
 * drag can move, and only their transform changes, so the fill never resizes a layout node.
 */
export const SIDEBAR_RESIZE_SLAB = 800;

/** Translate that parks a left-anchored slab so its right edge sits at `offset`. */
export function resolveSidebarResizeLeadingShift(offset: number): number {
  "worklet";
  return offset - SIDEBAR_RESIZE_SLAB;
}

/**
 * Translate that parks a right-anchored slab just past the gap opened when the pane shifts left.
 * A non-negative offset opens no trailing gap, so the slab sits fully off the right edge.
 */
export function resolveSidebarResizeTrailingShift(offset: number): number {
  "worklet";
  const gap = offset < 0 ? -offset : 0;
  return SIDEBAR_RESIZE_SLAB - gap;
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
