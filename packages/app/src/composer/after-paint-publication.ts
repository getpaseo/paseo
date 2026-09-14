export interface AfterPaintScheduler {
  schedule: (callback: () => void) => () => void;
}

// Browsers and React Native both expose requestAnimationFrame globally. A frame callback plus
// a zero timeout lands after the keystroke has painted, so the publication never competes with
// the input's own render.
export const afterPaintScheduler: AfterPaintScheduler = {
  schedule: (callback) => {
    if (typeof globalThis.requestAnimationFrame !== "function") {
      let cancelled = false;
      queueMicrotask(() => {
        if (!cancelled) callback();
      });
      return () => {
        cancelled = true;
      };
    }

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const frameId = globalThis.requestAnimationFrame(() => {
      timeoutId = setTimeout(callback, 0);
    });
    return () => {
      globalThis.cancelAnimationFrame(frameId);
      if (timeoutId !== null) clearTimeout(timeoutId);
    };
  },
};

export class AfterPaintPublication<T> {
  private pending: T | null = null;
  private cancelScheduled: (() => void) | null = null;

  constructor(
    private readonly publish: (value: T) => void,
    private readonly scheduler: AfterPaintScheduler = afterPaintScheduler,
  ) {}

  stage(value: T): void {
    this.pending = value;
    if (this.cancelScheduled) return;
    this.cancelScheduled = this.scheduler.schedule(() => {
      this.cancelScheduled = null;
      this.flush();
    });
  }

  flush(): void {
    if (this.pending === null) return;
    this.cancelScheduled?.();
    this.cancelScheduled = null;
    const value = this.pending;
    this.pending = null;
    this.publish(value);
  }

  cancel(): void {
    this.cancelScheduled?.();
    this.cancelScheduled = null;
    this.pending = null;
  }
}
