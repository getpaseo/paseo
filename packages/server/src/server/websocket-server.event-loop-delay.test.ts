import { afterEach, expect, test, vi } from "vitest";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "./test-utils/paseo-daemon.js";

// The real monitor, with each requested sampling interval recorded.
const requested = vi.hoisted(() => ({ resolutionsMs: [] as number[] }));
vi.mock("node:perf_hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:perf_hooks")>();
  return {
    ...actual,
    monitorEventLoopDelay(options?: { resolution?: number }) {
      requested.resolutionsMs.push(options?.resolution ?? 10);
      return actual.monitorEventLoopDelay(options);
    },
  };
});

let daemon: TestPaseoDaemon | null = null;

afterEach(async () => {
  await daemon?.close();
  daemon = null;
  requested.resolutionsMs.length = 0;
});

test("a running daemon samples event-loop delay no more often than every 100 ms", async () => {
  daemon = await createTestPaseoDaemon();

  // Each sample is a timer wakeup for the daemon's whole life; 10 ms meant 100 wakeups a second.
  expect(requested.resolutionsMs.length).toBeGreaterThan(0);
  expect(Math.min(...requested.resolutionsMs)).toBeGreaterThanOrEqual(100);
});
