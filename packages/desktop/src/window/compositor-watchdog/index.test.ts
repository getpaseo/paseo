import { describe, expect, it } from "vitest";

import { shouldRecoverFromFrameStall } from ".";

describe("compositor-watchdog", () => {
  describe("shouldRecoverFromFrameStall", () => {
    const recoverable = {
      stalledChecks: 3,
      recovering: false,
      msSinceLastRecovery: 120_000,
      consecutiveRecoveries: 0,
    };

    it("recovers once the stall threshold is reached", () => {
      expect(shouldRecoverFromFrameStall(recoverable)).toBe(true);
    });

    it("waits until the stall threshold is reached", () => {
      expect(shouldRecoverFromFrameStall({ ...recoverable, stalledChecks: 2 })).toBe(false);
    });

    it("does not recover while a recovery is already in progress", () => {
      expect(shouldRecoverFromFrameStall({ ...recoverable, recovering: true })).toBe(false);
    });

    it("respects the cooldown between recoveries", () => {
      expect(shouldRecoverFromFrameStall({ ...recoverable, msSinceLastRecovery: 30_000 })).toBe(
        false,
      );
    });

    it("stops recovering after the consecutive-recovery cap", () => {
      expect(shouldRecoverFromFrameStall({ ...recoverable, consecutiveRecoveries: 3 })).toBe(false);
    });
  });
});
