import { describe, expect, test } from "vitest";
import { BoundedExponentialHubRetryPolicy } from "./relationship-retry.js";

describe("Hub relationship retry policy", () => {
  test("keeps jitter within the lower and upper bounds", () => {
    const lower = new BoundedExponentialHubRetryPolicy(() => 0);
    const upper = new BoundedExponentialHubRetryPolicy(() => 1);

    expect(lower.delay(0)).toBe(375);
    expect(upper.delay(0)).toBe(625);
  });

  test("grows exponentially and caps the base delay", () => {
    const retry = new BoundedExponentialHubRetryPolicy(() => 0.5);

    expect([0, 1, 2, 3, 4, 5, 6, 20].map((attempt) => retry.delay(attempt))).toEqual([
      500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
    ]);
  });

  test("never schedules a zero-delay tight loop", () => {
    const retry = new BoundedExponentialHubRetryPolicy(() => 0);

    expect([0, 1, 2].map((attempt) => retry.delay(attempt))).toEqual([375, 750, 1_500]);
  });
});
