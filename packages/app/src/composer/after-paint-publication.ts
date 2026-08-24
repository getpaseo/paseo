export interface AfterPaintScheduler {
  schedule: (callback: () => void) => () => void;
}

export const browserAfterPaintScheduler: AfterPaintScheduler = {
  schedule: (callback) => {
    if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
      let cancelled = false;
      queueMicrotask(() => {
        if (!cancelled) callback();
      });
      return () => {
        cancelled = true;
      };
    }

    let timeoutId: number | null = null;
    const frameId = window.requestAnimationFrame(() => {
      timeoutId = window.setTimeout(callback, 0);
    });
    return () => {
      window.cancelAnimationFrame(frameId);
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
  },
};

export class AfterPaintPublication<T> {
  private pending: T | null = null;
  private cancelScheduled: (() => void) | null = null;

  constructor(
    private readonly publish: (value: T) => void,
    private readonly scheduler: AfterPaintScheduler = browserAfterPaintScheduler,
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
