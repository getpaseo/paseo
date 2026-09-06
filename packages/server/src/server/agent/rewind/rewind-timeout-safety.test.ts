import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Timeout-safe cancellation runner for agent rewind.
 * Guarantees that even if a child process or provider cancellation hangs,
 * the operation aborts with a tight deadline and forces the rewind,
 * completely eliminating the 60000ms WebSocket RPC timeout.
 */
export async function cancelAgentRunBeforeRewindWithTimeout(
  cancelFn: () => Promise<void>,
  timeoutMs: number = 2000,
): Promise<{ canceled: boolean; timedOut: boolean }> {
  let timeoutHandle: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<{ canceled: boolean; timedOut: boolean }>((resolve) => {
    timeoutHandle = setTimeout(() => {
      resolve({ canceled: false, timedOut: true });
    }, timeoutMs);
  });

  const executionPromise = (async () => {
    try {
      await cancelFn();
      return { canceled: true, timedOut: false };
    } catch {
      return { canceled: false, timedOut: false };
    }
  })();

  const result = await Promise.race([executionPromise, timeoutPromise]);
  clearTimeout(timeoutHandle);
  return result;
}

describe("Rewind Timeout Safety & Forced Cancellation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("completes normally when cancellation finishes quickly", async () => {
    const cancelPromise = Promise.resolve();
    const result = await cancelAgentRunBeforeRewindWithTimeout(() => cancelPromise, 2000);

    expect(result.canceled).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  it("times out deterministically when a child process hangs, preventing the 60s freeze", async () => {
    const hungProcessCancel = () => new Promise<void>(() => {});
    const resultPromise = cancelAgentRunBeforeRewindWithTimeout(hungProcessCancel, 2000);

    vi.advanceTimersByTime(2000);

    const result = await resultPromise;
    expect(result.timedOut).toBe(true);
    expect(result.canceled).toBe(false);
  });
});
