export interface TouchPoint {
  x: number;
  y: number;
}

export interface DragHold {
  begin: (point: TouchPoint) => void;
  move: (point: TouchPoint) => void;
  cancel: () => void;
}

/**
 * A hold that arms a drag once the finger has stayed put for `delayMs`. Moving further than
 * `slopPx` from where the touch began cancels it, so a scroll that starts on a handle stays a
 * scroll. The sidebar rows arm on the same delay and slop.
 */
export function createDragHold({
  delayMs,
  slopPx,
  onArm,
}: {
  delayMs: number;
  slopPx: number;
  onArm: () => void;
}): DragHold {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let start: TouchPoint | null = null;

  function cancel() {
    if (timer) clearTimeout(timer);
    timer = null;
    start = null;
  }

  return {
    begin(point) {
      cancel();
      start = point;
      timer = setTimeout(() => {
        timer = null;
        start = null;
        onArm();
      }, delayMs);
    },
    move(point) {
      if (!start) return;
      if (Math.hypot(point.x - start.x, point.y - start.y) > slopPx) cancel();
    },
    cancel,
  };
}
