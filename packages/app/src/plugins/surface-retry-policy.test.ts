import { describe, expect, it } from "vitest";
import {
  INITIAL_SURFACE_RETRY_STATE,
  reduceSurfaceRetry,
  type SurfaceRetryState,
} from "./surface-retry-policy";

const options = { retryDelayMs: 120 };
const fail = (state: SurfaceRetryState, message = "layout read raced removal") =>
  reduceSurfaceRetry(state, { type: "failed", message }, options);

describe("reduceSurfaceRetry", () => {
  it("blanks the frame and schedules one retry for the first failure", () => {
    const outcome = fail(INITIAL_SURFACE_RETRY_STATE);

    expect(outcome.scheduleRetry).toBe(true);
    expect(outcome.state).toEqual({
      error: "layout read raced removal",
      retryUsed: true,
      retryPending: true,
    });
  });

  it("shows the error without a retry when the surface passes no delay", () => {
    const outcome = reduceSurfaceRetry(
      INITIAL_SURFACE_RETRY_STATE,
      { type: "failed", message: "layout read raced removal" },
      { retryDelayMs: 0 },
    );

    expect(outcome.scheduleRetry).toBe(false);
    expect(outcome.state).toEqual({
      error: "layout read raced removal",
      retryUsed: false,
      retryPending: false,
    });
  });

  it("clears the error when the retry elapses and keeps the budget spent", () => {
    const pending = fail(INITIAL_SURFACE_RETRY_STATE).state;

    expect(reduceSurfaceRetry(pending, { type: "retry-elapsed" }, options).state).toEqual({
      error: null,
      retryUsed: true,
      retryPending: false,
    });
  });

  it("shows a failure that lands after the retried commit instead of retrying forever", () => {
    // The failure lands in an effect after the commit the retry rendered. Re-arming there would
    // retry on a timer for as long as the screen stays mounted.
    const afterRetry = reduceSurfaceRetry(
      fail(INITIAL_SURFACE_RETRY_STATE).state,
      { type: "retry-elapsed" },
      options,
    ).state;

    const repeated = fail(afterRetry);

    expect(repeated.scheduleRetry).toBe(false);
    expect(repeated.state).toEqual({
      error: "layout read raced removal",
      retryUsed: true,
      retryPending: false,
    });
  });

  it("re-arms the retry on a new identity while the screen is healthy", () => {
    // Fail once, recover, then leave and come back with no error showing. Without the re-arm the
    // next transient failure would be final, which is the later-visits case.
    const healthyAfterRetry = reduceSurfaceRetry(
      fail(INITIAL_SURFACE_RETRY_STATE).state,
      { type: "retry-elapsed" },
      options,
    ).state;
    expect(healthyAfterRetry.error).toBeNull();

    const revisited = reduceSurfaceRetry(healthyAfterRetry, { type: "identity-changed" }, options);

    expect(revisited.cancelRetry).toBe(true);
    expect(revisited.state).toEqual(INITIAL_SURFACE_RETRY_STATE);
    expect(fail(revisited.state).scheduleRetry).toBe(true);
  });
});
