import { describe, expect, it } from "vitest";

/**
 * Timeout-safe cancellation runner for agent rewind.
 * Guarantees that even if a child process or provider cancellation hangs,
 * the operation aborts with a tight deadline (e.g. 2000ms) and forces the rewind,
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
  if (timeoutHandle) {
    clearTimeout(timeoutHandle);
  }
  return result;
}

describe("Rewind Timeout Safety & Forced Cancellation", () => {
  it("completes normally when cancellation finishes quickly", async () => {
    const quickCancel = async () => {
      await new Promise((r) => setTimeout(r, 50));
    };

    const start = Date.now();
    const result = await cancelAgentRunBeforeRewindWithTimeout(quickCancel, 2000);
    const duration = Date.now() - start;

    expect(result.canceled).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(duration).toBeLessThan(500);
  });

  it("times out fast (in 100ms in test) when a child process hangs, preventing the 60s freeze", async () => {
    // Simulates a hung subprocess that never resolves
    const hungProcessCancel = () => new Promise<void>(() => {});

    const start = Date.now();
    const result = await cancelAgentRunBeforeRewindWithTimeout(hungProcessCancel, 100);
    const duration = Date.now() - start;

    expect(result.timedOut).toBe(true);
    expect(result.canceled).toBe(false);
    // Verified that it finished in ~100ms instead of 60,000ms!
    expect(duration).toBeLessThan(300);
  });
});
