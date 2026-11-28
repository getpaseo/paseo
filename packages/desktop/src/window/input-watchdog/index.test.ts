import { describe, expect, it } from "vitest";

import { recordProbeResult, shouldRecoverFromInputWedge } from ".";

describe("input-watchdog", () => {
  describe("shouldRecoverFromInputWedge", () => {
    const recoverable = {
      missedChecks: 2,
      recovering: false,
      msSinceLastRecovery: 120_000,
      consecutiveRecoveries: 0,
    };

    it("recovers once the miss threshold is reached", () => {
      expect(shouldRecoverFromInputWedge(recoverable)).toBe(true);
    });

    it("waits until the miss threshold is reached", () => {
      expect(shouldRecoverFromInputWedge({ ...recoverable, missedChecks: 1 })).toBe(false);
    });

    it("does not recover while a recovery is already in progress", () => {
      expect(shouldRecoverFromInputWedge({ ...recoverable, recovering: true })).toBe(false);
    });

    it("respects the cooldown between recoveries", () => {
      expect(shouldRecoverFromInputWedge({ ...recoverable, msSinceLastRecovery: 20_000 })).toBe(
        false,
      );
    });

    it("stops recovering after the consecutive-recovery cap", () => {
      expect(shouldRecoverFromInputWedge({ ...recoverable, consecutiveRecoveries: 3 })).toBe(false);
    });
  });

  describe("recordProbeResult", () => {
    it("clears the miss streak when the canary is acknowledged", () => {
      expect(recordProbeResult(1, true)).toBe(0);
    });

    it("grows the miss streak when the canary is not acknowledged", () => {
      expect(recordProbeResult(0, false)).toBe(1);
      expect(recordProbeResult(1, false)).toBe(2);
    });
  });
});
