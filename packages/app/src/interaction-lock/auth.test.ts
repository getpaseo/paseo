import { beforeEach, describe, expect, it, vi } from "vitest";

const hasHardwareAsync = vi.fn();
const isEnrolledAsync = vi.fn();
const authenticateAsync = vi.fn();

vi.mock("react-native", () => ({
  Platform: { OS: "android" },
}));

vi.mock("expo-local-authentication", () => ({
  hasHardwareAsync: (...args: unknown[]) => hasHardwareAsync(...args),
  isEnrolledAsync: (...args: unknown[]) => isEnrolledAsync(...args),
  authenticateAsync: (...args: unknown[]) => authenticateAsync(...args),
}));

import { authenticateForInteractionUnlock } from "./auth";

describe("authenticateForInteractionUnlock", () => {
  beforeEach(() => {
    hasHardwareAsync.mockReset();
    isEnrolledAsync.mockReset();
    authenticateAsync.mockReset();
    hasHardwareAsync.mockResolvedValue(true);
    isEnrolledAsync.mockResolvedValue(true);
  });

  it("returns ok when authentication succeeds", async () => {
    authenticateAsync.mockResolvedValue({ success: true });
    await expect(
      authenticateForInteractionUnlock({ promptMessage: "Unlock Paseo" }),
    ).resolves.toEqual({ ok: true });
    expect(authenticateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        promptMessage: "Unlock Paseo",
        disableDeviceFallback: false,
      }),
    );
  });

  it("maps user cancel", async () => {
    authenticateAsync.mockResolvedValue({ success: false, error: "user_cancel" });
    await expect(
      authenticateForInteractionUnlock({ promptMessage: "Unlock Paseo" }),
    ).resolves.toEqual({ ok: false, reason: "cancelled" });
  });

  it("maps unavailable device credential", async () => {
    authenticateAsync.mockResolvedValue({ success: false, error: "passcode_not_set" });
    await expect(
      authenticateForInteractionUnlock({ promptMessage: "Unlock Paseo" }),
    ).resolves.toEqual({
      ok: false,
      reason: "unavailable",
      message: "passcode_not_set",
    });
  });
});
