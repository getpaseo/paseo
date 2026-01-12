import { getNowMs, isPerfLoggingEnabled, perfLog } from "@/utils/perf";

const PERF_MONITOR_LOG_TAG = "[PerfMonitor]";
const FRAME_GAP_THRESHOLD_MS = 100;
const EVENT_LOOP_STALL_THRESHOLD_MS = 100;
const EVENT_LOOP_TICK_MS = 100;
const LONG_TASK_THRESHOLD_MS = 100;

type StopPerfMonitor = () => void;

type GlobalScope = typeof globalThis & {
  requestAnimationFrame?: (callback: (timestamp: number) => void) => number;
  cancelAnimationFrame?: (handle: number) => void;
  PerformanceObserver?: unknown;
};

type PerfObserverEntry = {
  duration: number;
  startTime: number;
};

type PerfObserverLike = {
  observe: (options: { entryTypes: string[] }) => void;
  disconnect: () => void;
};

type PerfObserverConstructor = new (
  callback: (list: { getEntries(): PerfObserverEntry[] }) => void
) => PerfObserverLike;

export function startPerfMonitor(scope: string): StopPerfMonitor {
  if (!isPerfLoggingEnabled()) {
    return () => {};
  }

  const globalScope = globalThis as GlobalScope;
  if (!globalScope) {
    return () => {};
  }

  const startMs = getNowMs();
  perfLog(PERF_MONITOR_LOG_TAG, { event: "monitor_start", scope });

  let rafHandle: number | null = null;
  let lastFrameMs = getNowMs();

  if (typeof globalScope.requestAnimationFrame === "function") {
    const onFrame = (now: number) => {
      const delta = now - lastFrameMs;
      if (delta >= FRAME_GAP_THRESHOLD_MS) {
        perfLog(PERF_MONITOR_LOG_TAG, {
          event: "frame_gap",
          scope,
          deltaMs: Math.round(delta),
          sinceStartMs: Math.round(now - startMs),
        });
      }
      lastFrameMs = now;
      rafHandle = globalScope.requestAnimationFrame?.(onFrame) ?? null;
    };
    rafHandle = globalScope.requestAnimationFrame(onFrame);
  }

  let lastTickMs = getNowMs();
  const intervalHandle = setInterval(() => {
    const now = getNowMs();
    const drift = now - lastTickMs - EVENT_LOOP_TICK_MS;
    if (drift >= EVENT_LOOP_STALL_THRESHOLD_MS) {
      perfLog(PERF_MONITOR_LOG_TAG, {
        event: "event_loop_stall",
        scope,
        driftMs: Math.round(drift),
        sinceStartMs: Math.round(now - startMs),
      });
    }
    lastTickMs = now;
  }, EVENT_LOOP_TICK_MS);

  let observer: PerfObserverLike | null = null;
  const ObserverCtor = globalScope.PerformanceObserver as PerfObserverConstructor | undefined;
  if (typeof ObserverCtor === "function") {
    try {
      observer = new ObserverCtor((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration >= LONG_TASK_THRESHOLD_MS) {
            perfLog(PERF_MONITOR_LOG_TAG, {
              event: "longtask",
              scope,
              durationMs: Math.round(entry.duration),
              startMs: Math.round(entry.startTime),
            });
          }
        }
      });
      observer.observe({ entryTypes: ["longtask"] });
    } catch (error) {
      perfLog(PERF_MONITOR_LOG_TAG, {
        event: "longtask_observer_error",
        scope,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return () => {
    if (rafHandle !== null && typeof globalScope.cancelAnimationFrame === "function") {
      globalScope.cancelAnimationFrame(rafHandle);
    }
    clearInterval(intervalHandle);
    observer?.disconnect();
    perfLog(PERF_MONITOR_LOG_TAG, { event: "monitor_stop", scope });
  };
}
