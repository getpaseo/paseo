import { describe, expect, test } from "vitest";
import { decideRestart, isCrash, planWorkerExit, type RestartPolicy } from "./restart-policy.js";

const policy: RestartPolicy = {
  maxRestarts: 3,
  windowMs: 10_000,
  baseDelayMs: 100,
  maxDelayMs: 1_000,
};

describe("decideRestart", () => {
  test("restarts while crashes within the window stay at or below maxRestarts", () => {
    // Three crashes inside the window (including the current one) is still allowed.
    const decision = decideRestart([1000, 1100, 1200], 1200, policy);
    expect(decision.shouldRestart).toBe(true);
  });

  test("stops restarting once crashes within the window exceed maxRestarts", () => {
    // The fourth crash inside the window is the crash-loop signal: give up.
    const decision = decideRestart([1000, 1100, 1200, 1300], 1300, policy);
    expect(decision.shouldRestart).toBe(false);
  });

  test("applies exponential backoff as recent crashes accumulate", () => {
    expect(decideRestart([1000], 1000, policy).delayMs).toBe(100); // base * 2^0
    expect(decideRestart([1000, 1100], 1100, policy).delayMs).toBe(200); // base * 2^1
    expect(decideRestart([1000, 1100, 1200], 1200, policy).delayMs).toBe(400); // base * 2^2
  });

  test("caps the backoff delay at maxDelayMs", () => {
    const burst = Array.from({ length: 10 }, (_value, index) => 1000 + index);
    expect(decideRestart(burst, 1009, policy).delayMs).toBe(1_000);
  });

  test("ignores crashes older than the window so a recovered worker restarts cleanly", () => {
    // Two ancient crashes far outside the window, plus one fresh crash now.
    const decision = decideRestart([10, 20, 100_000], 100_000, policy);
    expect(decision.shouldRestart).toBe(true);
    expect(decision.delayMs).toBe(100); // only the fresh crash counts → base delay
    expect(decision.recentCrashes).toBe(1);
  });
});

describe("isCrash", () => {
  test("treats a non-zero exit code as a crash when restartOnCrash is enabled", () => {
    expect(isCrash(true, 1, null)).toBe(true);
  });

  test("treats SIGTERM as a clean stop, not a crash", () => {
    expect(isCrash(true, null, "SIGTERM")).toBe(false);
  });

  test("treats a zero exit code as a clean exit", () => {
    expect(isCrash(true, 0, null)).toBe(false);
  });

  test("never reports a crash when restartOnCrash is disabled", () => {
    expect(isCrash(false, 1, null)).toBe(false);
  });
});

describe("planWorkerExit", () => {
  const base = {
    restartOnCrash: true,
    crashTimestamps: [] as number[],
    now: 0,
    policy,
  };

  test("exits cleanly with code 0 when shutting down", () => {
    const plan = planWorkerExit({
      ...base,
      shuttingDown: true,
      restarting: false,
      code: 1,
      signal: null,
    });
    expect(plan).toEqual({ action: "shutdown-exit" });
  });

  test("restarts immediately for an intentional restart without counting it as a crash", () => {
    const plan = planWorkerExit({
      ...base,
      shuttingDown: false,
      restarting: true,
      code: null,
      signal: "SIGTERM",
      crashTimestamps: [5, 6],
    });
    expect(plan).toEqual({ action: "restart", delayMs: 0, crashTimestamps: [5, 6] });
  });

  test("does not count a failed intentional restart exit as a crash", () => {
    const plan = planWorkerExit({
      ...base,
      shuttingDown: false,
      restarting: true,
      code: 1,
      signal: null,
      crashTimestamps: [5, 6],
    });
    expect(plan).toEqual({ action: "restart", delayMs: 0, crashTimestamps: [5, 6] });
  });

  test("restarts a crashed worker with backoff and records the crash", () => {
    const plan = planWorkerExit({
      ...base,
      shuttingDown: false,
      restarting: false,
      code: 1,
      signal: null,
      crashTimestamps: [1000],
      now: 1100,
    });
    expect(plan.action).toBe("restart");
    if (plan.action === "restart") {
      expect(plan.delayMs).toBe(200); // two recent crashes → base * 2
      expect(plan.crashTimestamps).toEqual([1000, 1100]);
    }
  });

  test("gives up with a non-zero code once the worker crash-loops past maxRestarts", () => {
    const plan = planWorkerExit({
      ...base,
      shuttingDown: false,
      restarting: false,
      code: 1,
      signal: null,
      crashTimestamps: [1000, 1100, 1200],
      now: 1300,
    });
    expect(plan.action).toBe("give-up");
    if (plan.action === "give-up") {
      expect(plan.code).toBeGreaterThan(0);
    }
  });

  test("exits with the worker's own code on a normal non-crash exit", () => {
    const plan = planWorkerExit({
      ...base,
      shuttingDown: false,
      restarting: false,
      code: 0,
      signal: null,
    });
    expect(plan).toEqual({ action: "exit", code: 0 });
  });
});
