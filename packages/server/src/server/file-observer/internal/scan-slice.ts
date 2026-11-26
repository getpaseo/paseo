const SCAN_YIELD_BUDGET_MS = 8;
const SCAN_YIELD_CHECK_STRIDE = 256;

export interface ScanSliceBudget {
  /** True on a stride boundary once the current event-loop slice budget has elapsed. */
  shouldYield(): boolean;
  /** True once the current event-loop slice budget has elapsed (for directory boundaries). */
  isExpired(): boolean;
  /** Yield to the event loop via setImmediate and start a fresh slice. */
  yield(): Promise<void>;
}

/**
 * Cooperative time-slice budget for directory scans. Checking the clock only every
 * `SCAN_YIELD_CHECK_STRIDE` entries keeps the hot loop free of per-entry allocations
 * or awaits while bounding uninterrupted main-thread work to roughly one slice.
 */
export function createScanSliceBudget(): ScanSliceBudget {
  let sliceStartedAt = performance.now();
  let entriesSinceCheck = 0;

  return {
    shouldYield() {
      entriesSinceCheck += 1;
      if (entriesSinceCheck < SCAN_YIELD_CHECK_STRIDE) return false;
      entriesSinceCheck = 0;
      return performance.now() - sliceStartedAt >= SCAN_YIELD_BUDGET_MS;
    },
    isExpired() {
      return performance.now() - sliceStartedAt >= SCAN_YIELD_BUDGET_MS;
    },
    async yield() {
      entriesSinceCheck = 0;
      await new Promise<void>((resolve) => setImmediate(resolve));
      sliceStartedAt = performance.now();
    },
  };
}
