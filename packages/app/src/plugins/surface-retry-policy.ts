/**
 * Retry policy for a plugin surface that failed to render.
 *
 * A plugin surface usually fails on a transient read: plugin code that keeps an event and reads
 * `event.nativeEvent` after the dispatch ended sees a pooled Fabric event whose payload was nulled,
 * which throws a null dereference outside any handler the boundary could catch. Retrying the surface
 * once lets it recover instead of leaving the user to close and reopen the screen.
 *
 * Two rules the state has to encode:
 *
 * - One retry, then show the error. A successful render does not re-arm the retry, because a failure
 *   can land in an effect after the retried commit; re-arming there would retry on a timer forever
 *   and re-run every plugin subscription each time.
 * - A new identity re-arms it even when nothing failed. A screen that recovered earlier in the
 *   session and is visited again has to keep its retry, or its next transient failure is final.
 */
export interface SurfaceRetryState {
  /** Message of the failure being shown, or null. */
  error: string | null;
  /** The retry for the failure in this identity was already spent. */
  retryUsed: boolean;
  /** Blank the frame until the retry runs, instead of flashing the error. */
  retryPending: boolean;
}

export const INITIAL_SURFACE_RETRY_STATE: SurfaceRetryState = {
  error: null,
  retryUsed: false,
  retryPending: false,
};

export type SurfaceRetryEvent =
  | { type: "failed"; message: string }
  | { type: "retry-elapsed" }
  | { type: "identity-changed" };

export interface SurfaceRetryOutcome {
  state: SurfaceRetryState;
  /** Start the retry timer. The caller owns the timer. */
  scheduleRetry: boolean;
  /** Drop a timer started by an earlier retry, if the caller has one. */
  cancelRetry: boolean;
}

export function reduceSurfaceRetry(
  state: SurfaceRetryState,
  event: SurfaceRetryEvent,
  options: { retryDelayMs: number },
): SurfaceRetryOutcome {
  switch (event.type) {
    case "failed":
      if (options.retryDelayMs > 0 && !state.retryUsed) {
        return {
          state: { error: event.message, retryUsed: true, retryPending: true },
          scheduleRetry: true,
          cancelRetry: false,
        };
      }
      return {
        state: { error: event.message, retryUsed: state.retryUsed, retryPending: false },
        scheduleRetry: false,
        cancelRetry: false,
      };
    case "retry-elapsed":
      return {
        state: { error: null, retryUsed: state.retryUsed, retryPending: false },
        scheduleRetry: false,
        cancelRetry: false,
      };
    case "identity-changed":
      return { state: INITIAL_SURFACE_RETRY_STATE, scheduleRetry: false, cancelRetry: true };
  }
}
