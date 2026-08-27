export interface ChatOutlineHoverIntent {
  enter(point: PointerPoint): void;
  pointAt(index: number): void;
  move(point: PointerPoint): void;
  leave(): void;
  dispose(): void;
}

interface PointerPoint {
  x: number;
  y: number;
}

const INITIAL_ACTIVATION_DELAY_MS = 150;
const HORIZONTAL_TRANSIT_DISTANCE_PX = 4;

export function createChatOutlineHoverIntent(input: {
  activate: (index: number | null) => void;
  schedule: (callback: () => void, delayMs: number) => number;
  cancel: (timerId: number) => void;
}): ChatOutlineHoverIntent {
  let timerId: number | null = null;
  let candidateIndex: number | null = null;
  let motionAnchor: PointerPoint | null = null;
  let active = false;

  function cancelTimer(): void {
    if (timerId === null) return;
    input.cancel(timerId);
    timerId = null;
  }

  function scheduleActivation(): void {
    if (candidateIndex === null) return;
    cancelTimer();
    timerId = input.schedule(() => {
      timerId = null;
      active = true;
      if (candidateIndex !== null) input.activate(candidateIndex);
    }, INITIAL_ACTIVATION_DELAY_MS);
  }

  return {
    enter(point) {
      motionAnchor = point;
    },
    pointAt(index) {
      candidateIndex = index;
      if (active) {
        input.activate(index);
        return;
      }
      if (timerId !== null) return;
      scheduleActivation();
    },
    move(point) {
      if (active || motionAnchor === null) return;
      const deltaX = point.x - motionAnchor.x;
      const deltaY = point.y - motionAnchor.y;
      if (Math.abs(deltaY) >= Math.abs(deltaX)) {
        motionAnchor = point;
        return;
      }
      if (Math.abs(deltaX) < HORIZONTAL_TRANSIT_DISTANCE_PX) return;
      motionAnchor = point;
      scheduleActivation();
    },
    leave() {
      cancelTimer();
      candidateIndex = null;
      motionAnchor = null;
      active = false;
      input.activate(null);
    },
    dispose() {
      cancelTimer();
      candidateIndex = null;
      motionAnchor = null;
      active = false;
    },
  };
}
