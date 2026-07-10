export interface SharedStepClock {
  getSnapshot: () => number;
  subscribe: (listener: () => void) => () => void;
}

export function createSharedStepClock(stepCount: number, cycleDurationMs: number): SharedStepClock {
  const normalizedStepCount = Math.max(1, Math.floor(stepCount));
  const stepDurationMs = Math.max(1, Math.round(cycleDurationMs / normalizedStepCount));
  const listeners = new Set<() => void>();
  let step = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  function advance(): void {
    step = (step + 1) % normalizedStepCount;
    for (const listener of listeners) {
      listener();
    }
  }

  return {
    getSnapshot: () => step,
    subscribe: (listener) => {
      listeners.add(listener);
      if (timer === null) {
        timer = setInterval(advance, stepDurationMs);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
  };
}
