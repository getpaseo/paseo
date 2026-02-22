import type { ActivityFlushHandle } from "./types";

const DEFAULT_ACTIVITY_FLUSH_INTERVAL_MS = 16;

export function scheduleAgentLastActivityFlush(
  callback: () => void,
  fallbackIntervalMs = DEFAULT_ACTIVITY_FLUSH_INTERVAL_MS
): ActivityFlushHandle {
  if (typeof requestAnimationFrame === "function") {
    const handle = requestAnimationFrame(callback);
    return {
      cancel: () => {
        if (typeof cancelAnimationFrame === "function") {
          cancelAnimationFrame(handle);
        }
      },
    };
  }

  const handle = setTimeout(callback, fallbackIntervalMs);
  return {
    cancel: () => {
      clearTimeout(handle);
    },
  };
}
