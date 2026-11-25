import { describe, expect, test } from "vitest";
import {
  ListenAddressUnavailableError,
  listenWithAddressRetry,
  type ListenAddressRetry,
  type ListenAddressRetryClock,
  type ListenAddressRetryPolicy,
} from "./listen-address-retry.js";

function createFakeClock(): ListenAddressRetryClock & { sleeps: number[] } {
  let now = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: async (delayMs) => {
      sleeps.push(delayMs);
      now += delayMs;
    },
  };
}

function listenError(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`listen ${code}: 100.64.0.1:6767`);
  error.code = code;
  return error;
}

/** Fails with each given error code in turn, then succeeds. */
function scriptedListen(codes: string[]): { attemptListen: () => Promise<void>; calls: number } {
  const state = {
    calls: 0,
    attemptListen: async () => {
      const code = codes[state.calls];
      state.calls += 1;
      if (code) throw listenError(code);
    },
  };
  return state;
}

const policy: ListenAddressRetryPolicy = {
  maxWaitMs: 10_000,
  delay: (attempt) => attempt * 1_000,
};

describe("listenWithAddressRetry", () => {
  test("keeps retrying while the address is unavailable and succeeds once it appears", async () => {
    const clock = createFakeClock();
    const listen = scriptedListen(["EADDRNOTAVAIL", "EADDRNOTAVAIL"]);
    const retries: ListenAddressRetry[] = [];

    await listenWithAddressRetry({
      attemptListen: listen.attemptListen,
      listen: "100.64.0.1:6767",
      clock,
      policy,
      onRetry: (retry) => retries.push(retry),
    });

    expect(listen.calls).toBe(3);
    expect(retries).toEqual([
      { attempt: 1, delayMs: 1_000, waitedMs: 0 },
      { attempt: 2, delayMs: 2_000, waitedMs: 1_000 },
    ]);
  });

  test("gives up after the retry window with an error that names the configured address", async () => {
    const clock = createFakeClock();
    const listen = scriptedListen(Array(20).fill("EADDRNOTAVAIL"));

    const result = listenWithAddressRetry({
      attemptListen: listen.attemptListen,
      listen: "100.64.0.1:6767",
      clock,
      policy,
    });

    await expect(result).rejects.toBeInstanceOf(ListenAddressUnavailableError);
    await expect(result).rejects.toMatchObject({
      code: "EADDRNOTAVAIL",
      listen: "100.64.0.1:6767",
      waitedMs: 10_000,
      message: expect.stringContaining("daemon.listen"),
    });
    // 1s + 2s + 3s + 4s fill the 10s window exactly; the fifth failure ends the wait.
    expect(clock.sleeps).toEqual([1_000, 2_000, 3_000, 4_000]);
    expect(listen.calls).toBe(5);
  });

  test("fails immediately on errors that waiting cannot fix", async () => {
    const clock = createFakeClock();
    const listen = scriptedListen(["EADDRINUSE"]);

    await expect(
      listenWithAddressRetry({
        attemptListen: listen.attemptListen,
        listen: "127.0.0.1:6767",
        clock,
        policy,
      }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(listen.calls).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });
});
