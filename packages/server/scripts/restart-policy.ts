export interface RestartPolicy {
  /** Maximum crash-restarts permitted within `windowMs` before the supervisor gives up. */
  maxRestarts: number;
  /** Sliding window (ms) over which crashes are counted. */
  windowMs: number;
  /** Backoff delay (ms) before the first restart in a burst. */
  baseDelayMs: number;
  /** Upper bound (ms) on the exponential backoff delay. */
  maxDelayMs: number;
}

export interface RestartDecision {
  shouldRestart: boolean;
  delayMs: number;
  recentCrashes: number;
}

/**
 * Production defaults: tolerate a brief burst of crash-restarts, but stop a
 * runaway loop. With these values an unrecoverable failure (e.g. EADDRINUSE
 * against a live daemon) is retried ~5 times over ~6s with exponential
 * backoff, then the supervisor gives up instead of hot-looping forever.
 */
export const DEFAULT_RESTART_POLICY: RestartPolicy = {
  maxRestarts: 5,
  windowMs: 10_000,
  baseDelayMs: 200,
  maxDelayMs: 5_000,
};

export function decideRestart(
  crashTimestamps: number[],
  now: number,
  policy: RestartPolicy,
): RestartDecision {
  const recentCrashes = crashTimestamps.filter((at) => now - at < policy.windowMs).length;
  const shouldRestart = recentCrashes <= policy.maxRestarts;
  const exponent = Math.max(0, recentCrashes - 1);
  const delayMs = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** exponent);
  return { shouldRestart, delayMs, recentCrashes };
}

export type ExitPlan =
  | { action: "shutdown-exit" }
  | { action: "restart"; delayMs: number; crashTimestamps: number[] }
  | { action: "give-up"; code: number; crashTimestamps: number[] }
  | { action: "exit"; code: number };

export interface PlanWorkerExitInput {
  shuttingDown: boolean;
  restarting: boolean;
  restartOnCrash: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Epoch-ms timestamps of prior crashes, not including the exit being planned. */
  crashTimestamps: number[];
  now: number;
  policy: RestartPolicy;
}

/**
 * A worker exit counts as a crash only when crash-restart is enabled and the
 * worker did not exit cleanly (zero code) or via the SIGTERM we send for
 * intentional restarts/shutdowns.
 */
export function isCrash(
  restartOnCrash: boolean,
  code: number | null,
  signal: NodeJS.Signals | null,
): boolean {
  if (!restartOnCrash) {
    return false;
  }
  const exitedWithError = code !== 0 && code !== null;
  const killedByUnexpectedSignal = signal !== null && signal !== "SIGTERM";
  return exitedWithError || killedByUnexpectedSignal;
}

/**
 * Decide what the supervisor should do when a worker exits, folding the
 * shutdown/intentional-restart/crash branches together with the crash-loop
 * circuit breaker. Pure so the full decision is testable without forking.
 */
export function planWorkerExit(input: PlanWorkerExitInput): ExitPlan {
  if (input.shuttingDown) {
    return { action: "shutdown-exit" };
  }

  // Intentional restarts (worker SIGTERMed by requestRestart) bypass the crash
  // accounting entirely. This preserves the supervisor's restart contract even
  // if the worker's shutdown path exits non-zero.
  if (input.restarting) {
    return { action: "restart", delayMs: 0, crashTimestamps: input.crashTimestamps };
  }

  const crashed = isCrash(input.restartOnCrash, input.code, input.signal);

  if (crashed) {
    const crashTimestamps = [...input.crashTimestamps, input.now].filter(
      (at) => input.now - at < input.policy.windowMs,
    );
    const decision = decideRestart(crashTimestamps, input.now, input.policy);
    if (decision.shouldRestart) {
      return { action: "restart", delayMs: decision.delayMs, crashTimestamps };
    }
    return { action: "give-up", code: 1, crashTimestamps };
  }

  return { action: "exit", code: typeof input.code === "number" ? input.code : 1 };
}
