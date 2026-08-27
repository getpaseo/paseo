import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FileChange } from "./file-observer/index.js";

export const WATCHER_LIVENESS_CANARY_TIMEOUT_MS = 10_000;

export interface WatcherLivenessCanary {
  readonly path: string;
  filterEvents(events: FileChange[]): FileChange[];
  verify(signal?: AbortSignal): Promise<void>;
}

export function createWatcherLivenessCanary(
  watchRoot: string,
  options: { timeoutMs?: number } = {},
): WatcherLivenessCanary {
  const canaryPath = join(watchRoot, `.paseo-watcher-canary-${randomUUID()}`);
  const timeoutMs = options.timeoutMs ?? WATCHER_LIVENESS_CANARY_TIMEOUT_MS;
  let reportCanary!: () => void;
  const reported = new Promise<void>((resolve) => {
    reportCanary = resolve;
  });

  return {
    path: canaryPath,
    filterEvents(events) {
      const filtered = events.filter((event) => event.path !== canaryPath);
      if (filtered.length !== events.length) {
        reportCanary();
      }
      return filtered;
    },
    async verify(signal) {
      await writeFile(canaryPath, "paseo watcher liveness canary\n", { flag: "wx" });
      let timeout: NodeJS.Timeout | null = null;
      let removeAbortListener = () => {};
      try {
        const timeoutPromise = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(
              new Error(
                `Watcher for ${watchRoot} did not report its liveness canary within ${timeoutMs}ms`,
              ),
            );
          }, timeoutMs);
        });
        const abortPromise = new Promise<never>((_resolve, reject) => {
          if (!signal) return;
          const rejectForAbort = () => reject(signal.reason);
          if (signal.aborted) {
            rejectForAbort();
            return;
          }
          signal.addEventListener("abort", rejectForAbort, { once: true });
          removeAbortListener = () => signal.removeEventListener("abort", rejectForAbort);
        });
        await Promise.race([reported, timeoutPromise, abortPromise]);
      } finally {
        if (timeout) clearTimeout(timeout);
        removeAbortListener();
        await rm(canaryPath, { force: true });
      }
    },
  };
}
