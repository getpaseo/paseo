import { performance } from "node:perf_hooks";

export const DAEMON_WORKER_FORCE_EXIT_TIMEOUT_MS = 10_000;
export const DAEMON_GRACEFUL_SHUTDOWN_BUDGET_MS = 8_000;

export interface ShutdownDeadline {
  readonly expiresAtMs: number;
  readonly now: () => number;
}

export type ShutdownTaskResult =
  | { status: "completed" }
  | { status: "failed"; error: unknown }
  | { status: "timed_out" };

export function createShutdownDeadline(
  timeoutMs: number,
  now: () => number = () => performance.now(),
): ShutdownDeadline {
  return {
    expiresAtMs: now() + Math.max(0, timeoutMs),
    now,
  };
}

export function remainingShutdownTimeMs(deadline: ShutdownDeadline): number {
  return Math.max(0, deadline.expiresAtMs - deadline.now());
}

export function capShutdownDeadline(
  deadline: ShutdownDeadline,
  maxDurationMs: number,
): ShutdownDeadline {
  return {
    expiresAtMs: Math.min(deadline.expiresAtMs, deadline.now() + Math.max(0, maxDurationMs)),
    now: deadline.now,
  };
}

export async function settleBeforeShutdownDeadline(
  task: Promise<unknown>,
  deadline: ShutdownDeadline,
): Promise<ShutdownTaskResult> {
  const outcome = task.then(
    () => ({ status: "completed" }) as const,
    (error: unknown) => ({ status: "failed", error }) as const,
  );
  const remainingMs = remainingShutdownTimeMs(deadline);
  if (remainingMs <= 0) {
    return { status: "timed_out" };
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      outcome,
      new Promise<{ status: "timed_out" }>((resolve) => {
        timer = setTimeout(() => resolve({ status: "timed_out" }), remainingMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
