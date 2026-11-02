import type { WaitForFinishResult } from "@getpaseo/client/internal/daemon-client";

export type FinishObservationResult = WaitForFinishResult & {
  reason?: "was canceled" | "host unreachable" | "host removed";
  /** A standing observation saw no run since its last outcome; the child was only archived or removed. */
  noRun?: true;
};
/** A standing observation saw a run start after the caller's latest outcome. */
export interface FinishRunStarted {
  runStarted: true;
}

interface ObservationBufferOptions {
  standing?: boolean;
  /** The caller already has the latest outcome, so only a run that starts later is reported. */
  reported?: boolean;
}

/** Coalesces duplicate checkpoints and retains one terminal result while delivery is pending. */
export function createObservationBuffer(
  signal: AbortSignal,
  options: ObservationBufferOptions = {},
) {
  const delivered = new Set<string>();
  const permissions = new Map<string, FinishObservationResult>();
  const resolvedBeforeInitial = new Set<string>();
  let initialPending = true;
  let terminal: FinishObservationResult | undefined;
  // A removal behind an undelivered outcome waits for that outcome to go out first.
  let removal: FinishObservationResult | undefined;
  let failure: unknown;
  let wake: (() => void) | undefined;
  // A standing observation reports a settled state only after a run it saw start. Idle cleanup,
  // reloads and duplicate settle events close or settle nothing new. Archive and removal still end it.
  let awaitingRun = options.reported === true;
  // Announced ahead of that run's outcome, so durable intent owes it before a restart can cut it off.
  let runStarted = false;
  const abort = () => {
    failure = signal.reason;
    wake?.();
  };
  signal.addEventListener("abort", abort, { once: true });
  function started(): void {
    if (awaitingRun) {
      runStarted = true;
      wake?.();
    }
    awaitingRun = false;
  }
  function push(result: FinishObservationResult): void {
    if (result.status === "timeout") return;
    if (result.status === "permission") {
      started();
      for (const request of result.final?.pendingPermissions ?? [])
        if (!delivered.has(request.id)) permissions.set(request.id, result);
    } else if (!awaitingRun) {
      if (!result.final && terminal?.final) removal = result;
      else terminal = result;
    } else if (!result.final || result.final.archivedAt) terminal = { ...result, noRun: true };
    wake?.();
  }
  return {
    started,
    pushInitial(result: FinishObservationResult) {
      initialPending = false;
      if (result.status === "permission" && result.final) {
        const pendingPermissions = result.final.pendingPermissions.filter(
          (request) => !resolvedBeforeInitial.has(request.id),
        );
        if (pendingPermissions.length)
          push({ ...result, final: { ...result.final, pendingPermissions } });
      } else if (
        !terminal &&
        result.final?.status !== "running" &&
        result.final?.status !== "initializing"
      )
        push(result);
      resolvedBeforeInitial.clear();
    },
    push,
    resolved(id: string) {
      if (initialPending) resolvedBeforeInitial.add(id);
      delivered.delete(id);
      permissions.delete(id);
    },
    fail(error: unknown) {
      failure = error;
      wake?.();
    },
    async next(): Promise<FinishObservationResult | FinishRunStarted> {
      while (true) {
        signal.throwIfAborted();
        if (runStarted) {
          runStarted = false;
          return { runStarted: true };
        }
        const first = permissions.entries().next().value;
        if (first) {
          for (const request of first[1].final?.pendingPermissions ?? []) {
            delivered.add(request.id);
            permissions.delete(request.id);
          }
          return first[1];
        }
        if (terminal) {
          const result = terminal;
          terminal = undefined;
          if (options.standing) awaitingRun = true;
          if (removal) {
            const end = removal;
            removal = undefined;
            push(end);
          }
          return result;
        }
        if (failure) throw failure;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    },
    dispose() {
      signal.removeEventListener("abort", abort);
    },
  };
}
