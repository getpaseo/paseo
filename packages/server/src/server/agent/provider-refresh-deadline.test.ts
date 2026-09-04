import { expect, test, vi } from "vitest";

import {
  PROVIDER_REFRESH_ABORT_CLEANUP_TIMEOUT_MS,
  runProviderRefreshWithDeadline,
} from "./provider-refresh-deadline.js";

test("bounds abort cleanup before settling a timed-out refresh", async () => {
  vi.useFakeTimers();
  let settled = false;

  try {
    const refresh = runProviderRefreshWithDeadline({
      label: "Codex",
      timeoutMs: 100,
      operation: async (context) => {
        context.registerAbortCleanup(async () => await new Promise<void>(() => {}));
        return await new Promise<never>(() => {});
      },
    });
    void refresh.then(
      () => {
        settled = true;
        return undefined;
      },
      () => {
        settled = true;
        return undefined;
      },
    );

    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(PROVIDER_REFRESH_ABORT_CLEANUP_TIMEOUT_MS);
    await expect(refresh).rejects.toThrow("Timed out refreshing Codex after 100ms");
    expect(settled).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
